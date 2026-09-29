import { describe, expect, it } from 'vitest';
import { describeQuantity, normalizePackage, normalizeUnit, quantityFromReceiptLine } from '../src';

describe('normalizeUnit', () => {
  it('maps receipt and fixture spellings', () => {
    expect(normalizeUnit('US_gal')).toBe('gal');
    expect(normalizeUnit('oz_mass')).toBe('oz');
    expect(normalizeUnit('LBS')).toBe('lb');
    expect(normalizeUnit('ct')).toBe('count');
    expect(normalizeUnit('package')).toBeUndefined();
    expect(normalizeUnit(undefined)).toBeUndefined();
  });
});

describe('quantityFromReceiptLine', () => {
  const pkg = (p: { count?: number; size?: number; unit?: string }) => normalizePackage(p);

  it('treats a multipack as containers, not packs (GRK YOGURT 2X32 OZ)', () => {
    expect(quantityFromReceiptLine({ quantity: 1, unit: 'multipack' }, pkg({ count: 2, size: 32, unit: 'oz_mass' }))).toEqual({
      quantity: { kind: 'exact', amount: 2, unit: 'count' },
      package: { size: 32, unit: 'oz' },
    });
  });

  it('treats a 24-count carton as 24 eggs in one package (EGGS 24 CT)', () => {
    expect(quantityFromReceiptLine({ quantity: 1, unit: 'package' }, pkg({ size: 24, unit: 'count' }))).toEqual({
      quantity: { kind: 'exact', amount: 24, unit: 'count' },
      package: { count: 24 },
    });
  });

  it('keeps per-item package size for repeated items (4 × CHICKPEAS 15 OZ CAN)', () => {
    expect(quantityFromReceiptLine({ quantity: 4, unit: 'can' }, pkg({ size: 15, unit: 'oz_mass' }))).toEqual({
      quantity: { kind: 'exact', amount: 4, unit: 'count' },
      package: { size: 15, unit: 'oz' },
    });
  });

  it('uses weight for weighed produce (BANANAS 1.25 LB)', () => {
    expect(quantityFromReceiptLine({ quantity: 1.25, unit: 'lb' }, null)).toEqual({
      quantity: { kind: 'exact', amount: 1.25, unit: 'lb' },
      package: null,
    });
  });

  it('defaults to one item', () => {
    expect(quantityFromReceiptLine({}, null)).toEqual({ quantity: { kind: 'exact', amount: 1, unit: 'count' }, package: null });
  });
});

describe('describeQuantity', () => {
  it('renders packages, weights, approximations and unknowns', () => {
    expect(describeQuantity({ kind: 'exact', amount: 2, unit: 'count' }, { size: 32, unit: 'oz' })).toBe('2 × 32 oz');
    expect(describeQuantity({ kind: 'exact', amount: 24, unit: 'count' }, { count: 24 })).toBe('24 count');
    expect(describeQuantity({ kind: 'exact', amount: 1.25, unit: 'lb' }, null)).toBe('1.25 lb');
    expect(describeQuantity({ kind: 'approx', amount: 0.5, unit: 'gal' }, null)).toBe('~0.5 gal');
    expect(describeQuantity({ kind: 'unknown' }, null)).toBe('unknown amount');
  });
});
