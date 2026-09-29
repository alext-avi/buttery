import { createHmac, randomInt } from 'node:crypto';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Executor } from '../db/client';
import { connections, loginCodes, lots, proposals } from '../db/schema';
import { AppError } from '../errors';
import type { Principal } from './principal';

// No 0/O, 1/I/L or U, so a code survives being read aloud or retyped.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const LENGTH = 8;
const SHAPE = new RegExp(`^[${ALPHABET}]{${LENGTH}}$`);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export const normalizeCode = (raw: string) => raw.toUpperCase().replace(/[\s-]/g, '');
const display = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
// Keyed so a leaked table of hashes can't be brute-forced offline: the code space is small.
const hashCode = (secret: string, code: string) => createHmac('sha256', secret).update(code).digest('hex');

/** What a page link grants: one receipt review, one item, or the inventory list. */
export type PageScope = { kind: 'proposal' | 'lot'; id: string } | { kind: 'inventory'; id: null };

/** The shareable pages. Anything else (settings, login) always needs a real sign-in. */
export function pageScope(pathname: string): PageScope | null {
  const review = new RegExp(`^/review/(${UUID})$`, 'i').exec(pathname);
  if (review) return { kind: 'proposal', id: review[1]!.toLowerCase() };
  const item = new RegExp(`^/items/(${UUID})$`, 'i').exec(pathname);
  if (item) return { kind: 'lot', id: item[1]!.toLowerCase() };
  if (pathname === '/inventory') return { kind: 'inventory', id: null };
  return null;
}

/** Whether the page's receipt or item belongs to the household (the inventory always does). */
export async function inHousehold(db: Executor, householdId: string, scope: PageScope): Promise<boolean> {
  if (scope.kind === 'inventory') return true;
  const table = scope.kind === 'proposal' ? proposals : lots;
  const [row] = await db.select({ id: table.id }).from(table).where(and(eq(table.id, scope.id), eq(table.householdId, householdId))).limit(1);
  return Boolean(row);
}

/**
 * Mints a one-time code for one Buttery page URL and returns the URL with `login=<code>` attached.
 * The code expires if it isn't opened within LOGIN_CODE_TTL_MINUTES.
 */
export async function mintPageLink(db: Executor, config: Config, p: Principal, rawUrl: string, now = new Date()): Promise<{ url: string; code: string; expiresAt: Date }> {
  let url: URL;
  try {
    url = new URL(rawUrl, config.PUBLIC_BASE_URL);
  } catch {
    throw new AppError('invalid_input', 'Pass a Buttery page URL.', 400);
  }
  const scope = url.origin === new URL(config.PUBLIC_BASE_URL).origin ? pageScope(url.pathname) : null;
  if (!scope) throw new AppError('invalid_input', 'Only receipt review, item and inventory links can be shared this way.', 400);
  if (!(await inHousehold(db, p.householdId, scope))) throw new AppError('not_found', 'That page is not in this household.', 404);
  url.searchParams.delete('login');
  const path = `${url.pathname}${url.search}`;
  const expiresAt = new Date(now.getTime() + config.LOGIN_CODE_TTL_MINUTES * 60_000);

  // Dead codes are useless after they expire; keep a day for debugging, then drop them.
  await db.delete(loginCodes).where(lt(loginCodes.expiresAt, new Date(now.getTime() - 24 * 60 * 60_000)));
  for (;;) {
    const code = Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const rows = await db
      .insert(loginCodes)
      .values({ codeHash: hashCode(config.SESSION_SECRET, code), path, scopeKind: scope.kind, scopeId: scope.id, householdId: p.householdId, userId: p.userId, connectionId: p.connectionId, expiresAt })
      .onConflictDoNothing()
      .returning({ id: loginCodes.id });
    if (rows[0]) {
      url.searchParams.set('login', display(code));
      return { url: `${config.PUBLIC_BASE_URL}${url.pathname}${url.search}`, code: display(code), expiresAt };
    }
  }
}

export type LoginGrant = { codeId: string; userId: string; householdId: string; connectionId: string; clientName: string; path: string; scope: PageScope };

/** A live code: unexpired, and its minting connection not revoked. */
export async function findLoginCode(db: Executor, config: Config, raw: string, now = new Date()): Promise<LoginGrant | null> {
  const code = normalizeCode(raw);
  if (!SHAPE.test(code)) return null;
  const [row] = await db
    .select({ code: loginCodes, clientName: connections.clientName })
    .from(loginCodes)
    .innerJoin(connections, eq(connections.id, loginCodes.connectionId))
    .where(and(eq(loginCodes.codeHash, hashCode(config.SESSION_SECRET, code)), gt(loginCodes.expiresAt, now), isNull(connections.revokedAt)))
    .limit(1);
  if (!row) return null;
  const c = row.code;
  const scope = (c.scopeKind === 'inventory' ? { kind: 'inventory', id: null } : { kind: c.scopeKind, id: c.scopeId! }) as PageScope;
  return { codeId: c.id, userId: c.userId, householdId: c.householdId, connectionId: c.connectionId, clientName: row.clientName, path: c.path, scope };
}

/** Counts an open; false if the code expired in the meantime. */
export async function recordLoginCodeUse(db: Executor, codeId: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(loginCodes)
    .set({ uses: sql`${loginCodes.uses} + 1` })
    .where(and(eq(loginCodes.id, codeId), gt(loginCodes.expiresAt, now)))
    .returning({ id: loginCodes.id });
  return rows.length > 0;
}
