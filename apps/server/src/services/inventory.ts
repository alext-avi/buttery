import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { daysBetween, normalizeName, PerishabilitySchema, similarity, todayIn } from '@buttery/domain';
import type { Db } from '../db/client';
import { changeSets, changes, connections, foods, lots, observations, proposalOps, proposals, reasoningCalls, users, type FoodRow, type LotRow } from '../db/schema';
import { notFound } from '../errors';
import type { AppDeps } from '../http/app';
import type { Principal } from '../identity/principal';
import type { LotDraft } from './drafts';
import { getHousehold } from './identity';
import { makeLinks } from './links';
import { receiptLabel } from './proposals';
import { compactLot, toLotView, type LotView } from './views';
import { verdictFor } from './verdict';

type Deps = Pick<AppDeps, 'db' | 'config'>;
export const STALE_AFTER_DAYS = 7;
export const DEFAULT_LOCATIONS = ['fridge', 'freezer', 'pantry', 'counter'];
const URGENCY_ORDER = { expired: 0, urgent: 1, soon: 2, later: 3 } as const;

async function context(deps: Deps, p: Principal, now: Date) {
  const household = await getHousehold(deps.db, p.householdId);
  return { today: todayIn(household.timezone, now), links: makeLinks(deps.config.PUBLIC_BASE_URL), household };
}

async function activeRows(db: Db, householdId: string, includeInactive = false): Promise<Array<{ lot: LotRow; food: FoodRow }>> {
  const where = includeInactive
    ? and(eq(lots.householdId, householdId), inArray(lots.status, ['active', 'depleted', 'discarded']))
    : and(eq(lots.householdId, householdId), eq(lots.status, 'active'));
  return db.select({ lot: lots, food: foods }).from(lots).innerJoin(foods, eq(lots.foodId, foods.id)).where(where);
}

const byExpiry = (a: LotView, b: LotView) => (a.expires?.on ?? '9999-12-31').localeCompare(b.expires?.on ?? '9999-12-31') || a.food.name.localeCompare(b.food.name);

function bucket(views: LotView[]) {
  const pick = (u: 'expired' | 'urgent' | 'soon') => views.filter((v) => v.urgency === u).sort(byExpiry);
  return { expired: pick('expired'), urgent: pick('urgent'), soon: pick('soon') };
}

async function recentChanges(db: Db, householdId: string, limit: number) {
  const rows = await db
    .select({ cs: changeSets, by: users.displayName, email: users.email, via: connections.clientName })
    .from(changeSets)
    .innerJoin(users, eq(users.id, changeSets.actorUserId))
    .leftJoin(connections, eq(connections.id, changeSets.connectionId))
    .where(eq(changeSets.householdId, householdId))
    .orderBy(desc(changeSets.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    change_set_id: r.cs.id,
    label: r.cs.label,
    at: r.cs.createdAt.toISOString(),
    by: r.by ?? r.email,
    via: r.via,
    undone: Boolean(r.cs.revertedByChangeSetId),
    is_undo: Boolean(r.cs.revertsChangeSetId),
  }));
}

