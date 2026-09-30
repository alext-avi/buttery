import { describe, expect, it } from 'vitest';
import { applyActivity, consumeQuantity, pickLot, type LotFacts, type ShelfLifeMap } from '../src';

const shelfLife: ShelfLifeMap = {
  sealed: { days: 5, confidence: 'medium', source: 'model_estimate', model: 'm' },
  opened: { days: 3, confidence: 'medium', source: 'default_rule' },
  frozen: { days: 180, confidence: 'medium', source: 'default_rule' },
  thawed: { days: 2, confidence: 'low', source: 'default_rule' },
};
const food = { perishability: 'perishable' as const, shelfLife };
const lot = (over: Partial<LotFacts> = {}): LotFacts => ({
  state: 'sealed', location: 'fridge', quantity: { kind: 'exact', amount: 1, unit: 'count' }, package: { size: 3, unit: 'lb' },
  status: 'active', acquiredOn: '2026-09-28', openedOn: null, frozenOn: null, thawedOn: null, printedExpiryOn: null, ...over,
});
const TODAY = '2026-09-29';

describe('applyActivity', () => {
  it('freezing moves the item to the freezer and re-estimates expiry from the freeze date', () => {
    const r = applyActivity(lot(), { kind: 'froze' }, food, TODAY);
    expect(r.lot).toMatchObject({ state: 'frozen', location: 'freezer', frozenOn: TODAY, status: 'active' });
    expect(r.lot.expires).toMatchObject({ on: '2027-03-28', kind: 'estimated', basis: 'frozen 2026-09-29 + 180d (default_rule, medium)' });
    expect(r.needsShelfLife).toBeNull();
  });

  it('asks for a shelf-life estimate when the food has none for the new state', () => {
    const r = applyActivity(lot(), { kind: 'froze' }, { ...food, shelfLife: { sealed: shelfLife.sealed! } }, TODAY);
    expect(r.needsShelfLife).toBe('frozen');
    expect(r.lot.expires).toBeNull();
  });

  it('thawing moves it to the fridge; opening and moving change state and place', () => {
    expect(applyActivity(lot({ state: 'frozen', location: 'freezer', frozenOn: '2026-09-01' }), { kind: 'thawed' }, food, TODAY).lot).toMatchObject({ state: 'thawed', location: 'fridge', thawedOn: TODAY, expires: { on: '2026-10-01' } });
    expect(applyActivity(lot(), { kind: 'opened' }, food, TODAY).lot).toMatchObject({ state: 'opened', openedOn: TODAY, expires: { on: '2026-10-02' } });
    expect(applyActivity(lot(), { kind: 'moved', toLocation: 'counter' }, food, TODAY).lot).toMatchObject({ location: 'counter', state: 'sealed' });
    expect(applyActivity(lot(), { kind: 'froze', toLocation: 'garage freezer' }, food, TODAY).lot.location).toBe('garage freezer');
  });

  it('finishing and discarding end the item', () => {
    expect(applyActivity(lot(), { kind: 'finished' }, food, TODAY).lot).toMatchObject({ status: 'depleted', quantity: { amount: 0 } });
    expect(applyActivity(lot(), { kind: 'discarded' }, food, TODAY).lot.status).toBe('discarded');
  });

  it('using everything uses it up', () => {
    expect(applyActivity(lot(), { kind: 'used', amount: { fraction: 1 } }, food, TODAY).lot.status).toBe('depleted');
  });

  it('using some without an amount keeps the item but marks the amount approximate', () => {
    const r = applyActivity(lot(), { kind: 'used' }, food, TODAY);
    expect(r.lot).toMatchObject({ status: 'active', quantity: { kind: 'approx', amount: 1 } });
    expect(r.notes.join(' ')).toContain('approximate');
  });
});

describe('consumeQuantity', () => {
  const gallon = { kind: 'exact' as const, amount: 1, unit: 'count' as const };
  it('takes a share of the item ("half the milk")', () => {
    expect(consumeQuantity(gallon, { size: 1, unit: 'gal' }, { fraction: 0.5 })).toMatchObject({ quantity: { kind: 'approx', amount: 0.5, unit: 'count' }, exhausted: false });
  });
  it('subtracts whole containers', () => {
    expect(consumeQuantity({ kind: 'exact', amount: 2, unit: 'count' }, { size: 32, unit: 'oz' }, { quantity: { kind: 'exact', amount: 1, unit: 'count' } }).quantity).toEqual({ kind: 'exact', amount: 1, unit: 'count' });
  });
  it('converts within a dimension and back to containers', () => {
    const r = consumeQuantity({ kind: 'exact', amount: 2, unit: 'count' }, { size: 32, unit: 'oz' }, { quantity: { kind: 'exact', amount: 8, unit: 'oz' } });
    expect(r.quantity).toEqual({ kind: 'approx', amount: 1.75, unit: 'count' });
    const milk = consumeQuantity(gallon, { size: 1, unit: 'gal' }, { quantity: { kind: 'exact', amount: 1, unit: 'cup' } });
    expect(milk.quantity.kind).toBe('approx');
    expect(milk.quantity.amount).toBeCloseTo(0.9375, 3);
  });
  it('subtracts weights directly', () => {
    expect(consumeQuantity({ kind: 'exact', amount: 1.25, unit: 'lb' }, null, { quantity: { kind: 'exact', amount: 0.5, unit: 'lb' } }).quantity).toEqual({ kind: 'exact', amount: 0.75, unit: 'lb' });
  });
  it('refuses to guess across dimensions', () => {
    const r = consumeQuantity(gallon, { size: 1, unit: 'gal' }, { quantity: { kind: 'exact', amount: 2, unit: 'lb' } });
    expect(r.quantity.kind).toBe('unknown');
    expect(r.note).toContain("couldn't compare");
  });
});

describe('pickLot', () => {
  it('prefers the lot expiring first, then the oldest', () => {
    const lots = [
      { id: 'late', expires: { on: '2026-10-09' }, acquiredOn: '2026-09-01' },
      { id: 'none', expires: null, acquiredOn: '2026-08-01' },
      { id: 'soon-new', expires: { on: '2026-10-01' }, acquiredOn: '2026-09-28' },
      { id: 'soon-old', expires: { on: '2026-10-01' }, acquiredOn: '2026-09-20' },
    ];
    expect(pickLot(lots)?.id).toBe('soon-old');
    expect(pickLot([])).toBeUndefined();
  });
});
