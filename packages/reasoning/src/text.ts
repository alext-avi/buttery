// Deterministic text helpers shared by the fallbacks and guardrails.

import { FOOD_CATEGORIES, SHELF_LIFE_DEFAULTS, type FoodCategory } from './shelfLifeDefaults.ts';

const ABBREVIATIONS: Record<string, string> = {
  chkn: 'chicken',
  chk: 'chicken',
  brst: 'breast',
  bnls: 'boneless',
  sknls: 'skinless',
  thgh: 'thighs',
  grk: 'greek',
  yog: 'yogurt',
  ygrt: 'yogurt',
  whl: 'whole',
  grnd: 'ground',
  bf: 'beef',
  mlk: 'milk',
  chz: 'cheese',
  strwb: 'strawberries',
  tom: 'tomatoes',
  toms: 'tomatoes',
  veg: 'vegetables',
  org: 'organic',
  oj: 'orange juice',
  pb: 'peanut butter',
};

/** Store-brand and noise tokens dropped from canonical names. */
const DROP_TOKENS = new Set(['ks', 'kirkland', 'signature', 'gv', 'great', 'value', 'organic', 'return', 'coupon', 'disc', 'discount']);

/**
 * The unit vocabulary for `package.unit`. Every package the module returns uses one of these;
 * `toBaseQuantity` converts any of them to grams, millilitres or a count.
 */
export const PACKAGE_UNITS = ['g', 'kg', 'oz', 'lb', 'ml', 'l', 'fl_oz', 'gal', 'qt', 'pt', 'ct'] as const;
export type PackageUnit = (typeof PACKAGE_UNITS)[number];

const UNIT_ALIASES: Record<string, PackageUnit> = {
  oz: 'oz', ounce: 'oz', ounces: 'oz', z: 'oz',
  'fl oz': 'fl_oz', floz: 'fl_oz', fl_oz: 'fl_oz', 'fl. oz': 'fl_oz', 'fluid ounce': 'fl_oz', 'fluid ounces': 'fl_oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb', '#': 'lb',
  g: 'g', gram: 'g', grams: 'g', gr: 'g',
  kg: 'kg', kilogram: 'kg', kilograms: 'kg',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l', ltr: 'l',
  gal: 'gal', gallon: 'gal', gallons: 'gal',
  qt: 'qt', quart: 'qt', quarts: 'qt',
  pt: 'pt', pint: 'pt', pints: 'pt',
  ct: 'ct', count: 'ct', pk: 'ct', pack: 'ct', each: 'ct', ea: 'ct', roll: 'ct', rolls: 'ct', pc: 'ct', pcs: 'ct',
};

const UNIT_PATTERN = '(fl\\.?\\s?oz|oz|ounces?|lbs?|pounds?|kg|g|ml|l|gal|gallons?|qt|pt|ct|count|pk|pack|rolls?)';
const NUMBER_PATTERN = '(\\d+\\/\\d+|\\d+(?:\\.\\d+)?)';

/** Map any unit spelling to the vocabulary, or undefined if it isn't a known unit. */
export function normalizeUnit(unit: string | undefined): PackageUnit | undefined {
  if (!unit) return undefined;
  const key = unit.toLowerCase().replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  return UNIT_ALIASES[key] ?? UNIT_ALIASES[key.replace(/\s/g, '')];
}

/** Receipt fractions are small: 1/2, 3/4, 2/3. Anything else with a slash ("2/40OZ") is count/size. */
function isFraction(n: number, d: number): boolean {
  return [2, 3, 4, 8].includes(d) && n > 0 && n < d;
}

function parseNumber(text: string): number {
  if (text.includes('/')) {
    const [n, d] = text.split('/').map(Number);
    return n! / d!;
  }
  return Number(text);
}

/**
 * Rewrite receipt size conventions into plain "<number> <unit>" text:
 * "2.5#" → "2.5 LB", "52Z" → "52 OZ", "HG"/"half gallon" → "1/2 GAL", "5 DZ" → "60 CT",
 * "a dozen" → "12 CT", "16FLOZ" → "16 FL OZ", "2/40OZ" → "2X40 OZ".
 */
