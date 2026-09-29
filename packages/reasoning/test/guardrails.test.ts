import { describe, expect, it } from 'vitest';
import {
  CanonicalizeOutputSchema,
  createMemoryCache,
  createReasoningProvider,
  ParseActivityOutputSchema,
  RankRecipesOutputSchema,
  ReasoningInputError,
  ShelfLifeOutputSchema,
  type ReasoningConfig,
} from '../src/index.ts';
import { FIXED_NOW, json, mockFetch, type Reply } from './helpers.ts';

function crusoe(replies: Reply[], config: ReasoningConfig = {}) {
  const mock = mockFetch(replies);
  const provider = createReasoningProvider({
    provider: 'crusoe',
    apiKey: 'test-key',
    model: 'test/model',
    fetch: mock.fetch,
    now: FIXED_NOW,
    ...config,
  });
  return { provider, ...mock };
}

const milkLine = { line_id: 'l1', raw_text: 'WHOLE MILK 1 GAL' };
const milkCandidates = {
  l1: [{ food_id: 'food_milk', name: 'whole milk', aliases: ['WHOLE MILK 1 GAL'], category: 'dairy', perishability: 'perishable' as const }],
};
const milkOut = (food_id = 'food_milk') => ({
  lines: [
    {
      line_id: 'l1',
      canonical_name: 'whole milk',
      category: 'dairy',
      perishability: 'perishable',
      package: { size: 1, unit: 'gal' },
      line_kind: 'item',
      match: { food_id, confidence: 'high' },
      rationale: 'same food',
    },
  ],
});

describe('structured output and repair', () => {
  it('returns path "model" and records the call when the first reply is valid', async () => {
    const { provider, requests } = crusoe([json(milkOut())]);
    const result = await provider.canonicalizeItems({ lines: [milkLine], candidates: milkCandidates });

    expect(result.path).toBe('model');
    expect(result.violations).toEqual([]);
    expect(CanonicalizeOutputSchema.parse(result.output)).toEqual(result.output);
    expect(result.call).toMatchObject({
      function: 'canonicalizeItems',
      provider: 'crusoe',
      model: 'test/model',
      valid: true,
      tokensIn: 100,
      tokensOut: 20,
      error: null,
      createdAt: '2026-09-29T12:00:00.000Z',
    });
    expect(result.call.inputHash).toMatch(/^[0-9a-f]{64}$/);

    const [req] = requests;
    expect(req!.url).toBe('https://api.inference.crusoecloud.com/v1/chat/completions');
    expect(req!.headers.get('authorization')).toBe('Bearer test-key');
    expect(req!.body.model).toBe('test/model');
    expect(req!.body.response_format.type).toBe('json_schema');
    expect(req!.body.response_format.json_schema.schema.properties.lines).toBeDefined();
    // Numeric bounds break Crusoe's guided decoding (0.5 decodes as 0); Zod enforces them instead.
    expect(JSON.stringify(req!.body.response_format.json_schema.schema)).not.toMatch(/minimum|maximum/i);
  });

  it('repairs invalid JSON once, sending the validation errors back', async () => {
    const { provider, requests } = crusoe([{ content: '{"lines": [' }, json(milkOut())]);
    const result = await provider.canonicalizeItems({ lines: [milkLine], candidates: milkCandidates });

    expect(result.path).toBe('repair');
    expect(result.call.valid).toBe(true);
    expect(result.call.tokensIn).toBe(200);
    expect(requests).toHaveLength(2);
    const repairMessages = requests[1]!.body.messages;
    expect(repairMessages.at(-2)).toMatchObject({ role: 'assistant', content: '{"lines": [' });
    expect(repairMessages.at(-1).content).toContain('not valid JSON');
  });

  it('repairs schema-invalid output, quoting the Zod errors', async () => {
    const bad = { lines: [{ ...milkOut().lines[0], category: 'moon rocks' }] };
    const { provider, requests } = crusoe([json(bad), json(milkOut())]);
    const result = await provider.canonicalizeItems({ lines: [milkLine], candidates: milkCandidates });

    expect(result.path).toBe('repair');
    expect(requests[1]!.body.messages.at(-1).content).toContain('category');
  });

  it('falls back when the repair also fails', async () => {
    const { provider, requests } = crusoe([{ content: 'nope' }, { content: '{"still": "wrong"}' }]);
    const result = await provider.canonicalizeItems({ lines: [milkLine], candidates: milkCandidates });

    expect(requests).toHaveLength(2);
    expect(result.path).toBe('fallback');
    expect(result.call).toMatchObject({ provider: 'crusoe', model: 'test/model', valid: false });
    expect(result.call.error).toMatch(/invalid output after repair/);
    // The alias is an exact match, so the fallback still finds the food.
    expect(result.output.lines[0]!.match).toEqual({ food_id: 'food_milk', confidence: 'high' });
    expect(CanonicalizeOutputSchema.parse(result.output)).toEqual(result.output);
  });

  it('downgrades to json_object when a model rejects json_schema', async () => {
    const { provider, requests } = crusoe([
      { status: 400, error: 'This response_format type is unavailable now' },
      json(milkOut()),
      json(milkOut()),
    ]);
    const first = await provider.canonicalizeItems({ lines: [milkLine], candidates: milkCandidates });
    expect(first.path).toBe('model');
    expect(requests[1]!.body.response_format).toEqual({ type: 'json_object' });
    expect(requests[1]!.body.messages[0].content).toContain('JSON Schema for your response');

    // Remembered for later calls to the same model.
    await provider.canonicalizeItems({ lines: [{ ...milkLine, raw_text: 'MILK 1 GAL' }], candidates: milkCandidates });
    expect(requests[2]!.body.response_format).toEqual({ type: 'json_object' });
  });
});

