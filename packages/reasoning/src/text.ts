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

const UNIT_ALIASES: Record<string, string> = {
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  'fl oz': 'fl_oz', floz: 'fl_oz', fl_oz: 'fl_oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  g: 'g', gram: 'g', grams: 'g',
  kg: 'kg',
  ml: 'ml',
  l: 'l', liter: 'l', litre: 'l',
  gal: 'gal', gallon: 'gal', gallons: 'gal',
  qt: 'qt', quart: 'qt',
  pt: 'pt', pint: 'pt',
  ct: 'ct', count: 'ct', pk: 'ct', pack: 'ct', each: 'ct', ea: 'ct', roll: 'ct', rolls: 'ct',
};

const UNIT_PATTERN = '(fl\\s?oz|oz|ounces?|lbs?|pounds?|kg|g|ml|l|gal|gallons?|qt|pt|ct|count|pk|pack|rolls?)';
const NUMBER_PATTERN = '(\\d+\\/\\d+|\\d+(?:\\.\\d+)?)';

export function normalizeUnit(unit: string | undefined): string | undefined {
  if (!unit) return undefined;
  const key = unit.toLowerCase().replace(/\s+/g, ' ').trim();
  return UNIT_ALIASES[key] ?? UNIT_ALIASES[key.replace(/\.$/, '')] ?? key;
}

function parseNumber(text: string): number {
  if (text.includes('/')) {
    const [n, d] = text.split('/').map(Number);
    return n! / d!;
  }
  return Number(text);
}

export interface ParsedPackage {
  count?: number;
  size?: number;
  unit?: string;
}

/**
 * Keep only usable package fields: finite, positive numbers and a non-empty unit. Returns
 * undefined when there is no usable size or count (a bare unit says nothing), so a package
 * never fails the output schema.
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
  return out;
}

/** Parse "2X32 OZ", "1 GAL", "24 CT", "1/2 GAL" and similar into a package. */
export function parsePackage(raw: string): ParsedPackage | undefined {
  const multi = new RegExp(`\\b(\\d+)\\s*[xX]\\s*${NUMBER_PATTERN}\\s*${UNIT_PATTERN}\\b`, 'i').exec(raw);
  if (multi) {
    return sanitizePackage({ count: Number(multi[1]), size: parseNumber(multi[2]!), unit: normalizeUnit(multi[3]) });
  }
  const single = new RegExp(`\\b${NUMBER_PATTERN}\\s*${UNIT_PATTERN}\\b`, 'i').exec(raw);
  if (single) return sanitizePackage({ size: parseNumber(single[1]!), unit: normalizeUnit(single[2]) });
  return undefined;
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
