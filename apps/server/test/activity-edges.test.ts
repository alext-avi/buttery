/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createFakeProvider } from '@buttery/reasoning';
import { changes, foods, lots, observations } from '../src/db/schema';
import { createApp } from '../src/http/app';
import type { ReasoningPort } from '../src/reasoning/port';
import { correctItem, getChanges, logActivity, logText } from '../src/services/activity';
import { undoChangeSet } from '../src/services/changes';
import { resolveProposal } from '../src/services/proposals';
import { submitReceipt } from '../src/services/receipts';
import { resetDb, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';
import { createFakeReasoning } from './helpers/fakeReasoning';
import { fixtureReceipt } from './fixtures/receipts';

const db = testDb();
const NOW = new Date('2026-09-29T15:00:00Z');
let n = 0;
const key = () => `edge-${Date.now()}-${n++}`;

async function stocked(email = 'alex@example.com', reasoning: ReasoningPort = createFakeReasoning()) {
  const { principal, token } = await seedUser(db, email);
  const deps = testDeps({ reasoning });
  const r = await submitReceipt(deps, principal, { kind: 'receipt', payload: fixtureReceipt('warehouse'), idempotency_key: key() });
  await resolveProposal(deps, principal, { proposal_id: r.proposal_id, accept_remaining: true, apply: true, idempotency_key: key() }, NOW);
  return { principal, deps, token };
}
const lotsOf = async (householdId: string, name: string) =>
  (await db.select({ lot: lots }).from(lots).innerJoin(foods, eq(foods.id, lots.foodId)).where(and(eq(lots.householdId, householdId), eq(foods.normalizedName, name)))).map((r) => r.lot);

describe('logActivity edge cases', () => {
  beforeEach(() => resetDb());

  it("never touches another household's item, even by lot_id", async () => {
    const a = await stocked('a@example.com');
    const b = await stocked('b@example.com');
    const [aChicken] = await lotsOf(a.principal.householdId, 'chicken breast');
    const r = await logActivity(b.deps, b.principal, { activities: [{ kind: 'discarded', items: [{ lot_id: aChicken!.id }] }], idempotency_key: key() }, NOW);
    expect(r.change_set_id).toBeNull();
    expect(r.unresolved[0]?.reason).toContain('not in current inventory');
    expect((await lotsOf(a.principal.householdId, 'chicken breast'))[0]?.status).toBe('active');
  });

  it('will not act on an item that is already used up', async () => {
    const { principal, deps } = await stocked();
    const [eggs] = await lotsOf(principal.householdId, 'eggs');
    await logActivity(deps, principal, { activities: [{ kind: 'finished', items: [{ lot_id: eggs!.id }] }], idempotency_key: key() }, NOW);
    const again = await logActivity(deps, principal, { activities: [{ kind: 'discarded', items: [{ lot_id: eggs!.id }] }], idempotency_key: key() }, NOW);
    expect(again.change_set_id).toBeNull();
    expect((await lotsOf(principal.householdId, 'eggs'))[0]?.status).toBe('depleted');
  });

  it('applies two actions on the same item in order, and one undo reverses both', async () => {
    const { principal, deps } = await stocked();
    const r = await logActivity(deps, principal, {
      activities: [
        { kind: 'froze', items: [{ food_name: 'chicken breast' }] },
        { kind: 'moved', items: [{ food_name: 'chicken breast', to_location: 'garage freezer' }] },
      ],
      idempotency_key: key(),
    }, NOW);
    expect(r.applied.map((a) => a.kind)).toEqual(['froze', 'moved']);
    expect((await lotsOf(principal.householdId, 'chicken breast'))[0]).toMatchObject({ state: 'frozen', location: 'garage freezer' });
    expect((await db.select().from(changes).where(eq(changes.changeSetId, r.change_set_id!))).filter((c) => c.op === 'update_lot')).toHaveLength(2);
    await undoChangeSet(db, principal, { change_set_id: r.change_set_id!, idempotency_key: key() });
    expect((await lotsOf(principal.householdId, 'chicken breast'))[0]).toMatchObject({ state: 'sealed', location: 'fridge' });
  });

  it('asks which one when a name could mean several foods on hand', async () => {
    const { principal, deps } = await stocked();
    await logActivity(deps, principal, { activities: [{ kind: 'bought', items: [{ food_name: '2% milk' }] }], idempotency_key: key() }, NOW);
    const r = await logActivity(deps, principal, { activities: [{ kind: 'finished', items: [{ food_name: 'milk' }] }], idempotency_key: key() }, NOW);
    expect(r.change_set_id).toBeNull();
    expect(r.unresolved[0]?.reason).toContain('several foods');
    expect(r.unresolved[0]?.candidates.map((c) => c.food_name).sort()).toEqual(['2% milk', 'Whole milk']);
  });

  it('buying a new food twice reuses it instead of creating a duplicate', async () => {
    const { principal, deps } = await stocked();
    await logActivity(deps, principal, { activities: [{ kind: 'bought', items: [{ food_name: 'sourdough bread' }] }], idempotency_key: key() }, NOW);
    await logActivity(deps, principal, { activities: [{ kind: 'bought', items: [{ food_name: 'Sourdough bread' }] }], idempotency_key: key() }, NOW);
    expect(await db.select().from(foods).where(eq(foods.normalizedName, 'sourdough bread'))).toHaveLength(1);
    expect(await lotsOf(principal.householdId, 'sourdough bread')).toHaveLength(2);
  });

  it('refuses a transition that makes no sense and changes nothing', async () => {
    const { principal, deps } = await stocked();
    const r = await logActivity(deps, principal, { activities: [{ kind: 'thawed', items: [{ food_name: 'whole milk' }] }], idempotency_key: key() }, NOW);
    expect(r.change_set_id).toBeNull();
    expect(r.unresolved[0]?.reason).toContain("isn't frozen");
    expect((await lotsOf(principal.householdId, 'whole milk'))[0]?.state).toBe('sealed');
  });

  it('applies what it can and reports the rest in the same call', async () => {
    const { principal, deps } = await stocked();
    const r = await logActivity(deps, principal, {
      activities: [
        { kind: 'finished', items: [{ food_name: 'eggs' }] },
        { kind: 'discarded', items: [{ food_name: 'kale' }] },
      ],
      idempotency_key: key(),
    }, NOW);
    expect(r.applied.map((a) => a.food_name)).toEqual(['Eggs']);
    expect(r.unresolved.map((u) => u.food_name)).toEqual(['kale']);
    expect(r.next.join(' ')).toContain('kale');
  });

  it('refuses to undo an activity when the item changed afterwards', async () => {
    const { principal, deps } = await stocked();
    const froze = await logActivity(deps, principal, { activities: [{ kind: 'froze', items: [{ food_name: 'chicken breast' }] }], idempotency_key: key() }, NOW);
    await logActivity(deps, principal, { activities: [{ kind: 'moved', items: [{ food_name: 'chicken breast', to_location: 'garage freezer' }] }], idempotency_key: key() }, NOW);
    await expect(undoChangeSet(db, principal, { change_set_id: froze.change_set_id!, idempotency_key: key() })).rejects.toMatchObject({ code: 'undo_conflict' });
  });

  it('rejects a request with neither lot_id nor food_name', async () => {
    const { principal, deps } = await stocked();
    await expect(logActivity(deps, principal, { activities: [{ kind: 'finished', items: [{} as any] }], idempotency_key: key() }, NOW)).rejects.toThrow();
  });
});

describe('logText edge cases', () => {
  beforeEach(() => resetDb());

  it('does not apply a model-invented item id, even when the model claims high confidence', async () => {
    const liar = createFakeProvider({
      parseActivity: () => ({ activities: [{ kind: 'discarded', items: [{ lot_id: 'not-a-real-lot', food_name: 'Whole milk' }] }], ambiguities: [], confidence: 'high' }),
    }) as unknown as ReasoningPort;
    const { principal } = await stocked();
    const r = await logText(testDeps({ reasoning: liar }), principal, { text: 'tossed the milk', idempotency_key: key() }, NOW);
    expect(r.status).toBe('needs_confirmation');
    expect((await lotsOf(principal.householdId, 'whole milk'))[0]?.status).toBe('active');
  });

  it('holds "cooked" for confirmation because recipes are not supported yet', async () => {
    const cook = createFakeProvider({
      parseActivity: () => ({ activities: [{ kind: 'cooked', items: [{ food_name: 'Chicken breast' }] }], ambiguities: [], confidence: 'high' }),
    }) as unknown as ReasoningPort;
    const { principal } = await stocked();
    const r = await logText(testDeps({ reasoning: cook }), principal, { text: 'we cooked the chicken', idempotency_key: key() }, NOW);
    expect(r.status).toBe('needs_confirmation');
    expect(r.ambiguities.map((a) => a.reason).join(' ')).toContain("isn't supported yet");
  });

  it('falls back to asking when the reasoning provider fails', async () => {
    const { principal } = await stocked();
    const r = await logText(testDeps({ reasoning: createFakeReasoning({ fail: true }) }), principal, { text: 'used half the milk', idempotency_key: key() }, NOW);
    expect(r).toMatchObject({ status: 'needs_confirmation', change_set_id: null });
  });

  it('replays the same key without recording the words twice', async () => {
    const { principal } = await stocked();
    const deps = testDeps();
    const k = key();
    const a = await logText(deps, principal, { text: 'used some milk', idempotency_key: k }, NOW);
    const b = await logText(deps, principal, { text: 'used some milk', idempotency_key: k }, NOW);
    expect(b).toEqual(a);
    const rows = await db.select().from(observations).where(eq(observations.kind, 'user_statement'));
    expect(rows.filter((o) => (o.payload as any).text === 'used some milk')).toHaveLength(1);
  });
});

describe('correctItem and getChanges edge cases', () => {
  beforeEach(() => resetDb());

  it("cannot correct another household's item", async () => {
    const a = await stocked('a@example.com');
    const b = await stocked('b@example.com');
    const [aEggs] = await lotsOf(a.principal.householdId, 'eggs');
    await expect(correctItem(b.deps, b.principal, { lot_id: aEggs!.id, location: 'pantry', idempotency_key: key() }, NOW)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('clearing a printed date falls back to the estimate', async () => {
    const { principal, deps } = await stocked();
    const [eggs] = await lotsOf(principal.householdId, 'eggs');
    await correctItem(deps, principal, { lot_id: eggs!.id, expires_on: '2026-10-20', idempotency_key: key() }, NOW);
    const cleared = await correctItem(deps, principal, { lot_id: eggs!.id, expires_on: null, idempotency_key: key() }, NOW);
    expect(cleared.lot.expires).toMatchObject({ kind: 'estimated', on: '2026-10-03' });
  });

  it('filters changes by time and marks undone ones', async () => {
    const { principal, deps } = await stocked();
    const froze = await logActivity(deps, principal, { activities: [{ kind: 'froze', items: [{ food_name: 'chicken breast' }] }], idempotency_key: key() }, NOW);
    await undoChangeSet(db, principal, { change_set_id: froze.change_set_id!, idempotency_key: key() });
    const all = await getChanges(deps, principal, { limit: 10 }, NOW);
    expect(all.changes.find((c) => c.change_set_id === froze.change_set_id)?.undone).toBe(true);
    expect(all.changes[0]?.is_undo).toBe(true);
    const none = await getChanges(deps, principal, { since: new Date(Date.now() + 60_000).toISOString() }, NOW);
    expect(none.changes).toHaveLength(0);
  });
});

describe('web item activity endpoint', () => {
  beforeEach(() => resetDb());
  const login = async (app: ReturnType<typeof createApp>, token: string) =>
    (await app.request('/auth/token-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })).headers.get('set-cookie')!.split(';')[0]!;

  it('requires a session and JSON, and stays inside the household', async () => {
    const a = await stocked('a@example.com');
    const b = await stocked('b@example.com');
    const app = createApp(testDeps());
    const [aChicken] = await lotsOf(a.principal.householdId, 'chicken breast');
    const body = JSON.stringify({ kind: 'froze', idempotency_key: key() });
    expect((await app.request(`/api/items/${aChicken!.id}/activity`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status).toBe(401);
    const cookieB = await login(app, b.token);
    expect((await app.request(`/api/items/${aChicken!.id}/activity`, { method: 'POST', headers: { cookie: cookieB, 'content-type': 'text/plain' }, body })).status).toBe(415);
    const res = await app.request(`/api/items/${aChicken!.id}/activity`, { method: 'POST', headers: { cookie: cookieB, 'content-type': 'application/json' }, body });
    expect(((await res.json()) as any).change_set_id).toBeNull();
    expect((await lotsOf(a.principal.householdId, 'chicken breast'))[0]?.state).toBe('sealed');
  });

  it('freezes an item for the signed-in household', async () => {
    const a = await stocked('a@example.com');
    const app = createApp(testDeps());
    const cookie = await login(app, a.token);
    const [chicken] = await lotsOf(a.principal.householdId, 'chicken breast');
    const res = await app.request(`/api/items/${chicken!.id}/activity`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'froze', idempotency_key: key() }) });
    expect(((await res.json()) as any).applied[0].kind).toBe('froze');
    expect((await lotsOf(a.principal.householdId, 'chicken breast'))[0]?.state).toBe('frozen');
  });
});
