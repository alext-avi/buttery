import { createMemoryCache } from './cache.ts';
import { createCrusoeCompleter, type Completer } from './client.ts';
import { DEFAULT_TIMEOUTS_MS, runReasoning, type EngineOptions } from './engine.ts';
import type {
  CanonicalizeOutput,
  ParseActivityOutput,
  RankRecipesOutput,
  ShelfLifeOutput,
} from './schemas.ts';
import type { ReasoningConfig, ReasoningFunction, ReasoningProvider } from './types.ts';

export const DEFAULT_CRUSOE_BASE_URL = 'https://api.inference.crusoecloud.com/v1';
export const DEFAULT_MODEL = 'deepseek-ai/Deepseek-V4-Flash';

/**
 * Built-in per-function defaults (see README "Live results"). Precedence for each function:
 * per-function config/env → `REASONING_MODEL` → this table → `DEFAULT_MODEL`.
 * parseActivity uses the Pro model because its confidence drives auto-apply (spec Section 7) and
 * Flash missed lot ids and invented fractions in live tests; Pro is about as fast (~1 s).
 */
export const DEFAULT_MODELS: Partial<Record<ReasoningFunction, string>> = {
  parseActivity: 'deepseek-ai/DeepSeek-V4-Pro',
};

const MODEL_ENV: Record<ReasoningFunction, string> = {
  canonicalizeItems: 'REASONING_MODEL_CANONICALIZE',
  estimateShelfLife: 'REASONING_MODEL_SHELF_LIFE',
  parseActivity: 'REASONING_MODEL_PARSE',
  rankRecipes: 'REASONING_MODEL_RANK',
};

/** Read `ReasoningConfig` from environment variables (see README). Explicit fields win. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ReasoningConfig {
  const models: Partial<Record<ReasoningFunction, string>> = {};
  for (const [fn, name] of Object.entries(MODEL_ENV) as [ReasoningFunction, string][]) {
    if (env[name]) models[fn] = env[name];
  }
  const provider = env.REASONING_PROVIDER;
  if (provider !== undefined && provider !== '' && provider !== 'crusoe' && provider !== 'fallback') {
    throw new Error(`REASONING_PROVIDER must be "crusoe" or "fallback", got "${provider}"`);
  }
  return {
    ...(provider ? { provider } : {}),
    ...(env.CRUSOE_API_KEY ? { apiKey: env.CRUSOE_API_KEY } : {}),
    ...(env.CRUSOE_BASE_URL ? { baseUrl: env.CRUSOE_BASE_URL } : {}),
    ...(env.REASONING_MODEL ? { model: env.REASONING_MODEL } : {}),
    models,
  };
}

function bind(opts: EngineOptions): ReasoningProvider {
  return {
    canonicalizeItems: (input, ctx) => runReasoning<CanonicalizeOutput>(opts, 'canonicalizeItems', input, ctx),
    estimateShelfLife: (input, ctx) => runReasoning<ShelfLifeOutput>(opts, 'estimateShelfLife', input, ctx),
    parseActivity: (input, ctx) => runReasoning<ParseActivityOutput>(opts, 'parseActivity', input, ctx),
    rankRecipes: (input, ctx) => runReasoning<RankRecipesOutput>(opts, 'rankRecipes', input, ctx),
  };
}

/**
 * The provider the app uses. With no argument, configuration comes from the environment.
 * Explicit `config` fields override environment values.
 */
