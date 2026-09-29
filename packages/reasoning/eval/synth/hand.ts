// Hand-written hard cases (test split only). These are written directly rather than rendered from
// templates, so they measure generalization beyond the generator's patterns: real-world
// abbreviations, look-alikes that differ by one attribute, and lines that should never match.

import type { EvalCase, ExpectedLine } from './types.ts';

type Cand = EvalCase['candidates'][string][number];
const cand = (food_id: string, name: string, category: string, aliases: string[] = [], perishability: Cand['perishability'] = 'perishable'): Cand => ({
  food_id, name, aliases, category, perishability,
});

interface HandLine {
  raw: string;
  price?: number;
  line_kind?: ExpectedLine['line_kind'];
  names?: string[];
  categories?: string[];
  pkg?: { count?: number; size: number; unit: string } | 'weight' | null;
  match?: string[];
  candidates?: Cand[];
  note: string;
}

// A household's catalog, reused as candidates.
const H = {
  wholeMilk: cand('h_whole_milk', 'whole milk', 'dairy', ['KS WHOLE MILK 1 GAL']),
  milk2: cand('h_milk_2', '2% milk', 'dairy'),
  eggs: cand('h_eggs', 'eggs', 'eggs', ['KS ORG EGGS 24CT']),
  chickenBreast: cand('h_chk_breast', 'chicken breast', 'poultry', ['KS BNLS SKNLS BREAST']),
  chickenThighs: cand('h_chk_thigh', 'chicken thighs', 'poultry'),
  groundBeef: cand('h_gr_beef', 'ground beef', 'ground_meat'),
  spinach: cand('h_spinach', 'baby spinach', 'leafy_greens'),
  springMix: cand('h_spring', 'spring mix', 'leafy_greens'),
  greekYogurt: cand('h_gk_yog', 'greek yogurt', 'dairy'),
  cheddar: cand('h_cheddar', 'shredded cheddar', 'cheese'),
  pasta: cand('h_penne', 'penne', 'grains_pasta', [], 'shelf_stable'),
  marinara: cand('h_marinara', 'marinara sauce', 'sauces', [], 'shelf_stable'),
  bananas: cand('h_bananas', 'bananas', 'fruit'),
  pb: cand('h_pb', 'peanut butter', 'condiments', [], 'shelf_stable'),
  butter: cand('h_butter', 'butter', 'dairy'),
  oj: cand('h_oj', 'orange juice', 'beverages'),
  coffee: cand('h_coffee', 'coffee', 'beverages', [], 'shelf_stable'),
  tortillas: cand('h_tortillas', 'flour tortillas', 'bread'),
  rice: cand('h_rice', 'jasmine rice', 'grains_pasta', [], 'shelf_stable'),
};

