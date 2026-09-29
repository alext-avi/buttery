// The call pipeline shared by every provider:
// validate input → redact → hash → cache → model → Zod → (one repair) → guardrails → record,
// with a deterministic fallback on any failure, so `output` is always schema-valid.

import { z } from 'zod';
import type { Completer, ChatMessage } from './client.ts';
import { cacheKey } from './cache.ts';
import {
  fallbackCanonicalize,
  fallbackParseActivity,
  fallbackRankRecipes,
  fallbackShelfLife,
} from './fallback.ts';
import {
  guardCanonicalize,
  guardParseActivity,
  guardRankRecipes,
  guardShelfLife,
  normalizeCanonicalize,
  normalizeParseActivity,
  type Guarded,
} from './guardrails.ts';
import { hashInput } from './hash.ts';
import { redactDeep } from './privacy.ts';
import { repairPrompt, systemPrompt, userPrompt } from './prompts.ts';
import { FUNCTION_SCHEMAS } from './schemas.ts';
import type { CallContext, ReasoningCache, ReasoningCallRecord, ReasoningFunction, ReasoningResult } from './types.ts';

interface FunctionSpec {
  input: z.ZodType;
  output: z.ZodType;
  fallback(input: any): unknown;
  guard(input: any, output: any): Guarded<unknown>;
  /** Output hygiene applied to the model's JSON before validation. */
  normalize?(json: unknown): unknown;
}

const SPECS: Record<ReasoningFunction, FunctionSpec> = {
  canonicalizeItems: { ...FUNCTION_SCHEMAS.canonicalizeItems, fallback: fallbackCanonicalize, guard: guardCanonicalize, normalize: normalizeCanonicalize },
  estimateShelfLife: { ...FUNCTION_SCHEMAS.estimateShelfLife, fallback: fallbackShelfLife, guard: guardShelfLife },
  parseActivity: { ...FUNCTION_SCHEMAS.parseActivity, fallback: fallbackParseActivity, guard: guardParseActivity, normalize: normalizeParseActivity },
  rankRecipes: { ...FUNCTION_SCHEMAS.rankRecipes, fallback: fallbackRankRecipes, guard: guardRankRecipes },
};

const JSON_SCHEMAS = Object.fromEntries(
  Object.entries(SPECS).map(([fn, spec]) => {
    const { $schema: _draft, ...schema } = z.toJSONSchema(spec.output, { io: 'output' }) as Record<string, unknown>;
    return [fn, stripNumericBounds(schema) as Record<string, unknown>];
  }),
) as Record<ReasoningFunction, Record<string, unknown>>;

/**
 * Crusoe's guided decoding mishandles numeric bounds: with `exclusiveMinimum: 0`, "1/2 GAL"
 * decodes as `size: 0` instead of 0.5 (verified 2026-09-29). Bounds are removed from the schema
 * sent to the model; Zod still enforces them, so a bad value goes through repair.
 */
function stripNumericBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripNumericBounds);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].includes(key)) continue;
    out[key] = stripNumericBounds(value);
  }
  return out;
}

/**
 * The JSON Schema sent to the model for one call. Guided decoding emits properties in schema
 * order, so optional keys the model "passes" can never be written afterwards (verified: cooked
 * rice with states [prepared, frozen] lost `frozen`). Shelf life therefore gets a per-call schema
 * whose `per_state` has exactly the requested states, in request order, all required.
 */
export function outputJsonSchema(fn: ReasoningFunction, input?: unknown): Record<string, unknown> {
  const base = JSON_SCHEMAS[fn];
  if (fn !== 'estimateShelfLife' || !input) return base;
  const states = (input as { states: string[] }).states;
  const properties = base.properties as Record<string, any>;
  const perState = properties.per_state;
  const estimate = Object.values(perState.properties as Record<string, unknown>)[0];
  return {
    ...base,
    properties: {
      ...properties,
      per_state: {
        ...perState,
        properties: Object.fromEntries(states.map((state) => [state, estimate])),
        required: states,
      },
    },
  };
}

export const DEFAULT_TIMEOUTS_MS: Record<ReasoningFunction, number> = {
  canonicalizeItems: 20_000,
  estimateShelfLife: 8_000,
  parseActivity: 8_000,
  rankRecipes: 8_000,
};

export interface EngineOptions {
  provider: ReasoningCallRecord['provider'];
  /** Absent for the `fallback` provider. */
  completer?: Completer;
  modelFor(fn: ReasoningFunction): string | null;
  timeoutFor(fn: ReasoningFunction): number;
  /** Used when the call has no `ctx.cache`. */
  defaultCache?: ReasoningCache;
  now(): Date;
}

