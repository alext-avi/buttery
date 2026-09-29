import { beforeEach, describe, expect, it } from 'vitest';
import { findIdempotent, runIdempotent } from '../src/services/idempotency';
import { resetDb, testDb } from './helpers/db';
import { seedUser } from './helpers/app';

describe('idempotency', () => {
  beforeEach(() => resetDb());
  const db = testDb();

  it('runs work once and replays the stored response', async () => {
    const { principal } = await seedUser(db);
    let runs = 0;
    const scope = { householdId: principal.householdId, tool: 't', key: 'key-00001', request: { a: 1 } };
    const work = async () => ({ n: ++runs, at: new Date('2026-09-29T00:00:00Z') });
    const first = await runIdempotent(db, scope, work);
    const second = await runIdempotent(db, scope, work);
    expect(runs).toBe(1);
    expect(second).toEqual(first);
    expect(first.at).toBe('2026-09-29T00:00:00.000Z'); // normalized to JSON on first return too
    expect(await findIdempotent(db, scope)).toEqual(first);
  });

  it('rejects reuse of a key for a different request', async () => {
    const { principal } = await seedUser(db);
    const scope = { householdId: principal.householdId, tool: 't', key: 'key-00002', request: { a: 1 } };
    await runIdempotent(db, scope, async () => ({ ok: true }));
    await expect(runIdempotent(db, { ...scope, request: { a: 2 } }, async () => ({ ok: true }))).rejects.toMatchObject({ code: 'idempotency_key_reused' });
  });

  it('executes once under concurrent retries with the same key', async () => {
    const { principal } = await seedUser(db);
    let runs = 0;
    const scope = { householdId: principal.householdId, tool: 't', key: 'key-00003', request: {} };
    const work = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 150));
      return { runs };
    };
    const [a, b] = await Promise.all([runIdempotent(db, scope, work), runIdempotent(db, scope, work)]);
    expect(runs).toBe(1);
    expect(a).toEqual(b);
  });

  it('does not store a response when work throws', async () => {
    const { principal } = await seedUser(db);
    const scope = { householdId: principal.householdId, tool: 't', key: 'key-00004', request: {} };
    await expect(runIdempotent(db, scope, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await runIdempotent(db, scope, async () => ({ ok: true }))).toEqual({ ok: true });
  });
});
