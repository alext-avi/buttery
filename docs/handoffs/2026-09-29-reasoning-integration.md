# Handoff: integrating `@buttery/reasoning` into the server

This note is for the thread building the server, database, MCP and web. The reasoning package lives
at `packages/reasoning` on branch `feat/reasoning-crusoe` (PR #1). Its README is the full
reference. This note covers what you need to wire it in correctly, with the decisions already made.

**Priority:** `canonicalizeItems` is the function that matters. Inventory, expiry, recipe coverage
and shopping lists are only as good as the item records it produces, and a wrong match silently
corrupts inventory. The other three functions work but are secondary; their fallbacks are
acceptable for the demo.

## 1. Setup

- **Dependency:** `"@buttery/reasoning": "*"` in your workspace's `package.json`. The root already
  has `"workspaces": ["packages/*", "apps/*"]`.
- **Loading:** the package ships TypeScript source (`exports` → `src/index.ts`) and relies on Node
  26's built-in type stripping. There's no build step. Vitest and tsx load it directly.
- **Env** (placeholders are in `.env.example`; the real key is in the gitignored `.env`):
  - `CRUSOE_API_KEY`: required for live calls. Without it, the provider is the offline fallback.
  - `REASONING_PROVIDER=fallback`: forces offline mode. Use it in CI and in tests.
  - Leave `CRUSOE_BASE_URL` and `REASONING_MODEL*` unset. The defaults are
    `deepseek-ai/Deepseek-V4-Flash`, with `deepseek-ai/DeepSeek-V4-Pro` for `parseActivity`.
- **One provider per process:**
  ```ts
  import { createReasoningProvider } from '@buttery/reasoning';
  export const reasoning = createReasoningProvider(); // reads env; in-memory cache by default
  ```
- **Credits:** keep an eye on them. Crusoe credits are limited and reserved for the demo. A receipt
  costs about $0.0006. Never run live calls in CI or in loops; use the fake or fallback provider.

## 2. The call shape (all four functions)

```ts
const { output, path, call, violations } = await reasoning.canonicalizeItems(input, { householdId, cache });
```

- **`output`** is always schema-valid, even when Crusoe is down. Never wrap calls in your own
  fallback logic.
- **`path`** is one of `'model' | 'repair' | 'cache' | 'fallback'`. With `'fallback'`, `call.error`
  says why (timeout, HTTP error or invalid output). Surface "estimated without the model" in the
  response if you like.
- **`call`** is a `ReasoningCallRecord`. **Persist it to `reasoning_calls`** and keep its id. Proposal
  ops, shelf-life values and parsed activities reference `reasoning_call_id` (spec Section 4).
  The field mapping:
  `function, provider, model, inputHash→input_hash, input, output, valid, latencyMs→latency_ms,
  tokensIn→tokens_in, tokensOut→tokens_out, error, createdAt→created_at`, plus `household_id`
  from your context.
- **`violations`** are human-readable strings for every correction code made to the model's
  output. Store them with the call or log them; they're good demo material ("model said 5 ct;
  printed size 5 DZ = 60 ct wins").
- **`ReasoningInputError`** is thrown only for invalid *input*. That's a server bug, so let it
  surface as a 500 in development.
- **Timeouts** are built in: 20 s for canonicalize, 8 s for the others. Real latency is about 0.3 s per
  receipt line (a 15-line receipt takes 4–6 s). Send one call per receipt; the package measured
  that splitting a receipt into parallel calls is no faster.

## 3. Receipts: `canonicalizeItems`

### 3.1 What you send

```ts
await reasoning.canonicalizeItems({
  lines: receiptLines.map((l, i) => ({
    line_id: `${observationId}:${i}`,     // any stable id; you'll get it back
    raw_text: l.text,                     // verbatim from the agent's transcription
    price_cents: l.priceCents,            // optional; negative helps detect coupons
    quantity: l.quantity,                 // optional, e.g. "2 @ 3.49" → 2
    hint: { food_name, package, location_guess }, // optional agent hints; package may be an object or "2X32 OZ"
  })),
  candidates: { [line_id]: shortlist },   // see 3.2
}, { householdId });
```

Only send food text, quantities, prices and dates. Never send user names, emails, store names or
addresses. The package strips unknown fields and redacts emails, phone numbers and street
addresses anyway, but don't rely on that.

### 3.2 Building the candidate shortlist (your job)

The model can only match a line to a food you list for that line. Anything else becomes `"new"`,
and the output records a violation. For each line:

1. **Alias fast path:** if the line's normalized text equals a food's learned alias, you already
   know the answer. Skip the model for that line and treat it as a `high` match. This is the
   spec's "learned aliases skip the model" rule, and it's what makes costs fall as the catalog
   grows. `standardizeCanonicalName` and the package's normalization are stable, so aliases stay
   consistent.
2. Otherwise, shortlist up to 4–5 of the household's foods: exact name, alias, then trigram
   similarity against `raw_text` (Postgres `pg_trgm` is fine). **Include look-alikes;** don't
   filter them out. The model is tuned to reject them: whole vs 2% milk, greek vs vanilla yogurt,
   brown vs white rice, egg whites vs eggs.
3. The candidate shape is `{ food_id, name, aliases, category, perishability }`. An empty or
   missing list is fine and means "new".

`scripts/demo.ts` (the `shortlist()` function) is a working reference: alias equality, then the
top trigram matches.

### 3.3 What you get back, and what to do with it

| Output field | Use |
|---|---|
| `canonical_name` | Already standardized: lowercase; no brand, "organic", size or fat ratio; variety kept ("2% milk"). Use it as the `foods.name` for new foods. |
| `category` | One of the 27 `FOOD_CATEGORIES` (the keys of `SHELF_LIFE_DEFAULTS`). **Use this list for `foods.category`** so shelf-life defaults and clamps line up. |
| `perishability` | Goes to `foods.perishability`. |
| `package` | `{count?, size?, unit?}`. `count` is the number of sub-packages (only for multipacks); `size`/`unit` are the amount per package. Goes to `lots.package` and to `foods.default_package` for new foods. See section 4. |
| `line_kind` | `item` → lot op. `coupon` → no lot; keep it on the receipt observation. `return` → reconcile against a matching lot before removing anything (spec). `non_food` → no lot. |
| `match.food_id` | A candidate id → add a lot to that food. `"new"` → a `create_food` op, then a lot. |
| `match.confidence` | Feeds the automation policy; see section 5. |
| `rationale` | At most about 8 words. Show it in the review UI next to the proposal. |

**On apply, learn the alias:** store the line's `raw_text` on the chosen food's `aliases`, as the
spec says. The next receipt with the same text takes the fast path.

**New foods need shelf life:** after creating a food, call `estimateShelfLife` once per food, not
per lot: `{ food_name, category, perishability, states: ['sealed','opened','frozen'], location }`.
Store each state in `foods.shelf_life_days` with `source: 'model_estimate'` and the
`reasoning_call_id`. Estimates are already clamped to category safety bounds, and a clamp lowers
confidence. User-entered values always win.

## 4. Units: the standard (please keep to it)

- **Vocabulary:** `package.unit` is always one of `PACKAGE_UNITS`:
  `g, kg, oz, lb, ml, l, fl_oz, gal, qt, pt, ct`. The schema enforces it on the model side too.
- **Printed sizes win:** if a size is printed on the line, the code parser's reading replaces the
  model's (`2.5#` → 2.5 lb, `52Z` → 52 oz, `HG` → 0.5 gal, `5 DZ` → 60 ct, `2/40OZ` → 2 × 40 oz,
  `12 PK … 12 FL OZ` → 12 × 12 fl_oz). A bare `2PK` sets only `count`. The model's package is
  used only when nothing parseable is printed.
