import { sql } from 'drizzle-orm';
import { createDb, type Db } from '../../src/db/client';

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://buttery:buttery@localhost:5433/buttery_test';

let shared: Db | undefined;

export function testDb(): Db {
  shared ??= createDb(TEST_DB_URL);
  return shared;
}

export async function resetDb(db: Db = testDb()): Promise<void> {
  const rows = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = rows.map((r) => `"${r.tablename}"`).join(', ');
  if (names) await db.execute(sql.raw(`truncate ${names} restart identity cascade`));
}

export async function closeTestDb(): Promise<void> {
  if (shared) await shared.$client.end();
  shared = undefined;
}
