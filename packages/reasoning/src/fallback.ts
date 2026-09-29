// Deterministic fallbacks. Used by the `fallback` provider and whenever a model call fails,
// times out or produces output that doesn't validate after one repair.

import type { z } from 'zod';
import type {
  CanonicalizeInputSchema,
  CanonicalizeOutput,
  Confidence,
  ParseActivityOutput,
  RankRecipesInputSchema,
  RankRecipesOutput,
  ShelfLifeInputSchema,
  ShelfLifeOutput,
} from './schemas.ts';
import { categoryDefaults, isFoodCategory } from './shelfLifeDefaults.ts';
import {
  canonicalNameFromRaw,
  classifyCategory,
  detectLineKind,
  normalizeName,
  parsePackage,
  trigramSimilarity,
} from './text.ts';

/** Trigram similarity at or above this is a `medium` match; below it the line is `'new'`. */
export const MATCH_THRESHOLD = 0.55;

type CanonicalizeParsed = z.output<typeof CanonicalizeInputSchema>;
type ShelfLifeParsed = z.output<typeof ShelfLifeInputSchema>;
type RankParsed = z.output<typeof RankRecipesInputSchema>;

export function fallbackCanonicalize(input: CanonicalizeParsed): CanonicalizeOutput {
  return {
    lines: input.lines.map((line) => {
      const nameSource = line.hint?.food_name?.trim() || line.raw_text;
      const canonical_name = line.hint?.food_name?.trim().toLowerCase() || canonicalNameFromRaw(line.raw_text);
      const line_kind = line.line_kind ?? detectLineKind(line.raw_text, line.price_cents);
      const category = line_kind === 'non_food' ? 'non_food' : classifyCategory(nameSource);
      const pkg = parsePackage(line.hint?.package ?? line.raw_text);

      const normalized = normalizeName(canonical_name);
      let best: { food_id: string; score: number; exact: boolean } | undefined;
      for (const candidate of input.candidates[line.line_id] ?? []) {
        for (const name of [candidate.name, ...candidate.aliases]) {
          const exact = normalizeName(name) === normalized || normalizeName(name) === normalizeName(line.raw_text);
          const score = exact ? 1 : Math.max(trigramSimilarity(name, canonical_name), trigramSimilarity(name, line.raw_text));
          if (!best || score > best.score) best = { food_id: candidate.food_id, score, exact };
        }
      }

      let match: { food_id: string; confidence: Confidence } = { food_id: 'new', confidence: 'low' };
      if (best?.exact) match = { food_id: best.food_id, confidence: 'high' };
      else if (best && best.score >= MATCH_THRESHOLD) match = { food_id: best.food_id, confidence: 'medium' };

      return {
        line_id: line.line_id,
        canonical_name,
        category,
        perishability: categoryDefaults(category).perishability,
        ...(pkg ? { package: pkg } : {}),
        line_kind,
        match,
        rationale: best
          ? `fallback: best candidate similarity ${best.score.toFixed(2)}${match.food_id === 'new' ? ' below threshold' : ''}`
          : 'fallback: no candidates; rule-based name and category',
      };
    }),
  };
}

export function resolveCategory(category: string | undefined, foodName: string) {
  return isFoodCategory(category) ? category : classifyCategory(foodName);
}

export function fallbackShelfLife(input: ShelfLifeParsed): ShelfLifeOutput {
  const category = resolveCategory(input.category, input.food_name);
  const defaults = categoryDefaults(category);
  const per_state: ShelfLifeOutput['per_state'] = {};
  for (const state of input.states) {
    per_state[state] = { days: defaults.states[state].days, confidence: 'low' };
  }
  return { per_state, rationale: `fallback: category default for ${category}` };
}

export function fallbackParseActivity(input: { text: string }): ParseActivityOutput {
  return {
    activities: [],
    ambiguities: [{ text: input.text, reason: "couldn't parse", candidate_lot_ids: [] }],
    confidence: 'low',
  };
}

export function fallbackRankRecipes(input: RankParsed): RankRecipesOutput {
  return {
    ranked: input.candidates.map((c) => ({ recipe_id: c.recipe_id, explanation: '' })),
    ideas: [],
  };
}
