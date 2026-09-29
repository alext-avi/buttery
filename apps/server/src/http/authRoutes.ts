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