describe('constrained choices', () => {
  it('coerces an invented food_id to "new" with low confidence', async () => {
    const { provider } = crusoe([json(milkOut('food_made_up'))]);
    const result = await provider.canonicalizeItems({ lines: [milkLine], candidates: milkCandidates });

    expect(result.output.lines[0]!.match).toEqual({ food_id: 'new', confidence: 'low' });
    expect(result.violations).toEqual([expect.stringContaining('food_made_up')]);
  });

  it('fills lines the model omitted and drops lines it invented', async () => {
    const out = { lines: [{ ...milkOut().lines[0], line_id: 'l9' }, milkOut().lines[0]] };
    const { provider } = crusoe([json(out)]);
    const result = await provider.canonicalizeItems({
      lines: [milkLine, { line_id: 'l2', raw_text: 'EGGS 24 CT' }],
      candidates: milkCandidates,
    });

    expect(result.output.lines.map((l) => l.line_id)).toEqual(['l1', 'l2']);
    expect(result.output.lines[1]).toMatchObject({ canonical_name: 'eggs', match: { food_id: 'new' } });
    expect(result.violations).toHaveLength(2);
  });

  it('drops parseActivity lot_ids that are not in context, keeping food_name', async () => {
    const { provider } = crusoe([
      json({
        activities: [
          {
            kind: 'froze',
            items: [
              { lot_id: 'lot_chicken', food_name: 'chicken', to_location: 'freezer' },
              { lot_id: 'lot_ghost', food_name: 'ground beef' },
            ],
          },
          { kind: 'cooked', items: [], recipe_id: 'recipe_ghost' },
        ],
        ambiguities: [{ text: 'the beef', reason: 'two lots', candidate_lot_ids: ['lot_chicken', 'lot_ghost'] }],
        confidence: 'medium',
      }),
    ]);
    const result = await provider.parseActivity({
      text: 'I froze the chicken and the beef',
      now: '2026-09-29T18:00:00',
      context: {
        lots: [{ lot_id: 'lot_chicken', food_name: 'chicken breast', location: 'fridge', state: 'sealed', quantity_text: '3 lb' }],
        locations: ['fridge', 'freezer'],
        recipes: [],
      },
    });

    const [activity, cooked] = result.output.activities;
    expect(activity!.items[0]).toEqual({ lot_id: 'lot_chicken', food_name: 'chicken', to_location: 'freezer' });
    expect(activity!.items[1]).toEqual({ food_name: 'ground beef' });
    expect(cooked).toEqual({ kind: 'cooked', items: [] });
    expect(result.output.ambiguities[0]!.candidate_lot_ids).toEqual(['lot_chicken']);
    expect(result.violations).toHaveLength(3);
    expect(ParseActivityOutputSchema.parse(result.output)).toEqual(result.output);
  });

  it('rankRecipes returns each candidate once: unknown dropped, duplicates removed, missing appended in input order', async () => {
    const { provider } = crusoe([
      json({
        ranked: [
          { recipe_id: 'r3', explanation: 'uses the spinach' },
          { recipe_id: 'r_fake', explanation: 'invented' },
          { recipe_id: 'r3', explanation: 'again' },
        ],
        ideas: [],
      }),
    ]);
    const candidate = (recipe_id: string) => ({ recipe_id, title: recipe_id, score: 1, coverage_summary: 'all', expiring_lots_used: [] });
    const result = await provider.rankRecipes({
      candidates: ['r1', 'r2', 'r3', 'r4'].map(candidate),
      use_soon: [],
      constraints: {},
      include_ideas: false,
    });

    expect(result.output.ranked.map((r) => r.recipe_id)).toEqual(['r3', 'r1', 'r2', 'r4']);
    expect(result.output.ranked[0]!.explanation).toBe('uses the spinach');
    expect(result.output.ranked[1]!.explanation).toBe('');
    expect(result.violations.join('\n')).toMatch(/unknown recipe_id "r_fake"[\s\S]*duplicate recipe_id "r3"/);
    expect(RankRecipesOutputSchema.parse(result.output)).toEqual(result.output);
  });
});

