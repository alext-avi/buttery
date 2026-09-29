import { Hono } from 'hono';
import { z } from 'zod';
import type { CodeLogin } from '../auth/codeLogin';
import { clearSession, safeNext, writeSession } from '../auth/session';
import { AppError } from '../errors';
import { resolvePat } from '../identity/tokens';
import { ensureWebConnection } from '../identity/webConnection';
import type { AppDeps } from './app';

const TokenLoginSchema = z.object({ token: z.string().min(1).max(200), next: z.string().max(500).optional() });
const CodeLoginSchema = z.object({ code: z.string().min(1).max(40), next: z.string().max(500).optional() });

export function requireJson(contentType: string | undefined): void {
  if (!(contentType ?? '').includes('application/json')) throw new AppError('unsupported_media_type', 'Send JSON', 415);
}

export function authRoutes(deps: AppDeps, codeLogin: CodeLogin) {
  const app = new Hono();
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
  app.post('/token-login', async (c) => {
    requireJson(c.req.header('content-type'));
    const body = TokenLoginSchema.parse(await c.req.json());
    const pat = await resolvePat(deps.db, body.token.trim());
    if (!pat) throw new AppError('invalid_token', 'That token is not valid.', 401);
    // Parented to the pasted token, so revoking it signs this browser out too.
    const connectionId = await ensureWebConnection(deps.db, pat.userId, pat.householdId, { id: pat.connectionId, name: `Web (token for ${pat.clientName})` });
    await writeSession(c, deps.config, { u: pat.userId, h: pat.householdId, c: connectionId });
    return c.json({ ok: true, next: safeNext(body.next) });
  });
  app.post('/code-login', async (c) => {
    requireJson(c.req.header('content-type'));
    const body = CodeLoginSchema.parse(await c.req.json());
    const result = await codeLogin.redeem(c, body.code);
    if (result === 'rate_limited') throw new AppError('rate_limited', 'Too many tries. Wait a few minutes and try again.', 429);
    if (result === 'invalid') throw new AppError('invalid_code', "That code didn't work. Check it, or ask your assistant for a new one.", 401);
    return c.json({ ok: true, next: safeNext(body.next) });
  });
  app.post('/logout', (c) => {
    clearSession(c);
    return c.json({ ok: true });
  });
  return app;
}
