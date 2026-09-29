import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, signIn } from './helpers';

// Runs after 04-duplicate, which applied the second receipt, so these items are active.
test('quick actions on an item: freeze, see it move, undo', async ({ page }) => {
  await signIn(page);
  await page.goto('/inventory');
  await page.getByTestId('lot').filter({ hasText: 'Chicken breast' }).first().click();
  await expect(page.locator('header .eyebrow')).toContainText('fridge');

  await page.getByRole('button', { name: 'Freeze' }).click();
  await expect(page.getByRole('status')).toContainText('freezer');
  await expect(page.locator('header .eyebrow')).toContainText('freezer');
  await expect(page.getByRole('button', { name: 'Thaw' })).toBeVisible();
  await expectNoHorizontalScroll(page);

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Undo this change' }).first().click();
  await expect(page.locator('header .eyebrow')).toContainText('fridge');
});

test('using half of something updates its amount', async ({ page }) => {
  await signIn(page);
  await page.goto('/inventory');
  await page.getByTestId('lot').filter({ hasText: 'Whole milk' }).first().click();
  await page.getByRole('button', { name: 'Used half' }).click();
  await expect(page.getByRole('status')).toContainText('Updated the amount');
  await expect(page.locator('dl.facts')).toContainText('0.5');
});
