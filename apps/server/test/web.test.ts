import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { createApp } from '../src/http/app';
import { TEST_DB_URL } from './helpers/db';
import { testDeps } from './helpers/app';

describe('SPA serving', () => {
  const dist = mkdtempSync(path.join(tmpdir(), 'buttery-web-'));
  mkdirSync(path.join(dist, 'assets'));
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
  const app = createApp(testDeps({ config: loadConfig({ DATABASE_URL: TEST_DB_URL, SESSION_SECRET: 'x'.repeat(32), WEB_DIST_DIR: dist }) }));

  it('serves index.html for deep links', async () => {
    const res = await app.request('/review/123');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
  });

  it('serves assets and leaves API routes alone', async () => {
    expect(await (await app.request('/assets/app.js')).text()).toContain('console.log');
    expect((await app.request('/api/me')).status).toBe(401);
    expect((await app.request('/api/nope')).status).toBe(401);
  });
});
