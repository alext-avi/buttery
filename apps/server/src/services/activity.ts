import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { ReasoningInputError } from '@buttery/reasoning';
import {
  ACTIVITY_KINDS,
  applyActivity,
  computeEffectiveExpiry,
  describeExpiry,
  describeQuantity,
  exactAliasMatch,
  IdempotencyKeySchema,
  IsoDateSchema,
  LotStateSchema,
  normalizeName,
  normalizeUnit,
  pickLot,
  QuantitySchema,
  shortlist,
  todayIn,
  type ActivityKind,
  type AmountChange,
  type IsoDate,
  type LotFacts,
  type LotState,
  type Quantity,
  type ShelfLifeMap,
} from '@buttery/domain';
import type { Db, Tx } from '../db/client';
import { changeSets, changes, connections, foods, lots, observations, users, type FoodRow, type LotRow } from '../db/schema';
import { AppError, notFound } from '../errors';
import type { AppDeps } from '../http/app';
import type { Principal } from '../identity/principal';
import { createInterimReasoning } from '../reasoning/interim';
import type { ParseActivityOutput, ReasoningResult, ShelfLifeOutput } from '../reasoning/port';
import { persistReasoningCall } from '../reasoning/record';
import { addLot, createOrReuseFood, openChangeSet, recordChange, updateLot, type ChangeSetHandle } from './changes';
import { defaultLocationFor } from './drafts';
import { findIdempotent, runIdempotent } from './idempotency';
import { getHousehold } from './identity';
import { makeLinks } from './links';
import { toLotView } from './views';

type Deps = Pick<AppDeps, 'db' | 'config' | 'reasoning'>;
const interim = createInterimReasoning();

// ---------- input schemas ----------

const ActivityQuantitySchema = z
  .object({
    kind: z.enum(['exact', 'approx', 'unknown']).default('approx'),
    amount: z.number().nonnegative().optional(),
    unit: z.string().max(20).optional(),
    fraction: z.number().min(0).max(1).optional().describe('Share of the item, e.g. 0.5 for "half"'),
  })
  .describe('For "used": a share (fraction) or an amount with a unit. Omit if unknown.');

const ActivityItemSchema = z
  .object({
    lot_id: z.uuid().optional().describe('A specific item, from search_inventory or get_household_summary'),
    food_name: z.string().min(1).max(100).optional().describe('Or the food by name; Buttery picks the item expiring first'),
    quantity: ActivityQuantitySchema.optional(),
    to_location: z.string().min(1).max(40).optional().describe('For "moved" (and optionally froze/thawed)'),
  })
  .refine((i) => i.lot_id || i.food_name, 'lot_id or food_name is required');

export const LogActivityInputSchema = z.object({
  activities: z
    .array(z.object({ kind: z.enum(ACTIVITY_KINDS), items: z.array(ActivityItemSchema).min(1).max(20) }))
    .min(1)
    .max(20),
  note: z.string().max(500).optional(),
  idempotency_key: IdempotencyKeySchema,
});
export type LogActivityInput = z.input<typeof LogActivityInputSchema>;
type ActivityItem = z.infer<typeof ActivityItemSchema>;
type Activity = { kind: ActivityKind; items: ActivityItem[] };

export const LogTextInputSchema = z.object({
  text: z.string().min(1).max(1000).describe("The user's own words, verbatim"),
  idempotency_key: IdempotencyKeySchema,
});

export const CorrectItemInputSchema = z.object({
  lot_id: z.uuid(),
  quantity: QuantitySchema.optional(),
  location: z.string().min(1).max(40).optional(),
  expires_on: IsoDateSchema.nullable().optional().describe('Date printed on the package; null clears it'),
  state: LotStateSchema.optional(),
  reason: z.string().max(300).optional(),
  idempotency_key: IdempotencyKeySchema,
});

