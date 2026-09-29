import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connections, memberships, users } from '../src/db/schema';
import { provisionUser } from '../src/identity/provision';
import { createPat, resolvePat } from '../src/identity/tokens';
import { sql } from 'drizzle-orm';
import { createDb } from '../src/db/client';
import { resetDb, TEST_DB_URL, testDb } from './helpers/db';

describe('identity', () => {
  beforeEach(() => resetDb());
  const db = testDb();

  it('provisions a user as owner of a new household', async () => {
    const r = await provisionUser(db, { email: 'a@example.com', displayName: 'Alex' });
    expect(r.created).toBe(true);
    const [m] = await db.select().from(memberships).where(eq(memberships.userId, r.userId));
    expect(m).toMatchObject({ householdId: r.householdId, role: 'owner' });
  });

  it('returns the same user for the same auth subject', async () => {
    const a = await provisionUser(db, { authSubject: 'user_1', email: 'a@example.com' });
    const b = await provisionUser(db, { authSubject: 'user_1' });
    expect(b).toMatchObject({ userId: a.userId, householdId: a.householdId, created: false });
  });

  it('links an auth subject to an existing email-only user', async () => {
    const a = await provisionUser(db, { email: 'a@example.com' });
    const b = await provisionUser(db, { authSubject: 'user_9', email: 'A@Example.com' });
    expect(b.userId).toBe(a.userId);
    const [u] = await db.select().from(users).where(eq(users.id, a.userId));
    expect(u?.authSubject).toBe('user_9');
  });

  it('creates one user when the same new identity signs in concurrently', async () => {
    const clients = Array.from({ length: 5 }, () => createDb(TEST_DB_URL));
    await Promise.all(clients.map((c) => c.execute(sql`select 1`))); // open every connection first
    const results = await Promise.all(clients.map((c) => provisionUser(c, { authSubject: 'user_race', email: 'race@example.com' })));
    await Promise.all(clients.map((c) => c.$client.end()));
    expect(new Set(results.map((r) => r.userId)).size).toBe(1);
    expect(new Set(results.map((r) => r.householdId)).size).toBe(1);
    expect(await db.select().from(users).where(eq(users.authSubject, 'user_race'))).toHaveLength(1);
  });

  it('creates and resolves a personal access token', async () => {
    const u = await provisionUser(db, { email: 'a@example.com' });
    const { token, connectionId } = await createPat(db, { userId: u.userId, householdId: u.householdId, clientName: 'Claude Code' });
    expect(token).toMatch(/^btr_[A-Za-z0-9_-]{32}$/);
    const p = await resolvePat(db, token);
    expect(p).toEqual({ userId: u.userId, householdId: u.householdId, connectionId, clientName: 'Claude Code' });
    const [row] = await db.select().from(connections).where(eq(connections.id, connectionId));
    expect(row?.tokenHash).not.toContain(token);
  });

  it('rejects revoked, unknown and non-prefixed tokens', async () => {
    const u = await provisionUser(db, { email: 'a@example.com' });
    const { token, connectionId } = await createPat(db, { userId: u.userId, householdId: u.householdId, clientName: 'x' });
    await db.update(connections).set({ revokedAt: new Date() }).where(eq(connections.id, connectionId));
    expect(await resolvePat(db, token)).toBeNull();
    expect(await resolvePat(db, 'btr_nope')).toBeNull();
    expect(await resolvePat(db, 'eyJhbGciOi...')).toBeNull();
  });
});
