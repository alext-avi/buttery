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
