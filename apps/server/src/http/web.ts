import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Config } from '../config';

const RESERVED = ['/api', '/auth/', '/mcp', '/.well-known', '/healthz'];
/** Paths that are never web app pages: the reserved prefixes plus built assets. */
export const NOT_PAGES = [...RESERVED, '/assets/'];

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