export function createReasoningProvider(config?: ReasoningConfig): ReasoningProvider {
  const env = configFromEnv();
  const merged: ReasoningConfig = { ...env, ...config, models: { ...env.models, ...config?.models } };
  const provider = merged.provider ?? (merged.apiKey ? 'crusoe' : 'fallback');
  const now = merged.now ?? (() => new Date());
  const timeoutFor = (fn: ReasoningFunction) => merged.timeoutsMs?.[fn] ?? DEFAULT_TIMEOUTS_MS[fn];

  if (provider === 'fallback') {
    return bind({ provider: 'fallback', modelFor: () => null, timeoutFor, now });
  }
  if (!merged.apiKey) {
    throw new Error('REASONING_PROVIDER=crusoe requires CRUSOE_API_KEY');
  }

  const completer = createCrusoeCompleter({
    apiKey: merged.apiKey,
    baseUrl: merged.baseUrl ?? DEFAULT_CRUSOE_BASE_URL,
    ...(merged.fetch ? { fetch: merged.fetch } : {}),
  });
  return bind({
    provider: 'crusoe',
    completer,
    modelFor: (fn) => merged.models?.[fn] ?? merged.model ?? DEFAULT_MODELS[fn] ?? DEFAULT_MODEL,
    timeoutFor,
    defaultCache: merged.cache ?? createMemoryCache(),
    now,
  });
}

/** Deterministic, offline provider: every function returns its fallback output. */
export function createFallbackProvider(config: Pick<ReasoningConfig, 'now'> = {}): ReasoningProvider {
  return createReasoningProvider({ provider: 'fallback', ...config });
}

// --- fake provider ---

type ScriptEntry<Out> = Out | string | Error | ((input: unknown) => Out | string);

/**
 * Scripted model responses per function. Each entry stands in for one model reply: an object
 * (sent as JSON), a raw string (to simulate malformed output) or an Error (to simulate a failed
 * call). An array is consumed in order, one entry per attempt, so `[bad, good]` exercises repair.
 * A function without a script, or an exhausted array, falls back.
 */
export interface FakeScript {
  canonicalizeItems?: ScriptEntry<CanonicalizeOutput> | ScriptEntry<CanonicalizeOutput>[];
  estimateShelfLife?: ScriptEntry<ShelfLifeOutput> | ScriptEntry<ShelfLifeOutput>[];
  parseActivity?: ScriptEntry<ParseActivityOutput> | ScriptEntry<ParseActivityOutput>[];
  rankRecipes?: ScriptEntry<RankRecipesOutput> | ScriptEntry<RankRecipesOutput>[];
  /** Model name recorded on calls (default "fake"). */
  model?: string;
}

/**
 * Test provider. Scripted outputs go through the same pipeline as real model output: Zod
 * validation, one repair, guardrails and fallback. Results are schema-valid, and invented ids
 * are corrected exactly as they would be for Crusoe. Caches only when `ctx.cache` is passed.
 */
export function createFakeProvider(script: FakeScript, config: Pick<ReasoningConfig, 'now' | 'timeoutsMs'> = {}): ReasoningProvider {
  const queues = new Map<ReasoningFunction, unknown[]>();
  const completer: Completer = {
    async complete({ fn, messages }) {
      const entry = script[fn];
      if (entry === undefined) throw new Error(`fake provider: no script for ${fn}`);
      if (!queues.has(fn)) queues.set(fn, Array.isArray(entry) ? [...entry] : [entry]);
      const queue = queues.get(fn)!;
      // A single (non-array) entry answers every call.
      const next = Array.isArray(entry) ? queue.shift() : queue[0];
      if (next === undefined) throw new Error(`fake provider: script for ${fn} exhausted`);
      const input = JSON.parse(messages[1]!.content.replace(/^Input:\n/, ''));
      const value = typeof next === 'function' ? (next as (i: unknown) => unknown)(input) : next;
      if (value instanceof Error) throw value;
      return { content: typeof value === 'string' ? value : JSON.stringify(value), tokensIn: null, tokensOut: null };
    },
  };
  const timeouts = config.timeoutsMs;
  return bind({
    provider: 'fake',
    completer,
    modelFor: () => script.model ?? 'fake',
    timeoutFor: (fn) => timeouts?.[fn] ?? DEFAULT_TIMEOUTS_MS[fn],
    now: config.now ?? (() => new Date()),
  });
}
