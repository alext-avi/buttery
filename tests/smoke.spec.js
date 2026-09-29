const { test, expect } = require('@playwright/test');

test('browser launches and renders a page', async ({ page }) => {
  await page.setContent('<h1>Playwright works</h1>');
  await expect(page.locator('h1')).toHaveText('Playwright works');
});

test('can load a live site', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page).toHaveTitle(/Example Domain/);
});
