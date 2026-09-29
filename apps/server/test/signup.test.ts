/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createAuthkit } from '../src/auth/authkit';
import { loadConfig } from '../src/config';
import { idempotencyRecords, users } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { provisionUser } from '../src/identity/provision';
import { resolvePat } from '../src/identity/tokens';
import { resetDb, TEST_DB_URL, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';

const base = { DATABASE_URL: TEST_DB_URL, SESSION_SECRET: 'x'.repeat(32), PUBLIC_BASE_URL: 'https://buttery.test', AUTHKIT_DOMAIN: 'https://auth.test', WORKOS_CLIENT_ID: 'client_test', WORKOS_API_KEY: 'sk_test_dummy' };
const newUser = async () => ({ id: 'user_new', email: 'new@example.com', firstName: 'Sam', lastName: null });

function appWith(mode: 'open' | 'closed') {
  const config = loadConfig({ ...base, SIGNUP_MODE: mode });
  const authkit = createAuthkit(config, testDb(), { fetchUser: async (id) => ({ ...(await newUser()), id }), exchangeCode: newUser })!;
  return createApp(testDeps({ config, authkit }));
}

async function cookieFor(app: ReturnType<typeof createApp>, token: string) {
  const res = await app.request('/auth/token-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}
const post = (app: ReturnType<typeof createApp>, path: string, cookie: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('self-serve sign-up', () => {
  beforeEach(() => resetDb());

  it('sends sign-up requests to the AuthKit sign-up screen', async () => {
    const res = await appWith('open').request('/auth/authkit?mode=sign-up&next=/inventory');
    expect(res.headers.get('location')).toContain('screen_hint=sign-up');
    expect(await (await appWith('open').request('/auth/config')).json()).toEqual({ authkit: true, signup: true });
  });

  it('creates a household on first sign-in and lands on onboarding', async () => {
    const res = await appWith('open').request('/auth/callback?code=abc&state=%2Finventory');
    expect(res.headers.get('location')).toBe('/settings?welcome=1');
    const [u] = await testDb().select().from(users).where(eq(users.authSubject, 'user_new'));
    expect(u?.email).toBe('new@example.com');
  });

  it('sends a returning user to their original page', async () => {
    await provisionUser(testDb(), { authSubject: 'user_new', email: 'new@example.com' });
    const res = await appWith('open').request('/auth/callback?code=abc&state=%2Freview%2Fx');
    expect(res.headers.get('location')).toBe('/review/x');
  });

  it('refuses new identities when sign-up is closed, but not existing ones', async () => {
    const closed = appWith('closed');
    expect((await closed.request('/auth/callback?code=abc')).status).toBe(403);
    expect((await (await closed.request('/auth/config')).json() as any)).toEqual({ authkit: true, signup: false });
    await provisionUser(testDb(), { authSubject: 'user_new', email: 'new@example.com' });
    expect((await closed.request('/auth/callback?code=abc')).status).toBe(302);
  });

  it('lets a signed-in user create, list and revoke access tokens', async () => {
    const app = createApp(testDeps());
    const { token } = await seedUser(testDb());
    const cookie = await cookieFor(app, token);
    const created = await post(app, '/api/tokens', cookie, { client_name: 'Codex' });
    expect(created.status).toBe(201);
    const body = (await created.json() as any);
    expect(body).toMatchObject({ client_name: 'Codex', mcp_url: 'https://buttery.test/mcp' });
    expect(body.token).toMatch(/^btr_/);
    expect(await resolvePat(testDb(), body.token)).not.toBeNull();

    const list = (await (await app.request('/api/tokens', { headers: { cookie } })).json() as any);
    expect(list.tokens.map((t: { client_name: string }) => t.client_name)).toContain('Codex');
    expect(JSON.stringify(list)).not.toContain(body.token);
    expect(JSON.stringify(await testDb().select().from(idempotencyRecords))).not.toContain(body.token);

    expect((await post(app, `/api/tokens/${body.connection_id}/revoke`, cookie, {})).status).toBe(200);
    expect(await resolvePat(testDb(), body.token)).toBeNull();
  });

  it('cannot revoke another user\'s token', async () => {
    const app = createApp(testDeps());
    const a = await seedUser(testDb(), 'a@example.com');
    const b = await seedUser(testDb(), 'b@example.com');
    const cookie = await cookieFor(app, b.token);
    expect((await post(app, `/api/tokens/${a.principal.connectionId}/revoke`, cookie, {})).status).toBe(404);
    expect(await resolvePat(testDb(), a.token)).not.toBeNull();
  });

  it('updates the household name and timezone, rejecting unknown timezones', async () => {
    const app = createApp(testDeps());
    const { token } = await seedUser(testDb());
    const cookie = await cookieFor(app, token);
    const ok = (await (await post(app, '/api/household', cookie, { name: 'The Thomases', timezone: 'America/Chicago' })).json() as any);
    expect(ok.household).toMatchObject({ name: 'The Thomases', timezone: 'America/Chicago' });
    expect((await post(app, '/api/household', cookie, { timezone: 'Mars/Olympus' })).status).toBe(422);
  });

  it('keeps allowCreate optional for the CLI', async () => {
    const r = await provisionUser(testDb(), { email: 'cli@example.com' });
    expect(r.created).toBe(true);
    await expect(provisionUser(testDb(), { email: 'x@example.com' }, { allowCreate: false })).rejects.toMatchObject({ code: 'signup_closed' });
    expect(await testDb().select().from(users).where(and(eq(users.email, 'x@example.com')))).toHaveLength(0);
  });
});
