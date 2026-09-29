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
