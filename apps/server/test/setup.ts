import { afterAll } from 'vitest';
import { closeTestDb } from './helpers/db';

afterAll(async () => {
  await closeTestDb();
});
