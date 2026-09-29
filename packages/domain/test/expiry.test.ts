import { describe, expect, it } from 'vitest';
import { addDays, computeEffectiveExpiry, daysBetween, describeExpiry, formatShortDate, todayIn, urgencyOf, type ShelfLifeMap } from '../src';

const perishable: ShelfLifeMap = {
  sealed: { days: 5, confidence: 'medium', source: 'model_estimate', model: 'crusoe:test' },
  opened: { days: 3, confidence: 'medium', source: 'default_rule' },
};

describe('dates', () => {
  it('does calendar math across month ends', () => {
    expect(addDays('2026-09-28', 5)).toBe('2026-10-03');
    expect(daysBetween('2026-09-28', '2026-10-03')).toBe(5);
  });
  it('computes today in a timezone', () => {
    expect(todayIn('America/New_York', new Date('2026-09-30T02:00:00Z'))).toBe('2026-09-29');
  });
  it('formats relative short dates', () => {
    expect(formatShortDate('2026-09-29', '2026-09-29')).toBe('today');
    expect(formatShortDate('2026-09-30', '2026-09-29')).toBe('tomorrow');
    expect(formatShortDate('2026-10-02', '2026-09-29')).toBe('Fri');
    expect(formatShortDate('2026-10-20', '2026-09-29')).toBe('Oct 20');
  });
});

describe('computeEffectiveExpiry', () => {
  it('estimates from the purchase date with a basis naming the source', () => {
    expect(
      computeEffectiveExpiry({ perishability: 'perishable', state: 'sealed', anchors: { sealed: '2026-09-28' }, shelfLife: perishable }),
    ).toEqual({
      on: '2026-10-03',
      kind: 'estimated',
      confidence: 'medium',
      basis: 'bought 2026-09-28 + 5d (model_estimate, crusoe:test, medium)',
    });
  });

  it('prefers a printed date while sealed', () => {
    expect(
      computeEffectiveExpiry({ perishability: 'perishable', state: 'sealed', anchors: { sealed: '2026-09-28' }, printedExpiryOn: '2026-10-10', shelfLife: perishable }),
    ).toEqual({ on: '2026-10-10', kind: 'printed', confidence: 'high', basis: 'printed on package' });
  });

  it('gives sealed shelf-stable food no expiry unless printed', () => {
    expect(
      computeEffectiveExpiry({ perishability: 'shelf_stable', state: 'sealed', anchors: { sealed: '2026-09-28' }, shelfLife: { sealed: { days: 730, confidence: 'medium', source: 'default_rule' } } }),
    ).toBeNull();
  });

  it('returns null when there is no estimate for the state', () => {
    expect(computeEffectiveExpiry({ perishability: 'perishable', state: 'sealed', anchors: { sealed: '2026-09-28' }, shelfLife: {} })).toBeNull();
  });
});

describe('urgency and description', () => {
  const exp = (on: string, kind: 'printed' | 'estimated' = 'estimated') => ({ on, kind, confidence: 'medium' as const, basis: 'x' });
  it('buckets by days remaining', () => {
    expect(urgencyOf(exp('2026-09-28'), '2026-09-29')).toBe('expired');
    expect(urgencyOf(exp('2026-10-01'), '2026-09-29')).toBe('urgent');
    expect(urgencyOf(exp('2026-10-06'), '2026-09-29')).toBe('soon');
    expect(urgencyOf(exp('2026-10-20'), '2026-09-29')).toBe('later');
    expect(urgencyOf(null, '2026-09-29')).toBeNull();
  });
  it('labels estimates and printed dates differently', () => {
    expect(describeExpiry(exp('2026-10-02'), '2026-09-29')).toBe('est. Fri · medium');
    expect(describeExpiry(exp('2026-10-02', 'printed'), '2026-09-29')).toBe('exp Fri');
    expect(describeExpiry(exp('2026-09-27'), '2026-09-29')).toBe('est. expired 2d ago · medium');
    expect(describeExpiry(null, '2026-09-29')).toBe('no expiry tracked');
  });
});
