import { describe, expect, it } from 'vitest';
import { applyActivity, consumeQuantity, normalizeUnit, type LotFacts, type ShelfLifeMap } from '../src';

const shelfLife: ShelfLifeMap = {
  sealed: { days: 5, confidence: 'medium', source: 'default_rule' },
  opened: { days: 3, confidence: 'medium', source: 'default_rule' },
  frozen: { days: 180, confidence: 'medium', source: 'default_rule' },
};
const food = { perishability: 'perishable' as const, shelfLife };
const lot = (over: Partial<LotFacts> = {}): LotFacts => ({
  state: 'sealed', location: 'fridge', quantity: { kind: 'exact', amount: 1, unit: 'count' }, package: null,
  status: 'active', acquiredOn: '2026-09-28', openedOn: null, frozenOn: null, thawedOn: null, printedExpiryOn: null, ...over,
});

describe('review fixes: transitions', () => {
  it('refuses to open something frozen (thaw it first)', () => {
    expect(applyActivity(lot({ state: 'frozen', frozenOn: '2026-09-01', location: 'freezer' }), { kind: 'opened' }, food, '2026-09-29').refused).toContain('thaw it first');
  });
  it('refuses to freeze something already past its date', () => {
    expect(applyActivity(lot({ acquiredOn: '2026-09-01' }), { kind: 'froze' }, food, '2026-09-29').refused).toContain('past its');
  });
  it('refuses any change to an item that is no longer active', () => {
    expect(applyActivity(lot({ status: 'depleted' }), { kind: 'discarded' }, food, '2026-09-29').refused).toContain('used up');
    expect(applyActivity(lot({ status: 'discarded' }), { kind: 'used', amount: { fraction: 0.5 } }, food, '2026-09-29').refused).toContain('thrown away');
  });
  it('says so when more was used than was recorded', () => {
    const r = applyActivity(lot({ quantity: { kind: 'exact', amount: 1, unit: 'lb' } }), { kind: 'used', amount: { quantity: { kind: 'exact', amount: 2, unit: 'lb' } } }, food, '2026-09-29');
    expect(r.lot.status).toBe('depleted');
    expect(r.notes.join(' ')).toContain('more than');
  });
});

describe('review fixes: units', () => {
  it('knows tablespoons and teaspoons', () => {
    expect(normalizeUnit('tbsp')).toBe('tbsp');
    expect(normalizeUnit('Tablespoons')).toBe('tbsp');
    expect(normalizeUnit('tsp')).toBe('tsp');
  });
  it('subtracts a spoonful from a jug, and refuses to compare spoons with pounds', () => {
    const milk = consumeQuantity({ kind: 'exact', amount: 1, unit: 'count' }, { size: 1, unit: 'gal' }, { quantity: { kind: 'exact', amount: 2, unit: 'tbsp' } });
    expect(milk.exhausted).toBe(false);
    expect(milk.quantity.amount).toBeCloseTo(0.992, 3);
    const butter = consumeQuantity({ kind: 'exact', amount: 1, unit: 'lb' }, null, { quantity: { kind: 'exact', amount: 2, unit: 'tbsp' } });
    expect(butter).toMatchObject({ exhausted: false, quantity: { kind: 'unknown' } });
  });
});
