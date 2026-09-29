/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ipKey } from '../src/auth/rateLimit';
import { loadConfig } from '../src/config';
import { serializeSigned } from 'hono/utils/cookie';
import { connections, loginCodes } from '../src/db/schema';
import { createApp } from '../src/http/app';
import type { Principal } from '../src/identity/principal';
import { mintPageLink } from '../src/identity/loginCodes';
import { revokePat } from '../src/identity/tokens';
import { resolveProposal } from '../src/services/proposals';
import { submitReceipt } from '../src/services/receipts';
import { fixtureReceipt } from './fixtures/receipts';
import { resetDb, TEST_DB_URL, testDb } from './helpers/db';
import { callTool, mcpClient, seedUser, startServer, testDeps } from './helpers/app';

const config = loadConfig({ DATABASE_URL: TEST_DB_URL, SESSION_SECRET: 'test-secret-test-secret-test-secret-123', PUBLIC_BASE_URL: 'https://buttery.test', TRUST_PROXY: 'true' });
const deps = () => testDeps({ config });
type App = ReturnType<typeof createApp>;

const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? null;
const get = (app: App, path: string, cookie?: string, ip = '10.0.0.1') =>
  app.request(`http://localhost${path}`, { headers: { 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}) } });
const post = (app: App, path: string, body: unknown, cookie?: string, ip = '10.0.0.1') =>
  app.request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const pathOf = (url: string) => {
  const u = new URL(url, 'https://buttery.test');
  return `${u.pathname}${u.search}`;
};
/** Opening an agent's link: a plain page load with ?login=. */
const open = (app: App, url: string, cookie?: string, ip?: string) => get(app, pathOf(url), cookie, ip);
const signIn = async (app: App, token: string) => cookieOf(await post(app, '/auth/token-login', { token }))!;
const codeFrom = (url: string) => new URL(url).searchParams.get('login')!;

async function seedReceipt(p: Principal, which: 'warehouse' | 'mixed' = 'warehouse') {
  const r = await submitReceipt(deps(), p, { kind: 'receipt', payload: fixtureReceipt(which), idempotency_key: `seed-${which}` });
  return r.proposal_id as string;
}
async function applyReceipt(p: Principal, proposalId: string) {
  return resolveProposal(deps(), p, { proposal_id: proposalId, decisions: [], accept_remaining: true, apply: true, idempotency_key: `apply-${proposalId}` } as any);
}

