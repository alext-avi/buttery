import type { Context, MiddlewareHandler } from 'hono';
import { createHmac } from 'node:crypto';
import { getSignedCookie, setSignedCookie } from 'hono/cookie';
import { and, eq, isNotNull } from 'drizzle-orm';
import { changes, changeSets } from '../db/schema';
import type { AppDeps } from '../http/app';
import { NOT_PAGES } from '../http/web';
import { findLoginCode, inHousehold, pageScope, recordLoginCodeUse, type PageScope } from '../identity/loginCodes';
import type { Principal } from '../identity/principal';
import { ensureWebConnection } from '../identity/webConnection';
import { clientIp, createFailureLimiter, type FailureLimiter } from './rateLimit';
import { principalFromSession, readSession, safeNext } from './session';

/**
 * Page passes: opening an agent's link (any number of times while its code is live) grants access to that one page for 24 hours.
 * A pass is not a sign-in: it never touches the session cookie, and every other page still asks the person to sign in.
 */
const COOKIE = 'btr_pass';
/**
 * Hono signs only a cookie's value, so a pass signed with the session key would also verify as a session.
 * Passes get their own derived key: a pass can never be replayed as a sign-in, whatever its shape.
 */
const passKey = (sessionSecret: string) => createHmac('sha256', sessionSecret).update('buttery page pass v1').digest('hex');
const PASS_MS = 24 * 60 * 60_000;
const MAX_PASSES = 10;

type Pass = { k: PageScope['kind']; i: string | null; u: string; h: string; c: string; e: number };
/** What a web API request needs from a pass: a page's own data, or permission to undo a change set. */
type Need = PageScope | { kind: 'undo'; id: string };

async function readPasses(c: Context, secret: string): Promise<Pass[]> {
  const raw = await getSignedCookie(c, secret, COOKIE);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as Pass[];
    return Array.isArray(list) ? list.filter((p) => p && p.e > Date.now()) : [];
  } catch {
    return [];
  }
}

const covers = (p: Pass, scope: PageScope) => p.k === scope.kind && p.i === scope.id;

/** The web API calls a page makes, mapped to the pass that allows them. Everything else needs a sign-in. */
export function apiNeed(method: string, path: string): Need | null {
  const m = /^\/api\/(proposals|items|change-sets)\/([0-9a-f-]{36})(\/resolve|\/undo)?$/i.exec(path);
  if (method === 'GET' && path === '/api/inventory') return { kind: 'inventory', id: null };
  if (!m) return null;
  const [, what, id, action] = m;
  if (what === 'proposals' && ((method === 'GET' && !action) || (method === 'POST' && action === '/resolve'))) return { kind: 'proposal', id: id!.toLowerCase() };
  if (what === 'items' && method === 'GET' && !action) return { kind: 'lot', id: id!.toLowerCase() };
  if (what === 'change-sets' && method === 'POST' && action === '/undo') return { kind: 'undo', id: id!.toLowerCase() };
  return null;
}

export type PageLinks = {
  /** The principal a page pass grants for this API request, if any. */
  principalFor(c: Context, need: Need): Promise<Principal | null>;
  /** Whether the browser holds any live page pass (so a refusal can say "that link only covers one page"). */
  hasPass(c: Context): Promise<boolean>;
  /** Handles `?login=` on page requests: grants the page pass if needed, then redirects to the same URL without it. */
  middleware: MiddlewareHandler;
};

export function createPageLinks(deps: AppDeps, limiter: FailureLimiter = createFailureLimiter()): PageLinks {
  const { db, config } = deps;
  const secret = passKey(config.SESSION_SECRET);
  const live = (p: Pass) => principalFromSession(db, { u: p.u, h: p.h, c: p.c });

  async function undoAllowed(p: Pass, changeSetId: string): Promise<boolean> {
    if (p.k === 'proposal') {
      const [cs] = await db.select({ id: changeSets.id }).from(changeSets).where(and(eq(changeSets.id, changeSetId), eq(changeSets.householdId, p.h), eq(changeSets.causeProposalId, p.i!))).limit(1);
      return Boolean(cs);
    }
    if (p.k === 'lot') {
      // Only a change to this item alone: undoing a whole receipt from an item link would remove other items too.
      const touched = await db
        .selectDistinct({ lotId: changes.lotId })
        .from(changes)
        .where(and(eq(changes.changeSetId, changeSetId), eq(changes.householdId, p.h), isNotNull(changes.lotId)));
      return touched.length === 1 && touched[0]!.lotId === p.i;
    }
    return false;
  }

  async function principalFor(c: Context, need: Need) {
    for (const p of await readPasses(c, secret)) {
      const ok = need.kind === 'undo' ? await undoAllowed(p, need.id) : covers(p, need);
      if (ok) {
        const principal = await live(p);
        if (principal) return principal;
      }
    }
    return null;
  }

  async function grantPass(c: Context, scope: PageScope, grant: { userId: string; householdId: string; connectionId: string; clientName: string }) {
    const connectionId = await ensureWebConnection(db, grant.userId, grant.householdId, { id: grant.connectionId, name: `Web (link from ${grant.clientName})` });
    const pass: Pass = { k: scope.kind, i: scope.id, u: grant.userId, h: grant.householdId, c: connectionId, e: Date.now() + PASS_MS };
    const others = (await readPasses(c, secret)).filter((p) => !covers(p, scope));
    await setSignedCookie(c, COOKIE, JSON.stringify([...others, pass].slice(-MAX_PASSES)), secret, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.PUBLIC_BASE_URL.startsWith('https://'),
      path: '/',
      maxAge: PASS_MS / 1000,
    });
  }

  const middleware: MiddlewareHandler = async (c, next) => {
    const url = new URL(c.req.url);
    const scope = pageScope(url.pathname);
    const raw = url.searchParams.get('login');
    if (c.req.method !== 'GET' || raw === null || !scope || NOT_PAGES.some((p) => url.pathname.startsWith(p))) return next();
    url.searchParams.delete('login');
    const target = safeNext(`${url.pathname}${url.search}`);
    const toLogin = (reason: string) => c.redirect(`/login?reason=${reason}&next=${encodeURIComponent(target)}`);

    // Already able to see the page: just clean the URL. Old links in a chat never count as failed guesses.
    const held = (await readPasses(c, secret)).find((p) => covers(p, scope));
    if (held && (await live(held))) return c.redirect(target);
    const session = await readSession(c, config.SESSION_SECRET);
    const current = session ? await principalFromSession(db, session) : null;
    if (current && (await inHousehold(db, current.householdId, scope))) return c.redirect(target);

    const ip = clientIp(c, config.TRUST_PROXY);
    if (limiter.blocked(ip)) return toLogin('rate_limited');
    const grant = await findLoginCode(db, config, raw);
    // The code only opens the page it was minted for.
    if (!grant || !covers({ k: grant.scope.kind, i: grant.scope.id } as Pass, scope) || !(await recordLoginCodeUse(db, grant.codeId))) {
      limiter.fail(ip);
      return toLogin('link_expired');
    }
    await grantPass(c, scope, grant);
    return c.redirect(target);
  };

  const hasPass = async (c: Context) => (await readPasses(c, secret)).length > 0;

  return { principalFor, hasPass, middleware };
}
