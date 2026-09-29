import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, jsonb, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { Expiry, Package, Quantity, ShelfLifeMap } from '@buttery/domain';
import { LOT_STATES } from '@buttery/domain';
import { connections, households, ts, users } from './identity';

export const OBSERVATION_KINDS = ['receipt', 'pantry_photo', 'meal_photo', 'recipe_capture', 'user_statement', 'shopping_completion', 'web_correction'] as const;
export const PROPOSAL_STATUSES = ['pending', 'partial', 'applied', 'rejected', 'superseded'] as const;
export const OP_TYPES = ['add_lot', 'ignore_line', 'create_food', 'add_alias', 'adjust_quantity', 'consume', 'discard', 'move', 'open', 'freeze', 'thaw', 'set_expiry', 'confirm_present', 'flag_not_seen', 'confirm_purchase'] as const;
export const DECISIONS = ['pending', 'accepted', 'edited', 'rejected', 'conflict'] as const;
export const LOT_STATUSES = ['active', 'depleted', 'discarded', 'voided'] as const;
const CONFIDENCE = ['high', 'medium', 'low'] as const;

const householdId = () => uuid('household_id').notNull().references(() => households.id);

export const foods = pgTable(
  'foods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: householdId(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
    category: text('category'),
    perishability: text('perishability', { enum: ['shelf_stable', 'perishable'] }).notNull(),
    shelfLife: jsonb('shelf_life').$type<ShelfLifeMap>().notNull().default({}),
    defaultLocation: text('default_location'),
    defaultPackage: jsonb('default_package').$type<Package | null>(),
    isStaple: boolean('is_staple').notNull().default(false),
    archivedAt: ts('archived_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('foods_household_name').on(t.householdId, t.normalizedName)],
);

export const lots = pgTable(
  'lots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: householdId(),
    foodId: uuid('food_id').notNull().references(() => foods.id),
    location: text('location').notNull(),
    state: text('state', { enum: LOT_STATES }).notNull().default('sealed'),
    quantity: jsonb('quantity').$type<Quantity>().notNull(),
    package: jsonb('package').$type<Package | null>(),
    expires: jsonb('expires').$type<Expiry | null>(),
    printedExpiryOn: date('printed_expiry_on', { mode: 'string' }),
    acquiredOn: date('acquired_on', { mode: 'string' }),
    openedOn: date('opened_on', { mode: 'string' }),
    frozenOn: date('frozen_on', { mode: 'string' }),
    thawedOn: date('thawed_on', { mode: 'string' }),
    lastEvidenceAt: ts('last_evidence_at'),
    lastEvidenceObservationId: uuid('last_evidence_observation_id'),
    status: text('status', { enum: LOT_STATUSES }).notNull().default('active'),
    version: integer('version').notNull().default(1),
    notes: text('notes'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('lots_household_status').on(t.householdId, t.status), index('lots_food').on(t.foodId)],
);

export const observations = pgTable(
  'observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: householdId(),
    kind: text('kind', { enum: OBSERVATION_KINDS }).notNull(),
    observedAt: ts('observed_at').notNull(),
    recordedAt: ts('recorded_at').notNull().defaultNow(),
    actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
    connectionId: uuid('connection_id').references(() => connections.id),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    fingerprint: text('fingerprint'),
    nearKey: text('near_key'),
    status: text('status', { enum: ['open', 'resolved'] }).notNull().default('open'),
  },
  (t) => [unique('observations_fingerprint').on(t.householdId, t.fingerprint), index('observations_near_key').on(t.householdId, t.nearKey)],
);

export const proposals = pgTable('proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: householdId(),
  observationId: uuid('observation_id').notNull().references(() => observations.id),
  status: text('status', { enum: PROPOSAL_STATUSES }).notNull().default('pending'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const proposalOps = pgTable(
  'proposal_ops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: householdId(),
    proposalId: uuid('proposal_id').notNull().references(() => proposals.id),
    seq: integer('seq').notNull(),
    op: text('op', { enum: OP_TYPES }).notNull(),
    sourceLineId: text('source_line_id'),
    targetFoodId: uuid('target_food_id').references(() => foods.id),
    targetLotId: uuid('target_lot_id').references(() => lots.id),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    confidence: text('confidence', { enum: CONFIDENCE }).notNull(),
    rationale: text('rationale'),
    candidates: jsonb('candidates').$type<Array<{ food_id: string; name: string; score: number }>>().notNull().default([]),
    basedOnVersion: integer('based_on_version'),
    decision: text('decision', { enum: DECISIONS }).notNull().default('pending'),
    appliedAt: ts('applied_at'),
    resultChangeSetId: uuid('result_change_set_id'),
    reasoningCallId: uuid('reasoning_call_id'),
  },
  (t) => [unique('proposal_ops_seq').on(t.proposalId, t.seq)],
);

export const changeSets = pgTable(
  'change_sets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: householdId(),
    label: text('label').notNull(),
    actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
    connectionId: uuid('connection_id').references(() => connections.id),
    causeObservationId: uuid('cause_observation_id').references(() => observations.id),
    causeProposalId: uuid('cause_proposal_id').references(() => proposals.id),
    revertsChangeSetId: uuid('reverts_change_set_id'),
    revertedByChangeSetId: uuid('reverted_by_change_set_id'),
    idempotencyKey: text('idempotency_key'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('change_sets_household_created').on(t.householdId, t.createdAt)],
);

export const changes = pgTable(
  'changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    householdId: householdId(),
    changeSetId: uuid('change_set_id').notNull().references(() => changeSets.id),
    seq: integer('seq').notNull(),
    op: text('op').notNull(),
    lotId: uuid('lot_id').references(() => lots.id),
    foodId: uuid('food_id').references(() => foods.id),
    before: jsonb('before'),
    after: jsonb('after'),
    causeObservationId: uuid('cause_observation_id').references(() => observations.id),
    causeProposalOpId: uuid('cause_proposal_op_id').references(() => proposalOps.id),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('changes_lot').on(t.lotId), index('changes_set').on(t.changeSetId)],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    householdId: householdId(),
    tool: text('tool').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.tool, t.key] })],
);

export const reasoningCalls = pgTable('reasoning_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  householdId: householdId(),
  function: text('function').notNull(),
  provider: text('provider').notNull(),
  model: text('model'),
  path: text('path').notNull(),
  inputHash: text('input_hash').notNull(),
  input: jsonb('input'),
  output: jsonb('output'),
  valid: boolean('valid').notNull(),
  violations: jsonb('violations').$type<string[]>().notNull().default([]),
  latencyMs: integer('latency_ms'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  error: text('error'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type FoodRow = typeof foods.$inferSelect;
export type LotRow = typeof lots.$inferSelect;
export type ObservationRow = typeof observations.$inferSelect;
export type ProposalRow = typeof proposals.$inferSelect;
export type ProposalOpRow = typeof proposalOps.$inferSelect;
export type ChangeSetRow = typeof changeSets.$inferSelect;
export type ChangeRow = typeof changes.$inferSelect;
