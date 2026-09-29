# Buttery Phase 0–1 (Foundations + Receipt Slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user shares a receipt with any MCP agent, reviews the extracted purchases on a phone-friendly page, commits them to a household inventory with provenance, undo and estimated expiry, and recovers that inventory from a fresh agent conversation.

**Architecture:** One Node/TypeScript service (Hono) serves MCP (Streamable HTTP, stateless), a JSON API and a React/Vite SPA. Both surfaces call one services layer, built on pure rules in `packages/domain`. Postgres holds current state and an append-only change log, written in the same transaction. Text reasoning goes through a `ReasoningPort`. It runs on an interim heuristic until the parallel `packages/reasoning` (Crusoe) PR lands; Task 18 wires that in.

**Tech Stack:** Node 26, npm workspaces, TypeScript 7 (`tsc --noEmit`), tsx, Hono 4 + @hono/node-server 2, @modelcontextprotocol/sdk 1.31 (`WebStandardStreamableHTTPServerTransport`), Zod 4, Drizzle ORM 0.45 + drizzle-kit + postgres.js, PostgreSQL 17 (Docker), Vitest 5, React 19 + React Router 8 + Vite 8, Playwright, jose, @workos-inc/node 11.

**Spec:** `docs/superpowers/specs/2026-09-29-buttery-design.md` (Sections 2–7, 9 and 10 Phases 0–1). Parallel work: `docs/handoffs/2026-09-29-crusoe-reasoning.md` (the `packages/reasoning` contract).

## Global Constraints

- Node 26; npm workspaces `packages/*`, `apps/*`. Workspace packages are ESM (`"type": "module"`). The root stays CommonJS for the existing `playwright.config.js`.
- TypeScript strict, extensionless relative imports (`moduleResolution: "Bundler"`), run with `tsx`; `npm run typecheck` must pass at every commit.
- Zod 4 everywhere (`import { z } from 'zod'`).
- PostgreSQL 17 container. **Every table carries `household_id`; every query is household-scoped in the services layer.**
- IDs are UUIDs (`gen_random_uuid()`).
- **Every state-changing MCP tool and API call requires `idempotency_key` (8–200 chars).** Same key + same request → stored response. Same key + different request → `idempotency_key_reused` (409).
- All links are absolute under `PUBLIC_BASE_URL`.
- **Model output is never committed directly.** It only becomes proposal ops, or estimated values carrying `confidence` and a `basis` that names the source.
- Phase 1 automation policy: **receipts are review-all.** `submit_observation` never changes inventory.
- Coupon, non-food and return lines never create lots. Return reconciliation is Phase 2.
- PATs are `btr_` + 32 url-safe chars, stored as SHA-256 hashes only.
- Expiry dates are local `YYYY-MM-DD` strings in the household timezone (`households.timezone`, default `America/New_York`).
- Changes are append-only; undo is a compensating change set. Lots are never deleted: undo sets `status = 'voided'`.

## Review Focus

1. **A second photo of the same receipt, transcribed slightly differently** (e.g. the receipt number is missing from one transcription, or the time differs by a minute). Expected: no silent duplicate. Either `duplicate_of` (same fingerprint) or `possible_duplicate_of` plus an uncertainty (same store, date and total). Pinned in Task 11.
2. **Multipack and package-count lines** (`GRK YOGURT 2X32 OZ`, `EGGS 24 CT`, `CHICKPEAS 15 OZ CAN` ×4, weighed `BANANAS 1.25 LB`). Expected: 2 containers of 32 oz, 24 eggs, 4 cans of 15 oz and 1.25 lb, never 2 multipacks or 24 packages. Pinned in Tasks 5 and 11.
3. **Coupon, non-food and return lines.** Expected: they appear as ignored lines and never create lots, even after "Accept all" and apply. Pinned in Tasks 11 and 12.
4. **Double-tapping Apply** (two resolve calls with different idempotency keys). Expected: lots are created once, and the second call reports nothing left to apply. Pinned in Task 12.
5. **Reasoning unavailable or throwing mid-receipt.** Expected: the proposal is still created from heuristics, with lower confidence and `fallback_used: true`. Nothing is lost or applied. Pinned in Task 11.

## Task order vs. spec phases

Tasks 1–4 are Phase 0 foundations over personal access tokens (PATs). Tasks 5–17 are Phase 1. Task 18 wires Crusoe once the parallel PR merges. Task 19 adds AuthKit OAuth. Task 20 adds self-serve sign-up and onboarding (account, household, agent tokens). Task 21 finishes Phase 0 (container, agentdock, Tailscale Funnel) and runs the Phase 0 and Phase 1 acceptance checks. This order is deliberate: the receipt slice works end to end over PATs before any external identity or hosting dependency.

## File map

```
package.json                     root workspaces + scripts (modified)
tsconfig.base.json               shared compiler options
docker-compose.yml               db (Task 2), app (Task 21)
docker/postgres-init/01-databases.sql
Dockerfile, .dockerignore        (Task 21)
.env.example
playwright.config.js             (modified, Task 16)
tests/e2e/*.spec.ts              Playwright, phone viewport
packages/domain/src/
  common.ts      Confidence, Perishability, LotState, IdempotencyKeySchema
  dates.ts       IsoDate math, todayIn, formatShortDate
  quantity.ts    units, Quantity/Package, quantityFromReceiptLine, describeQuantity
  expiry.ts      ShelfLifeMap, Expiry, computeEffectiveExpiry, urgencyOf, describeExpiry
  normalize.ts   normalizeName, similarity
  catalog.ts     CatalogFood, exactAliasMatch, shortlist
  hash.ts        canonicalJson, sha256Hex, hashJson
  receipt.ts     Receipt schemas, receiptFingerprint, receiptNearKey, withLineIds
  index.ts
apps/server/src/
  config.ts, errors.ts, main.ts
  db/client.ts, db/migrate.ts, db/schema/{identity,ledger,index}.ts
  identity/{principal,tokens,provision,webConnection}.ts
  auth/{bearer,session,authkit}.ts
  reasoning/{port,interim,record,provider}.ts
  services/{idempotency,changes,proposalStatus,foods,links,drafts,receipts,proposals,views,inventory,identity}.ts
  mcp/{instructions,server,respond}.ts, mcp/tools/{whoami,inventory,observations,foods}.ts
  http/{app,mcpRoute,wellKnown,authRoutes,apiRoutes,web}.ts
  cli/{migrate,token-create,seed-e2e}.ts
apps/server/test/                vitest (real Postgres: buttery_test)
apps/web/src/
  main.tsx, api.ts, types.ts, styles.css
  components/{Layout,Badges,OpCard}.tsx
  pages/{Login,Review,Inventory,Item}.tsx
```

---

### Task 1: Workspace scaffold and server health check

**Files:**
- Modify: `package.json`
- Create: `tsconfig.base.json`, `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`, `apps/server/src/http/app.ts`, `apps/server/src/main.ts`
- Test: `apps/server/test/health.test.ts`

**Interfaces:**
- Produces: `createApp(): Hono`. Task 4 changes this to `createApp(deps: AppDeps)`.

- [ ] **Step 1: Replace the root `package.json`**

```json
{
  "name": "buttery",
  "private": true,
  "type": "commonjs",
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "dev": "npm run dev -w apps/server",
    "test": "npm test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "e2e": "playwright test",
    "db:up": "docker compose up -d db",
    "db:migrate": "npm run db:migrate -w apps/server",
    "token:create": "npm run token:create -w apps/server --"
  },
  "devDependencies": {
    "@playwright/test": "^1.63.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  }
}
```

- [ ] **Step 3: Create the server package**

`apps/server/package.json`:

```json
{
  "name": "@buttery/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch --env-file-if-exists=../../.env src/main.ts",
    "start": "tsx --env-file-if-exists=../../.env src/main.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  }
}
```

`apps/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test", "vitest.config.ts", "drizzle.config.ts"]
}
```

`apps/server/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20000,
  },
});
```

Run: `npm i -w apps/server hono @hono/node-server zod && npm i -D -w apps/server tsx vitest typescript @types/node`

- [ ] **Step 4: Write the failing test** `apps/server/test/health.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app';

describe('health', () => {
  it('responds ok', async () => {
    const res = await createApp().request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npm test -w apps/server`
Expected: FAIL (cannot resolve `../src/http/app`).

- [ ] **Step 6: Implement** `apps/server/src/http/app.ts`

```ts
import { Hono } from 'hono';

export function createApp() {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  return app;
}
```

`apps/server/src/main.ts`:

```ts
import { serve } from '@hono/node-server';
import { createApp } from './http/app';

const port = Number(process.env.PORT ?? 8790);
serve({ fetch: createApp().fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`buttery listening on :${info.port}`);
});
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npm test -w apps/server && npm run typecheck`
Expected: 1 test passes; typecheck is clean.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json apps/server
git commit -m "chore: npm workspaces and server health check"
```

---

### Task 2: Postgres, Drizzle, identity schema and test database harness

**Files:**
- Create: `docker-compose.yml`, `docker/postgres-init/01-databases.sql`, `.env.example`, `apps/server/drizzle.config.ts`, `apps/server/src/config.ts`, `apps/server/src/db/client.ts`, `apps/server/src/db/schema/identity.ts`, `apps/server/src/db/schema/index.ts`, `apps/server/src/db/migrate.ts`, `apps/server/src/cli/migrate.ts`, `apps/server/test/global-setup.ts`, `apps/server/test/setup.ts`, `apps/server/test/helpers/db.ts`
- Modify: `apps/server/package.json` (scripts), `apps/server/vitest.config.ts`
- Test: `apps/server/test/db.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?): Config`; `createDb(url): Db`; types `Db`, `Tx`, `Executor` (accepts either a `Db` or a `Tx`); tables `households`, `users`, `memberships`, `connections`; `runMigrations(url)`; test helpers `TEST_DB_URL`, `testDb()`, `resetDb()`, `closeTestDb()`.

- [ ] **Step 1: Create `docker-compose.yml`**

```yaml
name: buttery
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_USER: buttery
      POSTGRES_PASSWORD: buttery
      POSTGRES_DB: buttery
    ports: ["127.0.0.1:5433:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/postgres-init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U buttery"]
      interval: 2s
      timeout: 3s
      retries: 30
volumes:
  pgdata:
```

`docker/postgres-init/01-databases.sql`:

```sql
CREATE DATABASE buttery_test OWNER buttery;
CREATE DATABASE buttery_e2e OWNER buttery;
```

`.env.example`:

```sh
DATABASE_URL=postgres://buttery:buttery@localhost:5433/buttery
TEST_DATABASE_URL=postgres://buttery:buttery@localhost:5433/buttery_test
PORT=8790
PUBLIC_BASE_URL=http://localhost:8790
SESSION_SECRET=replace-with-at-least-32-random-characters
# AuthKit (Task 19)
AUTHKIT_DOMAIN=
AUTHKIT_ISSUER=
WORKOS_CLIENT_ID=
WORKOS_API_KEY=
```

Run: `cp .env.example .env && docker compose up -d db && docker compose ps`
Expected: `db` is `healthy`. (The init script only runs on first volume creation. If the volume already existed, run `docker compose down -v` first.)

- [ ] **Step 2: Install dependencies**

Run: `npm i -w apps/server drizzle-orm postgres && npm i -D -w apps/server drizzle-kit`

- [ ] **Step 3: Create `apps/server/src/config.ts`**

```ts
import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(8790),
  PUBLIC_BASE_URL: z.url().default('http://localhost:8790'),
  SESSION_SECRET: z.string().min(32),
  WEB_DIST_DIR: z.string().optional(),
  AUTHKIT_DOMAIN: z.url().optional(),
  AUTHKIT_ISSUER: z.url().optional(),
  WORKOS_CLIENT_ID: z.string().optional(),
  WORKOS_API_KEY: z.string().optional(),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const config = EnvSchema.parse(present);
  return { ...config, PUBLIC_BASE_URL: config.PUBLIC_BASE_URL.replace(/\/$/, '') };
}
```

- [ ] **Step 4: Create the identity schema** `apps/server/src/db/schema/identity.ts`

```ts
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
```

`apps/server/src/db/schema/index.ts`:

```ts
export * from './identity';
```

- [ ] **Step 5: Create the DB client and migrations**

`apps/server/src/db/client.ts`:

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import * as schema from './schema';

export function createDb(url: string) {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  return drizzle({ client, schema });
}

export type Db = ReturnType<typeof createDb>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Executor = PgDatabase<any, typeof schema>;
```

`apps/server/src/db/migrate.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(url: string): Promise<void> {
  const db = createDb(url);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await db.$client.end();
  }
}
```

`apps/server/src/cli/migrate.ts`:

```ts
import { runMigrations } from '../db/migrate';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
await runMigrations(url);
console.log('migrations applied');
```

`apps/server/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
});
```

Add to the `apps/server/package.json` scripts:

```json
"db:generate": "drizzle-kit generate",
"db:migrate": "tsx --env-file-if-exists=../../.env src/cli/migrate.ts"
```

Run: `npm run db:generate -w apps/server`
Expected: `apps/server/drizzle/0000_*.sql` is created with 4 tables.

- [ ] **Step 6: Create the test harness**

`apps/server/test/helpers/db.ts`:

```ts
import { sql } from 'drizzle-orm';
import { createDb, type Db } from '../../src/db/client';

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://buttery:buttery@localhost:5433/buttery_test';

let shared: Db | undefined;

export function testDb(): Db {
  shared ??= createDb(TEST_DB_URL);
  return shared;
}

export async function resetDb(db: Db = testDb()): Promise<void> {
  const rows = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = rows.map((r) => `"${r.tablename}"`).join(', ');
  if (names) await db.execute(sql.raw(`truncate ${names} restart identity cascade`));
}

export async function closeTestDb(): Promise<void> {
  if (shared) await shared.$client.end();
  shared = undefined;
}
```

`apps/server/test/global-setup.ts`:

```ts
import { runMigrations } from '../src/db/migrate';
import { TEST_DB_URL } from './helpers/db';

export default async function setup() {
  await runMigrations(TEST_DB_URL);
}
```

`apps/server/test/setup.ts`:

```ts
import { afterAll } from 'vitest';
import { closeTestDb } from './helpers/db';

afterAll(async () => {
  await closeTestDb();
});
```

Replace `apps/server/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
    testTimeout: 20000,
  },
});
```

- [ ] **Step 7: Write the failing test** `apps/server/test/db.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { households } from '../src/db/schema';
import { loadConfig } from '../src/config';
import { resetDb, testDb } from './helpers/db';

describe('database', () => {
  beforeEach(() => resetDb());

  it('stores and reads a household with the default timezone', async () => {
    const db = testDb();
    const [h] = await db.insert(households).values({ name: 'Test' }).returning();
    const [read] = await db.select().from(households).where(eq(households.id, h!.id));
    expect(read?.timezone).toBe('America/New_York');
  });

  it('rejects a short session secret', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', SESSION_SECRET: 'short' })).toThrow();
  });

  it('strips a trailing slash from PUBLIC_BASE_URL', () => {
    const c = loadConfig({ DATABASE_URL: 'x', SESSION_SECRET: 'x'.repeat(32), PUBLIC_BASE_URL: 'https://a.test/' });
    expect(c.PUBLIC_BASE_URL).toBe('https://a.test');
  });
});
```

- [ ] **Step 8: Run tests**

Run: `npm test -w apps/server`
Expected: all pass. The migration is applied to `buttery_test` by global setup.

- [ ] **Step 9: Commit**

```bash
git add docker-compose.yml docker .env.example apps/server package-lock.json
git commit -m "feat: postgres, drizzle identity schema, test db harness"
```

---

### Task 3: Identity provisioning, personal access tokens and CLI

**Files:**
- Create: `apps/server/src/identity/principal.ts`, `apps/server/src/identity/tokens.ts`, `apps/server/src/identity/provision.ts`, `apps/server/src/cli/token-create.ts`
- Modify: `apps/server/package.json` (script)
- Test: `apps/server/test/identity.test.ts`

**Interfaces:**
- Consumes: `Db`, `Executor`, identity tables.
- Produces:
  - `type Principal = { userId: string; householdId: string; connectionId: string; clientName: string }`
  - `PAT_PREFIX`, `hashToken(t): string`, `createPat(db, { userId, householdId, clientName }): Promise<{ token; connectionId }>`, `resolvePat(db, token): Promise<Principal | null>`
  - `provisionUser(db, { authSubject?, email?, displayName? }): Promise<{ userId; householdId; created: boolean }>`

- [ ] **Step 1: Write the failing test** `apps/server/test/identity.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connections, memberships, users } from '../src/db/schema';
import { provisionUser } from '../src/identity/provision';
import { createPat, resolvePat } from '../src/identity/tokens';
import { resetDb, testDb } from './helpers/db';

describe('identity', () => {
  beforeEach(() => resetDb());
  const db = testDb();

  it('provisions a user as owner of a new household', async () => {
    const r = await provisionUser(db, { email: 'a@example.com', displayName: 'Alex' });
    expect(r.created).toBe(true);
    const [m] = await db.select().from(memberships).where(eq(memberships.userId, r.userId));
    expect(m).toMatchObject({ householdId: r.householdId, role: 'owner' });
  });

  it('returns the same user for the same auth subject', async () => {
    const a = await provisionUser(db, { authSubject: 'user_1', email: 'a@example.com' });
    const b = await provisionUser(db, { authSubject: 'user_1' });
    expect(b).toMatchObject({ userId: a.userId, householdId: a.householdId, created: false });
  });

  it('links an auth subject to an existing email-only user', async () => {
    const a = await provisionUser(db, { email: 'a@example.com' });
    const b = await provisionUser(db, { authSubject: 'user_9', email: 'A@Example.com' });
    expect(b.userId).toBe(a.userId);
    const [u] = await db.select().from(users).where(eq(users.id, a.userId));
    expect(u?.authSubject).toBe('user_9');
  });

  it('creates and resolves a personal access token', async () => {
    const u = await provisionUser(db, { email: 'a@example.com' });
    const { token, connectionId } = await createPat(db, { userId: u.userId, householdId: u.householdId, clientName: 'Claude Code' });
    expect(token).toMatch(/^btr_[A-Za-z0-9_-]{32}$/);
    const p = await resolvePat(db, token);
    expect(p).toEqual({ userId: u.userId, householdId: u.householdId, connectionId, clientName: 'Claude Code' });
    const [row] = await db.select().from(connections).where(eq(connections.id, connectionId));
    expect(row?.tokenHash).not.toContain(token);
  });

  it('rejects revoked, unknown and non-prefixed tokens', async () => {
    const u = await provisionUser(db, { email: 'a@example.com' });
    const { token, connectionId } = await createPat(db, { userId: u.userId, householdId: u.householdId, clientName: 'x' });
    await db.update(connections).set({ revokedAt: new Date() }).where(eq(connections.id, connectionId));
    expect(await resolvePat(db, token)).toBeNull();
    expect(await resolvePat(db, 'btr_nope')).toBeNull();
    expect(await resolvePat(db, 'eyJhbGciOi...')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w apps/server -- identity`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`apps/server/src/identity/principal.ts`:

```ts
export type Principal = {
  userId: string;
  householdId: string;
  connectionId: string;
  clientName: string;
};
```

`apps/server/src/identity/tokens.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { connections } from '../db/schema';
import type { Principal } from './principal';

export const PAT_PREFIX = 'btr_';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createPat(
  db: Executor,
  input: { userId: string; householdId: string; clientName: string },
): Promise<{ token: string; connectionId: string }> {
  const token = PAT_PREFIX + randomBytes(24).toString('base64url');
  const [row] = await db
    .insert(connections)
    .values({
      userId: input.userId,
      householdId: input.householdId,
      kind: 'pat',
      clientName: input.clientName,
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, 8),
    })
    .returning({ id: connections.id });
  return { token, connectionId: row!.id };
}

export async function resolvePat(db: Executor, token: string): Promise<Principal | null> {
  if (!token.startsWith(PAT_PREFIX)) return null;
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.tokenHash, hashToken(token)), isNull(connections.revokedAt)))
    .limit(1);
  if (!row) return null;
  await db.update(connections).set({ lastUsedAt: new Date() }).where(eq(connections.id, row.id));
  return { userId: row.userId, householdId: row.householdId, connectionId: row.id, clientName: row.clientName };
}
```

`apps/server/src/identity/provision.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { households, memberships, users } from '../db/schema';

export type ProvisionInput = { authSubject?: string | null; email?: string | null; displayName?: string | null };
export type ProvisionResult = { userId: string; householdId: string; created: boolean };

async function householdFor(db: Db, userId: string, defaultHouseholdId: string | null): Promise<string> {
  if (defaultHouseholdId) return defaultHouseholdId;
  const [m] = await db.select().from(memberships).where(eq(memberships.userId, userId)).limit(1);
  if (!m) throw new Error(`user ${userId} has no household`);
  return m.householdId;
}

export async function provisionUser(db: Db, input: ProvisionInput): Promise<ProvisionResult> {
  const email = input.email?.trim().toLowerCase() || null;

  if (input.authSubject) {
    const [bySubject] = await db.select().from(users).where(eq(users.authSubject, input.authSubject)).limit(1);
    if (bySubject) {
      return { userId: bySubject.id, householdId: await householdFor(db, bySubject.id, bySubject.defaultHouseholdId), created: false };
    }
  }

  if (email) {
    const [byEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (byEmail) {
      if (input.authSubject && !byEmail.authSubject) {
        await db
          .update(users)
          .set({ authSubject: input.authSubject })
          .where(and(eq(users.id, byEmail.id), isNull(users.authSubject)));
      }
      return { userId: byEmail.id, householdId: await householdFor(db, byEmail.id, byEmail.defaultHouseholdId), created: false };
    }
  }

  return db.transaction(async (tx) => {
    const name = input.displayName ? `${input.displayName}'s household` : 'Home';
    const [household] = await tx.insert(households).values({ name }).returning();
    const [user] = await tx
      .insert(users)
      .values({
        authSubject: input.authSubject ?? null,
        email,
        displayName: input.displayName ?? null,
        defaultHouseholdId: household!.id,
      })
      .returning();
    await tx.insert(memberships).values({ householdId: household!.id, userId: user!.id, role: 'owner' });
    return { userId: user!.id, householdId: household!.id, created: true };
  });
}
```

- [ ] **Step 4: Add the CLI** `apps/server/src/cli/token-create.ts`

```ts
import { parseArgs } from 'node:util';
import { createDb } from '../db/client';
import { provisionUser } from '../identity/provision';
import { createPat } from '../identity/tokens';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    client: { type: 'string', default: 'CLI' },
  },
});

if (!values.email) {
  console.error('usage: npm run token:create -- --email you@example.com [--name "Alex"] [--client "Claude Code"]');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const db = createDb(url);
try {
  const u = await provisionUser(db, { email: values.email, displayName: values.name ?? null });
  const { token } = await createPat(db, { userId: u.userId, householdId: u.householdId, clientName: values.client! });
  console.log(`household ${u.householdId}${u.created ? ' (new)' : ''}`);
  console.log(`token for "${values.client}": ${token}`);
  console.log('Store it now; it cannot be shown again.');
} finally {
  await db.$client.end();
}
```

Add the script to `apps/server/package.json`: `"token:create": "tsx --env-file-if-exists=../../.env src/cli/token-create.ts"`

- [ ] **Step 5: Run the tests**

Run: `npm test -w apps/server -- identity`
Expected: 5 pass.

- [ ] **Step 6: Try the CLI**

Run: `npm run db:migrate && npm run token:create -- --email you@example.com --name Alex --client "Claude Code"`
Expected: prints a household id and a `btr_…` token.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "feat: user/household provisioning and personal access tokens"
```

---

### Task 4: MCP endpoint with bearer auth, `whoami`, protected-resource metadata

**Files:**
- Create: `apps/server/src/errors.ts`, `apps/server/src/auth/bearer.ts`, `apps/server/src/services/identity.ts`, `apps/server/src/mcp/instructions.ts`, `apps/server/src/mcp/respond.ts`, `apps/server/src/mcp/server.ts`, `apps/server/src/mcp/tools/whoami.ts`, `apps/server/src/http/mcpRoute.ts`, `apps/server/src/http/wellKnown.ts`, `apps/server/test/helpers/app.ts`
- Modify: `apps/server/src/http/app.ts`, `apps/server/src/main.ts`, `apps/server/test/health.test.ts`
- Test: `apps/server/test/mcp-whoami.test.ts`

**Interfaces:**
- Consumes: `resolvePat`, `Principal`, `Config`, `Db`.
- Produces:
  - `class AppError(code, message, status = 400, details?)`, `notFound(what)`, `toAppError(err)`
  - `type BearerResolver = (token: string) => Promise<Principal | null>`
  - `type AppDeps = { config: Config; db: Db; resolveBearer?: BearerResolver }`. Task 10 adds `reasoning`.
  - `createApp(deps: AppDeps): Hono`
  - `buildMcpServer(deps, principal): McpServer`. Later tasks add `register*` calls here.
  - `toolResult(data)`, `withErrors(fn)`
  - `getWhoami(db, principal, config)`
  - Test helpers: `testConfig()`, `testDeps()`, `startServer(deps) → { url, close }`, `mcpClient(url, token)`, `callTool(client, name, args)`, `seedUser(db) → { principal, token }`

- [ ] **Step 1: Install**

Run: `npm i -w apps/server @modelcontextprotocol/sdk`

- [ ] **Step 2: Write the test helpers** `apps/server/test/helpers/app.ts`

```ts
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../../src/config';
import { createApp, type AppDeps } from '../../src/http/app';
import { provisionUser } from '../../src/identity/provision';
import { createPat } from '../../src/identity/tokens';
import type { Principal } from '../../src/identity/principal';
import type { Db } from '../../src/db/client';
import { TEST_DB_URL, testDb } from './db';

export function testConfig() {
  return loadConfig({
    DATABASE_URL: TEST_DB_URL,
    SESSION_SECRET: 'test-secret-test-secret-test-secret-123',
    PUBLIC_BASE_URL: 'https://buttery.test',
  });
}

export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return { config: testConfig(), db: testDb(), ...overrides };
}

export async function seedUser(
  db: Db,
  email = 'alex@example.com',
  clientName = 'Test Client',
): Promise<{ principal: Principal; token: string }> {
  const u = await provisionUser(db, { email, displayName: 'Alex' });
  const { token, connectionId } = await createPat(db, { userId: u.userId, householdId: u.householdId, clientName });
  return { token, principal: { userId: u.userId, householdId: u.householdId, connectionId, clientName } };
}

export async function startServer(deps: AppDeps): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createApp(deps);
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

export async function mcpClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'buttery-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return r.structuredContent ?? JSON.parse(text);
}
```

- [ ] **Step 3: Write the failing test** `apps/server/test/mcp-whoami.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from './helpers/db';
import { callTool, mcpClient, seedUser, startServer, testDeps } from './helpers/app';

describe('MCP whoami', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    await resetDb();
    server = await startServer(testDeps());
  });
  afterEach(() => server.close());

  it('identifies the user, household and connection', async () => {
    const { token, principal } = await seedUser(testDb(), 'alex@example.com', 'Claude Code');
    const client = await mcpClient(server.url, token);
    const me = await callTool(client, 'whoami');
    expect(me.household.id).toBe(principal.householdId);
    expect(me.connection.client_name).toBe('Claude Code');
    expect(me.links.inventory).toBe('https://buttery.test/inventory');
    await client.close();
  });

  it('rejects missing and invalid tokens with a resource-metadata challenge', async () => {
    for (const auth of [undefined, 'Bearer btr_invalid']) {
      const res = await fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain(
        'resource_metadata="https://buttery.test/.well-known/oauth-protected-resource"',
      );
    }
  });

  it('publishes protected-resource metadata', async () => {
    const res = await fetch(`${server.url}/.well-known/oauth-protected-resource`);
    expect(await res.json()).toMatchObject({ resource: 'https://buttery.test/mcp', bearer_methods_supported: ['header'] });
  });
});
```

Update `apps/server/test/health.test.ts` to the new signature:

```ts
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app';
import { testDeps } from './helpers/app';

describe('health', () => {
  it('responds ok', async () => {
    const res = await createApp(testDeps()).request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test -w apps/server -- mcp-whoami`
Expected: FAIL.

- [ ] **Step 5: Implement the errors, bearer resolver and identity service**

`apps/server/src/errors.ts`:

```ts
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError('not_found', `${what} not found`, 404);

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return new AppError('invalid_input', 'Invalid input', 422, err.issues);
  console.error(err);
  return new AppError('internal', 'Internal error', 500);
}
```

`apps/server/src/auth/bearer.ts`:

```ts
import type { Principal } from '../identity/principal';

export type BearerResolver = (token: string) => Promise<Principal | null>;

export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}
```

`apps/server/src/services/identity.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { households, users } from '../db/schema';
import type { Principal } from '../identity/principal';
import { notFound } from '../errors';

export async function getHousehold(db: Db, householdId: string) {
  const [h] = await db.select().from(households).where(eq(households.id, householdId));
  if (!h) throw notFound('Household');
  return h;
}

export async function getWhoami(db: Db, p: Principal, config: Config) {
  const household = await getHousehold(db, p.householdId);
  const [user] = await db.select().from(users).where(eq(users.id, p.userId));
  return {
    user: { id: p.userId, email: user?.email ?? null, display_name: user?.displayName ?? null },
    household: { id: household.id, name: household.name, timezone: household.timezone },
    connection: { id: p.connectionId, client_name: p.clientName },
    links: { inventory: `${config.PUBLIC_BASE_URL}/inventory` },
  };
}
```

- [ ] **Step 6: Implement the MCP server**

`apps/server/src/mcp/instructions.ts`:

```ts
export const MCP_INSTRUCTIONS = `Buttery keeps this household's authoritative food records: what we believe is on hand, the evidence behind each belief, and what changed.

Operating rules:
- Start a conversation with get_household_summary. It is compact and includes what needs attention and review links.
- The application, not the conversation, is the source of truth. Do not rely on memory of earlier chats.
- Receipts: transcribe every line verbatim with submit_observation (kind "receipt"). Do not guess expiry dates or storage. The server canonicalizes items, estimates shelf life and builds a proposal.
- Nothing from a receipt enters inventory until the user reviews it. Always give the user the review_url.
- A recipe ingredient or a photo never proves the household owns something. Never infer that an item is gone because it is not visible.
- Every change tool needs an idempotency_key. Generate a new one per user action and reuse it only when retrying the same call.
- After any change, tell the user what changed and that it can be undone (undo with the change_set_id).
- Quantities marked "~" are approximate; expiry marked "est." is an estimate with a confidence level. Say so when it matters.`;
```

`apps/server/src/mcp/respond.ts`:

```ts
import { toAppError } from '../errors';

export function toolResult(data: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

export function toolError(err: unknown) {
  const e = toAppError(err);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: e.code, message: e.message, details: e.details }) }],
  };
}

export function withErrors<A>(fn: (args: A) => Promise<object>) {
  return async (args: A) => {
    try {
      return toolResult((await fn(args)) as Record<string, unknown>);
    } catch (err) {
      return toolError(err);
    }
  };
}
```

`apps/server/src/mcp/tools/whoami.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../../http/app';
import type { Principal } from '../../identity/principal';
import { getWhoami } from '../../services/identity';
import { withErrors } from '../respond';

export function registerWhoami(server: McpServer, deps: AppDeps, p: Principal) {
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description: 'Identify the signed-in user, their household and this connection.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    withErrors(async () => getWhoami(deps.db, p, deps.config)),
  );
}
```

`apps/server/src/mcp/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../http/app';
import type { Principal } from '../identity/principal';
import { MCP_INSTRUCTIONS } from './instructions';
import { registerWhoami } from './tools/whoami';

export function buildMcpServer(deps: AppDeps, p: Principal): McpServer {
  const server = new McpServer({ name: 'buttery', version: '0.1.0' }, { instructions: MCP_INSTRUCTIONS });
  registerWhoami(server, deps, p);
  return server;
}
```

- [ ] **Step 7: Implement the HTTP routes**

`apps/server/src/http/mcpRoute.ts`:

```ts
import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { bearerToken } from '../auth/bearer';
import { resolvePat } from '../identity/tokens';
import { buildMcpServer } from '../mcp/server';
import type { AppDeps } from './app';

export function mcpRoutes(deps: AppDeps) {
  const resolve = deps.resolveBearer ?? ((t: string) => resolvePat(deps.db, t));
  const app = new Hono();
  app.all('/', async (c) => {
    const token = bearerToken(c.req.header('authorization'));
    const principal = token ? await resolve(token) : null;
    if (!principal) {
      return c.json({ error: 'unauthorized', message: 'A valid bearer token is required.' }, 401, {
        'WWW-Authenticate': `Bearer resource_metadata="${deps.config.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`,
      });
    }
    const server = buildMcpServer(deps, principal);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  return app;
}
```

`apps/server/src/http/wellKnown.ts`:

```ts
import { Hono } from 'hono';
import type { Config } from '../config';

