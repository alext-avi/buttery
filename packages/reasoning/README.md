# @buttery/reasoning

Buttery's reasoning module. It is the only place the app talks to an LLM. Four functions
(`canonicalizeItems`, `estimateShelfLife`, `parseActivity`, `rankRecipes`) run on
[Crusoe Managed Inference](https://docs.crusoecloud.com/serverless-inference/). Each one has a
Zod schema, guardrails, a deterministic fallback and a call record for `reasoning_calls`. The
package never touches a database.

Spec: `docs/superpowers/specs/2026-09-29-buttery-design.md`, Section 6.
Brief: `docs/handoffs/2026-09-29-crusoe-reasoning.md`.

## Usage

```ts
import { createReasoningProvider } from '@buttery/reasoning';

const reasoning = createReasoningProvider(); // config from env
const { output, path, call, violations } = await reasoning.canonicalizeItems(
  { lines: [{ line_id: 'l1', raw_text: 'KS ORG EGGS 24CT' }], candidates: { l1: shortlist } },
  { householdId, cache }, // both optional
);
// persist `call` to reasoning_calls; turn `output` into proposal ops
```

- `output` is always schema-valid, even when `path` is `'fallback'`.
- `path` is one of `'model' | 'repair' | 'cache' | 'fallback'`.
- `violations` lists every guardrail correction as a human-readable string.
- Invalid *input* throws `ReasoningInputError`. That's a caller bug, so it gets no fallback.

For tests, `createFakeProvider(script)` scripts model replies. Scripted output goes through the
same validation, repair, guardrails and fallback as real output. `createFallbackProvider()`
is deterministic and offline.

The package ships TypeScript source (`exports` → `src/index.ts`) and relies on Node 26's
built-in type stripping, so there's no build step. Vitest and tsx also load it directly.

## Configuration

| Env | Meaning |
|---|---|
| `REASONING_PROVIDER` | `crusoe` or `fallback`. The default is `crusoe` when `CRUSOE_API_KEY` is set, otherwise `fallback`. |
| `CRUSOE_API_KEY` | Crusoe API key (`cr_…`), created in the Crusoe Cloud console. |
| `CRUSOE_BASE_URL` | Defaults to `https://api.inference.crusoecloud.com/v1`. |
| `REASONING_MODEL` | Default model for all functions (built-in default: see below). |
| `REASONING_MODEL_CANONICALIZE`, `_SHELF_LIFE`, `_PARSE`, `_RANK` | Per-function overrides. |

Explicit `createReasoningProvider(config)` fields override env. The scripts load the
repo-root `.env` if it exists.

## Scripts

```sh
npm test -w packages/reasoning          # offline; live smoke tests run only if CRUSOE_API_KEY is set
npm run reasoning:ping                  # one estimateShelfLife call; fails unless path is model/repair
npm run reasoning:eval                  # fixture receipts → canonicalizeItems, prints accuracy
npm run reasoning:eval -- --model zai/GLM-5.3-Flash
```

Pass eval flags after `--`, or npm will swallow them.

## Guardrails

| Guardrail | Behavior |
|---|---|
| Structured output | Uses `response_format: {type: "json_schema"}`, generated from the Zod output schema. If a model rejects that with a 400, it is downgraded to `json_object` with the schema in the prompt, and the downgrade is remembered per model. The result is then Zod-validated. On failure there is **one repair retry** that includes the errors. If that also fails, the fallback runs. |
| Constrained choices | A `match.food_id` outside that line's candidates becomes `'new'`/`low`. Unknown or duplicate `line_id`s are dropped, and omitted lines are filled by the fallback. `parseActivity` drops unknown `lot_id`s (keeping `food_name`), unknown `recipe_id`s and unknown ambiguity candidates. `rankRecipes` returns every candidate exactly once: unknown ids are dropped, duplicates removed, and missing ids appended in input order. Ideas are dropped when `include_ideas` is false. |
| Safety clamps | `SHELF_LIFE_DEFAULTS` holds 27 categories × 5 states with `{days, max}`. An estimate above `max` is clamped, including `null` ("no expiry") where a max exists, and its confidence drops one level. Missing requested states are filled from defaults. |
| Timeouts | 20 s for `canonicalizeItems`, 8 s for the others, covering the whole call including the repair. A timeout, network error, HTTP error or caller abort leads to the fallback. |
| Fallbacks | canonicalize: rule-based name, category and package, then exact alias → `high`, trigram ≥ 0.55 → `medium`, otherwise `'new'`/`low`. shelf life: the defaults table at `low` confidence. parse: no activities plus one `"couldn't parse"` ambiguity at `low`. rank: input order, empty explanations, no ideas. |
| Cache | Key is `function:model:inputHash`. The default is in-memory per provider; `ctx.cache` overrides it. Hits return `path: 'cache'`. Only model and repair results are cached. |
| Privacy | Input schemas strip unknown fields. Emails, phone numbers and street addresses in any string are redacted before hashing, sending and recording. |

## Crusoe notes

Confirmed on 2026-09-29.

- **API:** OpenAI-compatible chat completions. Authentication is `Authorization: Bearer <CRUSOE_API_KEY>`.
- **Base URL:** `https://api.inference.crusoecloud.com/v1`. Unauthenticated `GET /models`
  returns `401 {"errors":["Authentication failed"]}`, so the endpoint is live.
  - `https://api.crusoe.ai/v1` appears in some search summaries, but it did not resolve when tested.
  - `managed-inference-api-proxy.crusoecloud.com/v1` is the batch-inference proxy.
- **Model IDs** (from the [Serverless Inference docs](https://docs.crusoecloud.com/serverless-inference/)):
  `deepseek-ai/DeepSeek-V4-Flash`, `deepseek-ai/DeepSeek-V4-Pro`, `google/gemma-4-31b-it`,
  `moonshotai/Kimi-K2.6`, `nvidia/Nemotron-3-Nano-30B-A3B`,
  `nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B`, `nvidia/Nemotron-3-Super-120B-A12B`,
  `nvidia/nemotron-3.5-lightning-30b-a3b`, `openai/gpt-oss-120b`, `qwen/Qwen3.8-27B`,
  `zai/GLM-5.3`, `zai/GLM-5.3-Flash`. `meta-llama/Llama-3.3-70B-Instruct` is deprecated.
- **Structured output:** Crusoe serves every model with guided decoding, so
  `response_format: json_schema` works across the catalog
  ([Pydantic AI's Crusoe provider](https://pydantic.dev/docs/ai/models/crusoe/) relies on
  this). Crusoe's own Postman collection shows `json_object`. The `json_object` downgrade
  above is defensive.
- **Rate limits:** serverless endpoints can return `429`; Crusoe raises limits on request.
  The package does not retry (`maxRetries: 0`), because the timeout budget is small and the
  fallback is always available.

<!-- LIVE-RESULTS -->

## Proposed spec changes

These are recorded here instead of editing the spec. None of them change the public contract in
the brief.

1. **Category vocabulary.** `canonicalizeItems` output `category` is an enum: the 27 keys of
   `SHELF_LIFE_DEFAULTS`, exported as `FOOD_CATEGORIES`. Section 4 lists example categories
   ("leafy produce, condiment…"); `foods.category` should use this list so clamps and
   defaults line up. Input `category` fields stay free strings, and unknown values are
   classified from the food name.
2. **Package convention.** `package.count` is the number of sub-packages (only for multipacks:
   `2X32 OZ` → `{count: 2, size: 32, unit: "oz"}`). `size` and `unit` are the amount per
   package. Units: `oz, fl_oz, lb, g, kg, ml, l, gal, qt, pt, ct`, so `24 CT` →
   `{size: 24, unit: "ct"}`.
3. **Call record on fallback after a model failure:** `provider: 'crusoe'`, the model name,
   `valid: false` and `error` set, with `output` equal to the fallback output actually
   returned. With `REASONING_PROVIDER=fallback`: `provider: 'fallback'`, `model: null`,
   `valid: true`. Cache hits: `path: 'cache'`, `tokensIn`/`tokensOut` `null`.
4. **`rankRecipes` input `use_soon`** uses the same shape as `expiring_lots_used`
   (`{lot_id, food_name, expires_on, urgency}`), with `urgency: 'expired' | 'urgent' | 'soon'`
   matching Section 7's windows.
5. **Extra guardrails beyond the brief:** canonicalize fills omitted lines and drops
   invented ones; `parseActivity` also filters `recipe_id` and ambiguity `candidate_lot_ids`;
   `rankRecipes` drops ideas when `include_ideas` is false. A `null` shelf life where the
   category has a max counts as over the max.
6. **Additive exports:** `createFallbackProvider`, `createMemoryCache`, `configFromEnv`,
   `FOOD_CATEGORIES`, `FOOD_STATES`, `categoryDefaults`, `DEFAULT_TIMEOUTS_MS`,
   `ReasoningInputError`, and a Zod schema for every input and output (`*Schema`).
   `createFakeProvider` takes an optional second `{now, timeoutsMs}` argument.
