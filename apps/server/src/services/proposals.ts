import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { describeExpiry, describeQuantity, IdempotencyKeySchema, todayIn, type Expiry, type Package, type Quantity } from '@buttery/domain';
import type { Tx } from '../db/client';
import { connections, foods, observations, proposalOps, proposals, users, type FoodRow, type LotRow, type ProposalOpRow } from '../db/schema';
import { AppError, notFound } from '../errors';
import type { AppDeps } from '../http/app';
import type { Principal } from '../identity/principal';
import { addAlias, addLot, createOrReuseFood, openChangeSet, type ChangeSetHandle } from './changes';
import { applyDraftEdits, countOps, LotDraftEditSchema, previewExpiry, type IgnoreDraft, type LineSnapshot, type LotDraft } from './drafts';
import { getHousehold } from './identity';
import { runIdempotent } from './idempotency';
import { makeLinks } from './links';
import { refreshProposalStatus } from './proposalStatus';

type Deps = Pick<AppDeps, 'db' | 'config'>;

export const DecisionSchema = z.object({
  op_id: z.uuid(),
  action: z.enum(['accept', 'reject', 'edit']),
  edits: LotDraftEditSchema.optional(),
});

export const ResolveProposalInputSchema = z.object({
  proposal_id: z.uuid(),
  decisions: z.array(DecisionSchema).max(300).default([]),
  accept_remaining: z.boolean().default(false).describe('Accept every still-pending line. Only when the user approved everything.'),
  apply: z.boolean().default(true).describe('Apply accepted lines to inventory now'),
  confirm_possible_duplicate: z.boolean().default(false).describe('Required when the receipt may duplicate one already recorded; set only after the user confirms it is a different purchase'),
  idempotency_key: IdempotencyKeySchema,
});
export type ResolveProposalInput = z.infer<typeof ResolveProposalInputSchema>;

export type OpView = {
  op_id: string;
  seq: number;
  op: string;
  decision: string;
  applied: boolean;
  confidence: string;
  rationale: string | null;
  line: LineSnapshot;
  line_kind?: string;
  reason?: string;
  candidates: Array<{ food_id: string; name: string }>;
  draft: {
    food_id: string | null;
    food_name: string;
    is_new_food: boolean;
    category: string | null;
    perishability: string;
    location: string;
    quantity: Quantity;
    package: Package | null;
    quantity_text: string;
    printed_expiry_on: string | null;
    expires_preview: Expiry | null;
    expiry_text: string;
  } | null;
};

export type ProposalView = {
  proposal: { id: string; status: string; created_at: string };
  observation: {
    id: string;
    kind: string;
    store: string | null;
    purchased_at: string | null;
    receipt_number: string | null;
    total_cents: number | null;
    recorded_at: string;
    recorded_by: string | null;
    via: string | null;
    possible_duplicate_of: { observation_id: string; review_url: string | null } | null;
    uncertainties: string[];
  };
  ops: OpView[];
  counts: ReturnType<typeof countOps>;
  links: { review: string; inventory: string };
};

function toOpView(o: ProposalOpRow, foodsById: Map<string, FoodRow>, today: string): OpView {
  const base = {
    op_id: o.id,
    seq: o.seq,
    op: o.op,
    decision: o.decision,
    applied: Boolean(o.appliedAt),
    confidence: o.confidence,
    rationale: o.rationale,
    candidates: o.candidates.map((c) => ({ food_id: c.food_id, name: c.name })),
  };
  if (o.op === 'ignore_line') {
    const d = o.payload as unknown as IgnoreDraft;
    return { ...base, line: d.line, line_kind: d.line_kind, reason: d.reason, draft: null };
  }
  const d = o.payload as unknown as LotDraft;
  const food = d.food_id ? foodsById.get(d.food_id) : undefined;
  const expires = previewExpiry(d, food);
  return {
    ...base,
    line: d.line,
    draft: {
      food_id: d.food_id,
      food_name: food?.name ?? d.new_food?.name ?? d.food_name,
      is_new_food: !d.food_id,
      category: food?.category ?? d.new_food?.category ?? null,
      perishability: food?.perishability ?? d.new_food?.perishability ?? 'perishable',
      location: d.location,
      quantity: d.quantity,
      package: d.package,
      quantity_text: describeQuantity(d.quantity, d.package),
      printed_expiry_on: d.printed_expiry_on,
      expires_preview: expires,
      expiry_text: describeExpiry(expires, today),
    },
  };
}