describe('safety clamps', () => {
  it('clamps estimates above the category max and lowers confidence one level', async () => {
    const { provider } = crusoe([
      json({
        per_state: { sealed: { days: 30, confidence: 'high' }, frozen: { days: null, confidence: 'medium' }, opened: { days: 1, confidence: 'high' } },
        rationale: 'optimistic',
      }),
    ]);
    const result = await provider.estimateShelfLife({
      food_name: 'chicken breast',
      category: 'poultry',
      states: ['sealed', 'opened', 'frozen'],
    });

    expect(result.output.per_state).toEqual({
      sealed: { days: 3, confidence: 'medium' },
      opened: { days: 1, confidence: 'high' },
      frozen: { days: 365, confidence: 'low' },
    });
    expect(result.violations).toHaveLength(2);
    expect(ShelfLifeOutputSchema.parse(result.output)).toEqual(result.output);
  });

  it('infers the category from the name when none is given, and fills missing states', async () => {
    const { provider } = crusoe([json({ per_state: { sealed: { days: 60, confidence: 'high' } }, rationale: 'x' })]);
    const result = await provider.estimateShelfLife({ food_name: 'baby spinach', states: ['sealed', 'opened'] });

    expect(result.output.per_state.sealed).toEqual({ days: 7, confidence: 'medium' });
    expect(result.output.per_state.opened).toEqual({ days: 3, confidence: 'low' });
    expect(result.violations).toHaveLength(2);
  });
});

