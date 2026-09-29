import { serve } from '@hono/node-server';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { createApp } from './http/app';
import { createInterimReasoning } from './reasoning/interim';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const app = createApp({ config, db, reasoning: createInterimReasoning() });

serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`buttery listening on :${info.port} (${config.PUBLIC_BASE_URL})`);
});
