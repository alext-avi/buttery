import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

export type FailureLimiter = { blocked(key: string): boolean; fail(key: string): void };

/** Counts failures per key in a sliding window. In memory: fine for one instance, needs a shared store for several. */
export function createFailureLimiter(limit = 10, windowMs = 10 * 60_000, now = () => Date.now()): FailureLimiter {
  const hits = new Map<string, number[]>();
  const recent = (key: string) => {
    const t = now();
    const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (list.length) hits.set(key, list);
    else hits.delete(key);
    return list;
  };
  return {
    blocked: (key) => recent(key).length >= limit,
    fail: (key) => {
      if (hits.size > 10_000) for (const k of [...hits.keys()]) recent(k);
      hits.set(key, [...recent(key), now()]);
    },
  };
}

/** With a trusted proxy, its appended X-Forwarded-For entry (the last one) is the client; earlier entries can be forged. */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const last = c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
