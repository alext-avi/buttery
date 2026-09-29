import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { connections } from '../db/schema';

/**
 * The browser's connection. With a parent (the agent token or code that vouched for it), revoking the parent signs these browsers out.
 * One connection per (user, household, parent), reused across sign-ins.
 */
export async function ensureWebConnection(db: Db, userId: string, householdId: string, parent?: { id: string; name: string }): Promise<string> {
  const [existing] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.userId, userId),
        eq(connections.householdId, householdId),
        eq(connections.kind, 'web'),
        isNull(connections.revokedAt),
        parent ? eq(connections.parentConnectionId, parent.id) : isNull(connections.parentConnectionId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const [row] = await db
    .insert(connections)
    .values({ userId, householdId, kind: 'web', clientName: parent?.name ?? 'Web', parentConnectionId: parent?.id ?? null })
    .returning({ id: connections.id });
  return row!.id;
}