describe('page links from agents', () => {
  beforeEach(() => resetDb());

  it('mints a code for one page, stored only as a keyed hash', async () => {
    const { principal } = await seedUser(testDb());
    const id = await seedReceipt(principal);
    const link = await mintPageLink(testDb(), config, principal, `https://buttery.test/review/${id}`);
    expect(link.url).toBe(`https://buttery.test/review/${id}?login=${link.code}`);
    expect(link.code).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/);
    const [row] = await testDb().select().from(loginCodes);
    expect(row).toMatchObject({ path: `/review/${id}`, scopeKind: 'proposal', scopeId: id, uses: 0, connectionId: principal.connectionId });
    expect(row!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.codeHash).not.toContain(link.code.replace('-', ''));
  });

  it('refuses pages that need a real sign-in, other hosts and other households', async () => {
    const a = await seedUser(testDb(), 'a@example.com');
    const b = await seedUser(testDb(), 'b@example.com');
    const bReceipt = await seedReceipt(b.principal);
    for (const url of ['https://buttery.test/settings', 'https://buttery.test/login', 'https://evil.example/inventory', '/api/me']) {
      await expect(mintPageLink(testDb(), config, a.principal, url)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(mintPageLink(testDb(), config, a.principal, `/review/${bReceipt}`)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('opening the link grants that page only, without signing in', async () => {
    const app = createApp(deps());
    const { principal } = await seedUser(testDb());
    const id = await seedReceipt(principal);
    const link = await mintPageLink(testDb(), config, principal, `/review/${id}`);

    const res = await open(app, link.url);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/review/${id}`);
    expect(res.headers.get('set-cookie')).not.toContain('btr_session');
    const pass = cookieOf(res)!;
    expect(pass.startsWith('btr_pass=')).toBe(true);

    expect((await get(app, `/api/proposals/${id}`, pass)).status).toBe(200);
    expect((await post(app, `/api/proposals/${id}/resolve`, { decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-via-pass' }, pass)).status).toBe(200);
    expect((await get(app, '/api/inventory', pass)).status).toBe(401);
    expect((await get(app, '/api/me', pass)).status).toBe(401);
    expect((await get(app, '/api/tokens', pass)).status).toBe(401);
  });

  it('keeps working for every browser until it expires', async () => {
    const app = createApp(deps());
    const { principal } = await seedUser(testDb());
    const link = await mintPageLink(testDb(), config, principal, '/inventory');
    for (let i = 0; i < 3; i++) {
      const res = await open(app, link.url);
      expect(res.headers.get('location')).toBe('/inventory');
      expect(cookieOf(res)).toMatch(/^btr_pass=/);
    }
    expect((await testDb().select().from(loginCodes))[0]!.uses).toBe(3);
  });

  it('only opens the page it was minted for', async () => {
    const app = createApp(deps());
    const { principal } = await seedUser(testDb());
    const id = await seedReceipt(principal);
    const code = codeFrom((await mintPageLink(testDb(), config, principal, `/review/${id}`)).url);
    expect((await get(app, `/inventory?login=${code}`)).headers.get('location')).toBe('/login?reason=link_expired&next=%2Finventory');
  });

  it('refuses a code that was not opened in time', async () => {
    const app = createApp(deps());
    const { principal } = await seedUser(testDb());
    const link = await mintPageLink(testDb(), config, principal, '/inventory', new Date(Date.now() - 11 * 60_000));
    const res = await open(app, link.url);
    expect(res.headers.get('location')).toBe('/login?reason=link_expired&next=%2Finventory');
    expect(cookieOf(res)).toBeNull();
  });

  it('just cleans the URL when the browser can already see the page', async () => {
    const app = createApp(deps());
    const { principal, token } = await seedUser(testDb());
    const id = await seedReceipt(principal);
    const code = codeFrom((await mintPageLink(testDb(), config, principal, `/review/${id}`)).url);
    const session = await signIn(app, token);
    expect((await get(app, `/review/${id}?x=1&login=${code}`, session)).headers.get('location')).toBe(`/review/${id}?x=1`);
    expect((await testDb().select().from(loginCodes))[0]!.uses).toBe(0);

    const pass = cookieOf(await get(app, `/review/${id}?login=${code}`))!;
    const again = await get(app, `/review/${id}?login=ZZZZ-ZZZZ`, pass);
    expect(again.headers.get('location')).toBe(`/review/${id}`);
    expect(again.headers.get('set-cookie')).toBeNull();
  });

  it('never changes an existing sign-in to another household', async () => {
    const app = createApp(deps());
    const a = await seedUser(testDb(), 'a@example.com', 'Claude A');
    const b = await seedUser(testDb(), 'b@example.com', 'Claude B');
    const aReceipt = await seedReceipt(a.principal);
    const bSession = await signIn(app, b.token);
    const res = await open(app, ((await mintPageLink(testDb(), config, a.principal, `/review/${aReceipt}`)).url), bSession);
    expect(res.headers.get('set-cookie')).not.toContain('btr_session');
    const both = `${bSession}; ${cookieOf(res)}`;
    expect((await get(app, `/api/proposals/${aReceipt}`, both)).status).toBe(200);
    const me = (await (await get(app, '/api/me', both)).json()) as any;
    expect(me.household.id).toBe(b.principal.householdId);
  });

  it('lets a receipt pass undo only that receipt', async () => {
    const app = createApp(deps());
    const { principal } = await seedUser(testDb());
    const first = await seedReceipt(principal, 'warehouse');
    const second = await seedReceipt(principal, 'mixed');
    expect(second).not.toBe(first);
    const applied = (await applyReceipt(principal, first)) as any;
    const other = (await applyReceipt(principal, second)) as any;
    const pass = cookieOf(await open(app, ((await mintPageLink(testDb(), config, principal, `/review/${first}`)).url)))!;
    expect((await post(app, `/api/change-sets/${other.applied_change_set_id}/undo`, { idempotency_key: 'undo-other-receipt' }, pass)).status).toBe(401);
    expect((await post(app, `/api/change-sets/${applied.applied_change_set_id}/undo`, { idempotency_key: 'undo-this-receipt' }, pass)).status).toBe(200);
  });

  it('an item pass can undo a change to that item alone, never a whole receipt', async () => {
    const app = createApp(deps());
    const { principal } = await seedUser(testDb());
    const receipt = fixtureReceipt('warehouse');
    const single = await submitReceipt(deps(), principal, { kind: 'receipt', payload: { ...receipt, receipt_number: 'one-line', lines: receipt.lines.slice(0, 1) }, idempotency_key: 'seed-one-line' });
    const whole = await seedReceipt(principal, 'mixed');
    const one = (await applyReceipt(principal, single.proposal_id)) as any;
    const many = (await applyReceipt(principal, whole)) as any;
    expect(many.created_lot_ids.length).toBeGreaterThan(1);

    const manyPass = cookieOf(await open(app, ((await mintPageLink(testDb(), config, principal, `/items/${many.created_lot_ids[0]}`)).url)))!;
    expect((await post(app, `/api/change-sets/${many.applied_change_set_id}/undo`, { idempotency_key: 'undo-whole-receipt' }, manyPass)).status).toBe(401);
    const onePass = cookieOf(await open(app, ((await mintPageLink(testDb(), config, principal, `/items/${one.created_lot_ids[0]}`)).url)))!;
    expect((await post(app, `/api/change-sets/${one.applied_change_set_id}/undo`, { idempotency_key: 'undo-single-item' }, onePass)).status).toBe(200);
  });

  it('a pass never reaches tokens, household settings or the food catalog', async () => {
    const app = createApp(deps());
    const { principal } = await seedUser(testDb());
    const id = await seedReceipt(principal);
    const pass = cookieOf(await open(app, ((await mintPageLink(testDb(), config, principal, `/review/${id}`)).url)))!;
    expect((await post(app, '/api/tokens', { client_name: 'Sneaky' }, pass)).status).toBe(401);
    expect((await post(app, `/api/tokens/${principal.connectionId}/revoke`, {}, pass)).status).toBe(401);
    expect((await post(app, '/api/household', { name: 'Renamed' }, pass)).status).toBe(401);
    expect((await get(app, '/api/foods', pass)).status).toBe(401);
  });

  it('a pass cookie can never be replayed as a sign-in, nor a sign-in as a pass', async () => {
    const app = createApp(deps());
    const { principal, token } = await seedUser(testDb());
    const id = await seedReceipt(principal);
    const pass = cookieOf(await open(app, ((await mintPageLink(testDb(), config, principal, `/review/${id}`)).url)))!;
    const session = await signIn(app, token);
    const passValue = pass.slice(pass.indexOf('=') + 1);
    const sessionValue = session.slice(session.indexOf('=') + 1);
    expect((await get(app, '/api/me', `btr_session=${passValue}`)).status).toBe(401);
    expect((await get(app, `/api/proposals/${id}`, `btr_pass=${sessionValue}`)).status).toBe(401);

    // A well-formed pass signed with the session key (what a leaked or confused signer would produce) is not a pass.
    const [web] = await testDb().select().from(connections).where(eq(connections.parentConnectionId, principal.connectionId));
    const forged = [{ k: 'proposal', i: id, u: principal.userId, h: principal.householdId, c: web!.id, e: Date.now() + 60_000 }];
    const cookie = (await serializeSigned('btr_pass', JSON.stringify(forged), config.SESSION_SECRET)).split(';')[0]!;
    expect((await get(app, `/api/proposals/${id}`, cookie)).status).toBe(401);
  });

  it('an item pass shows that item only', async () => {
    const app = createApp(deps());
    const { principal } = await seedUser(testDb());
    const id = await seedReceipt(principal);
    const [lotA, lotB] = ((await applyReceipt(principal, id)) as any).created_lot_ids as string[];
    const pass = cookieOf(await open(app, ((await mintPageLink(testDb(), config, principal, `https://buttery.test/items/${lotA}`)).url)))!;
    expect((await get(app, `/api/items/${lotA}`, pass)).status).toBe(200);
    expect((await get(app, `/api/items/${lotB}`, pass)).status).toBe(401);
    expect((await get(app, `/api/proposals/${id}`, pass)).status).toBe(401);
  });

  it('revoking the minting token kills its unused codes and the passes they granted', async () => {
    const app = createApp(deps());
    const { principal } = await seedUser(testDb());
    const used = await mintPageLink(testDb(), config, principal, '/inventory');
    const unused = await mintPageLink(testDb(), config, principal, '/inventory');
    const pass = cookieOf(await open(app, (used.url)))!;
    expect((await get(app, '/api/inventory', pass)).status).toBe(200);
    await revokePat(testDb(), principal, principal.connectionId);
    expect((await get(app, '/api/inventory', pass)).status).toBe(401);
    expect((await open(app, unused.url)).headers.get('location')).toMatch(/^\/login\?reason=link_expired/);
  });

  it('revoking a pasted token signs out the browsers it signed in (M7)', async () => {
    const app = createApp(deps());
    const { principal, token } = await seedUser(testDb());
    const session = await signIn(app, token);
    expect((await get(app, '/api/me', session)).status).toBe(200);
    await revokePat(testDb(), principal, principal.connectionId);
    expect((await get(app, '/api/me', session)).status).toBe(401);
  });

  it('rate-limits failed opens per client, grouping IPv6 by /64', async () => {
    const app = createApp(deps());
    const { principal } = await seedUser(testDb());
    const good = (await mintPageLink(testDb(), config, principal, '/inventory')).url;
    for (let i = 0; i < 10; i++) expect((await open(app, '/inventory?login=ABCD-EFGH', undefined, `2001:db8:1:2::${i + 1}`)).headers.get('location')).toMatch(/reason=link_expired/);
    expect((await open(app, good, undefined, '2001:db8:1:2::ff')).headers.get('location')).toMatch(/reason=rate_limited/);
    expect((await open(app, good, undefined, '203.0.113.7')).headers.get('location')).toBe('/inventory');
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('ignores login= on sign-in, settings, API and health paths', async () => {
    const app = createApp(deps());
    const { principal, token } = await seedUser(testDb());
    const code = codeFrom((await mintPageLink(testDb(), config, principal, '/inventory')).url);
    const session = await signIn(app, token);
    for (const path of ['/login', '/settings']) expect((await get(app, `${path}?login=${code}`, session)).status).not.toBe(302);
    expect((await get(app, `/api/me?login=${code}`)).status).toBe(401);
    expect((await get(app, `/healthz?login=${code}`)).status).toBe(200);
  });

  it('drops codes that expired more than a day ago when minting', async () => {
    const { principal } = await seedUser(testDb());
    await mintPageLink(testDb(), config, principal, '/inventory', new Date(Date.now() - 2 * 24 * 60 * 60_000));
    await mintPageLink(testDb(), config, principal, '/inventory');
    expect(await testDb().select().from(loginCodes)).toHaveLength(1);
  });
});

describe('get_login_code over MCP', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer(deps());
  });
  afterAll(() => server.close());
  beforeEach(() => resetDb());

  it('turns a Buttery page URL into a one-tap link', async () => {
    const { token, principal } = await seedUser(testDb());
    const id = await seedReceipt(principal);
    const client = await mcpClient(server.url, token);
    const r = await callTool(client, 'get_login_code', { url: `https://buttery.test/review/${id}` });
    expect(r.url).toMatch(new RegExp(`^https://buttery\\.test/review/${id}\\?login=[A-Z2-9]{4}-[A-Z2-9]{4}$`));
    const [row] = await testDb().select().from(loginCodes).where(eq(loginCodes.connectionId, principal.connectionId));
    expect(row?.scopeId).toBe(id);
    expect(JSON.stringify(await callTool(client, 'whoami'))).toContain('get_login_code');
    await expect(callTool(client, 'get_login_code', { url: 'https://buttery.test/settings' })).rejects.toThrow(/invalid_input/);
    await client.close();
  });
});