export class ReasoningInputError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(fn: ReasoningFunction, issues: z.core.$ZodIssue[]) {
    super(`${fn}: invalid input\n${z.prettifyError(new z.ZodError(issues))}`);
    this.name = 'ReasoningInputError';
    this.issues = issues;
  }
}

interface CachedEntry {
  output: unknown;
  violations: string[];
}

export async function runReasoning<T>(
  opts: EngineOptions,
  fn: ReasoningFunction,
  rawInput: unknown,
  ctx: CallContext = {},
): Promise<ReasoningResult<T>> {
  const spec = SPECS[fn];
  const started = performance.now();
  const createdAt = opts.now().toISOString();

  const parsedInput = spec.input.safeParse(rawInput);
  if (!parsedInput.success) throw new ReasoningInputError(fn, parsedInput.error.issues);
  const input = redactDeep(parsedInput.data);
  const inputHash = hashInput(input);
  const model = opts.modelFor(fn);

  const record = (fields: Partial<ReasoningCallRecord> & Pick<ReasoningCallRecord, 'output' | 'valid'>): ReasoningCallRecord => ({
    function: fn,
    provider: opts.provider,
    model,
    inputHash,
    input,
    latencyMs: Math.round(performance.now() - started),
    tokensIn: null,
    tokensOut: null,
    error: null,
    createdAt,
    ...fields,
  });

  const fallback = (error: string | null, extra: Partial<ReasoningCallRecord> = {}): ReasoningResult<T> => {
    const guarded = spec.guard(input, spec.output.parse(spec.fallback(input)));
    return {
      output: guarded.output as T,
      path: 'fallback',
      violations: guarded.violations,
      call: record({ output: guarded.output, valid: error === null, error, ...extra }),
    };
  };

  if (!opts.completer || !model) {
    return fallback(null, { provider: 'fallback', model: null });
  }

  const cache = ctx.cache ?? opts.defaultCache;
  const key = cacheKey(fn, model, inputHash);
  if (cache) {
    const hit = (await cache.get(key)) as CachedEntry | undefined;
    const valid = hit && spec.output.safeParse(hit.output);
    if (hit && valid?.success) {
      return {
        output: valid.data as T,
        path: 'cache',
        violations: hit.violations,
        call: record({ output: valid.data, valid: true }),
      };
    }
  }

  const timeoutMs = opts.timeoutFor(fn);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const onCallerAbort = () => controller.abort(new Error('aborted by caller'));
  if (ctx.signal?.aborted) onCallerAbort();
  ctx.signal?.addEventListener('abort', onCallerAbort, { once: true });

  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  const addTokens = (a: number | null, b: number | null) => {
    if (a !== null) tokensIn = (tokensIn ?? 0) + a;
    if (b !== null) tokensOut = (tokensOut ?? 0) + b;
  };

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(fn) },
    { role: 'user', content: userPrompt(input) },
  ];

  try {
    for (const attempt of ['model', 'repair'] as const) {
      const response = await abortable(
        opts.completer.complete({ fn, model, messages, jsonSchema: outputJsonSchema(fn, input), signal: controller.signal }),
        controller.signal,
      );
      addTokens(response.tokensIn, response.tokensOut);

      const checked = validate(spec, response.content);
      if (checked.ok) {
        const parsed = checked.data;
        const guarded = spec.guard(input, parsed);
        if (cache) await cache.set(key, { output: guarded.output, violations: guarded.violations } satisfies CachedEntry);
        return {
          output: guarded.output as T,
          path: attempt,
          violations: guarded.violations,
          call: record({ output: guarded.output, valid: true, tokensIn, tokensOut }),
        };
      }
      if (attempt === 'repair') {
        return fallback(`invalid output after repair: ${checked.errors}`, { tokensIn, tokensOut });
      }
      messages.push({ role: 'assistant', content: response.content }, { role: 'user', content: repairPrompt(checked.errors) });
    }
    throw new Error('unreachable');
  } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason : error;
    return fallback(errorMessage(reason), { tokensIn, tokensOut });
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/** Reject as soon as the signal aborts, even if the underlying request ignores it. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => {}); // a late rejection after abort is expected, not unhandled
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Parse model text as JSON, tolerating a ```json fence. */
export function parseJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}

/** Parse, normalize and validate model text; on failure, a compact summary for the repair prompt. */
function validate(spec: FunctionSpec, content: string): { ok: true; data: unknown } | { ok: false; errors: string } {
  let json: unknown;
  try {
    json = parseJson(content);
  } catch (error) {
    return { ok: false, errors: `response is not valid JSON (${errorMessage(error)})` };
  }
  const result = spec.output.safeParse(spec.normalize ? spec.normalize(json) : json);
  return result.success ? { ok: true, data: result.data } : { ok: false, errors: z.prettifyError(result.error) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
