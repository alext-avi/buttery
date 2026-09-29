import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { households } from '../src/db/schema';
import { loadConfig } from '../src/config';
import { resetDb, testDb } from './helpers/db';

describe('database', () => {
  beforeEach(() => resetDb());

  it('stores and reads a household with the default timezone', async () => {
    const db = testDb();
    const [h] = await db.insert(households).values({ name: 'Test' }).returning();
    const [read] = await db.select().from(households).where(eq(households.id, h!.id));
    expect(read?.timezone).toBe('America/New_York');
  });

  it('rejects a short session secret', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', SESSION_SECRET: 'short' })).toThrow();
  });

  it('strips a trailing slash from PUBLIC_BASE_URL', () => {
    const c = loadConfig({ DATABASE_URL: 'x', SESSION_SECRET: 'x'.repeat(32), PUBLIC_BASE_URL: 'https://a.test/' });
    expect(c.PUBLIC_BASE_URL).toBe('https://a.test');
  });
});
