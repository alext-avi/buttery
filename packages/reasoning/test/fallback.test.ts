import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CanonicalizeOutputSchema,
  createFallbackProvider,
  createReasoningProvider,
  DEFAULT_MODEL,
  DEFAULT_MODELS,
  FOOD_CATEGORIES,
  FOOD_STATES,
  ParseActivityOutputSchema,
  RankRecipesOutputSchema,
  SHELF_LIFE_DEFAULTS,
  ShelfLifeOutputSchema,
} from '../src/index.ts';

afterEach(() => vi.unstubAllEnvs());

describe('fallback provider', () => {
  const provider = createFallbackProvider();

  it('canonicalize: exact alias → high, trigram above threshold → medium, below → new/low', async () => {
    const result = await provider.canonicalizeItems({
      lines: [
        { line_id: 'a', raw_text: 'KS ORG EGGS 24CT' },
        { line_id: 'b', raw_text: 'GRK YOGURT 2X32 OZ' },
        { line_id: 'c', raw_text: 'STRAWBERRIES 2 LB' },
      ],
      candidates: {
        a: [{ food_id: 'f_eggs', name: 'eggs', aliases: ['KS ORG EGGS 24CT'], category: 'eggs', perishability: 'perishable' }],
        b: [{ food_id: 'f_yog', name: 'greek yogurt plain', aliases: [], category: 'dairy', perishability: 'perishable' }],
        c: [{ food_id: 'f_milk', name: 'whole milk', aliases: [], category: 'dairy', perishability: 'perishable' }],
      },
    });

    expect(result.path).toBe('fallback');
    expect(result.call).toMatchObject({ provider: 'fallback', model: null, valid: true, error: null });
    const [a, b, c] = result.output.lines;
    expect(a!.match).toEqual({ food_id: 'f_eggs', confidence: 'high' });
    expect(b!.match).toEqual({ food_id: 'f_yog', confidence: 'medium' });
    expect(b!.package).toEqual({ count: 2, size: 32, unit: 'oz' });
    expect(c).toMatchObject({ canonical_name: 'strawberries', category: 'berries', match: { food_id: 'new', confidence: 'low' } });
    expect(CanonicalizeOutputSchema.parse(result.output)).toEqual(result.output);
  });

  it('canonicalize: classifies coupons, returns and non-food lines', async () => {
    const result = await provider.canonicalizeItems({
      lines: [
        { line_id: '1', raw_text: 'SPINACH COUPON' },
        { line_id: '2', raw_text: 'RETURN: MILK 1/2 GAL' },
        { line_id: '3', raw_text: 'PAPER TOWELS 2 ROLL' },
        { line_id: '4', raw_text: 'CHICKPEAS 15 OZ CAN' },
      ],
      candidates: {},
    });
    expect(result.output.lines.map((l) => [l.line_kind, l.canonical_name, l.category])).toEqual([
      ['coupon', 'spinach', 'leafy_greens'],
      ['return', 'milk', 'dairy'],
      ['non_food', 'paper towels', 'non_food'],
      ['item', 'canned chickpeas', 'canned_goods'],
    ]);
    expect(result.output.lines[1]!.package).toEqual({ size: 0.5, unit: 'gal' });
  });

  it('shelf life: uses the defaults table', async () => {
    const result = await provider.estimateShelfLife({ food_name: 'chicken thighs', states: ['sealed', 'frozen'] });
    expect(result.output.per_state).toEqual({
      sealed: { days: SHELF_LIFE_DEFAULTS.poultry.states.sealed.days, confidence: 'low' },
      frozen: { days: SHELF_LIFE_DEFAULTS.poultry.states.frozen.days, confidence: 'low' },
    });
    expect(ShelfLifeOutputSchema.parse(result.output)).toEqual(result.output);
  });

  it('parse: no activities, one "couldn\'t parse" ambiguity, low confidence', async () => {
    const result = await provider.parseActivity({ text: 'froze the chicken', now: '2026-09-29', context: {} });
    expect(result.output).toEqual({
      activities: [],
      ambiguities: [{ text: 'froze the chicken', reason: "couldn't parse", candidate_lot_ids: [] }],
      confidence: 'low',
    });
    expect(ParseActivityOutputSchema.parse(result.output)).toEqual(result.output);
  });

  it('rank: input order, empty explanations, no ideas', async () => {
    const candidate = (recipe_id: string) => ({ recipe_id, title: recipe_id, score: 0, coverage_summary: '' });
    const result = await provider.rankRecipes({ candidates: [candidate('b'), candidate('a')], include_ideas: true });
    expect(result.output).toEqual({ ranked: [{ recipe_id: 'b', explanation: '' }, { recipe_id: 'a', explanation: '' }], ideas: [] });
    expect(RankRecipesOutputSchema.parse(result.output)).toEqual(result.output);
  });
});

