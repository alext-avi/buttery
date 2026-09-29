// Post-validation guardrails. Each takes the parsed input and a schema-valid output and
// returns a corrected output plus a human-readable violation per correction.

import type { z } from 'zod';
import type {
  CanonicalizeInputSchema,
  CanonicalizeOutput,
  Confidence,
  ParseActivityInputSchema,
  ParseActivityOutput,
  RankRecipesInputSchema,
  RankRecipesOutput,
  ShelfLifeInputSchema,
  ShelfLifeOutput,
} from './schemas.ts';
import { fallbackCanonicalize, fallbackShelfLife, resolveCategory } from './fallback.ts';
import { categoryDefaults } from './shelfLifeDefaults.ts';

export interface Guarded<T> {
  output: T;
  violations: string[];
}

export function lowerConfidence(c: Confidence): Confidence {
  return c === 'high' ? 'medium' : 'low';
}

// --- Output hygiene (before Zod) ---
// Guided decoding tends to fill optional fields instead of omitting them: "" ids, `servings: 0`,
// `recipe_id` on a "moved" activity, `size: 0` for an unknown size. These rules drop fields that
// carry no information or don't apply to the activity kind. They are cleanup, not corrections,
// so they record no violation.

const COOKED_ONLY = ['recipe_id', 'servings'] as const;
const LOCATION_KINDS = new Set(['moved', 'froze', 'thawed', 'bought']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function dropEmpty(obj: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const v = obj[key];
    if (v === '' || v === null || (typeof v === 'number' && v <= 0)) delete obj[key];
  }
}

export function normalizeParseActivity(json: unknown): unknown {
  if (!isRecord(json) || !Array.isArray(json.activities)) return json;
  for (const activity of json.activities) {
    if (!isRecord(activity)) continue;
    dropEmpty(activity, COOKED_ONLY);
    if (activity.kind !== 'cooked') for (const key of COOKED_ONLY) delete activity[key];
    if (!Array.isArray(activity.items)) continue;
    for (const item of activity.items) {
      if (!isRecord(item)) continue;
      dropEmpty(item, ['lot_id', 'food_name', 'to_location']);
      if (!LOCATION_KINDS.has(String(activity.kind))) delete item.to_location;
      if (isRecord(item.quantity)) dropEmpty(item.quantity, ['amount', 'unit']);
    }
  }
  return json;
}

export function normalizeCanonicalize(json: unknown): unknown {
  if (!isRecord(json) || !Array.isArray(json.lines)) return json;
  for (const line of json.lines) {
    if (!isRecord(line) || !isRecord(line.package)) continue;
    dropEmpty(line.package, ['count', 'size', 'unit']);
    if (Object.keys(line.package).length === 0) delete line.package;
  }
  return json;
}

export function guardCanonicalize(
  input: z.output<typeof CanonicalizeInputSchema>,
  output: CanonicalizeOutput,
): Guarded<CanonicalizeOutput> {
  const violations: string[] = [];
  const byId = new Map<string, CanonicalizeOutput['lines'][number]>();
  const known = new Set(input.lines.map((l) => l.line_id));

  for (const line of output.lines) {
    if (!known.has(line.line_id)) {
      violations.push(`canonicalizeItems: dropped unknown line_id "${line.line_id}"`);
      continue;
    }
    if (byId.has(line.line_id)) {
      violations.push(`canonicalizeItems: dropped duplicate line_id "${line.line_id}"`);
      continue;
    }
    const allowed = new Set((input.candidates[line.line_id] ?? []).map((c) => c.food_id));
    if (line.match.food_id !== 'new' && !allowed.has(line.match.food_id)) {
      violations.push(
        `canonicalizeItems: line "${line.line_id}" matched food_id "${line.match.food_id}" which is not a candidate; coerced to "new"`,
      );
      byId.set(line.line_id, { ...line, match: { food_id: 'new', confidence: 'low' } });
      continue;
    }
    byId.set(line.line_id, line);
  }

  const missing = input.lines.filter((l) => !byId.has(l.line_id));
  if (missing.length > 0) {
    const filled = fallbackCanonicalize({ lines: missing, candidates: input.candidates }).lines;
    for (const line of filled) {
      violations.push(`canonicalizeItems: model omitted line "${line.line_id}"; filled by fallback`);
      byId.set(line.line_id, line);
    }
  }

  return { output: { lines: input.lines.map((l) => byId.get(l.line_id)!) }, violations };
}

