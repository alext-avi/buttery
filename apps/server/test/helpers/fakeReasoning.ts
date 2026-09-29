import { hashJson, normalizeName, type Perishability } from '@buttery/domain';
import type { CanonicalizeInput, CanonicalizeOutput, ParseActivityOutput, ReasoningPort, ReasoningResult, ShelfLifeInput, ShelfLifeOutput } from '../../src/reasoning/port';

// What a good model returns for the fixture receipts in tests/fixtures/food-images.
export const FIXTURE_CANON: Record<string, [name: string, category: string, perishability: Perishability]> = {
  'WHOLE MILK 1 GAL': ['Whole milk', 'dairy', 'perishable'],
  'EGGS 24 CT': ['Eggs', 'eggs', 'perishable'],
  'BABY SPINACH 16 OZ': ['Baby spinach', 'leafy_produce', 'perishable'],
  'STRAWBERRIES 2 LB': ['Strawberries', 'fruit', 'perishable'],
  'CHKN BREAST 3 LB': ['Chicken breast', 'poultry', 'perishable'],
  'GRK YOGURT 2X32 OZ': ['Greek yogurt', 'dairy', 'perishable'],
  BANANAS: ['Bananas', 'fruit', 'perishable'],
  'CHERRY TOMATOES 10 OZ': ['Cherry tomatoes', 'produce', 'perishable'],
  'CHICKPEAS 15 OZ CAN': ['Canned chickpeas', 'canned', 'shelf_stable'],
  'BABY SPINACH 5 OZ': ['Baby spinach', 'leafy_produce', 'perishable'],
};

function result<T>(fn: 'canonicalizeItems' | 'estimateShelfLife' | 'parseActivity', input: unknown, output: T): ReasoningResult<T> {
  return {
    output,
    path: 'model',
    violations: [],
    call: { function: fn, provider: 'fake', model: 'fake-1', inputHash: hashJson(input), input, output, valid: true, latencyMs: 1, tokensIn: 10, tokensOut: 10, error: null, createdAt: new Date().toISOString() },
  };
}

export type FakeReasoning = ReasoningPort & { calls: { canonicalize: CanonicalizeInput[]; shelfLife: ShelfLifeInput[] } };

export function createFakeReasoning(opts: { fail?: boolean } = {}): FakeReasoning {
  const calls = { canonicalize: [] as CanonicalizeInput[], shelfLife: [] as ShelfLifeInput[] };
  return {
    calls,
    async canonicalizeItems(input) {
      calls.canonicalize.push(input);
      if (opts.fail) throw new Error('network down');
      const lines: CanonicalizeOutput['lines'] = input.lines.map((l) => {
        const [name, category, perishability] = FIXTURE_CANON[l.raw_text] ?? [l.raw_text, 'other', 'perishable'];
        const hit = (input.candidates[l.line_id] ?? []).find((c) => normalizeName(c.name) === normalizeName(name));
        return {
          line_id: l.line_id,
          canonical_name: name,
          category,
          perishability,
          ...(l.hint?.package ? { package: l.hint.package } : {}),
          line_kind: l.line_kind ?? 'item',
          match: hit ? { food_id: hit.food_id, confidence: 'high' } : { food_id: 'new', confidence: 'medium' },
          rationale: hit ? 'Same product as existing item' : 'New item',
        };
      });
      return result('canonicalizeItems', input, { lines });
    },
    async estimateShelfLife(input) {
      calls.shelfLife.push(input);
      if (opts.fail) throw new Error('network down');
      // Like the real provider, answer exactly the states asked for.
      const table: Record<string, { days: number; confidence: 'medium' | 'low' }> =
        input.perishability === 'shelf_stable'
          ? { sealed: { days: 730, confidence: 'medium' }, opened: { days: 4, confidence: 'low' } }
          : { sealed: { days: 5, confidence: 'medium' }, opened: { days: 3, confidence: 'medium' }, frozen: { days: 180, confidence: 'medium' }, thawed: { days: 2, confidence: 'low' } };
      const out: ShelfLifeOutput = {
        per_state: Object.fromEntries(input.states.filter((s) => table[s]).map((s) => [s, table[s]!])),
        rationale: input.perishability === 'shelf_stable' ? 'canned' : 'fresh',
      };
      return result('estimateShelfLife', input, out);
    },
    async parseActivity(input) {
      if (opts.fail) throw new Error('network down');
      const out: ParseActivityOutput = { activities: [], ambiguities: [{ text: input.text, reason: 'fake parser', candidate_lot_ids: [] }], confidence: 'low' };
      return result('parseActivity', input, out);
    },
  };
}
