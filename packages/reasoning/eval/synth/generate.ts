// Deterministic synthetic receipts for the canonicalizeItems eval.
//   node eval/synth/generate.ts        → writes eval/data/synth-{dev,test}.json
// No model is involved: every label comes from the catalog, so it is correct by construction.

import { writeFileSync, mkdirSync } from 'node:fs';
import { FOODS, FOOD_BY_KEY, NON_FOOD, type CatalogFood, type PackageSpec } from './catalog.ts';
import { HAND_CASES } from './hand.ts';
import type { EvalCase, EvalDataset, ExpectedLine, Scenario } from './types.ts';

// --- deterministic RNG ---
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
const chance = (rng: Rng, p: number) => rng() < p;
function sample<T>(rng: Rng, xs: readonly T[], n: number): T[] {
  const copy = [...xs];
  const out: T[] = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]!);
  return out;
}

// --- store styles ---
interface Store {
  kind: string;
  prefixes: string[];
  compactSizes: number; // probability of "16OZ" instead of "16 OZ"
  truncate: number; // max raw length, 0 = none
}

const STORES: Store[] = [
  { kind: 'warehouse', prefixes: ['KS ', 'KS ', ''], compactSizes: 0.1, truncate: 0 },
  { kind: 'supermarket', prefixes: ['GV ', 'SIG ', 'KRO ', ''], compactSizes: 0.4, truncate: 0 },
  { kind: 'natural', prefixes: ['365 ', '365 ORG ', 'ORG ', ''], compactSizes: 0.2, truncate: 0 },
  { kind: 'corner', prefixes: [''], compactSizes: 0.5, truncate: 22 },
];

function variantsFor(food: { variants: string[] }, split: 'dev' | 'test'): string[] {
  return food.variants.filter((_, i) => (split === 'dev' ? i % 2 === 0 : i % 2 === 1));
}

/** Mild scanning noise that keeps digits intact: O→0 inside a word, or a dropped vowel. */
function addNoise(rng: Rng, text: string): string {
  const words = text.split(' ');
  const i = Math.floor(rng() * words.length);
  const w = words[i]!;
  if (/\d/.test(w) || w.length < 5) return text;
  if (chance(rng, 0.5) && w.includes('O')) words[i] = w.replace('O', '0');
  else words[i] = w.replace(/[AEIOU](?=[A-Z])/, '');
  return words.join(' ');
}

function renderSize(rng: Rng, store: Store, pkg: PackageSpec): string {
  return chance(rng, store.compactSizes) ? pkg.text.replace(/^(\d+(?:\.\d+)?(?:\/\d+)?) (OZ|LB|CT|GAL|QT|PT|L|ML)$/, '$1$2') : pkg.text;
}

interface RenderedFood {
  raw: string;
  pkg: PackageSpec | null;
  weightLb?: number;
}

function renderFood(rng: Rng, store: Store, food: CatalogFood, split: 'dev' | 'test', allowNoise = true): RenderedFood {
  const variant = pick(rng, variantsFor(food, split));
  const hasSlot = variant.includes('{S}');
  const pkg = hasSlot && food.packages.length ? pick(rng, food.packages) : null;
  let body = variant.replace('{S}', pkg ? renderSize(rng, store, pkg) : '').replace(/\s+/g, ' ').trim();
  let weightLb: number | undefined;
  if (food.byWeight && !pkg && chance(rng, 0.6)) {
    weightLb = Math.round((0.4 + rng() * 3) * 100) / 100;
    const perLb = (0.5 + rng() * 3).toFixed(2);
    body = `${body} ${weightLb} LB @ ${perLb}/LB`;
  }
  const prefix = food.category === 'fruit' || food.category === 'vegetables' || food.category === 'herbs' ? '' : pick(rng, store.prefixes);
  let raw = `${prefix}${body}`;
  if (allowNoise && chance(rng, 0.12)) raw = addNoise(rng, raw);
  if (store.truncate && !pkg && !weightLb && raw.length > store.truncate) raw = raw.slice(0, store.truncate).trim();
  return { raw, pkg, ...(weightLb ? { weightLb } : {}) };
}

