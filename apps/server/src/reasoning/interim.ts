import { hashJson, similarity, type LineKind } from '@buttery/domain';
import type { CanonicalizeInput, CanonicalizeOutput, ReasoningCallRecord, ReasoningPort, ReasoningResult, ShelfLifeInput, ShelfLifeOutput } from './port';

const SIZE_TOKENS = /\b\d+(\.\d+)?\s*(x\s*\d+(\.\d+)?\s*)?(oz|lb|lbs|gal|ct|count|pk|pack|can|fl|qt|l|ml|g|kg)\b/gi;

function guessKind(raw: string): LineKind {
  if (/\b(coupon|discount|savings|instant)\b/i.test(raw)) return 'coupon';
  if (/^(return|refund)\b/i.test(raw.trim())) return 'return';
  return 'item';
}

function cleanName(raw: string): string {
  const s = raw.replace(SIZE_TOKENS, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return s ? s[0]!.toUpperCase() + s.slice(1) : raw;
}

function record<T>(fn: ReasoningCallRecord['function'], input: unknown, output: T): ReasoningResult<T> {
  return {
    output,
    path: 'fallback',
    violations: [],
    call: {
      function: fn,
      provider: 'fallback',
      model: null,
      inputHash: hashJson(input),
      input,
      output,
      valid: true,
      latencyMs: 0,
      tokensIn: null,
      tokensOut: null,
      error: null,
      createdAt: new Date().toISOString(),
    },
  };
}

export function createInterimReasoning(): ReasoningPort {
  return {
    async canonicalizeItems(input: CanonicalizeInput) {
      const lines = input.lines.map((l) => {
        const kind = l.line_kind ?? guessKind(l.raw_text);
        const candidates = input.candidates[l.line_id] ?? [];
        const best = candidates
          .map((c) => ({ c, score: Math.max(similarity(l.raw_text, c.name), ...c.aliases.map((a) => similarity(l.raw_text, a))) }))
          .sort((a, b) => b.score - a.score)[0];
        const matched = kind === 'item' && best && best.score >= 0.35;
        return {
          line_id: l.line_id,
          canonical_name: matched ? best.c.name : l.hint?.food_name ?? cleanName(l.raw_text),
          category: matched ? best.c.category : 'other',
          perishability: matched ? best.c.perishability : ('perishable' as const),
          ...(l.hint?.package ? { package: l.hint.package } : {}),
          line_kind: kind,
          match: matched ? { food_id: best.c.food_id, confidence: 'medium' as const } : { food_id: 'new' as const, confidence: 'low' as const },
          rationale: 'Heuristic match (reasoning model unavailable)',
        };
      });
      return record<CanonicalizeOutput>('canonicalizeItems', input, { lines });
    },
    async estimateShelfLife(input: ShelfLifeInput) {
      const per_state = Object.fromEntries(input.states.map((s) => [s, { days: null, confidence: 'low' as const }]));
      return record<ShelfLifeOutput>('estimateShelfLife', input, { per_state, rationale: 'No estimate available without the reasoning model' });
    },
  };
}
