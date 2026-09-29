import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPat } from '../src/identity/tokens';
import { resetDb, testDb } from './helpers/db';
import { callTool, mcpClient, seedUser, startServer, testDeps } from './helpers/app';
import { fixtureReceipt } from './fixtures/receipts';

describe('MCP receipt flow', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    await resetDb();
    server = await startServer(testDeps());
  });
  afterEach(() => server.close());

  it('lists the Phase 1 tools', async () => {
    const { token } = await seedUser(testDb());
    const client = await mcpClient(server.url, token);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_household_summary', 'get_item', 'get_login_code', 'resolve_proposal', 'search_inventory', 'submit_observation', 'undo', 'upsert_food', 'whoami']);
    expect(client.getInstructions()).toContain('get_household_summary');
    await client.close();
  });

  it('receipt → review → apply → recover from a fresh connection → undo', async () => {
    const db = testDb();
    const { token, principal } = await seedUser(db, 'alex@example.com', 'Claude iOS');
    const phone = await mcpClient(server.url, token);

    const sub = await callTool(phone, 'submit_observation', { kind: 'receipt', payload: fixtureReceipt('warehouse'), idempotency_key: 'mcp-rcpt-1' });
    expect(sub.review_url).toMatch(/^https:\/\/buttery\.test\/review\//);
    const applied = await callTool(phone, 'resolve_proposal', { proposal_id: sub.proposal_id, accept_remaining: true, apply: true, idempotency_key: 'mcp-apply-1' });
    expect(applied.created_lot_ids).toHaveLength(6);
    await phone.close();

    // A different client (e.g. Codex) with no conversation history recovers state from the summary alone.
    const codexToken = (await createPat(db, { userId: principal.userId, householdId: principal.householdId, clientName: 'Codex' })).token;
    const codex = await mcpClient(server.url, codexToken);
    const summary = await callTool(codex, 'get_household_summary');
    expect(summary.counts.active_items).toBe(6);
    expect(summary.recent_changes[0]).toMatchObject({ via: 'Claude iOS', label: expect.stringContaining('PANTRY CLUB') });
    const expiring = await callTool(codex, 'search_inventory', { expiring_within_days: 14 });
    expect(expiring.items.map((i: { food: { name: string } }) => i.food.name)).toContain('Chicken breast');
    const item = await callTool(codex, 'get_item', { lot_id: expiring.items[0].lot_id });
    expect(item.evidence[0].kind).toBe('receipt');

    const undone = await callTool(codex, 'undo', { change_set_id: applied.applied_change_set_id, idempotency_key: 'mcp-undo-1' });
    expect(undone.lots_voided).toBe(6);
    expect((await callTool(codex, 'get_household_summary')).counts.active_items).toBe(0);
    await codex.close();
  });

  it('returns structured errors', async () => {
    const db = testDb();
    const a = await seedUser(db, 'a@example.com');
    const b = await seedUser(db, 'b@example.com');
    const ca = await mcpClient(server.url, a.token);
    const sub = await callTool(ca, 'submit_observation', { kind: 'receipt', payload: fixtureReceipt('mixed'), idempotency_key: 'mcp-rcpt-2' });
    const cb = await mcpClient(server.url, b.token);
    await expect(callTool(cb, 'resolve_proposal', { proposal_id: sub.proposal_id, accept_remaining: true, idempotency_key: 'mcp-apply-2' })).rejects.toThrow(/not_found/);
    await expect(callTool(ca, 'submit_observation', { kind: 'receipt', payload: { store: 'x', purchased_at: 'bad', lines: [] }, idempotency_key: 'mcp-rcpt-3' })).rejects.toThrow();
    await ca.close();
    await cb.close();
  });
});