function foodExpected(food: CatalogFood, r: RenderedFood): Pick<ExpectedLine, 'names' | 'categories' | 'package'> {
  return {
    names: [food.name, ...(food.accept ?? [])],
    categories: [food.category, ...(food.acceptCategories ?? [])],
    package: r.pkg
      ? { accept: [{ ...(r.pkg.count ? { count: r.pkg.count } : {}), size: r.pkg.size, unit: r.pkg.unit }], allowAbsent: false }
      : r.weightLb
        ? { accept: [{ size: r.weightLb, unit: 'lb' }], allowAbsent: true }
        : null,
  };
}

// --- households and candidates ---
interface HouseholdFood {
  food_id: string;
  key: string;
  name: string;
  aliases: string[];
}

function candidateFor(rng: Rng, key: string, id: string, aliases: string[] = []) {
  const food = FOOD_BY_KEY.get(key)!;
  const name = chance(rng, 0.7) ? food.name : pick(rng, [food.name, ...(food.accept ?? [])]);
  return { food_id: id, name, aliases, category: food.category, perishability: perishabilityOf(food) } as const;
}

function perishabilityOf(food: CatalogFood): 'shelf_stable' | 'perishable' {
  return ['grains_pasta', 'canned_goods', 'sauces', 'condiments', 'dry_goods', 'snacks', 'beverages'].includes(food.category) &&
    !['orange_juice', 'pesto', 'salsa', 'hummus'].includes(food.key)
    ? 'shelf_stable'
    : 'perishable';
}

function chooseScenario(rng: Rng, food: CatalogFood): Scenario {
  const r = rng();
  if (r < 0.4) return 'hit';
  if (r < 0.5) return 'alias';
  if (r < 0.72) return food.lookalikes?.length ? 'lookalike' : 'unrelated';
  if (r < 0.9) return 'unrelated';
  return 'empty';
}

function buildCandidates(rng: Rng, scenario: Scenario, food: CatalogFood, raw: string, lineIdx: number, caseId: string) {
  const id = (key: string) => `${caseId}_f_${key}`;
  const others = FOODS.filter((f) => f.key !== food.key && !(food.lookalikes ?? []).includes(f.key) && !(food.sameAs ?? []).includes(f.key));
  const distractors = (n: number) => sample(rng, others, n).map((f) => candidateFor(rng, f.key, id(f.key)));
  const lookalikes = (n: number) =>
    sample(rng, food.lookalikes ?? [], n).map((k) => candidateFor(rng, k, id(k)));
  void lineIdx;
  switch (scenario) {
    case 'hit': {
      const list = [candidateFor(rng, food.key, id(food.key)), ...lookalikes(1 + Math.floor(rng() * 2)), ...distractors(1)];
      return { list: sample(rng, list, list.length), accept: [id(food.key)] };
    }
    case 'alias': {
      const list = [candidateFor(rng, food.key, id(food.key), [raw]), ...distractors(2)];
      return { list: sample(rng, list, list.length), accept: [id(food.key)] };
    }
    case 'lookalike':
      return { list: [...lookalikes(1 + Math.floor(rng() * 2)), ...distractors(1)], accept: ['new'] };
    case 'unrelated':
      return { list: distractors(1 + Math.floor(rng() * 3)), accept: ['new'] };
    case 'empty':
      return { list: [], accept: ['new'] };
  }
}

