# Buttery — Design Spec

Date: 2026-09-29
Status: Draft for review

## 1. Product definition

Buttery is a **household food ledger that agents operate**. People use it mainly through
AI agents (Claude on web/mobile/desktop, Claude Code, Codex, agentdock workers, any MCP
client). The application owns the authoritative records and the rules: what the household
believes it has, the evidence behind each belief, what changed and who changed it.
The connected agent does perception (reading photos, receipts, screenshots) and judgment
(choosing or inventing recipes). A small mobile web UI handles the things that are faster
by touch: reviewing proposals, correcting an item, following a recipe, checking off a list.

### Product principles

1. **Trustworthy beliefs over precise counts.** Quantities may be exact, approximate or
   unknown. Staples (salt, oil, flour…) are assumed present until marked out. The app
   surfaces stale beliefs instead of demanding constant confirmation.
2. **Evidence is not truth.** Observations (evidence), proposals (suggested changes) and
   changes (committed) are distinct records. A fridge photo never proves absence. A receipt
   proves a purchase, not what remains weeks later. A recipe ingredient never proves
   ownership.
3. **Perishability is first-class.** Every food is shelf-stable or perishable. Every
   expiry is either *printed* (recorded from packaging) or *estimated* (with its basis).
   "What should we use soon?" is a primary question, and recipe suggestions favor
   expiring items.
4. **Low-friction correction.** Every change is attributable and undoable. Retries and
   reprocessing never silently duplicate.
5. **Same rules everywhere.** MCP tools and the web UI call the same domain layer.

### MVP scope

**In:** inventory lots with provenance, uncertainty, perishability and printed/estimated
expiry; observation → proposal → change flow with undo and history; receipt
reconciliation; pantry/fridge photo proposals; direct activity logging (bought, cooked,
used, finished, discarded, froze, thawed, opened, moved); use-soon view; recipe capture,
editing and inventory-aware matching; shopping lists; compact state summary for fresh
agent conversations; four web views (review, inventory, recipe, shopping list);
household/member identity model.

**Out (for now):** barcode scanning, nutrition/macros, meal-plan calendars, grocery-store
APIs and price tracking, server-side LLM calls, native apps, push notifications, sharing
outside the household.

## 2. Key decisions

| Decision | Choice | Rationale / tradeoff |
|---|---|---|
| Image interpretation & recipe reasoning | **Connected agent.** The server validates, normalizes units, matches against the catalog and lots, computes coverage and shopping math, estimates expiry from rules, and enforces policy. | No server LLM keys or spend; works with any client; deterministic parts are testable. Cost: extraction quality varies by client model. A server-side extraction path for web-uploaded photos can be added later. |
| Image bytes | Agents send a structured transcription (e.g. receipt lines verbatim), which is the stored evidence. The original photo can optionally be attached from the review page (Phase 2). | MCP clients generally cannot forward a user's attached image to a tool as bytes. |
| Automation | **Server-enforced household policy** (Section 6). | Keeps MCP and web consistent; an agent cannot bypass review of photo inferences. |
| Duplicate protection | Idempotency keys + receipt fingerprints + optimistic item versions + shopping-completion reconciliation. | Agents don't reliably reuse keys on retry, so content-based dedup is also required. |
| Identity | Household = tenant; user = member; connection = OAuth client or personal access token tied to a user. Every change records actor user and client. MCP server is an **OAuth 2.1 resource server**; **WorkOS AuthKit** is the authorization server (supports Dynamic Client Registration for claude.ai connectors). PATs for CLIs and agentdock workers. | Multi-member households need no migration later. Avoids writing a custom authorization server. Alternative (embedded AS) rejected for security surface. |
| Web access | AuthKit login session as a long-lived cookie. Agents return plain deep links. | Links in chat history grant nothing by themselves. Object-scoped no-login links can be added later if phone login proves annoying. |
| Storage | **PostgreSQL 17** in a container. | Transactions spanning state + change log; unique constraints for idempotency/fingerprints; `SELECT … FOR UPDATE`; joins for coverage; `jsonb` for observation payloads. Row-level security available later for tenant isolation. |
| State model | Current-state tables + append-only change log written in the same transaction. Undo = compensating change set. | Full event sourcing rejected: rebuild/projection machinery without MVP benefit. |
| Hosting | Docker Compose (`app` + `postgres`) on this Mac, joined to the agentdock Docker network; public HTTPS via **Tailscale Funnel**. | Phone access from day one at zero cost. Risk: unavailable when the Mac sleeps; the container moves unchanged to an always-on host later. |