- **Comparisons:** for coverage, shortfall and quantity math, compare base quantities, never raw
  units:
  ```ts
  import { toBaseQuantity, samePackage } from '@buttery/reasoning';
  toBaseQuantity({ count: 2, size: 32, unit: 'oz' }); // { amount: 1814.37, unit: 'g' }
  toBaseQuantity({ size: 0.5, unit: 'gal' });         // { amount: 1892.71, unit: 'ml' }
  ```
  Mass → g, volume → ml, count → ct. Mass↔volume needs `foods.density_g_per_ml` (spec).
- **Receipt `oz` on liquids is ambiguous.** "52Z" orange juice stays `oz` (mass). Treat it as
  `fl_oz` in the domain when the food is a liquid or has a density.
- `parsePackage(text)` is exported if you want the same parser for agent-typed quantities
  ("half gallon of 2% milk" → 0.5 gal, "a dozen" → 12 ct).

## 5. Automation policy (Section 7): what the eval supports

- **Receipts stay "review all" in slice 1,** as the spec says.
- When you add "auto-apply high confidence" later: on the held-out synthetic test set,
  `high`-confidence matches to an existing food were right **99.4%** of the time (100% on dev).
  `low`-confidence matches were right 0–40% of the time. So:
  - auto-apply only `high`;
  - show `medium` and `low` as suggestions that need a tap;
  - never auto-apply a `low` match.
