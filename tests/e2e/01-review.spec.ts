import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, signIn, state } from './helpers';

test.describe.serial('receipt review on a phone', () => {
  test('a review link asks for sign-in, then opens the receipt', async ({ page }) => {
    const { token, proposal_id } = state();
    await page.goto(`/review/${proposal_id}`);
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByLabel('Access token').fill(token);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'PANTRY CLUB' })).toBeVisible();
    await expect(page.getByText('GRK YOGURT 2X32 OZ')).toBeVisible();
    // The verdict tells the user how much attention this receipt needs.
    await expect(page.getByTestId('verdict')).toContainText('worth a glance');
    await expect(page.getByText('shared by Alex via Claude iOS')).toBeVisible();
    // Estimated expiry reads as plain language, without model or confidence jargon.
    const chicken = page.getByTestId('op').filter({ hasText: 'CHKN BREAST 3 LB' });
    await expect(chicken).toContainText(/Good until about|Best used|Probably past its best/);
    await expect(chicken).not.toContainText('model_estimate');
    await expect(chicken).not.toContainText('confidence');
    await expectNoHorizontalScroll(page);
  });

  test('edit one line, skip one, apply the rest, then undo', async ({ page }) => {
    await signIn(page);
    await page.goto(`/review/${state().proposal_id}`);
    const yogurt = page.getByTestId('op').filter({ hasText: 'GRK YOGURT 2X32 OZ' });
    await yogurt.getByRole('button', { name: 'Edit' }).click();
    await yogurt.getByLabel('Location').selectOption('freezer');
    await yogurt.getByRole('button', { name: 'Save' }).click();
    await expect(yogurt.getByText('Edited')).toBeVisible();
    await expect(yogurt).toContainText('2 × 32 oz');

    const berries = page.getByTestId('op').filter({ hasText: 'STRAWBERRIES 2 LB' });
    await berries.getByRole('button', { name: 'Skip' }).click();

    await page.getByRole('button', { name: 'Add 5 items' }).click();
    await expect(page.getByRole('status')).toContainText('Added 5 items');
    await expect(yogurt).toContainText('freezer');
    await expect(yogurt).toContainText('2 × 32 oz');
    await expect(yogurt.getByText('Added')).toBeVisible();

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('button', { name: /Add \d+ items?/ })).toBeVisible();
  });

  test('re-apply everything for the inventory tests', async ({ page }) => {
    await signIn(page);
    await page.goto(`/review/${state().proposal_id}`);
    // Strawberries were skipped (rejected) earlier; undo only reopens applied lines, so re-add them explicitly.
    await page.getByTestId('op').filter({ hasText: 'STRAWBERRIES 2 LB' }).getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Add 6 items' }).click();
    await expect(page.getByRole('status')).toContainText('Added 6 items');
  });
});
