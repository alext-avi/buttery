// Regression tests from the PR #1 review: odd inputs, cache failures, invented lot ids,
// privacy false positives and duplicate shelf-life states.
import { describe, expect, it } from 'vitest';
import {
  CanonicalizeOutputSchema,
  createFakeProvider,
  createFallbackProvider,
  createReasoningProvider,
  ParseActivityOutputSchema,
  ShelfLifeOutputSchema,
  type ReasoningCache,
} from '../src/index.ts';
import { redactDeep, redactText } from '../src/privacy.ts';
import { parsePackage } from '../src/text.ts';
import { json, mockFetch } from './helpers.ts';

const fallback = createFallbackProvider();

describe('hint.package accepts the server object shape and a string', () => {
  it('uses an object hint.package {count, size, unit}', async () => {
    const result = await fallback.canonicalizeItems({
      lines: [{ line_id: 'a', raw_text: 'GRK YOGURT', hint: { package: { count: 2, size: 32, unit: 'OZ' } } }],
      candidates: {},
    });
    expect(result.path).toBe('fallback');
    expect(result.output.lines[0]!.package).toEqual({ count: 2, size: 32, unit: 'oz' });
    expect(CanonicalizeOutputSchema.parse(result.output)).toEqual(result.output);
  });

  it('still accepts a string hint.package', async () => {
    const result = await fallback.canonicalizeItems({
      lines: [{ line_id: 'a', raw_text: 'GRK YOGURT', hint: { package: '2X32 OZ' } }],
      candidates: {},
    });
    expect(result.output.lines[0]!.package).toEqual({ count: 2, size: 32, unit: 'oz' });
  });

  it('drops unusable values in an object hint.package', async () => {
    const result = await fallback.canonicalizeItems({
      lines: [{ line_id: 'a', raw_text: 'GRK YOGURT', hint: { package: { count: 0, size: -1, unit: '' } } }],
      candidates: {},
    });
    expect(result.output.lines[0]!.package).toBeUndefined();
    expect(CanonicalizeOutputSchema.parse(result.output)).toEqual(result.output);
  });
});

describe('outputs are schema-valid for odd inputs on every path', () => {
  const oddLines = ['WATER 0 OZ', 'MILK 1/0 GAL', 'SODA 2X0 OZ', '', '   ', '$$$ 12.99'];

  it('parsePackage drops non-finite and non-positive values', () => {
    expect(parsePackage('WATER 0 OZ')).toBeUndefined();
    expect(parsePackage('MILK 1/0 GAL')).toBeUndefined();
    expect(parsePackage('SODA 2X0 OZ')).toEqual({ count: 2, unit: 'oz' });
    expect(parsePackage('MILK 1/2 GAL')).toEqual({ size: 0.5, unit: 'gal' });
  });

  it('fallback provider never throws on odd receipt text', async () => {
    for (const raw_text of oddLines) {
      const result = await fallback.canonicalizeItems({ lines: [{ line_id: 'a', raw_text }], candidates: {} });
      expect(CanonicalizeOutputSchema.safeParse(result.output).success, raw_text).toBe(true);
    }
  });

  it('falls back to schema-valid output after a model error', async () => {
    const provider = createFakeProvider({ canonicalizeItems: new Error('outage') });
    for (const raw_text of oddLines) {
      const result = await provider.canonicalizeItems({ lines: [{ line_id: 'a', raw_text }], candidates: {} });
      expect(result.path).toBe('fallback');
      expect(CanonicalizeOutputSchema.safeParse(result.output).success, raw_text).toBe(true);
    }
  });

  it('lines the model omits are filled with schema-valid fallback lines', async () => {
    const provider = createFakeProvider({ canonicalizeItems: { lines: [] } });
    const result = await provider.canonicalizeItems({ lines: [{ line_id: 'a', raw_text: 'WATER 0 OZ' }], candidates: {} });
    expect(CanonicalizeOutputSchema.safeParse(result.output).success).toBe(true);
    expect(result.output.lines[0]!.package).toBeUndefined();
  });
});