export async function getProposalView(deps: Deps, p: Principal, proposalId: string, now = new Date()): Promise<ProposalView> {
  const { db } = deps;
  const links = makeLinks(deps.config.PUBLIC_BASE_URL);
  const [proposal] = await db.select().from(proposals).where(and(eq(proposals.id, proposalId), eq(proposals.householdId, p.householdId)));
  if (!proposal) throw notFound('Proposal');
  const [obs] = await db.select().from(observations).where(eq(observations.id, proposal.observationId));
  const ops = await db.select().from(proposalOps).where(eq(proposalOps.proposalId, proposal.id)).orderBy(proposalOps.seq);
  const household = await getHousehold(db, p.householdId);
  const today = todayIn(household.timezone, now);
  const foodsById = new Map((await db.select().from(foods).where(eq(foods.householdId, p.householdId))).map((f) => [f.id, f]));
  const [actor] = await db.select().from(users).where(eq(users.id, obs!.actorUserId));
  const [conn] = obs!.connectionId ? await db.select().from(connections).where(eq(connections.id, obs!.connectionId)) : [];
  const payload = obs!.payload as { store?: string; purchased_at?: string; receipt_number?: string; total_cents?: number };
  const [dupProposal] = obs!.possibleDuplicateOf ? await db.select().from(proposals).where(eq(proposals.observationId, obs!.possibleDuplicateOf)) : [];
  return {
    proposal: { id: proposal.id, status: proposal.status, created_at: proposal.createdAt.toISOString() },
    observation: {
      id: obs!.id,
      kind: obs!.kind,
      store: payload.store ?? null,
      purchased_at: payload.purchased_at ?? null,
      receipt_number: payload.receipt_number ?? null,
      total_cents: payload.total_cents ?? null,
      recorded_at: obs!.recordedAt.toISOString(),
      recorded_by: actor?.displayName ?? actor?.email ?? null,
      via: conn?.clientName ?? null,
      possible_duplicate_of: obs!.possibleDuplicateOf ? { observation_id: obs!.possibleDuplicateOf, review_url: dupProposal ? links.review(dupProposal.id) : null } : null,
      uncertainties: obs!.uncertainties,
    },
    ops: ops.map((o) => toOpView(o, foodsById, today)),
    counts: countOps(ops),
    links: { review: links.review(proposal.id), inventory: links.inventory() },
  };
}

export function receiptLabel(payload: Record<string, unknown>): string {
  const store = typeof payload.store === 'string' ? payload.store : 'receipt';
  const date = typeof payload.purchased_at === 'string' ? payload.purchased_at.slice(0, 10) : '';
  return `Receipt: ${store}${date ? ` ${date}` : ''}`;
}

async function applyAddLot(tx: Tx, cs: ChangeSetHandle, op: ProposalOpRow, observationId: string, foodsById: Map<string, FoodRow>): Promise<LotRow> {
  const d = op.payload as unknown as LotDraft;
  let food: FoodRow;
  if (d.food_id) {
    const found = foodsById.get(d.food_id) ?? (await tx.select().from(foods).where(and(eq(foods.id, d.food_id), eq(foods.householdId, cs.householdId))))[0];
    if (!found) throw new AppError('invalid_input', `The item chosen for "${d.line.raw_text}" no longer exists`, 422);
    food = found.archivedAt ? (await createOrReuseFood(tx, cs, { name: found.name, perishability: found.perishability })).food : found;
  } else {
    const nf = d.new_food!;
    food = (await createOrReuseFood(tx, cs, { name: nf.name, category: nf.category, perishability: nf.perishability, shelfLife: nf.shelf_life, defaultLocation: d.location, defaultPackage: d.package })).food;
  }
  food = await addAlias(tx, cs, food, d.line.raw_text);
  foodsById.set(food.id, food);
  return addLot(tx, cs, {
    food,
    location: d.location,
    state: d.state,
    quantity: d.quantity,
    package: d.package,
    acquiredOn: d.acquired_on,
    printedExpiryOn: d.printed_expiry_on,
    evidenceObservationId: observationId,
    causeProposalOpId: op.id,
    notes: d.notes,
  });
}

