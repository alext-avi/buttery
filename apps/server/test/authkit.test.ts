/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAuthkit } from '../src/auth/authkit';
import { loadConfig } from '../src/config';
import { createApp } from '../src/http/app';
import { provisionUser } from '../src/identity/provision';
import { resetDb, TEST_DB_URL, testDb } from './helpers/db';
import { callTool, mcpClient, startServer, testDeps } from './helpers/app';

const ISSUER = 'https://auth.test';
const config = loadConfig({
  DATABASE_URL: TEST_DB_URL,
  SESSION_SECRET: 'x'.repeat(32),
  PUBLIC_BASE_URL: 'https://buttery.test',
  AUTHKIT_DOMAIN: ISSUER,
  WORKOS_CLIENT_ID: 'client_test',
  WORKOS_API_KEY: 'sk_test_dummy',
});

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] });
  const sign = (claims: { sub?: string; iss?: string; exp?: string; client_id?: string }) =>
    new SignJWT({ client_id: claims.client_id ?? 'client_claude' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(claims.iss ?? ISSUER)
      .setSubject(claims.sub ?? 'user_01')
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? '5m')
      .sign(privateKey);
  return { jwks, sign };
}

const fetchUser = async (id: string) => ({ id, email: 'alex@example.com', firstName: 'Alex', lastName: null });

describe('AuthKit', () => {
  beforeEach(() => resetDb());
  const db = testDb();

  it('accepts a valid token, provisions the user once and reuses the connection', async () => {
    const { jwks, sign } = await keys();
    const ak = createAuthkit(config, db, { jwks, fetchUser })!;
    const a = await ak.resolveBearer(await sign({}));
    const b = await ak.resolveBearer(await sign({}));
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
  });

  it('links to an existing PAT user with the same email', async () => {
    const { jwks, sign } = await keys();
    const existing = await provisionUser(db, { email: 'alex@example.com' });
    const p = await createAuthkit(config, db, { jwks, fetchUser })!.resolveBearer(await sign({}));
    expect(p).toMatchObject({ userId: existing.userId, householdId: existing.householdId });
  });

  it('rejects a wrong issuer, an expired token and garbage', async () => {
    const { jwks, sign } = await keys();
    const ak = createAuthkit(config, db, { jwks, fetchUser })!;
    expect(await ak.resolveBearer(await sign({ iss: 'https://evil.test' }))).toBeNull();
    expect(await ak.resolveBearer(await sign({ exp: '-1m' }))).toBeNull();
    expect(await ak.resolveBearer('not-a-jwt')).toBeNull();
  });

  it('serves MCP to an AuthKit token', async () => {
    const { jwks, sign } = await keys();
    const ak = createAuthkit(config, db, { jwks, fetchUser })!;
    const server = await startServer(testDeps({ config, authkit: ak, resolveBearer: (t) => ak.resolveBearer(t) }));
    const client = await mcpClient(server.url, await sign({}));
    expect((await callTool(client, 'whoami')).user.email).toBe('alex@example.com');
    await client.close();
    await server.close();
  });

  it('completes web sign-in via the callback', async () => {
    const ak = createAuthkit(config, db, { fetchUser, exchangeCode: async () => fetchUser('user_01') })!;
    const app = createApp(testDeps({ config, authkit: ak }));
    const start = await app.request('/auth/authkit?next=/review/abc');
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toContain('client_id=client_test');
    const cb = await app.request('/auth/callback?code=xyz&state=%2Freview%2Fabc');
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/review/abc');
    const cookie = cb.headers.get('set-cookie')!.split(';')[0]!;
    const me = (await (await app.request('/api/me', { headers: { cookie } })).json() as any);
    expect(me.user.email).toBe('alex@example.com');
  });
});