## 3. Architecture

```
Claude (web/mobile/desktop) ─┐
Claude Code / Codex CLI ─────┼── HTTPS (Tailscale Funnel) ──► app container ──► postgres container
agentdock workers ───────────┘      (docker network)            │
Phone browser (review links) ───────────────────────────────────┘
                                   AuthKit (OAuth AS, login)
```

Monorepo (npm workspaces, TypeScript, Node 26):

- **`packages/domain`** — Zod schemas and pure domain rules: quantity/unit math, expiry
  estimation, matching, coverage, policy evaluation, attention computation. Shared by the
  server and the web app (schemas for form validation).
- **`apps/server`** — Hono on Node.
  - `/mcp` — MCP Streamable HTTP (`@modelcontextprotocol/sdk`), bearer-token protected;
    `/.well-known/oauth-protected-resource` metadata pointing at AuthKit.
  - `/api/*` — JSON API for the SPA; session-cookie protected.
  - `/auth/*` — AuthKit login/callback/logout.
  - Static SPA with client-route fallback for deep links.
  - Services layer (application use cases) calls domain rules and repositories; both MCP
    tools and API handlers are thin adapters over the same services.
  - Drizzle ORM + SQL migrations.
- **`apps/web`** — React + Vite SPA, mobile-first. Routes: `/review/:proposalId`,
  `/inventory` (with `?view=use-soon&location=…` etc.), `/items/:lotId`,
  `/recipes/:recipeId`, `/lists/:listId`, `/settings` (tokens, preferences; minimal).
- **Tests** — Vitest for domain (pure) and services (against a real Postgres test
  database); MCP contract tests using the SDK client against the running server;
  Playwright for web views at a phone viewport.

Configuration via environment: `DATABASE_URL`, `PUBLIC_BASE_URL` (used for all links),
AuthKit client id/secret/domain, session secret.

## 4. Domain model

All tables carry `household_id`; all queries are household-scoped in the services layer.

### Identity

- `households(id, name, created_at)`
- `users(id, auth_subject, email, display_name)`
- `memberships(household_id, user_id, role: owner|member)`
- `connections(id, user_id, household_id, kind: oauth_client|pat, client_name, token_hash?, last_used_at, revoked_at)`
  — PATs are random tokens prefixed `btr_`, stored hashed.

First AuthKit login creates the user and a household where they are owner.
A user with several households has a default household; tools accept an optional
`household_id`.

### Catalog: `foods`

- `name`, `aliases[]` (normalized; receipt text such as `KS ORG EGGS 24CT` is learned as an alias on apply)
- `category` (e.g. dairy, eggs, poultry, leafy produce, condiment…)
- `perishability: shelf_stable | perishable`
- `shelf_life_days: {sealed?, opened?, frozen?, thawed?, prepared?}` each with
  `source: default_rule | agent_estimate | user`
- `default_location`, `default_package {count?, size?, unit?}`
- `is_staple` (assumed present unless marked out)
- `density_g_per_ml?` (enables volume↔mass conversion)

A built-in table provides category defaults (≈20 categories) for shelf life and
perishability. Agents may supply estimates when creating a food; they are stored with
`source: agent_estimate`.

### Inventory: `lots`

One row per purchase or batch; multiple lots of one food are normal.

- `food_id`, `location` (household-defined; defaults fridge, freezer, pantry, counter)
- `state: sealed | opened | frozen | thawed | prepared` (prepared = leftovers)
- `quantity: {kind: exact|approx|unknown, amount?, unit?}` and optional
  `package {count, size, unit}` so "half of a 1-gal jug" is expressible
