/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../src/config';
import { connections, loginCodes } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { mintLoginCode } from '../src/identity/loginCodes';
import { revokePat } from '../src/identity/tokens';
import { resetDb, TEST_DB_URL, testDb } from './helpers/db';
import { callTool, mcpClient, seedUser, startServer, testDeps } from './helpers/app';

const env = { DATABASE_URL: TEST_DB_URL, SESSION_SECRET: 'test-secret-test-secret-test-secret-123', PUBLIC_BASE_URL: 'https://buttery.test', TRUST_PROXY: 'true' };
const config = loadConfig(env);
const newApp = () => createApp(testDeps({ config }));

const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? null;
const open = (app: ReturnType<typeof createApp>, path: string, opts: { cookie?: string; ip?: string } = {}) =>
  app.request(`http://localhost${path}`, { headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), 'x-forwarded-for': opts.ip ?? '10.0.0.1' } });
const codeLogin = (app: ReturnType<typeof createApp>, body: unknown, ip = '10.0.0.1') =>
  app.request('/auth/code-login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });
const me = (app: ReturnType<typeof createApp>, cookie: string) => app.request('/api/me', { headers: { cookie } });
const usesOf = async () => (await testDb().select().from(loginCodes))[0]!.uses;

describe('agent-minted login codes', () => {
  beforeEach(() => resetDb());

  it('mints an 8-character code tied to the connection, stored only as a keyed hash', async () => {
    const { principal } = await seedUser(testDb());
    const { code, expiresAt } = await mintLoginCode(testDb(), config, principal);
    expect(code).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    const [row] = await testDb().select().from(loginCodes);
    expect(row).toMatchObject({ householdId: principal.householdId, userId: principal.userId, connectionId: principal.connectionId, uses: 0, maxUses: 3 });
    expect(row!.codeHash).not.toContain(code.replace('-', ''));
    expect(row!.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs a fresh browser in from any page URL and strips the parameter', async () => {
    const app = newApp();
    const { principal } = await seedUser(testDb());
    const { code } = await mintLoginCode(testDb(), config, principal);
    const typed = code.replace('-', '').toLowerCase();
    const res = await open(app, `/review/abc?x=1&login=${typed}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/review/abc?x=1');
    const cookie = cookieOf(res)!;
    const who = (await (await me(app, cookie)).json()) as any;
    expect(who.household.id).toBe(principal.householdId);
    expect(who.connection.client_name).toBe('Web (link from Test Client)');
  });

  it('allows three uses, then sends the browser to /login with a reason', async () => {
    const app = newApp();
    const { principal } = await seedUser(testDb());
    const { code } = await mintLoginCode(testDb(), config, principal);
    for (let i = 0; i < 3; i++) expect((await open(app, `/inventory?login=${code}`)).headers.get('location')).toBe('/inventory');
    const fourth = await open(app, `/review/abc?login=${code}`);
    expect(fourth.status).toBe(302);
    expect(fourth.headers.get('location')).toBe('/login?reason=expired&next=%2Freview%2Fabc');
    expect(cookieOf(fourth)).toBeNull();
  });

  it('refuses an expired code', async () => {
    const app = newApp();
    const { principal } = await seedUser(testDb());
    const { code } = await mintLoginCode(testDb(), config, principal, new Date(Date.now() - 11 * 60_000));
    expect((await open(app, `/inventory?login=${code}`)).headers.get('location')).toBe('/login?reason=expired&next=%2Finventory');
    expect((await codeLogin(app, { code })).status).toBe(401);
  });

  it('spends no use when the browser is already signed in to that household', async () => {
    const app = newApp();
    const { principal } = await seedUser(testDb());
    const { code } = await mintLoginCode(testDb(), config, principal);
    const cookie = cookieOf(await open(app, `/inventory?login=${code}`))!;
    const again = await open(app, `/items/x?login=${code}`, { cookie });
    expect(again.headers.get('location')).toBe('/items/x');
    expect(await usesOf()).toBe(1);
  });

  it('strips a stale code without complaint when the browser already has a session', async () => {
    const app = newApp();
    const { principal } = await seedUser(testDb());
    const { code } = await mintLoginCode(testDb(), config, principal);
    const cookie = cookieOf(await open(app, `/inventory?login=${code}`))!;
    const res = await open(app, '/inventory?login=ZZZZ-ZZZZ', { cookie });
    expect(res.headers.get('location')).toBe('/inventory');
  });

  it('revoking the minting token kills its unused codes and the sessions they created', async () => {
    const app = newApp();
    const { principal } = await seedUser(testDb());
    const used = await mintLoginCode(testDb(), config, principal);
    const unused = await mintLoginCode(testDb(), config, principal);
    const cookie = cookieOf(await open(app, `/inventory?login=${used.code}`))!;
    expect((await me(app, cookie)).status).toBe(200);
    await revokePat(testDb(), principal, principal.connectionId);
    expect((await me(app, cookie)).status).toBe(401);
    expect((await open(app, `/inventory?login=${unused.code}`)).headers.get('location')).toMatch(/^\/login\?reason=expired/);
  });

  it('revoking a pasted token signs out the browsers it signed in (M7)', async () => {
    const app = newApp();
    const { principal, token } = await seedUser(testDb());
    const res = await app.request('/auth/token-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    const cookie = cookieOf(res)!;
    expect((await me(app, cookie)).status).toBe(200);
    await revokePat(testDb(), principal, principal.connectionId);
    expect((await me(app, cookie)).status).toBe(401);
  });

  it("a household A code only ever grants household A, even from a household B browser", async () => {
    const app = newApp();
    const a = await seedUser(testDb(), 'a@example.com', 'Claude A');
    const b = await seedUser(testDb(), 'b@example.com', 'Claude B');
    const bCookie = cookieOf(await open(app, `/inventory?login=${(await mintLoginCode(testDb(), config, b.principal)).code}`))!;
    const aCode = await mintLoginCode(testDb(), config, a.principal);
    const switched = await open(app, `/inventory?login=${aCode.code}`, { cookie: bCookie });
    const who = (await (await me(app, cookieOf(switched)!)).json()) as any;
    expect(who.household.id).toBe(a.principal.householdId);
    expect(who.household.id).not.toBe(b.principal.householdId);
  });

  it('never redirects off-site', async () => {
    const app = newApp();
    const { principal } = await seedUser(testDb());
    const { code } = await mintLoginCode(testDb(), config, principal);
    for (const path of ['//evil.example/x', '/%5C%5Cevil.example', '/%09/evil.example', '/\\evil.example']) {
      const location = (await open(app, `${path}?login=${code}`)).headers.get('location') ?? '';
      expect(location.startsWith('/')).toBe(true);
      expect(location).not.toMatch(/^\/\/|^\/\\|^\/\t/);
    }
    const fresh = await mintLoginCode(testDb(), config, principal);
    const body = (await (await codeLogin(app, { code: fresh.code, next: '//evil.example' })).json()) as any;
    expect(body.next).toBe('/inventory');
  });

  it('signs in with a typed code on /auth/code-login', async () => {
    const app = newApp();
    const { principal } = await seedUser(testDb());
    const { code } = await mintLoginCode(testDb(), config, principal);
    const res = await codeLogin(app, { code: ` ${code.toLowerCase()} `, next: '/review/abc' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, next: '/review/abc' });
    expect((await me(app, cookieOf(res)!)).status).toBe(200);
    const bad = await codeLogin(app, { code: 'ABCD-EFGH' });
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as any).error).toBe('invalid_code');
  });

  it('rate-limits failed attempts per client IP; successes do not count', async () => {
    const app = newApp();
    const { principal } = await seedUser(testDb());
    const { code } = await mintLoginCode(testDb(), config, principal);
    for (let i = 0; i < 9; i++) expect((await codeLogin(app, { code: 'ABCD-EFGH' }, '1.2.3.4')).status).toBe(401);
    expect((await codeLogin(app, { code }, '1.2.3.4')).status).toBe(200);
    expect((await open(app, '/inventory?login=ABCD-EFGH', { ip: '1.2.3.4' })).headers.get('location')).toMatch(/^\/login\?reason=expired/);
    expect((await codeLogin(app, { code: 'ABCD-EFGH' }, '1.2.3.4')).status).toBe(429);
    expect((await open(app, `/inventory?login=${code}`, { ip: '1.2.3.4' })).headers.get('location')).toMatch(/^\/login\?reason=rate_limited/);
    expect((await codeLogin(app, { code }, '5.6.7.8')).status).toBe(200);
  });

  it('ignores the parameter on API, auth, MCP and health paths', async () => {
    const app = newApp();
    const { principal } = await seedUser(testDb());
    const { code } = await mintLoginCode(testDb(), config, principal);
    expect((await open(app, `/api/me?login=${code}`)).status).toBe(401);
    expect((await open(app, `/healthz?login=${code}`)).status).toBe(200);
    expect(await usesOf()).toBe(0);
  });
});

describe('get_login_code over MCP', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer(testDeps({ config }));
  });
  afterAll(() => server.close());
  beforeEach(() => resetDb());

  it('returns a code and how to use it', async () => {
    const { token, principal } = await seedUser(testDb());
    const client = await mcpClient(server.url, token);
    const r = await callTool(client, 'get_login_code');
    expect(r.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(r).toMatchObject({ uses_left: 3, append: `login=${r.code}`, login_url: 'https://buttery.test/login', example: `https://buttery.test/inventory?login=${r.code}` });
    expect(r.how_to_use).toContain('Append');
    const [row] = await testDb().select().from(loginCodes).where(eq(loginCodes.connectionId, principal.connectionId));
    expect(row).toBeDefined();
    const who = await callTool(client, 'whoami');
    expect(JSON.stringify(who)).toContain('get_login_code');
    await client.close();
  });

  it('is only reachable with a valid bearer token', async () => {
    const res = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(await testDb().select().from(connections)).toHaveLength(0);
  });
});
