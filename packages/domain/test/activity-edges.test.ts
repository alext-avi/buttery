import { describe, expect, it } from 'vitest';
import { applyActivity, consumeQuantity, pickLot, type LotFacts, type ShelfLifeMap } from '../src';

const perishable: ShelfLifeMap = {
  sealed: { days: 5, confidence: 'medium', source: 'default_rule' },
  opened: { days: 3, confidence: 'medium', source: 'default_rule' },
  frozen: { days: 180, confidence: 'medium', source: 'default_rule' },
  thawed: { days: 2, confidence: 'low', source: 'default_rule' },
};
const food = { perishability: 'perishable' as const, shelfLife: perishable };
const lot = (over: Partial<LotFacts> = {}): LotFacts => ({
  state: 'sealed', location: 'fridge', quantity: { kind: 'exact', amount: 1, unit: 'count' }, package: null,
  status: 'active', acquiredOn: '2026-09-28', openedOn: null, frozenOn: null, thawedOn: null, printedExpiryOn: null, ...over,
});
const TODAY = '2026-09-29';

describe('consumeQuantity edge cases', () => {
  it('using more than is on hand uses it up', () => {
    expect(consumeQuantity({ kind: 'exact', amount: 1, unit: 'lb' }, null, { quantity: { kind: 'exact', amount: 3, unit: 'lb' } })).toMatchObject({ exhausted: true, quantity: { amount: 0 } });
    expect(consumeQuantity({ kind: 'exact', amount: 2, unit: 'count' }, null, { quantity: { kind: 'exact', amount: 5, unit: 'count' } })).toMatchObject({ exhausted: true, quantity: { amount: 0 } });
  });
  it('an approximate lot stays approximate', () => {
    expect(consumeQuantity({ kind: 'approx', amount: 2, unit: 'lb' }, null, { quantity: { kind: 'exact', amount: 0.5, unit: 'lb' } }).quantity).toEqual({ kind: 'approx', amount: 1.5, unit: 'lb' });
  });
  it('using exactly one container of a multipack by weight stays exact', () => {
    expect(consumeQuantity({ kind: 'exact', amount: 2, unit: 'count' }, { size: 32, unit: 'oz' }, { quantity: { kind: 'exact', amount: 32, unit: 'oz' } }).quantity).toEqual({ kind: 'exact', amount: 1, unit: 'count' });
  });
  it('subtracts volumes in the lot’s own unit, converting the used unit', () => {
    expect(consumeQuantity({ kind: 'exact', amount: 1, unit: 'l' }, null, { quantity: { kind: 'exact', amount: 250, unit: 'ml' } }).quantity).toEqual({ kind: 'exact', amount: 0.75, unit: 'l' });
  });
  it('a count without a package size cannot be compared with a weight', () => {
    expect(consumeQuantity({ kind: 'exact', amount: 3, unit: 'count' }, null, { quantity: { kind: 'exact', amount: 100, unit: 'g' } })).toMatchObject({ exhausted: false, quantity: { kind: 'unknown' } });
  });
  it('an unknown amount stays unknown and is never marked used up by a partial use', () => {
    expect(consumeQuantity({ kind: 'unknown' }, null, { fraction: 0.5 })).toMatchObject({ exhausted: false, quantity: { kind: 'unknown' } });
  });
});

describe('applyActivity edge cases', () => {
  it('opening an item with a printed date switches to the opened estimate', () => {
    const r = applyActivity(lot({ printedExpiryOn: '2026-10-20' }), { kind: 'opened' }, food, TODAY);
    expect(r.lot.expires).toMatchObject({ on: '2026-10-02', kind: 'estimated' });
  });
  it('opening a shelf-stable jar starts a clock', () => {
    const sauce = { perishability: 'shelf_stable' as const, shelfLife: { opened: { days: 5, confidence: 'medium' as const, source: 'default_rule' as const } } };
    expect(applyActivity(lot(), { kind: 'opened' }, sauce, TODAY).lot.expires).toMatchObject({ on: '2026-10-04' });
  });
  it('using part of an item keeps its expiry', () => {
    const before = applyActivity(lot(), { kind: 'moved', toLocation: 'fridge' }, food, TODAY).lot.expires;
    expect(applyActivity(lot(), { kind: 'used', amount: { fraction: 0.25 } }, food, TODAY).lot.expires).toEqual(before);
  });
  it('refuses to thaw something that is not frozen', () => {
    expect(applyActivity(lot(), { kind: 'thawed' }, food, TODAY).refused).toContain("isn't frozen");
  });
  it('refuses to re-freeze something already frozen (that would reset its clock)', () => {
    expect(applyActivity(lot({ state: 'frozen', frozenOn: '2026-09-01', location: 'freezer' }), { kind: 'froze' }, food, TODAY).refused).toContain('already frozen');
  });
  it('refuses to open something already opened (that would reset its clock)', () => {
    expect(applyActivity(lot({ state: 'opened', openedOn: '2026-09-27' }), { kind: 'opened' }, food, TODAY).refused).toContain('already opened');
  });
  it('refuses a move with no destination, or to where it already is', () => {
    expect(applyActivity(lot(), { kind: 'moved' }, food, TODAY).refused).toContain('Where');
    expect(applyActivity(lot(), { kind: 'moved', toLocation: 'fridge' }, food, TODAY).refused).toContain('already in the fridge');
  });
  it('accepts valid transitions without a refusal', () => {
    expect(applyActivity(lot(), { kind: 'froze' }, food, TODAY).refused).toBeNull();
    expect(applyActivity(lot({ state: 'frozen', frozenOn: '2026-09-01', location: 'freezer' }), { kind: 'thawed' }, food, TODAY).refused).toBeNull();
  });
});

describe('pickLot edge cases', () => {
  it('puts items with no dates last and is stable for ties', () => {
    const lots = [
      { id: 'a', expires: null, acquiredOn: null },
      { id: 'b', expires: { on: '2026-10-01' }, acquiredOn: null },
      { id: 'c', expires: { on: '2026-10-01' }, acquiredOn: '2026-09-30' },
    ];
    expect(pickLot(lots)?.id).toBe('c');
    expect(pickLot([{ id: 'x', expires: null, acquiredOn: null }])?.id).toBe('x');
  });
});
