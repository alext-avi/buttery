import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Authkit } from '../auth/authkit';
import { createPageLinks } from '../auth/pageLinks';
import type { BearerResolver } from '../auth/bearer';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { toAppError } from '../errors';
import type { ReasoningPort } from '../reasoning/port';
import { apiRoutes } from './apiRoutes';
import { authRoutes } from './authRoutes';
import { mcpRoutes } from './mcpRoute';
import { mountWeb } from './web';
import { wellKnownRoutes } from './wellKnown';

export type AppDeps = {
  config: Config;
  db: Db;
  reasoning: ReasoningPort;
  resolveBearer?: BearerResolver;
  authkit?: Authkit | null;
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
  const pageLinks = createPageLinks(deps);
  app.route('/auth', authRoutes(deps, pageLinks));
  app.route('/api', apiRoutes(deps, pageLinks));
  app.use('*', pageLinks.middleware);
  mountWeb(app, deps.config);
  return app;
}
