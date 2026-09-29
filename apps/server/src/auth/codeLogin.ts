import type { Context, MiddlewareHandler } from 'hono';
import type { AppDeps } from '../http/app';
import { findLoginCode, spendLoginCode, type LoginGrant } from '../identity/loginCodes';
import { ensureWebConnection } from '../identity/webConnection';
import { clientIp, createFailureLimiter, type FailureLimiter } from './rateLimit';
import { principalFromSession, readSession, safeNext, writeSession } from './session';

export type CodeLogin = {
  /** Spends a use and signs the browser in, or says why not. */
  redeem(c: Context, raw: string): Promise<'ok' | 'invalid' | 'rate_limited'>;
  /** Redeems `?login=` on page requests, then redirects to the same URL without it. */
  middleware: MiddlewareHandler;
};

// Everything the web app doesn't render as a page.
const NOT_PAGES = ['/api', '/auth/', '/mcp', '/.well-known', '/healthz', '/assets/'];

export function createCodeLogin(deps: AppDeps, limiter: FailureLimiter = createFailureLimiter()): CodeLogin {
  const ipOf = (c: Context) => clientIp(c, deps.config.TRUST_PROXY);

  async function signIn(c: Context, grant: LoginGrant) {
    const connectionId = await ensureWebConnection(deps.db, grant.userId, grant.householdId, { id: grant.connectionId, name: `Web (link from ${grant.clientName})` });
    await writeSession(c, deps.config, { u: grant.userId, h: grant.householdId, c: connectionId });
  }

  async function redeem(c: Context, raw: string) {
    const ip = ipOf(c);
    if (limiter.blocked(ip)) return 'rate_limited' as const;
    const grant = await findLoginCode(deps.db, deps.config, raw);
    if (!grant || !(await spendLoginCode(deps.db, grant.codeId))) {
      limiter.fail(ip);
      return 'invalid' as const;
    }
    await signIn(c, grant);
    return 'ok' as const;
  }

  const middleware: MiddlewareHandler = async (c, next) => {
    const url = new URL(c.req.url);
    const raw = url.searchParams.get('login');
    if (c.req.method !== 'GET' || raw === null || NOT_PAGES.some((p) => url.pathname.startsWith(p))) return next();
    url.searchParams.delete('login');
    const target = safeNext(`${url.pathname}${url.search}`);
    const toLogin = (reason: string) => c.redirect(`/login?reason=${reason}&next=${encodeURIComponent(target)}`);

    const session = await readSession(c, deps.config.SESSION_SECRET);
    const current = session ? await principalFromSession(deps.db, session) : null;
    const ip = ipOf(c);
    if (limiter.blocked(ip)) return current ? c.redirect(target) : toLogin('rate_limited');
    const grant = await findLoginCode(deps.db, deps.config, raw);
    // Already signed in: an old link in the chat shouldn't bounce you to the login screen.
    if (!grant) {
      limiter.fail(ip);
      return current ? c.redirect(target) : toLogin('expired');
    }
    if (current?.userId === grant.userId && current.householdId === grant.householdId) return c.redirect(target);
    if (!(await spendLoginCode(deps.db, grant.codeId))) {
      limiter.fail(ip);
      return current ? c.redirect(target) : toLogin('expired');
    }
    await signIn(c, grant);
    return c.redirect(target);
  };

  return { redeem, middleware };
}
