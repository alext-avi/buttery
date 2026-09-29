import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { reasoningCache } from '../db/schema';
import type { ReasoningCache } from './port';

export function createDbReasoningCache(db: Db): ReasoningCache {
  return {
    async get(key) {
      const [row] = await db.select().from(reasoningCache).where(eq(reasoningCache.key, key)).limit(1);
      return row?.value ?? undefined;
    },
    async set(key, value) {
      await db.insert(reasoningCache).values({ key, value: value as object }).onConflictDoUpdate({ target: reasoningCache.key, set: { value: value as object } });
    },
  };
}
