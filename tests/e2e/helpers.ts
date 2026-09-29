import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

export const state = () => JSON.parse(readFileSync('apps/server/.e2e/state.json', 'utf8')) as {
    token: string;
    proposal_id: string;
    dup_proposal_id: string;
    link_code: string;
    typed_code: string;
    expired_code: string;
  };

export async function signIn(page: Page) {
  const res = await page.request.post('/auth/token-login', { data: { token: state().token } });
  expect(res.ok()).toBe(true);
}

export async function expectNoHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