- `expires: {on, kind: printed|estimated, basis}`; `printed_expiry_on?` retained separately
- `acquired_at`, `opened_at?`, `frozen_at?`, `thawed_at?`
- `last_evidence_at`, `last_evidence_observation_id`
- `status: active | depleted | discarded`
- `version` (incremented on every change)
- `notes`

**Effective expiry rule:**
- Sealed with a printed date → printed.
- Otherwise estimated: anchor + `shelf_life_days[state]`, where anchor is `acquired_at`
  (sealed), `opened_at` (opened), `frozen_at` (frozen), `thawed_at` (thawed), or the cook
  time (prepared). The basis string records the computation, e.g. `"opened 9/27 + 5d (default_rule)"`.
- Shelf-stable foods with no printed date have no expiry. Opening a shelf-stable food with
  an `opened` shelf life makes the lot perishable from that point (e.g. pasta sauce).
- Freezing keeps `printed_expiry_on` but switches the effective expiry to the frozen estimate.

**Staleness:** a perishable active lot with no evidence for `stale_after_days`
(preference; default 7) is flagged for verification. Shelf-stable lots are never stale by time alone.

### Evidence: `observations`

- `kind: receipt | pantry_photo | meal_photo | recipe_capture | user_statement | shopping_completion | web_correction`
- `observed_at` (when it was true), `recorded_at`, `actor_user_id`, `connection_id`
- `payload jsonb` validated per kind. Receipt payload: `store, purchased_at, receipt_number?, total_cents?, lines[{raw_text, description?, quantity?, unit_price_cents?, price_cents?, interpretation{food_name, category?, perishability?, package?, location_guess?, shelf_life_estimate_days?, is_food}}]`
- `fingerprint?` — receipts: hash of normalized store + purchased_at (to the minute) +
  total_cents + receipt_number if present; unique per household
- `attachment_id?`, `status: open | resolved`

### Proposed changes: `proposals`, `proposal_ops`

- `proposals(id, observation_id, status: pending|partial|applied|rejected|superseded, created_at)`
- `proposal_ops(id, proposal_id, seq, op, target_lot_id?, target_food_id?, payload jsonb, confidence: high|medium|low, rationale, candidates jsonb, based_on_version?, decision: pending|accepted|edited|rejected|conflict, result_change_set_id?)`
- Op types: `add_lot`, `create_food`, `add_alias`, `adjust_quantity`, `consume`,
  `discard`, `move`, `open`, `freeze`, `thaw`, `set_expiry`, `confirm_present`,
  `flag_not_seen`, `confirm_purchase`, `ignore_line`.

### Committed changes: `changes`

Append-only.
- `id, change_set_id, household_id, op, lot_id?, food_id?, before jsonb, after jsonb, cause_observation_id?, cause_proposal_op_id?, actor_user_id, connection_id, idempotency_key?, created_at, reverted_by_change_set_id?`
- **Undo:** a change set can be reverted if every affected lot's current `version` equals
  its `after` version; the revert is a new change set of compensating changes. Otherwise
  undo is refused with the conflicting lots listed.

### Recipes: `recipes`, `recipe_revisions`

- `title, source {kind: url|screenshot|book|generated|user, ref?, captured_at}, servings, time_active_min?, time_total_min?, effort: easy|medium|involved?, diet_tags[], notes`
- `ingredients[{id, raw_text, food_id?, amount?, unit?, optional, group?, origin, substitutions[{food_id?, text, note?, origin}]}]`
- `steps[{text, origin}]`
- `origin` per field/item: `extracted | generated | user_edited`
- Every update writes a `recipe_revisions` row (full snapshot, actor, timestamp).

### Shopping: `shopping_lists`, `list_items`

- `shopping_lists(id, name, status: active|archived)`
- `list_items(id, list_id, food_id?, text, quantity?, unit?, reasons jsonb [{recipe_id?, need_text}], priority: essential|optional|check_first, status: needed|got|removed, updated_by, updated_at)`
- **`got` means "in the cart / acquired for this list" and never changes inventory.**
  Inventory changes only through `complete_shopping` or a receipt.

### Idempotency: `idempotency_records`

`(household_id, tool, key)` unique; stores the request hash and response. Same key with the
same request → stored response. Same key with a different request → error
`idempotency_key_reused`.

### Attention (computed, not stored)

