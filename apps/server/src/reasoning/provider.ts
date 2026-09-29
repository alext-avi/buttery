import { createReasoningProvider } from '@buttery/reasoning';
import type { Db } from '../db/client';
import { createDbReasoningCache } from './cache';
import type { ReasoningPort } from './port';

export function createReasoning(db: Db): ReasoningPort {
  const provider = createReasoningProvider();
  const cache = createDbReasoningCache(db);
  return {
    canonicalizeItems: (input, ctx) => provider.canonicalizeItems(input, { ...ctx, cache }),
    estimateShelfLife: (input, ctx) => provider.estimateShelfLife(input, { ...ctx, cache }),
  };
}