export const GetChangesInputSchema = z.object({
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

// ---------- results ----------

type Side = { location: string; state: string; status: string; quantity_text: string; expiry_text: string };
export type AppliedStep = { kind: ActivityKind; lot_id: string; food_name: string; summary: string; before: Side | null; after: Side };
export type Unresolved = { kind: ActivityKind; food_name: string | null; lot_id: string | null; reason: string; candidates: Array<{ lot_id: string; food_name: string; location: string; quantity_text: string }> };
export type ActivityResult = {
  change_set_id: string | null;
  applied: AppliedStep[];
  assumptions: string[];
  unresolved: Unresolved[];
  notes: string[];
  undo: { change_set_id: string } | null;
  next: string[];
};

// ---------- helpers ----------

type ActiveRow = { lot: LotRow; food: FoodRow };
const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const facts = (l: LotRow): LotFacts => ({
  state: l.state,
  location: l.location,
  quantity: l.quantity,
  package: l.package ?? null,
  status: l.status,
  acquiredOn: l.acquiredOn,
  openedOn: l.openedOn,
  frozenOn: l.frozenOn,
  thawedOn: l.thawedOn,
  printedExpiryOn: l.printedExpiryOn,
});
const side = (l: LotFacts & { expires?: LotRow['expires'] }, today: IsoDate): Side => ({
  location: l.location,
  state: l.state,
  status: l.status,
  quantity_text: describeQuantity(l.quantity, l.package),
  expiry_text: describeExpiry(l.expires ?? null, today),
});

function toAmount(q: ActivityItem['quantity']): AmountChange | undefined {
  if (!q) return undefined;
  if (q.fraction !== undefined) return { fraction: q.fraction };
  if (q.amount === undefined) return undefined;
  const unit = normalizeUnit(q.unit) ?? 'count';
  return { quantity: { kind: q.kind, amount: q.amount, unit } };
}

/** Foods a name could mean: exact/alias first, then containment and trigram similarity. */
function matchFoods(name: string, catalog: FoodRow[]): FoodRow[] {
  const exact = exactAliasMatch(name, catalog);
  if (exact) return [exact];
  const n = normalizeName(name);
  const containing = catalog.filter((f) => f.normalizedName.includes(n) || n.includes(f.normalizedName));
  if (containing.length) return containing;
  return shortlist(name, catalog, 5, 0.35);
}

async function estimate(deps: Deps, householdId: string, food: { name: string; category: string | null; perishability: FoodRow['perishability'] }, states: LotState[]) {
  const input = { food_name: food.name, ...(food.category ? { category: food.category } : {}), perishability: food.perishability, states };
  let result: ReasoningResult<ShelfLifeOutput>;
  try {
    result = await deps.reasoning.estimateShelfLife(input, { householdId });
  } catch (err) {
    if (err instanceof ReasoningInputError) throw err;
    result = await interim.estimateShelfLife(input);
  }
  const id = randomUUID();
  const source = result.path === 'fallback' ? ('default_rule' as const) : ('model_estimate' as const);
  const map: ShelfLifeMap = {};
  for (const [state, v] of Object.entries(result.output.per_state)) {
    if (!v || (v.days === null && result.path === 'fallback')) continue;
    map[state as LotState] = { days: v.days, confidence: v.confidence, source, ...(result.call.model ? { model: result.call.model } : {}), reasoning_call_id: id };
  }
  return { id, result, map };
}

// ---------- prepare (reads + reasoning, no writes) ----------

type Step =
  | { type: 'update'; kind: Exclude<ActivityKind, 'bought'>; lot: LotRow; food: FoodRow; next: LotFacts & { expires: LotRow['expires'] }; notes: string[] }
  | { type: 'add'; kind: 'bought'; food: FoodRow | null; newFoodName: string | null; quantity: Quantity; location: string | null };

type Prepared = {
  today: IsoDate;
  steps: Step[];
  unresolved: Unresolved[];
  assumptions: string[];
  foodUpdates: Map<string, { before: FoodRow; shelfLife: ShelfLifeMap }>;
  newFoodShelfLife: Map<string, ShelfLifeMap>;
  calls: Array<{ id: string; result: ReasoningResult<unknown> }>;
};

async function activeRows(db: Db, householdId: string): Promise<ActiveRow[]> {
  return db.select({ lot: lots, food: foods }).from(lots).innerJoin(foods, eq(foods.id, lots.foodId)).where(and(eq(lots.householdId, householdId), eq(lots.status, 'active')));
}

async function prepare(deps: Deps, p: Principal, activities: Activity[], now: Date): Promise<Prepared> {
  const household = await getHousehold(deps.db, p.householdId);
  const today = todayIn(household.timezone, now);
  const catalog = await deps.db.select().from(foods).where(and(eq(foods.householdId, p.householdId), isNull(foods.archivedAt)));
  const rows = await activeRows(deps.db, p.householdId);
  const current = new Map<string, LotFacts & { expires: LotRow['expires'] }>(); // evolving state when one call touches a lot twice
  const out: Prepared = { today, steps: [], unresolved: [], assumptions: [], foodUpdates: new Map(), newFoodShelfLife: new Map(), calls: [] };
  const shelfLifeOf = (f: FoodRow) => out.foodUpdates.get(f.id)?.shelfLife ?? f.shelfLife;
  const candidatesFor = (rs: ActiveRow[]) => rs.slice(0, 5).map((r) => ({ lot_id: r.lot.id, food_name: r.food.name, location: r.lot.location, quantity_text: describeQuantity(r.lot.quantity, r.lot.package) }));

  for (const act of activities) {
    for (const item of act.items) {
      if (act.kind === 'bought') {
        const [food] = item.food_name ? matchFoods(item.food_name, catalog) : [];
        const q = toAmount(item.quantity);
        out.steps.push({
          type: 'add',
          kind: 'bought',
          food: food ?? null,
          newFoodName: food ? null : sentence(item.food_name ?? 'Item'),
          quantity: q && 'quantity' in q ? q.quantity : { kind: 'approx', amount: 1, unit: 'count' },
          location: item.to_location ?? null,
        });
        continue;
      }
      let target: ActiveRow | undefined;
      if (item.lot_id) {
        target = rows.find((r) => r.lot.id === item.lot_id);
        if (!target) {
          out.unresolved.push({ kind: act.kind, food_name: item.food_name ?? null, lot_id: item.lot_id, reason: 'That item is not in current inventory.', candidates: [] });
          continue;
        }
      } else {
        const matches = matchFoods(item.food_name!, catalog);
        const onHand = rows.filter((r) => matches.some((f) => f.id === r.food.id));
        const foodsOnHand = [...new Set(onHand.map((r) => r.food.id))];
        if (!onHand.length) {
          out.unresolved.push({ kind: act.kind, food_name: item.food_name!, lot_id: null, reason: `No ${item.food_name} on hand.`, candidates: candidatesFor(rows.filter((r) => shortlist(item.food_name!, [r.food], 1, 0.2).length)) });
          continue;
        }
        if (foodsOnHand.length > 1) {
          out.unresolved.push({ kind: act.kind, food_name: item.food_name!, lot_id: null, reason: `"${item.food_name}" could mean several foods.`, candidates: candidatesFor(onHand) });
          continue;
        }
        target = pickLot(onHand.map((r) => ({ ...r, expires: current.get(r.lot.id)?.expires ?? r.lot.expires, acquiredOn: r.lot.acquiredOn })));
        if (onHand.length > 1) {
          const exp = describeExpiry(target!.lot.expires, today);
          out.assumptions.push(`You have ${onHand.length} on hand of ${target!.food.name}; used the one expiring first (${exp}, ${target!.lot.location}).`);
        }
      }
      const { lot, food } = target!;
      const state = current.get(lot.id) ?? { ...facts(lot), expires: lot.expires };
      let r = applyActivity(state, { kind: act.kind, amount: toAmount(item.quantity), ...(item.to_location ? { toLocation: item.to_location } : {}) }, { perishability: food.perishability, shelfLife: shelfLifeOf(food) }, today);
      if (r.refused) {
        out.unresolved.push({ kind: act.kind, food_name: food.name, lot_id: lot.id, reason: `${food.name}: ${r.refused}`, candidates: [] });
        continue;
      }
      if (r.needsShelfLife) {
        const est = await estimate(deps, p.householdId, food, [r.needsShelfLife]);
        out.calls.push({ id: est.id, result: est.result });
        out.foodUpdates.set(food.id, { before: food, shelfLife: { ...shelfLifeOf(food), ...est.map } });
        r = applyActivity(state, { kind: act.kind, amount: toAmount(item.quantity), ...(item.to_location ? { toLocation: item.to_location } : {}) }, { perishability: food.perishability, shelfLife: shelfLifeOf(food) }, today);
      }
      current.set(lot.id, r.lot);
      out.steps.push({ type: 'update', kind: act.kind, lot, food, next: r.lot, notes: r.notes });
    }
  }

  for (const s of out.steps) {
    if (s.type === 'add' && s.newFoodName && !out.newFoodShelfLife.has(s.newFoodName)) {
      const est = await estimate(deps, p.householdId, { name: s.newFoodName, category: null, perishability: 'perishable' }, ['sealed', 'opened', 'frozen']);
      out.calls.push({ id: est.id, result: est.result });
      out.newFoodShelfLife.set(s.newFoodName, est.map);
    }
  }
  return out;
}

// ---------- commit (one transaction, one change set) ----------

const VERB: Record<ActivityKind, string> = { bought: 'Added', used: 'Used', finished: 'Finished', discarded: 'Discarded', froze: 'Froze', thawed: 'Thawed', opened: 'Opened', moved: 'Moved' };

function summarize(step: Step & { type: 'update' }, before: Side, after: Side): string {
  const name = step.food.name;
  switch (step.kind) {
    case 'used':
      return step.next.status === 'depleted' ? `Used up ${name}` : `Used some ${name}: ${before.quantity_text} → ${after.quantity_text}`;
    case 'finished':
      return `Finished ${name}`;
    case 'discarded':
      return `Discarded ${name} (${before.location})`;
    case 'moved':
      return `Moved ${name}: ${before.location} → ${after.location}`;
    default:
      return `${VERB[step.kind]} ${name}${before.location !== after.location ? `: ${before.location} → ${after.location}` : ''}; ${after.expiry_text}`;
  }
}

async function commit(tx: Tx, deps: Deps, p: Principal, prep: Prepared, payload: Record<string, unknown>, now: Date, idempotencyKey: string): Promise<ActivityResult> {
  const observationId = randomUUID();
  await tx.insert(observations).values({ id: observationId, householdId: p.householdId, kind: 'user_statement', observedAt: now, actorUserId: p.userId, connectionId: p.connectionId, payload, status: 'resolved' });
  for (const c of prep.calls) await persistReasoningCall(tx, p.householdId, c.id, c.result);
  const base: Omit<ActivityResult, 'change_set_id' | 'applied' | 'undo' | 'next'> = { assumptions: prep.assumptions, unresolved: prep.unresolved, notes: prep.steps.flatMap((s) => (s.type === 'update' ? s.notes : [])) };
  const ask = prep.unresolved.length ? [`Ask the user about: ${prep.unresolved.map((u) => `${u.food_name ?? u.lot_id} (${u.reason})`).join('; ')}`] : [];
  if (!prep.steps.length) return { ...base, change_set_id: null, applied: [], undo: null, next: ask };

  const names = prep.steps.map((s) => `${VERB[s.kind].toLowerCase()} ${s.type === 'update' ? s.food.name : s.food?.name ?? s.newFoodName}`);
  const label = sentence(names.join(', ')).slice(0, 120);
  const cs: ChangeSetHandle = await openChangeSet(tx, p, { label, causeObservationId: observationId, idempotencyKey });

  for (const [foodId, u] of prep.foodUpdates) {
    const [after] = await tx.update(foods).set({ shelfLife: u.shelfLife, updatedAt: new Date() }).where(eq(foods.id, foodId)).returning();
    await recordChange(tx, cs, { op: 'update_food', foodId, before: u.before, after });
  }

  const applied: AppliedStep[] = [];
  const fresh = new Map<string, LotRow>();
  for (const step of prep.steps) {
    if (step.type === 'add') {
      const food = step.food ?? (await createOrReuseFood(tx, cs, { name: step.newFoodName!, perishability: 'perishable', shelfLife: prep.newFoodShelfLife.get(step.newFoodName!) ?? {} })).food;
      const location = step.location ?? food.defaultLocation ?? defaultLocationFor(food.perishability);
      const lot = await addLot(tx, cs, { food, location, quantity: step.quantity, acquiredOn: prep.today, evidenceObservationId: observationId });
      const after = side({ ...facts(lot), expires: lot.expires }, prep.today);
      applied.push({ kind: 'bought', lot_id: lot.id, food_name: food.name, summary: `Added ${food.name} (${after.quantity_text}, ${location})`, before: null, after });
      continue;
    }
    const before = fresh.get(step.lot.id) ?? step.lot;
    const [locked] = await tx.select().from(lots).where(eq(lots.id, before.id)).for('update');
    if (!locked || locked.version !== before.version) throw new AppError('conflict', `${step.food.name} changed while this was being applied. Try again.`, 409);
    const n = step.next;
    const after = await updateLot(tx, cs, locked, {
      state: n.state,
      location: n.location,
      quantity: n.quantity,
      status: n.status,
      expires: n.expires,
      openedOn: n.openedOn,
      frozenOn: n.frozenOn,
      thawedOn: n.thawedOn,
      lastEvidenceAt: now,
      lastEvidenceObservationId: observationId,
    }, observationId);
    fresh.set(after.id, after);
    const b = side({ ...facts(locked), expires: locked.expires }, prep.today);
    const a = side({ ...facts(after), expires: after.expires }, prep.today);
    applied.push({ kind: step.kind, lot_id: after.id, food_name: step.food.name, summary: summarize(step, b, a), before: b, after: a });
  }
  return {
    ...base,
    change_set_id: cs.id,
    applied,
    undo: { change_set_id: cs.id },
    next: [`Tell the user what changed (applied[].summary${prep.assumptions.length ? ' and assumptions' : ''}) and that they can undo it.`, ...ask],
  };
}

// ---------- public services ----------

export async function logActivity(deps: Deps, p: Principal, raw: LogActivityInput, now = new Date()): Promise<ActivityResult> {
  const input = LogActivityInputSchema.parse(raw);
  const { idempotency_key, ...request } = input;
  const scope = { householdId: p.householdId, tool: 'log_activity', key: idempotency_key, request };
  const prior = await findIdempotent<ActivityResult>(deps.db, scope);
  if (prior) return prior;
  const prep = await prepare(deps, p, input.activities, now);
  return runIdempotent(deps.db, scope, (tx) => commit(tx, deps, p, prep, { source: 'log_activity', activities: input.activities, ...(input.note ? { note: input.note } : {}) }, now, idempotency_key));
}

type Interpretation = Array<{ kind: string; items: Array<{ lot_id: string | null; food_name: string | null; location: string | null; quantity_text: string | null; quantity: ActivityItem['quantity'] | null; to_location: string | null }> }>;
export type LogTextResult =
  | (ActivityResult & { status: 'applied'; confidence: string; interpretation: Interpretation; ambiguities: ParseActivityOutput['ambiguities'] })
  | { status: 'needs_confirmation'; change_set_id: null; confidence: string; interpretation: Interpretation; ambiguities: ParseActivityOutput['ambiguities']; next: string[] };

export async function logText(deps: Deps, p: Principal, raw: z.input<typeof LogTextInputSchema>, now = new Date()): Promise<LogTextResult> {
  const input = LogTextInputSchema.parse(raw);
  const scope = { householdId: p.householdId, tool: 'log_text', key: input.idempotency_key, request: { text: input.text } };
  const prior = await findIdempotent<LogTextResult>(deps.db, scope);
  if (prior) return prior;

  const rows = (await activeRows(deps.db, p.householdId)).slice(0, 80);
  const context = {
    lots: rows.map((r) => ({ lot_id: r.lot.id, food_name: r.food.name, location: r.lot.location, state: r.lot.state, quantity_text: describeQuantity(r.lot.quantity, r.lot.package) })),
    locations: [...new Set(['fridge', 'freezer', 'pantry', 'counter', ...rows.map((r) => r.lot.location)])],
    recipes: [],
  };
  const parseInput = { text: input.text, now: now.toISOString(), context };
  let parsed: ReasoningResult<ParseActivityOutput>;
  try {
    parsed = await deps.reasoning.parseActivity(parseInput, { householdId: p.householdId });
  } catch (err) {
    if (err instanceof ReasoningInputError) throw err;
    parsed = await interim.parseActivity(parseInput);
  }
  const callId = randomUUID();
  const out = parsed.output;
  const ambiguities = [...out.ambiguities];
  const supported = out.activities.filter((a) => {
    if (a.kind === 'cooked') ambiguities.push({ text: input.text, reason: "Logging a cooked recipe isn't supported yet; say what was used instead.", candidate_lot_ids: [] });
    return a.kind !== 'cooked';
  }) as Activity[];
  const byLot = new Map(rows.map((r) => [r.lot.id, r]));
  const interpretation: Interpretation = supported.map((a) => ({
    kind: a.kind,
    items: a.items.map((i) => {
      const r = i.lot_id ? byLot.get(i.lot_id) : undefined;
      return {
        lot_id: i.lot_id ?? null,
        food_name: r?.food.name ?? i.food_name ?? null,
        location: r?.lot.location ?? null,
        quantity_text: r ? describeQuantity(r.lot.quantity, r.lot.package) : null,
        quantity: i.quantity ?? null,
        to_location: i.to_location ?? null,
      };
    }),
  }));
  const payload = { source: 'log_text', text: input.text, parsed: out, reasoning_call_id: callId };
  const confident = out.confidence === 'high' && ambiguities.length === 0 && supported.length > 0;

  if (confident) {
    const prep = await prepare(deps, p, supported, now);
    prep.calls.unshift({ id: callId, result: parsed });
    return runIdempotent(deps.db, scope, async (tx) => ({
      ...(await commit(tx, deps, p, prep, payload, now, input.idempotency_key)),
      status: 'applied' as const,
      confidence: out.confidence,
      interpretation,
      ambiguities,
    }));
  }
  return runIdempotent(deps.db, scope, async (tx) => {
    await persistReasoningCall(tx, p.householdId, callId, parsed);
    await tx.insert(observations).values({ householdId: p.householdId, kind: 'user_statement', observedAt: now, actorUserId: p.userId, connectionId: p.connectionId, payload, status: 'open' });
    return {
      status: 'needs_confirmation' as const,
      change_set_id: null,
      confidence: out.confidence,
      interpretation,
      ambiguities,
      next: [
        'Nothing was changed. Read the interpretation back to the user in plain words and ask them to confirm or clarify the ambiguities. Then call log_activity with explicit lot_ids.',
      ],
    };
  });
}

export async function correctItem(deps: Deps, p: Principal, raw: z.input<typeof CorrectItemInputSchema>, now = new Date()) {
  const input = CorrectItemInputSchema.parse(raw);
  const { idempotency_key, ...request } = input;
  const links = makeLinks(deps.config.PUBLIC_BASE_URL);
  const household = await getHousehold(deps.db, p.householdId);
  const today = todayIn(household.timezone, now);
  return runIdempotent(deps.db, { householdId: p.householdId, tool: 'correct_item', key: idempotency_key, request }, async (tx) => {
    const [row] = await tx.select({ lot: lots, food: foods }).from(lots).innerJoin(foods, eq(foods.id, lots.foodId)).where(and(eq(lots.id, input.lot_id), eq(lots.householdId, p.householdId))).for('update');
    if (!row) throw notFound('Item');
    const { lot, food } = row;
    const state = input.state ?? lot.state;
    const anchors = {
      openedOn: state === 'opened' && !lot.openedOn ? today : lot.openedOn,
      frozenOn: state === 'frozen' && !lot.frozenOn ? today : lot.frozenOn,
      thawedOn: state === 'thawed' && !lot.thawedOn ? today : lot.thawedOn,
    };
    const printedExpiryOn = input.expires_on !== undefined ? input.expires_on : lot.printedExpiryOn;
    const expires = computeEffectiveExpiry({
      perishability: food.perishability,
      state,
      anchors: { sealed: lot.acquiredOn ?? undefined, opened: anchors.openedOn ?? undefined, frozen: anchors.frozenOn ?? undefined, thawed: anchors.thawedOn ?? undefined },
      printedExpiryOn,
      shelfLife: food.shelfLife,
    });
    const observationId = randomUUID();
    await tx.insert(observations).values({ id: observationId, householdId: p.householdId, kind: 'user_statement', observedAt: now, actorUserId: p.userId, connectionId: p.connectionId, payload: { source: 'correct_item', ...request }, status: 'resolved' });
    const cs = await openChangeSet(tx, p, { label: `Corrected ${food.name}`, causeObservationId: observationId, idempotencyKey: idempotency_key });
    const after = await updateLot(tx, cs, lot, {
      state,
      ...anchors,
      ...(input.quantity ? { quantity: input.quantity } : {}),
      ...(input.location ? { location: input.location } : {}),
      printedExpiryOn,
      expires,
      lastEvidenceAt: now,
      lastEvidenceObservationId: observationId,
    }, observationId);
    return { change_set_id: cs.id, lot: toLotView(after, food, today, links, now), undo: { change_set_id: cs.id } };
  });
}

export async function getChanges(deps: Deps, p: Principal, raw: z.input<typeof GetChangesInputSchema>, now = new Date()) {
  const input = GetChangesInputSchema.parse(raw);
  const household = await getHousehold(deps.db, p.householdId);
  const sets = await deps.db
    .select({ cs: changeSets, by: users.displayName, email: users.email, via: connections.clientName })
    .from(changeSets)
    .innerJoin(users, eq(users.id, changeSets.actorUserId))
    .leftJoin(connections, eq(connections.id, changeSets.connectionId))
    .where(eq(changeSets.householdId, p.householdId))
    .orderBy(desc(changeSets.createdAt))
    .limit(input.limit);
  const filtered = input.since ? sets.filter((s) => s.cs.createdAt >= new Date(input.since!)) : sets;
  const ids = filtered.map((s) => s.cs.id);
  const touched = ids.length
    ? await deps.db.select({ changeSetId: changes.changeSetId, name: foods.name }).from(changes).innerJoin(foods, eq(foods.id, changes.foodId)).where(inArray(changes.changeSetId, ids))
    : [];
  return {
    today: todayIn(household.timezone, now),
    changes: filtered.map((s) => ({
      change_set_id: s.cs.id,
      label: s.cs.label,
      at: s.cs.createdAt.toISOString(),
      by: s.by ?? s.email,
      via: s.via,
      items: [...new Set(touched.filter((t) => t.changeSetId === s.cs.id).map((t) => t.name))],
      undone: Boolean(s.cs.revertedByChangeSetId),
      is_undo: Boolean(s.cs.revertsChangeSetId),
    })),
  };
}