// --- cases ---
function buildCase(rng: Rng, split: 'dev' | 'test', n: number): EvalCase {
  const store = pick(rng, STORES);
  const caseId = `${split}-${String(n).padStart(3, '0')}`;
  const lines: EvalCase['lines'] = [];
  const candidates: EvalCase['candidates'] = {};
  const expected: EvalCase['expected'] = {};
  const size = 6 + Math.floor(rng() * 10);
  const foods = sample(rng, FOODS, size);

  foods.forEach((food, i) => {
    const line_id = `${caseId}-${i}`;
    const r = renderFood(rng, store, food, split);
    const scenario = chooseScenario(rng, food);
    const c = buildCandidates(rng, scenario, food, r.raw, i, caseId);
    const price = Math.round((1 + rng() * 15) * 100);
    lines.push({ line_id, raw_text: r.raw, ...(chance(rng, 0.5) ? { price_cents: price } : {}) });
    if (c.list.length) candidates[line_id] = c.list;
    expected[line_id] = { kind: 'food', food_key: food.key, line_kind: 'item', ...foodExpected(food, r), match: c.accept, scenario, store: store.kind };
  });

  // Coupons referencing a food on the receipt, generic savings, returns and non-food lines.
  let extra = foods.length;
  const add = (line: EvalCase['lines'][number], exp: ExpectedLine, cands?: EvalCase['candidates'][string]) => {
    lines.push(line);
    expected[line.line_id] = exp;
    if (cands?.length) candidates[line.line_id] = cands;
  };
  if (chance(rng, 0.5)) {
    const target = pick(rng, foods);
    const base = pick(rng, variantsFor(target, split)).replace('{S}', '').replace(/\s+/g, ' ').trim();
    const raw = pick(rng, [`${base} COUPON`, `MFR CPN ${base}`, `INST SAV ${base}`, `/ ${base} 2.00 OFF`]);
    add({ line_id: `${caseId}-${extra++}`, raw_text: raw, price_cents: -Math.round((0.5 + rng() * 3) * 100) },
      { kind: 'coupon', food_key: target.key, line_kind: 'coupon', names: [target.name, ...(target.accept ?? [])], categories: [], package: null, match: [], scenario: 'empty', store: store.kind });
  }
  if (chance(rng, 0.25)) {
    add({ line_id: `${caseId}-${extra++}`, raw_text: pick(rng, ['INSTANT SAVINGS', 'LOYALTY SAVINGS', 'MEMBER DISCOUNT', 'SAVINGS TOTAL']), price_cents: -Math.round(rng() * 500) - 50 },
      { kind: 'coupon', line_kind: 'coupon', names: [], categories: [], package: null, match: [], scenario: 'empty', store: store.kind });
  }
  if (chance(rng, 0.35)) {
    const food = pick(rng, FOODS);
    const r = renderFood(rng, store, food, split, false);
    const raw = `${pick(rng, ['RETURN: ', 'RTN ', 'REFUND ', 'RETURN '])}${r.raw}`;
    const hit = chance(rng, 0.6);
    const id = `${caseId}_f_${food.key}`;
    add({ line_id: `${caseId}-${extra++}`, raw_text: raw, price_cents: -Math.round((1 + rng() * 10) * 100) },
      { kind: 'return', food_key: food.key, line_kind: 'return', ...foodExpected(food, r), match: hit ? [id] : ['new'], scenario: hit ? 'hit' : 'empty', store: store.kind },
      hit ? [candidateFor(rng, food.key, id)] : undefined);
  }
  const nonFoodCount = chance(rng, 0.6) ? 1 + Math.floor(rng() * 2) : 0;
  for (const item of sample(rng, NON_FOOD, nonFoodCount)) {
    const raw = `${pick(rng, store.prefixes)}${pick(rng, variantsFor(item, split))}`;
    add({ line_id: `${caseId}-${extra++}`, raw_text: raw, price_cents: Math.round((2 + rng() * 20) * 100) },
      { kind: 'non_food', line_kind: 'non_food', names: [item.name, ...(item.accept ?? [])], categories: ['non_food'], package: null, match: ['new'], scenario: 'empty', store: store.kind });
  }

  // Shuffle line order so kinds are interleaved like a real receipt.
  const order = sample(rng, lines.map((_, i) => i), lines.length);
  return { case_id: caseId, store: store.kind, lines: order.map((i) => lines[i]!), candidates, expected };
}

function dataset(split: 'dev' | 'test', seed: number, count: number): EvalDataset {
  const rng = mulberry32(seed);
  const cases = Array.from({ length: count }, (_, i) => buildCase(rng, split, i));
  if (split === 'test') cases.push(...HAND_CASES);
  return { version: 1, split, seed, generator: 'eval/synth/generate.ts', cases };
}

const outDir = new URL('../data/', import.meta.url);
mkdirSync(outDir, { recursive: true });
for (const [split, seed, count] of [['dev', 1, 40], ['test', 2, 28]] as const) {
  const data = dataset(split, seed, count);
  writeFileSync(new URL(`synth-${split}.json`, outDir), JSON.stringify(data, null, 1) + '\n');
  const lines = data.cases.reduce((n, c) => n + c.lines.length, 0);
  const kinds: Record<string, number> = {};
  const scen: Record<string, number> = {};
  for (const c of data.cases) for (const e of Object.values(c.expected)) {
    kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    if (e.kind === 'food') scen[e.scenario] = (scen[e.scenario] ?? 0) + 1;
  }
  console.log(`${split}: ${data.cases.length} receipts, ${lines} lines`, kinds, 'food scenarios', scen);
}
