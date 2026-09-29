import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  exactAliasMatch,
  IdempotencyKeySchema,
  normalizeName,
  normalizePackage,
  quantityFromReceiptLine,
  receiptFingerprint,
  receiptNearKey,
  ReceiptPayloadSchema,
  shortlist,
  withLineIds,
  type Confidence,
  type LineKind,
  type Package,
  type Perishability,
  type ReceiptLine,
  type ShelfLifeMap,
} from '@buttery/domain';
import type { Executor } from '../db/client';
import { observations, proposalOps, proposals, type FoodRow } from '../db/schema';
import type { AppDeps } from '../http/app';
import type { Principal } from '../identity/principal';
import { createInterimReasoning } from '../reasoning/interim';
import type { CanonicalizeInput, CanonicalLine, ReasoningResult, ShelfLifeInput, ShelfLifeOutput } from '../reasoning/port';
import { persistReasoningCall } from '../reasoning/record';
import { countOps, defaultLocationFor, type IgnoreDraft, type LineSnapshot, type LotDraft } from './drafts';
import { loadCatalog, toCandidate } from './foods';
import { findIdempotent, runIdempotent } from './idempotency';
import { makeLinks } from './links';

export const SubmitReceiptInputSchema = z.object({
  kind: z.literal('receipt'),
  observed_at: z.iso.datetime({ offset: true }).optional(),
  payload: ReceiptPayloadSchema,
  idempotency_key: IdempotencyKeySchema,
});
export type SubmitReceiptInput = z.infer<typeof SubmitReceiptInputSchema>;

export type SubmitReceiptResult = {
  observation_id: string;
  proposal_id: string;
  review_url: string;
  duplicate_of: string | null;
  possible_duplicate_of: string | null;
  counts: ReturnType<typeof countOps>;
  reasoning: { canonicalize: string | null; shelf_life: string[]; fallback_used: boolean };
  auto_applied: never[];
  uncertainties: string[];
  next: string[];
};

type Deps = Pick<AppDeps, 'db' | 'reasoning' | 'config'>;
type Line = ReceiptLine & { line_id: string };
type LineRes =
  | { kind: 'non_item'; lineKind: Exclude<LineKind, 'item'>; confidence: Confidence; rationale: string; callId: string | null }
  | { kind: 'match'; food: FoodRow; confidence: Confidence; rationale: string; callId: string | null; pkg: Package | null }
  | { kind: 'new'; name: string; category: string | null; perishability: Perishability; confidence: Confidence; rationale: string; callId: string | null; pkg: Package | null };
type NewOp = Omit<typeof proposalOps.$inferInsert, 'householdId' | 'proposalId'>;

const TOOL = 'submit_observation';
const interim = createInterimReasoning();

async function callWithFallback<T>(
  primary: () => Promise<ReasoningResult<T>>,
  fallback: () => Promise<ReasoningResult<T>>,
): Promise<{ result: ReasoningResult<T>; threw: boolean }> {
  try {
    return { result: await primary(), threw: false };
  } catch (err) {
    console.warn('reasoning failed; using interim heuristic', err);
    const result = await fallback();
    return { result: { ...result, call: { ...result.call, error: String(err) } }, threw: true };
  }
}

async function findObservation(db: Executor, householdId: string, field: 'fingerprint' | 'nearKey', value: string) {
  const col = field === 'fingerprint' ? observations.fingerprint : observations.nearKey;
  const [row] = await db.select().from(observations).where(and(eq(observations.householdId, householdId), eq(col, value))).limit(1);
  return row;
}

async function duplicateResult(db: Executor, observationId: string, links: ReturnType<typeof makeLinks>): Promise<SubmitReceiptResult> {
  const [proposal] = await db.select().from(proposals).where(eq(proposals.observationId, observationId)).limit(1);
  const ops = await db.select().from(proposalOps).where(eq(proposalOps.proposalId, proposal!.id));
  return {
    observation_id: observationId,
    proposal_id: proposal!.id,
    review_url: links.review(proposal!.id),
    duplicate_of: observationId,
    possible_duplicate_of: null,
    counts: countOps(ops),
    reasoning: { canonicalize: null, shelf_life: [], fallback_used: false },
    auto_applied: [],
    uncertainties: [],
    next: ['This receipt was already recorded; nothing new was created. Share the existing review link.'],
  };
}