export function standardizeSizeText(raw: string): string {
  return raw
    .replace(/(\d+(?:\.\d+)?)\s*#/g, '$1 LB')
    .replace(/(\d+(?:\.\d+)?)Z\b/gi, '$1 OZ')
    .replace(/(\d+(?:\.\d+)?)\s*FL\.?\s*OZ\b/gi, '$1 FL OZ')
    .replace(/\b(?:HG|HLF GAL|HALF GAL(?:LON)?|half a gallon|half gallon)\b/gi, '1/2 GAL')
    .replace(/\b(\d+(?:\.\d+)?)\s*(?:DZ|DOZ|DOZEN)\b/gi, (_, n: string) => `${Number(n) * 12} CT`)
    .replace(/\b(?:a|one)\s+dozen\b/gi, '12 CT')
    .replace(/\bhalf\s+(?:a\s+)?dozen\b/gi, '6 CT')
    .replace(/\b(\d+)\/(\d+(?:\.\d+)?)\s*(OZ|LB|CT|FL OZ|ML|L|G)\b/gi, (m, a: string, b: string, u: string) =>
      isFraction(Number(a), Number(b)) ? m : `${a}X${b} ${u}`,
    );
}

export interface ParsedPackage {
  count?: number;
  size?: number;
  unit?: PackageUnit;
}

/**
 * Keep only usable package fields: finite, positive numbers and a unit from the vocabulary.
 * Returns undefined when there is no usable size or count (a bare unit says nothing), so a
 * package never fails the output schema.
 */
export function sanitizePackage(pkg: { count?: unknown; size?: unknown; unit?: unknown } | undefined): ParsedPackage | undefined {
  if (!pkg) return undefined;
  const out: ParsedPackage = {};
  const usable = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (usable(pkg.count)) out.count = pkg.count;
  if (usable(pkg.size)) out.size = pkg.size;
  const unit = typeof pkg.unit === 'string' ? normalizeUnit(pkg.unit) : undefined;
  if (out.count === undefined && out.size === undefined) return undefined;
  if (unit) out.unit = unit;
  // "dozen" as a unit: 2 dozen → 24 ct.
  if (typeof pkg.unit === 'string' && /^(dz|doz|dozen)$/i.test(pkg.unit.trim()) && out.size !== undefined) {
    out.size *= 12;
    out.unit = 'ct';
  }
  // A single package: count 1 carries no information.
  if (out.count === 1 && out.size !== undefined) delete out.count;
  return out;
}

/**
 * Parse the printed size on a line: "2X32 OZ", "1 GAL", "24 CT", "1/2 GAL", "2.5#", "52Z", "5 DZ",
 * "2/40OZ", "12 PK ... 12 FL OZ". Returns undefined when no size is printed.
 */
export function parsePackage(raw: string): ParsedPackage | undefined {
  const text = standardizeSizeText(raw);
  const multi = new RegExp(`\\b(\\d+)\\s*[xX]\\s*${NUMBER_PATTERN}\\s*${UNIT_PATTERN}(?![a-z])`, 'i').exec(text);
  if (multi) {
    return sanitizePackage({ count: Number(multi[1]), size: parseNumber(multi[2]!), unit: normalizeUnit(multi[3]) });
  }
  const sizes = [...text.matchAll(new RegExp(`\\b${NUMBER_PATTERN}\\s*${UNIT_PATTERN}(?![a-z])`, 'gi'))].map((m) => ({
    size: parseNumber(m[1]!),
    unit: normalizeUnit(m[2]),
  }));
  if (sizes.length === 0) return undefined;
  // "12 PK DR PEPPER 12 FL OZ": a pack count plus a per-item size is a multipack.
  const count = sizes.find((s) => s.unit === 'ct');
  const measure = sizes.find((s) => s.unit !== 'ct');
  if (count && measure && Number.isInteger(count.size)) return sanitizePackage({ count: count.size, ...measure });
  return sanitizePackage(measure ?? sizes[0]);
}

const TO_BASE: Record<PackageUnit, { unit: 'g' | 'ml' | 'ct'; factor: number }> = {
  g: { unit: 'g', factor: 1 },
  kg: { unit: 'g', factor: 1000 },
  oz: { unit: 'g', factor: 28.3495 },
  lb: { unit: 'g', factor: 453.592 },
  ml: { unit: 'ml', factor: 1 },
  l: { unit: 'ml', factor: 1000 },
  fl_oz: { unit: 'ml', factor: 29.5735 },
  gal: { unit: 'ml', factor: 3785.41 },
  qt: { unit: 'ml', factor: 946.353 },
  pt: { unit: 'ml', factor: 473.176 },
  ct: { unit: 'ct', factor: 1 },
};

/**
 * Total amount in a base unit (grams, millilitres or count), e.g. 2X32 OZ → 1814 g. Lets the
 * domain compare "64 FL OZ" with "1/2 GAL". Returns undefined without a size and unit.
 */
export function toBaseQuantity(pkg: ParsedPackage | undefined): { amount: number; unit: 'g' | 'ml' | 'ct' } | undefined {
  if (!pkg?.unit || pkg.size === undefined) return undefined;
  const base = TO_BASE[pkg.unit];
  return { amount: Math.round((pkg.count ?? 1) * pkg.size * base.factor * 100) / 100, unit: base.unit };
}

/** True when two packages describe the same total quantity (1% tolerance). */
export function samePackage(a: ParsedPackage | undefined, b: ParsedPackage | undefined): boolean {
  const x = toBaseQuantity(a);
  const y = toBaseQuantity(b);
  if (!x || !y) return !a === !b && JSON.stringify(a) === JSON.stringify(b);
  return x.unit === y.unit && Math.abs(x.amount - y.amount) <= Math.max(0.5, y.amount * 0.01) && (a?.count ?? 1) === (b?.count ?? 1);
}

const NAME_NOISE = new Set(['organic', 'org', 'og', 'ks', 'kirkland', 'gv', 'sig', 'signature', 'kro', 'kroger', '365', 'tj', 'fresh']);

/**
 * The standard form for canonical names: lowercase, single-spaced, no brand or "organic" tokens,
 * no printed sizes or fat ratios. Variety words stay ("2% milk", "brown rice"). Applied to model
 * output so the same food is always spelled the same way.
 */
export function standardizeCanonicalName(name: string): string {
  const cleaned = standardizeSizeText(name)
    .toLowerCase()
    .replace(new RegExp(`\\b\\d+\\s*x\\s*${NUMBER_PATTERN}\\s*${UNIT_PATTERN}(?![a-z])`, 'gi'), ' ')
    .replace(new RegExp(`\\b${NUMBER_PATTERN}\\s*${UNIT_PATTERN}(?![a-z])`, 'gi'), ' ')
    .replace(/\b\d{2}\/\d{1,2}\b/g, ' ') // fat ratios: 80/20, 93/7
    .replace(/[^a-z0-9%&'\- ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !NAME_NOISE.has(t))
    .join(' ')
    .trim();
  return cleaned || name.trim().toLowerCase();
}

/** Lowercase, expand receipt abbreviations, remove sizes, prices and punctuation. */
export function normalizeName(raw: string): string {
  const withoutSizes = raw
    .replace(new RegExp(`\\b\\d+\\s*[xX]\\s*${NUMBER_PATTERN}\\s*${UNIT_PATTERN}\\b`, 'gi'), ' ')
    .replace(new RegExp(`\\b${NUMBER_PATTERN}\\s*${UNIT_PATTERN}\\b`, 'gi'), ' ')
    .replace(/[-$]?\d+(\.\d+)?/g, ' ');
  const tokens = withoutSizes
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ABBREVIATIONS[t] ?? t)
    .join(' ')
    .split(' ')
    .filter((t) => t && !DROP_TOKENS.has(t));
  return tokens.join(' ');
}

/** Human-readable canonical name from a receipt line, e.g. "CHICKPEAS 15 OZ CAN" → "canned chickpeas". */
export function canonicalNameFromRaw(raw: string): string {
  const tokens = normalizeName(raw).split(' ').filter(Boolean);
  const canned = tokens.includes('can') || tokens.includes('cans');
  const rest = tokens.filter((t) => t !== 'can' && t !== 'cans');
  const name = rest.join(' ');
  if (!name) return raw.trim().toLowerCase() || 'unknown item';
  return canned && !name.startsWith('canned') ? `canned ${name}` : name;
}

export function classifyCategory(name: string): FoodCategory {
  const text = ` ${normalizeName(name)} `;
  let best: { category: FoodCategory; length: number } | undefined;
  for (const category of FOOD_CATEGORIES) {
    for (const keyword of SHELF_LIFE_DEFAULTS[category].keywords) {
      if (text.includes(` ${keyword} `) && (!best || keyword.length > best.length)) {
        best = { category, length: keyword.length };
      }
    }
  }
  return best?.category ?? 'other';
}

/**
 * Line kinds that receipts mark explicitly. These are standards, not guesses: when a marker is
 * present it overrides the model. Returns undefined when the text has no explicit marker.
 */
export function explicitLineKind(raw: string): 'coupon' | 'return' | undefined {
  const text = raw.trim().toUpperCase();
  if (/^(INST(ANT)?\s+SAV(INGS)?|MFR\s+CPN|CPN|COUPON|DIGITAL\s+CPN)\b/.test(text) || /\bCOUPON\b/.test(text)) return 'coupon';
  if (/^\/\s/.test(text) && /\b(OFF|\d+\.\d{2}-)/.test(text)) return 'coupon';
  if (/^(RETURN|RTN|REFUND)\b:?\s+\S/.test(text)) return 'return';
  return undefined;
}

export function detectLineKind(raw: string, priceCents?: number): 'item' | 'coupon' | 'return' | 'non_food' {
  const text = raw.toLowerCase();
  if (/\b(return|refund)\b/.test(text)) return 'return';
  if (/\b(coupon|disc|discount|savings|promo)\b/.test(text)) return 'coupon';
  if (priceCents !== undefined && priceCents < 0) return 'coupon';
  if (classifyCategory(raw) === 'non_food') return 'non_food';
  return 'item';
}

function trigrams(text: string): Set<string> {
  const padded = `  ${text} `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

/** Jaccard similarity of character trigrams (0..1), on normalized names. */
export function trigramSimilarity(a: string, b: string): number {
  const x = trigrams(normalizeName(a));
  const y = trigrams(normalizeName(b));
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared++;
  return shared / (x.size + y.size - shared);
}