export async function getHouseholdSummary(deps: Deps, p: Principal, now = new Date()) {
  const { db } = deps;
  const { today, links, household } = await context(deps, p, now);
  const views = (await activeRows(db, p.householdId)).map(({ lot, food }) => toLotView(lot, food, today, links, now));
  const byLocation: Record<string, number> = {};
  for (const v of views) byLocation[v.location] = (byLocation[v.location] ?? 0) + 1;
  const soon = bucket(views);
  const stale = views.filter((v) => v.food.perishability === 'perishable' && (v.evidence_age_days ?? 0) > STALE_AFTER_DAYS).length;
  const noEstimate = views.filter((v) => v.food.perishability === 'perishable' && !v.expires).length;

  const open = await db
    .select({ proposal: proposals, payload: observations.payload, observation: observations })
    .from(proposals)
    .innerJoin(observations, eq(observations.id, proposals.observationId))
    .where(and(eq(proposals.householdId, p.householdId), inArray(proposals.status, ['pending', 'partial'])))
    .orderBy(desc(proposals.createdAt));
  const openOps = open.length
    ? await db.select().from(proposalOps).where(inArray(proposalOps.proposalId, open.map((o) => o.proposal.id)))
    : [];

  return {
    household: { id: household.id, name: household.name, timezone: household.timezone },
    today,
    counts: { active_items: views.length, by_location: byLocation },
    use_soon: { expired: soon.expired.slice(0, 10).map(compactLot), urgent: soon.urgent.slice(0, 10).map(compactLot), soon: soon.soon.slice(0, 10).map(compactLot) },
    attention: { pending_reviews: open.length, expired: soon.expired.length, stale, no_expiry_estimate: noEstimate },
    pending_reviews: open.slice(0, 5).map((o) => ({
      proposal_id: o.proposal.id,
      label: receiptLabel(o.payload),
      status: o.proposal.status,
      created_at: o.proposal.createdAt.toISOString(),
      open_lines: openOps.filter((x) => x.proposalId === o.proposal.id && x.decision === 'pending' && !x.appliedAt).length,
      verdict: verdictFor(openOps.filter((x) => x.proposalId === o.proposal.id), o.observation).verdict?.verdict ?? null,
      review_url: links.review(o.proposal.id),
    })),
    recent_changes: await recentChanges(db, p.householdId, 5),
    links: { inventory: links.inventory(), use_soon: links.inventory({ view: 'use-soon' }) },
    notes: ['"~" means approximate. "est." expiry is an estimate with a confidence level; "exp" is printed on the package.'],
  };
}

export const SearchInventoryInputSchema = z.object({
  query: z.string().max(100).optional().describe('Food name to look for'),
  location: z.string().max(40).optional(),
  perishability: PerishabilitySchema.optional(),
  expiring_within_days: z.number().int().min(0).max(365).optional().describe('Include items expiring within N days (and already expired)'),
  include_inactive: z.boolean().default(false).describe('Also include used-up and discarded items'),
  sort: z.enum(['expiry', 'location', 'recent']).default('expiry'),
  limit: z.number().int().min(1).max(200).default(50),
});
export type SearchInventoryInput = z.infer<typeof SearchInventoryInputSchema>;

export async function searchInventory(deps: Deps, p: Principal, input: SearchInventoryInput, now = new Date()) {
  const { today, links } = await context(deps, p, now);
  let views = (await activeRows(deps.db, p.householdId, input.include_inactive)).map(({ lot, food }) => toLotView(lot, food, today, links, now));
  if (input.query) {
    const q = normalizeName(input.query);
    views = views.filter((v) => normalizeName(v.food.name).includes(q) || similarity(q, v.food.name) >= 0.3);
  }
  if (input.location) views = views.filter((v) => v.location === input.location);
  if (input.perishability) views = views.filter((v) => v.food.perishability === input.perishability);
  if (input.expiring_within_days !== undefined) {
    views = views.filter((v) => v.expires && daysBetween(today, v.expires.on) <= input.expiring_within_days!);
  }
  views.sort(
    input.sort === 'location'
      ? (a, b) => a.location.localeCompare(b.location) || byExpiry(a, b)
      : input.sort === 'recent'
        ? (a, b) => (b.acquired_on ?? '').localeCompare(a.acquired_on ?? '')
        : byExpiry,
  );
  return { today, total: views.length, items: views.slice(0, input.limit), links: { inventory: links.inventory() } };
}

export async function getInventoryPage(deps: Deps, p: Principal, input: { location?: string }, now = new Date()) {
  const { today, links } = await context(deps, p, now);
  let views = (await activeRows(deps.db, p.householdId)).map(({ lot, food }) => toLotView(lot, food, today, links, now));
  // Household-wide totals, so a filtered page can still show every location's count.
  const counts = { total: views.length, use_soon: views.filter((v) => v.urgency && v.urgency !== 'later').length, by_location: {} as Record<string, number> };
  for (const v of views) counts.by_location[v.location] = (counts.by_location[v.location] ?? 0) + 1;
  if (input.location) views = views.filter((v) => v.location === input.location);
  const byLocation: Record<string, LotView[]> = {};
  for (const v of [...views].sort((a, b) => a.food.name.localeCompare(b.food.name))) (byLocation[v.location] ??= []).push(v);
  const locations = [...new Set([...DEFAULT_LOCATIONS, ...views.map((v) => v.location)])];
  return { today, use_soon: bucket(views), by_location: byLocation, locations, counts };
}