Pending/partial proposals; expired and expiring-soon lots; stale perishables; unknown
quantities needed by a list or recipe in progress; unmatched or ignored receipt lines
awaiting a decision; undo/version conflicts; `flag_not_seen` signals.

### Units and coverage

- Quantities are normalized to mass (g), volume (ml) or count. Conversion only within a
  dimension, or across mass/volume when the food has `density_g_per_ml`.
- Package-based quantities convert via package size when known.
- Coverage per ingredient: `covered | partial | missing | uncertain | staple_assumed`.
  Incompatible or unknown quantities yield `uncertain`, never a guess.

### Lot selection rule (used everywhere consumption happens)

When an activity names a food with several active lots: prefer the lot with the earliest
effective expiry, then the earliest `acquired_at`. The chosen lot and the assumption are
reported in the response.

## 5. MCP interface

The server's MCP `instructions` explain the operating model to every client: start with
`get_household_summary`; never infer absence from a photo; use `log_activity` for clear
user statements and `submit_observation` for interpretations of images; always give the
user the returned review link; report lot-selection assumptions and offer undo.

### Response conventions

- Compact by default; `detail: true` expands.
- Quantities returned both structured and as readable text (`"~½ gal (photo, 9/27)"`).
- Every result includes `links` (absolute URLs under `PUBLIC_BASE_URL`), `uncertainties`,
  and `next` hints.
- Every state-changing tool requires `idempotency_key`.

### Tools (21)

**Identity**
- `whoami` — user, household(s), connection, preferences digest.

**State**
- `get_household_summary` — counts by location; top use-soon items (with printed/estimated
  flag); attention counts with links; pending reviews; active shopping list; last 5 change
  sets; preferences. Target ≤ ~2k tokens.
- `search_inventory(query?, location?, perishability?, expiring_within_days?, needs_attention?, include_depleted?, sort: expiry|location|recent)`
- `get_item(lot_id | food_id)` — detail, evidence trail, change history.
- `get_attention(kind?)` — grouped attention items with links.
- `get_changes(since?, lot_id?, change_set_id?, limit?)`

**Observations and changes**
- `submit_observation(kind, observed_at, payload, location?, idempotency_key)` → `{observation, proposal, duplicate_of?, review_url, auto_applied[]}`
- `log_activity(kind: bought|cooked|used|finished|discarded|froze|thawed|opened|moved, items[{food|lot_id, quantity?, to_location?}], recipe_id?, servings?, leftovers?, note?, idempotency_key)`
  → applied change set + undo handle + assumptions; unresolved parts go to attention.
- `resolve_proposal(proposal_id, decisions[{op_id, accept|reject|edit, edits?}]?, apply: bool, idempotency_key)`
- `correct_item(lot_id, fields, reason, idempotency_key)`
- `undo(change_set_id, idempotency_key)`
- `upsert_food(food, idempotency_key)` — aliases, perishability, shelf life, staple flag, density.

**Recipes**
- `save_recipe(recipe, source, idempotency_key)` → id + link
- `update_recipe(recipe_id, patch, idempotency_key)` → new revision
- `get_recipe(recipe_id, servings?)` → scaled recipe + coverage + link
- `find_recipes(query?, max_total_min?, effort?, diet_tags?, prioritize_expiring=true, limit?)`
  → ranked saved recipes with coverage and which expiring lots each would use.

**Shopping**
- `build_shopping_list(recipes[{recipe_id, servings}], list_id?, include_optional=false, idempotency_key)`
- `get_shopping_list(list_id?)` (default: active list)
- `update_shopping_list(list_id, ops[{add|remove|set_status|edit}], idempotency_key)`
- `complete_shopping(list_id, idempotency_key)` → `shopping_completion` observation → approximate purchase lots

**Preferences**
- `set_preferences(patch, idempotency_key)`

### Recipe ranking

Score = coverage (fraction of essential ingredients `covered`/`staple_assumed`, partial
counts half) + expiring bonus (weighted by urgency of lots used) − penalty for `missing`
essentials; filtered by time/effort/diet. Returned with the per-ingredient breakdown so the
agent can explain. Generated ideas are the agent's; saving one sets `source.kind = generated`.

