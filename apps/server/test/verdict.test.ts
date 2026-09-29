/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeProvider } from '@buttery/reasoning';
import type { ReasoningPort } from '../src/reasoning/port';
import { getHouseholdSummary } from '../src/services/inventory';
import { getProposalView, resolveProposal } from '../src/services/proposals';
import { submitReceipt } from '../src/services/receipts';
import { resetDb, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';
import { createFakeReasoning } from './helpers/fakeReasoning';
import { fixtureReceipt } from './fixtures/receipts';

const db = testDb();
const allHigh = createFakeProvider({
  canonicalizeItems: (input: any) => ({
    lines: input.lines.map((l: any) => ({
      line_id: l.line_id, canonical_name: l.raw_text.toLowerCase().replace(/\s+\d.*$/, ''), category: 'dairy', perishability: 'perishable',
      line_kind: 'item', match: { food_id: 'new', confidence: 'high' }, rationale: 'clear product name',
    })),
  }),
  estimateShelfLife: () => ({ per_state: { sealed: { days: 7, confidence: 'high' }, opened: { days: 5, confidence: 'high' }, frozen: { days: 90, confidence: 'medium' } }, rationale: 'test' }),
}) as unknown as ReasoningPort;
const clean = { store: 'PANTRY CLUB', purchased_at: '2026-09-28T18:42', receipt_number: 'PC-9', total_cents: 1248, lines: [{ raw_text: 'WHOLE MILK 1 GAL', price_cents: 599 }, { raw_text: 'EGGS 24 CT', price_cents: 649 }] };

describe('receipt verdict', () => {
  beforeEach(() => resetDb());

  it('says safe_to_apply when every line is high confidence, and tells the agent to ask for a yes in chat', async () => {
    const { principal } = await seedUser(db);
    const r = await submitReceipt(testDeps({ reasoning: allHigh }), principal, { kind: 'receipt', payload: clean, idempotency_key: 'verdict-0001' });
    expect(r.verdict).toMatchObject({ verdict: 'safe_to_apply', reasons: ['All 2 items matched with high confidence'] });
    expect(r.lines_to_check).toEqual([]);
    expect(r.next.join(' ')).toMatch(/resolve_proposal.*accept_remaining/);
  });

  it('says quick_check and lists the lines worth a glance', async () => {
    const { principal } = await seedUser(db);
    const r = await submitReceipt(testDeps(), principal, { kind: 'receipt', payload: fixtureReceipt('warehouse'), idempotency_key: 'verdict-0002' });
    expect(r.verdict?.verdict).toBe('quick_check'); // the port fake marks new foods medium
    expect(r.lines_to_check[0]).toMatchObject({ raw_text: 'WHOLE MILK 1 GAL', food_name: 'Whole milk', confidence: 'medium' });
  });

  it('says needs_review when the model was unavailable or the receipt has a return', async () => {
    const { principal } = await seedUser(db);
    const down = await submitReceipt(testDeps({ reasoning: createFakeReasoning({ fail: true }) }), principal, { kind: 'receipt', payload: clean, idempotency_key: 'verdict-0003' });
    expect(down.verdict).toMatchObject({ verdict: 'needs_review' });
    expect(down.verdict?.reasons).toContain('Matched without the reasoning model');
    const mixed = await submitReceipt(testDeps(), principal, { kind: 'receipt', payload: fixtureReceipt('mixed'), idempotency_key: 'verdict-0004' });
    expect(mixed.verdict?.reasons).toContain("Includes a return, which isn't applied automatically");
  });

  it('shows the verdict on the review page and in the summary, over the lines still open', async () => {
    const { principal } = await seedUser(db);
    const deps = testDeps({ reasoning: allHigh });
    const r = await submitReceipt(deps, principal, { kind: 'receipt', payload: clean, idempotency_key: 'verdict-0005' });
    const view = await getProposalView(deps, principal, r.proposal_id);
    expect(view.verdict?.verdict).toBe('safe_to_apply');
    const summary = await getHouseholdSummary(deps, principal);
    expect(summary.pending_reviews[0]).toMatchObject({ verdict: 'safe_to_apply' });
    const applied = await resolveProposal(deps, principal, { proposal_id: r.proposal_id, accept_remaining: true, apply: true, idempotency_key: 'verdict-0006' });
    expect(applied.verdict).toBeNull(); // nothing left to review
  });

  it('persists the fallback flag so the verdict holds on later views', async () => {
    const { principal } = await seedUser(db);
    const deps = testDeps({ reasoning: createFakeReasoning({ fail: true }) });
    const r = await submitReceipt(deps, principal, { kind: 'receipt', payload: clean, idempotency_key: 'verdict-0007' });
    const view = await getProposalView(testDeps(), principal, r.proposal_id);
    expect(view.verdict?.verdict).toBe('needs_review');
  });
});
