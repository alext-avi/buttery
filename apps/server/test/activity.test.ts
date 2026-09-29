/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createFakeProvider } from '@buttery/reasoning';
import { foods, lots, observations } from '../src/db/schema';
import type { ReasoningPort } from '../src/reasoning/port';
import { correctItem, getChanges, logActivity, logText } from '../src/services/activity';
import { getItem } from '../src/services/inventory';
import { undoChangeSet } from '../src/services/changes';
import { resolveProposal } from '../src/services/proposals';
import { submitReceipt } from '../src/services/receipts';
import { resetDb, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';
import { createFakeReasoning } from './helpers/fakeReasoning';
import { fixtureReceipt } from './fixtures/receipts';

const db = testDb();
const NOW = new Date('2026-09-29T15:00:00Z'); // Tue 2026-09-29 in New York
let n = 0;
const key = () => `act-${Date.now()}-${n++}`;

async function stocked(reasoning: ReasoningPort = createFakeReasoning()) {
  const { principal } = await seedUser(db);
  const deps = testDeps({ reasoning });
  const r = await submitReceipt(deps, principal, { kind: 'receipt', payload: fixtureReceipt('warehouse'), idempotency_key: key() });
  await resolveProposal(deps, principal, { proposal_id: r.proposal_id, accept_remaining: true, apply: true, idempotency_key: key() }, NOW);
  return { principal, deps };
}
const lotOf = async (householdId: string, name: string) => {
  const rows = await db.select({ lot: lots }).from(lots).innerJoin(foods, eq(foods.id, lots.foodId)).where(and(eq(lots.householdId, householdId), eq(foods.normalizedName, name)));
  return rows.map((r) => r.lot);
};

describe('logActivity', () => {
  beforeEach(() => resetDb());

  it('freezes an item, re-estimates its expiry, and can be undone', async () => {
    const { principal, deps } = await stocked();
    const r = await logActivity(deps, principal, { activities: [{ kind: 'froze', items: [{ food_name: 'chicken breast' }] }], idempotency_key: key() }, NOW);
    expect(r.applied[0]).toMatchObject({ kind: 'froze', food_name: 'Chicken breast', summary: expect.stringContaining('freezer') });
    const [chicken] = await lotOf(principal.householdId, 'chicken breast');
    const item = await getItem(deps, principal, chicken!.id, NOW);
    expect(item.evidence.map((e) => e.summary)).toContain('Update: frozen');
    expect(chicken).toMatchObject({ state: 'frozen', location: 'freezer', frozenOn: '2026-09-29', expires: { on: '2027-03-28', kind: 'estimated' } });
    await undoChangeSet(db, principal, { change_set_id: r.change_set_id!, idempotency_key: key() });
    const [restored] = await lotOf(principal.householdId, 'chicken breast');
    expect(restored).toMatchObject({ state: 'sealed', location: 'fridge', expires: { on: '2026-10-03' } });
  });

  it('uses half the milk and finishes the eggs in one change set', async () => {
    const { principal, deps } = await stocked();
    const r = await logActivity(deps, principal, {
      activities: [
        { kind: 'used', items: [{ food_name: 'whole milk', quantity: { kind: 'approx', fraction: 0.5 } }] },
        { kind: 'finished', items: [{ food_name: 'eggs' }] },
      ],
      idempotency_key: key(),
    }, NOW);
    expect(r.applied).toHaveLength(2);
    expect((await lotOf(principal.householdId, 'whole milk'))[0]?.quantity).toMatchObject({ kind: 'approx', amount: 0.5 });
    expect((await lotOf(principal.householdId, 'eggs'))[0]?.status).toBe('depleted');
  });

  it('picks the lot expiring first when there are several, and says so', async () => {
    const { principal, deps } = await stocked();
    await db.update(lots).set({ printedExpiryOn: '2026-09-30', expires: { on: '2026-09-30', kind: 'printed', confidence: 'high', basis: 'printed on package' } })
      .where(eq(lots.id, (await lotOf(principal.householdId, 'baby spinach'))[0]!.id));
    const second = await submitReceipt(deps, principal, { kind: 'receipt', payload: fixtureReceipt('mixed'), idempotency_key: key() });
    await resolveProposal(deps, principal, { proposal_id: second.proposal_id, accept_remaining: true, apply: true, idempotency_key: key() }, NOW);
    expect(await lotOf(principal.householdId, 'baby spinach')).toHaveLength(2);
    const r = await logActivity(deps, principal, { activities: [{ kind: 'discarded', items: [{ food_name: 'spinach' }] }], idempotency_key: key() }, NOW);
    expect(r.assumptions.join(' ')).toContain('2 on hand');
    const spinach = await lotOf(principal.householdId, 'baby spinach');
    expect(spinach.find((l) => l.status === 'discarded')?.expires?.on).toBe('2026-09-30');
  });

  it('applies nothing for an item it cannot find, and says why', async () => {
    const { principal, deps } = await stocked();
    const r = await logActivity(deps, principal, { activities: [{ kind: 'discarded', items: [{ food_name: 'kale' }] }], idempotency_key: key() }, NOW);
    expect(r.change_set_id).toBeNull();
    expect(r.unresolved[0]).toMatchObject({ food_name: 'kale', reason: expect.stringContaining('No kale') });
  });

  it('asks Crusoe for a shelf-life estimate when the food has none for the new state', async () => {
    const fake = createFakeReasoning();
    const { principal, deps } = await stocked(fake);
    await logActivity(deps, principal, { activities: [{ kind: 'froze', items: [{ food_name: 'chicken breast' }] }], idempotency_key: key() }, NOW);
    const before = fake.calls.shelfLife.length;
    await logActivity(deps, principal, { activities: [{ kind: 'thawed', items: [{ food_name: 'chicken breast' }] }], idempotency_key: key() }, NOW);
    expect(fake.calls.shelfLife.slice(before).map((c) => c.states)).toEqual([['thawed']]);
    const [f] = await db.select().from(foods).where(eq(foods.normalizedName, 'chicken breast'));
    expect(f?.shelfLife.thawed).toMatchObject({ source: 'model_estimate' });
    expect((await lotOf(principal.householdId, 'chicken breast'))[0]).toMatchObject({ state: 'thawed', location: 'fridge' });
  });

  it('replays the same idempotency key', async () => {
    const { principal, deps } = await stocked();
    const k = key();
    const input = { activities: [{ kind: 'used' as const, items: [{ food_name: 'whole milk', quantity: { kind: 'approx' as const, fraction: 0.5 } }] }], idempotency_key: k };
    const a = await logActivity(deps, principal, input, NOW);
    const b = await logActivity(deps, principal, input, NOW);
    expect(b).toEqual(a);
    expect((await lotOf(principal.householdId, 'whole milk'))[0]?.quantity.amount).toBe(0.5);
  });

  it('records a purchase without a receipt as an approximate new lot', async () => {
    const { principal, deps } = await stocked();
    const r = await logActivity(deps, principal, { activities: [{ kind: 'bought', items: [{ food_name: 'whole milk' }] }], idempotency_key: key() }, NOW);
    expect(r.applied[0]?.summary).toContain('Added');
    expect(await lotOf(principal.householdId, 'whole milk')).toHaveLength(2);
  });
});

describe('logText', () => {
  beforeEach(() => resetDb());
  const parser = (confidence: 'high' | 'medium', ambiguous = false) =>
    createFakeProvider({
      parseActivity: (input: any) => {
        const milk = input.context.lots.find((l: any) => l.food_name === 'Whole milk');
        return {
          activities: [{ kind: 'used', items: [{ lot_id: milk.lot_id, food_name: 'Whole milk', quantity: { kind: 'approx', fraction: 0.5 } }] }],
          ambiguities: ambiguous ? [{ text: 'the old stuff', reason: 'unclear which items', candidate_lot_ids: [] }] : [],
          confidence,
        };
      },
    }) as unknown as ReasoningPort;

  it('applies a confident parse straight away', async () => {
    const { principal } = await stocked();
    const r = await logText(testDeps({ reasoning: parser('high') }), principal, { text: 'we used half the milk', idempotency_key: key() }, NOW);
    expect(r).toMatchObject({ status: 'applied', confidence: 'high' });
    expect((await lotOf(principal.householdId, 'whole milk'))[0]?.quantity.amount).toBe(0.5);
  });

  it('holds an uncertain parse for confirmation in chat and keeps the words as evidence', async () => {
    const { principal } = await stocked();
    const r = await logText(testDeps({ reasoning: parser('medium', true) }), principal, { text: 'used half the milk and tossed the old stuff', idempotency_key: key() }, NOW);
    expect(r).toMatchObject({ status: 'needs_confirmation', change_set_id: null });
    expect(r.interpretation[0]).toMatchObject({ kind: 'used', items: [{ food_name: 'Whole milk' }] });
    expect(r.ambiguities[0]?.text).toBe('the old stuff');
    expect(r.next.join(' ')).toContain('log_activity');
    expect((await lotOf(principal.householdId, 'whole milk'))[0]?.quantity.amount).toBe(1);
    const statements = await db.select().from(observations).where(eq(observations.kind, 'user_statement'));
    expect(statements.some((o) => (o.payload as any).text === 'used half the milk and tossed the old stuff')).toBe(true);
  });
});

describe('correctItem and getChanges', () => {
  beforeEach(() => resetDb());

  it('corrects an item and lists what changed, newest first', async () => {
    const { principal, deps } = await stocked();
    const [yogurt] = await lotOf(principal.householdId, 'greek yogurt');
    const c = await correctItem(deps, principal, { lot_id: yogurt!.id, location: 'freezer', expires_on: '2026-10-20', quantity: { kind: 'exact', amount: 1, unit: 'count' }, reason: 'moved one tub', idempotency_key: key() }, NOW);
    expect(c.lot).toMatchObject({ location: 'freezer', expires: { on: '2026-10-20', kind: 'printed' } });
    const feed = await getChanges(deps, principal, { limit: 5 }, NOW);
    expect(feed.changes[0]).toMatchObject({ label: 'Corrected Greek yogurt', items: ['Greek yogurt'], undone: false });
    expect(feed.changes[1]?.label).toContain('Receipt');
  });
});
