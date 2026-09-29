import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { computeEffectiveExpiry, normalizeName, type IsoDate, type LotState, type Package, type Perishability, type Quantity, type ShelfLifeMap } from '@buttery/domain';
import type { Db, Tx } from '../db/client';
import { changeSets, changes, foods, lots, proposalOps, type ChangeRow, type FoodRow, type LotRow } from '../db/schema';
import { AppError, notFound } from '../errors';
import type { Principal } from '../identity/principal';
import { runIdempotent } from './idempotency';
import { refreshProposalStatus } from './proposalStatus';

export type ChangeSetHandle = { id: string; householdId: string; nextSeq: number };

const snapshot = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)));

export async function openChangeSet(
  tx: Tx,
  p: Principal,
  input: { label: string; causeObservationId?: string | null; causeProposalId?: string | null; idempotencyKey?: string | null; revertsChangeSetId?: string | null },
): Promise<ChangeSetHandle> {
  const [row] = await tx
    .insert(changeSets)
    .values({
      householdId: p.householdId,
      label: input.label,
      actorUserId: p.userId,
      connectionId: p.connectionId,
      causeObservationId: input.causeObservationId ?? null,
      causeProposalId: input.causeProposalId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      revertsChangeSetId: input.revertsChangeSetId ?? null,
    })
    .returning({ id: changeSets.id });
  return { id: row!.id, householdId: p.householdId, nextSeq: 1 };
}

export async function recordChange(
  tx: Tx,
  cs: ChangeSetHandle,
  c: { op: string; lotId?: string | null; foodId?: string | null; before: unknown; after: unknown; causeObservationId?: string | null; causeProposalOpId?: string | null },
): Promise<void> {
  await tx.insert(changes).values({
    householdId: cs.householdId,
    changeSetId: cs.id,
    seq: cs.nextSeq++,
    op: c.op,
    lotId: c.lotId ?? null,
    foodId: c.foodId ?? null,
    before: snapshot(c.before),
    after: snapshot(c.after),
    causeObservationId: c.causeObservationId ?? null,
    causeProposalOpId: c.causeProposalOpId ?? null,
  });
}

export type NewFoodInput = {
  name: string;
  category?: string | null;
  perishability: Perishability;
  shelfLife?: ShelfLifeMap;
  defaultLocation?: string | null;
  defaultPackage?: Package | null;
  aliases?: string[];
};

export async function createOrReuseFood(tx: Tx, cs: ChangeSetHandle, input: NewFoodInput): Promise<{ food: FoodRow; created: boolean }> {
  const normalizedName = normalizeName(input.name);
  const [existing] = await tx
    .select()
    .from(foods)
    .where(and(eq(foods.householdId, cs.householdId), eq(foods.normalizedName, normalizedName)))
    .limit(1);
  if (existing) {
    if (!existing.archivedAt) return { food: existing, created: false };
    const [revived] = await tx.update(foods).set({ archivedAt: null, updatedAt: new Date() }).where(eq(foods.id, existing.id)).returning();
    await recordChange(tx, cs, { op: 'unarchive_food', foodId: existing.id, before: existing, after: revived });
    return { food: revived!, created: false };
  }
  const aliases = [...new Set((input.aliases ?? []).map(normalizeName).filter((a) => a && a !== normalizedName))];
  const [food] = await tx
    .insert(foods)
    .values({
      householdId: cs.householdId,
      name: input.name.trim(),
      normalizedName,
      aliases,
      category: input.category ?? null,
      perishability: input.perishability,
      shelfLife: input.shelfLife ?? {},
      defaultLocation: input.defaultLocation ?? null,
      defaultPackage: input.defaultPackage ?? null,
    })
    .returning();
  await recordChange(tx, cs, { op: 'create_food', foodId: food!.id, before: null, after: food });
  return { food: food!, created: true };
}

