import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { connections } from '../db/schema';
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
