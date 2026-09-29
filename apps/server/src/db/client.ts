import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from './schema';

export function createDb(url: string) {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  return drizzle({ client, schema });
}

export type Db = ReturnType<typeof createDb>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Executor = PgDatabase<any, typeof schema>;