function resolveCanonical(c: CanonicalLine, line: Line, catalog: FoodRow[], callId: string): LineRes {
  const pkg = normalizePackage(c.package ?? line.hint?.package);
  if (c.line_kind !== 'item') return { kind: 'non_item', lineKind: c.line_kind, confidence: c.match.confidence, rationale: c.rationale, callId };
  if (c.match.food_id !== 'new') {
    const food = catalog.find((f) => f.id === c.match.food_id);
    if (food) return { kind: 'match', food, confidence: c.match.confidence, rationale: c.rationale, callId, pkg };
  }
  const sameName = catalog.find((f) => f.normalizedName === normalizeName(c.canonical_name));
  if (sameName) return { kind: 'match', food: sameName, confidence: c.match.confidence, rationale: `${c.rationale} (same name as an existing item)`, callId, pkg };
  return { kind: 'new', name: c.canonical_name, category: c.category, perishability: c.perishability, confidence: c.match.confidence, rationale: c.rationale, callId, pkg };
}

function toShelfLifeMap(r: ReasoningResult<ShelfLifeOutput>, callId: string): ShelfLifeMap {
  const source = r.path === 'fallback' ? 'default_rule' : 'model_estimate';
  const out: ShelfLifeMap = {};
  for (const [state, v] of Object.entries(r.output.per_state)) {
    if (!v || (v.days === null && r.path === 'fallback')) continue;
    out[state as keyof ShelfLifeMap] = { days: v.days, confidence: v.confidence, source, ...(r.call.model ? { model: r.call.model } : {}), reasoning_call_id: callId };
  }
  return out;
}

function snapshotLine(l: Line): LineSnapshot {
  return {
    line_id: l.line_id,
    raw_text: l.raw_text,
    ...(l.detail ? { detail: l.detail } : {}),
    ...(l.quantity !== undefined ? { quantity: l.quantity } : {}),
    ...(l.unit ? { unit: l.unit } : {}),
    ...(l.price_cents !== undefined ? { price_cents: l.price_cents } : {}),
  };
}

const IGNORE_REASON: Record<Exclude<LineKind, 'item'>, string> = {
  coupon: 'Coupon or discount',
  non_food: 'Not food',
  return: 'Return: not applied to inventory yet. Adjust the matching item manually if needed.',
};

function buildOp(line: Line, res: LineRes, seq: number, acquiredOn: string, catalog: FoodRow[], shelfLives: Map<string, ShelfLifeMap>): NewOp {
  const candidates = shortlist(line.raw_text, catalog).map((c) => ({ food_id: c.id, name: c.name, score: Math.round(c.score * 100) / 100 }));
  if (res.kind === 'non_item') {
    const payload: IgnoreDraft = { line: snapshotLine(line), line_kind: res.lineKind, reason: IGNORE_REASON[res.lineKind] };
    return { seq, op: 'ignore_line', sourceLineId: line.line_id, payload, confidence: res.confidence, rationale: res.rationale, candidates, reasoningCallId: res.callId };
  }
  const { quantity, package: pkg } = quantityFromReceiptLine(line, res.pkg);
  const perishability = res.kind === 'match' ? res.food.perishability : res.perishability;
  const payload: LotDraft = {
    line: snapshotLine(line),
    food_id: res.kind === 'match' ? res.food.id : null,
    food_name: res.kind === 'match' ? res.food.name : res.name,
    new_food:
      res.kind === 'new'
        ? { name: res.name, category: res.category, perishability: res.perishability, shelf_life: shelfLives.get(normalizeName(res.name)) ?? {} }
        : null,
    location: (res.kind === 'match' ? res.food.defaultLocation : null) ?? line.hint?.location_guess ?? defaultLocationFor(perishability),
    state: 'sealed',
    quantity,
    package: pkg,
    acquired_on: acquiredOn,
    printed_expiry_on: null,
    notes: null,
  };
  return {
    seq,
    op: 'add_lot',
    sourceLineId: line.line_id,
    targetFoodId: payload.food_id,
    payload,
    confidence: res.confidence,
    rationale: res.rationale,
    candidates,
    reasoningCallId: res.callId,
  };
}