export function wellKnownRoutes(config: Config) {
  const app = new Hono();
  const metadata = () => ({
    resource: `${config.PUBLIC_BASE_URL}/mcp`,
    resource_name: 'Buttery',
    authorization_servers: config.AUTHKIT_DOMAIN ? [config.AUTHKIT_DOMAIN] : [],
    bearer_methods_supported: ['header'],
  });
  app.get('/oauth-protected-resource', (c) => c.json(metadata()));
  app.get('/oauth-protected-resource/mcp', (c) => c.json(metadata()));
  app.get('/oauth-authorization-server', async (c) => {
    if (!config.AUTHKIT_DOMAIN) return c.json({ error: 'not_configured' }, 404);
    const res = await fetch(`${config.AUTHKIT_DOMAIN}/.well-known/oauth-authorization-server`);
    return c.json(await res.json(), res.ok ? 200 : 502);
  });
  return app;
}
```

Replace `apps/server/src/http/app.ts`:

```ts
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { BearerResolver } from '../auth/bearer';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { toAppError } from '../errors';
import { mcpRoutes } from './mcpRoute';
import { wellKnownRoutes } from './wellKnown';

export type AppDeps = {
  config: Config;
  db: Db;
  resolveBearer?: BearerResolver;
};

export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.onError((err, c) => {
    const e = toAppError(err);
    return c.json({ error: e.code, message: e.message, details: e.details }, e.status as ContentfulStatusCode);
  });
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.route('/.well-known', wellKnownRoutes(deps.config));
  app.route('/mcp', mcpRoutes(deps));
  return app;
}
```

Replace `apps/server/src/main.ts`:

```ts
import { serve } from '@hono/node-server';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { createApp } from './http/app';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const app = createApp({ config, db });

serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`buttery listening on :${info.port} (${config.PUBLIC_BASE_URL})`);
});
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npm test -w apps/server && npm run typecheck`
Expected: all pass.

- [ ] **Step 9: Manual check with Claude Code**

Run: `npm run dev` (in a separate terminal), then:
`claude mcp add --transport http buttery http://localhost:8790/mcp --header "Authorization: Bearer <token from Task 3>"`
Ask Claude Code to "call buttery whoami".
Expected: household and connection are returned.

- [ ] **Step 10: Commit**

```bash
git add apps/server package-lock.json
git commit -m "feat: MCP endpoint with PAT bearer auth, whoami, protected-resource metadata"
```

---

### Task 5: Domain package: dates, quantities, expiry and urgency

**Files:**
- Create: `packages/domain/package.json`, `packages/domain/tsconfig.json`, `packages/domain/src/common.ts`, `packages/domain/src/dates.ts`, `packages/domain/src/quantity.ts`, `packages/domain/src/expiry.ts`, `packages/domain/src/index.ts`
- Modify: `apps/server/package.json` (add dependency `"@buttery/domain": "*"`)
- Test: `packages/domain/test/quantity.test.ts`, `packages/domain/test/expiry.test.ts`

**Interfaces:**
- Produces (all exported from `@buttery/domain`):
  - `ConfidenceSchema`/`Confidence` (`'high'|'medium'|'low'`), `PerishabilitySchema`/`Perishability`, `LOT_STATES`/`LotState`, `IdempotencyKeySchema`, `IsoDateSchema`/`IsoDate`
  - `addDays(d, n)`, `daysBetween(from, to)`, `todayIn(tz, now?)`, `formatShortDate(d, today)`
  - `UNITS`, `UnitSchema`/`Unit`, `QuantitySchema`/`Quantity`, `PackageSchema`/`Package`, `PackageInputSchema`, `normalizeUnit(raw)`, `normalizePackage(input)`, `quantityFromReceiptLine(line, pkg)`, `describeQuantity(q, pkg)`
  - `ShelfLifeEntrySchema`/`ShelfLifeEntry`, `ShelfLifeMapSchema`/`ShelfLifeMap`, `ExpirySchema`/`Expiry`, `computeEffectiveExpiry(input)`, `Urgency`, `DEFAULT_WINDOWS`, `urgencyOf(expiry, today, windows?)`, `describeExpiry(expiry, today)`

- [ ] **Step 1: Create the package**

`packages/domain/package.json`:

```json
{
  "name": "@buttery/domain",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  }
}
```

`packages/domain/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test"]
}
```

Run: `npm i -w packages/domain zod && npm i -D -w packages/domain vitest typescript @types/node`
Add `"@buttery/domain": "*"` to `dependencies` in `apps/server/package.json`, then run `npm install`.

- [ ] **Step 2: Write the failing tests**

`packages/domain/test/quantity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { describeQuantity, normalizePackage, normalizeUnit, quantityFromReceiptLine } from '../src';

describe('normalizeUnit', () => {
  it('maps receipt and fixture spellings', () => {
    expect(normalizeUnit('US_gal')).toBe('gal');
    expect(normalizeUnit('oz_mass')).toBe('oz');
    expect(normalizeUnit('LBS')).toBe('lb');
    expect(normalizeUnit('ct')).toBe('count');
    expect(normalizeUnit('package')).toBeUndefined();
    expect(normalizeUnit(undefined)).toBeUndefined();
  });
});

describe('quantityFromReceiptLine', () => {
  const pkg = (p: { count?: number; size?: number; unit?: string }) => normalizePackage(p);

  it('treats a multipack as containers, not packs (GRK YOGURT 2X32 OZ)', () => {
    expect(quantityFromReceiptLine({ quantity: 1, unit: 'multipack' }, pkg({ count: 2, size: 32, unit: 'oz_mass' }))).toEqual({
      quantity: { kind: 'exact', amount: 2, unit: 'count' },
      package: { size: 32, unit: 'oz' },
    });
  });

  it('treats a 24-count carton as 24 eggs in one package (EGGS 24 CT)', () => {
    expect(quantityFromReceiptLine({ quantity: 1, unit: 'package' }, pkg({ size: 24, unit: 'count' }))).toEqual({
      quantity: { kind: 'exact', amount: 24, unit: 'count' },
      package: { count: 24 },
    });
  });

  it('keeps per-item package size for repeated items (4 × CHICKPEAS 15 OZ CAN)', () => {
    expect(quantityFromReceiptLine({ quantity: 4, unit: 'can' }, pkg({ size: 15, unit: 'oz_mass' }))).toEqual({
      quantity: { kind: 'exact', amount: 4, unit: 'count' },
      package: { size: 15, unit: 'oz' },
    });
  });

  it('uses weight for weighed produce (BANANAS 1.25 LB)', () => {
    expect(quantityFromReceiptLine({ quantity: 1.25, unit: 'lb' }, null)).toEqual({
      quantity: { kind: 'exact', amount: 1.25, unit: 'lb' },
      package: null,
    });
  });

  it('defaults to one item', () => {
    expect(quantityFromReceiptLine({}, null)).toEqual({ quantity: { kind: 'exact', amount: 1, unit: 'count' }, package: null });
  });
});

describe('describeQuantity', () => {
  it('renders packages, weights, approximations and unknowns', () => {
    expect(describeQuantity({ kind: 'exact', amount: 2, unit: 'count' }, { size: 32, unit: 'oz' })).toBe('2 × 32 oz');
    expect(describeQuantity({ kind: 'exact', amount: 24, unit: 'count' }, { count: 24 })).toBe('24 count');
    expect(describeQuantity({ kind: 'exact', amount: 1.25, unit: 'lb' }, null)).toBe('1.25 lb');
    expect(describeQuantity({ kind: 'approx', amount: 0.5, unit: 'gal' }, null)).toBe('~0.5 gal');
    expect(describeQuantity({ kind: 'unknown' }, null)).toBe('unknown amount');
  });
});
```

`packages/domain/test/expiry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addDays, computeEffectiveExpiry, daysBetween, describeExpiry, formatShortDate, todayIn, urgencyOf, type ShelfLifeMap } from '../src';

const perishable: ShelfLifeMap = {
  sealed: { days: 5, confidence: 'medium', source: 'model_estimate', model: 'crusoe:test' },
  opened: { days: 3, confidence: 'medium', source: 'default_rule' },
};

describe('dates', () => {
  it('does calendar math across month ends', () => {
    expect(addDays('2026-09-28', 5)).toBe('2026-10-03');
    expect(daysBetween('2026-09-28', '2026-10-03')).toBe(5);
  });
  it('computes today in a timezone', () => {
    expect(todayIn('America/New_York', new Date('2026-09-30T02:00:00Z'))).toBe('2026-09-29');
  });
  it('formats relative short dates', () => {
    expect(formatShortDate('2026-09-29', '2026-09-29')).toBe('today');
    expect(formatShortDate('2026-09-30', '2026-09-29')).toBe('tomorrow');
    expect(formatShortDate('2026-10-02', '2026-09-29')).toBe('Fri');
    expect(formatShortDate('2026-10-20', '2026-09-29')).toBe('Oct 20');
  });
});

describe('computeEffectiveExpiry', () => {
  it('estimates from the purchase date with a basis naming the source', () => {
    expect(
      computeEffectiveExpiry({ perishability: 'perishable', state: 'sealed', anchors: { sealed: '2026-09-28' }, shelfLife: perishable }),
    ).toEqual({
      on: '2026-10-03',
      kind: 'estimated',
      confidence: 'medium',
      basis: 'bought 2026-09-28 + 5d (model_estimate, crusoe:test, medium)',
    });
  });

  it('prefers a printed date while sealed', () => {
    expect(
      computeEffectiveExpiry({ perishability: 'perishable', state: 'sealed', anchors: { sealed: '2026-09-28' }, printedExpiryOn: '2026-10-10', shelfLife: perishable }),
    ).toEqual({ on: '2026-10-10', kind: 'printed', confidence: 'high', basis: 'printed on package' });
  });

  it('gives sealed shelf-stable food no expiry unless printed', () => {
    expect(
      computeEffectiveExpiry({ perishability: 'shelf_stable', state: 'sealed', anchors: { sealed: '2026-09-28' }, shelfLife: { sealed: { days: 730, confidence: 'medium', source: 'default_rule' } } }),
    ).toBeNull();
  });

  it('returns null when there is no estimate for the state', () => {
    expect(computeEffectiveExpiry({ perishability: 'perishable', state: 'sealed', anchors: { sealed: '2026-09-28' }, shelfLife: {} })).toBeNull();
  });
});

describe('urgency and description', () => {
  const exp = (on: string, kind: 'printed' | 'estimated' = 'estimated') => ({ on, kind, confidence: 'medium' as const, basis: 'x' });
  it('buckets by days remaining', () => {
    expect(urgencyOf(exp('2026-09-28'), '2026-09-29')).toBe('expired');
    expect(urgencyOf(exp('2026-10-01'), '2026-09-29')).toBe('urgent');
    expect(urgencyOf(exp('2026-10-06'), '2026-09-29')).toBe('soon');
    expect(urgencyOf(exp('2026-10-20'), '2026-09-29')).toBe('later');
    expect(urgencyOf(null, '2026-09-29')).toBeNull();
  });
  it('labels estimates and printed dates differently', () => {
    expect(describeExpiry(exp('2026-10-02'), '2026-09-29')).toBe('est. Fri · medium');
    expect(describeExpiry(exp('2026-10-02', 'printed'), '2026-09-29')).toBe('exp Fri');
    expect(describeExpiry(exp('2026-09-27'), '2026-09-29')).toBe('est. expired 2d ago · medium');
    expect(describeExpiry(null, '2026-09-29')).toBe('no expiry tracked');
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npm test -w packages/domain`
Expected: FAIL (cannot resolve `../src`).

- [ ] **Step 4: Implement**

`packages/domain/src/common.ts`:

```ts
import { z } from 'zod';

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const PerishabilitySchema = z.enum(['shelf_stable', 'perishable']);
export type Perishability = z.infer<typeof PerishabilitySchema>;

export const LOT_STATES = ['sealed', 'opened', 'frozen', 'thawed', 'prepared'] as const;
export const LotStateSchema = z.enum(LOT_STATES);
export type LotState = z.infer<typeof LotStateSchema>;

export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(200)
  .describe('Unique key for this user action. Generate a new one per action; reuse it only when retrying the same call.');

export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export type IsoDate = string;
```

`packages/domain/src/dates.ts`:

```ts
import type { IsoDate } from './common';

const DAY_MS = 86_400_000;
const toUtc = (d: IsoDate) => Date.parse(`${d}T00:00:00Z`);

export function addDays(d: IsoDate, n: number): IsoDate {
  return new Date(toUtc(d) + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

export function todayIn(timeZone: string, now: Date = new Date()): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function formatShortDate(d: IsoDate, today: IsoDate): string {
  const diff = daysBetween(today, d);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  const date = new Date(`${d}T00:00:00Z`);
  if (diff > 1 && diff < 7) return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(date);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
}
```

`packages/domain/src/quantity.ts`:

```ts
import { z } from 'zod';

export const UNITS = ['count', 'g', 'kg', 'oz', 'lb', 'ml', 'l', 'fl_oz', 'cup', 'qt', 'gal'] as const;
export const UnitSchema = z.enum(UNITS);
export type Unit = z.infer<typeof UnitSchema>;

export const QuantitySchema = z.object({
  kind: z.enum(['exact', 'approx', 'unknown']),
  amount: z.number().nonnegative().optional(),
  unit: UnitSchema.optional(),
});
export type Quantity = z.infer<typeof QuantitySchema>;

export const PackageSchema = z.object({
  count: z.number().positive().optional(),
  size: z.number().positive().optional(),
  unit: UnitSchema.optional(),
});
export type Package = z.infer<typeof PackageSchema>;

export const PackageInputSchema = z
  .object({
    count: z.number().positive().optional().describe('Items per pack, e.g. 2 for "2X32 OZ", 24 for "24 CT"'),
    size: z.number().positive().optional().describe('Size of each item, e.g. 32 for "2X32 OZ"'),
    unit: z.string().max(20).optional().describe('Unit of size, e.g. "oz", "lb", "gal", "count"'),
  })
  .describe('Package details printed on the line');

const UNIT_ALIASES: Record<string, Unit> = {
  count: 'count', ct: 'count', ea: 'count', each: 'count', pc: 'count', pcs: 'count',
  g: 'g', gram: 'g', grams: 'g', kg: 'kg',
  oz: 'oz', oz_mass: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  ml: 'ml', l: 'l', liter: 'l', litre: 'l',
  fl_oz: 'fl_oz', 'fl oz': 'fl_oz', floz: 'fl_oz',
  cup: 'cup', cups: 'cup', qt: 'qt', quart: 'qt',
  gal: 'gal', gallon: 'gal', us_gal: 'gal',
};

export function normalizeUnit(raw: string | undefined | null): Unit | undefined {
  if (!raw) return undefined;
  return UNIT_ALIASES[raw.trim().toLowerCase().replace(/\.$/, '')];
}

export function normalizePackage(input: { count?: number; size?: number; unit?: string } | undefined | null): Package | null {
  if (!input) return null;
  const unit = normalizeUnit(input.unit);
  const pkg: Package = {};
  if (input.count) pkg.count = input.count;
  if (input.size && unit) {
    pkg.size = input.size;
    pkg.unit = unit;
  }
  if (pkg.unit === 'count' && pkg.size && !pkg.count) return { count: pkg.size };
  return Object.keys(pkg).length ? pkg : null;
}

export function quantityFromReceiptLine(
  line: { quantity?: number; unit?: string },
  pkg: Package | null,
): { quantity: Quantity; package: Package | null } {
  const qty = line.quantity ?? 1;
  const lineUnit = normalizeUnit(line.unit);
  if (lineUnit && lineUnit !== 'count') return { quantity: { kind: 'exact', amount: qty, unit: lineUnit }, package: null };
  if (pkg?.count && pkg.size && pkg.unit) {
    return { quantity: { kind: 'exact', amount: qty * pkg.count, unit: 'count' }, package: { size: pkg.size, unit: pkg.unit } };
  }
  if (pkg?.count) return { quantity: { kind: 'exact', amount: qty * pkg.count, unit: 'count' }, package: { count: pkg.count } };
  if (pkg?.size && pkg.unit) {
    return { quantity: { kind: 'exact', amount: qty, unit: 'count' }, package: { size: pkg.size, unit: pkg.unit } };
  }
  return { quantity: { kind: 'exact', amount: qty, unit: 'count' }, package: null };
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

export function describeQuantity(q: Quantity, pkg: Package | null | undefined): string {
  if (q.kind === 'unknown' || q.amount === undefined) return 'unknown amount';
  const prefix = q.kind === 'approx' ? '~' : '';
  if (!q.unit || q.unit === 'count') {
    if (pkg?.size && pkg.unit) return `${prefix}${fmt(q.amount)} × ${fmt(pkg.size)} ${pkg.unit}`;
    return `${prefix}${fmt(q.amount)}${pkg?.count ? ' count' : ''}`;
  }
  return `${prefix}${fmt(q.amount)} ${q.unit}`;
}
```

`packages/domain/src/expiry.ts`:

```ts
import { z } from 'zod';
import { ConfidenceSchema, IsoDateSchema, LotStateSchema, type IsoDate, type LotState, type Perishability } from './common';
import { addDays, daysBetween, formatShortDate } from './dates';

export const ShelfLifeEntrySchema = z.object({
  days: z.number().int().nonnegative().nullable(),
  confidence: ConfidenceSchema,
  source: z.enum(['default_rule', 'model_estimate', 'agent_hint', 'user']),
  model: z.string().optional(),
  reasoning_call_id: z.string().optional(),
});
export type ShelfLifeEntry = z.infer<typeof ShelfLifeEntrySchema>;

export const ShelfLifeMapSchema = z.partialRecord(LotStateSchema, ShelfLifeEntrySchema);
export type ShelfLifeMap = Partial<Record<LotState, ShelfLifeEntry>>;

export const ExpirySchema = z.object({
  on: IsoDateSchema,
  kind: z.enum(['printed', 'estimated']),
  confidence: ConfidenceSchema,
  basis: z.string(),
});
export type Expiry = z.infer<typeof ExpirySchema>;

const VERB: Record<LotState, string> = { sealed: 'bought', opened: 'opened', frozen: 'frozen', thawed: 'thawed', prepared: 'cooked' };

export type ExpiryInput = {
  perishability: Perishability;
  state: LotState;
  anchors: Partial<Record<LotState, IsoDate>>;
  printedExpiryOn?: IsoDate | null;
  shelfLife: ShelfLifeMap;
};

export function computeEffectiveExpiry(i: ExpiryInput): Expiry | null {
  if (i.state === 'sealed' && i.printedExpiryOn) {
    return { on: i.printedExpiryOn, kind: 'printed', confidence: 'high', basis: 'printed on package' };
  }
  if (i.perishability === 'shelf_stable' && i.state === 'sealed') return null;
  const entry = i.shelfLife[i.state];
  const anchor = i.anchors[i.state];
  if (!entry || entry.days === null || !anchor) return null;
  const source = entry.model ? `${entry.source}, ${entry.model}` : entry.source;
  return {
    on: addDays(anchor, entry.days),
    kind: 'estimated',
    confidence: entry.confidence,
    basis: `${VERB[i.state]} ${anchor} + ${entry.days}d (${source}, ${entry.confidence})`,
  };
}

export type Urgency = 'expired' | 'urgent' | 'soon' | 'later';
export const DEFAULT_WINDOWS = { urgentDays: 2, soonDays: 7 };

export function urgencyOf(expiry: Expiry | null | undefined, today: IsoDate, w = DEFAULT_WINDOWS): Urgency | null {
  if (!expiry) return null;
  const d = daysBetween(today, expiry.on);
  if (d < 0) return 'expired';
  if (d <= w.urgentDays) return 'urgent';
  if (d <= w.soonDays) return 'soon';
  return 'later';
}

export function describeExpiry(expiry: Expiry | null | undefined, today: IsoDate): string {
  if (!expiry) return 'no expiry tracked';
  const d = daysBetween(today, expiry.on);
  const when = d < 0 ? `${-d}d ago` : formatShortDate(expiry.on, today);
  if (expiry.kind === 'printed') return `${d < 0 ? 'expired' : 'exp'} ${when}`;
  return `${d < 0 ? 'est. expired' : 'est.'} ${when} · ${expiry.confidence}`;
}
```

`packages/domain/src/index.ts`:

```ts
export * from './common';
export * from './dates';
export * from './quantity';
export * from './expiry';
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -w packages/domain && npm run typecheck`
Expected: all pass. (If `z.partialRecord` is missing in the installed Zod 4 minor, use `z.record(LotStateSchema, ShelfLifeEntrySchema).partial()` instead.)

- [ ] **Step 6: Commit**

```bash
git add packages/domain apps/server/package.json package-lock.json
git commit -m "feat(domain): dates, quantities, expiry and urgency rules"
```

---

### Task 6: Domain: name matching, hashing, receipt schema and fingerprints

**Files:**
- Create: `packages/domain/src/normalize.ts`, `packages/domain/src/catalog.ts`, `packages/domain/src/hash.ts`, `packages/domain/src/receipt.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/matching.test.ts`, `packages/domain/test/receipt.test.ts`

**Interfaces:**
- Produces:
  - `normalizeName(s)`, `similarity(a, b)` (trigram Jaccard, 0–1)
  - `type CatalogFood = { id; name; normalizedName; aliases: string[]; category: string | null; perishability }`, `exactAliasMatch(text, foods)`, `shortlist(text, foods, limit = 5, min = 0.2): Array<CatalogFood & { score }>`
  - `canonicalJson(v)`, `sha256Hex(s)`, `hashJson(v)`
  - `LineKindSchema`/`LineKind` (`'item'|'coupon'|'return'|'non_food'`), `ReceiptLineSchema`/`ReceiptLine`, `ReceiptPayloadSchema`/`ReceiptPayload`, `withLineIds(payload)`, `receiptFingerprint(payload)`, `receiptNearKey(payload)`

- [ ] **Step 1: Write the failing tests**

`packages/domain/test/matching.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { exactAliasMatch, normalizeName, shortlist, similarity, type CatalogFood } from '../src';

const food = (id: string, name: string, aliases: string[] = []): CatalogFood => ({
  id, name, normalizedName: normalizeName(name), aliases, category: null, perishability: 'perishable',
});

describe('matching', () => {
  it('normalizes case, punctuation and accents', () => {
    expect(normalizeName('  Jalapeño  PEPPERS, 2-LB ')).toBe('jalapeno peppers 2 lb');
  });

  it('scores similar names higher', () => {
    expect(similarity('BABY SPINACH 5 OZ', 'Baby spinach')).toBeGreaterThan(similarity('BABY SPINACH 5 OZ', 'Whole milk'));
  });

  it('matches exact names and learned aliases', () => {
    const foods = [food('1', 'Whole milk', ['whole milk 1 gal']), food('2', 'Eggs')];
    expect(exactAliasMatch('WHOLE MILK 1 GAL', foods)?.id).toBe('1');
    expect(exactAliasMatch('eggs', foods)?.id).toBe('2');
    expect(exactAliasMatch('EGGS 24 CT', foods)).toBeUndefined();
  });

  it('shortlists plausible candidates, best first', () => {
    const foods = [food('1', 'Whole milk'), food('2', 'Baby spinach'), food('3', 'Strawberries')];
    const list = shortlist('BABY SPINACH 5 OZ', foods);
    expect(list[0]?.id).toBe('2');
    expect(list.every((c) => c.score >= 0.2)).toBe(true);
  });
});
```

