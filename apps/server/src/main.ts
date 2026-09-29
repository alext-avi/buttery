import { serve } from '@hono/node-server';
import { createApp } from './http/app';

const port = Number(process.env.PORT ?? 8790);
serve({ fetch: createApp().fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`buttery listening on :${info.port}`);
});
