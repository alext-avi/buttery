import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app';
import { testDeps } from './helpers/app';

describe('health', () => {
  it('responds ok', async () => {
    const res = await createApp(testDeps()).request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
