import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { connections } from '../src/db/schema';
import { provisionUser } from '../src/identity/provision';
import { hashToken } from '../src/identity/tokens';
import { submitReceipt } from '../src/services/receipts';
import { createFakeReasoning } from './helpers/fakeReasoning';
import { fixtureReceipt } from './fixtures/receipts';

const E2E_TOKEN = 'btr_e2e_token_for_local_tests_only_00';
const url = process.env.DATABASE_URL ?? '';
if (!url.includes('buttery_e2e')) throw new Error('e2e-seed only runs against the buttery_e2e database');

await runMigrations(url);
const db = createDb(url);
const tables = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
await db.execute(sql.raw(`truncate ${tables.map((t) => `"${t.tablename}"`).join(', ')} restart identity cascade`));

const u = await provisionUser(db, { email: 'e2e@example.com', displayName: 'Alex' });
const [conn] = await db
  .insert(connections)
  .values({ userId: u.userId, householdId: u.householdId, kind: 'pat', clientName: 'Claude iOS', tokenHash: hashToken(E2E_TOKEN), tokenPrefix: E2E_TOKEN.slice(0, 8) })
  .returning();
const principal = { userId: u.userId, householdId: u.householdId, connectionId: conn!.id, clientName: 'Claude iOS' };
const r = await submitReceipt({ db, config: loadConfig(), reasoning: createFakeReasoning() }, principal, {
  kind: 'receipt',
  payload: fixtureReceipt('warehouse'),
  idempotency_key: 'e2e-seed-warehouse',
});

const out = fileURLToPath(new URL('../.e2e/', import.meta.url));
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/state.json`, JSON.stringify({ token: E2E_TOKEN, proposal_id: r.proposal_id }));
await db.$client.end();
console.log('e2e seed ready');
