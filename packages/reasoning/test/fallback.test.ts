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
