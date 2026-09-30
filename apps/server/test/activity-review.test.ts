/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createFakeProvider } from '@buttery/reasoning';
import { foods, lots } from '../src/db/schema';
import type { ReasoningPort } from '../src/reasoning/port';
import { correctItem, logActivity, logText } from '../src/services/activity';
import { resolveProposal } from '../src/services/proposals';
import { submitReceipt } from '../src/services/receipts';
import { resetDb, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';
import { createFakeReasoning } from './helpers/fakeReasoning';
import { fixtureReceipt } from './fixtures/receipts';

const db = testDb();
const NOW = new Date('2026-09-29T15:00:00Z');
let n = 0;
const key = () => `rev-${Date.now()}-${n++}`;
async function stocked(reasoning: ReasoningPort = createFakeReasoning()) {
  const { principal } = await seedUser(db);
  const deps = testDeps({ reasoning });
  const r = await submitReceipt(deps, principal, { kind: 'receipt', payload: fixtureReceipt('warehouse'), idempotency_key: key() });
  await resolveProposal(deps, principal, { proposal_id: r.proposal_id, accept_remaining: true, apply: true, idempotency_key: key() }, NOW);
  return { principal, deps };
}
const lotsOf = async (householdId: string, name: string) =>
  (await db.select({ lot: lots }).from(lots).innerJoin(foods, eq(foods.id, lots.foodId)).where(and(eq(lots.householdId, householdId), eq(foods.normalizedName, name)))).map((r) => r.lot);
const buy = (deps: any, p: any, name: string) => logActivity(deps, p, { activities: [{ kind: 'bought', items: [{ food_name: name }] }], idempotency_key: key() }, NOW);

describe('C1: lot selection respects state', () => {
  beforeEach(() => resetDb());

  it('"opened the milk" opens the sealed one, not the one already open', async () => {
    const { principal, deps } = await stocked();
    await buy(deps, principal, 'whole milk');
    const [a] = await lotsOf(principal.householdId, 'whole milk');
    await db.update(lots).set({ state: 'opened', openedOn: '2026-09-27', expires: { on: '2026-09-30', kind: 'estimated', confidence: 'medium', basis: 'x' } }).where(eq(lots.id, a!.id));
    const r = await logActivity(deps, principal, { activities: [{ kind: 'opened', items: [{ food_name: 'whole milk' }] }], idempotency_key: key() }, NOW);
    expect(r.applied).toHaveLength(1);
    const after = await lotsOf(principal.householdId, 'whole milk');
    expect(after.find((l) => l.id === a!.id)?.openedOn).toBe('2026-09-27');
    expect(after.filter((l) => l.state === 'opened')).toHaveLength(2);
  });

  it('"thawed the chicken" thaws the frozen one', async () => {
    const { principal, deps } = await stocked();
    await buy(deps, principal, 'chicken breast');
    const [a, b] = await lotsOf(principal.householdId, 'chicken breast');
    await db.update(lots).set({ state: 'frozen', frozenOn: '2026-09-01', location: 'freezer' }).where(eq(lots.id, b!.id));
    await logActivity(deps, principal, { activities: [{ kind: 'thawed', items: [{ food_name: 'chicken breast' }] }], idempotency_key: key() }, NOW);
    const after = await lotsOf(principal.householdId, 'chicken breast');
    expect(after.find((l) => l.id === a!.id)?.state).toBe('sealed');
    expect(after.find((l) => l.id === b!.id)?.state).toBe('thawed');
  });

  it('will not freeze an item already past its date', async () => {
    const { principal, deps } = await stocked();
    const [c] = await lotsOf(principal.householdId, 'chicken breast');
    await db.update(lots).set({ acquiredOn: '2026-09-01', expires: { on: '2026-09-06', kind: 'estimated', confidence: 'medium', basis: 'x' } }).where(eq(lots.id, c!.id));
    const r = await logActivity(deps, principal, { activities: [{ kind: 'froze', items: [{ lot_id: c!.id }] }], idempotency_key: key() }, NOW);
    expect(r.change_set_id).toBeNull();
    expect(r.unresolved[0]?.reason).toContain('past its');
  });
});

describe('C2: units', () => {
  beforeEach(() => resetDb());

  it('a spoonful of an item measured by weight leaves the amount unknown instead of using it up', async () => {
    const { principal, deps } = await stocked();
    const r = await logActivity(deps, principal, { activities: [{ kind: 'used', items: [{ food_name: 'chicken breast', quantity: { amount: 2, unit: 'tbsp' } }] }], idempotency_key: key() }, NOW);
    expect(r.applied[0]?.summary).not.toContain('Used up');
    expect((await lotsOf(principal.householdId, 'chicken breast'))[0]).toMatchObject({ status: 'active', quantity: { kind: 'unknown' } });
  });

  it('an unrecognised unit never subtracts, and says so', async () => {
    const { principal, deps } = await stocked();
    const r = await logActivity(deps, principal, { activities: [{ kind: 'used', items: [{ food_name: 'eggs', quantity: { amount: 3, unit: 'slices' } }] }], idempotency_key: key() }, NOW);
    expect((await lotsOf(principal.householdId, 'eggs'))[0]).toMatchObject({ status: 'active', quantity: { amount: 24 } });
    expect(r.notes.join(' ')).toContain('slices');
  });

  it('an amount with no kind is exact ("used 2 eggs" leaves 22, not ~22)', async () => {
    const { principal, deps } = await stocked();
    await logActivity(deps, principal, { activities: [{ kind: 'used', items: [{ food_name: 'eggs', quantity: { amount: 2 } }] }], idempotency_key: key() }, NOW);
    expect((await lotsOf(principal.householdId, 'eggs'))[0]?.quantity).toEqual({ kind: 'exact', amount: 22, unit: 'count' });
  });
});

describe('C3 / I3: log_text only applies what the server fully resolves', () => {
  beforeEach(() => resetDb());
  const parser = (items: any[]) =>
    createFakeProvider({ parseActivity: () => ({ activities: [{ kind: 'finished', items }], ambiguities: [], confidence: 'high' }) }) as unknown as ReasoningPort;

  it('holds a confident parse for confirmation when the server cannot tell which item', async () => {
    const { principal } = await stocked();
    const deps = testDeps();
    await buy(deps, principal, 'chicken thighs');
    const r = await logText(testDeps({ reasoning: parser([{ food_name: 'Whole milk' }, { food_name: 'chicken' }]) }), principal, { text: 'finished the milk and the chicken', idempotency_key: key() }, NOW);
    expect(r.status).toBe('needs_confirmation');
    expect((r as any).unresolved?.[0]?.reason).toContain('several foods');
    expect((await lotsOf(principal.householdId, 'whole milk'))[0]?.status).toBe('active');
  });

  it('treats model items with no lot_id or food_name as needing confirmation, not a crash', async () => {
    const { principal } = await stocked();
    const r = await logText(testDeps({ reasoning: parser([{ quantity: { kind: 'approx', fraction: 0.5 } }]) }), principal, { text: 'used half', idempotency_key: key() }, NOW);
    expect(r.status).toBe('needs_confirmation');
  });
});

describe('I1: several items of the same food in one call', () => {
  beforeEach(() => resetDb());

  it('"finished both milks" finishes two different cartons', async () => {
    const { principal, deps } = await stocked();
    await buy(deps, principal, 'whole milk');
    const r = await logActivity(deps, principal, { activities: [{ kind: 'finished', items: [{ food_name: 'whole milk' }, { food_name: 'whole milk' }] }], idempotency_key: key() }, NOW);
    expect(new Set(r.applied.map((a) => a.lot_id)).size).toBe(2);
    expect((await lotsOf(principal.householdId, 'whole milk')).every((l) => l.status === 'depleted')).toBe(true);
  });
});

describe('I2 / I7: matching and buying', () => {
  beforeEach(() => resetDb());

  it('"eggplant" does not match Eggs', async () => {
    const { principal, deps } = await stocked();
    const r = await logActivity(deps, principal, { activities: [{ kind: 'discarded', items: [{ food_name: 'eggplant' }] }], idempotency_key: key() }, NOW);
    expect(r.change_set_id).toBeNull();
    expect((await lotsOf(principal.householdId, 'eggs'))[0]?.status).toBe('active');
  });

  it('"bought almond milk" creates Almond milk instead of adding to Whole milk', async () => {
    const { principal, deps } = await stocked();
    await buy(deps, principal, 'almond milk');
    expect(await lotsOf(principal.householdId, 'whole milk')).toHaveLength(1);
    expect(await lotsOf(principal.householdId, 'almond milk')).toHaveLength(1);
  });

  it('a new food bought without a receipt is classified by Crusoe (rice → shelf-stable, pantry)', async () => {
    const provider = createFakeProvider({
      canonicalizeItems: (input: any) => ({ lines: input.lines.map((l: any) => ({ line_id: l.line_id, canonical_name: 'rice', category: 'grains', perishability: 'shelf_stable', line_kind: 'item', match: { food_id: 'new', confidence: 'high' }, rationale: 'dry grain' })) }),
      estimateShelfLife: () => ({ per_state: { sealed: { days: 365, confidence: 'medium' }, opened: { days: 180, confidence: 'medium' }, frozen: { days: 365, confidence: 'low' } }, rationale: 'dry' }),
    }) as unknown as ReasoningPort;
    const { principal } = await stocked();
    await buy(testDeps({ reasoning: provider }), principal, 'rice');
    const [rice] = await db.select().from(foods).where(eq(foods.normalizedName, 'rice'));
    expect(rice?.perishability).toBe('shelf_stable');
    expect((await lotsOf(principal.householdId, 'rice'))[0]?.location).toBe('pantry');
  });
});

describe('I4: correct_item', () => {
  beforeEach(() => resetDb());

  it('refuses to correct a used-up item unless a quantity brings it back', async () => {
    const { principal, deps } = await stocked();
    const [milk] = await lotsOf(principal.householdId, 'whole milk');
    await logActivity(deps, principal, { activities: [{ kind: 'finished', items: [{ lot_id: milk!.id }] }], idempotency_key: key() }, NOW);
    await expect(correctItem(deps, principal, { lot_id: milk!.id, location: 'pantry', idempotency_key: key() }, NOW)).rejects.toMatchObject({ code: 'not_active' });
    const back = await correctItem(deps, principal, { lot_id: milk!.id, quantity: { kind: 'approx', amount: 0.5, unit: 'count' }, idempotency_key: key() }, NOW);
    expect(back.lot.status).toBe('active');
  });

  it('a state change to frozen estimates frozen shelf life and moves it to the freezer', async () => {
    const fake = createFakeReasoning();
    const { principal, deps } = await stocked(fake);
    const [chicken] = await lotsOf(principal.householdId, 'chicken breast');
    await db.update(foods).set({ shelfLife: { sealed: { days: 5, confidence: 'medium', source: 'default_rule' } } }).where(eq(foods.id, chicken!.foodId));
    const r = await correctItem(deps, principal, { lot_id: chicken!.id, state: 'frozen', idempotency_key: key() }, NOW);
    expect(r.lot).toMatchObject({ state: 'frozen', location: 'freezer' });
    expect(r.lot.expires).not.toBeNull();
  });
});
