import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { IdempotencyKeySchema, LotStateSchema, normalizeName, PerishabilitySchema, type ShelfLifeMap } from '@buttery/domain';
import type { Executor } from '../db/client';
import { foods, type FoodRow } from '../db/schema';
import { notFound } from '../errors';
import type { AppDeps } from '../http/app';
import type { Principal } from '../identity/principal';
import type { CandidateFood } from '../reasoning/port';
import { createOrReuseFood, openChangeSet, recordChange } from './changes';
import { runIdempotent } from './idempotency';

export async function loadCatalog(db: Executor, householdId: string): Promise<FoodRow[]> {
  return db.select().from(foods).where(and(eq(foods.householdId, householdId), isNull(foods.archivedAt)));
}

export function toCandidate(f: FoodRow): CandidateFood {
  return { food_id: f.id, name: f.name, aliases: f.aliases, category: f.category ?? 'other', perishability: f.perishability };
}

export const UpsertFoodInputSchema = z.object({
  food_id: z.uuid().optional().describe('Update this food; otherwise matched by name or created'),
  name: z.string().min(1).max(100),
  aliases: z.array(z.string().min(1).max(200)).max(50).optional().describe('Receipt spellings to recognize, e.g. "KS ORG EGGS 24CT"'),
  category: z.string().max(40).optional(),
  perishability: PerishabilitySchema.optional(),
  shelf_life_days: z.partialRecord(LotStateSchema, z.number().int().min(0).max(3650).nullable()).optional().describe('User-known shelf life per state; null = no meaningful expiry'),
  default_location: z.string().max(40).optional(),
  is_staple: z.boolean().optional().describe('Assumed on hand unless marked out'),
  idempotency_key: IdempotencyKeySchema,
});
export type UpsertFoodInput = z.infer<typeof UpsertFoodInputSchema>;

function foodView(f: FoodRow) {
  return { id: f.id, name: f.name, aliases: f.aliases, category: f.category, perishability: f.perishability, shelf_life: f.shelfLife, default_location: f.defaultLocation, is_staple: f.isStaple };
}

export async function upsertFood(deps: Pick<AppDeps, 'db'>, p: Principal, input: UpsertFoodInput) {
  const { idempotency_key, ...request } = input;
  return runIdempotent(deps.db, { householdId: p.householdId, tool: 'upsert_food', key: idempotency_key, request }, async (tx) => {
    const userShelfLife: ShelfLifeMap = Object.fromEntries(
      Object.entries(input.shelf_life_days ?? {}).map(([state, days]) => [state, { days: days ?? null, confidence: 'high' as const, source: 'user' as const }]),
    );
    const [target] = input.food_id
      ? await tx.select().from(foods).where(and(eq(foods.id, input.food_id), eq(foods.householdId, p.householdId)))
      : await tx.select().from(foods).where(and(eq(foods.householdId, p.householdId), eq(foods.normalizedName, normalizeName(input.name))));
    if (input.food_id && !target) throw notFound('Food');
    const cs = await openChangeSet(tx, p, { label: `Food: ${input.name}`, idempotencyKey: idempotency_key });

    if (!target) {
      const { food } = await createOrReuseFood(tx, cs, {
        name: input.name,
        category: input.category ?? null,
        perishability: input.perishability ?? 'perishable',
        shelfLife: userShelfLife,
        defaultLocation: input.default_location ?? null,
        aliases: input.aliases,
      });
      const final = input.is_staple !== undefined ? (await tx.update(foods).set({ isStaple: input.is_staple }).where(eq(foods.id, food.id)).returning())[0]! : food;
      return { food: foodView(final), change_set_id: cs.id, created: true, notes: [] as string[] };
    }

    const aliases = [...new Set([...target.aliases, ...(input.aliases ?? []).map(normalizeName)])].filter((a) => a && a !== target.normalizedName);
    const [after] = await tx
      .update(foods)
      .set({
        ...(input.food_id ? { name: input.name.trim(), normalizedName: normalizeName(input.name) } : {}),
        aliases,
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.perishability ? { perishability: input.perishability } : {}),
        shelfLife: { ...target.shelfLife, ...userShelfLife },
        ...(input.default_location !== undefined ? { defaultLocation: input.default_location } : {}),
        ...(input.is_staple !== undefined ? { isStaple: input.is_staple } : {}),
        archivedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(foods.id, target.id))
      .returning();
    await recordChange(tx, cs, { op: 'update_food', foodId: target.id, before: target, after });
    return { food: foodView(after!), change_set_id: cs.id, created: false, notes: ['Existing items keep their current expiry estimate.'] };
  });
}