export async function resolveProposal(deps: Deps, p: Principal, raw: z.input<typeof ResolveProposalInputSchema>, now = new Date()) {
  const input: ResolveProposalInput = ResolveProposalInputSchema.parse(raw);
  const { db } = deps;
  const { idempotency_key, ...request } = input;
  const outcome = await runIdempotent(db, { householdId: p.householdId, tool: 'resolve_proposal', key: idempotency_key, request }, async (tx) => {
    const [proposal] = await tx
      .select()
      .from(proposals)
      .where(and(eq(proposals.id, input.proposal_id), eq(proposals.householdId, p.householdId)))
      .for('update');
    if (!proposal) throw notFound('Proposal');
    const [observation] = await tx.select().from(observations).where(eq(observations.id, proposal.observationId));
    const loadOps = () => tx.select().from(proposalOps).where(eq(proposalOps.proposalId, proposal.id)).orderBy(proposalOps.seq);
    const byId = new Map((await loadOps()).map((o) => [o.id, o]));
    const foodsById = new Map((await tx.select().from(foods).where(eq(foods.householdId, p.householdId))).map((f) => [f.id, f]));
    const notes: string[] = [];

    for (const d of input.decisions) {
      const op = byId.get(d.op_id);
      if (!op) throw new AppError('invalid_input', `Line ${d.op_id} is not part of this proposal`, 422);
      if (op.appliedAt) {
        notes.push(`"${(op.payload as unknown as LotDraft).line.raw_text}" was already applied; decision ignored.`);
        continue;
      }
      if (d.action === 'edit') {
        if (op.op !== 'add_lot' || !d.edits) throw new AppError('invalid_input', 'Only item lines can be edited, and edits are required', 422);
        const draft = applyDraftEdits(op.payload as unknown as LotDraft, d.edits, foodsById);
        await tx.update(proposalOps).set({ payload: draft as unknown as Record<string, unknown>, targetFoodId: draft.food_id, decision: 'edited' }).where(eq(proposalOps.id, op.id));
      } else {
        await tx.update(proposalOps).set({ decision: d.action === 'accept' ? 'accepted' : 'rejected' }).where(eq(proposalOps.id, op.id));
      }
    }
    if (input.accept_remaining) {
      await tx.update(proposalOps).set({ decision: 'accepted' }).where(and(eq(proposalOps.proposalId, proposal.id), eq(proposalOps.decision, 'pending')));
    }

    let appliedChangeSetId: string | null = null;
    const createdLotIds: string[] = [];
    if (input.apply && observation!.possibleDuplicateOf && !input.confirm_possible_duplicate) {
      throw new AppError(
        'possible_duplicate',
        'This receipt may duplicate one already recorded. Ask the user to confirm it is a different purchase, then retry with confirm_possible_duplicate: true.',
        409,
        { possible_duplicate_of: observation!.possibleDuplicateOf },
      );
    }
    if (input.apply) {
      const toApply = (await loadOps()).filter((o) => (o.decision === 'accepted' || o.decision === 'edited') && !o.appliedAt);
      const hasLots = toApply.some((o) => o.op === 'add_lot');
      const cs = hasLots
        ? await openChangeSet(tx, p, { label: receiptLabel(observation!.payload), causeObservationId: observation!.id, causeProposalId: proposal.id, idempotencyKey: idempotency_key })
        : null;
      appliedChangeSetId = cs?.id ?? null;
      for (const op of toApply) {
        if (op.op === 'add_lot') createdLotIds.push((await applyAddLot(tx, cs!, op, observation!.id, foodsById)).id);
        await tx.update(proposalOps).set({ appliedAt: now, resultChangeSetId: op.op === 'add_lot' ? cs!.id : null }).where(eq(proposalOps.id, op.id));
      }
      if (!toApply.length) notes.push('Nothing left to apply.');
    }
    await refreshProposalStatus(tx, proposal.id);
    return { applied_change_set_id: appliedChangeSetId, created_lot_ids: createdLotIds, notes };
  });

  const view = await getProposalView(deps, p, input.proposal_id, now);
  return {
    ...view,
    ...outcome,
    undo: outcome.applied_change_set_id ? { change_set_id: outcome.applied_change_set_id } : null,
  };
}
