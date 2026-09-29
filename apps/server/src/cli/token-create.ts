import { parseArgs } from 'node:util';
import { createDb } from '../db/client';
import { provisionUser } from '../identity/provision';
import { createPat } from '../identity/tokens';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    client: { type: 'string', default: 'CLI' },
  },
});

if (!values.email) {
  console.error('usage: npm run token:create -- --email you@example.com [--name "Alex"] [--client "Claude Code"]');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const db = createDb(url);
try {
  const u = await provisionUser(db, { email: values.email, displayName: values.name ?? null });
  const { token } = await createPat(db, { userId: u.userId, householdId: u.householdId, clientName: values.client! });
  console.log(`household ${u.householdId}${u.created ? ' (new)' : ''}`);
  console.log(`token for "${values.client}": ${token}`);
  console.log('Store it now; it cannot be shown again.');
} finally {
  await db.$client.end();
}
