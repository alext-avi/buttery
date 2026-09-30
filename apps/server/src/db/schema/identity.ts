import { integer, pgTable, primaryKey, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const households = pgTable('households', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('America/New_York'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  authSubject: text('auth_subject').unique(),
  email: text('email').unique(),
  displayName: text('display_name'),
  defaultHouseholdId: uuid('default_household_id').references(() => households.id),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const memberships = pgTable(
  'memberships',
  {
    householdId: uuid('household_id').notNull().references(() => households.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    role: text('role', { enum: ['owner', 'member'] }).notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.householdId, t.userId] })],
);

export const connections = pgTable('connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  householdId: uuid('household_id').notNull().references(() => households.id),
  kind: text('kind', { enum: ['pat', 'oauth_client', 'web'] }).notNull(),
  clientName: text('client_name').notNull(),
  oauthClientId: text('oauth_client_id'),
  tokenHash: text('token_hash').unique(),
  tokenPrefix: text('token_prefix'),
  /** The connection that vouched for this one: a web session created from a login code or a pasted token. */
  parentConnectionId: uuid('parent_connection_id').references((): AnyPgColumn => connections.id),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/**
 * Codes an agent attaches to a link. Opening the link within the window grants a page pass for that one page
 * (not a sign-in); it can be opened any number of times until it expires. Only an HMAC of the code is stored.
 */
export const loginCodes = pgTable('login_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  codeHash: text('code_hash').notNull().unique(),
  /** The page the code opens, e.g. /review/<id>, and what it grants: a receipt, an item or the inventory. */
  path: text('path').notNull(),
  scopeKind: text('scope_kind', { enum: ['proposal', 'lot', 'inventory'] }).notNull(),
  scopeId: uuid('scope_id'),
  householdId: uuid('household_id').notNull().references(() => households.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  connectionId: uuid('connection_id').notNull().references(() => connections.id),
  /** How many times the link was opened; kept for the record, not a limit. */
  uses: integer('uses').notNull().default(0),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});