## 6. Automation policy (household preferences, server-enforced)

| Source | Default | Notes |
|---|---|---|
| `log_activity` (direct statement) | Apply | Ambiguity (multiple lots) resolved by lot-selection rule and reported; no match → nothing applied, candidates returned. |
| `log_activity cooked` consumption | Apply as approximate | Quantities marked `approx`; unit-incompatible or ambiguous ingredients go to attention. |
| Receipt | **Review all** (slice 1) | Later option: auto-apply `high` confidence ops, review the rest. |
| Pantry/fridge photo | Review | `flag_not_seen` never depletes a lot. |
| Meal photo | Review | Low-confidence consumption only. |
| `complete_shopping` | Apply as approximate | Receipts later produce `confirm_purchase` ops. |
| Web corrections | Apply | Recorded as `web_correction` observation. |

Use-soon windows (defaults): **urgent ≤ 2 days**, **soon ≤ 7 days**, plus expired.
`stale_after_days` default 7.

## 7. Workflows

**W1 Receipt intake (slice 1).** User shares a Costco receipt → agent transcribes lines
verbatim with interpretations → `submit_observation(receipt)` → server fingerprints,
matches aliases/foods/lots, builds a proposal (`add_lot`, `create_food`+`add_lot`,
`ignore_line` for non-food, `confirm_purchase` when a recent shopping completion matches) →
responds with counts and `review_url` → review page shows raw line ↔ interpretation with
inline edits for food, quantity, location, expiry → apply → aliases learned.
*Mistakes:* same receipt again → `duplicate_of` + same link, nothing new; retry → stored
response; wrong match → edit in review, or `correct_item`/`undo` after commit; partial
review → accepted ops applied, rest stay pending in attention; refund/return lines →
flagged, not applied.

**W2 Fresh conversation.** `get_household_summary` answers what's available, what's
expiring, what's pending; `search_inventory`/`get_item` answer why we believe it.

**W3 Direct statements.** "Threw out the spinach", "moved the chicken to the freezer",
"finished the milk" → `log_activity` → applied with undo; freezing/opening recomputes
estimated expiry with a recorded basis. *Mistakes:* multiple lots → lot-selection rule,
assumption reported; no match → candidates returned, agent asks.

**W4 Fridge/pantry photo.** Agent lists visible items with approximate levels and readable
dates → proposal of `confirm_present`, approximate `adjust_quantity`, low-confidence
`add_lot`, `set_expiry` (printed), `flag_not_seen` for expected perishables in that
location → review link.

**W5 What to cook.** "Something in 30 minutes using what's expiring" →
`find_recipes(prioritize_expiring, max_total_min=30)` plus summary use-soon → agent ranks,
may add generated ideas labeled as such.

**W6 Recipe capture.** Screenshot → agent extracts → `save_recipe(source=screenshot,
origin=extracted)` → recipe link; web edits create revisions; unmapped ingredients allowed.

**W7 Shopping.** Select recipes → `build_shopping_list` (on-hand excluded, uncertain →
`check_first`, optional listed separately) → list link → check off in store (`got`, list
only) → `complete_shopping` → approximate lots → later receipt → `confirm_purchase` ops set
exact quantity/price. *Mistakes:* uncheck has no side effects; items not bought stay `needed`.

**W8 Cooked.** `log_activity(cooked, recipe_id, servings)` → approximate consumption via
lot-selection rule; optional leftovers lot (`prepared`, estimated expiry) → ambiguous
ingredients to attention. *Mistakes:* "only used half the chicken" → `correct_item` or `undo`.

**W9 Meal photo (Phase 5).** Low-confidence consumption proposals plus suggestions.

## 8. Web views

All mobile-first, reachable by deep link, minimal navigation (a small top bar: Inventory ·
Lists · Recipes).

- **Review** `/review/:proposalId` — observation header (source, time, who, via which
  client); ops grouped (new foods, matched, needs decision, ignored); per-op inline edit;
  Accept all / apply selected; conflicts shown inline.
- **Inventory** `/inventory` — default view "Use soon" (expired / urgent / soon, each lot
  with printed/est badge and evidence age), then by location; quick actions per lot
  (used up, discard, move, freeze, correct quantity); filter by location/perishability/attention.
