import { beforeEach, describe, expect, it } from 'vitest';
import { foods, lots, observations } from '../src/db/schema';
import { resetDb, testDb } from './helpers/db';
import { seedUser } from './helpers/app';

describe('ledger schema', () => {
  beforeEach(() => resetDb());
  const db = testDb();

  it('stores a food and a lot with JSON quantity and expiry', async () => {
    const { principal } = await seedUser(db);
    const [food] = await db
      .insert(foods)
      .values({ householdId: principal.householdId, name: 'Whole milk', normalizedName: 'whole milk', perishability: 'perishable' })
      .returning();
    expect(food?.aliases).toEqual([]);
    const [lot] = await db
      .insert(lots)
      .values({
        householdId: principal.householdId,
        foodId: food!.id,
        location: 'fridge',
        quantity: { kind: 'exact', amount: 1, unit: 'count' },
        expires: { on: '2026-10-03', kind: 'estimated', confidence: 'medium', basis: 'x' },
        acquiredOn: '2026-09-28',
      })
      .returning();
    expect(lot).toMatchObject({ state: 'sealed', status: 'active', version: 1, acquiredOn: '2026-09-28' });
  });

  it('enforces one observation per receipt fingerprint per household', async () => {
    const { principal } = await seedUser(db);
    const row = { householdId: principal.householdId, kind: 'receipt' as const, observedAt: new Date(), actorUserId: principal.userId, payload: {}, fingerprint: 'fp1' };
    await db.insert(observations).values(row);
    await expect(db.insert(observations).values(row)).rejects.toThrow();
  });
});