export async function submitReceipt(deps: Deps, p: Principal, input: SubmitReceiptInput): Promise<SubmitReceiptResult> {
  const { db } = deps;
  const links = makeLinks(deps.config.PUBLIC_BASE_URL);
  const scope = {
    householdId: p.householdId,
    tool: TOOL,
    key: input.idempotency_key,
    request: { kind: input.kind, observed_at: input.observed_at, payload: input.payload },
  };
  const replayed = await findIdempotent<SubmitReceiptResult>(db, scope);
  if (replayed) return replayed;

  const payload = withLineIds(input.payload);
  const fingerprint = receiptFingerprint(payload);
  const nearKey = receiptNearKey(payload);
  const existing = await findObservation(db, p.householdId, 'fingerprint', fingerprint);
  if (existing) return runIdempotent(db, scope, (tx) => duplicateResult(tx, existing.id, links));
  const near = nearKey ? await findObservation(db, p.householdId, 'nearKey', nearKey) : undefined;

  const catalog = await loadCatalog(db, p.householdId);
  const calls: Array<{ id: string; result: ReasoningResult<unknown> }> = [];
  const resolutions = new Map<string, LineRes>();
  const unresolved: Line[] = [];

  for (const line of payload.lines) {
    if (line.line_kind && line.line_kind !== 'item') {
      resolutions.set(line.line_id, { kind: 'non_item', lineKind: line.line_kind, confidence: 'high', rationale: `Marked as ${line.line_kind} on the receipt`, callId: null });
      continue;
    }
    const exact = exactAliasMatch(line.raw_text, catalog);
    if (exact) {
      resolutions.set(line.line_id, { kind: 'match', food: exact, confidence: 'high', rationale: 'Matches a receipt line confirmed before', callId: null, pkg: normalizePackage(line.hint?.package) });
      continue;
    }
    unresolved.push(line);
  }

  let fallbackUsed = false;
  let canonPath: string | null = null;
  if (unresolved.length) {
    const canonInput: CanonicalizeInput = {
      lines: unresolved.map((l) => ({ line_id: l.line_id, raw_text: l.raw_text, quantity: l.quantity, price_cents: l.price_cents, line_kind: l.line_kind, hint: l.hint })),
      candidates: Object.fromEntries(unresolved.map((l) => [l.line_id, shortlist(`${l.raw_text} ${l.hint?.food_name ?? ''}`, catalog).map(toCandidate)])),
    };
    const canon = await callWithFallback(
      () => deps.reasoning.canonicalizeItems(canonInput, { householdId: p.householdId }),
      () => interim.canonicalizeItems(canonInput),
    );
    fallbackUsed ||= canon.threw || canon.result.path === 'fallback';
    canonPath = canon.threw ? 'fallback' : canon.result.path;
    const callId = randomUUID();
    calls.push({ id: callId, result: canon.result });
    const byLine = new Map(canon.result.output.lines.map((c) => [c.line_id, c]));
    for (const l of unresolved) {
      let c = byLine.get(l.line_id);
      if (!c) {
        const single = canonInput.lines.find((x) => x.line_id === l.line_id)!;
        c = (await interim.canonicalizeItems({ lines: [single], candidates: { [l.line_id]: canonInput.candidates[l.line_id] ?? [] } })).output.lines[0]!;
        fallbackUsed = true;
      }
      resolutions.set(l.line_id, resolveCanonical(c, l, catalog, callId));
    }
  }

  const newFoods = new Map<string, { name: string; category: string | null; perishability: Perishability }>();
  for (const r of resolutions.values()) if (r.kind === 'new') newFoods.set(normalizeName(r.name), r);
  const shelfLives = new Map<string, ShelfLifeMap>();
  const shelfPaths: string[] = [];
  await Promise.all(
    [...newFoods].map(async ([key, f]) => {
      const sl: ShelfLifeInput = {
        food_name: f.name,
        ...(f.category ? { category: f.category } : {}),
        perishability: f.perishability,
        states: ['sealed', 'opened', 'frozen'],
        anchor_date: payload.purchased_at.slice(0, 10),
      };
      const r = await callWithFallback(() => deps.reasoning.estimateShelfLife(sl, { householdId: p.householdId }), () => interim.estimateShelfLife(sl));
      fallbackUsed ||= r.threw;
      const id = randomUUID();
      calls.push({ id, result: r.result });
      shelfPaths.push(r.threw ? 'fallback' : r.result.path);
      shelfLives.set(key, toShelfLifeMap(r.result, id));
    }),
  );

  const acquiredOn = payload.purchased_at.slice(0, 10);
  const ops = payload.lines.map((line, i) => buildOp(line, resolutions.get(line.line_id)!, i + 1, acquiredOn, catalog, shelfLives));
  if (fallbackUsed) for (const o of ops) if (o.op === 'add_lot' && !o.targetFoodId) o.confidence = 'low';

  const counts = countOps(ops.map((o) => ({ op: o.op, targetFoodId: o.targetFoodId ?? null, confidence: o.confidence, payload: o.payload })));
  const uncertainties: string[] = [];
  if (near) uncertainties.push(`This looks like a receipt already recorded (same store, date and total). Check the review page before applying.`);
  if (fallbackUsed) uncertainties.push('The reasoning model was unavailable for some lines; names and matches came from a simple heuristic and are marked low confidence.');
  if (counts.low_confidence) uncertainties.push(`${counts.low_confidence} line(s) need a closer look.`);
  const noEstimate = [...newFoods.keys()].filter((k) => !shelfLives.get(k)?.sealed).length;
  if (noEstimate) uncertainties.push(`${noEstimate} new item(s) have no shelf-life estimate yet.`);
  if (payload.lines.some((l) => resolutions.get(l.line_id)?.kind === 'non_item' && (resolutions.get(l.line_id) as { lineKind: string }).lineKind === 'return')) {
    uncertainties.push('Returns are listed but not applied to inventory yet.');
  }

  return runIdempotent(db, scope, async (tx) => {
    const observationId = randomUUID();
    const inserted = await tx
      .insert(observations)
      .values({
        id: observationId,
        householdId: p.householdId,
        kind: 'receipt',
        observedAt: input.observed_at ? new Date(input.observed_at) : new Date(),
        actorUserId: p.userId,
        connectionId: p.connectionId,
        payload: payload as unknown as Record<string, unknown>,
        fingerprint,
        nearKey,
      })
      .onConflictDoNothing()
      .returning({ id: observations.id });
    if (!inserted.length) {
      const dup = await findObservation(tx, p.householdId, 'fingerprint', fingerprint);
      return duplicateResult(tx, dup!.id, links);
    }
    for (const c of calls) await persistReasoningCall(tx, p.householdId, c.id, c.result);
    const [proposal] = await tx.insert(proposals).values({ householdId: p.householdId, observationId }).returning();
    await tx.insert(proposalOps).values(ops.map((o) => ({ ...o, householdId: p.householdId, proposalId: proposal!.id })));
    const reviewUrl = links.review(proposal!.id);
    return {
      observation_id: observationId,
      proposal_id: proposal!.id,
      review_url: reviewUrl,
      duplicate_of: null,
      possible_duplicate_of: near?.id ?? null,
      counts,
      reasoning: { canonicalize: canonPath, shelf_life: shelfPaths, fallback_used: fallbackUsed },
      auto_applied: [],
      uncertainties,
      next: [`Nothing has been added to inventory yet. Give the user this review link: ${reviewUrl}`],
    };
  });
}
