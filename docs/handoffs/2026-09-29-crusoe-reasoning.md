# Handoff: Crusoe reasoning module (`packages/reasoning`)

You are building one isolated package of **Buttery**, an agent-first household food ledger.
Another thread is building the rest of the app (server, database, MCP, web) in parallel.
Your package is the only place the app talks to an LLM, so the contract below matters more
than internal polish.

## Read first

- `docs/superpowers/specs/2026-09-29-buttery-design.md`. **Section 6 (Reasoning module)** is
  your spec. Also read Section 2 (the trust-boundary rows), Section 4 (`foods.shelf_life_days`,
  `lots.expires`, `reasoning_calls`) and Section 7 (automation policy) for context.
- `tests/fixtures/food-images/README.md` and `sources/expected-text.json` for the eval.

## Scope

**In:** `packages/reasoning/**`. You may also make these root-level edits: add `"workspaces": ["packages/*", "apps/*"]`
to the root `package.json` if it isn't there, add root scripts `reasoning:ping` and
`reasoning:eval`, update `package-lock.json`, and add `.env.example` entries.

**Out:** database, server, MCP, domain package, web UI. Don't edit the spec. Record discoveries
and any contract changes you need in `packages/reasoning/README.md` under **Crusoe notes** and
**Proposed spec changes**.

## Stack

TypeScript (ESM, strict), Node 26, Zod, Vitest. Use the `openai` npm client pointed at Crusoe's
base URL **if** Crusoe Managed Inference is OpenAI-compatible. Check Crusoe's current docs
first: base URL, auth header, model IDs, and whether `response_format: json_schema` (or
`json_object`) is supported. If it isn't OpenAI-compatible, write a thin `fetch` client.
Record what you found in the README.

## Public contract (the other thread integrates against this — keep it stable)

```ts
export function createReasoningProvider(config?: ReasoningConfig): ReasoningProvider; // default: from env
export function createFakeProvider(script: FakeScript): ReasoningProvider;             // for tests
export { SHELF_LIFE_DEFAULTS } from './shelfLifeDefaults';                             // ~20 categories

export interface ReasoningProvider {
  canonicalizeItems(input: CanonicalizeInput, ctx?: CallContext): Promise<ReasoningResult<CanonicalizeOutput>>;
  estimateShelfLife(input: ShelfLifeInput, ctx?: CallContext): Promise<ReasoningResult<ShelfLifeOutput>>;
  parseActivity(input: ParseActivityInput, ctx?: CallContext): Promise<ReasoningResult<ParseActivityOutput>>;
  rankRecipes(input: RankRecipesInput, ctx?: CallContext): Promise<ReasoningResult<RankRecipesOutput>>;
}

export interface CallContext { householdId?: string; signal?: AbortSignal; cache?: ReasoningCache; }
export interface ReasoningCache { get(key: string): Promise<unknown | undefined>; set(key: string, value: unknown): Promise<void>; }

export interface ReasoningResult<T> {
  output: T;                                   // always schema-valid, even on fallback
  path: 'model' | 'repair' | 'cache' | 'fallback';
  call: ReasoningCallRecord;                   // the server persists this to reasoning_calls
  violations: string[];                        // guardrail corrections applied (see below)
}

export interface ReasoningCallRecord {
  function: 'canonicalizeItems' | 'estimateShelfLife' | 'parseActivity' | 'rankRecipes';
  provider: 'crusoe' | 'fallback' | 'fake';
  model: string | null;
  inputHash: string;                           // sha256 of canonical JSON input
  input: unknown; output: unknown; valid: boolean;
  latencyMs: number; tokensIn: number | null; tokensOut: number | null;
  error: string | null; createdAt: string;     // ISO
}
```

The package **never touches a database**. It returns call records, and caching goes through the
injected `ReasoningCache` (the default is in-memory). Export Zod schemas for every input and
output type too.

### Function schemas

Field names are snake_case to match the spec's JSON.

- **canonicalizeItems**
  - in: `{ lines: [{ line_id, raw_text, quantity?, price_cents?, line_kind?, hint?: { food_name?, package?, location_guess? } }], candidates: { [line_id]: [{ food_id, name, aliases[], category, perishability }] } }`
  - out: `{ lines: [{ line_id, canonical_name, category, perishability: 'shelf_stable'|'perishable', package?: { count?, size?, unit? }, line_kind: 'item'|'coupon'|'return'|'non_food', match: { food_id: string | 'new', confidence: 'high'|'medium'|'low' }, rationale }] }`
  - Receipts are batched into one model call.
- **estimateShelfLife**
  - in: `{ food_name, category?, perishability?, states: ('sealed'|'opened'|'frozen'|'thawed'|'prepared')[], location?, anchor_date? }`
  - out: `{ per_state: { [state]: { days: number | null, confidence } }, rationale }` (`null` = no meaningful expiry)
