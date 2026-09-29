import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { connections } from '../db/schema';

export async function ensureWebConnection(db: Db, userId: string, householdId: string): Promise<string> {
  const [existing] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.householdId, householdId), eq(connections.kind, 'web'), isNull(connections.revokedAt)))
    .limit(1);
  if (existing) return existing.id;
  const [row] = await db.insert(connections).values({ userId, householdId, kind: 'web', clientName: 'Web' }).returning({ id: connections.id });
  return row!.id;
}