export function guardShelfLife(
  input: z.output<typeof ShelfLifeInputSchema>,
  output: ShelfLifeOutput,
): Guarded<ShelfLifeOutput> {
  const violations: string[] = [];
  const category = resolveCategory(input.category, input.food_name);
  const bounds = categoryDefaults(category).states;
  const defaults = fallbackShelfLife(input).per_state;
  const per_state: ShelfLifeOutput['per_state'] = {};

  for (const state of input.states) {
    let estimate = output.per_state[state];
    if (!estimate) {
      violations.push(`estimateShelfLife: missing state "${state}"; used category default`);
      estimate = defaults[state]!;
    }
    const max = bounds[state].max;
    if (max !== null && (estimate.days === null || estimate.days > max)) {
      violations.push(
        `estimateShelfLife: ${state} ${estimate.days ?? 'no expiry'} exceeds ${category} max ${max}d; clamped, confidence lowered`,
      );
      estimate = { days: max, confidence: lowerConfidence(estimate.confidence) };
    }
    per_state[state] = estimate;
  }

  for (const state of Object.keys(output.per_state)) {
    if (!input.states.includes(state as never)) violations.push(`estimateShelfLife: dropped unrequested state "${state}"`);
  }

  return { output: { per_state, rationale: output.rationale }, violations };
}

export function guardParseActivity(
  input: z.output<typeof ParseActivityInputSchema>,
  output: ParseActivityOutput,
): Guarded<ParseActivityOutput> {
  const violations: string[] = [];
  const lots = new Map(input.context.lots.map((l) => [l.lot_id, l]));
  const recipes = new Set(input.context.recipes.map((r) => r.recipe_id));

  const activities = output.activities.map((raw) => {
    // Guided decoding sometimes fills an optional id with "" instead of omitting it.
    const activity = raw.recipe_id === '' ? withoutKey(raw, 'recipe_id') : raw;
    const items = activity.items.map((rawItem) => {
      const item = rawItem.lot_id === '' ? withoutKey(rawItem, 'lot_id') : rawItem;
      if (item.lot_id === undefined || lots.has(item.lot_id)) return item;
      violations.push(`parseActivity: dropped unknown lot_id "${item.lot_id}"`);
      const { lot_id: _dropped, ...rest } = item;
      return rest;
    });
    if (activity.recipe_id !== undefined && !recipes.has(activity.recipe_id)) {
      violations.push(`parseActivity: dropped unknown recipe_id "${activity.recipe_id}"`);
      const { recipe_id: _dropped, ...rest } = activity;
      return { ...rest, items };
    }
    return { ...activity, items };
  });

  const ambiguities = output.ambiguities.map((a) => {
    const ids = a.candidate_lot_ids.filter((id) => lots.has(id));
    if (ids.length !== a.candidate_lot_ids.length) {
      violations.push(`parseActivity: dropped unknown candidate_lot_ids in ambiguity "${a.text}"`);
    }
    return { ...a, candidate_lot_ids: ids };
  });

  return { output: { ...output, activities, ambiguities }, violations };
}

function withoutKey<T extends object>(value: T, key: keyof T): T {
  const { [key]: _dropped, ...rest } = value;
  return rest as T;
}

export function guardRankRecipes(
  input: z.output<typeof RankRecipesInputSchema>,
  output: RankRecipesOutput,
): Guarded<RankRecipesOutput> {
  const violations: string[] = [];
  const known = new Set(input.candidates.map((c) => c.recipe_id));
  const seen = new Set<string>();
  const ranked: RankRecipesOutput['ranked'] = [];

  for (const entry of output.ranked) {
    if (!known.has(entry.recipe_id)) {
      violations.push(`rankRecipes: dropped unknown recipe_id "${entry.recipe_id}"`);
    } else if (seen.has(entry.recipe_id)) {
      violations.push(`rankRecipes: dropped duplicate recipe_id "${entry.recipe_id}"`);
    } else {
      seen.add(entry.recipe_id);
      ranked.push(entry);
    }
  }
  for (const candidate of input.candidates) {
    if (!seen.has(candidate.recipe_id)) {
      violations.push(`rankRecipes: appended missing recipe_id "${candidate.recipe_id}"`);
      ranked.push({ recipe_id: candidate.recipe_id, explanation: '' });
    }
  }

  const ideas = input.include_ideas ? output.ideas : [];
  if (!input.include_ideas && output.ideas.length > 0) violations.push('rankRecipes: dropped ideas (include_ideas is false)');

  return { output: { ranked, ideas }, violations };
}
