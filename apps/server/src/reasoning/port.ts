// Mirrors the public contract of packages/reasoning (docs/handoffs/2026-09-29-crusoe-reasoning.md).
import type { Confidence, LineKind, LotState, Perishability } from '@buttery/domain';

export type CandidateFood = { food_id: string; name: string; aliases: string[]; category: string; perishability: Perishability };

export type CanonicalizeInput = {
  lines: Array<{
    line_id: string;
    raw_text: string;
    quantity?: number;
    price_cents?: number;
    line_kind?: LineKind;
    hint?: { food_name?: string; package?: { count?: number; size?: number; unit?: string }; location_guess?: string };
  }>;
  candidates: Record<string, CandidateFood[]>;
};

export type CanonicalLine = {
  line_id: string;
  canonical_name: string;
  category: string;
  perishability: Perishability;
  package?: { count?: number; size?: number; unit?: string };
  line_kind: LineKind;
  match: { food_id: string | 'new'; confidence: Confidence };
  rationale: string;
};
export type CanonicalizeOutput = { lines: CanonicalLine[] };

export type ShelfLifeInput = {
  food_name: string;
  category?: string;
  perishability?: Perishability;
  states: LotState[];
  location?: string;
  anchor_date?: string;
};
export type ShelfLifeOutput = {
  per_state: Partial<Record<LotState, { days: number | null; confidence: Confidence }>>;
  rationale: string;
};

export type ReasoningCallRecord = {
  function: 'canonicalizeItems' | 'estimateShelfLife' | 'parseActivity' | 'rankRecipes';
  provider: 'crusoe' | 'fallback' | 'fake';
  model: string | null;
  inputHash: string;
  input: unknown;
  output: unknown;
  valid: boolean;
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  error: string | null;
  createdAt: string;
};

export type ReasoningResult<T> = {
  output: T;
  path: 'model' | 'repair' | 'cache' | 'fallback';
  call: ReasoningCallRecord;
  violations: string[];
};

export type ReasoningCache = { get(key: string): Promise<unknown | undefined>; set(key: string, value: unknown): Promise<void> };
export type ReasoningContext = { householdId?: string; cache?: ReasoningCache };

export interface ReasoningPort {
  canonicalizeItems(input: CanonicalizeInput, ctx?: ReasoningContext): Promise<ReasoningResult<CanonicalizeOutput>>;
  estimateShelfLife(input: ShelfLifeInput, ctx?: ReasoningContext): Promise<ReasoningResult<ShelfLifeOutput>>;
}
