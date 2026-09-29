import { Hono } from 'hono';
import { z } from 'zod';
import { IdempotencyKeySchema, shortlist } from '@buttery/domain';
import { principalFromSession, readSession } from '../auth/session';
import { AppError } from '../errors';
import type { Principal } from '../identity/principal';
import { createPat, listPats, revokePat } from '../identity/tokens';
import { undoChangeSet } from '../services/changes';
import { updateHousehold, UpdateHouseholdSchema } from '../services/household';
import { loadCatalog } from '../services/foods';
import { getWhoami } from '../services/identity';
import { getInventoryPage, getItem } from '../services/inventory';
import { getProposalView, resolveProposal, ResolveProposalInputSchema } from '../services/proposals';
import type { AppDeps } from './app';
import { requireJson } from './authRoutes';

export function apiRoutes(deps: AppDeps) {
  const api = new Hono<{ Variables: { principal: Principal } }>();

  api.use('*', async (c, next) => {
    if (c.req.method !== 'GET') requireJson(c.req.header('content-type'));
    const s = await readSession(c, deps.config.SESSION_SECRET);
    const p = s ? await principalFromSession(deps.db, s) : null;
    if (!p) throw new AppError('unauthorized', 'Sign in required', 401);
    c.set('principal', p);
    await next();
  });

  api.get('/me', async (c) => c.json(await getWhoami(deps.db, c.get('principal'), deps.config)));

  api.get('/proposals/:id', async (c) => c.json(await getProposalView(deps, c.get('principal'), z.uuid().parse(c.req.param('id')))));

  api.post('/proposals/:id/resolve', async (c) => {
    const input = ResolveProposalInputSchema.parse({ ...(await c.req.json()), proposal_id: c.req.param('id') });
    return c.json(await resolveProposal(deps, c.get('principal'), input));
  });

  api.get('/inventory', async (c) => c.json(await getInventoryPage(deps, c.get('principal'), { location: c.req.query('location') || undefined })));

  api.get('/items/:id', async (c) => c.json(await getItem(deps, c.get('principal'), z.uuid().parse(c.req.param('id')))));

  api.post('/change-sets/:id/undo', async (c) => {
    const { idempotency_key } = z.object({ idempotency_key: IdempotencyKeySchema }).parse(await c.req.json());
    return c.json(await undoChangeSet(deps.db, c.get('principal'), { change_set_id: z.uuid().parse(c.req.param('id')), idempotency_key }));
  });

  api.get('/foods', async (c) => {
    const foods = await loadCatalog(deps.db, c.get('principal').householdId);
    const q = c.req.query('q');
    const list = q ? shortlist(q, foods, 20, 0.1) : foods.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ foods: list.map((f) => ({ food_id: f.id, name: f.name, category: f.category, perishability: f.perishability })) });
  });

  api.get('/tokens', async (c) => c.json({ tokens: await listPats(deps.db, c.get('principal')), mcp_url: `${deps.config.PUBLIC_BASE_URL}/mcp` }));

  api.post('/tokens', async (c) => {
    const { client_name } = z.object({ client_name: z.string().trim().min(1).max(60) }).parse(await c.req.json());
    const p = c.get('principal');
    const { token, connectionId } = await createPat(deps.db, { userId: p.userId, householdId: p.householdId, clientName: client_name });
    return c.json({ token, connection_id: connectionId, client_name, mcp_url: `${deps.config.PUBLIC_BASE_URL}/mcp` }, 201);
  });

  api.post('/tokens/:id/revoke', async (c) => {
    await revokePat(deps.db, c.get('principal'), z.uuid().parse(c.req.param('id')));
    return c.json({ ok: true });
  });

  api.post('/household', async (c) => {
    const p = c.get('principal');
    await updateHousehold(deps.db, p, UpdateHouseholdSchema.parse(await c.req.json()));
    return c.json(await getWhoami(deps.db, p, deps.config));
  });

  return api;
}
