import { and, eq } from 'drizzle-orm';
import { hashJson } from '@buttery/domain';
import type { Db, Executor, Tx } from '../db/client';
import { idempotencyRecords } from '../db/schema';
import { AppError } from '../errors';

export type IdempotencyScope = { householdId: string; tool: string; key: string; request: unknown };

function where(s: IdempotencyScope) {
  return and(
    eq(idempotencyRecords.householdId, s.householdId),
    eq(idempotencyRecords.tool, s.tool),
    eq(idempotencyRecords.key, s.key),
  );
}

async function findRecord(db: Executor, s: IdempotencyScope) {
  const [row] = await db.select().from(idempotencyRecords).where(where(s)).limit(1);
  return row;
}

function replay<R>(row: { requestHash: string; response: unknown }, requestHash: string): R {
  if (row.requestHash !== requestHash) {
    throw new AppError('idempotency_key_reused', 'This idempotency_key was already used for a different request. Use a new key for a new action.', 409);
  }
  if (row.response === null || row.response === undefined) {
    throw new AppError('idempotency_in_flight', 'A request with this idempotency_key is still in progress. Retry shortly.', 409);
  }
  return row.response as R;
}

export async function findIdempotent<R>(db: Executor, s: IdempotencyScope): Promise<R | undefined> {
  const row = await findRecord(db, s);
  return row ? replay<R>(row, hashJson(s.request)) : undefined;
}

export async function runIdempotent<R>(db: Db, s: IdempotencyScope, work: (tx: Tx) => Promise<R>): Promise<R> {
  const requestHash = hashJson(s.request);
  const prior = await findRecord(db, s);
  if (prior) return replay<R>(prior, requestHash);

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(idempotencyRecords)
      .values({ householdId: s.householdId, tool: s.tool, key: s.key, requestHash, response: null })
      .onConflictDoNothing()
      .returning({ key: idempotencyRecords.key });
    if (inserted.length === 0) {
      // A concurrent request with the same key committed first (we waited on its row lock).
      const row = await findRecord(tx, s);
      if (!row) throw new AppError('idempotency_in_flight', 'A request with this idempotency_key is still in progress. Retry shortly.', 409);
      return replay<R>(row, requestHash);
    }
    const result = JSON.parse(JSON.stringify(await work(tx))) as R;
    await tx.update(idempotencyRecords).set({ response: result as object }).where(where(s));
    return result;
  });
}