describe('configuration', () => {
  it('REASONING_PROVIDER=fallback wins even with a key set', async () => {
    vi.stubEnv('REASONING_PROVIDER', 'fallback');
    vi.stubEnv('CRUSOE_API_KEY', 'cr_test');
    const result = await createReasoningProvider().estimateShelfLife({ food_name: 'eggs', states: ['sealed'] });
    expect(result.call.provider).toBe('fallback');
  });

  it('defaults to fallback without a key, and to crusoe with one', async () => {
    vi.stubEnv('REASONING_PROVIDER', '');
    vi.stubEnv('CRUSOE_API_KEY', '');
    const result = await createReasoningProvider().estimateShelfLife({ food_name: 'eggs', states: ['sealed'] });
    expect(result.call.provider).toBe('fallback');

    const seen: string[] = [];
    const fetchSpy = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${JSON.parse(String(init.body)).model}`);
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    vi.stubEnv('CRUSOE_API_KEY', 'cr_test');
    vi.stubEnv('CRUSOE_BASE_URL', 'https://example.test/v1');
    vi.stubEnv('REASONING_MODEL', 'default/model');
    vi.stubEnv('REASONING_MODEL_SHELF_LIFE', 'fast/model');
    const crusoe = createReasoningProvider({ fetch: fetchSpy });
    const r = await crusoe.estimateShelfLife({ food_name: 'eggs', states: ['sealed'] });
    await crusoe.parseActivity({ text: 'x', now: 'y', context: {} });
    expect(r.call).toMatchObject({ provider: 'crusoe', model: 'fast/model' });
    expect(seen).toEqual(['https://example.test/v1/chat/completions fast/model', 'https://example.test/v1/chat/completions default/model']);
  });

  it('uses built-in per-function defaults when no model is configured', async () => {
    vi.stubEnv('REASONING_MODEL', '');
    vi.stubEnv('REASONING_MODEL_PARSE', '');
    vi.stubEnv('REASONING_MODEL_SHELF_LIFE', '');
    const offline = (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    const provider = createReasoningProvider({ provider: 'crusoe', apiKey: 'cr_test', fetch: offline });
    expect((await provider.parseActivity({ text: 'x', now: 'y', context: {} })).call.model).toBe(DEFAULT_MODELS.parseActivity);
    expect((await provider.estimateShelfLife({ food_name: 'eggs', states: ['sealed'] })).call.model).toBe(DEFAULT_MODEL);
  });

  it('rejects an unknown REASONING_PROVIDER', () => {
    vi.stubEnv('REASONING_PROVIDER', 'openai');
    expect(() => createReasoningProvider()).toThrow(/REASONING_PROVIDER/);
  });
});

describe('SHELF_LIFE_DEFAULTS', () => {
  it('covers about twenty categories, every state, with defaults inside their bounds', () => {
    expect(FOOD_CATEGORIES.length).toBeGreaterThanOrEqual(20);
    for (const category of FOOD_CATEGORIES) {
      for (const state of FOOD_STATES) {
        const { days, max } = SHELF_LIFE_DEFAULTS[category].states[state];
        if (max !== null) {
          expect(days, `${category}.${state}`).not.toBeNull();
          expect(days!, `${category}.${state}`).toBeLessThanOrEqual(max);
        }
      }
    }
  });
});

describe('unit standards (text helpers)', async () => {
  const { parsePackage, toBaseQuantity, standardizeCanonicalName } = await import('../src/text.ts');

  it.each([
    ['KS FINE MEX BLEND SHRD 2.5#', { size: 2.5, unit: 'lb' }],
    ['SIG SELECT OJ 52Z', { size: 52, unit: 'oz' }],
    ['GV 2PCT MILK HG', { size: 0.5, unit: 'gal' }],
    ['EGGS 5 DZ', { size: 60, unit: 'ct' }],
    ['KS PB CRMY 2/40OZ', { count: 2, size: 40, unit: 'oz' }],
    ['RETURN: MILK 1/2 GAL', { size: 0.5, unit: 'gal' }],
    ['16 PK DR PEPPER 12 FL OZ', { count: 16, size: 12, unit: 'fl_oz' }],
    ['KOMBUCHA GINGER 16FLOZ', { size: 16, unit: 'fl_oz' }],
    ['GR BEEF 85/15 2.25LB', { size: 2.25, unit: 'lb' }],
    ['got a dozen eggs', { size: 12, unit: 'ct' }],
    ['12 ZUCCHINI', undefined],
    ['BAG 0.10', undefined],
  ])('parsePackage(%j)', (raw, expected) => {
    expect(parsePackage(raw)).toEqual(expected);
  });

  it('converts packages to base quantities so different printings compare', () => {
    expect(toBaseQuantity({ count: 2, size: 32, unit: 'oz' })).toEqual({ amount: 1814.37, unit: 'g' });
    expect(toBaseQuantity({ size: 0.5, unit: 'gal' })!.amount).toBeCloseTo(toBaseQuantity({ size: 64, unit: 'fl_oz' })!.amount, -1);
    expect(toBaseQuantity({ size: 24, unit: 'ct' })).toEqual({ amount: 24, unit: 'ct' });
  });

  it('standardizes names and keeps variety words', () => {
    expect(standardizeCanonicalName('Organic 2% Milk')).toBe('2% milk');
    expect(standardizeCanonicalName('KS brown rice 25 LB')).toBe('brown rice');
  });
});

describe('explicit line-kind markers', async () => {
  const { explicitLineKind } = await import('../src/text.ts');
  it.each([
    ['INST SAV CORN 4CT', 'coupon'],
    ['MFR CPN KS EGGS', 'coupon'],
    ['SPINACH COUPON', 'coupon'],
    ['/ 1234567 KS ORG EGGS 2.00-', 'coupon'],
    ['/ RED SDLS GRAPES 2.00 OFF', 'coupon'],
    ['RETURN: MILK 1/2 GAL', 'return'],
    ['RTN GV WHL MLK GAL', 'return'],
    ['BAG REFUND 0.10', undefined],
    ['CORN ON COB', undefined],
  ])('%s → %s', (raw, kind) => {
    expect(explicitLineKind(raw)).toBe(kind);
  });
});