- **parseActivity**
  - in: `{ text, now, context: { lots: [{ lot_id, food_name, location, state, quantity_text }], locations: string[], recipes: [{ recipe_id, title }] } }`
  - out: `{ activities: [{ kind: 'bought'|'cooked'|'used'|'finished'|'discarded'|'froze'|'thawed'|'opened'|'moved', items: [{ lot_id?, food_name?, quantity?: { kind: 'exact'|'approx'|'unknown', amount?, unit?, fraction? }, to_location? }], recipe_id?, servings? }], ambiguities: [{ text, reason, candidate_lot_ids[] }], confidence }`
- **rankRecipes**
  - in: `{ candidates: [{ recipe_id, title, score, coverage_summary, expiring_lots_used: [{ lot_id, food_name, expires_on, urgency }] }], use_soon: [...], constraints: { max_total_min?, effort?, diet_tags? }, include_ideas: boolean }`
  - out: `{ ranked: [{ recipe_id, explanation }], ideas: [{ title, uses: string[], why, est_total_min? }] }`

## Guardrails (all required, all tested)

1. **Structured output:** use the strongest structured-output mode Crusoe supports, then
   validate with Zod. On failure, make **one repair retry** that includes the validation errors.
   If that also fails, use the fallback and set `path: 'fallback'`.
2. **Constrained choices:**
   - `match.food_id` must be one of that line's candidates or `'new'`. Otherwise coerce it to
     `'new'` with `low` confidence and record a violation.
   - `parseActivity` `lot_id`s must come from `context.lots`. Otherwise drop the id, keep
     `food_name`, and record a violation.
   - `rankRecipes` must return each candidate exactly once. Unknown ids are dropped, and missing
     ones are appended in the input order.
3. **Safety clamps:** `SHELF_LIFE_DEFAULTS` holds default and max days per category and state.
   Estimates above the max are clamped and their confidence drops one level (violation recorded).
4. **Timeouts:** 20s for `canonicalizeItems`, 8s for the others (AbortController). A timeout or
   network error leads to the fallback.
5. **Fallbacks (the `fallback` provider, also used internally):**
   - canonicalize: normalized-string and trigram match against candidates; below the threshold → `'new'`/`low`
   - shelf life: the defaults table
   - parse: `activities: []` plus one ambiguity `"couldn't parse"` and confidence `low`
   - rank: input order, empty explanations, no ideas
6. **Cache** key: `function:model:inputHash`. Cache hits return `path: 'cache'`.
7. **Privacy:** send only food text, quantities, dates, locations and recipe titles, never
   user names, emails or store addresses.

## Configuration (env)

- `REASONING_PROVIDER=crusoe|fallback` (default `crusoe` when `CRUSOE_API_KEY` is set, otherwise `fallback`)
- `CRUSOE_API_KEY`, `CRUSOE_BASE_URL`
- `REASONING_MODEL` (default model)
- Per-function overrides: `REASONING_MODEL_CANONICALIZE`, `REASONING_MODEL_SHELF_LIFE`,
  `REASONING_MODEL_PARSE`, `REASONING_MODEL_RANK`

Never commit keys. `.env` is gitignored; add placeholders to `.env.example`.

## Scripts

- `npm run reasoning:ping`: one tiny `estimateShelfLife` call. Prints model, latency, path and
  the validated output. Exits non-zero unless `path` is `model` or `repair`.
- `npm run reasoning:eval [--model X]`: runs the receipt lines from
  `tests/fixtures/food-images/sources/expected-text.json` through `canonicalizeItems` with empty
  candidate lists. Scores `canonical_name`, `category`, `line_kind` and `package` against the
  expected values, and prints per-line results plus accuracy. Send the model **only** the raw
  receipt line text, never expected values, annotations or the manifest (the fixture README's
  evaluation rule).

## Tests (Vitest, no network by default)

- Every guardrail above, using a mocked HTTP layer: invalid JSON → repair → success; repair
  fails → fallback; invented `food_id` → coerced; clamp lowers confidence; timeout → fallback;
  cache hit; rank de-duplicates and appends.
- Fallback provider behavior for each function.
- `createFakeProvider` returns scripted outputs that are still schema-validated.
- Live smoke tests run only when `CRUSOE_API_KEY` is set (`describe.skipIf`).

## Git

Work on branch `feat/reasoning-crusoe`, ideally in a separate worktree. Make small commits,
push, and open a PR to `main` titled "Reasoning module (Crusoe)". The PR body should cover:
- the Crusoe facts you confirmed
- models tried and eval accuracy
- any proposed spec changes

## Done when

- [ ] `npm test -w packages/reasoning` passes with no network.
- [ ] `npm run reasoning:ping` succeeds against Crusoe with a real key.
- [ ] `npm run reasoning:eval` prints accuracy for at least one Crusoe model; results go in the README.
- [ ] Setting `REASONING_PROVIDER=fallback` makes all four functions return schema-valid output.
- [ ] The README documents the confirmed base URL, model IDs, structured-output support,
      recommended model per function, and any proposed spec changes.
