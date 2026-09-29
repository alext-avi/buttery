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
| `REASONING_MODEL` | Default model for all functions. |
| `REASONING_MODEL_CANONICALIZE`, `_SHELF_LIFE`, `_PARSE`, `_RANK` | Per-function overrides. |

Model precedence for each function: per-function override → `REASONING_MODEL` → built-in
per-function default (`DEFAULT_MODELS`: `parseActivity` → `deepseek-ai/DeepSeek-V4-Pro`) →
`DEFAULT_MODEL` (`deepseek-ai/Deepseek-V4-Flash`). Explicit `createReasoningProvider(config)`
fields override env. The scripts load the
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
| Output hygiene | Before validation, fields that carry no information are dropped, without recording a violation: `""` ids, zero or negative numbers, `recipe_id`/`servings` on activities other than `cooked`, `to_location` on kinds that don't move food, and zero package fields. See the Crusoe notes for why. |
| Constrained choices | A `match.food_id` outside that line's candidates becomes `'new'`/`low`. Unknown or duplicate `line_id`s are dropped, and omitted lines are filled by the fallback. `parseActivity` drops unknown `lot_id`s (keeping `food_name`; each drop lowers confidence one level and adds a `"could not be matched to a known lot"` ambiguity, so the parse is never auto-applied against an invented lot), unknown `recipe_id`s and unknown ambiguity candidates. `rankRecipes` returns every candidate exactly once: unknown ids are dropped, duplicates removed, and missing ids appended in input order. Ideas are dropped when `include_ideas` is false. |
| Safety clamps | `SHELF_LIFE_DEFAULTS` holds 27 categories × 5 states with `{days, max}`. An estimate above `max` is clamped, including `null` ("no expiry") where a max exists, and its confidence drops one level. Missing requested states are filled from defaults. |
| Timeouts | 20 s for `canonicalizeItems`, 8 s for the others, covering the whole call including the repair. A timeout, network error, HTTP error or caller abort leads to the fallback. |
| Fallbacks | canonicalize: rule-based name, category and package, then exact alias → `high`, trigram ≥ 0.55 → `medium`, otherwise `'new'`/`low`. shelf life: the defaults table at `low` confidence. parse: no activities plus one `"couldn't parse"` ambiguity at `low`. rank: input order, empty explanations, no ideas. The final output is re-validated after guards on every path. Guarded model output that fails is replaced by the fallback, and a fallback that would fail is replaced by a minimal valid output, so only invalid *input* throws. |
| Cache | Key is `function:model:inputHash`. The default is in-memory per provider; `ctx.cache` overrides it. Hits return `path: 'cache'`. Only model and repair results are cached. Cache errors are never fatal: a failing `get` is a miss, and a failing `set` keeps the model result and its path. |
| Privacy | Input schemas strip unknown fields. Emails, phone numbers and street addresses in free-text strings are redacted before hashing, sending and recording. Id fields (`*_id`, `*_ids`) are left untouched. An address is a 2–6 digit house number, one to three capitalized words and a street suffix (`1234 Elm Street`); a number followed by a unit (`12 OZ DR PEPPER`) or lowercase text (`3 lb Lane cake`) is never an address. |

## Crusoe notes

Confirmed on 2026-09-29.

- **API:** OpenAI-compatible chat completions. Authentication is `Authorization: Bearer <CRUSOE_API_KEY>`.
- **Base URL:** `https://api.inference.crusoecloud.com/v1`. Unauthenticated `GET /models`
  returns `401 {"errors":["Authentication failed"]}`, so the endpoint is live.
  - `https://api.crusoe.ai/v1` appears in some search summaries, but it did not resolve when tested.
  - `managed-inference-api-proxy.crusoecloud.com/v1` is the batch-inference proxy.
- **Model IDs:** use the IDs from `GET /v1/models`, not the docs page. Several differ in
  prefix or case (the docs say `zai/GLM-5.3`, `qwen/Qwen3.8-27B`,
  `deepseek-ai/DeepSeek-V4-Flash`). Live list on 2026-09-29:
  `openai/gpt-oss-120b`, `Qwen/Qwen3.8-27B`, `deepseek-ai/DeepSeek-V4-Pro`,
  `deepseek-ai/Deepseek-V4-Flash`, `zai-org/GLM-5.3`, `zai-org/GLM-5.3-Flash`,
  `moonshotai/Kimi-K2.6`, `google/gemma-4-31b-it`, `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`,
  `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`, `nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B`,
  `nvidia/Nemotron-3.5-Lightning-30B-A3B`, `yutori/n2`.
- **API key type:** an **Intelligence API key** (console: Security → Intelligence API keys).
  Cloud API keys are for infrastructure and don't authenticate inference.
