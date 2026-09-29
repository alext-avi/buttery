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
