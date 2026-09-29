import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { foods, lots, observations } from '../src/db/schema';
import { createOrReuseFood, openChangeSet, undoChangeSet } from '../src/services/changes';
import { getProposalView, resolveProposal } from '../src/services/proposals';
import { submitReceipt } from '../src/services/receipts';
import { resetDb, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';
import { createFakeReasoning } from './helpers/fakeReasoning';
import { fixtureReceipt } from './fixtures/receipts';

const db = testDb();
const NOW = new Date('2026-09-29T15:00:00Z');

async function setup(receipt: 'warehouse' | 'mixed' = 'warehouse') {
  const { principal } = await seedUser(db);
  const fake = createFakeReasoning();
  const deps = testDeps({ reasoning: fake });
  const r = await submitReceipt(deps, principal, { kind: 'receipt', payload: fixtureReceipt(receipt), idempotency_key: `rcpt-${receipt}-1` });
  const view = await getProposalView(deps, principal, r.proposal_id, NOW);
  const op = (raw: string) => view.ops.find((o) => o.line.raw_text === raw)!;
  return { principal, deps, fake, r, view, op };
}
const activeLots = () => db.select().from(lots).where(eq(lots.status, 'active'));

describe('resolveProposal', () => {
  beforeEach(() => resetDb());

  it('shows the review with estimated expiry text', async () => {
    const { view, op } = await setup();
    expect(view.observation).toMatchObject({ store: 'PANTRY CLUB', via: 'Test Client', recorded_by: 'Alex' });
    expect(op('CHKN BREAST 3 LB').draft).toMatchObject({ food_name: 'Chicken breast', is_new_food: true, quantity_text: '1 × 3 lb', expiry_text: 'est. Sat · medium' });
  });

  it('accepts everything and applies it as one change set', async () => {
    const { principal, deps, r } = await setup();
    const out = await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0001' }, NOW);
    expect(out.proposal.status).toBe('applied');
    expect(out.created_lot_ids).toHaveLength(6);
    expect(out.undo?.change_set_id).toBe(out.applied_change_set_id);
    const chicken = (await db.select().from(foods).where(eq(foods.normalizedName, 'chicken breast')))[0]!;
    expect(chicken.aliases).toContain('chkn breast 3 lb');
    const [lot] = await db.select().from(lots).where(eq(lots.foodId, chicken.id));
    expect(lot?.expires).toMatchObject({ on: '2026-10-03', kind: 'estimated', confidence: 'medium' });
    const [obs] = await db.select().from(observations).where(eq(observations.id, r.observation_id));
    expect(obs?.status).toBe('resolved');
  });

  it('applies edits and rejections', async () => {
    const { principal, deps, r, op } = await setup();
    const out = await resolveProposal(
      deps,
      principal,
      {
        proposal_id: r.proposal_id,
        decisions: [
          { op_id: op('GRK YOGURT 2X32 OZ').op_id, action: 'edit', edits: { quantity: { kind: 'approx', amount: 1, unit: 'count' }, location: 'freezer', expires_on: '2026-10-20' } },
          { op_id: op('STRAWBERRIES 2 LB').op_id, action: 'reject' },
        ],
        accept_remaining: true,
        apply: true,
        idempotency_key: 'apply-0002',
      },
      NOW,
    );
    expect(out.created_lot_ids).toHaveLength(5);
    const yogurt = out.ops.find((o) => o.line.raw_text === 'GRK YOGURT 2X32 OZ')!;
    expect(yogurt).toMatchObject({ decision: 'edited', applied: true, draft: { location: 'freezer', quantity_text: '~1 × 32 oz' } });
    const [lot] = await db.select().from(lots).where(eq(lots.location, 'freezer'));
    expect(lot?.expires).toMatchObject({ on: '2026-10-20', kind: 'printed' });
    expect(out.ops.find((o) => o.line.raw_text === 'STRAWBERRIES 2 LB')).toMatchObject({ decision: 'rejected', applied: false });
    expect(out.proposal.status).toBe('applied');
  });

  it('supports partial review', async () => {
    const { principal, deps, r, op } = await setup();
    const first = await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [{ op_id: op('EGGS 24 CT').op_id, action: 'accept' }], accept_remaining: false, apply: true, idempotency_key: 'apply-0003' }, NOW);
    expect(first.proposal.status).toBe('partial');
    expect(await activeLots()).toHaveLength(1);
    const second = await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0004' }, NOW);
    expect(second.proposal.status).toBe('applied');
    expect(await activeLots()).toHaveLength(6);
  });

  it('can switch a line to an existing food instead of creating one', async () => {
    const { principal, deps, r, op } = await setup();
    const milk = await db.transaction(async (tx) => {
      const cs = await openChangeSet(tx, principal, { label: 'seed' });
      return (await createOrReuseFood(tx, cs, { name: 'Milk', perishability: 'perishable' })).food;
    });
    await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [{ op_id: op('WHOLE MILK 1 GAL').op_id, action: 'edit', edits: { food_id: milk.id } }], accept_remaining: true, apply: true, idempotency_key: 'apply-0005' }, NOW);
    expect(await db.select().from(foods).where(eq(foods.normalizedName, 'whole milk'))).toHaveLength(0);
    expect((await db.select().from(lots).where(eq(lots.foodId, milk.id))).length).toBe(1);
  });

  it('never creates lots for ignored lines, even after accept-all', async () => {
    const { principal, deps, r } = await setup('mixed');
    const out = await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0006' }, NOW);
    expect(out.created_lot_ids).toHaveLength(4);
    expect(out.proposal.status).toBe('applied');
  });

  it('does not duplicate lots on a second apply with a new key', async () => {
    const { principal, deps, r } = await setup();
    await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0007' }, NOW);
    const again = await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0008' }, NOW);
    expect(again.applied_change_set_id).toBeNull();
    expect(again.notes).toContain('Nothing left to apply.');
    expect(await activeLots()).toHaveLength(6);
  });

  it('replays the same key', async () => {
    const { principal, deps, r } = await setup();
    const input = { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0009' };
    const a = await resolveProposal(deps, principal, input, NOW);
    const b = await resolveProposal(deps, principal, input, NOW);
    expect(b.applied_change_set_id).toBe(a.applied_change_set_id);
    expect(await activeLots()).toHaveLength(6);
  });

  it('undo reopens the proposal so it can be fixed and re-applied', async () => {
    const { principal, deps, r } = await setup();
    const applied = await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0010' }, NOW);
    const undo = await undoChangeSet(db, principal, { change_set_id: applied.applied_change_set_id!, idempotency_key: 'undo-0010' });
    expect(undo.proposal_reopened).toBe(r.proposal_id);
    expect(await activeLots()).toHaveLength(0);
    const view = await getProposalView(deps, principal, r.proposal_id, NOW);
    expect(view.proposal.status).toBe('pending');
    const reapplied = await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0011' }, NOW);
    expect(reapplied.created_lot_ids).toHaveLength(6);
    expect(await db.select().from(foods)).toHaveLength(6); // revived, not duplicated
  });

  it('matches the next receipt via learned aliases', async () => {
    const { principal, deps, fake, r } = await setup();
    await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0012' }, NOW);
    const next = await submitReceipt(deps, principal, { kind: 'receipt', payload: { ...fixtureReceipt('warehouse'), receipt_number: 'PC-009999', purchased_at: '2026-10-05T10:00' }, idempotency_key: 'rcpt-next-1' });
    expect(next.counts).toMatchObject({ matched: 6, new_foods: 0 });
    expect(fake.calls.canonicalize).toHaveLength(1); // second receipt needed no model call
    const view = await getProposalView(deps, principal, next.proposal_id, NOW);
    expect(view.ops.every((o) => o.confidence === 'high')).toBe(true);
  });

  it('hides proposals from other households', async () => {
    const { deps, r } = await setup();
    const other = await seedUser(db, 'other@example.com');
    await expect(getProposalView(deps, other.principal, r.proposal_id, NOW)).rejects.toMatchObject({ code: 'not_found' });
    await expect(resolveProposal(deps, other.principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0013' }, NOW)).rejects.toMatchObject({ code: 'not_found' });
    expect(await db.select().from(lots).where(and(eq(lots.householdId, other.principal.householdId)))).toHaveLength(0);
  });

  it('requires explicit confirmation before applying a possible duplicate', async () => {
    const { principal, deps } = await setup();
    const { receipt_number: _n, ...noNumber } = fixtureReceipt('warehouse');
    const dup = await submitReceipt(deps, principal, { kind: 'receipt', payload: noNumber, idempotency_key: 'rcpt-dup-1' });
    const view = await getProposalView(deps, principal, dup.proposal_id, NOW);
    expect(view.observation.possible_duplicate_of).toMatchObject({ observation_id: expect.any(String), review_url: expect.stringContaining('/review/') });
    expect(view.observation.uncertainties.join(' ')).toContain('already recorded');
    const input = { proposal_id: dup.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-dup-1' };
    await expect(resolveProposal(deps, principal, input, NOW)).rejects.toMatchObject({ code: 'possible_duplicate' });
    expect(await activeLots()).toHaveLength(0);
    const ok = await resolveProposal(deps, principal, { ...input, idempotency_key: 'apply-dup-2', confirm_possible_duplicate: true }, NOW);
    expect(ok.created_lot_ids).toHaveLength(6);
  });
});
