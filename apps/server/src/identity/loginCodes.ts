import { createHmac, randomInt } from 'node:crypto';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Executor } from '../db/client';
import { connections, loginCodes } from '../db/schema';
import type { Principal } from './principal';

// No 0/O, 1/I/L or U, so a code survives being read aloud or typed on a phone.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const LENGTH = 8;
const SHAPE = new RegExp(`^[${ALPHABET}]{${LENGTH}}$`);

export const normalizeCode = (raw: string) => raw.toUpperCase().replace(/[\s-]/g, '');
const display = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
// Keyed so a leaked table of hashes can't be brute-forced offline: the code space is small.
const hashCode = (secret: string, code: string) => createHmac('sha256', secret).update(code).digest('hex');

export async function mintLoginCode(db: Executor, config: Config, p: Principal, now = new Date()): Promise<{ code: string; expiresAt: Date; usesLeft: number }> {
  const expiresAt = new Date(now.getTime() + config.LOGIN_CODE_TTL_MINUTES * 60_000);
  for (;;) {
    const code = Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const rows = await db
      .insert(loginCodes)
      .values({ codeHash: hashCode(config.SESSION_SECRET, code), householdId: p.householdId, userId: p.userId, connectionId: p.connectionId, expiresAt })
      .onConflictDoNothing()
      .returning({ maxUses: loginCodes.maxUses });
    if (rows[0]) return { code: display(code), expiresAt, usesLeft: rows[0].maxUses };
  }
}

export type LoginGrant = { codeId: string; userId: string; householdId: string; connectionId: string; clientName: string };

/** A live code: unexpired, uses left, and its minting connection not revoked. Does not spend a use. */
export async function findLoginCode(db: Executor, config: Config, raw: string, now = new Date()): Promise<LoginGrant | null> {
  const code = normalizeCode(raw);
  if (!SHAPE.test(code)) return null;
  const [row] = await db
    .select({ codeId: loginCodes.id, userId: loginCodes.userId, householdId: loginCodes.householdId, connectionId: loginCodes.connectionId, clientName: connections.clientName })
    .from(loginCodes)
    .innerJoin(connections, eq(connections.id, loginCodes.connectionId))
    .where(and(eq(loginCodes.codeHash, hashCode(config.SESSION_SECRET, code)), lt(loginCodes.uses, loginCodes.maxUses), gt(loginCodes.expiresAt, now), isNull(connections.revokedAt)))
    .limit(1);
  return row ?? null;
}

/** Atomically spends one use; false if the code ran out or expired in the meantime. */
export async function spendLoginCode(db: Executor, codeId: string, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(loginCodes)
    .set({ uses: sql`${loginCodes.uses} + 1` })
    .where(and(eq(loginCodes.id, codeId), lt(loginCodes.uses, loginCodes.maxUses), gt(loginCodes.expiresAt, now)))
    .returning({ id: loginCodes.id });
  return rows.length > 0;
}
