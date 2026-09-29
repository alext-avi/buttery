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

test('moving an item to another place', async ({ page }) => {
  await signIn(page);
  await page.goto('/inventory');
  await page.getByTestId('lot').filter({ hasText: 'Greek yogurt' }).first().click();
  await page.getByLabel('Move to').selectOption('pantry');
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Moved to the pantry');
  await expect(page.locator('header .eyebrow')).toContainText('pantry');
});

test('finishing an item takes it off the inventory list', async ({ page }) => {
  await signIn(page);
  await page.goto('/inventory');
  await page.getByTestId('lot').filter({ hasText: 'Eggs' }).first().click();
  await page.getByRole('button', { name: 'Finished' }).click();
  await expect(page.getByRole('status')).toContainText('used up');
  await expect(page.getByRole('button', { name: 'Finished' })).toHaveCount(0);
  const itemUrl = page.url();
  await page.goto('/inventory');
  await expect(page.getByTestId('lot').filter({ hasText: 'Eggs' })).toHaveCount(0);
  // A mistaken "Finished" can still be undone from the item's history.
  await page.goto(itemUrl);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Undo this change' }).first().click();
  await expect(page.getByRole('button', { name: 'Finished' })).toBeVisible();
});

test('discarding asks first, then records it', async ({ page }) => {
  await signIn(page);
  await page.goto('/inventory');
  await page.getByTestId('lot').filter({ hasText: 'Baby spinach' }).first().click();
  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('button', { name: 'Discard' })).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('status')).toContainText('thrown away');
  // The confirmation offers an immediate undo.
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Discard' })).toBeVisible();
});
