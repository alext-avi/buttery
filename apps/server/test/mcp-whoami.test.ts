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
