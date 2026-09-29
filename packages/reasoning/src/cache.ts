import type { ReasoningCache } from './types.ts';

export function createMemoryCache(maxEntries = 1000): ReasoningCache {
  const entries = new Map<string, unknown>();
  return {
    async get(key) {
      return entries.get(key);
    },
    async set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
    },
  };
}

export function cacheKey(fn: string, model: string, inputHash: string): string {
  return `${fn}:${model}:${inputHash}`;
}
