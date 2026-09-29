import type { Context } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { and, eq, isNull } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { connections } from '../db/schema';
import type { Principal } from '../identity/principal';

const COOKIE = 'btr_session';
export type SessionData = { u: string; h: string; c: string };

export async function readSession(c: Context, secret: string): Promise<SessionData | null> {
  const raw = await getSignedCookie(c, secret, COOKIE);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<SessionData>;
    return s.u && s.h && s.c ? (s as SessionData) : null;
  } catch {
    return null;
  }
}

export async function writeSession(c: Context, config: Config, s: SessionData): Promise<void> {
  await setSignedCookie(c, COOKIE, JSON.stringify(s), config.SESSION_SECRET, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.PUBLIC_BASE_URL.startsWith('https://'),
    path: '/',
    maxAge: 60 * 60 * 24 * 90,
  });
}

export function clearSession(c: Context): void {
  deleteCookie(c, COOKIE, { path: '/' });
}

export async function principalFromSession(db: Db, s: SessionData): Promise<Principal | null> {
  const [conn] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, s.c), eq(connections.userId, s.u), eq(connections.householdId, s.h), isNull(connections.revokedAt)))
    .limit(1);
  return conn ? { userId: conn.userId, householdId: conn.householdId, connectionId: conn.id, clientName: conn.clientName } : null;
}

const LOCAL = 'http://buttery.local';

/** Only same-site paths survive; backslashes, control characters and protocol-relative tricks fall back. */
export function safeNext(next: unknown): string {
  const fallback = '/inventory';
  if (typeof next !== 'string' || !next.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(next)) return fallback;
  try {
    const u = new URL(next, LOCAL);
    return u.origin === LOCAL ? `${u.pathname}${u.search}${u.hash}` : fallback;
  } catch {
    return fallback;
  }
}
