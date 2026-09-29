import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { lots } from '../src/db/schema';
import { undoChangeSet } from '../src/services/changes';
import { getHouseholdSummary, getInventoryPage, getItem, searchInventory, SearchInventoryInputSchema } from '../src/services/inventory';
import { getProposalView, resolveProposal } from '../src/services/proposals';
import { submitReceipt } from '../src/services/receipts';
import { resetDb, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';
import { fixtureReceipt } from './fixtures/receipts';

const db = testDb();
const NOW = new Date('2026-09-29T15:00:00Z'); // Tue 2026-09-29 in New York

async function seedInventory() {
  const { principal } = await seedUser(db);
  const deps = testDeps();
  const r = await submitReceipt(deps, principal, { kind: 'receipt', payload: fixtureReceipt('warehouse'), idempotency_key: 'rcpt-inv-1' });
  const view = await getProposalView(deps, principal, r.proposal_id, NOW);
  const op = (raw: string) => view.ops.find((o) => o.line.raw_text === raw)!.op_id;
  const applied = await resolveProposal(
    deps,
    principal,
    {
      proposal_id: r.proposal_id,
      decisions: [
        { op_id: op('EGGS 24 CT'), action: 'edit', edits: { expires_on: '2026-09-30' } },
        { op_id: op('STRAWBERRIES 2 LB'), action: 'edit', edits: { expires_on: '2026-09-27' } },
      ],
      accept_remaining: true,
      apply: true,
      idempotency_key: 'apply-inv-1',
    },
    NOW,
  );
  return { principal, deps, applied };
}

describe('inventory reads', () => {
  beforeEach(() => resetDb());

  it('summarizes what is on hand, what to use soon and what changed', async () => {
    const { principal, deps } = await seedInventory();
    const s = await getHouseholdSummary(deps, principal, NOW);
    expect(s.today).toBe('2026-09-29');
    expect(s.counts).toMatchObject({ active_items: 6, by_location: { fridge: 6 } });
    expect(s.use_soon.expired.map((l) => l.name)).toEqual(['Strawberries']);
    expect(s.use_soon.urgent.map((l) => l.name)).toEqual(['Eggs']);
    expect(s.use_soon.soon).toHaveLength(4);
    expect(s.use_soon.urgent[0]).toMatchObject({ expiry_text: 'exp tomorrow', quantity_text: '24 count' });
    expect(s.attention).toMatchObject({ pending_reviews: 0, expired: 1, stale: 0 });
    expect(s.recent_changes[0]).toMatchObject({ label: 'Receipt: PANTRY CLUB 2026-09-28', via: 'Test Client', undone: false });
    expect(s.links.inventory).toBe('https://buttery.test/inventory');
    expect(JSON.stringify(s).length).toBeLessThan(8000);
  });

  it('lists pending reviews with links', async () => {
    const { principal } = await seedUser(db);
    const deps = testDeps();
    const r = await submitReceipt(deps, principal, { kind: 'receipt', payload: fixtureReceipt('mixed'), idempotency_key: 'rcpt-inv-2' });
    const s = await getHouseholdSummary(deps, principal, NOW);
    expect(s.pending_reviews[0]).toMatchObject({ proposal_id: r.proposal_id, review_url: r.review_url, open_lines: 7 });
    expect(s.attention.pending_reviews).toBe(1);
  });

  it('flags stale perishables', async () => {
    const { principal, deps, applied } = await seedInventory();
    await db.update(lots).set({ lastEvidenceAt: new Date('2026-09-15T00:00:00Z') }).where(eq(lots.id, applied.created_lot_ids[0]!));
    expect((await getHouseholdSummary(deps, principal, NOW)).attention.stale).toBe(1);
  });

  it('searches by name, expiry window and location', async () => {
    const { principal, deps } = await seedInventory();
    const q = (x: Record<string, unknown>) => searchInventory(deps, principal, SearchInventoryInputSchema.parse(x), NOW);
    expect((await q({ query: 'spinach' })).items.map((i) => i.food.name)).toEqual(['Baby spinach']);
    expect((await q({ expiring_within_days: 1 })).items.map((i) => i.food.name)).toEqual(['Strawberries', 'Eggs']);
    expect((await q({ location: 'pantry' })).items).toHaveLength(0);
  });

  it('explains an item: evidence, estimate basis and history', async () => {
    const { principal, deps } = await seedInventory();
    const chicken = (await searchInventory(deps, principal, SearchInventoryInputSchema.parse({ query: 'chicken' }), NOW)).items[0]!;
    const item = await getItem(deps, principal, chicken.lot_id, NOW);
    expect(item.lot.expires).toMatchObject({ kind: 'estimated', confidence: 'medium' });
    expect(item.lot.expires?.basis).toContain('fake-1');
    expect(item.evidence[0]).toMatchObject({ kind: 'receipt', summary: 'Receipt · PANTRY CLUB · 2026-09-28', line: 'CHKN BREAST 3 LB' });
    expect(item.history.map((h) => h.op)).toEqual(['add_lot']);
    expect(item.reasoning.some((c) => c.function === 'estimateShelfLife' && c.model === 'fake-1')).toBe(true);
  });

  it('groups the inventory page by urgency and location', async () => {
    const { principal, deps } = await seedInventory();
    const page = await getInventoryPage(deps, principal, {}, NOW);
    expect(page.use_soon.expired).toHaveLength(1);
    expect(Object.keys(page.by_location)).toEqual(['fridge']);
    expect(page.locations).toEqual(['fridge', 'freezer', 'pantry', 'counter']);
  });

  it('drops voided items after undo', async () => {
    const { principal, deps, applied } = await seedInventory();
    await undoChangeSet(db, principal, { change_set_id: applied.applied_change_set_id!, idempotency_key: 'undo-inv-1' });
    const s = await getHouseholdSummary(deps, principal, NOW);
    expect(s.counts.active_items).toBe(0);
    expect(s.recent_changes.map((c) => c.label)).toEqual(['Undo: Receipt: PANTRY CLUB 2026-09-28', 'Receipt: PANTRY CLUB 2026-09-28']);
    expect(s.recent_changes[1]?.undone).toBe(true);
  });
});