describe('timeouts and network errors', () => {
  it('falls back when the call exceeds its timeout', async () => {
    const { provider } = crusoe([{ hang: true }], { timeoutsMs: { estimateShelfLife: 50 } });
    const result = await provider.estimateShelfLife({ food_name: 'whole milk', category: 'dairy', states: ['opened'] });

    expect(result.path).toBe('fallback');
    expect(result.call.error).toBe('timeout after 50ms');
    expect(result.output.per_state.opened).toEqual({ days: 7, confidence: 'low' });
  });

  it('uses the default timeouts from the brief', async () => {
    const { DEFAULT_TIMEOUTS_MS } = await import('../src/index.ts');
    expect(DEFAULT_TIMEOUTS_MS).toEqual({ canonicalizeItems: 20_000, estimateShelfLife: 8_000, parseActivity: 8_000, rankRecipes: 8_000 });
  });

  it('falls back on network errors and HTTP errors', async () => {
    const { provider } = crusoe([{ networkError: 'ECONNREFUSED' }, { status: 500, error: 'boom' }]);
    const a = await provider.parseActivity({ text: 'used half the milk', now: '2026-09-29', context: {} });
    const b = await provider.parseActivity({ text: 'used all the milk', now: '2026-09-29', context: {} });

    for (const r of [a, b]) {
      expect(r.path).toBe('fallback');
      expect(r.call.valid).toBe(false);
      expect(r.output.confidence).toBe('low');
    }
    expect(b.call.error).toMatch(/500/);
  });

  it('falls back when the caller aborts', async () => {
    const { provider } = crusoe([{ hang: true }]);
    const controller = new AbortController();
    const pending = provider.estimateShelfLife({ food_name: 'eggs', states: ['sealed'] }, { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.path).toBe('fallback');
    expect(result.call.error).toBe('aborted by caller');
  });
});

describe('cache', () => {
  it('returns path "cache" on the second identical call, keyed by function:model:inputHash', async () => {
    const cache = createMemoryCache();
    const reply = json({ per_state: { opened: { days: 5, confidence: 'medium' } }, rationale: 'r' });
    const { provider, requests } = crusoe([reply], { cache });

    const input = { food_name: 'whole milk', category: 'dairy', states: ['opened' as const] };
    const first = await provider.estimateShelfLife(input);
    const second = await provider.estimateShelfLife({ states: ['opened'], category: 'dairy', food_name: 'whole milk' });

    expect(first.path).toBe('model');
    expect(second.path).toBe('cache');
    expect(second.output).toEqual(first.output);
    expect(second.call.inputHash).toBe(first.call.inputHash);
    expect(requests).toHaveLength(1);
    expect(await cache.get(`estimateShelfLife:test/model:${first.call.inputHash}`)).toBeDefined();
  });

  it('uses ctx.cache over the provider default and misses for a different model', async () => {
    const reply = () => json({ per_state: { opened: { days: 5, confidence: 'medium' } }, rationale: 'r' });
    const shared = createMemoryCache();
    const a = crusoe([reply()]);
    const b = crusoe([reply()], { model: 'other/model' });
    const input = { food_name: 'whole milk', states: ['opened' as const] };

    await a.provider.estimateShelfLife(input, { cache: shared });
    expect((await a.provider.estimateShelfLife(input, { cache: shared })).path).toBe('cache');
    expect((await b.provider.estimateShelfLife(input, { cache: shared })).path).toBe('model');
  });
});

describe('privacy and input validation', () => {
  it('strips unknown fields and redacts emails, phones and street addresses before sending', async () => {
    const { provider, requests } = crusoe([json(milkOut('new'))]);
    const result = await provider.canonicalizeItems({
      lines: [
        {
          ...milkLine,
          raw_text: 'WHOLE MILK 1 GAL alex@example.com 555-123-4567 123 Main Street',
          // @ts-expect-error extra fields are not part of the contract and must be stripped
          user_name: 'Alex',
        },
      ],
      candidates: {},
    });

    const sent = JSON.stringify(requests[0]!.body.messages);
    expect(sent).not.toMatch(/alex@example\.com|555-123-4567|Main Street|user_name/);
    expect(sent).toContain('[email]');
    expect(JSON.stringify(result.call.input)).not.toContain('example.com');
    // Receipt counts are not mistaken for addresses.
    expect(JSON.stringify(result.call.input)).toContain('WHOLE MILK 1 GAL');
  });

  it('throws ReasoningInputError for invalid input instead of calling the model', async () => {
    const { provider, requests } = crusoe([]);
    await expect(provider.estimateShelfLife({ food_name: '', states: [] })).rejects.toBeInstanceOf(ReasoningInputError);
    expect(requests).toHaveLength(0);
  });
});

describe('model-facing schema', () => {
  it('shelf life: per_state lists exactly the requested states, in request order, all required', async () => {
    const { provider, requests } = crusoe([
      json({ per_state: { prepared: { days: 4, confidence: 'high' }, frozen: { days: 180, confidence: 'medium' } }, rationale: 'r' }),
    ]);
    const result = await provider.estimateShelfLife({ food_name: 'cooked rice', category: 'grains_pasta', states: ['prepared', 'frozen'] });
    const perState = requests[0]!.body.response_format.json_schema.schema.properties.per_state;
    expect(Object.keys(perState.properties)).toEqual(['prepared', 'frozen']);
    expect(perState.required).toEqual(['prepared', 'frozen']);
    expect(result.violations).toEqual([]);
  });

  it('parseActivity: empty-string ids are treated as absent, without a violation', async () => {
    const { provider } = crusoe([
      json({ activities: [{ kind: 'used', items: [{ lot_id: '', food_name: 'milk' }], recipe_id: '' }], ambiguities: [], confidence: 'medium' }),
    ]);
    const result = await provider.parseActivity({ text: 'used some milk', now: '2026-09-29', context: {} });
    expect(result.output.activities[0]).toEqual({ kind: 'used', items: [{ food_name: 'milk' }] });
    expect(result.violations).toEqual([]);
  });
});

describe('output hygiene', () => {
  it('drops fields that do not apply to the activity kind and zero-valued numbers, without violations', async () => {
    const { provider } = crusoe([
      json({
        activities: [
          { kind: 'moved', items: [{ lot_id: 'lot_a', to_location: 'freezer' }], recipe_id: 'r1', servings: 2 },
          { kind: 'used', items: [{ lot_id: 'lot_a', to_location: 'fridge', quantity: { kind: 'approx', amount: 0 } }], servings: 0 },
          { kind: 'cooked', items: [], recipe_id: 'r1', servings: 0 },
        ],
        ambiguities: [],
        confidence: 'high',
      }),
    ]);
    const result = await provider.parseActivity({
      text: 'moved it, used some, cooked r1',
      now: '2026-09-29',
      context: {
        lots: [{ lot_id: 'lot_a', food_name: 'chicken', location: 'fridge', state: 'sealed', quantity_text: '1 lb' }],
        recipes: [{ recipe_id: 'r1', title: 'Soup' }],
      },
    });
    expect(result.path).toBe('model');
    expect(result.output.activities).toEqual([
      { kind: 'moved', items: [{ lot_id: 'lot_a', to_location: 'freezer' }] },
      { kind: 'used', items: [{ lot_id: 'lot_a', quantity: { kind: 'approx' } }] },
      { kind: 'cooked', items: [], recipe_id: 'r1' },
    ]);
    expect(result.violations).toEqual([]);
  });

  it('drops zero package fields in canonicalize instead of failing validation', async () => {
    const out = milkOut();
    const { provider } = crusoe([json({ lines: [{ ...out.lines[0], package: { count: 0, size: 0 } }] })]);
    const result = await provider.canonicalizeItems({ lines: [milkLine], candidates: milkCandidates });
    expect(result.path).toBe('model');
    expect(result.output.lines[0]!.package).toBeUndefined();
  });
});
