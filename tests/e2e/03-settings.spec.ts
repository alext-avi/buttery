import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, signIn } from './helpers';

test('settings: rename the household and manage agent tokens', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings?welcome=1');
  await expect(page.getByRole('heading', { name: 'Your household is ready' })).toBeVisible();

  await page.getByLabel('Household name').fill('E2E Kitchen');
  await page.getByRole('button', { name: 'Save household' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');

  await page.getByLabel('Agent name').fill('Codex');
  await page.getByRole('button', { name: 'Create token' }).click();
  const tokenBox = page.getByTestId('new-token');
  await expect(tokenBox).toContainText('btr_');
  await expect(tokenBox).toContainText('claude mcp add --transport http buttery');
  const token = (await tokenBox.getByTestId('token-value').textContent())!.trim();

  const row = page.getByTestId('token-row').filter({ hasText: 'Codex' });
  await row.getByRole('button', { name: 'Revoke' }).click();
  await expect(row).toHaveCount(0);
  const reuse = await page.request.post('/auth/token-login', { data: { token } });
  expect(reuse.status()).toBe(401);
  await expectNoHorizontalScroll(page);
});
