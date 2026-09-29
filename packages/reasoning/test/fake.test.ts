import { describe, expect, it } from 'vitest';
import { createFakeProvider, createMemoryCache, ShelfLifeOutputSchema } from '../src/index.ts';

const milkLife = { per_state: { opened: { days: 7, confidence: 'medium' as const } }, rationale: 'typical' };

describe('createFakeProvider', () => {
  it('returns scripted outputs through the normal pipeline', async () => {
    const provider = createFakeProvider({ estimateShelfLife: milkLife });
    const result = await provider.estimateShelfLife({ food_name: 'whole milk', category: 'dairy', states: ['opened'] });

    expect(result.path).toBe('model');
    expect(result.output).toEqual(milkLife);
    expect(result.call).toMatchObject({ provider: 'fake', model: 'fake', valid: true });
    expect(ShelfLifeOutputSchema.parse(result.output)).toEqual(result.output);
  });

  it('still validates, repairs and falls back', async () => {
    const provider = createFakeProvider({ estimateShelfLife: ['{bad json', milkLife] });
    expect((await provider.estimateShelfLife({ food_name: 'milk', states: ['opened'] })).path).toBe('repair');

    const broken = createFakeProvider({ estimateShelfLife: [{ per_state: 'nope' } as never, 'still bad'] });
    const result = await broken.estimateShelfLife({ food_name: 'milk', category: 'dairy', states: ['opened'] });
    expect(result.path).toBe('fallback');
    expect(result.output.per_state.opened).toEqual({ days: 7, confidence: 'low' });
  });

  it('applies guardrails to scripted output', async () => {
    const provider = createFakeProvider({
      canonicalizeItems: (input: any) => ({
        lines: input.lines.map((l: any) => ({
          line_id: l.line_id,
          canonical_name: 'eggs',
          category: 'eggs',
          perishability: 'perishable',
          line_kind: 'item',
          match: { food_id: 'not_a_candidate', confidence: 'high' },
          rationale: 'scripted',
        })),
      }),
    });
    const result = await provider.canonicalizeItems({ lines: [{ line_id: 'x', raw_text: 'EGGS 24 CT' }], candidates: {} });
    expect(result.output.lines[0]!.match).toEqual({ food_id: 'new', confidence: 'low' });
    expect(result.violations).toContainEqual(expect.stringContaining('not_a_candidate'));
    // The printed size on the line wins over the (missing) scripted package.
    expect(result.output.lines[0]!.package).toEqual({ size: 24, unit: 'ct' });
  });

  it('falls back for unscripted functions and simulated errors', async () => {
    const provider = createFakeProvider({ parseActivity: new Error('simulated outage') });
    const parsed = await provider.parseActivity({ text: 'ate the leftovers', now: '2026-09-29', context: {} });
    expect(parsed.path).toBe('fallback');
    expect(parsed.call.error).toBe('simulated outage');

    const ranked = await provider.rankRecipes({ candidates: [], include_ideas: false });
    expect(ranked.path).toBe('fallback');
  });

  it('caches only through ctx.cache', async () => {
    const provider = createFakeProvider({ estimateShelfLife: milkLife });
    const input = { food_name: 'milk', states: ['opened' as const] };
    expect((await provider.estimateShelfLife(input)).path).toBe('model');
    expect((await provider.estimateShelfLife(input)).path).toBe('model');

    const cache = createMemoryCache();
    await provider.estimateShelfLife(input, { cache });
    expect((await provider.estimateShelfLife(input, { cache })).path).toBe('cache');
  });
});
