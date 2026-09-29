import { and, eq, isNull } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { foods, type FoodRow } from '../db/schema';
import type { CandidateFood } from '../reasoning/port';

export async function loadCatalog(db: Executor, householdId: string): Promise<FoodRow[]> {
  return db.select().from(foods).where(and(eq(foods.householdId, householdId), isNull(foods.archivedAt)));
}

export function toCandidate(f: FoodRow): CandidateFood {
  return { food_id: f.id, name: f.name, aliases: f.aliases, category: f.category ?? 'other', perishability: f.perishability };
}