`packages/domain/test/receipt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hashJson, receiptFingerprint, receiptNearKey, ReceiptPayloadSchema, withLineIds } from '../src';

const base = {
  store: 'PANTRY CLUB',
  purchased_at: '2026-09-28T18:42',
  receipt_number: 'PC-004218',
  total_cents: 4694,
  lines: [{ raw_text: 'WHOLE MILK 1 GAL' }],
};

describe('receipt identity', () => {
  it('hashes JSON independent of key order', () => {
    expect(hashJson({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(hashJson({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });

  it('fingerprints by store + receipt number + date when a number is present', () => {
    const recapture = { ...base, store: 'Pantry Club', purchased_at: '2026-09-28T18:43', total_cents: 4649 };
    expect(receiptFingerprint(recapture)).toBe(receiptFingerprint(base));
  });

  it('falls back to store + minute + total without a number', () => {
    const a = { ...base, receipt_number: undefined };
    expect(receiptFingerprint(a)).toBe(receiptFingerprint({ ...a, lines: [{ raw_text: 'different' }] }));
    expect(receiptFingerprint(a)).not.toBe(receiptFingerprint({ ...a, total_cents: 100 }));
  });

  it('near key ignores the receipt number so a mixed pair is still flagged', () => {
    expect(receiptNearKey({ ...base, receipt_number: undefined })).toBe(receiptNearKey(base));
    expect(receiptNearKey({ ...base, total_cents: undefined })).toBeNull();
  });

  it('assigns stable line ids', () => {
    const p = withLineIds(ReceiptPayloadSchema.parse({ ...base, lines: [{ raw_text: 'A' }, { raw_text: 'B', line_id: 'x' }, { raw_text: 'C' }] }));
    expect(p.lines.map((l) => l.line_id)).toEqual(['L1', 'x', 'L3']);
  });

  it('validates the purchase timestamp format', () => {
    expect(() => ReceiptPayloadSchema.parse({ ...base, purchased_at: 'yesterday' })).toThrow();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w packages/domain`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/domain/src/normalize.ts`:

```ts
export function normalizeName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function trigrams(s: string): Set<string> {
  const t = `  ${normalizeName(s)} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

export function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const g of ta) if (tb.has(g)) shared++;
  return shared / (ta.size + tb.size - shared);
}
```

`packages/domain/src/catalog.ts`:

```ts
import type { Perishability } from './common';
import { normalizeName, similarity } from './normalize';

export type CatalogFood = {
  id: string;
  name: string;
  normalizedName: string;
  aliases: string[];
  category: string | null;
  perishability: Perishability;
};

export function exactAliasMatch<F extends CatalogFood>(text: string, foods: F[]): F | undefined {
  const n = normalizeName(text);
  return foods.find((f) => f.normalizedName === n || f.aliases.includes(n));
}

export function shortlist<F extends CatalogFood>(text: string, foods: F[], limit = 5, min = 0.2): Array<F & { score: number }> {
  return foods
    .map((f) => ({ ...f, score: Math.max(similarity(text, f.name), ...f.aliases.map((a) => similarity(text, a))) }))
    .filter((f) => f.score >= min)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
```

`packages/domain/src/hash.ts`:

```ts
import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
export const hashJson = (v: unknown) => sha256Hex(canonicalJson(v));
```

`packages/domain/src/receipt.ts`:

```ts
import { z } from 'zod';
import { PackageInputSchema } from './quantity';
import { normalizeName } from './normalize';
import { sha256Hex } from './hash';

export const LineKindSchema = z.enum(['item', 'coupon', 'return', 'non_food']);
export type LineKind = z.infer<typeof LineKindSchema>;

export const ReceiptLineSchema = z.object({
  line_id: z.string().min(1).max(40).optional().describe('Optional; the server assigns L1, L2… if omitted'),
  raw_text: z.string().min(1).max(200).describe('The line exactly as printed, e.g. "GRK YOGURT 2X32 OZ"'),
  detail: z.string().max(200).optional().describe('Secondary printed text, e.g. "1.25 LB @ 0.64/LB"'),
  quantity: z.number().positive().optional().describe('Count or weight bought on this line (default 1)'),
  unit: z.string().max(20).optional().describe('Unit of quantity when weighed, e.g. "lb"'),
  unit_price_cents: z.number().int().optional(),
  price_cents: z.number().int().optional().describe('Line total in cents; negative for coupons and returns'),
  line_kind: LineKindSchema.optional().describe('item | coupon | return | non_food'),
  hint: z
    .object({
      food_name: z.string().max(100).optional(),
      package: PackageInputSchema.optional(),
      location_guess: z.string().max(40).optional(),
    })
    .optional()
    .describe('Optional hints; the server decides the canonical item'),
});
export type ReceiptLine = z.infer<typeof ReceiptLineSchema>;

export const ReceiptPayloadSchema = z.object({
  store: z.string().min(1).max(100),
  purchased_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/, 'local date/time like 2026-09-28T18:42')
    .describe('Local purchase date/time as printed'),
  receipt_number: z.string().max(60).optional().describe('Transaction/receipt number if printed'),
  total_cents: z.number().int().optional(),
  lines: z.array(ReceiptLineSchema).min(1).max(200).describe('Every printed line, in order'),
});
export type ReceiptPayload = z.infer<typeof ReceiptPayloadSchema>;
export type ReceiptPayloadWithIds = ReceiptPayload & { lines: Array<ReceiptLine & { line_id: string }> };

export function withLineIds(p: ReceiptPayload): ReceiptPayloadWithIds {
  const used = new Set(p.lines.map((l) => l.line_id).filter(Boolean));
  return {
    ...p,
    lines: p.lines.map((l, i) => {
      if (l.line_id) return l as ReceiptLine & { line_id: string };
      let id = `L${i + 1}`;
      while (used.has(id)) id = `${id}_`;
      used.add(id);
      return { ...l, line_id: id };
    }),
  };
}

type Identity = Pick<ReceiptPayload, 'store' | 'purchased_at' | 'receipt_number' | 'total_cents'>;

export function receiptFingerprint(r: Identity): string {
  const store = normalizeName(r.store);
  if (r.receipt_number) return sha256Hex(['rn', store, normalizeName(r.receipt_number), r.purchased_at.slice(0, 10)].join('|'));
  return sha256Hex(['ts', store, r.purchased_at.slice(0, 16), String(r.total_cents ?? '')].join('|'));
}

export function receiptNearKey(r: Identity): string | null {
  if (r.total_cents === undefined) return null;
  return sha256Hex(['near', normalizeName(r.store), r.purchased_at.slice(0, 10), String(r.total_cents)].join('|'));
}
```

Append to `packages/domain/src/index.ts`:

```ts
export * from './normalize';
export * from './catalog';
export * from './hash';
export * from './receipt';
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -w packages/domain && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): name matching, canonical hashing, receipt schema and fingerprints"
```

---

### Task 7: Ledger schema

**Files:**
- Create: `apps/server/src/db/schema/ledger.ts`
- Modify: `apps/server/src/db/schema/index.ts`
- Generate: `apps/server/drizzle/0001_*.sql`
- Test: `apps/server/test/ledger-schema.test.ts`

**Interfaces:**
- Produces tables and row types:
  - `foods` / `FoodRow`
  - `lots` / `LotRow`
  - `observations` / `ObservationRow`
  - `proposals` / `ProposalRow`
  - `proposalOps` / `ProposalOpRow`
  - `changeSets` / `ChangeSetRow`
  - `changes` / `ChangeRow`
  - `idempotencyRecords`
  - `reasoningCalls`
  - Constants: `OBSERVATION_KINDS`, `PROPOSAL_STATUSES`, `OP_TYPES`, `DECISIONS`, `LOT_STATUSES`

- [ ] **Step 1: Write the failing test** `apps/server/test/ledger-schema.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { foods, lots, observations } from '../src/db/schema';
import { resetDb, testDb } from './helpers/db';
import { seedUser } from './helpers/app';

describe('ledger schema', () => {
  beforeEach(() => resetDb());
  const db = testDb();

  it('stores a food and a lot with JSON quantity and expiry', async () => {
    const { principal } = await seedUser(db);
    const [food] = await db
      .insert(foods)
      .values({ householdId: principal.householdId, name: 'Whole milk', normalizedName: 'whole milk', perishability: 'perishable' })
      .returning();
    expect(food?.aliases).toEqual([]);
    const [lot] = await db
      .insert(lots)
      .values({
        householdId: principal.householdId,
        foodId: food!.id,
        location: 'fridge',
        quantity: { kind: 'exact', amount: 1, unit: 'count' },
        expires: { on: '2026-10-03', kind: 'estimated', confidence: 'medium', basis: 'x' },
        acquiredOn: '2026-09-28',
      })
      .returning();
    expect(lot).toMatchObject({ state: 'sealed', status: 'active', version: 1, acquiredOn: '2026-09-28' });
  });

  it('enforces one observation per receipt fingerprint per household', async () => {
    const { principal } = await seedUser(db);
    const row = { householdId: principal.householdId, kind: 'receipt' as const, observedAt: new Date(), actorUserId: principal.userId, payload: {}, fingerprint: 'fp1' };
    await db.insert(observations).values(row);
    await expect(db.insert(observations).values(row)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w apps/server -- ledger-schema`
Expected: FAIL (`foods` is not exported).

- [ ] **Step 3: Implement** `apps/server/src/db/schema/ledger.ts`

```ts
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
```

Append to `apps/server/src/db/schema/index.ts`:

```ts
export * from './ledger';
```

- [ ] **Step 4: Generate the migration and run the tests**

Run: `npm run db:generate -w apps/server && npm test -w apps/server`
Expected: `drizzle/0001_*.sql` is created and all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: ledger schema (foods, lots, observations, proposals, changes, idempotency, reasoning calls)"
```

---

### Task 8: Idempotency service

**Files:**
- Create: `apps/server/src/services/idempotency.ts`
- Test: `apps/server/test/idempotency.test.ts`

**Interfaces:**
- Consumes: `idempotencyRecords`, `hashJson`, `AppError`.
- Produces:
  - `type IdempotencyScope = { householdId: string; tool: string; key: string; request: unknown }`
  - `findIdempotent<R>(db, scope): Promise<R | undefined>`: cheap lookup before expensive work (e.g. model calls). Throws `idempotency_key_reused` on a request mismatch.
  - `runIdempotent<R>(db, scope, work: (tx) => Promise<R>): Promise<R>`: runs `work` once per key inside one transaction, stores a JSON-normalized result, and replays it on repeat calls.

- [ ] **Step 1: Write the failing test** `apps/server/test/idempotency.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { findIdempotent, runIdempotent } from '../src/services/idempotency';
import { resetDb, testDb } from './helpers/db';
import { seedUser } from './helpers/app';

describe('idempotency', () => {
  beforeEach(() => resetDb());
  const db = testDb();

  it('runs work once and replays the stored response', async () => {
    const { principal } = await seedUser(db);
    let runs = 0;
    const scope = { householdId: principal.householdId, tool: 't', key: 'key-00001', request: { a: 1 } };
    const work = async () => ({ n: ++runs, at: new Date('2026-09-29T00:00:00Z') });
    const first = await runIdempotent(db, scope, work);
    const second = await runIdempotent(db, scope, work);
    expect(runs).toBe(1);
    expect(second).toEqual(first);
    expect(first.at).toBe('2026-09-29T00:00:00.000Z'); // normalized to JSON on first return too
    expect(await findIdempotent(db, scope)).toEqual(first);
  });

  it('rejects reuse of a key for a different request', async () => {
    const { principal } = await seedUser(db);
    const scope = { householdId: principal.householdId, tool: 't', key: 'key-00002', request: { a: 1 } };
    await runIdempotent(db, scope, async () => ({ ok: true }));
    await expect(runIdempotent(db, { ...scope, request: { a: 2 } }, async () => ({ ok: true }))).rejects.toMatchObject({ code: 'idempotency_key_reused' });
  });

  it('executes once under concurrent retries with the same key', async () => {
    const { principal } = await seedUser(db);
    let runs = 0;
    const scope = { householdId: principal.householdId, tool: 't', key: 'key-00003', request: {} };
    const work = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 150));
      return { runs };
    };
    const [a, b] = await Promise.all([runIdempotent(db, scope, work), runIdempotent(db, scope, work)]);
    expect(runs).toBe(1);
    expect(a).toEqual(b);
  });

  it('does not store a response when work throws', async () => {
    const { principal } = await seedUser(db);
    const scope = { householdId: principal.householdId, tool: 't', key: 'key-00004', request: {} };
    await expect(runIdempotent(db, scope, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await runIdempotent(db, scope, async () => ({ ok: true }))).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w apps/server -- idempotency`
Expected: FAIL.

- [ ] **Step 3: Implement** `apps/server/src/services/idempotency.ts`

```ts
import { and, eq } from 'drizzle-orm';
import { hashJson } from '@buttery/domain';
import type { Db, Executor, Tx } from '../db/client';
import { idempotencyRecords } from '../db/schema';
import { AppError } from '../errors';

export type IdempotencyScope = { householdId: string; tool: string; key: string; request: unknown };

function where(s: IdempotencyScope) {
  return and(
    eq(idempotencyRecords.householdId, s.householdId),
    eq(idempotencyRecords.tool, s.tool),
    eq(idempotencyRecords.key, s.key),
  );
}

async function findRecord(db: Executor, s: IdempotencyScope) {
  const [row] = await db.select().from(idempotencyRecords).where(where(s)).limit(1);
  return row;
}

function replay<R>(row: { requestHash: string; response: unknown }, requestHash: string): R {
  if (row.requestHash !== requestHash) {
    throw new AppError('idempotency_key_reused', 'This idempotency_key was already used for a different request. Use a new key for a new action.', 409);
  }
  if (row.response === null || row.response === undefined) {
    throw new AppError('idempotency_in_flight', 'A request with this idempotency_key is still in progress. Retry shortly.', 409);
  }
  return row.response as R;
}

export async function findIdempotent<R>(db: Executor, s: IdempotencyScope): Promise<R | undefined> {
  const row = await findRecord(db, s);
  return row ? replay<R>(row, hashJson(s.request)) : undefined;
}

export async function runIdempotent<R>(db: Db, s: IdempotencyScope, work: (tx: Tx) => Promise<R>): Promise<R> {
  const requestHash = hashJson(s.request);
  const prior = await findRecord(db, s);
  if (prior) return replay<R>(prior, requestHash);

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(idempotencyRecords)
      .values({ householdId: s.householdId, tool: s.tool, key: s.key, requestHash, response: null })
      .onConflictDoNothing()
      .returning({ key: idempotencyRecords.key });
    if (inserted.length === 0) {
      // A concurrent request with the same key committed first (we waited on its row lock).
      const row = await findRecord(tx, s);
      if (!row) throw new AppError('idempotency_in_flight', 'A request with this idempotency_key is still in progress. Retry shortly.', 409);
      return replay<R>(row, requestHash);
    }
    const result = JSON.parse(JSON.stringify(await work(tx))) as R;
    await tx.update(idempotencyRecords).set({ response: result as object }).where(where(s));
    return result;
  });
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -w apps/server -- idempotency`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: idempotent execution with replay and key-reuse detection"
```

---

### Task 9: Change engine and undo

**Files:**
- Create: `apps/server/src/services/changes.ts`, `apps/server/src/services/proposalStatus.ts`
- Test: `apps/server/test/changes.test.ts`

**Interfaces:**
- Consumes: `Tx`, `Db`, `Principal`, ledger tables, `computeEffectiveExpiry`, `normalizeName`, `runIdempotent`.
- Produces:
  - `type ChangeSetHandle = { id: string; householdId: string; nextSeq: number }`
  - `openChangeSet(tx, p, { label, causeObservationId?, causeProposalId?, idempotencyKey?, revertsChangeSetId? }): Promise<ChangeSetHandle>`
  - `recordChange(tx, cs, { op, lotId?, foodId?, before, after, causeObservationId?, causeProposalOpId? })`
  - `type NewFoodInput = { name; category?: string | null; perishability; shelfLife?: ShelfLifeMap; defaultLocation?: string | null; defaultPackage?: Package | null; aliases?: string[] }`
  - `createOrReuseFood(tx, cs, input): Promise<{ food: FoodRow; created: boolean }>`
  - `addAlias(tx, cs, food, alias): Promise<FoodRow>`
  - `type NewLotInput = { food: FoodRow; location; state?: LotState; quantity: Quantity; package?: Package | null; acquiredOn?: IsoDate | null; printedExpiryOn?: IsoDate | null; evidenceObservationId?: string | null; causeProposalOpId?: string | null; notes?: string | null }`
  - `addLot(tx, cs, input): Promise<LotRow>`
  - `undoChangeSet(db, p, { change_set_id, idempotency_key }): Promise<UndoResult>`
  - `type UndoResult = { reverted_change_set_id; undo_change_set_id; label; lots_voided; foods_archived; aliases_removed; proposal_reopened: string | null }`
  - `deriveProposalStatus(ops)`, `refreshProposalStatus(tx, proposalId): Promise<ProposalStatus>`

- [ ] **Step 1: Write the failing test** `apps/server/test/changes.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { changeSets, changes, foods, lots } from '../src/db/schema';
import { addAlias, addLot, createOrReuseFood, openChangeSet, undoChangeSet } from '../src/services/changes';
import { deriveProposalStatus } from '../src/services/proposalStatus';
import { resetDb, testDb } from './helpers/db';
import { seedUser } from './helpers/app';

const shelfLife = { sealed: { days: 5, confidence: 'medium' as const, source: 'model_estimate' as const } };

async function seedFoodAndLot(db: ReturnType<typeof testDb>, p: Awaited<ReturnType<typeof seedUser>>['principal']) {
  return db.transaction(async (tx) => {
    const cs = await openChangeSet(tx, p, { label: 'Receipt: test' });
    const { food } = await createOrReuseFood(tx, cs, { name: 'Whole milk', perishability: 'perishable', shelfLife });
    const aliased = await addAlias(tx, cs, food, 'WHOLE MILK 1 GAL');
    const lot = await addLot(tx, cs, { food: aliased, location: 'fridge', quantity: { kind: 'exact', amount: 1, unit: 'count' }, acquiredOn: '2026-09-28' });
    return { cs, food: aliased, lot };
  });
}

describe('change engine', () => {
  beforeEach(() => resetDb());
  const db = testDb();

  it('records every change in a change set with before/after snapshots', async () => {
    const { principal } = await seedUser(db);
    const { cs, food, lot } = await seedFoodAndLot(db, principal);
    expect(food.aliases).toEqual(['whole milk 1 gal']);
    expect(lot.expires).toMatchObject({ on: '2026-10-03', kind: 'estimated' });
    const rows = await db.select().from(changes).where(eq(changes.changeSetId, cs.id)).orderBy(changes.seq);
    expect(rows.map((r) => r.op)).toEqual(['create_food', 'add_alias', 'add_lot']);
    expect(rows[2]?.before).toBeNull();
    expect(rows[2]?.after).toMatchObject({ id: lot.id, version: 1 });
  });

  it('reuses an existing food by normalized name', async () => {
    const { principal } = await seedUser(db);
    await seedFoodAndLot(db, principal);
    const again = await db.transaction(async (tx) => {
      const cs = await openChangeSet(tx, principal, { label: 'x' });
      return createOrReuseFood(tx, cs, { name: 'WHOLE  milk', perishability: 'perishable' });
    });
    expect(again.created).toBe(false);
  });

  it('undoes a change set with compensating changes and keeps history', async () => {
    const { principal } = await seedUser(db);
    const { cs, food, lot } = await seedFoodAndLot(db, principal);
    const r = await undoChangeSet(db, principal, { change_set_id: cs.id, idempotency_key: 'undo-00001' });
    expect(r).toMatchObject({ reverted_change_set_id: cs.id, lots_voided: 1, foods_archived: 1, aliases_removed: 1 });
    const [l] = await db.select().from(lots).where(eq(lots.id, lot.id));
    expect(l).toMatchObject({ status: 'voided', version: 2 });
    const [f] = await db.select().from(foods).where(eq(foods.id, food.id));
    expect(f?.archivedAt).not.toBeNull();
    expect(f?.aliases).toEqual([]);
    const sets = await db.select().from(changeSets).where(eq(changeSets.householdId, principal.householdId));
    expect(sets).toHaveLength(2);
  });

  it('refuses to undo twice', async () => {
    const { principal } = await seedUser(db);
    const { cs } = await seedFoodAndLot(db, principal);
    await undoChangeSet(db, principal, { change_set_id: cs.id, idempotency_key: 'undo-00002' });
    await expect(undoChangeSet(db, principal, { change_set_id: cs.id, idempotency_key: 'undo-00003' })).rejects.toMatchObject({ code: 'already_reverted' });
  });

  it('refuses to undo when a lot changed afterwards', async () => {
    const { principal } = await seedUser(db);
    const { cs, lot } = await seedFoodAndLot(db, principal);
    await db.update(lots).set({ version: 2 }).where(eq(lots.id, lot.id));
    await expect(undoChangeSet(db, principal, { change_set_id: cs.id, idempotency_key: 'undo-00004' })).rejects.toMatchObject({ code: 'undo_conflict', details: { lot_ids: [lot.id] } });
  });

  it('revives an archived food instead of duplicating it', async () => {
    const { principal } = await seedUser(db);
    const { cs, food } = await seedFoodAndLot(db, principal);
    await undoChangeSet(db, principal, { change_set_id: cs.id, idempotency_key: 'undo-00005' });
    const revived = await db.transaction(async (tx) => {
      const cs2 = await openChangeSet(tx, principal, { label: 'again' });
      return createOrReuseFood(tx, cs2, { name: 'Whole milk', perishability: 'perishable' });
    });
    expect(revived).toMatchObject({ created: false, food: { id: food.id, archivedAt: null } });
  });

  it('cannot undo another household\'s change set', async () => {
    const a = await seedUser(db, 'a@example.com');
    const b = await seedUser(db, 'b@example.com');
    const { cs } = await seedFoodAndLot(db, a.principal);
    await expect(undoChangeSet(db, b.principal, { change_set_id: cs.id, idempotency_key: 'undo-00006' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('deriveProposalStatus', () => {
  const op = (decision: string, applied = false) => ({ decision, appliedAt: applied ? new Date() : null });
  it('derives pending, partial, applied and rejected', () => {
    expect(deriveProposalStatus([op('pending'), op('accepted')])).toBe('pending');
    expect(deriveProposalStatus([op('accepted', true), op('pending')])).toBe('partial');
    expect(deriveProposalStatus([op('accepted', true), op('rejected')])).toBe('applied');
    expect(deriveProposalStatus([op('rejected'), op('rejected')])).toBe('rejected');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w apps/server -- changes`
Expected: FAIL.

- [ ] **Step 3: Implement** `apps/server/src/services/proposalStatus.ts`

```ts
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { observations, proposalOps, proposals, PROPOSAL_STATUSES } from '../db/schema';

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export function deriveProposalStatus(ops: Array<{ decision: string; appliedAt: Date | null }>): ProposalStatus {
  const open = ops.filter((o) => o.decision === 'pending' || ((o.decision === 'accepted' || o.decision === 'edited') && !o.appliedAt));
  const anyApplied = ops.some((o) => o.appliedAt);
  if (open.length === 0) return anyApplied ? 'applied' : 'rejected';
  return anyApplied ? 'partial' : 'pending';
}

export async function refreshProposalStatus(tx: Tx, proposalId: string): Promise<ProposalStatus> {
  const ops = await tx
    .select({ decision: proposalOps.decision, appliedAt: proposalOps.appliedAt })
    .from(proposalOps)
    .where(eq(proposalOps.proposalId, proposalId));
  const status = deriveProposalStatus(ops);
  const [p] = await tx.update(proposals).set({ status, updatedAt: new Date() }).where(eq(proposals.id, proposalId)).returning();
  await tx
    .update(observations)
    .set({ status: status === 'applied' || status === 'rejected' ? 'resolved' : 'open' })
    .where(eq(observations.id, p!.observationId));
  return status;
}
```

- [ ] **Step 4: Implement** `apps/server/src/services/changes.ts`

```ts
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { computeEffectiveExpiry, normalizeName, type IsoDate, type LotState, type Package, type Perishability, type Quantity, type ShelfLifeMap } from '@buttery/domain';
import type { Db, Tx } from '../db/client';
import { changeSets, changes, foods, lots, proposalOps, type ChangeRow, type FoodRow, type LotRow } from '../db/schema';
import { AppError, notFound } from '../errors';
import type { Principal } from '../identity/principal';
import { runIdempotent } from './idempotency';
import { refreshProposalStatus } from './proposalStatus';

export type ChangeSetHandle = { id: string; householdId: string; nextSeq: number };

const snapshot = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)));

export async function openChangeSet(
  tx: Tx,
  p: Principal,
  input: { label: string; causeObservationId?: string | null; causeProposalId?: string | null; idempotencyKey?: string | null; revertsChangeSetId?: string | null },
): Promise<ChangeSetHandle> {
  const [row] = await tx
    .insert(changeSets)
    .values({
      householdId: p.householdId,
      label: input.label,
      actorUserId: p.userId,
      connectionId: p.connectionId,
      causeObservationId: input.causeObservationId ?? null,
      causeProposalId: input.causeProposalId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      revertsChangeSetId: input.revertsChangeSetId ?? null,
    })
    .returning({ id: changeSets.id });
  return { id: row!.id, householdId: p.householdId, nextSeq: 1 };
}

export async function recordChange(
  tx: Tx,
  cs: ChangeSetHandle,
  c: { op: string; lotId?: string | null; foodId?: string | null; before: unknown; after: unknown; causeObservationId?: string | null; causeProposalOpId?: string | null },
): Promise<void> {
  await tx.insert(changes).values({
    householdId: cs.householdId,
    changeSetId: cs.id,
    seq: cs.nextSeq++,
    op: c.op,
    lotId: c.lotId ?? null,
    foodId: c.foodId ?? null,
    before: snapshot(c.before),
    after: snapshot(c.after),
    causeObservationId: c.causeObservationId ?? null,
    causeProposalOpId: c.causeProposalOpId ?? null,
  });
}

export type NewFoodInput = {
  name: string;
  category?: string | null;
  perishability: Perishability;
  shelfLife?: ShelfLifeMap;
  defaultLocation?: string | null;
  defaultPackage?: Package | null;
  aliases?: string[];
};

export async function createOrReuseFood(tx: Tx, cs: ChangeSetHandle, input: NewFoodInput): Promise<{ food: FoodRow; created: boolean }> {
  const normalizedName = normalizeName(input.name);
  const [existing] = await tx
    .select()
    .from(foods)
    .where(and(eq(foods.householdId, cs.householdId), eq(foods.normalizedName, normalizedName)))
    .limit(1);
  if (existing) {
    if (!existing.archivedAt) return { food: existing, created: false };
    const [revived] = await tx.update(foods).set({ archivedAt: null, updatedAt: new Date() }).where(eq(foods.id, existing.id)).returning();
    await recordChange(tx, cs, { op: 'unarchive_food', foodId: existing.id, before: existing, after: revived });
    return { food: revived!, created: false };
  }
  const aliases = [...new Set((input.aliases ?? []).map(normalizeName).filter((a) => a && a !== normalizedName))];
  const [food] = await tx
    .insert(foods)
    .values({
      householdId: cs.householdId,
      name: input.name.trim(),
      normalizedName,
      aliases,
      category: input.category ?? null,
      perishability: input.perishability,
      shelfLife: input.shelfLife ?? {},
      defaultLocation: input.defaultLocation ?? null,
      defaultPackage: input.defaultPackage ?? null,
    })
    .returning();
  await recordChange(tx, cs, { op: 'create_food', foodId: food!.id, before: null, after: food });
  return { food: food!, created: true };
}

export async function addAlias(tx: Tx, cs: ChangeSetHandle, food: FoodRow, alias: string): Promise<FoodRow> {
  const a = normalizeName(alias);
  if (!a || a === food.normalizedName || food.aliases.includes(a)) return food;
  const [updated] = await tx.update(foods).set({ aliases: [...food.aliases, a], updatedAt: new Date() }).where(eq(foods.id, food.id)).returning();
  await recordChange(tx, cs, { op: 'add_alias', foodId: food.id, before: { alias: a }, after: { alias: a } });
  return updated!;
}

export type NewLotInput = {
  food: FoodRow;
  location: string;
  state?: LotState;
  quantity: Quantity;
  package?: Package | null;
  acquiredOn?: IsoDate | null;
  printedExpiryOn?: IsoDate | null;
  evidenceObservationId?: string | null;
  causeProposalOpId?: string | null;
  notes?: string | null;
};

export async function addLot(tx: Tx, cs: ChangeSetHandle, input: NewLotInput): Promise<LotRow> {
  const state = input.state ?? 'sealed';
  const expires = computeEffectiveExpiry({
    perishability: input.food.perishability,
    state,
    anchors: { sealed: input.acquiredOn ?? undefined },
    printedExpiryOn: input.printedExpiryOn ?? null,
    shelfLife: input.food.shelfLife,
  });
  const [lot] = await tx
    .insert(lots)
    .values({
      householdId: cs.householdId,
      foodId: input.food.id,
      location: input.location,
      state,
      quantity: input.quantity,
      package: input.package ?? null,
      expires,
      printedExpiryOn: input.printedExpiryOn ?? null,
      acquiredOn: input.acquiredOn ?? null,
      lastEvidenceAt: new Date(),
      lastEvidenceObservationId: input.evidenceObservationId ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  await recordChange(tx, cs, {
    op: 'add_lot',
    lotId: lot!.id,
    foodId: input.food.id,
    before: null,
    after: lot,
    causeObservationId: input.evidenceObservationId,
    causeProposalOpId: input.causeProposalOpId,
  });
  return lot!;
}

export type UndoResult = {
  reverted_change_set_id: string;
  undo_change_set_id: string;
  label: string;
  lots_voided: number;
  foods_archived: number;
  aliases_removed: number;
  proposal_reopened: string | null;
};

type Counts = { lots_voided: number; foods_archived: number; aliases_removed: number };

async function revertChange(tx: Tx, cs: ChangeSetHandle, r: ChangeRow, counts: Counts): Promise<void> {
  switch (r.op) {
    case 'add_lot': {
      const [before] = await tx.select().from(lots).where(eq(lots.id, r.lotId!));
      const [after] = await tx
        .update(lots)
        .set({ status: 'voided', version: sql`${lots.version} + 1`, updatedAt: new Date() })
        .where(eq(lots.id, r.lotId!))
        .returning();
      await recordChange(tx, cs, { op: 'void_lot', lotId: r.lotId, foodId: r.foodId, before, after });
      counts.lots_voided++;
      return;
    }
    case 'create_food':
    case 'unarchive_food': {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(lots)
        .where(and(eq(lots.foodId, r.foodId!), eq(lots.status, 'active')));
      if (n > 0) return; // other active lots still use this food; keep it
      const [before] = await tx.select().from(foods).where(eq(foods.id, r.foodId!));
      const [after] = await tx.update(foods).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(foods.id, r.foodId!)).returning();
      await recordChange(tx, cs, { op: 'archive_food', foodId: r.foodId, before, after });
      counts.foods_archived++;
      return;
    }
    case 'add_alias': {
      const alias = (r.after as { alias: string }).alias;
      await tx
        .update(foods)
        .set({ aliases: sql`array_remove(${foods.aliases}, ${alias})`, updatedAt: new Date() })
        .where(eq(foods.id, r.foodId!));
      await recordChange(tx, cs, { op: 'remove_alias', foodId: r.foodId, before: { alias }, after: { alias } });
      counts.aliases_removed++;
      return;
    }
    default:
      throw new AppError('not_supported', `Undo of "${r.op}" is not supported yet.`, 422);
  }
}

async function reopenProposalOps(tx: Tx, proposalId: string, changeSetId: string): Promise<string> {
  await tx
    .update(proposalOps)
    .set({ decision: 'pending', appliedAt: null, resultChangeSetId: null })
    .where(and(eq(proposalOps.proposalId, proposalId), eq(proposalOps.resultChangeSetId, changeSetId)));
  await refreshProposalStatus(tx, proposalId);
  return proposalId;
}

export async function undoChangeSet(db: Db, p: Principal, input: { change_set_id: string; idempotency_key: string }): Promise<UndoResult> {
  return runIdempotent(
    db,
    { householdId: p.householdId, tool: 'undo', key: input.idempotency_key, request: { change_set_id: input.change_set_id } },
    async (tx) => {
      const [cs] = await tx
        .select()
        .from(changeSets)
        .where(and(eq(changeSets.id, input.change_set_id), eq(changeSets.householdId, p.householdId)))
        .for('update');
      if (!cs) throw notFound('Change set');
      if (cs.revertedByChangeSetId) throw new AppError('already_reverted', 'This change set was already undone.', 409, { undone_by: cs.revertedByChangeSetId });
      if (cs.revertsChangeSetId) throw new AppError('not_supported', 'Undoing an undo is not supported; re-apply the original change instead.', 422);

      const rows = await tx.select().from(changes).where(eq(changes.changeSetId, cs.id)).orderBy(desc(changes.seq));
      const expected = new Map<string, number>();
      for (const r of rows) if (r.lotId && !expected.has(r.lotId)) expected.set(r.lotId, (r.after as { version: number }).version);
      if (expected.size) {
        const current = await tx.select({ id: lots.id, version: lots.version }).from(lots).where(inArray(lots.id, [...expected.keys()])).for('update');
        const conflicts = current.filter((l) => l.version !== expected.get(l.id)).map((l) => l.id);
        if (conflicts.length) {
          throw new AppError('undo_conflict', 'Some items changed after this; correct them individually instead.', 409, { lot_ids: conflicts });
        }
      }

      const undo = await openChangeSet(tx, p, { label: `Undo: ${cs.label}`, revertsChangeSetId: cs.id, idempotencyKey: input.idempotency_key });
      const counts: Counts = { lots_voided: 0, foods_archived: 0, aliases_removed: 0 };
      for (const r of rows) await revertChange(tx, undo, r, counts);
      await tx.update(changeSets).set({ revertedByChangeSetId: undo.id }).where(eq(changeSets.id, cs.id));
      const proposalReopened = cs.causeProposalId ? await reopenProposalOps(tx, cs.causeProposalId, cs.id) : null;
      return { reverted_change_set_id: cs.id, undo_change_set_id: undo.id, label: cs.label, ...counts, proposal_reopened: proposalReopened };
    },
  );
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -w apps/server -- changes && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat: change sets with snapshots, food reuse, alias learning, conflict-checked undo"
```

---

### Task 10: Reasoning port, interim heuristic and call logging

**Files:**
- Create: `apps/server/src/reasoning/port.ts`, `apps/server/src/reasoning/interim.ts`, `apps/server/src/reasoning/record.ts`, `apps/server/test/helpers/fakeReasoning.ts`
- Modify: `apps/server/src/http/app.ts` (`AppDeps.reasoning`), `apps/server/src/main.ts`, `apps/server/test/helpers/app.ts` (`testDeps`)
- Test: `apps/server/test/reasoning-port.test.ts`

**Interfaces:**
- Consumes: the `packages/reasoning` contract from `docs/handoffs/2026-09-29-crusoe-reasoning.md`, which is mirrored here structurally so Task 18 can pass that provider in unchanged.
- Produces:
  - Types: `ReasoningPort`, `CanonicalizeInput`, `CanonicalizeOutput`, `CanonicalLine`, `ShelfLifeInput`, `ShelfLifeOutput`, `ReasoningResult<T>`, `ReasoningCallRecord`
  - `createInterimReasoning(): ReasoningPort`. The server's last resort, also used when a provider throws.
  - `persistReasoningCall(tx, householdId, id, result): Promise<void>`
  - `AppDeps.reasoning: ReasoningPort`
  - Test helper `createFakeReasoning(opts?)` with `FIXTURE_CANON`

- [ ] **Step 1: Write the failing test** `apps/server/test/reasoning-port.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { reasoningCalls } from '../src/db/schema';
import { createInterimReasoning } from '../src/reasoning/interim';
import { persistReasoningCall } from '../src/reasoning/record';
import { resetDb, testDb } from './helpers/db';
import { seedUser } from './helpers/app';

describe('interim reasoning', () => {
  const r = createInterimReasoning();

  it('classifies coupons and returns and never invents a food id', async () => {
    const out = await r.canonicalizeItems({
      lines: [
        { line_id: 'L1', raw_text: 'SPINACH COUPON' },
        { line_id: 'L2', raw_text: 'RETURN: MILK 1/2 GAL' },
        { line_id: 'L3', raw_text: 'BABY SPINACH 5 OZ' },
      ],
      candidates: { L3: [{ food_id: 'f1', name: 'Baby spinach', aliases: [], category: 'produce', perishability: 'perishable' }] },
    });
    expect(out.path).toBe('fallback');
    expect(out.output.lines.map((l) => l.line_kind)).toEqual(['coupon', 'return', 'item']);
    expect(out.output.lines[2]?.match).toEqual({ food_id: 'f1', confidence: 'medium' });
  });

  it('cleans a raw line into a readable new-food name', async () => {
    const out = await r.canonicalizeItems({ lines: [{ line_id: 'L1', raw_text: 'CHERRY TOMATOES 10 OZ' }], candidates: {} });
    expect(out.output.lines[0]).toMatchObject({ canonical_name: 'Cherry tomatoes', match: { food_id: 'new', confidence: 'low' } });
  });

  it('returns no shelf-life estimate rather than guessing', async () => {
    const out = await r.estimateShelfLife({ food_name: 'Milk', states: ['sealed', 'opened'] });
    expect(out.output.per_state.sealed).toEqual({ days: null, confidence: 'low' });
  });
});

describe('persistReasoningCall', () => {
  beforeEach(() => resetDb());
  it('stores the call record with path and violations', async () => {
    const db = testDb();
    const { principal } = await seedUser(db);
    const result = await createInterimReasoning().estimateShelfLife({ food_name: 'Milk', states: ['sealed'] });
    const id = crypto.randomUUID();
    await db.transaction((tx) => persistReasoningCall(tx, principal.householdId, id, result));
    const [row] = await db.select().from(reasoningCalls).where(eq(reasoningCalls.id, id));
    expect(row).toMatchObject({ function: 'estimateShelfLife', provider: 'fallback', path: 'fallback', valid: true });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w apps/server -- reasoning-port`
Expected: FAIL.

- [ ] **Step 3: Implement the port** `apps/server/src/reasoning/port.ts`

```ts
// Mirrors the public contract of packages/reasoning (docs/handoffs/2026-09-29-crusoe-reasoning.md).
import type { Confidence, LineKind, LotState, Perishability } from '@buttery/domain';

export type CandidateFood = { food_id: string; name: string; aliases: string[]; category: string; perishability: Perishability };

export type CanonicalizeInput = {
  lines: Array<{
    line_id: string;
    raw_text: string;
    quantity?: number;
    price_cents?: number;
    line_kind?: LineKind;
    hint?: { food_name?: string; package?: { count?: number; size?: number; unit?: string }; location_guess?: string };
  }>;
  candidates: Record<string, CandidateFood[]>;
};

export type CanonicalLine = {
  line_id: string;
  canonical_name: string;
  category: string;
  perishability: Perishability;
  package?: { count?: number; size?: number; unit?: string };
  line_kind: LineKind;
  match: { food_id: string | 'new'; confidence: Confidence };
  rationale: string;
};
export type CanonicalizeOutput = { lines: CanonicalLine[] };

export type ShelfLifeInput = {
  food_name: string;
  category?: string;
  perishability?: Perishability;
  states: LotState[];
  location?: string;
  anchor_date?: string;
};
export type ShelfLifeOutput = {
  per_state: Partial<Record<LotState, { days: number | null; confidence: Confidence }>>;
  rationale: string;
};

export type ReasoningCallRecord = {
  function: 'canonicalizeItems' | 'estimateShelfLife' | 'parseActivity' | 'rankRecipes';
  provider: 'crusoe' | 'fallback' | 'fake';
  model: string | null;
  inputHash: string;
  input: unknown;
  output: unknown;
  valid: boolean;
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  error: string | null;
  createdAt: string;
};

export type ReasoningResult<T> = {
  output: T;
  path: 'model' | 'repair' | 'cache' | 'fallback';
  call: ReasoningCallRecord;
  violations: string[];
};

export type ReasoningContext = { householdId?: string };

export interface ReasoningPort {
  canonicalizeItems(input: CanonicalizeInput, ctx?: ReasoningContext): Promise<ReasoningResult<CanonicalizeOutput>>;
  estimateShelfLife(input: ShelfLifeInput, ctx?: ReasoningContext): Promise<ReasoningResult<ShelfLifeOutput>>;
}
```

- [ ] **Step 4: Implement the interim heuristic** `apps/server/src/reasoning/interim.ts`

```ts
import { hashJson, similarity, type LineKind } from '@buttery/domain';
import type { CanonicalizeInput, CanonicalizeOutput, ReasoningCallRecord, ReasoningPort, ReasoningResult, ShelfLifeInput, ShelfLifeOutput } from './port';

const SIZE_TOKENS = /\b\d+(\.\d+)?\s*(x\s*\d+(\.\d+)?\s*)?(oz|lb|lbs|gal|ct|count|pk|pack|can|fl|qt|l|ml|g|kg)\b/gi;

function guessKind(raw: string): LineKind {
  if (/\b(coupon|discount|savings|instant)\b/i.test(raw)) return 'coupon';
  if (/^(return|refund)\b/i.test(raw.trim())) return 'return';
  return 'item';
}

function cleanName(raw: string): string {
  const s = raw.replace(SIZE_TOKENS, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return s ? s[0]!.toUpperCase() + s.slice(1) : raw;
}

function record<T>(fn: ReasoningCallRecord['function'], input: unknown, output: T): ReasoningResult<T> {
  return {
    output,
    path: 'fallback',
    violations: [],
    call: {
      function: fn,
      provider: 'fallback',
      model: null,
      inputHash: hashJson(input),
      input,
      output,
      valid: true,
      latencyMs: 0,
      tokensIn: null,
      tokensOut: null,
      error: null,
      createdAt: new Date().toISOString(),
    },
  };
}

export function createInterimReasoning(): ReasoningPort {
  return {
    async canonicalizeItems(input: CanonicalizeInput) {
      const lines = input.lines.map((l) => {
        const kind = l.line_kind ?? guessKind(l.raw_text);
        const candidates = input.candidates[l.line_id] ?? [];
        const best = candidates
          .map((c) => ({ c, score: Math.max(similarity(l.raw_text, c.name), ...c.aliases.map((a) => similarity(l.raw_text, a))) }))
          .sort((a, b) => b.score - a.score)[0];
        const matched = kind === 'item' && best && best.score >= 0.35;
        return {
          line_id: l.line_id,
          canonical_name: matched ? best.c.name : l.hint?.food_name ?? cleanName(l.raw_text),
          category: matched ? best.c.category : 'other',
          perishability: matched ? best.c.perishability : ('perishable' as const),
          ...(l.hint?.package ? { package: l.hint.package } : {}),
          line_kind: kind,
          match: matched ? { food_id: best.c.food_id, confidence: 'medium' as const } : { food_id: 'new' as const, confidence: 'low' as const },
          rationale: 'Heuristic match (reasoning model unavailable)',
        };
      });
      return record<CanonicalizeOutput>('canonicalizeItems', input, { lines });
    },
    async estimateShelfLife(input: ShelfLifeInput) {
      const per_state = Object.fromEntries(input.states.map((s) => [s, { days: null, confidence: 'low' as const }]));
      return record<ShelfLifeOutput>('estimateShelfLife', input, { per_state, rationale: 'No estimate available without the reasoning model' });
    },
  };
}
```

- [ ] **Step 5: Implement call logging** `apps/server/src/reasoning/record.ts`

```ts
import type { Tx } from '../db/client';
import { reasoningCalls } from '../db/schema';
import type { ReasoningResult } from './port';

export async function persistReasoningCall(tx: Tx, householdId: string, id: string, r: ReasoningResult<unknown>): Promise<void> {
  await tx.insert(reasoningCalls).values({
    id,
    householdId,
    function: r.call.function,
    provider: r.call.provider,
    model: r.call.model,
    path: r.path,
    inputHash: r.call.inputHash,
    input: r.call.input as object,
    output: r.call.output as object,
    valid: r.call.valid,
    violations: r.violations,
    latencyMs: Math.round(r.call.latencyMs),
    tokensIn: r.call.tokensIn,
    tokensOut: r.call.tokensOut,
    error: r.call.error,
  });
}
```

- [ ] **Step 6: Create the fake for tests** `apps/server/test/helpers/fakeReasoning.ts`

```ts
import { hashJson, normalizeName, type Perishability } from '@buttery/domain';
import type { CanonicalizeInput, CanonicalizeOutput, ReasoningPort, ReasoningResult, ShelfLifeInput, ShelfLifeOutput } from '../../src/reasoning/port';

// What a good model returns for the fixture receipts in tests/fixtures/food-images.
export const FIXTURE_CANON: Record<string, [name: string, category: string, perishability: Perishability]> = {
  'WHOLE MILK 1 GAL': ['Whole milk', 'dairy', 'perishable'],
  'EGGS 24 CT': ['Eggs', 'eggs', 'perishable'],
  'BABY SPINACH 16 OZ': ['Baby spinach', 'leafy_produce', 'perishable'],
  'STRAWBERRIES 2 LB': ['Strawberries', 'fruit', 'perishable'],
  'CHKN BREAST 3 LB': ['Chicken breast', 'poultry', 'perishable'],
  'GRK YOGURT 2X32 OZ': ['Greek yogurt', 'dairy', 'perishable'],
  BANANAS: ['Bananas', 'fruit', 'perishable'],
  'CHERRY TOMATOES 10 OZ': ['Cherry tomatoes', 'produce', 'perishable'],
  'CHICKPEAS 15 OZ CAN': ['Canned chickpeas', 'canned', 'shelf_stable'],
  'BABY SPINACH 5 OZ': ['Baby spinach', 'leafy_produce', 'perishable'],
};

function result<T>(fn: 'canonicalizeItems' | 'estimateShelfLife', input: unknown, output: T): ReasoningResult<T> {
  return {
    output,
    path: 'model',
    violations: [],
    call: { function: fn, provider: 'fake', model: 'fake-1', inputHash: hashJson(input), input, output, valid: true, latencyMs: 1, tokensIn: 10, tokensOut: 10, error: null, createdAt: new Date().toISOString() },
  };
}

export type FakeReasoning = ReasoningPort & { calls: { canonicalize: CanonicalizeInput[]; shelfLife: ShelfLifeInput[] } };

export function createFakeReasoning(opts: { fail?: boolean } = {}): FakeReasoning {
  const calls = { canonicalize: [] as CanonicalizeInput[], shelfLife: [] as ShelfLifeInput[] };
  return {
    calls,
    async canonicalizeItems(input) {
      calls.canonicalize.push(input);
      if (opts.fail) throw new Error('network down');
      const lines: CanonicalizeOutput['lines'] = input.lines.map((l) => {
        const [name, category, perishability] = FIXTURE_CANON[l.raw_text] ?? [l.raw_text, 'other', 'perishable'];
        const hit = (input.candidates[l.line_id] ?? []).find((c) => normalizeName(c.name) === normalizeName(name));
        return {
          line_id: l.line_id,
          canonical_name: name,
          category,
          perishability,
          ...(l.hint?.package ? { package: l.hint.package } : {}),
          line_kind: l.line_kind ?? 'item',
          match: hit ? { food_id: hit.food_id, confidence: 'high' } : { food_id: 'new', confidence: 'medium' },
          rationale: hit ? 'Same product as existing item' : 'New item',
        };
      });
      return result('canonicalizeItems', input, { lines });
    },
    async estimateShelfLife(input) {
      calls.shelfLife.push(input);
      if (opts.fail) throw new Error('network down');
      const out: ShelfLifeOutput =
        input.perishability === 'shelf_stable'
          ? { per_state: { sealed: { days: 730, confidence: 'medium' }, opened: { days: 4, confidence: 'low' } }, rationale: 'canned' }
          : { per_state: { sealed: { days: 5, confidence: 'medium' }, opened: { days: 3, confidence: 'medium' }, frozen: { days: 180, confidence: 'medium' } }, rationale: 'fresh' };
      return result('estimateShelfLife', input, out);
    },
  };
}
```

- [ ] **Step 7: Wire it into `AppDeps`**

In `apps/server/src/http/app.ts`, add the import and field:

```ts
import type { ReasoningPort } from '../reasoning/port';

export type AppDeps = {
  config: Config;
  db: Db;
  reasoning: ReasoningPort;
  resolveBearer?: BearerResolver;
};
```

In `apps/server/src/main.ts`:

```ts
import { createInterimReasoning } from './reasoning/interim';
// ...
const app = createApp({ config, db, reasoning: createInterimReasoning() });
```

In `apps/server/test/helpers/app.ts`, change `testDeps`:

```ts
import { createFakeReasoning } from './fakeReasoning';

export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return { config: testConfig(), db: testDb(), reasoning: createFakeReasoning(), ...overrides };
}
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npm test -w apps/server && npm run typecheck`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add apps/server
git commit -m "feat: reasoning port matching the Crusoe module contract, interim heuristic, call logging"
```

---

### Task 11: Receipt ingestion (`submitReceipt`)

**Files:**
- Create: `apps/server/src/services/foods.ts`, `apps/server/src/services/links.ts`, `apps/server/src/services/drafts.ts`, `apps/server/src/services/receipts.ts`, `apps/server/test/fixtures/receipts.ts`
- Test: `apps/server/test/receipts.test.ts`

**Interfaces:**
- Consumes: domain (`withLineIds`, `receiptFingerprint`, `receiptNearKey`, `exactAliasMatch`, `shortlist`, `normalizePackage`, `quantityFromReceiptLine`, `computeEffectiveExpiry`), `ReasoningPort`, `createInterimReasoning`, `persistReasoningCall`, `findIdempotent`, `runIdempotent`.
- Produces:
  - `loadCatalog(db, householdId): Promise<FoodRow[]>` (non-archived foods), `toCandidate(food): CandidateFood`
  - `makeLinks(base)` → `{ review(id), item(lotId), inventory(params?) }`
  - `type LineSnapshot`, `type LotDraft`, `type IgnoreDraft`, `LotDraftEditSchema`/`LotDraftEdit`, `applyDraftEdits(draft, edits, foodsById)`, `previewExpiry(draft, food?)`, `countOps(ops)`, `defaultLocationFor(perishability)`
  - `SubmitReceiptInputSchema`, `type SubmitReceiptResult`, `submitReceipt(deps, principal, input): Promise<SubmitReceiptResult>`
  - Test helper `fixtureReceipt('warehouse' | 'mixed'): ReceiptPayload`

- [ ] **Step 1: Create the fixture helper** `apps/server/test/fixtures/receipts.ts`

This transcribes the receipt fixtures the way a careful agent would. The test never sees expected canonical names; those live only in `FIXTURE_CANON` inside the fake model.

```ts
import { readFileSync } from 'node:fs';
import type { ReceiptPayload } from '@buttery/domain';

type Row = {
  raw: string;
  detail?: string;
  quantity?: number;
  unit?: string;
  amount: number;
  kind: string;
  package_count?: number;
  package_size?: { quantity: number; unit: string };
};
type Receipt = { merchant: string; transaction_id: string; purchased_at_local: string; total: number; rows: Row[] };

const FIXTURE = new URL('../../../../tests/fixtures/food-images/sources/expected-text.json', import.meta.url);
const data = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { receipts: Record<'warehouse' | 'mixed', Receipt> };
const KIND = { food_purchase: 'item', discount: 'coupon', non_food_purchase: 'non_food', return: 'return' } as const;

export function fixtureReceipt(name: 'warehouse' | 'mixed'): ReceiptPayload {
  const r = data.receipts[name];
  return {
    store: r.merchant,
    purchased_at: r.purchased_at_local.slice(0, 16),
    receipt_number: r.transaction_id,
    total_cents: Math.round(r.total * 100),
    lines: r.rows.map((row) => ({
      raw_text: row.raw,
      ...(row.detail ? { detail: row.detail } : {}),
      ...(row.quantity !== undefined ? { quantity: row.quantity } : {}),
      ...(row.unit ? { unit: row.unit } : {}),
      price_cents: Math.round(row.amount * 100),
      line_kind: KIND[row.kind as keyof typeof KIND],
      ...(row.package_size
        ? { hint: { package: { ...(row.package_count ? { count: row.package_count } : {}), size: row.package_size.quantity, unit: row.package_size.unit } } }
        : {}),
    })),
  };
}
```

- [ ] **Step 2: Write the failing test** `apps/server/test/receipts.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { lots, observations, proposalOps, reasoningCalls } from '../src/db/schema';
import { addAlias, createOrReuseFood, openChangeSet } from '../src/services/changes';
import { submitReceipt } from '../src/services/receipts';
import type { LotDraft } from '../src/services/drafts';
import { resetDb, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';
import { createFakeReasoning } from './helpers/fakeReasoning';
import { fixtureReceipt } from './fixtures/receipts';

const db = testDb();
type Deps = ReturnType<typeof testDeps>;
type P = Awaited<ReturnType<typeof seedUser>>['principal'];
const submit = (deps: Deps, p: P, payload = fixtureReceipt('warehouse'), key = 'rcpt-00001') =>
  submitReceipt(deps, p, { kind: 'receipt', payload, idempotency_key: key });

async function opsFor(proposalId: string) {
  const rows = await db.select().from(proposalOps).where(eq(proposalOps.proposalId, proposalId)).orderBy(proposalOps.seq);
  return Object.fromEntries(rows.map((o) => [(o.payload as LotDraft).line.raw_text, o]));
}

describe('submitReceipt', () => {
  beforeEach(() => resetDb());

  it('builds a review-only proposal for the warehouse receipt', async () => {
    const { principal } = await seedUser(db);
    const r = await submit(testDeps(), principal);
    expect(r.review_url).toBe(`https://buttery.test/review/${r.proposal_id}`);
    expect(r.counts).toMatchObject({ lines: 6, items: 6, new_foods: 6, ignored: 0 });
    expect(r.auto_applied).toEqual([]);
    expect(await db.select().from(lots)).toHaveLength(0);

    const ops = await opsFor(r.proposal_id);
    expect(ops['GRK YOGURT 2X32 OZ']?.payload).toMatchObject({ quantity: { kind: 'exact', amount: 2, unit: 'count' }, package: { size: 32, unit: 'oz' } });
    expect(ops['EGGS 24 CT']?.payload).toMatchObject({ quantity: { amount: 24, unit: 'count' }, package: { count: 24 } });
    expect(ops['CHKN BREAST 3 LB']?.payload).toMatchObject({
      food_id: null,
      new_food: { name: 'Chicken breast', perishability: 'perishable', shelf_life: { sealed: { days: 5, source: 'model_estimate', model: 'fake-1' } } },
      acquired_on: '2026-09-28',
      location: 'fridge',
    });
  });

  it('never turns coupon, non-food or return lines into lots', async () => {
    const { principal } = await seedUser(db);
    const r = await submit(testDeps(), principal, fixtureReceipt('mixed'));
    expect(r.counts).toMatchObject({ lines: 7, items: 4, ignored: 3 });
    const ops = await opsFor(r.proposal_id);
    for (const raw of ['SPINACH COUPON', 'PAPER TOWELS 2 ROLL', 'RETURN: MILK 1/2 GAL']) expect(ops[raw]?.op).toBe('ignore_line');
    expect(ops['BANANAS']?.payload).toMatchObject({ quantity: { kind: 'exact', amount: 1.25, unit: 'lb' }, package: null });
    expect(ops['CHICKPEAS 15 OZ CAN']?.payload).toMatchObject({ quantity: { amount: 4 }, package: { size: 15, unit: 'oz' }, location: 'pantry' });
    expect(r.uncertainties.join(' ')).toContain('Returns are listed but not applied');
  });

  it('replays the same idempotency key without recording twice', async () => {
    const { principal } = await seedUser(db);
    const deps = testDeps();
    const a = await submit(deps, principal);
    const b = await submit(deps, principal);
    expect(b).toEqual(a);
    expect(await db.select().from(observations)).toHaveLength(1);
  });

  it('detects a recaptured receipt as a duplicate', async () => {
    const { principal } = await seedUser(db);
    const deps = testDeps();
    const a = await submit(deps, principal);
    const recapture = { ...fixtureReceipt('warehouse'), purchased_at: '2026-09-28T18:43', store: 'Pantry Club' };
    const b = await submit(deps, principal, recapture, 'rcpt-00002');
    expect(b).toMatchObject({ duplicate_of: a.observation_id, proposal_id: a.proposal_id, review_url: a.review_url });
    expect(await db.select().from(observations)).toHaveLength(1);
  });

  it('flags a possible duplicate when the receipt number was not transcribed', async () => {
    const { principal } = await seedUser(db);
    const deps = testDeps();
    const a = await submit(deps, principal);
    const { receipt_number: _omit, ...noNumber } = fixtureReceipt('warehouse');
    const b = await submit(deps, principal, noNumber, 'rcpt-00003');
    expect(b.duplicate_of).toBeNull();
    expect(b.possible_duplicate_of).toBe(a.observation_id);
    expect(b.uncertainties.join(' ')).toContain('already recorded');
  });

  it('still builds a proposal when reasoning throws', async () => {
    const { principal } = await seedUser(db);
    const r = await submit(testDeps({ reasoning: createFakeReasoning({ fail: true }) }), principal);
    expect(r.reasoning.fallback_used).toBe(true);
    expect(r.counts.items).toBe(6);
    const ops = Object.values(await opsFor(r.proposal_id));
    expect(ops.every((o) => o.confidence === 'low')).toBe(true);
    const calls = await db.select().from(reasoningCalls);
    expect(calls.some((c) => c.error?.includes('network down'))).toBe(true);
  });

  it('matches learned aliases without asking the model', async () => {
    const { principal } = await seedUser(db);
    const milk = await db.transaction(async (tx) => {
      const cs = await openChangeSet(tx, principal, { label: 'seed' });
      const { food } = await createOrReuseFood(tx, cs, { name: 'Whole milk', perishability: 'perishable', defaultLocation: 'fridge' });
      return addAlias(tx, cs, food, 'WHOLE MILK 1 GAL');
    });
    const fake = createFakeReasoning();
    const r = await submit(testDeps({ reasoning: fake }), principal);
    expect(fake.calls.canonicalize[0]?.lines.map((l) => l.raw_text)).not.toContain('WHOLE MILK 1 GAL');
    const ops = await opsFor(r.proposal_id);
    expect(ops['WHOLE MILK 1 GAL']).toMatchObject({ targetFoodId: milk.id, confidence: 'high' });
    expect(r.counts).toMatchObject({ matched: 1, new_foods: 5 });
  });

  it('records reasoning calls and links them from ops', async () => {
    const { principal } = await seedUser(db);
    const r = await submit(testDeps(), principal);
    const ops = Object.values(await opsFor(r.proposal_id));
    const ids = new Set((await db.select().from(reasoningCalls)).map((c) => c.id));
    expect(ops.every((o) => o.reasoningCallId && ids.has(o.reasoningCallId))).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -w apps/server -- receipts`
Expected: FAIL.

- [ ] **Step 4: Implement the supporting services**

`apps/server/src/services/foods.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm';
import type { Executor } from '../db/client';
import { foods, type FoodRow } from '../db/schema';
import type { CandidateFood } from '../reasoning/port';

export async function loadCatalog(db: Executor, householdId: string): Promise<FoodRow[]> {
  return db.select().from(foods).where(and(eq(foods.householdId, householdId), isNull(foods.archivedAt)));
}

export function toCandidate(f: FoodRow): CandidateFood {
  return { food_id: f.id, name: f.name, aliases: f.aliases, category: f.category ?? 'other', perishability: f.perishability };
}
```

`apps/server/src/services/links.ts`:

```ts
export function makeLinks(base: string) {
  return {
    review: (proposalId: string) => `${base}/review/${proposalId}`,
    item: (lotId: string) => `${base}/items/${lotId}`,
    inventory: (params: Record<string, string> = {}) => {
      const q = new URLSearchParams(params).toString();
      return `${base}/inventory${q ? `?${q}` : ''}`;
    },
  };
}
```

`apps/server/src/services/drafts.ts`:

```ts
import { z } from 'zod';
import {
  computeEffectiveExpiry,
  IsoDateSchema,
  PerishabilitySchema,
  QuantitySchema,
  type Expiry,
  type IsoDate,
  type LineKind,
  type LotState,
  type Package,
  type Perishability,
  type Quantity,
  type ShelfLifeMap,
} from '@buttery/domain';
import type { FoodRow } from '../db/schema';
import { AppError } from '../errors';

export type LineSnapshot = { line_id: string; raw_text: string; detail?: string; quantity?: number; unit?: string; price_cents?: number };

export type LotDraft = {
  line: LineSnapshot;
  food_id: string | null;
  food_name: string;
  new_food: { name: string; category: string | null; perishability: Perishability; shelf_life: ShelfLifeMap } | null;
  location: string;
  state: LotState;
  quantity: Quantity;
  package: Package | null;
  acquired_on: IsoDate;
  printed_expiry_on: IsoDate | null;
  notes: string | null;
};

export type IgnoreDraft = { line: LineSnapshot; line_kind: Exclude<LineKind, 'item'>; reason: string };

export const LotDraftEditSchema = z
  .object({
    food_id: z.uuid().optional().describe('Switch this line to an existing food'),
    new_food: z
      .object({ name: z.string().min(1).max(100), category: z.string().max(40).optional(), perishability: PerishabilitySchema.optional() })
      .optional()
      .describe('Treat this line as a new food with this name'),
    quantity: QuantitySchema.optional(),
    location: z.string().min(1).max(40).optional(),
    expires_on: IsoDateSchema.nullable().optional().describe('Date printed on the package; null clears it'),
    notes: z.string().max(500).nullable().optional(),
  })
  .strict();
export type LotDraftEdit = z.infer<typeof LotDraftEditSchema>;

export function defaultLocationFor(perishability: Perishability): string {
  return perishability === 'perishable' ? 'fridge' : 'pantry';
}

export function applyDraftEdits(draft: LotDraft, e: LotDraftEdit, foodsById: Map<string, FoodRow>): LotDraft {
  const next: LotDraft = { ...draft };
  if (e.food_id) {
    const f = foodsById.get(e.food_id);
    if (!f) throw new AppError('invalid_input', 'Unknown food_id for this household', 422);
    next.food_id = f.id;
    next.food_name = f.name;
    next.new_food = null;
    if (!e.location && f.defaultLocation) next.location = f.defaultLocation;
  }
  if (e.new_food) {
    const base = next.new_food ?? { name: next.food_name, category: null, perishability: 'perishable' as Perishability, shelf_life: {} };
    next.food_id = null;
    next.new_food = {
      ...base,
      name: e.new_food.name,
      category: e.new_food.category ?? base.category,
      perishability: e.new_food.perishability ?? base.perishability,
    };
    next.food_name = next.new_food.name;
  }
  if (e.quantity) next.quantity = e.quantity;
  if (e.location) next.location = e.location;
  if (e.expires_on !== undefined) next.printed_expiry_on = e.expires_on;
  if (e.notes !== undefined) next.notes = e.notes;
  return next;
}

export function previewExpiry(d: LotDraft, food?: FoodRow): Expiry | null {
  return computeEffectiveExpiry({
    perishability: food?.perishability ?? d.new_food?.perishability ?? 'perishable',
    state: d.state,
    anchors: { sealed: d.acquired_on },
    printedExpiryOn: d.printed_expiry_on,
    shelfLife: food?.shelfLife ?? d.new_food?.shelf_life ?? {},
  });
}

type CountableOp = { op: string; targetFoodId: string | null; confidence: string; decision?: string; appliedAt?: Date | null; payload: unknown };

export function countOps(ops: CountableOp[]) {
  const lotOps = ops.filter((o) => o.op === 'add_lot');
  const newNames = new Set(lotOps.filter((o) => !o.targetFoodId).map((o) => (o.payload as LotDraft).food_name.toLowerCase()));
  return {
    lines: ops.length,
    items: lotOps.length,
    matched: lotOps.filter((o) => o.targetFoodId).length,
    new_foods: newNames.size,
    ignored: ops.filter((o) => o.op === 'ignore_line').length,
    low_confidence: ops.filter((o) => o.confidence === 'low').length,
    pending: ops.filter((o) => (o.decision ?? 'pending') === 'pending' && !o.appliedAt).length,
    applied: ops.filter((o) => o.appliedAt).length,
  };
}
```

- [ ] **Step 5: Implement** `apps/server/src/services/receipts.ts`

```ts
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
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -w apps/server -- receipts && npm run typecheck`
Expected: 8 pass.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "feat: receipt ingestion with dedup, alias matching, reasoning with fallback, review-only proposals"
```

---

### Task 12: Reviewing and applying proposals (`resolveProposal`, `getProposalView`)

**Files:**
- Create: `apps/server/src/services/proposals.ts`
- Test: `apps/server/test/proposals.test.ts`

**Interfaces:**
- Consumes: `LotDraft`, `applyDraftEdits`, `previewExpiry`, `countOps`, `openChangeSet`, `createOrReuseFood`, `addAlias`, `addLot`, `refreshProposalStatus`, `runIdempotent`, `getHousehold`, `makeLinks`.
- Produces:
  - `DecisionSchema`, `ResolveProposalInputSchema`/`ResolveProposalInput`
  - `type OpView`, `type ProposalView`
  - `getProposalView(deps, p, proposalId, now?): Promise<ProposalView>`
  - `resolveProposal(deps, p, input, now?): Promise<ProposalView & { applied_change_set_id: string | null; created_lot_ids: string[]; notes: string[]; undo: { change_set_id: string } | null }>`

- [ ] **Step 1: Write the failing test** `apps/server/test/proposals.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { foods, lots, observations } from '../src/db/schema';
import { createOrReuseFood, openChangeSet, undoChangeSet } from '../src/services/changes';
import { getProposalView, resolveProposal } from '../src/services/proposals';
import { submitReceipt } from '../src/services/receipts';
import { resetDb, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';
import { createFakeReasoning } from './helpers/fakeReasoning';
import { fixtureReceipt } from './fixtures/receipts';

const db = testDb();
const NOW = new Date('2026-09-29T15:00:00Z');

async function setup(receipt: 'warehouse' | 'mixed' = 'warehouse') {
  const { principal } = await seedUser(db);
  const fake = createFakeReasoning();
  const deps = testDeps({ reasoning: fake });
  const r = await submitReceipt(deps, principal, { kind: 'receipt', payload: fixtureReceipt(receipt), idempotency_key: `rcpt-${receipt}-1` });
  const view = await getProposalView(deps, principal, r.proposal_id, NOW);
  const op = (raw: string) => view.ops.find((o) => o.line.raw_text === raw)!;
  return { principal, deps, fake, r, view, op };
}
const activeLots = () => db.select().from(lots).where(eq(lots.status, 'active'));

describe('resolveProposal', () => {
  beforeEach(() => resetDb());

  it('shows the review with estimated expiry text', async () => {
    const { view, op } = await setup();
    expect(view.observation).toMatchObject({ store: 'PANTRY CLUB', via: 'Test Client', recorded_by: 'Alex' });
    expect(op('CHKN BREAST 3 LB').draft).toMatchObject({ food_name: 'Chicken breast', is_new_food: true, quantity_text: '1 × 3 lb', expiry_text: 'est. Sat · medium' });
  });

  it('accepts everything and applies it as one change set', async () => {
    const { principal, deps, r } = await setup();
    const out = await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0001' }, NOW);
    expect(out.proposal.status).toBe('applied');
    expect(out.created_lot_ids).toHaveLength(6);
    expect(out.undo?.change_set_id).toBe(out.applied_change_set_id);
    const chicken = (await db.select().from(foods).where(eq(foods.normalizedName, 'chicken breast')))[0]!;
    expect(chicken.aliases).toContain('chkn breast 3 lb');
    const [lot] = await db.select().from(lots).where(eq(lots.foodId, chicken.id));
    expect(lot?.expires).toMatchObject({ on: '2026-10-03', kind: 'estimated', confidence: 'medium' });
    const [obs] = await db.select().from(observations).where(eq(observations.id, r.observation_id));
    expect(obs?.status).toBe('resolved');
  });

  it('applies edits and rejections', async () => {
    const { principal, deps, r, op } = await setup();
    const out = await resolveProposal(
      deps,
      principal,
      {
        proposal_id: r.proposal_id,
        decisions: [
          { op_id: op('GRK YOGURT 2X32 OZ').op_id, action: 'edit', edits: { quantity: { kind: 'approx', amount: 1, unit: 'count' }, location: 'freezer', expires_on: '2026-10-20' } },
          { op_id: op('STRAWBERRIES 2 LB').op_id, action: 'reject' },
        ],
        accept_remaining: true,
        apply: true,
        idempotency_key: 'apply-0002',
      },
      NOW,
    );
    expect(out.created_lot_ids).toHaveLength(5);
    const yogurt = out.ops.find((o) => o.line.raw_text === 'GRK YOGURT 2X32 OZ')!;
    expect(yogurt).toMatchObject({ decision: 'edited', applied: true, draft: { location: 'freezer', quantity_text: '~1 × 32 oz' } });
    const [lot] = await db.select().from(lots).where(eq(lots.location, 'freezer'));
    expect(lot?.expires).toMatchObject({ on: '2026-10-20', kind: 'printed' });
    expect(out.ops.find((o) => o.line.raw_text === 'STRAWBERRIES 2 LB')).toMatchObject({ decision: 'rejected', applied: false });
    expect(out.proposal.status).toBe('applied');
  });

  it('supports partial review', async () => {
    const { principal, deps, r, op } = await setup();
    const first = await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [{ op_id: op('EGGS 24 CT').op_id, action: 'accept' }], accept_remaining: false, apply: true, idempotency_key: 'apply-0003' }, NOW);
    expect(first.proposal.status).toBe('partial');
    expect(await activeLots()).toHaveLength(1);
    const second = await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0004' }, NOW);
    expect(second.proposal.status).toBe('applied');
    expect(await activeLots()).toHaveLength(6);
  });

  it('can switch a line to an existing food instead of creating one', async () => {
    const { principal, deps, r, op } = await setup();
    const milk = await db.transaction(async (tx) => {
      const cs = await openChangeSet(tx, principal, { label: 'seed' });
      return (await createOrReuseFood(tx, cs, { name: 'Milk', perishability: 'perishable' })).food;
    });
    await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [{ op_id: op('WHOLE MILK 1 GAL').op_id, action: 'edit', edits: { food_id: milk.id } }], accept_remaining: true, apply: true, idempotency_key: 'apply-0005' }, NOW);
    expect(await db.select().from(foods).where(eq(foods.normalizedName, 'whole milk'))).toHaveLength(0);
    expect((await db.select().from(lots).where(eq(lots.foodId, milk.id))).length).toBe(1);
  });

  it('never creates lots for ignored lines, even after accept-all', async () => {
    const { principal, deps, r } = await setup('mixed');
    const out = await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0006' }, NOW);
    expect(out.created_lot_ids).toHaveLength(4);
    expect(out.proposal.status).toBe('applied');
  });

  it('does not duplicate lots on a second apply with a new key', async () => {
    const { principal, deps, r } = await setup();
    await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0007' }, NOW);
    const again = await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0008' }, NOW);
    expect(again.applied_change_set_id).toBeNull();
    expect(again.notes).toContain('Nothing left to apply.');
    expect(await activeLots()).toHaveLength(6);
  });

  it('replays the same key', async () => {
    const { principal, deps, r } = await setup();
    const input = { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0009' };
    const a = await resolveProposal(deps, principal, input, NOW);
    const b = await resolveProposal(deps, principal, input, NOW);
    expect(b.applied_change_set_id).toBe(a.applied_change_set_id);
    expect(await activeLots()).toHaveLength(6);
  });

  it('undo reopens the proposal so it can be fixed and re-applied', async () => {
    const { principal, deps, r } = await setup();
    const applied = await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0010' }, NOW);
    const undo = await undoChangeSet(db, principal, { change_set_id: applied.applied_change_set_id!, idempotency_key: 'undo-0010' });
    expect(undo.proposal_reopened).toBe(r.proposal_id);
    expect(await activeLots()).toHaveLength(0);
    const view = await getProposalView(deps, principal, r.proposal_id, NOW);
    expect(view.proposal.status).toBe('pending');
    const reapplied = await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0011' }, NOW);
    expect(reapplied.created_lot_ids).toHaveLength(6);
    expect(await db.select().from(foods)).toHaveLength(6); // revived, not duplicated
  });

  it('matches the next receipt via learned aliases', async () => {
    const { principal, deps, fake, r } = await setup();
    await resolveProposal(deps, principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0012' }, NOW);
    const next = await submitReceipt(deps, principal, { kind: 'receipt', payload: { ...fixtureReceipt('warehouse'), receipt_number: 'PC-009999', purchased_at: '2026-10-05T10:00' }, idempotency_key: 'rcpt-next-1' });
    expect(next.counts).toMatchObject({ matched: 6, new_foods: 0 });
    expect(fake.calls.canonicalize).toHaveLength(1); // second receipt needed no model call
    const view = await getProposalView(deps, principal, next.proposal_id, NOW);
    expect(view.ops.every((o) => o.confidence === 'high')).toBe(true);
  });

  it('hides proposals from other households', async () => {
    const { deps, r } = await setup();
    const other = await seedUser(db, 'other@example.com');
    await expect(getProposalView(deps, other.principal, r.proposal_id, NOW)).rejects.toMatchObject({ code: 'not_found' });
    await expect(resolveProposal(deps, other.principal, { proposal_id: r.proposal_id, decisions: [], accept_remaining: true, apply: true, idempotency_key: 'apply-0013' }, NOW)).rejects.toMatchObject({ code: 'not_found' });
    expect(await db.select().from(lots).where(and(eq(lots.householdId, other.principal.householdId)))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w apps/server -- proposals`
Expected: FAIL.

- [ ] **Step 3: Implement** `apps/server/src/services/proposals.ts`

```ts
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
  observation: { id: string; kind: string; store: string | null; purchased_at: string | null; receipt_number: string | null; total_cents: number | null; recorded_at: string; recorded_by: string | null; via: string | null };
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
    },
    ops: ops.map((o) => toOpView(o, foodsById, today)),
    counts: countOps(ops),
    links: { review: links.review(proposal.id), inventory: links.inventory() },
  };
}

function receiptLabel(payload: Record<string, unknown>): string {
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

export async function resolveProposal(deps: Deps, p: Principal, input: ResolveProposalInput, now = new Date()) {
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
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -w apps/server -- proposals && npm run typecheck`
Expected: 11 pass. If the "est. Sat" assertion fails, check the date: the fake gives 5 days from 2026-09-28, which is Sat 2026-10-03, and today is 2026-09-29 in New York.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat: review, edit, partially apply and re-apply receipt proposals"
```

---

### Task 13: Inventory read services (summary, search, item detail, inventory page)

**Files:**
- Create: `apps/server/src/services/views.ts`, `apps/server/src/services/inventory.ts`
- Modify: `apps/server/src/services/proposals.ts` (export `receiptLabel`)
- Test: `apps/server/test/inventory.test.ts`

**Interfaces:**
- Consumes: `lots`, `foods`, `changeSets`, `changes`, `observations`, `proposals`, `proposalOps`, `reasoningCalls`, domain `describeQuantity`/`describeExpiry`/`urgencyOf`/`todayIn`/`similarity`, `makeLinks`, `getHousehold`.
- Produces:
  - `type LotView`, `toLotView(lot, food, today, links, now)`, `type CompactLot`, `compactLot(v)`
  - `STALE_AFTER_DAYS = 7`
  - `getHouseholdSummary(deps, p, now?)`
  - `SearchInventoryInputSchema`, `searchInventory(deps, p, input, now?)`
  - `getInventoryPage(deps, p, { location? }, now?)`
  - `getItem(deps, p, lotId, now?)`

- [ ] **Step 1: Export the label helper** from `apps/server/src/services/proposals.ts`

Change `function receiptLabel` to `export function receiptLabel`.

- [ ] **Step 2: Write the failing test** `apps/server/test/inventory.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { lots } from '../src/db/schema';
import { undoChangeSet } from '../src/services/changes';
import { getHouseholdSummary, getInventoryPage, getItem, searchInventory, SearchInventoryInputSchema } from '../src/services/inventory';
import { getProposalView, resolveProposal } from '../src/services/proposals';
import { submitReceipt } from '../src/services/receipts';
import { resetDb, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';
import { fixtureReceipt } from './fixtures/receipts';

const db = testDb();
const NOW = new Date('2026-09-29T15:00:00Z'); // Tue 2026-09-29 in New York

async function seedInventory() {
  const { principal } = await seedUser(db);
  const deps = testDeps();
  const r = await submitReceipt(deps, principal, { kind: 'receipt', payload: fixtureReceipt('warehouse'), idempotency_key: 'rcpt-inv-1' });
  const view = await getProposalView(deps, principal, r.proposal_id, NOW);
  const op = (raw: string) => view.ops.find((o) => o.line.raw_text === raw)!.op_id;
  const applied = await resolveProposal(
    deps,
    principal,
    {
      proposal_id: r.proposal_id,
      decisions: [
        { op_id: op('EGGS 24 CT'), action: 'edit', edits: { expires_on: '2026-09-30' } },
        { op_id: op('STRAWBERRIES 2 LB'), action: 'edit', edits: { expires_on: '2026-09-27' } },
      ],
      accept_remaining: true,
      apply: true,
      idempotency_key: 'apply-inv-1',
    },
    NOW,
  );
  return { principal, deps, applied };
}

describe('inventory reads', () => {
  beforeEach(() => resetDb());

  it('summarizes what is on hand, what to use soon and what changed', async () => {
    const { principal, deps } = await seedInventory();
    const s = await getHouseholdSummary(deps, principal, NOW);
    expect(s.today).toBe('2026-09-29');
    expect(s.counts).toMatchObject({ active_items: 6, by_location: { fridge: 6 } });
    expect(s.use_soon.expired.map((l) => l.name)).toEqual(['Strawberries']);
    expect(s.use_soon.urgent.map((l) => l.name)).toEqual(['Eggs']);
    expect(s.use_soon.soon).toHaveLength(4);
    expect(s.use_soon.urgent[0]).toMatchObject({ expiry_text: 'exp tomorrow', quantity_text: '24 count' });
    expect(s.attention).toMatchObject({ pending_reviews: 0, expired: 1, stale: 0 });
    expect(s.recent_changes[0]).toMatchObject({ label: 'Receipt: PANTRY CLUB 2026-09-28', via: 'Test Client', undone: false });
    expect(s.links.inventory).toBe('https://buttery.test/inventory');
    expect(JSON.stringify(s).length).toBeLessThan(8000);
  });

  it('lists pending reviews with links', async () => {
    const { principal } = await seedUser(db);
    const deps = testDeps();
    const r = await submitReceipt(deps, principal, { kind: 'receipt', payload: fixtureReceipt('mixed'), idempotency_key: 'rcpt-inv-2' });
    const s = await getHouseholdSummary(deps, principal, NOW);
    expect(s.pending_reviews[0]).toMatchObject({ proposal_id: r.proposal_id, review_url: r.review_url, open_lines: 7 });
    expect(s.attention.pending_reviews).toBe(1);
  });

  it('flags stale perishables', async () => {
    const { principal, deps, applied } = await seedInventory();
    await db.update(lots).set({ lastEvidenceAt: new Date('2026-09-15T00:00:00Z') }).where(eq(lots.id, applied.created_lot_ids[0]!));
    expect((await getHouseholdSummary(deps, principal, NOW)).attention.stale).toBe(1);
  });

  it('searches by name, expiry window and location', async () => {
    const { principal, deps } = await seedInventory();
    const q = (x: Record<string, unknown>) => searchInventory(deps, principal, SearchInventoryInputSchema.parse(x), NOW);
    expect((await q({ query: 'spinach' })).items.map((i) => i.food.name)).toEqual(['Baby spinach']);
    expect((await q({ expiring_within_days: 1 })).items.map((i) => i.food.name)).toEqual(['Strawberries', 'Eggs']);
    expect((await q({ location: 'pantry' })).items).toHaveLength(0);
  });

  it('explains an item: evidence, estimate basis and history', async () => {
    const { principal, deps } = await seedInventory();
    const chicken = (await searchInventory(deps, principal, SearchInventoryInputSchema.parse({ query: 'chicken' }), NOW)).items[0]!;
    const item = await getItem(deps, principal, chicken.lot_id, NOW);
    expect(item.lot.expires).toMatchObject({ kind: 'estimated', confidence: 'medium' });
    expect(item.lot.expires?.basis).toContain('fake-1');
    expect(item.evidence[0]).toMatchObject({ kind: 'receipt', summary: 'Receipt · PANTRY CLUB · 2026-09-28', line: 'CHKN BREAST 3 LB' });
    expect(item.history.map((h) => h.op)).toEqual(['add_lot']);
    expect(item.reasoning.some((c) => c.function === 'estimateShelfLife' && c.model === 'fake-1')).toBe(true);
  });

  it('groups the inventory page by urgency and location', async () => {
    const { principal, deps } = await seedInventory();
    const page = await getInventoryPage(deps, principal, {}, NOW);
    expect(page.use_soon.expired).toHaveLength(1);
    expect(Object.keys(page.by_location)).toEqual(['fridge']);
    expect(page.locations).toEqual(['fridge', 'freezer', 'pantry', 'counter']);
  });

  it('drops voided items after undo', async () => {
    const { principal, deps, applied } = await seedInventory();
    await undoChangeSet(db, principal, { change_set_id: applied.applied_change_set_id!, idempotency_key: 'undo-inv-1' });
    const s = await getHouseholdSummary(deps, principal, NOW);
    expect(s.counts.active_items).toBe(0);
    expect(s.recent_changes.map((c) => c.label)).toEqual(['Undo: Receipt: PANTRY CLUB 2026-09-28', 'Receipt: PANTRY CLUB 2026-09-28']);
    expect(s.recent_changes[1]?.undone).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -w apps/server -- inventory`
Expected: FAIL.

- [ ] **Step 4: Implement** `apps/server/src/services/views.ts`

```ts
import { describeExpiry, describeQuantity, urgencyOf, type Expiry, type IsoDate, type Package, type Quantity, type Urgency } from '@buttery/domain';
import type { FoodRow, LotRow } from '../db/schema';
import type { makeLinks } from './links';

export type LotView = {
  lot_id: string;
  food: { id: string; name: string; category: string | null; perishability: string };
  location: string;
  state: string;
  status: string;
  quantity: Quantity;
  package: Package | null;
  quantity_text: string;
  expires: Expiry | null;
  expiry_text: string;
  urgency: Urgency | null;
  acquired_on: string | null;
  last_evidence_at: string | null;
  evidence_age_days: number | null;
  links: { item: string };
};

export function toLotView(lot: LotRow, food: FoodRow, today: IsoDate, links: ReturnType<typeof makeLinks>, now: Date): LotView {
  return {
    lot_id: lot.id,
    food: { id: food.id, name: food.name, category: food.category, perishability: food.perishability },
    location: lot.location,
    state: lot.state,
    status: lot.status,
    quantity: lot.quantity,
    package: lot.package ?? null,
    quantity_text: describeQuantity(lot.quantity, lot.package),
    expires: lot.expires ?? null,
    expiry_text: describeExpiry(lot.expires, today),
    urgency: urgencyOf(lot.expires, today),
    acquired_on: lot.acquiredOn,
    last_evidence_at: lot.lastEvidenceAt?.toISOString() ?? null,
    evidence_age_days: lot.lastEvidenceAt ? Math.floor((now.getTime() - lot.lastEvidenceAt.getTime()) / 86_400_000) : null,
    links: { item: links.item(lot.id) },
  };
}

export type CompactLot = { lot_id: string; name: string; location: string; quantity_text: string; expiry_text: string; urgency: Urgency | null; link: string };

export function compactLot(v: LotView): CompactLot {
  return { lot_id: v.lot_id, name: v.food.name, location: v.location, quantity_text: v.quantity_text, expiry_text: v.expiry_text, urgency: v.urgency, link: v.links.item };
}
```

- [ ] **Step 5: Implement** `apps/server/src/services/inventory.ts`

```ts
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
    .select({ proposal: proposals, payload: observations.payload })
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
  if (input.location) views = views.filter((v) => v.location === input.location);
  const byLocation: Record<string, LotView[]> = {};
  for (const v of [...views].sort((a, b) => a.food.name.localeCompare(b.food.name))) (byLocation[v.location] ??= []).push(v);
  const locations = [...new Set([...DEFAULT_LOCATIONS, ...views.map((v) => v.location)])];
  return { today, use_soon: bucket(views), by_location: byLocation, locations };
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
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -w apps/server -- inventory && npm run typecheck`
Expected: 7 pass.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "feat: household summary, inventory search, item evidence and history"
```

---

### Task 14: Phase 1 MCP tools

**Files:**
- Create: `apps/server/src/mcp/tools/inventory.ts`, `apps/server/src/mcp/tools/observations.ts`, `apps/server/src/mcp/tools/foods.ts`
- Modify: `apps/server/src/services/foods.ts` (`upsertFood`), `apps/server/src/services/changes.ts` (undo for `update_food`), `apps/server/src/mcp/server.ts`
- Test: `apps/server/test/mcp-receipt-flow.test.ts`, `apps/server/test/foods.test.ts`

**Interfaces:**
- Consumes: every service above.
- Produces: MCP tools `get_household_summary`, `search_inventory`, `get_item`, `submit_observation`, `resolve_proposal`, `undo`, `upsert_food` (plus `whoami`). Also `UpsertFoodInputSchema`, `upsertFood(deps, p, input)`.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/foods.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { foods } from '../src/db/schema';
import { undoChangeSet } from '../src/services/changes';
import { upsertFood, UpsertFoodInputSchema } from '../src/services/foods';
import { resetDb, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';

const db = testDb();

describe('upsertFood', () => {
  beforeEach(() => resetDb());

  it('creates a food with user-provided shelf life and aliases', async () => {
    const { principal } = await seedUser(db);
    const r = await upsertFood(testDeps(), principal, UpsertFoodInputSchema.parse({ name: 'Oat milk', perishability: 'shelf_stable', shelf_life_days: { opened: 7 }, aliases: ['OATLY 64OZ'], idempotency_key: 'food-0001' }));
    expect(r.created).toBe(true);
    expect(r.food).toMatchObject({ aliases: ['oatly 64oz'], shelf_life: { opened: { days: 7, source: 'user', confidence: 'high' } } });
  });

  it('updates an existing food by name and can be undone', async () => {
    const { principal } = await seedUser(db);
    const deps = testDeps();
    await upsertFood(deps, principal, UpsertFoodInputSchema.parse({ name: 'Oat milk', perishability: 'shelf_stable', idempotency_key: 'food-0002' }));
    const upd = await upsertFood(deps, principal, UpsertFoodInputSchema.parse({ name: 'oat milk', is_staple: true, default_location: 'pantry', idempotency_key: 'food-0003' }));
    expect(upd).toMatchObject({ created: false, food: { is_staple: true, default_location: 'pantry' } });
    await undoChangeSet(db, principal, { change_set_id: upd.change_set_id, idempotency_key: 'undo-food-1' });
    const [f] = await db.select().from(foods).where(eq(foods.normalizedName, 'oat milk'));
    expect(f).toMatchObject({ isStaple: false, defaultLocation: null });
  });
});
```

`apps/server/test/mcp-receipt-flow.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPat } from '../src/identity/tokens';
import { resetDb, testDb } from './helpers/db';
import { callTool, mcpClient, seedUser, startServer, testDeps } from './helpers/app';
import { fixtureReceipt } from './fixtures/receipts';

describe('MCP receipt flow', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    await resetDb();
    server = await startServer(testDeps());
  });
  afterEach(() => server.close());

  it('lists the Phase 1 tools', async () => {
    const { token } = await seedUser(testDb());
    const client = await mcpClient(server.url, token);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_household_summary', 'get_item', 'resolve_proposal', 'search_inventory', 'submit_observation', 'undo', 'upsert_food', 'whoami']);
    expect(client.getInstructions()).toContain('get_household_summary');
    await client.close();
  });

  it('receipt → review → apply → recover from a fresh connection → undo', async () => {
    const db = testDb();
    const { token, principal } = await seedUser(db, 'alex@example.com', 'Claude iOS');
    const phone = await mcpClient(server.url, token);

    const sub = await callTool(phone, 'submit_observation', { kind: 'receipt', payload: fixtureReceipt('warehouse'), idempotency_key: 'mcp-rcpt-1' });
    expect(sub.review_url).toMatch(/^https:\/\/buttery\.test\/review\//);
    const applied = await callTool(phone, 'resolve_proposal', { proposal_id: sub.proposal_id, accept_remaining: true, apply: true, idempotency_key: 'mcp-apply-1' });
    expect(applied.created_lot_ids).toHaveLength(6);
    await phone.close();

    // A different client (e.g. Codex) with no conversation history recovers state from the summary alone.
    const codexToken = (await createPat(db, { userId: principal.userId, householdId: principal.householdId, clientName: 'Codex' })).token;
    const codex = await mcpClient(server.url, codexToken);
    const summary = await callTool(codex, 'get_household_summary');
    expect(summary.counts.active_items).toBe(6);
    expect(summary.recent_changes[0]).toMatchObject({ via: 'Claude iOS', label: expect.stringContaining('PANTRY CLUB') });
    const expiring = await callTool(codex, 'search_inventory', { expiring_within_days: 14 });
    expect(expiring.items.map((i: { food: { name: string } }) => i.food.name)).toContain('Chicken breast');
    const item = await callTool(codex, 'get_item', { lot_id: expiring.items[0].lot_id });
    expect(item.evidence[0].kind).toBe('receipt');

    const undone = await callTool(codex, 'undo', { change_set_id: applied.applied_change_set_id, idempotency_key: 'mcp-undo-1' });
    expect(undone.lots_voided).toBe(6);
    expect((await callTool(codex, 'get_household_summary')).counts.active_items).toBe(0);
    await codex.close();
  });

  it('returns structured errors', async () => {
    const db = testDb();
    const a = await seedUser(db, 'a@example.com');
    const b = await seedUser(db, 'b@example.com');
    const ca = await mcpClient(server.url, a.token);
    const sub = await callTool(ca, 'submit_observation', { kind: 'receipt', payload: fixtureReceipt('mixed'), idempotency_key: 'mcp-rcpt-2' });
    const cb = await mcpClient(server.url, b.token);
    await expect(callTool(cb, 'resolve_proposal', { proposal_id: sub.proposal_id, accept_remaining: true, idempotency_key: 'mcp-apply-2' })).rejects.toThrow(/not_found/);
    await expect(callTool(ca, 'submit_observation', { kind: 'receipt', payload: { store: 'x', purchased_at: 'bad', lines: [] }, idempotency_key: 'mcp-rcpt-3' })).rejects.toThrow();
    await ca.close();
    await cb.close();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w apps/server -- mcp-receipt-flow foods`
Expected: FAIL.

- [ ] **Step 3: Add `upsertFood`** (append to `apps/server/src/services/foods.ts`)

```ts
import { z } from 'zod';
import { IdempotencyKeySchema, LotStateSchema, normalizeName, PerishabilitySchema, type ShelfLifeMap } from '@buttery/domain';
import type { Db } from '../db/client';
import type { AppDeps } from '../http/app';
import type { Principal } from '../identity/principal';
import { notFound } from '../errors';
import { createOrReuseFood, openChangeSet, recordChange } from './changes';
import { runIdempotent } from './idempotency';

export const UpsertFoodInputSchema = z.object({
  food_id: z.uuid().optional().describe('Update this food; otherwise matched by name or created'),
  name: z.string().min(1).max(100),
  aliases: z.array(z.string().min(1).max(200)).max(50).optional().describe('Receipt spellings to recognize, e.g. "KS ORG EGGS 24CT"'),
  category: z.string().max(40).optional(),
  perishability: PerishabilitySchema.optional(),
  shelf_life_days: z.partialRecord(LotStateSchema, z.number().int().min(0).max(3650).nullable()).optional().describe('User-known shelf life per state; null = no meaningful expiry'),
  default_location: z.string().max(40).optional(),
  is_staple: z.boolean().optional().describe('Assumed on hand unless marked out'),
  idempotency_key: IdempotencyKeySchema,
});
export type UpsertFoodInput = z.infer<typeof UpsertFoodInputSchema>;

function foodView(f: FoodRow) {
  return { id: f.id, name: f.name, aliases: f.aliases, category: f.category, perishability: f.perishability, shelf_life: f.shelfLife, default_location: f.defaultLocation, is_staple: f.isStaple };
}

export async function upsertFood(deps: Pick<AppDeps, 'db'>, p: Principal, input: UpsertFoodInput) {
  const { idempotency_key, ...request } = input;
  return runIdempotent(deps.db as Db, { householdId: p.householdId, tool: 'upsert_food', key: idempotency_key, request }, async (tx) => {
    const userShelfLife: ShelfLifeMap = Object.fromEntries(
      Object.entries(input.shelf_life_days ?? {}).map(([state, days]) => [state, { days: days ?? null, confidence: 'high' as const, source: 'user' as const }]),
    );
    const [target] = input.food_id
      ? await tx.select().from(foods).where(and(eq(foods.id, input.food_id), eq(foods.householdId, p.householdId)))
      : await tx.select().from(foods).where(and(eq(foods.householdId, p.householdId), eq(foods.normalizedName, normalizeName(input.name))));
    if (input.food_id && !target) throw notFound('Food');
    const cs = await openChangeSet(tx, p, { label: `Food: ${input.name}`, idempotencyKey: idempotency_key });

    if (!target) {
      const { food } = await createOrReuseFood(tx, cs, {
        name: input.name,
        category: input.category ?? null,
        perishability: input.perishability ?? 'perishable',
        shelfLife: userShelfLife,
        defaultLocation: input.default_location ?? null,
        aliases: input.aliases,
      });
      const final = input.is_staple !== undefined ? (await tx.update(foods).set({ isStaple: input.is_staple }).where(eq(foods.id, food.id)).returning())[0]! : food;
      return { food: foodView(final), change_set_id: cs.id, created: true, notes: [] as string[] };
    }

    const aliases = [...new Set([...target.aliases, ...(input.aliases ?? []).map(normalizeName)])].filter((a) => a && a !== target.normalizedName);
    const [after] = await tx
      .update(foods)
      .set({
        ...(input.food_id ? { name: input.name.trim(), normalizedName: normalizeName(input.name) } : {}),
        aliases,
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.perishability ? { perishability: input.perishability } : {}),
        shelfLife: { ...target.shelfLife, ...userShelfLife },
        ...(input.default_location !== undefined ? { defaultLocation: input.default_location } : {}),
        ...(input.is_staple !== undefined ? { isStaple: input.is_staple } : {}),
        archivedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(foods.id, target.id))
      .returning();
    await recordChange(tx, cs, { op: 'update_food', foodId: target.id, before: target, after });
    return { food: foodView(after!), change_set_id: cs.id, created: false, notes: ['Existing items keep their current expiry estimate.'] };
  });
}
```

(Merge these imports with the existing ones at the top of the file: `and`, `eq`, `isNull` from drizzle; `foods`, `FoodRow` from the schema.)

- [ ] **Step 4: Support undo of `update_food`** (add a case to `revertChange` in `apps/server/src/services/changes.ts`)

```ts
    case 'update_food': {
      const before = r.before as FoodRow & { createdAt: string; updatedAt: string; archivedAt: string | null };
      const [current] = await tx.select().from(foods).where(eq(foods.id, r.foodId!));
      const [restored] = await tx
        .update(foods)
        .set({
          name: before.name,
          normalizedName: before.normalizedName,
          aliases: before.aliases,
          category: before.category,
          perishability: before.perishability,
          shelfLife: before.shelfLife,
          defaultLocation: before.defaultLocation,
          isStaple: before.isStaple,
          archivedAt: before.archivedAt ? new Date(before.archivedAt) : null,
          updatedAt: new Date(),
        })
        .where(eq(foods.id, r.foodId!))
        .returning();
      await recordChange(tx, cs, { op: 'restore_food', foodId: r.foodId, before: current, after: restored });
      return;
    }
```

- [ ] **Step 5: Implement the tools**

`apps/server/src/mcp/tools/inventory.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../../http/app';
import type { Principal } from '../../identity/principal';
import { getHouseholdSummary, getItem, searchInventory, SearchInventoryInputSchema } from '../../services/inventory';
import { withErrors } from '../respond';

export function registerInventoryTools(server: McpServer, deps: AppDeps, p: Principal) {
  server.registerTool(
    'get_household_summary',
    {
      title: 'Household summary',
      description:
        'START HERE in every new conversation. Compact current state from the authoritative records: items on hand by location, what to use soon (expired / urgent ≤2 days / soon ≤7 days, with printed vs estimated dates), what needs review (with review links), recent changes (with change_set_id for undo) and links to the web views.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    withErrors(async () => getHouseholdSummary(deps, p)),
  );

  server.registerTool(
    'search_inventory',
    {
      title: 'Search inventory',
      description: 'Find items on hand by name, location, perishability or expiry window. Each item includes quantity (with "~" if approximate), expiry text ("est." = estimate, "exp" = printed) and a link.',
      inputSchema: SearchInventoryInputSchema.shape,
      annotations: { readOnlyHint: true },
    },
    withErrors(async (args) => searchInventory(deps, p, SearchInventoryInputSchema.parse(args))),
  );

  server.registerTool(
    'get_item',
    {
      title: 'Item detail',
      description: 'Everything about one item: the current belief, the evidence behind it (e.g. the receipt line), how its expiry was estimated and by which model, and its change history.',
      inputSchema: { lot_id: z.uuid() },
      annotations: { readOnlyHint: true },
    },
    withErrors(async (args: { lot_id: string }) => getItem(deps, p, args.lot_id)),
  );
}
```

`apps/server/src/mcp/tools/observations.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { IdempotencyKeySchema } from '@buttery/domain';
import type { AppDeps } from '../../http/app';
import type { Principal } from '../../identity/principal';
import { undoChangeSet } from '../../services/changes';
import { resolveProposal, ResolveProposalInputSchema } from '../../services/proposals';
import { submitReceipt, SubmitReceiptInputSchema } from '../../services/receipts';
import { withErrors } from '../respond';

export function registerObservationTools(server: McpServer, deps: AppDeps, p: Principal) {
  server.registerTool(
    'submit_observation',
    {
      title: 'Submit a receipt',
      description: [
        'Record a receipt the user shared (this version supports kind "receipt").',
        'Transcribe EVERY printed line in order into payload.lines[].raw_text exactly as printed, including coupons, returns and non-food lines (tag them with line_kind).',
        'Put the bought quantity in quantity (e.g. 4 for "4 @ 0.99", 1.25 with unit "lb" for weighed produce), prices in cents, and printed package details in hint.package (e.g. "2X32 OZ" → {count: 2, size: 32, unit: "oz"}).',
        'Do not guess expiry dates or storage. The server canonicalizes items, matches existing inventory, estimates shelf life and builds a proposal.',
        'Nothing is added to inventory until the user reviews it: give the user the returned review_url.',
        'If the result has duplicate_of, the receipt was already recorded; say so and share the existing link.',
      ].join(' '),
      inputSchema: SubmitReceiptInputSchema.shape,
    },
    withErrors(async (args) => submitReceipt(deps, p, SubmitReceiptInputSchema.parse(args))),
  );

  server.registerTool(
    'resolve_proposal',
    {
      title: 'Resolve a proposal',
      description:
        'Apply the user\'s review decisions. Prefer sending the user the review_url; use this when the user gives decisions in chat (e.g. "looks good, add it all" → accept_remaining: true, apply: true). Edits can change a line\'s food, quantity, location or printed expiry date. Coupon, non-food and return lines never create inventory. The result includes undo.change_set_id.',
      inputSchema: ResolveProposalInputSchema.shape,
    },
    withErrors(async (args) => resolveProposal(deps, p, ResolveProposalInputSchema.parse(args))),
  );

  server.registerTool(
    'undo',
    {
      title: 'Undo a change set',
      description: 'Reverse a committed change set (e.g. an applied receipt) with compensating changes. History keeps both. Refuses if the items changed since.',
      inputSchema: { change_set_id: z.uuid(), idempotency_key: IdempotencyKeySchema },
      annotations: { destructiveHint: true },
    },
    withErrors(async (args: { change_set_id: string; idempotency_key: string }) => undoChangeSet(deps.db, p, args)),
  );
}
```

`apps/server/src/mcp/tools/foods.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../../http/app';
import type { Principal } from '../../identity/principal';
import { upsertFood, UpsertFoodInputSchema } from '../../services/foods';
import { withErrors } from '../respond';

export function registerFoodTools(server: McpServer, deps: AppDeps, p: Principal) {
  server.registerTool(
    'upsert_food',
    {
      title: 'Create or update a food',
      description: 'Teach the catalog about a food: receipt aliases, perishability (shelf_stable or perishable), known shelf life per state, default location, staple flag. Values from the user are recorded as source "user".',
      inputSchema: UpsertFoodInputSchema.shape,
    },
    withErrors(async (args) => upsertFood(deps, p, UpsertFoodInputSchema.parse(args))),
  );
}
```

Update `apps/server/src/mcp/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../http/app';
import type { Principal } from '../identity/principal';
import { MCP_INSTRUCTIONS } from './instructions';
import { registerFoodTools } from './tools/foods';
import { registerInventoryTools } from './tools/inventory';
import { registerObservationTools } from './tools/observations';
import { registerWhoami } from './tools/whoami';

export function buildMcpServer(deps: AppDeps, p: Principal): McpServer {
  const server = new McpServer({ name: 'buttery', version: '0.1.0' }, { instructions: MCP_INSTRUCTIONS });
  registerWhoami(server, deps, p);
  registerInventoryTools(server, deps, p);
  registerObservationTools(server, deps, p);
  registerFoodTools(server, deps, p);
  return server;
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -w apps/server && npm run typecheck`
Expected: all pass.

- [ ] **Step 7: Manual check in Claude Code**

Restart `npm run dev`. In Claude Code (connected in Task 4), attach `tests/fixtures/food-images/images/receipt-warehouse-clean.png` and say "I bought these groceries. Extract the purchases for review."
Expected: Claude calls `submit_observation` and returns a review link (the page arrives in Task 16). Then "looks good, add everything" leads to `resolve_proposal`. A new Claude Code session asked "what's expiring this week?" answers from `get_household_summary`.

- [ ] **Step 8: Commit**

```bash
git add apps/server
git commit -m "feat: Phase 1 MCP tools (summary, search, item, submit receipt, resolve, undo, upsert food)"
```

---

### Task 15: Web session and JSON API

**Files:**
- Create: `apps/server/src/identity/webConnection.ts`, `apps/server/src/auth/session.ts`, `apps/server/src/http/authRoutes.ts`, `apps/server/src/http/apiRoutes.ts`
- Modify: `apps/server/src/http/app.ts`
- Test: `apps/server/test/api.test.ts`

**Interfaces:**
- Consumes: `resolvePat`, services, `AppError`.
- Produces:
  - `ensureWebConnection(db, userId, householdId): Promise<string>`
  - `readSession(c, secret)`, `writeSession(c, config, data)`, `clearSession(c)`, `principalFromSession(db, s)`
  - Routes:
    - `POST /auth/token-login {token, next?}` → `{ok, next}`
    - `POST /auth/logout`
    - `GET /auth/config` → `{authkit: boolean}`
    - `GET /api/me`
    - `GET /api/proposals/:id`
    - `POST /api/proposals/:id/resolve`
    - `GET /api/inventory?location=`
    - `GET /api/items/:lotId`
    - `POST /api/change-sets/:id/undo`
    - `GET /api/foods?q=`
  - `AppDeps.authkit?` (placeholder type `{ loginUrl(next: string): string } | null`; Task 19 fills it in)

- [ ] **Step 1: Write the failing test** `apps/server/test/api.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app';
import { submitReceipt } from '../src/services/receipts';
import { resetDb, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';
import { fixtureReceipt } from './fixtures/receipts';

async function login(app: ReturnType<typeof createApp>, token: string) {
  const res = await app.request('/auth/token-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, next: '/review/x' }) });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, next: '/review/x' });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

describe('web API', () => {
  beforeEach(() => resetDb());
  const db = testDb();

  it('requires a session', async () => {
    const res = await createApp(testDeps()).request('/api/me');
    expect(res.status).toBe(401);
  });

  it('rejects a bad token and unsafe redirects', async () => {
    const app = createApp(testDeps());
    const bad = await app.request('/auth/token-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'btr_nope' }) });
    expect(bad.status).toBe(401);
    const { token } = await seedUser(db);
    const ok = await app.request('/auth/token-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, next: '//evil.example' }) });
    expect((await ok.json()).next).toBe('/inventory');
  });

  it('reviews and applies a receipt through the API', async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const { token, principal } = await seedUser(db);
    const cookie = await login(app, token);
    const r = await submitReceipt(deps, principal, { kind: 'receipt', payload: fixtureReceipt('warehouse'), idempotency_key: 'api-rcpt-1' });

    const view = await (await app.request(`/api/proposals/${r.proposal_id}`, { headers: { cookie } })).json();
    expect(view.ops).toHaveLength(6);

    const nonJson = await app.request(`/api/proposals/${r.proposal_id}/resolve`, { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{}' });
    expect(nonJson.status).toBe(415);

    const res = await app.request(`/api/proposals/${r.proposal_id}/resolve`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ decisions: [], accept_remaining: true, apply: true, idempotency_key: 'api-apply-1' }),
    });
    const applied = await res.json();
    expect(applied.created_lot_ids).toHaveLength(6);

    const inv = await (await app.request('/api/inventory', { headers: { cookie } })).json();
    expect(inv.by_location.fridge).toHaveLength(6);
    const item = await (await app.request(`/api/items/${applied.created_lot_ids[0]}`, { headers: { cookie } })).json();
    expect(item.history[0].op).toBe('add_lot');

    const undo = await app.request(`/api/change-sets/${applied.applied_change_set_id}/undo`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ idempotency_key: 'api-undo-1' }),
    });
    expect((await undo.json()).lots_voided).toBe(6);
  });

  it('attributes web actions to a Web connection', async () => {
    const app = createApp(testDeps());
    const { token } = await seedUser(db, 'alex@example.com', 'Claude Code');
    const cookie = await login(app, token);
    const me = await (await app.request('/api/me', { headers: { cookie } })).json();
    expect(me.connection.client_name).toBe('Web');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w apps/server -- api`
Expected: FAIL.

- [ ] **Step 3: Implement the session pieces**

`apps/server/src/identity/webConnection.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { connections } from '../db/schema';

export async function ensureWebConnection(db: Db, userId: string, householdId: string): Promise<string> {
  const [existing] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.householdId, householdId), eq(connections.kind, 'web'), isNull(connections.revokedAt)))
    .limit(1);
  if (existing) return existing.id;
  const [row] = await db.insert(connections).values({ userId, householdId, kind: 'web', clientName: 'Web' }).returning({ id: connections.id });
  return row!.id;
}
```

`apps/server/src/auth/session.ts`:

```ts
import type { Context } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { and, eq, isNull } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { connections } from '../db/schema';
import type { Principal } from '../identity/principal';

const COOKIE = 'btr_session';
export type SessionData = { u: string; h: string; c: string };

export async function readSession(c: Context, secret: string): Promise<SessionData | null> {
  const raw = await getSignedCookie(c, secret, COOKIE);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<SessionData>;
    return s.u && s.h && s.c ? (s as SessionData) : null;
  } catch {
    return null;
  }
}

export async function writeSession(c: Context, config: Config, s: SessionData): Promise<void> {
  await setSignedCookie(c, COOKIE, JSON.stringify(s), config.SESSION_SECRET, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.PUBLIC_BASE_URL.startsWith('https://'),
    path: '/',
    maxAge: 60 * 60 * 24 * 90,
  });
}

export function clearSession(c: Context): void {
  deleteCookie(c, COOKIE, { path: '/' });
}

export async function principalFromSession(db: Db, s: SessionData): Promise<Principal | null> {
  const [conn] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, s.c), eq(connections.userId, s.u), eq(connections.householdId, s.h), isNull(connections.revokedAt)))
    .limit(1);
  return conn ? { userId: conn.userId, householdId: conn.householdId, connectionId: conn.id, clientName: conn.clientName } : null;
}

export function safeNext(next: unknown): string {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/inventory';
}
```

- [ ] **Step 4: Implement the routes**

`apps/server/src/http/authRoutes.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { clearSession, safeNext, writeSession } from '../auth/session';
import { AppError } from '../errors';
import { resolvePat } from '../identity/tokens';
import { ensureWebConnection } from '../identity/webConnection';
import type { AppDeps } from './app';

const TokenLoginSchema = z.object({ token: z.string().min(1).max(200), next: z.string().max(500).optional() });

export function requireJson(contentType: string | undefined): void {
  if (!(contentType ?? '').includes('application/json')) throw new AppError('unsupported_media_type', 'Send JSON', 415);
}

export function authRoutes(deps: AppDeps) {
  const app = new Hono();
  app.get('/config', (c) => c.json({ authkit: Boolean(deps.authkit) }));
  app.post('/token-login', async (c) => {
    requireJson(c.req.header('content-type'));
    const body = TokenLoginSchema.parse(await c.req.json());
    const pat = await resolvePat(deps.db, body.token.trim());
    if (!pat) throw new AppError('invalid_token', 'That token is not valid.', 401);
    const connectionId = await ensureWebConnection(deps.db, pat.userId, pat.householdId);
    await writeSession(c, deps.config, { u: pat.userId, h: pat.householdId, c: connectionId });
    return c.json({ ok: true, next: safeNext(body.next) });
  });
  app.post('/logout', (c) => {
    clearSession(c);
    return c.json({ ok: true });
  });
  return app;
}
```

`apps/server/src/http/apiRoutes.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { IdempotencyKeySchema, shortlist } from '@buttery/domain';
import { principalFromSession, readSession } from '../auth/session';
import { AppError } from '../errors';
import type { Principal } from '../identity/principal';
import { undoChangeSet } from '../services/changes';
import { loadCatalog } from '../services/foods';
import { getWhoami } from '../services/identity';
import { getInventoryPage, getItem } from '../services/inventory';
import { getProposalView, resolveProposal, ResolveProposalInputSchema } from '../services/proposals';
import type { AppDeps } from './app';
import { requireJson } from './authRoutes';

export function apiRoutes(deps: AppDeps) {
  const api = new Hono<{ Variables: { principal: Principal } }>();

  api.use('*', async (c, next) => {
    if (c.req.method !== 'GET') requireJson(c.req.header('content-type'));
    const s = await readSession(c, deps.config.SESSION_SECRET);
    const p = s ? await principalFromSession(deps.db, s) : null;
    if (!p) throw new AppError('unauthorized', 'Sign in required', 401);
    c.set('principal', p);
    await next();
  });

  api.get('/me', async (c) => c.json(await getWhoami(deps.db, c.get('principal'), deps.config)));

  api.get('/proposals/:id', async (c) => c.json(await getProposalView(deps, c.get('principal'), z.uuid().parse(c.req.param('id')))));

  api.post('/proposals/:id/resolve', async (c) => {
    const input = ResolveProposalInputSchema.parse({ ...(await c.req.json()), proposal_id: c.req.param('id') });
    return c.json(await resolveProposal(deps, c.get('principal'), input));
  });

  api.get('/inventory', async (c) => c.json(await getInventoryPage(deps, c.get('principal'), { location: c.req.query('location') || undefined })));

  api.get('/items/:id', async (c) => c.json(await getItem(deps, c.get('principal'), z.uuid().parse(c.req.param('id')))));

  api.post('/change-sets/:id/undo', async (c) => {
    const { idempotency_key } = z.object({ idempotency_key: IdempotencyKeySchema }).parse(await c.req.json());
    return c.json(await undoChangeSet(deps.db, c.get('principal'), { change_set_id: z.uuid().parse(c.req.param('id')), idempotency_key }));
  });

  api.get('/foods', async (c) => {
    const foods = await loadCatalog(deps.db, c.get('principal').householdId);
    const q = c.req.query('q');
    const list = q ? shortlist(q, foods, 20, 0.1) : foods.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ foods: list.map((f) => ({ food_id: f.id, name: f.name, category: f.category, perishability: f.perishability })) });
  });

  return api;
}
```

In `apps/server/src/http/app.ts`, add to `AppDeps` and register the routes (after `/mcp`):

```ts
export type AppDeps = {
  config: Config;
  db: Db;
  reasoning: ReasoningPort;
  resolveBearer?: BearerResolver;
  authkit?: { loginUrl(next: string): string } | null;
};
// inside createApp, after app.route('/mcp', ...):
app.route('/auth', authRoutes(deps));
app.route('/api', apiRoutes(deps));
```

with imports `import { authRoutes } from './authRoutes';` and `import { apiRoutes } from './apiRoutes';`.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -w apps/server && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat: token login sessions and JSON API for review, inventory, items and undo"
```

---

### Task 16: React app: login and receipt review, served by the server, e2e on a phone viewport

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/api.ts`, `apps/web/src/types.ts`, `apps/web/src/useLoad.ts`, `apps/web/src/format.ts`, `apps/web/src/styles.css`, `apps/web/src/components/Layout.tsx`, `apps/web/src/components/Badges.tsx`, `apps/web/src/components/ErrorBox.tsx`, `apps/web/src/components/OpCard.tsx`, `apps/web/src/pages/Login.tsx`, `apps/web/src/pages/Review.tsx`, `apps/server/src/http/web.ts`, `apps/server/test/e2e-seed.ts`, `tests/e2e/helpers.ts`, `tests/e2e/01-review.spec.ts`
- Modify: `apps/server/src/http/app.ts` (mount the web UI last), `apps/server/package.json` (`e2e:server` script), `playwright.config.js`, `.gitignore`
- Test: `apps/server/test/web.test.ts`, `tests/e2e/01-review.spec.ts`

**Interfaces:**
- Consumes: the Task 15 API routes and response shapes (`ProposalView`, `OpView`, resolve result, `UndoResult`).
- Produces:
  - SPA routes `/login`, `/review/:proposalId`. Task 17 adds `/inventory` and `/items/:lotId`.
  - `mountWeb(app, config)`
  - Web modules `api`, `newKey()`, `ApiError`, `useLoad(fn, deps)`, `ExpiryBadge`, `ConfidenceBadge`, `ErrorBox`, `money(cents)`, `cap(s)`, `when(iso)`

- [ ] **Step 1: Scaffold the web package**

Run: `npm i -w apps/web react react-dom react-router && npm i -D -w apps/web vite @vitejs/plugin-react typescript @types/react @types/react-dom` (create `apps/web/package.json` first, as below).

`apps/web/package.json`:

```json
{
  "name": "@buttery/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc -p tsconfig.json"
  }
}
```

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

`apps/web/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8790', '/auth': 'http://localhost:8790' },
  },
});
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#faf6ee" />
    <title>Buttery</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Write shared web modules**

`apps/web/src/types.ts`:

```ts
export type Confidence = 'high' | 'medium' | 'low';
export type Urgency = 'expired' | 'urgent' | 'soon' | 'later';
export type Quantity = { kind: 'exact' | 'approx' | 'unknown'; amount?: number; unit?: string };
export type Expiry = { on: string; kind: 'printed' | 'estimated'; confidence: Confidence; basis: string };

export type OpView = {
  op_id: string;
  seq: number;
  op: 'add_lot' | 'ignore_line';
  decision: 'pending' | 'accepted' | 'edited' | 'rejected' | 'conflict';
  applied: boolean;
  confidence: Confidence;
  rationale: string | null;
  line: { line_id: string; raw_text: string; detail?: string; quantity?: number; unit?: string; price_cents?: number };
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
    quantity_text: string;
    printed_expiry_on: string | null;
    expires_preview: Expiry | null;
    expiry_text: string;
  } | null;
};

export type ProposalView = {
  proposal: { id: string; status: string; created_at: string };
  observation: { id: string; kind: string; store: string | null; purchased_at: string | null; recorded_at: string; recorded_by: string | null; via: string | null };
  ops: OpView[];
  counts: { lines: number; items: number; pending: number; applied: number; low_confidence: number };
  links: { review: string; inventory: string };
};

export type ResolveResponse = ProposalView & { applied_change_set_id: string | null; created_lot_ids: string[]; notes: string[] };

export type Edits = {
  food_id?: string;
  new_food?: { name: string };
  quantity?: Quantity;
  location?: string;
  expires_on?: string | null;
};
export type Decision = { op_id: string; action: 'accept' | 'reject' } | { op_id: string; action: 'edit'; edits: Edits };

export type LotView = {
  lot_id: string;
  food: { id: string; name: string; category: string | null; perishability: 'shelf_stable' | 'perishable' };
  location: string;
  state: string;
  status: string;
  quantity_text: string;
  expires: Expiry | null;
  expiry_text: string;
  urgency: Urgency | null;
  acquired_on: string | null;
  evidence_age_days: number | null;
};

export type InventoryResponse = {
  today: string;
  use_soon: { expired: LotView[]; urgent: LotView[]; soon: LotView[] };
  by_location: Record<string, LotView[]>;
  locations: string[];
};

export type ItemResponse = {
  lot: LotView;
  food: { id: string; name: string; aliases: string[]; perishability: string };
  evidence: Array<{ observation_id: string; kind: string; summary: string; line: string | null; price_cents: number | null; review_url: string | null }>;
  history: Array<{ change_set_id: string; label: string; op: string; at: string; by: string | null; via: string | null; undone: boolean; is_undo: boolean }>;
  reasoning: Array<{ call_id: string; function: string; provider: string; model: string | null; path: string }>;
};

export type UndoResponse = { reverted_change_set_id: string; label: string; lots_voided: number };
```

`apps/web/src/api.ts`:

```ts
import type { Decision, InventoryResponse, ItemResponse, ProposalView, ResolveResponse, UndoResponse } from './types';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach Buttery. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path.startsWith('/api/')) {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? res.statusText, data.details);
  return data as T;
}

export const newKey = () => crypto.randomUUID();

export const api = {
  authConfig: () => request<{ authkit: boolean }>('GET', '/auth/config'),
  tokenLogin: (token: string, next: string) => request<{ ok: true; next: string }>('POST', '/auth/token-login', { token, next }),
  proposal: (id: string) => request<ProposalView>('GET', `/api/proposals/${id}`),
  resolve: (id: string, body: { decisions: Decision[]; accept_remaining: boolean; apply: boolean; idempotency_key: string }) =>
    request<ResolveResponse>('POST', `/api/proposals/${id}/resolve`, body),
  inventory: (location?: string) => request<InventoryResponse>('GET', `/api/inventory${location ? `?location=${encodeURIComponent(location)}` : ''}`),
  item: (id: string) => request<ItemResponse>('GET', `/api/items/${id}`),
  undo: (changeSetId: string, key: string) => request<UndoResponse>('POST', `/api/change-sets/${changeSetId}/undo`, { idempotency_key: key }),
};
```

`apps/web/src/useLoad.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';

type State<T> = { data?: T; error?: ApiError; loading: boolean };

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<State<T>>({ loading: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => setState({ data, loading: false }),
      (error: unknown) => setState({ error: error instanceof ApiError ? error : new ApiError(0, 'error', String(error)), loading: false }),
    );
  }, deps);
  useEffect(reload, [reload]);
  return { ...state, reload, setData: (data: T) => setState({ data, loading: false }) };
}
```

`apps/web/src/format.ts`:

```ts
export const money = (cents: number) => `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const dateOnly = (d: string | null) => (d ? new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '');
```

`apps/web/src/components/Badges.tsx`:

```tsx
import type { Confidence, Urgency } from '../types';

export function ConfidenceBadge({ value }: { value: Confidence }) {
  return <span className={`badge conf-${value}`}>{value === 'low' ? 'Check this' : `${value} confidence`}</span>;
}

export function ExpiryBadge({ text, urgency, kind }: { text: string; urgency?: Urgency | null; kind?: 'printed' | 'estimated' }) {
  const title = kind === 'estimated' ? 'Estimated expiry' : kind === 'printed' ? 'Printed on the package' : undefined;
  return (
    <span className={`expiry ${urgency ?? ''}`} title={title}>
      {text}
    </span>
  );
}
```

`apps/web/src/components/ErrorBox.tsx`:

```tsx
import { ApiError } from '../api';

export function ErrorBox({ error }: { error: ApiError }) {
  const message = error.status === 404 ? 'This link does not match anything in your household.' : error.message;
  return (
    <div className="banner error" role="alert">
      {message}
    </div>
  );
}
```

`apps/web/src/components/Layout.tsx`:

```tsx
import { Link, NavLink, Outlet } from 'react-router';

export function Layout() {
  return (
    <>
      <header className="topbar">
        <Link to="/inventory" className="brand">
          Buttery
        </Link>
        <nav>
          <NavLink to="/inventory">Inventory</NavLink>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
}
```

- [ ] **Step 3: Write the review card** `apps/web/src/components/OpCard.tsx`

```tsx
import { useState, type FormEvent } from 'react';
import { money } from '../format';
import type { Edits, OpView, Quantity } from '../types';
import { ConfidenceBadge, ExpiryBadge } from './Badges';

export type Choice = { action: 'accept' } | { action: 'reject' } | { action: 'edit'; edits: Edits };

const LOCATIONS = ['fridge', 'freezer', 'pantry', 'counter'];
const UNITS = ['count', 'g', 'kg', 'oz', 'lb', 'ml', 'l', 'fl_oz', 'cup', 'qt', 'gal'];

function describe(q: Quantity): string {
  if (q.kind === 'unknown' || q.amount === undefined) return 'unknown amount';
  return `${q.kind === 'approx' ? '~' : ''}${q.amount}${q.unit && q.unit !== 'count' ? ` ${q.unit}` : ''}`;
}

export function OpCard({ op, choice, onChange }: { op: OpView; choice: Choice; onChange?: (c: Choice) => void }) {
  const [editing, setEditing] = useState(false);

  if (op.op === 'ignore_line' || !op.draft) {
    return (
      <li className="card muted-card" data-testid="op">
        <div className="raw">
          {op.line.raw_text}
          {op.line.price_cents !== undefined && <span>{money(op.line.price_cents)}</span>}
        </div>
        <div className="meta">{op.reason}</div>
      </li>
    );
  }

  const d = op.draft;
  const edits = choice.action === 'edit' ? choice.edits : {};
  const name = edits.new_food?.name ?? op.candidates.find((c) => c.food_id === edits.food_id)?.name ?? d.food_name;
  const skipped = choice.action === 'reject';

  return (
    <li className={`card${skipped ? ' skipped' : ''}`} data-testid="op">
      <div className="raw">
        {op.line.raw_text}
        {op.line.price_cents !== undefined && <span>{money(op.line.price_cents)}</span>}
      </div>
      <div className="title-row">
        <strong>{name}</strong>
        {d.is_new_food && !edits.food_id && <span className="badge">New item</span>}
        {op.confidence !== 'high' && !op.applied && <ConfidenceBadge value={op.confidence} />}
        {choice.action === 'edit' && !op.applied && <span className="badge">Edited</span>}
        {op.applied && <span className="badge ok">Added</span>}
        {skipped && <span className="badge">Skipped</span>}
      </div>
      <div className="meta">
        {edits.quantity ? describe(edits.quantity) : d.quantity_text} · {edits.location ?? d.location} ·{' '}
        {edits.expires_on ? <span>exp {edits.expires_on}</span> : <ExpiryBadge text={d.expiry_text} kind={d.expires_preview?.kind} />}
      </div>
      {!edits.expires_on && d.expires_preview?.kind === 'estimated' && <div className="muted small">{d.expires_preview.basis}</div>}
      {op.confidence === 'low' && op.rationale && !op.applied && <div className="hint">{op.rationale}</div>}

      {onChange && !op.applied && !editing && (
        <div className="actions">
          <button type="button" className={skipped ? '' : 'selected'} aria-pressed={!skipped} onClick={() => onChange(choice.action === 'edit' ? choice : { action: 'accept' })}>
            Add
          </button>
          <button type="button" className={skipped ? 'selected' : ''} aria-pressed={skipped} onClick={() => onChange({ action: 'reject' })}>
            Skip
          </button>
          <button type="button" onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
      )}
      {onChange && editing && (
        <EditForm
          op={op}
          initial={edits}
          onCancel={() => setEditing(false)}
          onSave={(e) => {
            onChange({ action: 'edit', edits: e });
            setEditing(false);
          }}
        />
      )}
    </li>
  );
}

function EditForm({ op, initial, onSave, onCancel }: { op: OpView; initial: Edits; onSave: (e: Edits) => void; onCancel: () => void }) {
  const d = op.draft!;
  const q = initial.quantity ?? d.quantity;
  const [foodId, setFoodId] = useState(initial.food_id ?? '');
  const [name, setName] = useState(initial.new_food?.name ?? d.food_name);
  const [amount, setAmount] = useState(q.amount?.toString() ?? '');
  const [unit, setUnit] = useState(q.unit ?? 'count');
  const [approx, setApprox] = useState(q.kind === 'approx');
  const [location, setLocation] = useState(initial.location ?? d.location);
  const [expires, setExpires] = useState(initial.expires_on ?? d.printed_expiry_on ?? '');

  function save(ev: FormEvent) {
    ev.preventDefault();
    const e: Edits = {};
    if (foodId) e.food_id = foodId;
    else if (name.trim() && name.trim() !== d.food_name) e.new_food = { name: name.trim() };
    e.quantity = amount === '' ? { kind: 'unknown' } : { kind: approx ? 'approx' : 'exact', amount: Number(amount), unit };
    if (location !== d.location) e.location = location;
    if (expires !== (d.printed_expiry_on ?? '')) e.expires_on = expires || null;
    onSave(e);
  }

  return (
    <form className="edit" onSubmit={save}>
      {op.candidates.length > 0 && (
        <label>
          Same as an existing item
          <select value={foodId} onChange={(e) => setFoodId(e.target.value)}>
            <option value="">No, keep as below</option>
            {op.candidates.map((c) => (
              <option key={c.food_id} value={c.food_id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {!foodId && (
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      <div className="row">
        <label>
          Amount
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="unknown" />
        </label>
        <label>
          Unit
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>
            {UNITS.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={approx} onChange={(e) => setApprox(e.target.checked)} /> Approximate
      </label>
      <label>
        Location
        <select value={location} onChange={(e) => setLocation(e.target.value)}>
          {[...new Set([...LOCATIONS, d.location])].map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </label>
      <label>
        Date printed on package (optional)
        <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
      </label>
      <div className="actions">
        <button type="submit" className="primary">
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Write the pages**

`apps/web/src/pages/Login.tsx`:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { api, ApiError } from '../api';

export function Login() {
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/inventory';
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [authkit, setAuthkit] = useState(false);

  useEffect(() => {
    api.authConfig().then((c) => setAuthkit(c.authkit), () => {});
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.tokenLogin(token, next);
      window.location.assign(r.next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <h1>Buttery</h1>
      <p className="muted">Sign in to review and correct your household's food.</p>
      {authkit && (
        <a className="button primary" href={`/auth/authkit?next=${encodeURIComponent(next)}`}>
          Continue with your account
        </a>
      )}
      <form onSubmit={submit}>
        <label>
          Access token
          <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="btr_…" required />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className={authkit ? '' : 'primary'} disabled={busy}>
          Sign in
        </button>
      </form>
      <p className="muted small">
        Create a token with <code>npm run token:create</code>.
      </p>
    </main>
  );
}
```

`apps/web/src/pages/Review.tsx`:

```tsx
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError, newKey } from '../api';
import { ErrorBox } from '../components/ErrorBox';
import { OpCard, type Choice } from '../components/OpCard';
import { dateOnly } from '../format';
import type { Decision, OpView, ResolveResponse } from '../types';
import { useLoad } from '../useLoad';

export function Review() {
  const { proposalId = '' } = useParams();
  const { data, error, loading, setData, reload } = useLoad(() => api.proposal(proposalId), [proposalId]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResolveResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const applyKey = useRef(newKey());
  const undoKey = useRef(newKey());

  if (loading && !data) return <p className="muted">Loading…</p>;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const choiceFor = (o: OpView): Choice => choices[o.op_id] ?? (o.decision === 'rejected' ? { action: 'reject' } : { action: 'accept' });
  const setChoice = (id: string) => (c: Choice) => {
    setChoices((prev) => ({ ...prev, [id]: c }));
    applyKey.current = newKey();
  };
  const open = data.ops.filter((o) => !o.applied);
  const lotOps = data.ops.filter((o) => o.op === 'add_lot');
  const needsLook = lotOps.filter((o) => !o.applied && o.confidence === 'low');
  const others = lotOps.filter((o) => !needsLook.includes(o));
  const ignored = data.ops.filter((o) => o.op === 'ignore_line');
  const adding = open.filter((o) => o.op === 'add_lot' && choiceFor(o).action !== 'reject').length;

  async function apply() {
    setBusy(true);
    setActionError(null);
    try {
      const decisions: Decision[] = open.map((o) => {
        const c = o.op === 'ignore_line' ? ({ action: 'accept' } as Choice) : choiceFor(o);
        return c.action === 'edit' ? { op_id: o.op_id, action: 'edit', edits: c.edits } : { op_id: o.op_id, action: c.action };
      });
      const res = await api.resolve(proposalId, { decisions, accept_remaining: false, apply: true, idempotency_key: applyKey.current });
      applyKey.current = newKey();
      setChoices({});
      setResult(res);
      setData(res);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (!result?.applied_change_set_id) return;
    setBusy(true);
    try {
      await api.undo(result.applied_change_set_id, undoKey.current);
      undoKey.current = newKey();
      setResult(null);
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not undo. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const card = (o: OpView) => <OpCard key={o.op_id} op={o} choice={choiceFor(o)} onChange={o.applied ? undefined : setChoice(o.op_id)} />;

  return (
    <div>
      <header>
        <p className="eyebrow">Receipt review</p>
        <h1>{data.observation.store ?? 'Receipt'}</h1>
        <p className="muted">
          {dateOnly(data.observation.purchased_at)} · shared by {data.observation.recorded_by ?? 'someone'}
          {data.observation.via ? ` via ${data.observation.via}` : ''}
        </p>
      </header>

      {result?.applied_change_set_id && (
        <div className="banner ok" role="status">
          <strong>
            Added {result.created_lot_ids.length} item{result.created_lot_ids.length === 1 ? '' : 's'}
          </strong>{' '}
          to inventory.{' '}
          <button className="link" onClick={undo} disabled={busy}>
            Undo
          </button>{' '}
          · <Link to="/inventory">View inventory</Link>
        </div>
      )}
      {!result && data.proposal.status === 'applied' && (
        <div className="banner ok">
          This receipt is done. <Link to="/inventory">View inventory</Link>
        </div>
      )}
      {actionError && (
        <div className="banner error" role="alert">
          {actionError}
        </div>
      )}

      {needsLook.length > 0 && (
        <section>
          <h2>Needs a look ({needsLook.length})</h2>
          <ul className="cards">{needsLook.map(card)}</ul>
        </section>
      )}
      {others.length > 0 && (
        <section>
          <h2>Items ({others.length})</h2>
          <ul className="cards">{others.map(card)}</ul>
        </section>
      )}
      {ignored.length > 0 && (
        <section>
          <h2>Not added to inventory</h2>
          <ul className="cards">{ignored.map(card)}</ul>
        </section>
      )}

      {open.length > 0 && (
        <div className="action-bar">
          <button className="primary" onClick={apply} disabled={busy}>
            {busy ? 'Saving…' : adding > 0 ? `Add ${adding} item${adding === 1 ? '' : 's'}` : 'Confirm'}
          </button>
        </div>
      )}
    </div>
  );
}
```

`apps/web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Review } from './pages/Review';
import './styles.css';

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Navigate to="/inventory" replace /> },
      { path: '/review/:proposalId', element: <Review /> },
      { path: '*', element: <p className="muted">Page not found.</p> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
```

- [ ] **Step 5: Write the styles** `apps/web/src/styles.css`

```css
:root {
  --bg: #faf6ee; --surface: #ffffff; --soft: #f3ecdc; --text: #2b2419; --muted: #7a6f5f; --border: #e7dfcf;
  --accent: #c8901a; --accent-ink: #ffffff; --ok: #2f7d4f; --warn: #a45f00; --danger: #b3261e;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1b1813; --surface: #26221b; --soft: #2f2a21; --text: #f1ebdf; --muted: #b0a590; --border: #3a342a;
    --accent: #e0a93a; --accent-ink: #1b1813; --ok: #6cc18e; --warn: #f0a646; --danger: #ff8a80;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; -webkit-text-size-adjust: 100%; }
main { max-width: 640px; margin: 0 auto; padding: 16px 16px 120px; }
.topbar { position: sticky; top: 0; z-index: 5; display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: var(--bg); border-bottom: 1px solid var(--border); }
.brand { font-weight: 700; color: var(--text); text-decoration: none; }
nav a { color: var(--muted); text-decoration: none; margin-left: 16px; }
nav a.active { color: var(--text); font-weight: 600; }
h1 { font-size: 1.5rem; margin: 4px 0; }
h2 { font-size: 0.8rem; margin: 24px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
.eyebrow { margin: 0; color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; }
.muted { color: var(--muted); }
.small { font-size: 0.85rem; }
ul.cards { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }
.card.skipped { opacity: 0.55; }
.muted-card { background: var(--soft); }
.raw { font: 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); display: flex; justify-content: space-between; gap: 8px; overflow-wrap: anywhere; }
.title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 4px; }
.meta { color: var(--muted); font-size: 0.9rem; margin-top: 2px; overflow-wrap: anywhere; }
.hint { font-size: 0.85rem; color: var(--warn); margin-top: 4px; }
.badge { font-size: 0.72rem; padding: 2px 8px; border-radius: 999px; background: var(--soft); border: 1px solid var(--border); white-space: nowrap; }
.badge.ok { color: var(--ok); border-color: var(--ok); }
.conf-low { color: var(--warn); border-color: var(--warn); }
.expiry.expired { color: var(--danger); font-weight: 600; }
.expiry.urgent { color: var(--warn); font-weight: 600; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
button, .button { font: inherit; min-height: 40px; padding: 8px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
button.selected { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
button.primary, .button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
button:disabled { opacity: 0.6; cursor: default; }
button.link { border: none; background: none; padding: 0; min-height: auto; color: inherit; text-decoration: underline; }
.action-bar { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); background: linear-gradient(transparent, var(--bg) 30%); display: flex; justify-content: center; }
.action-bar button { width: 100%; max-width: 608px; min-height: 48px; }
.banner { border-radius: 12px; padding: 12px 14px; margin: 12px 0; border: 1px solid var(--border); background: var(--surface); }
.banner.ok { border-color: var(--ok); }
.banner.error, .error { color: var(--danger); }
.banner.error { border-color: var(--danger); }
form.edit { display: grid; gap: 10px; margin-top: 10px; }
label { display: grid; gap: 4px; font-size: 0.85rem; color: var(--muted); }
input, select { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; min-height: 40px; width: 100%; }
.row { display: flex; gap: 8px; }
.row > * { flex: 1; min-width: 0; }
.check { display: flex; align-items: center; gap: 8px; }
.check input { width: auto; min-height: auto; }
.login { max-width: 420px; }
.login form { display: grid; gap: 12px; margin-top: 16px; }
.chips { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; }
.chips a { white-space: nowrap; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border); color: var(--text); text-decoration: none; font-size: 0.9rem; }
.chips a.active { background: var(--text); color: var(--bg); }
.lot { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; color: inherit; text-decoration: none; }
.lot .right { text-align: right; white-space: nowrap; font-size: 0.9rem; }
dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
```

- [ ] **Step 6: Serve the SPA from the server**

`apps/server/src/http/web.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Config } from '../config';

const RESERVED = ['/api', '/auth/', '/mcp', '/.well-known', '/healthz'];

export function mountWeb(app: Hono, config: Config): void {
  const dist = config.WEB_DIST_DIR ?? fileURLToPath(new URL('../../../web/dist', import.meta.url));
  const indexPath = path.join(dist, 'index.html');
  if (!existsSync(indexPath)) {
    app.get('/', (c) => c.text('Web UI not built. Run: npm run build -w apps/web'));
    return;
  }
  const indexHtml = readFileSync(indexPath, 'utf8');
  app.use('/assets/*', serveStatic({ root: path.relative(process.cwd(), dist) }));
  app.get('*', (c) => (RESERVED.some((r) => c.req.path.startsWith(r)) ? c.notFound() : c.html(indexHtml)));
}
```

In `createApp`, as the last line before `return app;`: `mountWeb(app, deps.config);` (import from `./web`).

- [ ] **Step 7: Write the server test for SPA serving** `apps/server/test/web.test.ts`

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { createApp } from '../src/http/app';
import { TEST_DB_URL } from './helpers/db';
import { testDeps } from './helpers/app';

describe('SPA serving', () => {
  const dist = mkdtempSync(path.join(tmpdir(), 'buttery-web-'));
  mkdirSync(path.join(dist, 'assets'));
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
  const app = createApp(testDeps({ config: loadConfig({ DATABASE_URL: TEST_DB_URL, SESSION_SECRET: 'x'.repeat(32), WEB_DIST_DIR: dist }) }));

  it('serves index.html for deep links', async () => {
    const res = await app.request('/review/123');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
  });

  it('serves assets and leaves API routes alone', async () => {
    expect(await (await app.request('/assets/app.js')).text()).toContain('console.log');
    expect((await app.request('/api/me')).status).toBe(401);
    expect((await app.request('/api/nope')).status).toBe(401);
  });
});
```

Run: `npm test -w apps/server -- web`
Expected: PASS.

- [ ] **Step 8: E2E seed and Playwright config**

`apps/server/test/e2e-seed.ts`. This is test infrastructure: it resets `buttery_e2e`, seeds a user, a fixed token and one pending receipt, using the deterministic fake reasoning:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { loadConfig } from '../src/config';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { connections } from '../src/db/schema';
import { provisionUser } from '../src/identity/provision';
import { hashToken } from '../src/identity/tokens';
import { submitReceipt } from '../src/services/receipts';
import { createFakeReasoning } from './helpers/fakeReasoning';
import { fixtureReceipt } from './fixtures/receipts';

const E2E_TOKEN = 'btr_e2e_token_for_local_tests_only_00';
const url = process.env.DATABASE_URL ?? '';
if (!url.includes('buttery_e2e')) throw new Error('e2e-seed only runs against the buttery_e2e database');

await runMigrations(url);
const db = createDb(url);
const tables = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
await db.execute(sql.raw(`truncate ${tables.map((t) => `"${t.tablename}"`).join(', ')} restart identity cascade`));

const u = await provisionUser(db, { email: 'e2e@example.com', displayName: 'Alex' });
const [conn] = await db
  .insert(connections)
  .values({ userId: u.userId, householdId: u.householdId, kind: 'pat', clientName: 'Claude iOS', tokenHash: hashToken(E2E_TOKEN), tokenPrefix: E2E_TOKEN.slice(0, 8) })
  .returning();
const principal = { userId: u.userId, householdId: u.householdId, connectionId: conn!.id, clientName: 'Claude iOS' };
const r = await submitReceipt({ db, config: loadConfig(), reasoning: createFakeReasoning() }, principal, {
  kind: 'receipt',
  payload: fixtureReceipt('warehouse'),
  idempotency_key: 'e2e-seed-warehouse',
});

const out = fileURLToPath(new URL('../.e2e/', import.meta.url));
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/state.json`, JSON.stringify({ token: E2E_TOKEN, proposal_id: r.proposal_id }));
await db.$client.end();
console.log('e2e seed ready');
```

Add to the `apps/server/package.json` scripts: `"e2e:server": "tsx test/e2e-seed.ts && tsx src/main.ts"`
Append `apps/server/.e2e/` to `.gitignore`.

Replace `playwright.config.js`:

```js
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  // One worker, files in name order: 01-review runs before 02-inventory against one seeded DB.
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:8791', trace: 'on-first-retry' },
  projects: [{ name: 'phone', use: { ...devices['Pixel 7'] } }],
  webServer: {
    command: 'npm run build -w apps/web && npm run e2e:server -w apps/server',
    url: 'http://127.0.0.1:8791/healthz',
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      DATABASE_URL: 'postgres://buttery:buttery@localhost:5433/buttery_e2e',
      PORT: '8791',
      PUBLIC_BASE_URL: 'http://127.0.0.1:8791',
      SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret-1234',
    },
  },
});
```

(The old `tests/smoke.spec.js` is outside `testDir` and no longer runs. Delete it in this commit if you like; it only checked that Playwright works.)

- [ ] **Step 9: Write the e2e test**

`tests/e2e/helpers.ts`:

```ts
import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

export const state = () => JSON.parse(readFileSync('apps/server/.e2e/state.json', 'utf8')) as { token: string; proposal_id: string };

export async function signIn(page: Page) {
  const res = await page.request.post('/auth/token-login', { data: { token: state().token } });
  expect(res.ok()).toBe(true);
}

export async function expectNoHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
```

`tests/e2e/01-review.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, signIn, state } from './helpers';

test.describe.serial('receipt review on a phone', () => {
  test('a review link asks for sign-in, then opens the receipt', async ({ page }) => {
    const { token, proposal_id } = state();
    await page.goto(`/review/${proposal_id}`);
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByLabel('Access token').fill(token);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'PANTRY CLUB' })).toBeVisible();
    await expect(page.getByText('GRK YOGURT 2X32 OZ')).toBeVisible();
    await expect(page.getByText('shared by Alex via Claude iOS')).toBeVisible();
    // Estimated expiry shows its basis, naming the model that produced it.
    await expect(page.getByTestId('op').filter({ hasText: 'CHKN BREAST 3 LB' })).toContainText('model_estimate, fake-1, medium');
    await expectNoHorizontalScroll(page);
  });

  test('edit one line, skip one, apply the rest, then undo', async ({ page }) => {
    await signIn(page);
    await page.goto(`/review/${state().proposal_id}`);
    const yogurt = page.getByTestId('op').filter({ hasText: 'GRK YOGURT 2X32 OZ' });
    await yogurt.getByRole('button', { name: 'Edit' }).click();
    await yogurt.getByLabel('Location').selectOption('freezer');
    await yogurt.getByRole('button', { name: 'Save' }).click();
    await expect(yogurt.getByText('Edited')).toBeVisible();

    const berries = page.getByTestId('op').filter({ hasText: 'STRAWBERRIES 2 LB' });
    await berries.getByRole('button', { name: 'Skip' }).click();

    await page.getByRole('button', { name: 'Add 5 items' }).click();
    await expect(page.getByRole('status')).toContainText('Added 5 items');
    await expect(yogurt).toContainText('freezer');
    await expect(yogurt.getByText('Added')).toBeVisible();

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('button', { name: /Add \d+ items?/ })).toBeVisible();
  });

  test('re-apply everything for the inventory tests', async ({ page }) => {
    await signIn(page);
    await page.goto(`/review/${state().proposal_id}`);
    // Strawberries were skipped (rejected) earlier; undo only reopens applied lines, so re-add them explicitly.
    await page.getByTestId('op').filter({ hasText: 'STRAWBERRIES 2 LB' }).getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Add 6 items' }).click();
    await expect(page.getByRole('status')).toContainText('Added 6 items');
  });
});
```

- [ ] **Step 10: Run the e2e tests**

Run: `npx playwright install chromium && npm run e2e`
Expected: 3 pass. (The DB container must be running and `buttery_e2e` must exist; the init script creates it.)

- [ ] **Step 11: Typecheck and commit**

Run: `npm run typecheck && npm test`

```bash
git add apps/web apps/server playwright.config.js tests/e2e .gitignore package-lock.json
git commit -m "feat(web): token sign-in and mobile receipt review page; SPA served by server; phone e2e"
```

---

### Task 17: Inventory and item pages

**Files:**
- Create: `apps/web/src/pages/Inventory.tsx`, `apps/web/src/pages/Item.tsx`, `tests/e2e/02-inventory.spec.ts`
- Modify: `apps/web/src/main.tsx` (routes)

**Interfaces:**
- Consumes: `api.inventory`, `api.item`, `api.undo`, `ExpiryBadge`, `useLoad`, `ErrorBox`, `cap`, `money`, `when`.
- Produces: SPA routes `/inventory` (supports `?location=` and `?view=use-soon`) and `/items/:lotId`.

- [ ] **Step 1: Write the failing e2e test** `tests/e2e/02-inventory.spec.ts`

This runs after `01-review.spec.ts` (one worker; files run in name order). Its `beforeEach` re-applies the seeded receipt through the API, so it does not depend on the review test's end state. A second apply is a no-op.

```ts
import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, signIn, state } from './helpers';

test.describe.serial('inventory on a phone', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    const res = await page.request.post(`/api/proposals/${state().proposal_id}/resolve`, {
      data: { decisions: [], accept_remaining: true, apply: true, idempotency_key: `e2e-inv-${Date.now()}` },
    });
    expect(res.ok()).toBe(true);
  });

  test('shows what to use soon with estimate labels', async ({ page }) => {
    await page.goto('/inventory');
    await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();
    const chicken = page.getByTestId('lot').filter({ hasText: 'Chicken breast' }).first();
    await expect(chicken).toContainText('est.');
    await expect(chicken).toContainText('1 × 3 lb');
    await expectNoHorizontalScroll(page);
  });

  test('filters by location', async ({ page }) => {
    await page.goto('/inventory?location=pantry');
    await expect(page.getByText('Nothing here yet')).toBeVisible();
  });

  test('an item explains its evidence and can be undone', async ({ page }) => {
    await page.goto('/inventory');
    await page.getByTestId('lot').filter({ hasText: 'Chicken breast' }).first().click();
    await expect(page.getByRole('heading', { name: 'Chicken breast' })).toBeVisible();
    await expect(page.getByText('Receipt · PANTRY CLUB · 2026-09-28')).toBeVisible();
    await expect(page.getByText('CHKN BREAST 3 LB')).toBeVisible();
    await expect(page.getByText(/Estimated: bought 2026-09-28 \+ 5d/)).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).first().click();
    await expect(page.getByRole('status')).toContainText('Undid');
    await expect(page.getByText('voided')).toBeVisible();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run e2e -- 02-inventory`
Expected: FAIL (route renders "Page not found.").

- [ ] **Step 3: Implement the pages**

`apps/web/src/pages/Inventory.tsx`:

```tsx
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { ExpiryBadge } from '../components/Badges';
import { ErrorBox } from '../components/ErrorBox';
import { cap } from '../format';
import type { LotView } from '../types';
import { useLoad } from '../useLoad';

function LotRow({ lot, showLocation }: { lot: LotView; showLocation?: boolean }) {
  return (
    <li className="card" data-testid="lot">
      <Link className="lot" to={`/items/${lot.lot_id}`}>
        <span>
          <strong>{lot.food.name}</strong>
          <span className="meta">
            {' '}
            {lot.quantity_text}
            {showLocation ? ` · ${lot.location}` : ''}
          </span>
        </span>
        <span className="right">
          <ExpiryBadge text={lot.expiry_text} urgency={lot.urgency} kind={lot.expires?.kind} />
          {lot.evidence_age_days !== null && lot.evidence_age_days > 0 && <div className="muted small">seen {lot.evidence_age_days}d ago</div>}
        </span>
      </Link>
    </li>
  );
}

export function Inventory() {
  const [params] = useSearchParams();
  const location = params.get('location') ?? '';
  const useSoonOnly = params.get('view') === 'use-soon';
  const { data, error, loading } = useLoad(() => api.inventory(location || undefined), [location]);

  if (loading && !data) return <p className="muted">Loading…</p>;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const soon = [...data.use_soon.expired, ...data.use_soon.urgent, ...data.use_soon.soon];
  const total = Object.values(data.by_location).reduce((n, items) => n + items.length, 0);

  return (
    <div>
      <header>
        <h1>Inventory</h1>
        <p className="muted">
          {total} item{total === 1 ? '' : 's'}
          {location ? ` in ${location}` : ''}
        </p>
      </header>
      <div className="chips">
        <Link className={!location ? 'active' : ''} to="/inventory">
          All
        </Link>
        {data.locations.map((l) => (
          <Link key={l} className={location === l ? 'active' : ''} to={`/inventory?location=${l}`}>
            {cap(l)}
          </Link>
        ))}
      </div>

      <section>
        <h2>Use soon</h2>
        {soon.length === 0 ? (
          <p className="muted">Nothing expiring in the next week.</p>
        ) : (
          <ul className="cards">
            {soon.map((l) => (
              <LotRow key={l.lot_id} lot={l} showLocation={!location} />
            ))}
          </ul>
        )}
      </section>

      {!useSoonOnly &&
        Object.entries(data.by_location).map(([loc, items]) => (
          <section key={loc}>
            <h2>
              {cap(loc)} · {items.length}
            </h2>
            <ul className="cards">
              {items.map((l) => (
                <LotRow key={l.lot_id} lot={l} />
              ))}
            </ul>
          </section>
        ))}
      {total === 0 && <p className="muted">Nothing here yet. Share a receipt with your agent to get started.</p>}
    </div>
  );
}
```

`apps/web/src/pages/Item.tsx`:

```tsx
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError, newKey } from '../api';
import { ExpiryBadge } from '../components/Badges';
import { ErrorBox } from '../components/ErrorBox';
import { money, when } from '../format';
import { useLoad } from '../useLoad';

const OP_LABEL: Record<string, string> = { add_lot: 'Added', void_lot: 'Removed (undo)' };

export function Item() {
  const { lotId = '' } = useParams();
  const { data, error, loading, reload } = useLoad(() => api.item(lotId), [lotId]);
  const undoKey = useRef(newKey());
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading && !data) return <p className="muted">Loading…</p>;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const l = data.lot;
  const models = [...new Set(data.reasoning.map((r) => r.model).filter(Boolean))];

  async function undo(changeSetId: string) {
    setBusy(true);
    try {
      const r = await api.undo(changeSetId, undoKey.current);
      undoKey.current = newKey();
      setMessage(`Undid “${r.label}”.`);
      reload();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Could not undo. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <header>
        <p className="eyebrow">
          {l.location}
          {l.status !== 'active' ? ` · ${l.status}` : ''}
        </p>
        <h1>{l.food.name}</h1>
      </header>
      {message && (
        <div className="banner" role="status">
          {message}
        </div>
      )}

      <section className="card">
        <dl className="facts">
          <dt>Amount</dt>
          <dd>{l.quantity_text}</dd>
          <dt>Expiry</dt>
          <dd>
            <ExpiryBadge text={l.expiry_text} urgency={l.urgency} kind={l.expires?.kind} />
            {l.expires && <div className="muted small">{l.expires.kind === 'printed' ? 'Printed on the package' : `Estimated: ${l.expires.basis}`}</div>}
          </dd>
          <dt>Type</dt>
          <dd>{l.food.perishability === 'perishable' ? 'Perishable' : 'Shelf-stable'}</dd>
          <dt>Bought</dt>
          <dd>{l.acquired_on ?? 'unknown'}</dd>
          <dt>Last seen</dt>
          <dd>{l.evidence_age_days === null ? 'never' : l.evidence_age_days === 0 ? 'today' : `${l.evidence_age_days} days ago`}</dd>
        </dl>
      </section>

      <h2>Evidence</h2>
      <ul className="cards">
        {data.evidence.map((e) => (
          <li className="card" key={e.observation_id}>
            <strong>{e.summary}</strong>
            {e.line && (
              <div className="raw">
                {e.line}
                {e.price_cents !== null && <span>{money(e.price_cents)}</span>}
              </div>
            )}
            {e.review_url && <Link to={new URL(e.review_url).pathname}>Open receipt review</Link>}
          </li>
        ))}
      </ul>
      {models.length > 0 && <p className="muted small">Name and shelf life estimated by {models.join(', ')}.</p>}

      <h2>History</h2>
      <ul className="cards">
        {data.history.map((h) => (
          <li className="card" key={`${h.change_set_id}-${h.op}`}>
            <div className="title-row">
              <strong>{OP_LABEL[h.op] ?? h.op}</strong>
              {h.undone && <span className="badge">Undone</span>}
            </div>
            <div className="meta">
              {h.label} · {when(h.at)} · {h.by ?? 'someone'}
              {h.via ? ` via ${h.via}` : ''}
            </div>
            {!h.undone && !h.is_undo && l.status === 'active' && (
              <div className="actions">
                <button onClick={() => undo(h.change_set_id)} disabled={busy}>
                  Undo
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

In `apps/web/src/main.tsx`, add imports and routes inside the `Layout` children (before the `*` route):

```tsx
import { Inventory } from './pages/Inventory';
import { Item } from './pages/Item';
// ...
      { path: '/inventory', element: <Inventory /> },
      { path: '/items/:lotId', element: <Item /> },
```

- [ ] **Step 4: Run all tests**

Run: `npm run typecheck && npm test && npm run e2e`
Expected: all pass. Review tests run first, then inventory tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web tests/e2e
git commit -m "feat(web): inventory with use-soon and location filters; item evidence, estimate basis, history and undo"
```

---

### Task 18: Wire in the Crusoe reasoning module

**Precondition:** the `feat/reasoning-crusoe` PR (handoff `docs/handoffs/2026-09-29-crusoe-reasoning.md`) is merged to `main`, and `packages/reasoning/package.json` has the name `@buttery/reasoning`. **If it is not merged, stop and report it.** The app keeps running on the interim heuristic, and every earlier acceptance criterion still holds.

**Files:**
- Create: `apps/server/src/reasoning/provider.ts`, `apps/server/src/reasoning/cache.ts`
- Modify: `apps/server/src/db/schema/ledger.ts` (`reasoningCache` table), `apps/server/src/reasoning/port.ts` (`ReasoningContext.cache`), `apps/server/src/main.ts`, `apps/server/package.json`, `.env.example`
- Generate: `apps/server/drizzle/0002_*.sql`
- Test: `apps/server/test/reasoning-contract.test.ts`

**Interfaces:**
- Consumes: from `@buttery/reasoning` (per the handoff contract): `createReasoningProvider()`, the `ReasoningCache` shape `{ get(key), set(key, value) }` and env `REASONING_PROVIDER`, `CRUSOE_API_KEY`, `CRUSOE_BASE_URL`, `REASONING_MODEL`.
- Produces: `createReasoning(db): ReasoningPort` (the provider with a Postgres-backed cache injected), `createDbReasoningCache(db)`.

- [ ] **Step 1: Sync and read the module's notes**

Run: `git pull && cat packages/reasoning/README.md`
Read the **Crusoe notes** and **Proposed spec changes** sections. If the package's exported types differ from `apps/server/src/reasoning/port.ts`, **the package's contract wins**: update `port.ts` to match and fix the compile errors that follow.

- [ ] **Step 2: Add the dependency and cache table**

Add `"@buttery/reasoning": "*"` to `apps/server/package.json` dependencies, then run `npm install`.

Append to `apps/server/src/db/schema/ledger.ts`:

```ts
export const reasoningCache = pgTable('reasoning_cache', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});
```

Run: `npm run db:generate -w apps/server`

In `apps/server/src/reasoning/port.ts`:

```ts
export type ReasoningCache = { get(key: string): Promise<unknown | undefined>; set(key: string, value: unknown): Promise<void> };
export type ReasoningContext = { householdId?: string; cache?: ReasoningCache };
```

- [ ] **Step 3: Write the failing contract test** `apps/server/test/reasoning-contract.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createReasoning } from '../src/reasoning/provider';
import { submitReceipt } from '../src/services/receipts';
import { getProposalView } from '../src/services/proposals';
import { resetDb, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';
import { fixtureReceipt } from './fixtures/receipts';

describe('@buttery/reasoning integration (fallback provider, no network)', () => {
  beforeEach(async () => {
    await resetDb();
    process.env.REASONING_PROVIDER = 'fallback';
  });

  it('produces a schema-valid proposal with default-rule shelf life', async () => {
    const db = testDb();
    const { principal } = await seedUser(db);
    const deps = testDeps({ reasoning: createReasoning(db) });
    const r = await submitReceipt(deps, principal, { kind: 'receipt', payload: fixtureReceipt('warehouse'), idempotency_key: 'contract-1' });
    expect(r.counts.items).toBe(6);
    const view = await getProposalView(deps, principal, r.proposal_id);
    const chicken = view.ops.find((o) => o.line.raw_text === 'CHKN BREAST 3 LB')!;
    expect(chicken.draft?.expires_preview).toMatchObject({ kind: 'estimated' });
    expect(chicken.draft?.expires_preview?.basis).toContain('default_rule');
  });
});
```

Run: `npm test -w apps/server -- reasoning-contract`
Expected: FAIL (`../src/reasoning/provider` is missing).

- [ ] **Step 4: Implement**

`apps/server/src/reasoning/cache.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { reasoningCache } from '../db/schema';
import type { ReasoningCache } from './port';

export function createDbReasoningCache(db: Db): ReasoningCache {
  return {
    async get(key) {
      const [row] = await db.select().from(reasoningCache).where(eq(reasoningCache.key, key)).limit(1);
      return row?.value ?? undefined;
    },
    async set(key, value) {
      await db.insert(reasoningCache).values({ key, value: value as object }).onConflictDoUpdate({ target: reasoningCache.key, set: { value: value as object } });
    },
  };
}
```

`apps/server/src/reasoning/provider.ts`:

```ts
import { createReasoningProvider } from '@buttery/reasoning';
import type { Db } from '../db/client';
import { createDbReasoningCache } from './cache';
import type { ReasoningPort } from './port';

export function createReasoning(db: Db): ReasoningPort {
  const provider = createReasoningProvider();
  const cache = createDbReasoningCache(db);
  return {
    canonicalizeItems: (input, ctx) => provider.canonicalizeItems(input, { ...ctx, cache }),
    estimateShelfLife: (input, ctx) => provider.estimateShelfLife(input, { ...ctx, cache }),
  };
}
```

In `apps/server/src/main.ts`, replace `createInterimReasoning()` with `createReasoning(db)` (import from `./reasoning/provider`). The interim heuristic stays in `receipts.ts` as the last resort when a provider throws.

Append to `.env.example`:

```sh
# Crusoe reasoning (see packages/reasoning/README.md)
REASONING_PROVIDER=crusoe
CRUSOE_API_KEY=
CRUSOE_BASE_URL=
REASONING_MODEL=
```

- [ ] **Step 5: Run the tests**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Live check against Crusoe**

With the real key in `.env`:
- Run: `npm run reasoning:ping`. Expected: `path` is `model` or `repair`.
- Run: `npm run reasoning:eval`. Record the accuracy in the PR or commit message.
- Restart the server. In Claude Code, share `tests/fixtures/food-images/images/receipt-warehouse-clean.png`. Open the review link: each estimated expiry's basis names the Crusoe model. After applying, an item page lists the Crusoe model under "estimated by".
- Stop the network (or set a bad `CRUSOE_BASE_URL`) and submit `receipt-mixed-lines.png`. Expected: a proposal still arrives, and the response has `fallback_used: true`.

- [ ] **Step 7: Commit**

```bash
git add apps/server .env.example package-lock.json
git commit -m "feat: use the Crusoe reasoning module with a Postgres-backed cache"
```

---

### Task 19: AuthKit OAuth for MCP and web sign-in

**Manual prerequisite (you, in the WorkOS dashboard):**
1. Create or choose a WorkOS environment for Buttery and enable **AuthKit**.
2. Enable **Dynamic Client Registration** (needed for claude.ai custom connectors; see WorkOS's MCP auth guide, as dashboard labels change).
3. Add the redirect URI `${PUBLIC_BASE_URL}/auth/callback` (the Funnel URL from Task 21, plus `http://localhost:8790/auth/callback` for local use).
4. Copy the AuthKit domain (`https://<name>.authkit.app`), client ID and API key into `.env` as `AUTHKIT_DOMAIN`, `WORKOS_CLIENT_ID` and `WORKOS_API_KEY`. Leave `AUTHKIT_ISSUER` empty unless tokens carry a different `iss`. Decode one token to check.

**Files:**
- Create: `apps/server/src/auth/authkit.ts`
- Modify: `apps/server/src/identity/provision.ts` (`findUserBySubject`), `apps/server/src/http/authRoutes.ts` (`/auth/authkit`, `/auth/callback`), `apps/server/src/http/app.ts` (`AppDeps.authkit: Authkit | null`), `apps/server/src/main.ts`
- Test: `apps/server/test/authkit.test.ts`

**Interfaces:**
- Consumes: `provisionUser`, `resolvePat`, `ensureWebConnection`, `writeSession`, `safeNext`, `connections`.
- Produces:
  - `type Authkit = { resolveBearer(token): Promise<Principal | null>; loginUrl(next): string; completeLogin(code): Promise<{ userId; householdId }> }`
  - `createAuthkit(config, db, overrides?): Authkit | null`
  - `findUserBySubject(db, sub): Promise<{ userId; householdId } | null>`

- [ ] **Step 1: Install**

Run: `npm i -w apps/server jose @workos-inc/node`

- [ ] **Step 2: Write the failing test** `apps/server/test/authkit.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAuthkit } from '../src/auth/authkit';
import { loadConfig } from '../src/config';
import { createApp } from '../src/http/app';
import { provisionUser } from '../src/identity/provision';
import { resetDb, TEST_DB_URL, testDb } from './helpers/db';
import { callTool, mcpClient, startServer, testDeps } from './helpers/app';

const ISSUER = 'https://auth.test';
const config = loadConfig({
  DATABASE_URL: TEST_DB_URL,
  SESSION_SECRET: 'x'.repeat(32),
  PUBLIC_BASE_URL: 'https://buttery.test',
  AUTHKIT_DOMAIN: ISSUER,
  WORKOS_CLIENT_ID: 'client_test',
  WORKOS_API_KEY: 'sk_test_dummy',
});

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] });
  const sign = (claims: { sub?: string; iss?: string; exp?: string; client_id?: string }) =>
    new SignJWT({ client_id: claims.client_id ?? 'client_claude' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(claims.iss ?? ISSUER)
      .setSubject(claims.sub ?? 'user_01')
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? '5m')
      .sign(privateKey);
  return { jwks, sign };
}

const fetchUser = async (id: string) => ({ id, email: 'alex@example.com', firstName: 'Alex', lastName: null });

describe('AuthKit', () => {
  beforeEach(() => resetDb());
  const db = testDb();

  it('accepts a valid token, provisions the user once and reuses the connection', async () => {
    const { jwks, sign } = await keys();
    const ak = createAuthkit(config, db, { jwks, fetchUser })!;
    const a = await ak.resolveBearer(await sign({}));
    const b = await ak.resolveBearer(await sign({}));
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
  });

  it('links to an existing PAT user with the same email', async () => {
    const { jwks, sign } = await keys();
    const existing = await provisionUser(db, { email: 'alex@example.com' });
    const p = await createAuthkit(config, db, { jwks, fetchUser })!.resolveBearer(await sign({}));
    expect(p).toMatchObject({ userId: existing.userId, householdId: existing.householdId });
  });

  it('rejects a wrong issuer, an expired token and garbage', async () => {
    const { jwks, sign } = await keys();
    const ak = createAuthkit(config, db, { jwks, fetchUser })!;
    expect(await ak.resolveBearer(await sign({ iss: 'https://evil.test' }))).toBeNull();
    expect(await ak.resolveBearer(await sign({ exp: '-1m' }))).toBeNull();
    expect(await ak.resolveBearer('not-a-jwt')).toBeNull();
  });

  it('serves MCP to an AuthKit token', async () => {
    const { jwks, sign } = await keys();
    const ak = createAuthkit(config, db, { jwks, fetchUser })!;
    const server = await startServer(testDeps({ config, authkit: ak, resolveBearer: (t) => ak.resolveBearer(t) }));
    const client = await mcpClient(server.url, await sign({}));
    expect((await callTool(client, 'whoami')).user.email).toBe('alex@example.com');
    await client.close();
    await server.close();
  });

  it('completes web sign-in via the callback', async () => {
    const ak = createAuthkit(config, db, { fetchUser, exchangeCode: async () => fetchUser('user_01') })!;
    const app = createApp(testDeps({ config, authkit: ak }));
    const start = await app.request('/auth/authkit?next=/review/abc');
    expect(start.status).toBe(302);
    expect(start.headers.get('location')).toContain('client_id=client_test');
    const cb = await app.request('/auth/callback?code=xyz&state=%2Freview%2Fabc');
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/review/abc');
    const cookie = cb.headers.get('set-cookie')!.split(';')[0]!;
    const me = await (await app.request('/api/me', { headers: { cookie } })).json();
    expect(me.user.email).toBe('alex@example.com');
  });
});
```

Run: `npm test -w apps/server -- authkit`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `apps/server/src/identity/provision.ts`:

```ts
export async function findUserBySubject(db: Db, sub: string): Promise<{ userId: string; householdId: string } | null> {
  const [u] = await db.select().from(users).where(eq(users.authSubject, sub)).limit(1);
  return u ? { userId: u.id, householdId: await householdFor(db, u.id, u.defaultHouseholdId) } : null;
}
```

`apps/server/src/auth/authkit.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { WorkOS } from '@workos-inc/node';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { connections } from '../db/schema';
import type { Principal } from '../identity/principal';
import { findUserBySubject, provisionUser } from '../identity/provision';

export type AuthkitUser = { id: string; email: string | null; firstName: string | null; lastName: string | null };

export type Authkit = {
  resolveBearer(token: string): Promise<Principal | null>;
  loginUrl(next: string): string;
  completeLogin(code: string): Promise<{ userId: string; householdId: string }>;
};

type Overrides = { jwks?: JWTVerifyGetKey; fetchUser?: (id: string) => Promise<AuthkitUser>; exchangeCode?: (code: string) => Promise<AuthkitUser> };

async function ensureOAuthConnection(db: Db, userId: string, householdId: string, oauthClientId: string) {
  const [existing] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.householdId, householdId), eq(connections.kind, 'oauth_client'), eq(connections.oauthClientId, oauthClientId), isNull(connections.revokedAt)))
    .limit(1);
  if (existing) return existing;
  const [row] = await db
    .insert(connections)
    .values({ userId, householdId, kind: 'oauth_client', oauthClientId, clientName: `Connector ${oauthClientId.slice(-6)}` })
    .returning();
  return row!;
}

export function createAuthkit(config: Config, db: Db, o: Overrides = {}): Authkit | null {
  if (!config.AUTHKIT_DOMAIN || !config.WORKOS_CLIENT_ID || !config.WORKOS_API_KEY) return null;
  const clientId = config.WORKOS_CLIENT_ID;
  const issuer = config.AUTHKIT_ISSUER ?? config.AUTHKIT_DOMAIN;
  const jwks = o.jwks ?? createRemoteJWKSet(new URL(`${config.AUTHKIT_DOMAIN}/oauth2/jwks`));
  const workos = new WorkOS(config.WORKOS_API_KEY, { clientId });
  const toUser = (u: { id: string; email: string; firstName: string | null; lastName: string | null }): AuthkitUser => ({ id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName });
  const fetchUser = o.fetchUser ?? (async (id: string) => toUser(await workos.userManagement.getUser(id)));
  const exchangeCode = o.exchangeCode ?? (async (code: string) => toUser((await workos.userManagement.authenticateWithCode({ clientId, code })).user));
  const ensure = (u: AuthkitUser) =>
    provisionUser(db, { authSubject: u.id, email: u.email, displayName: [u.firstName, u.lastName].filter(Boolean).join(' ') || null });

  return {
    async resolveBearer(token) {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, jwks, { issuer }));
      } catch {
        return null;
      }
      if (!payload.sub) return null;
      const known = await findUserBySubject(db, payload.sub);
      const { userId, householdId } = known ?? (await ensure(await fetchUser(payload.sub)));
      const oauthClientId = (payload.client_id as string | undefined) ?? (payload.azp as string | undefined) ?? 'oauth';
      const conn = await ensureOAuthConnection(db, userId, householdId, oauthClientId);
      return { userId, householdId, connectionId: conn.id, clientName: conn.clientName };
    },
    loginUrl(next) {
      return workos.userManagement.getAuthorizationUrl({ provider: 'authkit', clientId, redirectUri: `${config.PUBLIC_BASE_URL}/auth/callback`, state: next });
    },
    async completeLogin(code) {
      const r = await ensure(await exchangeCode(code));
      return { userId: r.userId, householdId: r.householdId };
    },
  };
}
```

In `apps/server/src/http/app.ts`, change `authkit?: { loginUrl(next: string): string } | null;` to `authkit?: Authkit | null;` (with `import type { Authkit } from '../auth/authkit';`).

Add to `authRoutes` in `apps/server/src/http/authRoutes.ts`:

```ts
  app.get('/authkit', (c) => {
    if (!deps.authkit) throw new AppError('not_configured', 'Account sign-in is not configured', 404);
    return c.redirect(deps.authkit.loginUrl(safeNext(c.req.query('next'))));
  });
  app.get('/callback', async (c) => {
    if (!deps.authkit) throw new AppError('not_configured', 'Account sign-in is not configured', 404);
    const code = c.req.query('code');
    if (!code) throw new AppError('invalid_input', 'Missing code', 400);
    const { userId, householdId } = await deps.authkit.completeLogin(code);
    const connectionId = await ensureWebConnection(deps.db, userId, householdId);
    await writeSession(c, deps.config, { u: userId, h: householdId, c: connectionId });
    return c.redirect(safeNext(c.req.query('state')));
  });
```

Replace `apps/server/src/main.ts`:

```ts
import { serve } from '@hono/node-server';
import { createAuthkit } from './auth/authkit';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { createApp } from './http/app';
import { resolvePat } from './identity/tokens';
import { createReasoning } from './reasoning/provider';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const authkit = createAuthkit(config, db);
const resolveBearer = async (token: string) => (await resolvePat(db, token)) ?? (authkit ? authkit.resolveBearer(token) : null);
const app = createApp({ config, db, reasoning: createReasoning(db), authkit, resolveBearer });

serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`buttery listening on :${info.port} (${config.PUBLIC_BASE_URL})${authkit ? ' with AuthKit' : ''}`);
});
```

(If Task 18 has not landed yet, keep `createInterimReasoning()` in place of `createReasoning(db)`.)

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server package-lock.json
git commit -m "feat: AuthKit OAuth resource server for MCP and account sign-in for the web"
```

---

### Task 20: Self-serve sign-up and onboarding

Anyone can create an account and household from the web (AuthKit's sign-up screen). New users land on an onboarding and settings page, where they name the household, set its timezone, and connect agents. They mint their own access tokens for CLI agents (Claude Code, Codex, agentdock), with no operator step. `SIGNUP_MODE=closed` turns off new sign-ups without affecting existing users.

**Files:**
- Create: `apps/server/src/services/household.ts`, `apps/web/src/pages/Settings.tsx`, `tests/e2e/03-settings.spec.ts`
- Modify: `apps/server/src/config.ts` (`SIGNUP_MODE`), `apps/server/src/identity/provision.ts` (`allowCreate`), `apps/server/src/identity/tokens.ts` (`listPats`, `revokePat`), `apps/server/src/auth/authkit.ts` (sign-up screen, sign-up policy, `created`), `apps/server/src/http/authRoutes.ts`, `apps/server/src/http/apiRoutes.ts`, `apps/web/src/api.ts`, `apps/web/src/types.ts`, `apps/web/src/pages/Login.tsx`, `apps/web/src/components/Layout.tsx`, `apps/web/src/main.tsx`, `.env.example`
- Test: `apps/server/test/signup.test.ts`, `tests/e2e/03-settings.spec.ts`

**Interfaces:**
- Consumes: `createAuthkit` (Task 19), `provisionUser`, `createPat`, `resolvePat`, `getWhoami`, session helpers.
- Produces:
  - `Config.SIGNUP_MODE: 'open' | 'closed'` (default `open`)
  - `provisionUser(db, input, { allowCreate?: boolean })`: throws `AppError('signup_closed', …, 403)` when it would create a user and `allowCreate === false`
  - `Authkit.loginUrl(next, mode?: 'sign-in' | 'sign-up')`
  - `Authkit.completeLogin(code) → { userId, householdId, created }`
  - `listPats(db, p)`, `revokePat(db, p, connectionId)`
  - `updateHousehold(db, p, { name?, timezone? })`
  - Routes:
    - `GET /auth/authkit?mode=sign-up`
    - `GET /auth/config` → `{ authkit, signup }`
    - `GET /api/tokens`
    - `POST /api/tokens {client_name}` → 201 with the token shown once
    - `POST /api/tokens/:id/revoke`
    - `POST /api/household {name?, timezone?}`
  - SPA route `/settings` (`?welcome=1` after a first sign-up)

**Ruling (security over the global idempotency constraint):** `POST /api/tokens` takes **no** idempotency key. Storing its response in `idempotency_records` would keep the raw token in the database. The UI disables the button while the request is in flight; a double-submit creates two tokens, and the user can revoke one.

- [ ] **Step 1: Write the failing server test** `apps/server/test/signup.test.ts`

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createAuthkit } from '../src/auth/authkit';
import { loadConfig } from '../src/config';
import { idempotencyRecords, users } from '../src/db/schema';
import { createApp } from '../src/http/app';
import { provisionUser } from '../src/identity/provision';
import { resolvePat } from '../src/identity/tokens';
import { resetDb, TEST_DB_URL, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';

const base = { DATABASE_URL: TEST_DB_URL, SESSION_SECRET: 'x'.repeat(32), PUBLIC_BASE_URL: 'https://buttery.test', AUTHKIT_DOMAIN: 'https://auth.test', WORKOS_CLIENT_ID: 'client_test', WORKOS_API_KEY: 'sk_test_dummy' };
const newUser = async () => ({ id: 'user_new', email: 'new@example.com', firstName: 'Sam', lastName: null });

function appWith(mode: 'open' | 'closed') {
  const config = loadConfig({ ...base, SIGNUP_MODE: mode });
  const authkit = createAuthkit(config, testDb(), { fetchUser: async (id) => ({ ...(await newUser()), id }), exchangeCode: newUser })!;
  return createApp(testDeps({ config, authkit }));
}

async function cookieFor(app: ReturnType<typeof createApp>, token: string) {
  const res = await app.request('/auth/token-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}
const post = (app: ReturnType<typeof createApp>, path: string, cookie: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('self-serve sign-up', () => {
  beforeEach(() => resetDb());

  it('sends sign-up requests to the AuthKit sign-up screen', async () => {
    const res = await appWith('open').request('/auth/authkit?mode=sign-up&next=/inventory');
    expect(res.headers.get('location')).toContain('screen_hint=sign-up');
    expect(await (await appWith('open').request('/auth/config')).json()).toEqual({ authkit: true, signup: true });
  });

  it('creates a household on first sign-in and lands on onboarding', async () => {
    const res = await appWith('open').request('/auth/callback?code=abc&state=%2Finventory');
    expect(res.headers.get('location')).toBe('/settings?welcome=1');
    const [u] = await testDb().select().from(users).where(eq(users.authSubject, 'user_new'));
    expect(u?.email).toBe('new@example.com');
  });

  it('sends a returning user to their original page', async () => {
    await provisionUser(testDb(), { authSubject: 'user_new', email: 'new@example.com' });
    const res = await appWith('open').request('/auth/callback?code=abc&state=%2Freview%2Fx');
    expect(res.headers.get('location')).toBe('/review/x');
  });

  it('refuses new identities when sign-up is closed, but not existing ones', async () => {
    const closed = appWith('closed');
    expect((await closed.request('/auth/callback?code=abc')).status).toBe(403);
    expect(await (await closed.request('/auth/config')).json()).toEqual({ authkit: true, signup: false });
    await provisionUser(testDb(), { authSubject: 'user_new', email: 'new@example.com' });
    expect((await closed.request('/auth/callback?code=abc')).status).toBe(302);
  });

  it('lets a signed-in user create, list and revoke access tokens', async () => {
    const app = createApp(testDeps());
    const { token } = await seedUser(testDb());
    const cookie = await cookieFor(app, token);
    const created = await post(app, '/api/tokens', cookie, { client_name: 'Codex' });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body).toMatchObject({ client_name: 'Codex', mcp_url: 'https://buttery.test/mcp' });
    expect(body.token).toMatch(/^btr_/);
    expect(await resolvePat(testDb(), body.token)).not.toBeNull();

    const list = await (await app.request('/api/tokens', { headers: { cookie } })).json();
    expect(list.tokens.map((t: { client_name: string }) => t.client_name)).toContain('Codex');
    expect(JSON.stringify(list)).not.toContain(body.token);
    expect(JSON.stringify(await testDb().select().from(idempotencyRecords))).not.toContain(body.token);

    expect((await post(app, `/api/tokens/${body.connection_id}/revoke`, cookie, {})).status).toBe(200);
    expect(await resolvePat(testDb(), body.token)).toBeNull();
  });

  it('cannot revoke another user\'s token', async () => {
    const app = createApp(testDeps());
    const a = await seedUser(testDb(), 'a@example.com');
    const b = await seedUser(testDb(), 'b@example.com');
    const cookie = await cookieFor(app, b.token);
    expect((await post(app, `/api/tokens/${a.principal.connectionId}/revoke`, cookie, {})).status).toBe(404);
    expect(await resolvePat(testDb(), a.token)).not.toBeNull();
  });

  it('updates the household name and timezone, rejecting unknown timezones', async () => {
    const app = createApp(testDeps());
    const { token } = await seedUser(testDb());
    const cookie = await cookieFor(app, token);
    const ok = await (await post(app, '/api/household', cookie, { name: 'The Thomases', timezone: 'America/Chicago' })).json();
    expect(ok.household).toMatchObject({ name: 'The Thomases', timezone: 'America/Chicago' });
    expect((await post(app, '/api/household', cookie, { timezone: 'Mars/Olympus' })).status).toBe(422);
  });

  it('keeps allowCreate optional for the CLI', async () => {
    const r = await provisionUser(testDb(), { email: 'cli@example.com' });
    expect(r.created).toBe(true);
    await expect(provisionUser(testDb(), { email: 'x@example.com' }, { allowCreate: false })).rejects.toMatchObject({ code: 'signup_closed' });
    expect(await testDb().select().from(users).where(and(eq(users.email, 'x@example.com')))).toHaveLength(0);
  });
});
```

Run: `npm test -w apps/server -- signup`
Expected: FAIL (`SIGNUP_MODE` is unknown, and the routes are missing).

- [ ] **Step 2: Implement the server pieces**

`apps/server/src/config.ts`: add `SIGNUP_MODE: z.enum(['open', 'closed']).default('open'),` to `EnvSchema`, and `SIGNUP_MODE=open` to `.env.example`.

`apps/server/src/identity/provision.ts`: change the signature and guard creation:

```ts
import { AppError } from '../errors';

export type ProvisionOptions = { allowCreate?: boolean };

export async function provisionUser(db: Db, input: ProvisionInput, opts: ProvisionOptions = {}): Promise<ProvisionResult> {
  // ...existing subject and email lookups unchanged...
  if (opts.allowCreate === false) {
    throw new AppError('signup_closed', 'New sign-ups are closed for this Buttery. Ask the household owner for access.', 403);
  }
  // ...existing transaction that creates household, user and membership...
}
```

Append to `apps/server/src/identity/tokens.ts`:

```ts
import { desc } from 'drizzle-orm';
import { notFound } from '../errors';

export async function listPats(db: Executor, p: Principal) {
  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.userId, p.userId), eq(connections.householdId, p.householdId), eq(connections.kind, 'pat'), isNull(connections.revokedAt)))
    .orderBy(desc(connections.createdAt));
  return rows.map((r) => ({
    connection_id: r.id,
    client_name: r.clientName,
    token_prefix: r.tokenPrefix,
    created_at: r.createdAt.toISOString(),
    last_used_at: r.lastUsedAt?.toISOString() ?? null,
  }));
}

export async function revokePat(db: Executor, p: Principal, connectionId: string): Promise<void> {
  const rows = await db
    .update(connections)
    .set({ revokedAt: new Date() })
    .where(and(eq(connections.id, connectionId), eq(connections.userId, p.userId), eq(connections.householdId, p.householdId), eq(connections.kind, 'pat'), isNull(connections.revokedAt)))
    .returning({ id: connections.id });
  if (!rows.length) throw notFound('Token');
}
```

`apps/server/src/services/household.ts`:

```ts
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { households } from '../db/schema';
import { AppError } from '../errors';
import type { Principal } from '../identity/principal';

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const UpdateHouseholdSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  timezone: z.string().max(64).refine(isTimeZone, 'Unknown timezone').optional(),
});

export async function updateHousehold(db: Db, p: Principal, input: z.infer<typeof UpdateHouseholdSchema>) {
  if (!input.name && !input.timezone) throw new AppError('invalid_input', 'Nothing to update', 422);
  await db
    .update(households)
    .set({ ...(input.name ? { name: input.name } : {}), ...(input.timezone ? { timezone: input.timezone } : {}) })
    .where(eq(households.id, p.householdId));
}
```

`apps/server/src/auth/authkit.ts`:
- `Authkit.loginUrl(next: string, mode: 'sign-in' | 'sign-up' = 'sign-in')` passes `screenHint: mode` to `getAuthorizationUrl`.
- `ensure(u)` calls `provisionUser(db, {...}, { allowCreate: config.SIGNUP_MODE === 'open' })`.
- In `resolveBearer`, wrap `ensure(...)` in try/catch and return `null` on an `AppError` with code `signup_closed`.
- `completeLogin` returns `{ userId, householdId, created }` from `provisionUser`.

`apps/server/src/http/authRoutes.ts`:

```ts
  app.get('/config', (c) => c.json({ authkit: Boolean(deps.authkit), signup: Boolean(deps.authkit) && deps.config.SIGNUP_MODE === 'open' }));
  app.get('/authkit', (c) => {
    if (!deps.authkit) throw new AppError('not_configured', 'Account sign-in is not configured', 404);
    const mode = c.req.query('mode') === 'sign-up' ? 'sign-up' : 'sign-in';
    return c.redirect(deps.authkit.loginUrl(safeNext(c.req.query('next')), mode));
  });
  app.get('/callback', async (c) => {
    if (!deps.authkit) throw new AppError('not_configured', 'Account sign-in is not configured', 404);
    const code = c.req.query('code');
    if (!code) throw new AppError('invalid_input', 'Missing code', 400);
    const { userId, householdId, created } = await deps.authkit.completeLogin(code);
    const connectionId = await ensureWebConnection(deps.db, userId, householdId);
    await writeSession(c, deps.config, { u: userId, h: householdId, c: connectionId });
    return c.redirect(created ? '/settings?welcome=1' : safeNext(c.req.query('state')));
  });
```

(These replace the Task 19 versions of `/config`, `/authkit` and `/callback`.)

Add to `apps/server/src/http/apiRoutes.ts`:

```ts
  api.get('/tokens', async (c) => c.json({ tokens: await listPats(deps.db, c.get('principal')), mcp_url: `${deps.config.PUBLIC_BASE_URL}/mcp` }));

  api.post('/tokens', async (c) => {
    const { client_name } = z.object({ client_name: z.string().trim().min(1).max(60) }).parse(await c.req.json());
    const p = c.get('principal');
    const { token, connectionId } = await createPat(deps.db, { userId: p.userId, householdId: p.householdId, clientName: client_name });
    return c.json({ token, connection_id: connectionId, client_name, mcp_url: `${deps.config.PUBLIC_BASE_URL}/mcp` }, 201);
  });

  api.post('/tokens/:id/revoke', async (c) => {
    await revokePat(deps.db, c.get('principal'), z.uuid().parse(c.req.param('id')));
    return c.json({ ok: true });
  });

  api.post('/household', async (c) => {
    const p = c.get('principal');
    await updateHousehold(deps.db, p, UpdateHouseholdSchema.parse(await c.req.json()));
    return c.json(await getWhoami(deps.db, p, deps.config));
  });
```

with imports `createPat, listPats, revokePat` from `../identity/tokens` and `updateHousehold, UpdateHouseholdSchema` from `../services/household`.

Run: `npm test -w apps/server && npm run typecheck`
Expected: all pass, including `signup.test.ts` (8 tests) and the Task 19 AuthKit tests.

- [ ] **Step 3: Write the failing e2e test** `tests/e2e/03-settings.spec.ts`

```ts
import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, signIn } from './helpers';

test('settings: rename the household and manage agent tokens', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings?welcome=1');
  await expect(page.getByRole('heading', { name: 'Your household is ready' })).toBeVisible();

  await page.getByLabel('Household name').fill('E2E Kitchen');
  await page.getByRole('button', { name: 'Save household' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');

  await page.getByLabel('Agent name').fill('Codex');
  await page.getByRole('button', { name: 'Create token' }).click();
  const tokenBox = page.getByTestId('new-token');
  await expect(tokenBox).toContainText('btr_');
  await expect(tokenBox).toContainText('claude mcp add --transport http buttery');
  const token = (await tokenBox.getByTestId('token-value').textContent())!.trim();

  const row = page.getByTestId('token-row').filter({ hasText: 'Codex' });
  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(row).toHaveCount(0);
  const reuse = await page.request.post('/auth/token-login', { data: { token } });
  expect(reuse.status()).toBe(401);
  await expectNoHorizontalScroll(page);
});
```

Run: `npm run e2e -- 03-settings`
Expected: FAIL (`/settings` renders "Page not found.").

- [ ] **Step 4: Implement the web pieces**

Append to `apps/web/src/types.ts`:

```ts
export type Me = {
  user: { id: string; email: string | null; display_name: string | null };
  household: { id: string; name: string; timezone: string };
  connection: { id: string; client_name: string };
};
export type TokenRow = { connection_id: string; client_name: string; token_prefix: string | null; created_at: string; last_used_at: string | null };
export type NewToken = { token: string; connection_id: string; client_name: string; mcp_url: string };
```

Add to `api` in `apps/web/src/api.ts` (and change `authConfig`'s type to `{ authkit: boolean; signup: boolean }`):

```ts
  me: () => request<Me>('GET', '/api/me'),
  updateHousehold: (body: { name?: string; timezone?: string }) => request<Me>('POST', '/api/household', body),
  tokens: () => request<{ tokens: TokenRow[]; mcp_url: string }>('GET', '/api/tokens'),
  createToken: (client_name: string) => request<NewToken>('POST', '/api/tokens', { client_name }),
  revokeToken: (id: string) => request<{ ok: true }>('POST', `/api/tokens/${id}/revoke`, {}),
```

`apps/web/src/pages/Settings.tsx`:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { api, ApiError } from '../api';
import { ErrorBox } from '../components/ErrorBox';
import { when } from '../format';
import type { NewToken } from '../types';
import { useLoad } from '../useLoad';

export function Settings() {
  const [params] = useSearchParams();
  const welcome = params.get('welcome') === '1';
  const me = useLoad(() => api.me(), []);
  const tokens = useLoad(() => api.tokens(), []);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [agentName, setAgentName] = useState('Claude Code');
  const [created, setCreated] = useState<NewToken | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!me.data) return;
    setName(me.data.household.name);
    setTimezone(welcome ? Intl.DateTimeFormat().resolvedOptions().timeZone : me.data.household.timezone);
  }, [me.data, welcome]);

  if (me.error) return <ErrorBox error={me.error} />;
  if (!me.data || !tokens.data) return <p className="muted">Loading…</p>;
  const mcpUrl = tokens.data.mcp_url;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }
  const saveHousehold = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      me.setData(await api.updateHousehold({ name, timezone }));
      setMessage('Saved.');
    });
  };
  const createToken = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      setCreated(await api.createToken(agentName));
      tokens.reload();
    });
  };
  const revoke = (id: string) =>
    run(async () => {
      await api.revokeToken(id);
      if (created?.connection_id === id) setCreated(null);
      tokens.reload();
    });

  return (
    <div>
      <header>
        {welcome ? (
          <>
            <h1>Your household is ready</h1>
            <p className="muted">Name it, check the timezone, then connect an agent. You'll mostly use Buttery by talking to Claude, Codex or another assistant.</p>
          </>
        ) : (
          <h1>Settings</h1>
        )}
      </header>
      {message && (
        <div className="banner" role="status">
          {message}
        </div>
      )}

      <h2>Household</h2>
      <form className="card edit" onSubmit={saveHousehold}>
        <label>
          Household name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Timezone (used for expiry dates)
          <input value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
        </label>
        <div className="actions">
          <button className="primary" disabled={busy}>
            Save household
          </button>
        </div>
      </form>

      <h2>Connect Claude (web, desktop, phone)</h2>
      <div className="card">
        <p>
          In Claude, open Settings → Connectors → Add custom connector, and paste:
        </p>
        <div className="raw">{mcpUrl}</div>
        <p className="muted small">Sign in with this same account when Claude asks.</p>
      </div>

      <h2>Connect a command-line agent</h2>
      <form className="card edit" onSubmit={createToken}>
        <label>
          Agent name
          <input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Claude Code, Codex, agentdock…" required />
        </label>
        <div className="actions">
          <button className="primary" disabled={busy}>
            Create token
          </button>
        </div>
      </form>
      {created && (
        <div className="card" data-testid="new-token">
          <p>
            <strong>Copy this token now</strong>. It won't be shown again.
          </p>
          <div className="raw" data-testid="token-value">
            {created.token}
          </div>
          <p className="muted small">Claude Code:</p>
          <div className="raw">{`claude mcp add --transport http buttery ${created.mcp_url} --header "Authorization: Bearer ${created.token}"`}</div>
        </div>
      )}

      <h2>Active tokens</h2>
      {tokens.data.tokens.length === 0 ? (
        <p className="muted">No tokens yet.</p>
      ) : (
        <ul className="cards">
          {tokens.data.tokens.map((t) => (
            <li key={t.connection_id} className="card" data-testid="token-row">
              <div className="title-row">
                <strong>{t.client_name}</strong>
                <span className="badge">{t.token_prefix}…</span>
              </div>
              <div className="meta">
                Created {when(t.created_at)} · {t.last_used_at ? `last used ${when(t.last_used_at)}` : 'never used'}
              </div>
              <div className="actions">
                <button onClick={() => revoke(t.connection_id)} disabled={busy}>
                  Revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

`apps/web/src/pages/Login.tsx`: keep `authkit` and add `signup` state from `api.authConfig()`. When `signup` is true, render a primary link `Create your household` to `/auth/authkit?mode=sign-up&next=${encodeURIComponent(next)}`, above the existing "Continue with your account" link.

`apps/web/src/components/Layout.tsx`: add `<NavLink to="/settings">Settings</NavLink>` after Inventory.

`apps/web/src/main.tsx`: import `Settings` and add `{ path: '/settings', element: <Settings /> }` to the `Layout` children.

- [ ] **Step 5: Run everything**

Run: `npm run typecheck && npm test && npm run e2e`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server apps/web tests/e2e .env.example
git commit -m "feat: self-serve sign-up, onboarding, household settings and agent token management"
```

---

### Task 21: Container on the agentdock network, Tailscale Funnel, acceptance run

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docs/runbooks/connect-clients.md`
- Modify: `docker-compose.yml` (the `app` service), `apps/server/package.json` (`start:prod`)

- [ ] **Step 1: Container files**

`Dockerfile`:

```dockerfile
FROM node:26-slim
WORKDIR /app
COPY . .
RUN npm ci --include=dev && npm run build -w apps/web
WORKDIR /app/apps/server
EXPOSE 8790
CMD ["npm", "run", "start:prod"]
```

(If the `node:26-slim` tag is unavailable, use `node:24-slim`.)

`.dockerignore`:

```
**/node_modules
.git
.env
test-results
playwright-report
apps/web/dist
apps/server/.e2e
tests/fixtures/food-images/images
tests/fixtures/food-images/retired
```

Add to the `apps/server/package.json` scripts: `"start:prod": "tsx src/cli/migrate.ts && tsx src/main.ts"`

Add to `docker-compose.yml` under `services:`, and add the top-level `networks:`:

```yaml
  app:
    build: .
    env_file: .env
    environment:
      DATABASE_URL: postgres://buttery:buttery@db:5432/buttery
      PORT: "8790"
    ports: ["127.0.0.1:8790:8790"]
    depends_on:
      db: { condition: service_healthy }
    restart: unless-stopped
    networks:
      default: {}
      agentdock:
        aliases: [buttery]

networks:
  agentdock:
    external: true
    name: agent-container_default
```

- [ ] **Step 2: Bring it up behind Funnel**

Run: `tailscale funnel --bg 8790 && tailscale funnel status`
Put the printed `https://<machine>.<tailnet>.ts.net` URL into `.env` as `PUBLIC_BASE_URL`, and add `<that URL>/auth/callback` to AuthKit's redirect URIs.
Run: `docker compose up -d --build && curl -s https://<machine>.<tailnet>.ts.net/healthz`
Expected: `{"ok":true}`.
Run: `docker compose exec app npm run token:create -- --email you@example.com --name Alex --client "Claude Code"`

- [ ] **Step 3: Write `docs/runbooks/connect-clients.md`**

```markdown
# Connecting agents to Buttery

Base URL: the Tailscale Funnel URL in `.env` (`PUBLIC_BASE_URL`). MCP endpoint: `<base>/mcp`.

## Claude (web, desktop, iOS/Android)
Settings → Connectors → Add custom connector → URL `<base>/mcp` → sign in with AuthKit using the same email as your token user (identities link by email). The connector is then available in the mobile app.

## Claude Code
claude mcp add --transport http buttery <base>/mcp --header "Authorization: Bearer <btr_ token>"

## Codex CLI
In ~/.codex/config.toml (check `codex mcp --help` for your version's keys):
[mcp_servers.buttery]
url = "<base>/mcp"
bearer_token_env_var = "BUTTERY_TOKEN"

## agentdock workers (codex-isolated, claude-code-2, …)
Add an HTTP MCP server for the worker through agentdock's MCP management:
URL `http://buttery:8790/mcp` (container alias on the agent-container_default network), header `Authorization: Bearer <btr_ token>`. Config activates on the worker's next task.

## Tokens
Create: `docker compose exec app npm run token:create -- --email you@example.com --client "<client name>"`. One token per client, so history shows which client made each change.
```

- [ ] **Step 4: Acceptance run (Phase 0 + Phase 1)**

Check each item and note the evidence (test name, screenshot or transcript) in the PR description:

| Spec criterion | How to verify |
|---|---|
| `docker compose up` works from a clean checkout | `git clone` into a temp dir → `cp .env.example .env` (fill secrets) → `docker compose up -d --build` → `/healthz` |
| Claude Code calls `whoami` with a PAT | runbook, Claude Code section |
| An agentdock worker calls `whoami` with a PAT | configure `codex-isolated`, then submit an agentdock task: "Call the buttery whoami tool and report the household name" |
| claude.ai connector completes OAuth via Funnel; `whoami` works from the phone | runbook, Claude section; ask "who am I in buttery?" in the iOS app |
| `reasoning:ping` succeeds (Crusoe) | Task 18 Step 6 |
| A real Costco receipt shared from the phone yields a review link that opens on the phone | share a photo in the Claude iOS app → tap the link → sign in once |
| Edit one line, reject one, apply; inventory shows "est." lots | e2e `01-review.spec.ts` + manual on the phone |
| Resubmitting the same receipt creates nothing new | `receipts.test.ts` "detects a recaptured receipt"; manual: share the same photo again → `duplicate_of` |
| Retrying apply creates no duplicate changes | `proposals.test.ts` "does not duplicate lots…" and "replays the same key" |
| Undo restores prior state; history shows both | `changes.test.ts`, e2e item undo |
| A fresh Claude conversation and a Codex task via agentdock answer "what's expiring this week?" from the summary alone | new Claude chat; agentdock task to `codex-isolated` |
| A second receipt with the same items matches via learned aliases at high confidence | `proposals.test.ts` "matches the next receipt via learned aliases" |
| Fixture receipts canonicalize correctly; eval reports accuracy | `npm run reasoning:eval` (Task 18) |
| Fallback works when Crusoe is unreachable | `receipts.test.ts` "still builds a proposal when reasoning throws" + Task 18 Step 6 |
| Review page shows the estimate basis naming the model; the item links to its reasoning call | e2e review test + the item page "estimated by" line |
| Recaptured fixture receipt is detected as a duplicate | share `receipt-warehouse-recapture.png` after `receipt-warehouse-clean.png` |
| Someone new can sign up, get a household and connect an agent without operator help | open `<base>/login` in a private window → Create your household → AuthKit sign-up → lands on `/settings?welcome=1` → create a token → `claude mcp add …` → `whoami` shows the new household |
| `SIGNUP_MODE=closed` blocks new identities but not existing users | `signup.test.ts` |

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml apps/server/package.json docs/runbooks
git commit -m "chore: container on agentdock network behind Tailscale Funnel; client connection runbook"
```

---

## Deferred to Phase 2 (explicitly out of this plan)

- Return lines that reduce or remove the matching item (spec open item; currently shown as "not added").
- `log_activity`, `log_text`, `correct_item`, `get_attention`, `get_changes`, `set_preferences`; expiry recomputation on open, freeze and thaw; pantry-photo proposals; photo attachment on review.
- Naming OAuth connections after the client ("Claude iOS" instead of "Connector abc123"), via a settings page.
- Signed OAuth `state` for web sign-in (currently only the `next` path, validated by `safeNext`).