const RECEIPTS: { id: string; store: string; lines: HandLine[] }[] = [
  {
    id: 'hand-warehouse',
    store: 'warehouse',
    lines: [
      { raw: 'E 1234567 KS ORG EGGS 24CT', names: ['eggs', 'organic eggs'], categories: ['eggs'], pkg: { size: 24, unit: 'ct' }, match: ['h_eggs'], candidates: [H.eggs, H.chickenBreast], note: 'item-number prefix; learned alias differs only by the prefix' },
      { raw: '512515 KS 2% RDCD FAT MLK 2PK', names: ['2% milk', 'reduced fat milk'], categories: ['dairy'], pkg: null, match: ['new'], candidates: [H.wholeMilk], note: 'must not match whole milk' },
      { raw: 'KS ROTISSERIE CHKN', names: ['rotisserie chicken'], categories: ['poultry', 'leftovers'], pkg: null, match: ['new'], candidates: [H.chickenBreast, H.chickenThighs], note: 'cooked chicken is not raw breast' },
      { raw: 'CHKN THGH BNLS 6.09LB', names: ['chicken thighs', 'boneless chicken thighs'], categories: ['poultry'], pkg: { size: 6.09, unit: 'lb' }, match: ['h_chk_thigh'], candidates: [H.chickenBreast, H.chickenThighs], note: 'weight fused to unit' },
      { raw: 'KS SPRNG MX 1LB', names: ['spring mix', 'salad mix', 'mixed greens'], categories: ['leafy_greens'], pkg: { size: 1, unit: 'lb' }, match: ['h_spring'], candidates: [H.spinach, H.springMix], note: 'heavy abbreviation' },
      { raw: 'KS GRK YGRT NF 2X48OZ', names: ['greek yogurt', 'nonfat greek yogurt'], categories: ['dairy'], pkg: { count: 2, size: 48, unit: 'oz' }, match: ['h_gk_yog'], candidates: [H.greekYogurt], note: 'multipack, compact size' },
      { raw: 'KS PB CRMY 2/40OZ', names: ['peanut butter', 'creamy peanut butter'], categories: ['condiments', 'dry_goods', 'snacks'], pkg: { count: 2, size: 40, unit: 'oz' }, match: ['h_pb'], candidates: [H.pb, H.butter], note: 'PB abbreviation; "2/40OZ" multipack; must not match butter' },
      { raw: 'KS FINE MEX BLEND SHRD 2.5#', names: ['mexican blend cheese', 'shredded mexican blend', 'mexican cheese blend'], categories: ['cheese'], pkg: { size: 2.5, unit: 'lb' }, match: ['new'], candidates: [H.cheddar], note: '# means pounds; different cheese from cheddar' },
      { raw: '/ 1234567 KS ORG EGGS 2.00-', line_kind: 'coupon', names: ['eggs', 'organic eggs'], note: 'warehouse instant-savings line' },
      { raw: 'KS 2PLY TOWEL 12CT', line_kind: 'non_food', names: ['paper towels'], categories: ['non_food'], note: 'non-food with a count' },
      { raw: 'CA CRV 24', line_kind: 'non_food', names: ['bottle deposit', 'crv', 'deposit'], categories: ['non_food'], note: 'deposit fee' },
    ],
  },
  {
    id: 'hand-supermarket',
    store: 'supermarket',
    lines: [
      { raw: 'GV WHL MLK GAL', names: ['whole milk'], categories: ['dairy'], pkg: { size: 1, unit: 'gal' }, match: ['h_whole_milk'], candidates: [H.wholeMilk, H.milk2], note: 'GAL without a number' },
      { raw: 'GV 2PCT MILK HG', names: ['2% milk', 'reduced fat milk'], categories: ['dairy'], pkg: { size: 0.5, unit: 'gal' }, match: ['h_milk_2'], candidates: [H.wholeMilk, H.milk2], note: 'HG = half gallon' },
      { raw: 'GRND BF 73/27 FAM PK', names: ['ground beef'], categories: ['ground_meat', 'meat'], pkg: null, match: ['h_gr_beef'], candidates: [H.groundBeef, H.chickenBreast], note: 'fat ratio; family pack has no size' },
      { raw: 'FF CHKN BRST TENDERS', names: ['chicken breast tenders', 'chicken tenders', 'chicken breast'], categories: ['poultry'], pkg: null, match: ['h_chk_breast', 'new'], candidates: [H.chickenBreast, H.chickenThighs], note: 'tenders are breast meat; either answer is acceptable' },
      { raw: 'MARINARA TRADER 25 OZ', names: ['marinara sauce', 'pasta sauce', 'marinara'], categories: ['sauces'], pkg: { size: 25, unit: 'oz' }, match: ['h_marinara'], candidates: [H.marinara, H.pasta], note: 'brand word after the product' },
      { raw: 'BNNS', pkg: null, names: ['bananas', 'banana'], categories: ['fruit'], match: ['h_bananas'], candidates: [H.bananas], note: 'vowel-stripped' },
      { raw: '@ 2 FOR 5.00', line_kind: 'coupon', names: [], note: 'multi-buy price line with no product; treat as a discount' },
      { raw: 'SIG SELECT OJ CALCIUM 52Z', names: ['orange juice'], categories: ['beverages'], pkg: { size: 52, unit: 'fl_oz' }, match: ['h_oj'], candidates: [H.oj], note: 'Z = oz' },
      { raw: 'TORT FLR BURRITO 10CT', names: ['flour tortillas', 'tortillas', 'burrito tortillas'], categories: ['bread'], pkg: { size: 10, unit: 'ct' }, match: ['h_tortillas'], candidates: [H.tortillas], note: 'word order scrambled' },
      { raw: 'BAKERY MISC', names: [], categories: ['bread', 'other'], pkg: null, match: ['new'], candidates: [H.tortillas], note: 'uninformative line must not match' },
      { raw: 'RTN GV WHL MLK GAL', line_kind: 'return', names: ['whole milk'], categories: ['dairy'], match: ['h_whole_milk'], candidates: [H.wholeMilk], note: 'return should still identify the food' },
      { raw: 'CLOROX WIPES 3PK', line_kind: 'non_food', names: ['disinfecting wipes', 'wipes', 'cleaning wipes', 'clorox wipes'], categories: ['non_food'], note: 'brand-only non-food' },
    ],
  },
  {
    id: 'hand-natural',
    store: 'natural',
    lines: [
      { raw: '365 OG BBY SPIN 5OZ', names: ['baby spinach', 'spinach'], categories: ['leafy_greens'], pkg: { size: 5, unit: 'oz' }, match: ['h_spinach'], candidates: [H.spinach, H.springMix], note: 'OG = organic' },
      { raw: 'OG CILNTRO', names: ['cilantro'], categories: ['herbs'], pkg: null, match: ['new'], note: 'no candidates' },
      { raw: 'PLU 4011 BANANAS', pkg: null, names: ['bananas', 'banana'], categories: ['fruit'], match: ['h_bananas'], candidates: [H.bananas], note: 'PLU code prefix' },
      { raw: '365 WW PENNE RIGATE 16OZ', names: ['penne', 'whole wheat penne', 'penne pasta'], categories: ['grains_pasta'], pkg: { size: 16, unit: 'oz' }, match: ['h_penne'], candidates: [H.pasta, H.marinara], note: 'WW = whole wheat' },
      { raw: 'KOMBUCHA GINGER 16FLOZ', names: ['kombucha'], categories: ['beverages'], pkg: { size: 16, unit: 'fl_oz' }, match: ['new'], candidates: [H.oj], note: 'fused FLOZ' },
      { raw: 'JASMINE RICE BULK 2.13 LB', names: ['jasmine rice', 'rice'], categories: ['grains_pasta'], pkg: { size: 2.13, unit: 'lb' }, match: ['h_rice'], candidates: [H.rice], note: 'bulk bin by weight' },
      { raw: 'COFFEE WB FRENCH RST 12OZ', names: ['coffee', 'whole bean coffee', 'french roast coffee'], categories: ['beverages', 'dry_goods'], pkg: { size: 12, unit: 'oz' }, match: ['h_coffee'], candidates: [H.coffee], note: 'WB = whole bean' },
      { raw: 'OAT MILK BARISTA 32OZ', names: ['oat milk'], categories: ['dairy', 'beverages'], pkg: { size: 32, unit: 'oz' }, match: ['new'], candidates: [H.wholeMilk, H.milk2], note: 'plant milk must not match dairy milk' },
      { raw: 'BAG REFUND 0.10', line_kind: 'coupon', names: [], note: 'bag credit is a discount, not a return of food' },
      { raw: 'VEGAN BUTTER STICKS 16OZ', names: ['vegan butter', 'plant butter', 'plant-based butter'], categories: ['dairy', 'condiments'], pkg: { size: 16, unit: 'oz' }, match: ['new'], candidates: [H.butter], note: 'vegan butter is a different food from butter' },
    ],
  },
  {
    id: 'hand-typed',
    store: 'typed',
    lines: [
      { raw: 'got a dozen eggs', names: ['eggs'], categories: ['eggs'], pkg: { size: 12, unit: 'ct' }, match: ['h_eggs'], candidates: [H.eggs], note: 'free text from a person' },
      { raw: '2 lbs chicken thighs', names: ['chicken thighs'], categories: ['poultry'], pkg: { size: 2, unit: 'lb' }, match: ['h_chk_thigh'], candidates: [H.chickenBreast, H.chickenThighs], note: 'lowercase free text' },
      { raw: 'the big bag of spinach', names: ['spinach', 'baby spinach'], categories: ['leafy_greens'], pkg: null, match: ['h_spinach'], candidates: [H.spinach, H.springMix], note: 'vague size must not be invented' },
      { raw: 'leftover chili', names: ['chili', 'leftover chili'], categories: ['leftovers'], pkg: null, match: ['new'], candidates: [H.groundBeef], note: 'prepared food, not its ingredient' },
      { raw: 'some sourdough from the farmers market', names: ['sourdough bread', 'sourdough'], categories: ['bread'], pkg: null, match: ['new'], note: 'store detail should not appear in the name' },
      { raw: 'half gallon of 2% milk', names: ['2% milk', 'reduced fat milk'], categories: ['dairy'], pkg: { size: 0.5, unit: 'gal' }, match: ['h_milk_2'], candidates: [H.wholeMilk, H.milk2], note: 'written-out size' },
    ],
  },
];

export const HAND_CASES: EvalCase[] = RECEIPTS.map((r) => {
  const c: EvalCase = { case_id: r.id, store: r.store, lines: [], candidates: {}, expected: {} };
  r.lines.forEach((l, i) => {
    const line_id = `${r.id}-${i}`;
    const line_kind = l.line_kind ?? 'item';
    c.lines.push({ line_id, raw_text: l.raw, ...(l.price ? { price_cents: l.price } : {}) });
    if (l.candidates?.length) c.candidates[line_id] = l.candidates;
    c.expected[line_id] = {
      kind: line_kind === 'item' ? 'food' : line_kind,
      line_kind,
      names: l.names ?? [],
      categories: l.categories ?? [],
      package:
        l.pkg === undefined || l.pkg === null
          ? null
          : l.pkg === 'weight'
            ? { accept: [], allowAbsent: true }
            : { accept: [l.pkg], allowAbsent: false },
      match: l.match ?? (line_kind === 'non_food' ? ['new'] : []),
      scenario: !l.candidates?.length ? 'empty' : l.match?.includes('new') ? 'lookalike' : 'hit',
      store: r.store,
      note: l.note,
    };
  });
  return c;
});