export async function getItem(deps: Deps, p: Principal, lotId: string, now = new Date()) {
  const { db } = deps;
  const { today, links } = await context(deps, p, now);
  const [row] = await db
    .select({ lot: lots, food: foods })
    .from(lots)
    .innerJoin(foods, eq(lots.foodId, foods.id))
    .where(and(eq(lots.id, lotId), eq(lots.householdId, p.householdId)));
  if (!row) throw notFound('Item');

  const history = await db
    .select({ c: changes, cs: changeSets, by: users.displayName, via: connections.clientName })
    .from(changes)
    .innerJoin(changeSets, eq(changeSets.id, changes.changeSetId))
    .innerJoin(users, eq(users.id, changeSets.actorUserId))
    .leftJoin(connections, eq(connections.id, changeSets.connectionId))
    .where(eq(changes.lotId, lotId))
    .orderBy(changes.createdAt, changes.seq);

  const observationIds = [...new Set([row.lot.lastEvidenceObservationId, ...history.map((h) => h.c.causeObservationId)].filter((x): x is string => Boolean(x)))];
  const obsRows = observationIds.length ? await db.select().from(observations).where(inArray(observations.id, observationIds)) : [];
  const opIds = history.map((h) => h.c.causeProposalOpId).filter((x): x is string => Boolean(x));
  const opRows = opIds.length ? await db.select().from(proposalOps).where(inArray(proposalOps.id, opIds)) : [];
  const proposalRows = obsRows.length ? await db.select().from(proposals).where(inArray(proposals.observationId, obsRows.map((o) => o.id))) : [];

  const evidence = obsRows.map((o) => {
    const payload = o.payload as { store?: string; purchased_at?: string };
    const op = opRows.find((x) => history.some((h) => h.c.causeProposalOpId === x.id && h.c.causeObservationId === o.id));
    const line = op ? (op.payload as unknown as LotDraft).line : undefined;
    const proposal = proposalRows.find((x) => x.observationId === o.id);
    return {
      observation_id: o.id,
      kind: o.kind,
      observed_at: o.observedAt.toISOString(),
      summary: o.kind === 'receipt' ? `Receipt · ${payload.store ?? 'unknown store'} · ${payload.purchased_at?.slice(0, 10) ?? ''}` : o.kind,
      store: payload.store ?? null,
      purchased_at: payload.purchased_at ?? null,
      line: line?.raw_text ?? null,
      price_cents: line?.price_cents ?? null,
      review_url: proposal ? links.review(proposal.id) : null,
    };
  });

  const callIds = [
    ...Object.values(row.food.shelfLife).map((e) => e?.reasoning_call_id),
    ...opRows.map((o) => o.reasoningCallId),
  ].filter((x): x is string => Boolean(x));
  const calls = callIds.length ? await db.select().from(reasoningCalls).where(inArray(reasoningCalls.id, [...new Set(callIds)])) : [];

  return {
    today,
    lot: toLotView(row.lot, row.food, today, links, now),
    food: {
      id: row.food.id,
      name: row.food.name,
      category: row.food.category,
      perishability: row.food.perishability,
      aliases: row.food.aliases,
      shelf_life: row.food.shelfLife,
      default_location: row.food.defaultLocation,
    },
    evidence,
    history: history.map((h) => ({
      change_set_id: h.cs.id,
      label: h.cs.label,
      op: h.c.op,
      at: h.c.createdAt.toISOString(),
      by: h.by,
      via: h.via,
      undone: Boolean(h.cs.revertedByChangeSetId),
      is_undo: Boolean(h.cs.revertsChangeSetId),
    })),
    reasoning: calls.map((c) => ({ call_id: c.id, function: c.function, provider: c.provider, model: c.model, path: c.path, at: c.createdAt.toISOString() })),
    links: { item: links.item(row.lot.id), inventory: links.inventory() },
  };
}
