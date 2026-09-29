// Read-only checks; never imports fixtures or changes a household.
import assert from 'node:assert/strict';
const base = process.argv[2];
assert.ok(base, 'Usage: node scripts/smoke-demo.mjs <base-url>');
async function get(path, options = {}) {
  return fetch(new URL(path, `${base.replace(/\/$/, '')}/`), { signal: AbortSignal.timeout(15000), ...options });
}
const health = await get('/healthz');
assert.equal(health.status, 200, 'Health endpoint');
assert.equal((await health.json()).ok, true, 'Database health');
const page = await get('/');
assert.equal(page.status, 200, 'Web UI');
const html = await page.text();
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map(m => m[1]);
assert.ok(assets.some(p => p.endsWith('.js')), 'Built JS asset referenced by UI');
for (const asset of assets) {
  const response = await get(asset);
  assert.equal(response.status, 200, `UI asset ${asset}`);
  assert.ok(!response.headers.get('content-type')?.includes('text/html'), `Asset ${asset} must not be the SPA fallback`);
}
const mcp = await get('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'release-smoke', version: '1.0.0' } } }) });
assert.equal(mcp.status, 401, 'MCP must require authentication');
console.log('PASS: health, web UI, built assets, and MCP authentication boundary.');