describe('cache failures are not fatal', () => {
  const life = { per_state: { opened: { days: 5, confidence: 'medium' as const } }, rationale: 'r' };
  const input = { food_name: 'milk', category: 'dairy', states: ['opened' as const] };

  it('a failing get is a miss', async () => {
    const cache: ReasoningCache = {
      get: async () => {
        throw new Error('db down');
      },
      set: async () => {},
    };
    const result = await createFakeProvider({ estimateShelfLife: life }).estimateShelfLife(input, { cache });
    expect(result.path).toBe('model');
    expect(result.output).toEqual(life);
  });

  it('a failing set keeps the valid model result and its path', async () => {
    const cache: ReasoningCache = {
      get: async () => undefined,
      set: async () => {
        throw new Error('db down');
      },
    };
    const result = await createFakeProvider({ estimateShelfLife: life }).estimateShelfLife(input, { cache });
    expect(result.path).toBe('model');
    expect(result.output).toEqual(life);
    expect(result.call.error).toBeNull();
  });

  it('a cache entry without violations still returns a violations array', async () => {
    const cache: ReasoningCache = { get: async () => ({ output: life }), set: async () => {} };
    const result = await createFakeProvider({ estimateShelfLife: life }).estimateShelfLife(input, { cache });
    expect(result.path).toBe('cache');
    expect(result.violations).toEqual([]);
  });
});

describe('parseActivity: an invented lot_id lowers confidence and adds an ambiguity', () => {
  it('high → medium, plus an ambiguity for the unmatched item', async () => {
    const provider = createFakeProvider({
      parseActivity: {
        activities: [{ kind: 'used', items: [{ lot_id: 'lot_fake', food_name: 'milk' }] }],
        ambiguities: [],
        confidence: 'high',
      },
    });
    const result = await provider.parseActivity({
      text: 'used the milk',
      now: '2026-09-29',
      context: { lots: [{ lot_id: 'lot_1', food_name: 'oat milk', location: 'fridge', state: 'opened', quantity_text: '1 qt' }] },
    });

    expect(result.path).toBe('model');
    expect(result.output.confidence).toBe('medium');
    expect(result.output.activities[0]!.items[0]).toEqual({ food_name: 'milk' });
    expect(result.output.ambiguities).toHaveLength(1);
    expect(result.output.ambiguities[0]).toMatchObject({ text: 'milk', candidate_lot_ids: [] });
    expect(result.output.ambiguities[0]!.reason).toMatch(/known lot/);
    expect(result.violations.some((v) => v.includes('lot_fake'))).toBe(true);
    expect(ParseActivityOutputSchema.parse(result.output)).toEqual(result.output);
  });
});

describe('privacy: food text is not mistaken for addresses', () => {
  it.each(['12 OZ DR PEPPER', '2 LB ST LOUIS RIBS', 'used 2 cans of Dr Pepper', '3 lb Lane cake', 'EGGS 24 CT', '16 PK DR PEPPER 12 FL OZ'])(
    'keeps %j',
    (text) => {
      expect(redactText(text)).toBe(text);
    },
  );

  it.each(['1234 Elm Street', '1234 ELM STREET', '55 North Oak Ave.', '901 Main St'])('redacts the address %j', (text) => {
    expect(redactText(`ship to ${text} please`)).toContain('[address]');
    expect(redactText(text)).not.toMatch(/Elm|ELM|Oak|Main/);
  });

  it('does not redact id fields', () => {
    const redacted = redactDeep({ recipe_id: 'r-555-123-4567', lot_ids: ['555-123-4567'], title: 'call 555-123-4567' });
    expect(redacted).toEqual({ recipe_id: 'r-555-123-4567', lot_ids: ['555-123-4567'], title: 'call [phone]' });
  });

  it('keeps recipe ids intact end to end', async () => {
    const provider = createFakeProvider({
      rankRecipes: (i: any) => ({ ranked: i.candidates.map((c: any) => ({ recipe_id: c.recipe_id, explanation: 'x' })), ideas: [] }),
    });
    const result = await provider.rankRecipes({
      candidates: [{ recipe_id: 'r-555-123-4567', title: 'soup', score: 1, coverage_summary: 'all' }],
      include_ideas: false,
    });
    expect(result.output.ranked).toEqual([{ recipe_id: 'r-555-123-4567', explanation: 'x' }]);
    expect(result.violations).toEqual([]);
  });
});

describe('estimateShelfLife: duplicate states', () => {
  it('dedupes states before building the model schema', async () => {
    const mock = mockFetch([
      json({ per_state: { sealed: { days: 7, confidence: 'medium' }, opened: { days: 5, confidence: 'medium' } }, rationale: 'r' }),
    ]);
    const provider = createReasoningProvider({ provider: 'crusoe', apiKey: 'test-key', model: 'test/model', fetch: mock.fetch });
    const result = await provider.estimateShelfLife({ food_name: 'milk', category: 'dairy', states: ['sealed', 'sealed', 'opened'] });

    expect(mock.requests[0]!.body.response_format.json_schema.schema.properties.per_state.required).toEqual(['sealed', 'opened']);
    expect(Object.keys(result.output.per_state)).toEqual(['sealed', 'opened']);
    expect(result.violations).toEqual([]);
    expect(ShelfLifeOutputSchema.parse(result.output)).toEqual(result.output);
  });
});
