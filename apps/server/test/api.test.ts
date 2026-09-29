/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app';
import { submitReceipt } from '../src/services/receipts';
import { resetDb, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';
import { fixtureReceipt } from './fixtures/receipts';

async function login(app: ReturnType<typeof createApp>, token: string) {
  const res = await app.request('/auth/token-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, next: '/review/x' }) });
  expect(res.status).toBe(200);
  expect((await res.json() as any)).toEqual({ ok: true, next: '/review/x' });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

describe('web API', () => {
  beforeEach(() => resetDb());
  const db = testDb();

  it('requires a session', async () => {
    const res = await createApp(testDeps()).request('/api/me');
    expect(res.status).toBe(401);
  });

  it('rejects a bad token and unsafe redirects', async () => {
    const app = createApp(testDeps());
    const bad = await app.request('/auth/token-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'btr_nope' }) });
    expect(bad.status).toBe(401);
    const { token } = await seedUser(db);
    const ok = await app.request('/auth/token-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, next: '//evil.example' }) });
    expect(((await ok.json() as any)).next).toBe('/inventory');
  });

  it('reviews and applies a receipt through the API', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const { token, principal } = await seedUser(db);
    const cookie = await login(app, token);
    const r = await submitReceipt(deps, principal, { kind: 'receipt', payload: fixtureReceipt('warehouse'), idempotency_key: 'api-rcpt-1' });

    const view = (await (await app.request(`/api/proposals/${r.proposal_id}`, { headers: { cookie } })).json() as any);
    expect(view.ops).toHaveLength(6);

    const nonJson = await app.request(`/api/proposals/${r.proposal_id}/resolve`, { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{}' });
    expect(nonJson.status).toBe(415);

    const res = await app.request(`/api/proposals/${r.proposal_id}/resolve`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ decisions: [], accept_remaining: true, apply: true, idempotency_key: 'api-apply-1' }),
    });
    const applied = (await res.json() as any);
    expect(applied.created_lot_ids).toHaveLength(6);

    const inv = (await (await app.request('/api/inventory', { headers: { cookie } })).json() as any);
    expect(inv.by_location.fridge).toHaveLength(6);
    const item = (await (await app.request(`/api/items/${applied.created_lot_ids[0]}`, { headers: { cookie } })).json() as any);
    expect(item.history[0].op).toBe('add_lot');

    const undo = await app.request(`/api/change-sets/${applied.applied_change_set_id}/undo`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ idempotency_key: 'api-undo-1' }),
    });
    expect(((await undo.json() as any)).lots_voided).toBe(6);
  });

  it('attributes web actions to a Web connection', async () => {
    const app = createApp(testDeps());
    const { token } = await seedUser(db, 'alex@example.com', 'Claude Code');
    const cookie = await login(app, token);
    const me = (await (await app.request('/api/me', { headers: { cookie } })).json() as any);
    expect(me.connection.client_name).toBe('Web');
  });
});