- **Item** `/items/:lotId` — belief, evidence trail, history, undo.
- **Recipe** `/recipes/:id?servings=n` — ingredients with coverage badges, substitutions
  (origin labeled), missing items with "add to list", steps, source; edit mode.
- **Shopping list** `/lists/:id` — checklist grouped essential / check-first / optional;
  tap to toggle `got`; add item; "Done shopping" (explains that it records approximate
  purchases).

## 9. Phased plan and acceptance criteria

**Phase 0 — Foundations.** Monorepo; Compose (app + postgres) on the agentdock network;
migrations; identity tables; AuthKit OAuth + protected-resource metadata; PAT creation via
CLI script; `whoami`; Tailscale Funnel.
✅ `docker compose up` works from a clean checkout. ✅ Claude Code calls `whoami` with a
PAT. ✅ An agentdock worker calls `whoami` with a PAT. ✅ claude.ai custom connector
completes OAuth via the Funnel URL and `whoami` works from the phone.

**Phase 1 — Receipt slice.** Foods, lots, observations, proposals, changes, idempotency;
`submit_observation(receipt)`, `resolve_proposal`, `undo`, `get_household_summary`,
`search_inventory`, `get_item`, `upsert_food`; review and inventory views; category shelf-life defaults.
✅ A real Costco receipt shared from the phone yields a review link that opens on the phone.
✅ Edit one line, reject one, apply → inventory shows lots with estimated expiries labeled "est."
✅ Resubmitting the same receipt creates nothing new (automated test).
✅ Retrying apply creates no duplicate changes (automated test).
✅ Undo restores prior state; history shows both change sets.
✅ A fresh Claude conversation and a Codex task via agentdock both answer "what's expiring this week" using only the summary.
✅ A second receipt with the same items matches via learned aliases at high confidence.

**Phase 2 — Activity, corrections, use-soon.** `log_activity`, `correct_item`,
`get_attention`, `get_changes`, `set_preferences`; expiry recomputation on
open/freeze/thaw; pantry-photo proposals; use-soon view; optional photo attachment on review.
✅ "Froze the chicken" changes its effective expiry with a recorded basis and is undoable.
✅ A fridge photo produces `flag_not_seen` without depleting anything.
✅ Use-soon lists fridge perishables by urgency with printed/est badges.

**Phase 3 — Recipes.** `save_recipe`, `update_recipe`, `get_recipe`, `find_recipes`;
recipe view with scaling, substitutions, missing items.
✅ A screenshot becomes a saved recipe with source preserved.
✅ A web edit creates a revision.
✅ Unit tests cover coverage and conversion, including incompatible → `uncertain`.
✅ `find_recipes` names the expiring lots each recipe uses and ranks accordingly.

**Phase 4 — Shopping.** `build_shopping_list`, `get/update_shopping_list`,
`complete_shopping`; checklist view; `confirm_purchase` reconciliation.
✅ A list from two recipes excludes on-hand items, marks uncertain as check-first, separates optional.
✅ Checking off does not change inventory (automated test).
✅ A receipt after completion confirms purchases without duplicating lots.

**Phase 5 — Cooking and meal photos.** Cooked consumption, leftovers, meal-photo proposals.
✅ Cooking for 4 draws down expiring lots first. ✅ Leftovers appear in use-soon.
✅ Mistaken consumption is fixable by correction or undo.

**Phase 6 — Household sharing.** Invites, second member, per-person attribution in history
and review views. (Identity model already supports it.)

## 10. Risks and open questions

- **Mac availability:** Funnel URL is down when the Mac sleeps. Mitigation: move the
  container to an always-on host when daily use starts.
- **Receipt transcription quality** varies by client model; alias learning and the review
  step contain the damage. Measure match rates on real Costco receipts in Phase 1.
- **AuthKit + claude.ai connector compatibility** is validated first in Phase 0 before
  domain work depends on it; fallback is an embedded minimal authorization server.
- **Tool count (21)** may be more than some clients handle well; revisit after Phase 3 by
  observing agent tool-selection errors.
