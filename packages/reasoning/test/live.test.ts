// Live smoke tests against Crusoe. Skipped unless CRUSOE_API_KEY is set in the environment.
import { describe, expect, it } from 'vitest';
import { createReasoningProvider } from '../src/index.ts';

const key = process.env.CRUSOE_API_KEY;

describe.skipIf(!key)('Crusoe live smoke', () => {
  it('estimateShelfLife returns a model result', async () => {
    const provider = createReasoningProvider({ provider: 'crusoe' });
    const result = await provider.estimateShelfLife({ food_name: 'whole milk', category: 'dairy', states: ['sealed', 'opened'], location: 'fridge' });
    expect(['model', 'repair']).toContain(result.path);
    expect(result.output.per_state.opened?.days).toBeGreaterThan(0);
  }, 30_000);

  it('canonicalizeItems handles a receipt line', async () => {
    const provider = createReasoningProvider({ provider: 'crusoe' });
    const result = await provider.canonicalizeItems({ lines: [{ line_id: '1', raw_text: 'CHKN BREAST 3 LB' }], candidates: {} });
    expect(['model', 'repair']).toContain(result.path);
    expect(result.output.lines[0]).toMatchObject({ category: 'poultry', line_kind: 'item' });
  }, 30_000);
});
