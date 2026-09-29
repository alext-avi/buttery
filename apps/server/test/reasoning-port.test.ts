import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { reasoningCalls } from '../src/db/schema';
import { createInterimReasoning } from '../src/reasoning/interim';
import { persistReasoningCall } from '../src/reasoning/record';
import { resetDb, testDb } from './helpers/db';
import { seedUser } from './helpers/app';

describe('interim reasoning', () => {
  const r = createInterimReasoning();

  it('classifies coupons and returns and never invents a food id', async () => {
    const out = await r.canonicalizeItems({
      lines: [
        { line_id: 'L1', raw_text: 'SPINACH COUPON' },
        { line_id: 'L2', raw_text: 'RETURN: MILK 1/2 GAL' },
        { line_id: 'L3', raw_text: 'BABY SPINACH 5 OZ' },
      ],
      candidates: { L3: [{ food_id: 'f1', name: 'Baby spinach', aliases: [], category: 'produce', perishability: 'perishable' }] },
    });
    expect(out.path).toBe('fallback');
    expect(out.output.lines.map((l) => l.line_kind)).toEqual(['coupon', 'return', 'item']);
    expect(out.output.lines[2]?.match).toEqual({ food_id: 'f1', confidence: 'medium' });
  });

  it('cleans a raw line into a readable new-food name', async () => {
    const out = await r.canonicalizeItems({ lines: [{ line_id: 'L1', raw_text: 'CHERRY TOMATOES 10 OZ' }], candidates: {} });
    expect(out.output.lines[0]).toMatchObject({ canonical_name: 'Cherry tomatoes', match: { food_id: 'new', confidence: 'low' } });
  });

  it('returns no shelf-life estimate rather than guessing', async () => {
    const out = await r.estimateShelfLife({ food_name: 'Milk', states: ['sealed', 'opened'] });
    expect(out.output.per_state.sealed).toEqual({ days: null, confidence: 'low' });
  });
});

describe('persistReasoningCall', () => {
  beforeEach(() => resetDb());
  it('stores the call record with path and violations', async () => {
    const db = testDb();
    const { principal } = await seedUser(db);
    const result = await createInterimReasoning().estimateShelfLife({ food_name: 'Milk', states: ['sealed'] });
    const id = crypto.randomUUID();
    await db.transaction((tx) => persistReasoningCall(tx, principal.householdId, id, result));
    const [row] = await db.select().from(reasoningCalls).where(eq(reasoningCalls.id, id));
    expect(row).toMatchObject({ function: 'estimateShelfLife', provider: 'fallback', path: 'fallback', valid: true });
  });
});
