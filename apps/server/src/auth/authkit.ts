import { and, eq, isNull } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { WorkOS } from '@workos-inc/node';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { connections } from '../db/schema';
import type { Principal } from '../identity/principal';
import { AppError } from '../errors';
import { findUserBySubject, provisionUser } from '../identity/provision';

export type AuthkitUser = { id: string; email: string | null; firstName: string | null; lastName: string | null };

export type Authkit = {
  resolveBearer(token: string): Promise<Principal | null>;
  loginUrl(next: string, mode?: 'sign-in' | 'sign-up'): string;
  completeLogin(code: string): Promise<{ userId: string; householdId: string; created: boolean }>;
};

type Overrides = { jwks?: JWTVerifyGetKey; fetchUser?: (id: string) => Promise<AuthkitUser>; exchangeCode?: (code: string) => Promise<AuthkitUser> };

async function ensureOAuthConnection(db: Db, userId: string, householdId: string, oauthClientId: string) {
  const [existing] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.householdId, householdId), eq(connections.kind, 'oauth_client'), eq(connections.oauthClientId, oauthClientId), isNull(connections.revokedAt)))
    .limit(1);
  if (existing) return existing;
  const [row] = await db
    .insert(connections)
    .values({ userId, householdId, kind: 'oauth_client', oauthClientId, clientName: `Connector ${oauthClientId.slice(-6)}` })
    .returning();
  return row!;
}

export function createAuthkit(config: Config, db: Db, o: Overrides = {}): Authkit | null {
  if (!config.AUTHKIT_DOMAIN || !config.WORKOS_CLIENT_ID || !config.WORKOS_API_KEY) return null;
  const clientId = config.WORKOS_CLIENT_ID;
  const issuer = config.AUTHKIT_ISSUER ?? config.AUTHKIT_DOMAIN;
  const jwks = o.jwks ?? createRemoteJWKSet(new URL(`${config.AUTHKIT_DOMAIN}/oauth2/jwks`));
  const workos = new WorkOS(config.WORKOS_API_KEY, { clientId });
  const toUser = (u: { id: string; email: string; firstName: string | null; lastName: string | null }): AuthkitUser => ({ id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName });
  const fetchUser = o.fetchUser ?? (async (id: string) => toUser(await workos.userManagement.getUser(id)));
  const exchangeCode = o.exchangeCode ?? (async (code: string) => toUser((await workos.userManagement.authenticateWithCode({ clientId, code })).user));
  const ensure = (u: AuthkitUser) =>
    provisionUser(db, { authSubject: u.id, email: u.email, displayName: [u.firstName, u.lastName].filter(Boolean).join(' ') || null }, { allowCreate: config.SIGNUP_MODE === 'open' });

  return {
    async resolveBearer(token) {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, jwks, { issuer }));
      } catch {
        return null;
      }
      if (!payload.sub) return null;
      const known = await findUserBySubject(db, payload.sub);
      let identity = known;
      if (!identity) {
        try {
          identity = await ensure(await fetchUser(payload.sub));
        } catch (err) {
          if (err instanceof AppError && err.code === 'signup_closed') return null;
          throw err;
        }
      }
      const { userId, householdId } = identity;
      const oauthClientId = (payload.client_id as string | undefined) ?? (payload.azp as string | undefined) ?? 'oauth';
      const conn = await ensureOAuthConnection(db, userId, householdId, oauthClientId);
      return { userId, householdId, connectionId: conn.id, clientName: conn.clientName };
    },
    loginUrl(next, mode = 'sign-in') {
      return workos.userManagement.getAuthorizationUrl({ provider: 'authkit', clientId, redirectUri: `${config.PUBLIC_BASE_URL}/auth/callback`, state: next, screenHint: mode });
    },
    async completeLogin(code) {
      const r = await ensure(await exchangeCode(code));
      return { userId: r.userId, householdId: r.householdId, created: r.created };
    },
  };
}
