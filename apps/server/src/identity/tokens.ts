import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { connections } from '../db/schema';
import { notFound } from '../errors';
import type { Principal } from './principal';

export const PAT_PREFIX = 'btr_';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createPat(
  db: Executor,
  input: { userId: string; householdId: string; clientName: string },
): Promise<{ token: string; connectionId: string }> {
  const token = PAT_PREFIX + randomBytes(24).toString('base64url');
  const [row] = await db
    .insert(connections)
    .values({
      userId: input.userId,
      householdId: input.householdId,
      kind: 'pat',
      clientName: input.clientName,
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, 8),
    })
    .returning({ id: connections.id });
  return { token, connectionId: row!.id };
}

export async function resolvePat(db: Executor, token: string): Promise<Principal | null> {
  if (!token.startsWith(PAT_PREFIX)) return null;
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.tokenHash, hashToken(token)), isNull(connections.revokedAt)))
    .limit(1);
  if (!row) return null;
  await db.update(connections).set({ lastUsedAt: new Date() }).where(eq(connections.id, row.id));
  return { userId: row.userId, householdId: row.householdId, connectionId: row.id, clientName: row.clientName };
}

export async function listPats(db: Executor, p: Principal) {
  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.userId, p.userId), eq(connections.householdId, p.householdId), eq(connections.kind, 'pat'), isNull(connections.revokedAt)))
    .orderBy(desc(connections.createdAt));
  return rows.map((r) => ({
    connection_id: r.id,
    client_name: r.clientName,
    token_prefix: r.tokenPrefix,
    created_at: r.createdAt.toISOString(),
    last_used_at: r.lastUsedAt?.toISOString() ?? null,
  }));
}

export async function revokePat(db: Executor, p: Principal, connectionId: string): Promise<void> {
  const rows = await db
    .update(connections)
    .set({ revokedAt: new Date() })
    .where(and(eq(connections.id, connectionId), eq(connections.userId, p.userId), eq(connections.householdId, p.householdId), eq(connections.kind, 'pat'), isNull(connections.revokedAt)))
    .returning({ id: connections.id });
  if (!rows.length) throw notFound('Token');
}
