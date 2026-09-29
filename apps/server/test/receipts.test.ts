import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { lots, observations, proposalOps, reasoningCalls } from '../src/db/schema';
import { addAlias, createOrReuseFood, openChangeSet } from '../src/services/changes';
import { submitReceipt } from '../src/services/receipts';
import type { LotDraft } from '../src/services/drafts';
import { resetDb, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';
import { createFakeReasoning } from './helpers/fakeReasoning';
import { fixtureReceipt } from './fixtures/receipts';

const db = testDb();
type Deps = ReturnType<typeof testDeps>;
type P = Awaited<ReturnType<typeof seedUser>>['principal'];
const submit = (deps: Deps, p: P, payload = fixtureReceipt('warehouse'), key = 'rcpt-00001') =>
  submitReceipt(deps, p, { kind: 'receipt', payload, idempotency_key: key });

async function opsFor(proposalId: string) {
  const rows = await db.select().from(proposalOps).where(eq(proposalOps.proposalId, proposalId)).orderBy(proposalOps.seq);
  return Object.fromEntries(rows.map((o) => [(o.payload as unknown as LotDraft).line.raw_text, o]));
}

describe('submitReceipt', () => {
  beforeEach(() => resetDb());

  it('builds a review-only proposal for the warehouse receipt', async () => {
    const { principal } = await seedUser(db);
    const r = await submit(testDeps(), principal);
    expect(r.review_url).toBe(`https://buttery.test/review/${r.proposal_id}`);
    expect(r.counts).toMatchObject({ lines: 6, items: 6, new_foods: 6, ignored: 0 });
    expect(r.auto_applied).toEqual([]);
    expect(await db.select().from(lots)).toHaveLength(0);

    const ops = await opsFor(r.proposal_id);
    expect(ops['GRK YOGURT 2X32 OZ']?.payload).toMatchObject({ quantity: { kind: 'exact', amount: 2, unit: 'count' }, package: { size: 32, unit: 'oz' } });
    expect(ops['EGGS 24 CT']?.payload).toMatchObject({ quantity: { amount: 24, unit: 'count' }, package: { count: 24 } });
    expect(ops['CHKN BREAST 3 LB']?.payload).toMatchObject({
      food_id: null,
      new_food: { name: 'Chicken breast', perishability: 'perishable', shelf_life: { sealed: { days: 5, source: 'model_estimate', model: 'fake-1' } } },
      acquired_on: '2026-09-28',
      location: 'fridge',
    });
  });

  it('never turns coupon, non-food or return lines into lots', async () => {
    const { principal } = await seedUser(db);
    const r = await submit(testDeps(), principal, fixtureReceipt('mixed'));
    expect(r.counts).toMatchObject({ lines: 7, items: 4, ignored: 3 });
    const ops = await opsFor(r.proposal_id);
    for (const raw of ['SPINACH COUPON', 'PAPER TOWELS 2 ROLL', 'RETURN: MILK 1/2 GAL']) expect(ops[raw]?.op).toBe('ignore_line');
    expect(ops['BANANAS']?.payload).toMatchObject({ quantity: { kind: 'exact', amount: 1.25, unit: 'lb' }, package: null });
    expect(ops['CHICKPEAS 15 OZ CAN']?.payload).toMatchObject({ quantity: { amount: 4 }, package: { size: 15, unit: 'oz' }, location: 'pantry' });
    expect(r.uncertainties.join(' ')).toContain('Returns are listed but not applied');
  });

  it('replays the same idempotency key without recording twice', async () => {
    const { principal } = await seedUser(db);
    const deps = testDeps();
    const a = await submit(deps, principal);
    const b = await submit(deps, principal);
    expect(b).toEqual(a);
    expect(await db.select().from(observations)).toHaveLength(1);
  });

  it('detects a recaptured receipt as a duplicate', async () => {
    const { principal } = await seedUser(db);
    const deps = testDeps();
    const a = await submit(deps, principal);
    const recapture = { ...fixtureReceipt('warehouse'), purchased_at: '2026-09-28T18:43', store: 'Pantry Club' };
    const b = await submit(deps, principal, recapture, 'rcpt-00002');
    expect(b).toMatchObject({ duplicate_of: a.observation_id, proposal_id: a.proposal_id, review_url: a.review_url });
    expect(await db.select().from(observations)).toHaveLength(1);
  });

  it('flags a possible duplicate when the receipt number was not transcribed', async () => {
    const { principal } = await seedUser(db);
    const deps = testDeps();
    const a = await submit(deps, principal);
    const { receipt_number: _omit, ...noNumber } = fixtureReceipt('warehouse');
    const b = await submit(deps, principal, noNumber, 'rcpt-00003');
    expect(b.duplicate_of).toBeNull();
    expect(b.possible_duplicate_of).toBe(a.observation_id);
    expect(b.uncertainties.join(' ')).toContain('already recorded');
  });

  it('still builds a proposal when reasoning throws', async () => {
    const { principal } = await seedUser(db);
    const r = await submit(testDeps({ reasoning: createFakeReasoning({ fail: true }) }), principal);
    expect(r.reasoning.fallback_used).toBe(true);
    expect(r.counts.items).toBe(6);
    const ops = Object.values(await opsFor(r.proposal_id));
    expect(ops.every((o) => o.confidence === 'low')).toBe(true);
    const calls = await db.select().from(reasoningCalls);
    expect(calls.some((c) => c.error?.includes('network down'))).toBe(true);
  });

  it('matches learned aliases without asking the model', async () => {
    const { principal } = await seedUser(db);
    const milk = await db.transaction(async (tx) => {
      const cs = await openChangeSet(tx, principal, { label: 'seed' });
      const { food } = await createOrReuseFood(tx, cs, { name: 'Whole milk', perishability: 'perishable', defaultLocation: 'fridge' });
      return addAlias(tx, cs, food, 'WHOLE MILK 1 GAL');
    });
    const fake = createFakeReasoning();
    const r = await submit(testDeps({ reasoning: fake }), principal);
    expect(fake.calls.canonicalize[0]?.lines.map((l) => l.raw_text)).not.toContain('WHOLE MILK 1 GAL');
    const ops = await opsFor(r.proposal_id);
    expect(ops['WHOLE MILK 1 GAL']).toMatchObject({ targetFoodId: milk.id, confidence: 'high' });
    expect(r.counts).toMatchObject({ matched: 1, new_foods: 5 });
  });

  it('records reasoning calls and links them from ops', async () => {
    const { principal } = await seedUser(db);
    const r = await submit(testDeps(), principal);
    const ops = Object.values(await opsFor(r.proposal_id));
    const ids = new Set((await db.select().from(reasoningCalls)).map((c) => c.id));
    expect(ops.every((o) => o.reasoningCallId && ids.has(o.reasoningCallId))).toBe(true);
  });

  it('flags a cropped second photo (no receipt number, no total) by line overlap', async () => {
    const { principal } = await seedUser(db);
    const deps = testDeps();
    const a = await submit(deps, principal);
    const { receipt_number: _n, total_cents: _t, ...cropped } = fixtureReceipt('warehouse');
    const b = await submit(deps, principal, cropped, 'rcpt-crop-1');
    expect(b.duplicate_of).toBeNull();
    expect(b.possible_duplicate_of).toBe(a.observation_id);
  });

  it('records two different same-day trips without time or total as separate receipts', async () => {
    const { principal } = await seedUser(db);
    const deps = testDeps();
    const trip = (raw: string) => ({ store: 'CORNER PANTRY', purchased_at: '2026-09-29', lines: [{ raw_text: raw }] });
    const milk = await submit(deps, principal, trip('MILK'), 'rcpt-trip-1');
    const bread = await submit(deps, principal, trip('BREAD'), 'rcpt-trip-2');
    expect(bread.duplicate_of).toBeNull();
    expect(bread.observation_id).not.toBe(milk.observation_id);
    expect(await db.select().from(observations)).toHaveLength(2);
  });

  it('never proposes lots for untagged negative-price or non-food lines, even when reasoning throws', async () => {
    const { principal } = await seedUser(db);
    const payload = {
      store: 'PANTRY CLUB',
      purchased_at: '2026-09-28T18:42',
      lines: [
        { raw_text: 'TPD/GRK YOGURT', price_cents: -300 },
        { raw_text: 'KS PAPER TOWEL 12 RL', price_cents: 1999 },
        { raw_text: 'BANANAS', quantity: 1.25, unit: 'lb', price_cents: 80 },
      ],
    };
    for (const [deps, key] of [[testDeps({ reasoning: createFakeReasoning({ fail: true }) }), 'rcpt-untagged-1'], [testDeps(), 'rcpt-untagged-2']] as const) {
      await resetDb();
      const { principal: p } = await seedUser(db);
      const r = await submit(deps, p, payload, key);
      const ops = await opsFor(r.proposal_id);
      expect(ops['TPD/GRK YOGURT']?.op).toBe('ignore_line');
      expect(ops['BANANAS']?.op).toBe('add_lot');
      if (key === 'rcpt-untagged-1') expect(ops['KS PAPER TOWEL 12 RL']?.op).toBe('ignore_line');
    }
    void principal;
  });
});
