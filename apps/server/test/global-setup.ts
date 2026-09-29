import { runMigrations } from '../src/db/migrate';
import { TEST_DB_URL } from './helpers/db';

export default async function setup() {
  await runMigrations(TEST_DB_URL);
}
