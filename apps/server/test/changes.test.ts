import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { changeSets, changes, foods, lots } from '../src/db/schema';
import { addAlias, addLot, createOrReuseFood, openChangeSet, undoChangeSet } from '../src/services/changes';
import { deriveProposalStatus } from '../src/services/proposalStatus';
import { resetDb, testDb } from './helpers/db';
import { seedUser } from './helpers/app';

const shelfLife = { sealed: { days: 5, confidence: 'medium' as const, source: 'model_estimate' as const } };

async function seedFoodAndLot(db: ReturnType<typeof testDb>, p: Awaited<ReturnType<typeof seedUser>>['principal']) {
  return db.transaction(async (tx) => {
    const cs = await openChangeSet(tx, p, { label: 'Receipt: test' });
    const { food } = await createOrReuseFood(tx, cs, { name: 'Whole milk', perishability: 'perishable', shelfLife });
    const aliased = await addAlias(tx, cs, food, 'WHOLE MILK 1 GAL');
    const lot = await addLot(tx, cs, { food: aliased, location: 'fridge', quantity: { kind: 'exact', amount: 1, unit: 'count' }, acquiredOn: '2026-09-28' });
    return { cs, food: aliased, lot };
  });
}

describe('change engine', () => {
  beforeEach(() => resetDb());
  const db = testDb();

  it('records every change in a change set with before/after snapshots', async () => {
    const { principal } = await seedUser(db);
    const { cs, food, lot } = await seedFoodAndLot(db, principal);
    expect(food.aliases).toEqual(['whole milk 1 gal']);
    expect(lot.expires).toMatchObject({ on: '2026-10-03', kind: 'estimated' });
    const rows = await db.select().from(changes).where(eq(changes.changeSetId, cs.id)).orderBy(changes.seq);
    expect(rows.map((r) => r.op)).toEqual(['create_food', 'add_alias', 'add_lot']);
    expect(rows[2]?.before).toBeNull();
    expect(rows[2]?.after).toMatchObject({ id: lot.id, version: 1 });
  });

  it('reuses an existing food by normalized name', async () => {
    const { principal } = await seedUser(db);
    await seedFoodAndLot(db, principal);
    const again = await db.transaction(async (tx) => {
      const cs = await openChangeSet(tx, principal, { label: 'x' });
      return createOrReuseFood(tx, cs, { name: 'WHOLE  milk', perishability: 'perishable' });
    });
    expect(again.created).toBe(false);
  });

  it('undoes a change set with compensating changes and keeps history', async () => {
    const { principal } = await seedUser(db);
    const { cs, food, lot } = await seedFoodAndLot(db, principal);
    const r = await undoChangeSet(db, principal, { change_set_id: cs.id, idempotency_key: 'undo-00001' });
    expect(r).toMatchObject({ reverted_change_set_id: cs.id, lots_voided: 1, foods_archived: 1, aliases_removed: 1 });
    const [l] = await db.select().from(lots).where(eq(lots.id, lot.id));
    expect(l).toMatchObject({ status: 'voided', version: 2 });
    const [f] = await db.select().from(foods).where(eq(foods.id, food.id));
    expect(f?.archivedAt).not.toBeNull();
    expect(f?.aliases).toEqual([]);
    const sets = await db.select().from(changeSets).where(eq(changeSets.householdId, principal.householdId));
    expect(sets).toHaveLength(2);
  });

  it('refuses to undo twice', async () => {
    const { principal } = await seedUser(db);
    const { cs } = await seedFoodAndLot(db, principal);
    await undoChangeSet(db, principal, { change_set_id: cs.id, idempotency_key: 'undo-00002' });
    await expect(undoChangeSet(db, principal, { change_set_id: cs.id, idempotency_key: 'undo-00003' })).rejects.toMatchObject({ code: 'already_reverted' });
  });

  it('refuses to undo when a lot changed afterwards', async () => {
    const { principal } = await seedUser(db);
    const { cs, lot } = await seedFoodAndLot(db, principal);
    await db.update(lots).set({ version: 2 }).where(eq(lots.id, lot.id));
    await expect(undoChangeSet(db, principal, { change_set_id: cs.id, idempotency_key: 'undo-00004' })).rejects.toMatchObject({ code: 'undo_conflict', details: { lot_ids: [lot.id] } });
  });

  it('revives an archived food instead of duplicating it', async () => {
    const { principal } = await seedUser(db);
    const { cs, food } = await seedFoodAndLot(db, principal);
    await undoChangeSet(db, principal, { change_set_id: cs.id, idempotency_key: 'undo-00005' });
    const revived = await db.transaction(async (tx) => {
      const cs2 = await openChangeSet(tx, principal, { label: 'again' });
      return createOrReuseFood(tx, cs2, { name: 'Whole milk', perishability: 'perishable' });
    });
    expect(revived).toMatchObject({ created: false, food: { id: food.id, archivedAt: null } });
  });

  it('cannot undo another household\'s change set', async () => {
    const a = await seedUser(db, 'a@example.com');
    const b = await seedUser(db, 'b@example.com');
    const { cs } = await seedFoodAndLot(db, a.principal);
    await expect(undoChangeSet(db, b.principal, { change_set_id: cs.id, idempotency_key: 'undo-00006' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('deriveProposalStatus', () => {
  const op = (decision: string, applied = false) => ({ decision, appliedAt: applied ? new Date() : null });
  it('derives pending, partial, applied and rejected', () => {
    expect(deriveProposalStatus([op('pending'), op('accepted')])).toBe('pending');
    expect(deriveProposalStatus([op('accepted', true), op('pending')])).toBe('partial');
    expect(deriveProposalStatus([op('accepted', true), op('rejected')])).toBe('applied');
    expect(deriveProposalStatus([op('rejected'), op('rejected')])).toBe('rejected');
  });
});
