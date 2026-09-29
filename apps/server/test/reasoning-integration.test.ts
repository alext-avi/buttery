/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createFakeProvider, ReasoningInputError } from '@buttery/reasoning';
import { proposalOps, reasoningCalls } from '../src/db/schema';
import { addAlias, createOrReuseFood, openChangeSet } from '../src/services/changes';
import type { LotDraft } from '../src/services/drafts';
import { submitReceipt } from '../src/services/receipts';
import type { ReasoningPort } from '../src/reasoning/port';
import { resetDb, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';

const db = testDb();
const receipt = { store: 'PANTRY CLUB', purchased_at: '2026-09-28T18:42', receipt_number: 'PC-1', lines: [{ raw_text: 'EGGS 24 CT', price_cents: 649 }] };

describe('@buttery/reasoning through the server (fake provider, no credits)', () => {
  beforeEach(() => resetDb());

  it('coerces an invented food id to a new food and keeps the violation on the call record', async () => {
    const { principal } = await seedUser(db);
    await db.transaction(async (tx) => {
      const cs = await openChangeSet(tx, principal, { label: 'seed' });
      await createOrReuseFood(tx, cs, { name: 'egg whites', perishability: 'perishable' });
    });
    const provider = createFakeProvider({
      canonicalizeItems: (input: any) => ({
        lines: input.lines.map((l: any) => ({
          line_id: l.line_id, canonical_name: 'eggs', category: 'eggs', perishability: 'perishable',
          package: { size: 24, unit: 'ct' }, line_kind: 'item', match: { food_id: 'not-a-candidate', confidence: 'high' }, rationale: 'test',
        })),
      }),
      estimateShelfLife: () => ({ per_state: { sealed: { days: 28, confidence: 'medium' }, opened: { days: 28, confidence: 'medium' }, frozen: { days: 300, confidence: 'low' } }, rationale: 'test' }),
    });
    const r = await submitReceipt(testDeps({ reasoning: provider as unknown as ReasoningPort }), principal, { kind: 'receipt', payload: receipt, idempotency_key: 'int-1' });
    const [op] = await db.select().from(proposalOps).where(eq(proposalOps.proposalId, r.proposal_id));
    const draft = op!.payload as unknown as LotDraft;
    expect(draft.food_id).toBeNull();
    expect(draft.new_food?.name).toBe('eggs');
    expect(draft.quantity).toMatchObject({ amount: 24, unit: 'count' });
    const calls = await db.select().from(reasoningCalls).where(eq(reasoningCalls.function, 'canonicalizeItems'));
    expect(calls[0]?.violations.length).toBeGreaterThan(0);
  });

  it('passes the storage location to shelf-life estimates', async () => {
    const { principal } = await seedUser(db);
    const seen: any[] = [];
    const provider = createFakeProvider({
      canonicalizeItems: (input: any) => ({ lines: input.lines.map((l: any) => ({ line_id: l.line_id, canonical_name: 'eggs', category: 'eggs', perishability: 'perishable', line_kind: 'item', match: { food_id: 'new', confidence: 'high' }, rationale: 'test' })) }),
      estimateShelfLife: (input: any) => {
        seen.push(input);
        return { per_state: { sealed: { days: 28, confidence: 'medium' }, opened: { days: 28, confidence: 'medium' }, frozen: { days: 300, confidence: 'low' } }, rationale: 'test' };
      },
    });
    await submitReceipt(testDeps({ reasoning: provider as unknown as ReasoningPort }), principal, { kind: 'receipt', payload: receipt, idempotency_key: 'int-2' });
    expect(JSON.stringify(seen)).toContain('fridge');
  });

  it('lets ReasoningInputError surface as a server bug instead of silently falling back', async () => {
    const { principal } = await seedUser(db);
    const broken: ReasoningPort = {
      canonicalizeItems: async () => { throw new ReasoningInputError('canonicalizeItems', []); },
      estimateShelfLife: async () => { throw new ReasoningInputError('canonicalizeItems', []); },
      parseActivity: async () => { throw new ReasoningInputError('parseActivity', []); },
    };
    await expect(submitReceipt(testDeps({ reasoning: broken }), principal, { kind: 'receipt', payload: receipt, idempotency_key: 'int-3' })).rejects.toBeInstanceOf(ReasoningInputError);
  });

  it('skips the model entirely for learned aliases', async () => {
    const { principal } = await seedUser(db);
    await db.transaction(async (tx) => {
      const cs = await openChangeSet(tx, principal, { label: 'seed' });
      const { food } = await createOrReuseFood(tx, cs, { name: 'eggs', perishability: 'perishable' });
      await addAlias(tx, cs, food, 'EGGS 24 CT');
    });
    const provider = createFakeProvider({}); // any model call would throw "no script"
    const r = await submitReceipt(testDeps({ reasoning: provider as unknown as ReasoningPort }), principal, { kind: 'receipt', payload: receipt, idempotency_key: 'int-4' });
    expect(r.reasoning).toMatchObject({ canonicalize: null, fallback_used: false });
  });
});