- A `"new"` with high confidence is safe to propose as `create_food`. A missed match only creates
  a duplicate that can be merged, which is why the model prefers "new" when unsure.
- The overall test-split numbers are in the README ("Canonicalization eval"): 98.9% match
  accuracy, 0.9% wrong matches, 100% package, 100% category.

## 6. The other three functions (brief)

- **`parseActivity`** (`log_text`, web quick log):
  - Send `{ text, now, context: { lots, locations, recipes } }`, with lots in the compact shape
    `{lot_id, food_name, location, state, quantity_text}`.
  - Invented `lot_id`s are dropped, confidence is lowered, and an ambiguity is added.
  - Policy: apply only if `confidence === 'high'` and `ambiguities` is empty; otherwise review.
  - The fallback is "couldn't parse", with the text kept as an observation.
- **`estimateShelfLife`:** see 3.3. The fallback is the defaults table at `low` confidence.
- **`rankRecipes`** (`find_recipes`):
  - Send your deterministic top ~15 candidates plus the use-soon lots, with `urgency` one of
    `expired | urgent | soon`.
  - Every candidate comes back exactly once, with a one-line explanation, plus optional `ideas`
    when `include_ideas` is true.
  - The fallback is your own order, with empty explanations.

## 7. Caching

- The default in-memory cache is enough for the hackathon.
- For persistence across restarts, pass `ctx.cache` (or `config.cache`) implementing
  `{ get(key), set(key, value) }`. A key-value table is simplest:
  `reasoning_cache(key text primary key, value jsonb)`.
- The key is `function:model:inputHash`, and the value is opaque. Cache errors are never fatal.

## 8. Testing without credits

```ts
import { createFakeProvider, createFallbackProvider } from '@buttery/reasoning';

// Scripted replies still go through validation, guardrails and standards, as in production.
const reasoning = createFakeProvider({
  canonicalizeItems: (input: any) => ({ lines: input.lines.map((l: any) => ({
    line_id: l.line_id, canonical_name: 'eggs', category: 'eggs', perishability: 'perishable',
    line_kind: 'item', match: { food_id: 'new', confidence: 'high' }, rationale: 'test',
  })) }),
});
const offline = createFallbackProvider(); // deterministic, no network
```

- An array of script entries is consumed one per attempt, so `['{bad json', good]` exercises the
  repair path.
- An `Error` entry simulates an outage, which produces the fallback.

## 9. Handy commands

```sh
npm test -w packages/reasoning                        # offline unit tests
npm run reasoning:ping                                # one live call (uses credits; about $0.0001)
npm run demo -w packages/reasoning -- --file scripts/demo-receipt.txt --compare   # live demo
```

If you need a contract change, ask the reasoning thread rather than editing `packages/reasoning`.
It owns that directory, and pending proposals are listed in its README under "Proposed spec changes".
