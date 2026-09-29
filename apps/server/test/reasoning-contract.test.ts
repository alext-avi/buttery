import { beforeEach, describe, expect, it } from 'vitest';
import { createReasoning } from '../src/reasoning/provider';
import { submitReceipt } from '../src/services/receipts';
import { getProposalView } from '../src/services/proposals';
import { resetDb, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';
import { fixtureReceipt } from './fixtures/receipts';

describe('@buttery/reasoning integration (fallback provider, no network)', () => {
  beforeEach(async () => {
    await resetDb();
    process.env.REASONING_PROVIDER = 'fallback';
  });

  it('produces a schema-valid proposal with default-rule shelf life', async () => {
    const db = testDb();
    const { principal } = await seedUser(db);
    const deps = testDeps({ reasoning: createReasoning(db) });
    const r = await submitReceipt(deps, principal, { kind: 'receipt', payload: fixtureReceipt('warehouse'), idempotency_key: 'contract-1' });
    expect(r.counts.items).toBe(6);
    const view = await getProposalView(deps, principal, r.proposal_id);
    const chicken = view.ops.find((o) => o.line.raw_text === 'CHKN BREAST 3 LB')!;
    expect(chicken.draft?.expires_preview).toMatchObject({ kind: 'estimated' });
    expect(chicken.draft?.expires_preview?.basis).toContain('default_rule');
  });
});
