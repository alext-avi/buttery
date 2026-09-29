import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { households, memberships, users } from '../db/schema';

export type ProvisionInput = { authSubject?: string | null; email?: string | null; displayName?: string | null };
export type ProvisionResult = { userId: string; householdId: string; created: boolean };

async function householdFor(db: Db, userId: string, defaultHouseholdId: string | null): Promise<string> {
  if (defaultHouseholdId) return defaultHouseholdId;
  const [m] = await db.select().from(memberships).where(eq(memberships.userId, userId)).limit(1);
  if (!m) throw new Error(`user ${userId} has no household`);
  return m.householdId;
}

export async function provisionUser(db: Db, input: ProvisionInput): Promise<ProvisionResult> {
  const email = input.email?.trim().toLowerCase() || null;

  if (input.authSubject) {
    const [bySubject] = await db.select().from(users).where(eq(users.authSubject, input.authSubject)).limit(1);
    if (bySubject) {
      return { userId: bySubject.id, householdId: await householdFor(db, bySubject.id, bySubject.defaultHouseholdId), created: false };
    }
  }

  if (email) {
    const [byEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (byEmail) {
      if (input.authSubject && !byEmail.authSubject) {
        await db
          .update(users)
          .set({ authSubject: input.authSubject })
          .where(and(eq(users.id, byEmail.id), isNull(users.authSubject)));
      }
      return { userId: byEmail.id, householdId: await householdFor(db, byEmail.id, byEmail.defaultHouseholdId), created: false };
    }
  }

  return db.transaction(async (tx) => {
    const name = input.displayName ? `${input.displayName}'s household` : 'Home';
    const [household] = await tx.insert(households).values({ name }).returning();
    const [user] = await tx
      .insert(users)
      .values({
        authSubject: input.authSubject ?? null,
        email,
        displayName: input.displayName ?? null,
        defaultHouseholdId: household!.id,
      })
      .returning();
    await tx.insert(memberships).values({ householdId: household!.id, userId: user!.id, role: 'owner' });
    return { userId: user!.id, householdId: household!.id, created: true };
  });
}
