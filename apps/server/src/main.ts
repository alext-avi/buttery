import { serve } from '@hono/node-server';
import { createAuthkit } from './auth/authkit';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { createApp } from './http/app';
import { resolvePat } from './identity/tokens';
import { createReasoning } from './reasoning/provider';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const authkit = createAuthkit(config, db);
const resolveBearer = async (token: string) => (await resolvePat(db, token)) ?? (authkit ? authkit.resolveBearer(token) : null);
const app = createApp({ config, db, reasoning: createReasoning(db), authkit, resolveBearer });

serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`buttery listening on :${info.port} (${config.PUBLIC_BASE_URL})${authkit ? ' with AuthKit' : ''}`);
});
