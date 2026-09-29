import { z } from 'zod';

export const UNITS = ['count', 'g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'fl_oz', 'cup', 'pt', 'qt', 'gal'] as const;
export const UnitSchema = z.enum(UNITS);
export type Unit = z.infer<typeof UnitSchema>;

export const QuantitySchema = z.object({
  kind: z.enum(['exact', 'approx', 'unknown']),
  amount: z.number().nonnegative().optional(),
  unit: UnitSchema.optional(),
});
export type Quantity = z.infer<typeof QuantitySchema>;

export const PackageSchema = z.object({
  count: z.number().positive().optional(),
  size: z.number().positive().optional(),
  unit: UnitSchema.optional(),
});
export type Package = z.infer<typeof PackageSchema>;

export const PackageInputSchema = z
  .object({
    count: z.number().positive().optional().describe('Items per pack, e.g. 2 for "2X32 OZ", 24 for "24 CT"'),
    size: z.number().positive().optional().describe('Size of each item, e.g. 32 for "2X32 OZ"'),
    unit: z.string().max(20).optional().describe('Unit of size, e.g. "oz", "lb", "gal", "count"'),
  })
  .describe('Package details printed on the line');

const UNIT_ALIASES: Record<string, Unit> = {
  count: 'count', ct: 'count', ea: 'count', each: 'count', pc: 'count', pcs: 'count',
  g: 'g', gram: 'g', grams: 'g', kg: 'kg',
  oz: 'oz', oz_mass: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  ml: 'ml', l: 'l', liter: 'l', litre: 'l',
  fl_oz: 'fl_oz', 'fl oz': 'fl_oz', floz: 'fl_oz',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp', tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  cup: 'cup', cups: 'cup', pt: 'pt', pint: 'pt', pints: 'pt', qt: 'qt', quart: 'qt',
  gal: 'gal', gallon: 'gal', us_gal: 'gal',
};

export function normalizeUnit(raw: string | undefined | null): Unit | undefined {
  if (!raw) return undefined;
  return UNIT_ALIASES[raw.trim().toLowerCase().replace(/\.$/, '')];
}

export function normalizePackage(input: { count?: number; size?: number; unit?: string } | undefined | null): Package | null {
  if (!input) return null;
  const unit = normalizeUnit(input.unit);
  const pkg: Package = {};
  if (input.count) pkg.count = input.count;
  if (input.size && unit) {
    pkg.size = input.size;
    pkg.unit = unit;
  }
  if (pkg.unit === 'count' && pkg.size && !pkg.count) return { count: pkg.size };
  return Object.keys(pkg).length ? pkg : null;
}

export function quantityFromReceiptLine(
  line: { quantity?: number; unit?: string },
  pkg: Package | null,
): { quantity: Quantity; package: Package | null } {
  const qty = line.quantity ?? 1;
  const lineUnit = normalizeUnit(line.unit);
  if (lineUnit && lineUnit !== 'count') return { quantity: { kind: 'exact', amount: qty, unit: lineUnit }, package: null };
  if (pkg?.count && pkg.size && pkg.unit) {
    return { quantity: { kind: 'exact', amount: qty * pkg.count, unit: 'count' }, package: { size: pkg.size, unit: pkg.unit } };
  }
  if (pkg?.count) return { quantity: { kind: 'exact', amount: qty * pkg.count, unit: 'count' }, package: { count: pkg.count } };
  if (pkg?.size && pkg.unit) {
    return { quantity: { kind: 'exact', amount: qty, unit: 'count' }, package: { size: pkg.size, unit: pkg.unit } };
  }
  return { quantity: { kind: 'exact', amount: qty, unit: 'count' }, package: null };
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

export function describeQuantity(q: Quantity, pkg: Package | null | undefined): string {
  if (q.kind === 'unknown' || q.amount === undefined) return 'unknown amount';
  const prefix = q.kind === 'approx' ? '~' : '';
  if (!q.unit || q.unit === 'count') {
    if (pkg?.size && pkg.unit) return `${prefix}${fmt(q.amount)} × ${fmt(pkg.size)} ${pkg.unit}`;
    return `${prefix}${fmt(q.amount)}${pkg?.count ? ' count' : ''}`;
  }
  return `${prefix}${fmt(q.amount)} ${q.unit}`;
}
