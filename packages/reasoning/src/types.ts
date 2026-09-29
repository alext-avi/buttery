import type {
  CanonicalizeInput,
  CanonicalizeOutput,
  ParseActivityInput,
  ParseActivityOutput,
  RankRecipesInput,
  RankRecipesOutput,
  ShelfLifeInput,
  ShelfLifeOutput,
} from './schemas.ts';

export type ReasoningFunction = 'canonicalizeItems' | 'estimateShelfLife' | 'parseActivity' | 'rankRecipes';

export const REASONING_FUNCTIONS: readonly ReasoningFunction[] = [
  'canonicalizeItems',
  'estimateShelfLife',
  'parseActivity',
  'rankRecipes',
];

export interface ReasoningProvider {
  canonicalizeItems(input: CanonicalizeInput, ctx?: CallContext): Promise<ReasoningResult<CanonicalizeOutput>>;
  estimateShelfLife(input: ShelfLifeInput, ctx?: CallContext): Promise<ReasoningResult<ShelfLifeOutput>>;
  parseActivity(input: ParseActivityInput, ctx?: CallContext): Promise<ReasoningResult<ParseActivityOutput>>;
  rankRecipes(input: RankRecipesInput, ctx?: CallContext): Promise<ReasoningResult<RankRecipesOutput>>;
}

export interface CallContext {
  householdId?: string;
  signal?: AbortSignal;
  cache?: ReasoningCache;
}

export interface ReasoningCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface ReasoningResult<T> {
  /** Always schema-valid, even on fallback. */
  output: T;
  path: 'model' | 'repair' | 'cache' | 'fallback';
  /** The server persists this to `reasoning_calls`. */
  call: ReasoningCallRecord;
  /** Guardrail corrections applied. */
  violations: string[];
}

export interface ReasoningCallRecord {
  function: ReasoningFunction;
  provider: 'crusoe' | 'fallback' | 'fake';
  model: string | null;
  /** sha256 of canonical JSON input (after validation and privacy redaction). */
  inputHash: string;
  input: unknown;
  output: unknown;
  valid: boolean;
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  error: string | null;
  /** ISO timestamp. */
  createdAt: string;
}

export interface ReasoningConfig {
  /** Defaults to `crusoe` when an API key is available, otherwise `fallback`. */
  provider?: 'crusoe' | 'fallback';
  apiKey?: string;
  baseUrl?: string;
  /** Default model for every function. */
  model?: string;
  /** Per-function model overrides. */
  models?: Partial<Record<ReasoningFunction, string>>;
  /** Per-function timeouts in ms (defaults: 20s canonicalize, 8s others). */
  timeoutsMs?: Partial<Record<ReasoningFunction, number>>;
  /** Default cache when a call has no `ctx.cache`. Defaults to an in-memory cache. */
  cache?: ReasoningCache;
  /** Injectable fetch (tests mock the HTTP layer through this). */
  fetch?: typeof fetch;
  /** Clock, for deterministic records in tests. */
  now?: () => Date;
}
