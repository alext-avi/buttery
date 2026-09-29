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
