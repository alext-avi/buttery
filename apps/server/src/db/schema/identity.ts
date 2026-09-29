import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});