export async function addAlias(tx: Tx, cs: ChangeSetHandle, food: FoodRow, alias: string): Promise<FoodRow> {
  const a = normalizeName(alias);
  if (!a || a === food.normalizedName || food.aliases.includes(a)) return food;
  const [updated] = await tx.update(foods).set({ aliases: [...food.aliases, a], updatedAt: new Date() }).where(eq(foods.id, food.id)).returning();
  await recordChange(tx, cs, { op: 'add_alias', foodId: food.id, before: { alias: a }, after: { alias: a } });
  return updated!;
}

export type NewLotInput = {
  food: FoodRow;
  location: string;
  state?: LotState;
  quantity: Quantity;
  package?: Package | null;
  acquiredOn?: IsoDate | null;
  printedExpiryOn?: IsoDate | null;
  evidenceObservationId?: string | null;
  causeProposalOpId?: string | null;
  notes?: string | null;
};

export async function addLot(tx: Tx, cs: ChangeSetHandle, input: NewLotInput): Promise<LotRow> {
  const state = input.state ?? 'sealed';
  const expires = computeEffectiveExpiry({
    perishability: input.food.perishability,
    state,
    anchors: { sealed: input.acquiredOn ?? undefined },
    printedExpiryOn: input.printedExpiryOn ?? null,
    shelfLife: input.food.shelfLife,
  });
  const [lot] = await tx
    .insert(lots)
    .values({
      householdId: cs.householdId,
      foodId: input.food.id,
      location: input.location,
      state,
      quantity: input.quantity,
      package: input.package ?? null,
      expires,
      printedExpiryOn: input.printedExpiryOn ?? null,
      acquiredOn: input.acquiredOn ?? null,
      lastEvidenceAt: new Date(),
      lastEvidenceObservationId: input.evidenceObservationId ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  await recordChange(tx, cs, {
    op: 'add_lot',
    lotId: lot!.id,
    foodId: input.food.id,
    before: null,
    after: lot,
    causeObservationId: input.evidenceObservationId,
    causeProposalOpId: input.causeProposalOpId,
  });
  return lot!;
}

export type UndoResult = {
  reverted_change_set_id: string;
  undo_change_set_id: string;
  label: string;
  lots_voided: number;
  foods_archived: number;
  aliases_removed: number;
  proposal_reopened: string | null;
};

type Counts = { lots_voided: number; foods_archived: number; aliases_removed: number };

async function revertChange(tx: Tx, cs: ChangeSetHandle, r: ChangeRow, counts: Counts): Promise<void> {
  switch (r.op) {
    case 'add_lot': {
      const [before] = await tx.select().from(lots).where(eq(lots.id, r.lotId!));
      const [after] = await tx
        .update(lots)
        .set({ status: 'voided', version: sql`${lots.version} + 1`, updatedAt: new Date() })
        .where(eq(lots.id, r.lotId!))
        .returning();
      await recordChange(tx, cs, { op: 'void_lot', lotId: r.lotId, foodId: r.foodId, before, after });
      counts.lots_voided++;
      return;
    }
    case 'create_food':
    case 'unarchive_food': {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(lots)
        .where(and(eq(lots.foodId, r.foodId!), eq(lots.status, 'active')));
      if (n > 0) return; // other active lots still use this food; keep it
      const [before] = await tx.select().from(foods).where(eq(foods.id, r.foodId!));
      const [after] = await tx.update(foods).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(foods.id, r.foodId!)).returning();
      await recordChange(tx, cs, { op: 'archive_food', foodId: r.foodId, before, after });
      counts.foods_archived++;
      return;
    }
    case 'add_alias': {
      const alias = (r.after as { alias: string }).alias;
      await tx
        .update(foods)
        .set({ aliases: sql`array_remove(${foods.aliases}, ${alias})`, updatedAt: new Date() })
        .where(eq(foods.id, r.foodId!));
      await recordChange(tx, cs, { op: 'remove_alias', foodId: r.foodId, before: { alias }, after: { alias } });
      counts.aliases_removed++;
      return;
    }
    case 'update_food': {
      const before = r.before as FoodRow & { archivedAt: string | null };
      const after = r.after as { updatedAt: string };
      const [current] = await tx.select().from(foods).where(eq(foods.id, r.foodId!)).for('update');
      if (current && current.updatedAt.getTime() !== new Date(after.updatedAt).getTime()) {
        throw new AppError('undo_conflict', 'This food changed after that edit; update it directly instead.', 409, { food_ids: [r.foodId] });
      }
      const [restored] = await tx
        .update(foods)
        .set({
          name: before.name,
          normalizedName: before.normalizedName,
          aliases: before.aliases,
          category: before.category,
          perishability: before.perishability,
          shelfLife: before.shelfLife,
          defaultLocation: before.defaultLocation,
          isStaple: before.isStaple,
          archivedAt: before.archivedAt ? new Date(before.archivedAt) : null,
          updatedAt: new Date(),
        })
        .where(eq(foods.id, r.foodId!))
        .returning();
      await recordChange(tx, cs, { op: 'restore_food', foodId: r.foodId, before: current, after: restored });
      return;
    }
    default:
      throw new AppError('not_supported', `Undo of "${r.op}" is not supported yet.`, 422);
  }
}

async function reopenProposalOps(tx: Tx, proposalId: string, changeSetId: string): Promise<string> {
  await tx
    .update(proposalOps)
    .set({ decision: 'pending', appliedAt: null, resultChangeSetId: null })
    .where(and(eq(proposalOps.proposalId, proposalId), eq(proposalOps.resultChangeSetId, changeSetId)));
  await refreshProposalStatus(tx, proposalId);
  return proposalId;
}

export async function undoChangeSet(db: Db, p: Principal, input: { change_set_id: string; idempotency_key: string }): Promise<UndoResult> {
  return runIdempotent(
    db,
    { householdId: p.householdId, tool: 'undo', key: input.idempotency_key, request: { change_set_id: input.change_set_id } },
    async (tx) => {
      const [cs] = await tx
        .select()
        .from(changeSets)
        .where(and(eq(changeSets.id, input.change_set_id), eq(changeSets.householdId, p.householdId)))
        .for('update');
      if (!cs) throw notFound('Change set');
      if (cs.revertedByChangeSetId) throw new AppError('already_reverted', 'This change set was already undone.', 409, { undone_by: cs.revertedByChangeSetId });
      if (cs.revertsChangeSetId) throw new AppError('not_supported', 'Undoing an undo is not supported; re-apply the original change instead.', 422);

      const rows = await tx.select().from(changes).where(eq(changes.changeSetId, cs.id)).orderBy(desc(changes.seq));
      const expected = new Map<string, number>();
      for (const r of rows) if (r.lotId && !expected.has(r.lotId)) expected.set(r.lotId, (r.after as { version: number }).version);
      if (expected.size) {
        const current = await tx.select({ id: lots.id, version: lots.version }).from(lots).where(inArray(lots.id, [...expected.keys()])).for('update');
        const conflicts = current.filter((l) => l.version !== expected.get(l.id)).map((l) => l.id);
        if (conflicts.length) {
          throw new AppError('undo_conflict', 'Some items changed after this; correct them individually instead.', 409, { lot_ids: conflicts });
        }
      }

      const undo = await openChangeSet(tx, p, { label: `Undo: ${cs.label}`, revertsChangeSetId: cs.id, idempotencyKey: input.idempotency_key });
      const counts: Counts = { lots_voided: 0, foods_archived: 0, aliases_removed: 0 };
      for (const r of rows) await revertChange(tx, undo, r, counts);
      await tx.update(changeSets).set({ revertedByChangeSetId: undo.id }).where(eq(changeSets.id, cs.id));
      const proposalReopened = cs.causeProposalId ? await reopenProposalOps(tx, cs.causeProposalId, cs.id) : null;
      return { reverted_change_set_id: cs.id, undo_change_set_id: undo.id, label: cs.label, ...counts, proposal_reopened: proposalReopened };
    },
  );
}