- **Structured output:** Crusoe serves every model with guided decoding, so
  `response_format: json_schema` works across the catalog
  ([Pydantic AI's Crusoe provider](https://pydantic.dev/docs/ai/models/crusoe/) relies on
  this). Verified live: every model tested accepted `json_schema`. The `json_object`
  downgrade above is defensive.
- **Guided-decoding quirks** (all verified live, and each handled in code):
  - *Numeric bounds break decimals.* With `exclusiveMinimum: 0`, "1/2 GAL" decodes as
    `size: 0`. Without the bound, or in `json_object` mode, the same request gives 0.5. The model
    schema therefore has `minimum`/`maximum`/`exclusive*` stripped, and Zod enforces them.
  - *Properties are emitted in schema order.* Optional keys the model skips can't be written
    later. For cooked rice with `states: [prepared, frozen]`, `frozen` was silently dropped by
    both models tried. `estimateShelfLife` now sends a per-call schema whose `per_state` lists
    exactly the requested states, in order, all required.
  - *Optional fields get filled rather than omitted:* `""`, `servings: 0`, and `recipe_id` on a
    "moved" activity. That's the reason for the output hygiene step.
- **Capacity:** `503 No capacity available, retry later` showed up intermittently for
  `google/gemma-4-31b-it` and `zai-org/GLM-5.3-Flash`, especially under parallel requests. It
  leads to the fallback like any other error.
- **Rate limits:** serverless endpoints can return `429`; Crusoe raises limits on request.
  The package does not retry (`maxRetries: 0`), because the timeout budget is small and the
  fallback is always available.

## Live results (2026-09-29)

### Eval: `npm run reasoning:eval`

The fixture has 13 receipt lines from two receipts. Each receipt is one batched
`canonicalizeItems` call with empty candidate lists. There are 46 scored fields: 11
`canonical_name`, 12 `category`, 13 `line_kind` and 10 `package`. The runs were sequential.

| Model | Overall | Latency (2 receipts) | Notes |
|---|---|---|---|
| **`deepseek-ai/Deepseek-V4-Flash`** | **46/46 (100%)** | **3.1–3.4 s** | ~1.6 s per receipt, ~500 output tokens |
| `deepseek-ai/DeepSeek-V4-Pro` | 46/46 (100%) | 6.0 s | |
| `openai/gpt-oss-120b` | 46/46 (100%) | 15.0 s | reasoning model, ~1.2–1.6k output tokens |
| `Qwen/Qwen3.8-27B` | 46/46 (100%) | 20.0 s | 15 s on the 7-line receipt, close to the 20 s limit |
| `zai-org/GLM-5.3-Flash` | 46/46 (100%) | 20.8 s | |
| `google/gemma-4-31b-it` | 46/46 (100%) | 25.2 s | intermittent 503s |
| `nvidia/Nemotron-3.5-Lightning-30B-A3B` | not scored | timeout | used all 4096 output tokens reasoning; both receipts timed out at 20 s |
| `moonshotai/Kimi-K2.6` | not scored | timeout | no response within 20 s |

Before the numeric-bounds fix, `Deepseek-V4-Flash` and `Qwen3.8-27B` failed validation on
"1/2 GAL" (`size: 0`), and those receipts fell back.

**Caveats:**
- The fixture is too easy to tell the fast models apart: every model that finished scored
  100%, so latency decided.
- The eval excludes lines from receipts that fell back, so fallback results can't inflate a
  model's score.
- The deterministic fallback also scores 46/46, but only because its abbreviation and keyword
  lists were written with these fixture lines in view. That says nothing about how it
  handles other receipts.
- A harder, held-out receipt set is the next step for model choice.

### Other functions

These were spot-checked live on DeepSeek Flash, DeepSeek Pro, `gpt-oss-120b`, GLM-5.3-Flash,
Qwen3.8-27B and Gemma. They're not a formal eval.

- **`estimateShelfLife`:** Flash takes ~0.7–1.2 s and returns sensible values (e.g. cooked rice
  prepared 4 d, frozen 180 d; whole milk sealed 7 d, opened 5 d). `gpt-oss-120b` takes ~2 s.
- **`parseActivity`** (five household notes against four lots, including two whole-milk lots):
  - DeepSeek Pro resolved every lot correctly in ~0.8–1.3 s. It flagged the ambiguous milk
    and lowered confidence.
  - Flash was as fast but missed the lot for "half the milk", and set `fraction: 0.5` for "some".
  - Gemma was accurate but took 2–4 s.
  - `gpt-oss-120b`, GLM-5.3-Flash and Qwen3.8-27B often exceeded the 8 s limit.
- **`rankRecipes`:** Flash took 1.7 s and `gpt-oss-120b` 2.3 s. Both put the recipe using the
  urgent spinach first, and wrote useful one-line explanations and three ideas.

### Recommended model per function

| Function | Model | Why |
|---|---|---|
| `canonicalizeItems` | `deepseek-ai/Deepseek-V4-Flash` | 100% on the eval, fastest by 2× |
| `estimateShelfLife` | `deepseek-ai/Deepseek-V4-Flash` | ~1 s; clamps catch any outliers |
| `parseActivity` | `deepseek-ai/DeepSeek-V4-Pro` | best lot resolution at ~1 s; its confidence drives auto-apply |
| `rankRecipes` | `deepseek-ai/Deepseek-V4-Flash` | fast; the deterministic order is the fallback anyway |

These are the built-in defaults. Avoid `Kimi-K2.6` and `Nemotron-3.5-Lightning` with the
current timeouts.

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
6. **Output hygiene before validation** (see Guardrails). The spec's validation step should
   note that non-informative fields are normalized away before Zod, not treated as
   invalid output.
7. **Per-function model defaults.** Section 6 says "one model is the default, with
   per-function overrides". The package also ships one built-in override
   (`parseActivity` → DeepSeek-V4-Pro). Env settings still win.
8. **Input shapes.** `canonicalizeItems` `hint.package` accepts the server's object
   `{count?, size?, unit?}` or a printed string (`"2X32 OZ"`); unusable values (zero, negative,
   non-finite, empty unit) are dropped rather than rejected. `estimateShelfLife` `states` are
   deduped (first occurrence wins).
9. **Additive exports:** `createFallbackProvider`, `createMemoryCache`, `configFromEnv`, `DEFAULT_MODEL`, `DEFAULT_MODELS`,
   `FOOD_CATEGORIES`, `FOOD_STATES`, `categoryDefaults`, `DEFAULT_TIMEOUTS_MS`,
   `ReasoningInputError`, and a Zod schema for every input and output (`*Schema`).
   `createFakeProvider` takes an optional second `{now, timeoutsMs}` argument.
