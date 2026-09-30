import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, signIn, state } from './helpers';

test.describe.serial('receipt review on a phone', () => {
  test('a plain review link asks for sign-in; signed in, it opens the receipt', async ({ page }) => {
    const { proposal_id } = state();
    await page.goto(`/review/${proposal_id}`);
    await expect(page).toHaveURL(/\/login\?next=/);
    // Account sign-in only: there is no token box in the web app.
    await expect(page.getByLabel('Access token')).toHaveCount(0);
    await expect(page.getByTestId('no-account-sign-in')).toBeVisible();
    await signIn(page);
    await page.goto(`/review/${proposal_id}`);
    await expect(page.getByRole('heading', { name: 'PANTRY CLUB' })).toBeVisible();
    await expect(page.getByText('GRK YOGURT 2X32 OZ')).toBeVisible();
    // The verdict tells the user how much attention this receipt needs.
    await expect(page.getByTestId('verdict')).toContainText('worth a glance');
    // The page follows the verdict: every line that isn't high confidence is counted and marked.
    await expect(page.getByTestId('stat-to-check')).toContainText('6');
    await expect(page.getByTestId('op').filter({ hasText: 'WHOLE MILK 1 GAL' })).toContainText('Worth a glance');
    await expect(page.getByText('shared by Alex via Claude iOS')).toBeVisible();
    // Estimated expiry reads as plain language, without model or confidence jargon.
    const chicken = page.getByTestId('op').filter({ hasText: 'CHKN BREAST 3 LB' });
    await expect(chicken).toContainText(/Good until about|Best used|Probably past its best/);
    await expect(chicken).not.toContainText('model_estimate');
    await expect(chicken).not.toContainText('confidence');
    await expectNoHorizontalScroll(page);
  });

  test('each button saves at once: edit and add one, skip one, add the rest, undo one', async ({ page }) => {
    await signIn(page);
    await page.goto(`/review/${state().proposal_id}`);
    const yogurt = page.getByTestId('op').filter({ hasText: 'GRK YOGURT 2X32 OZ' });
    await yogurt.getByRole('button', { name: 'Edit' }).click();
    await yogurt.getByLabel('Location').selectOption('freezer');
    await yogurt.getByRole('button', { name: 'Save and add' }).click();
    await expect(page.getByRole('status')).toContainText('Added');
    await expect(yogurt.getByText('Added')).toBeVisible();
    await expect(yogurt).toContainText('freezer');
    await expect(yogurt).toContainText('2 × 32 oz');

    const berries = page.getByTestId('op').filter({ hasText: 'STRAWBERRIES 2 LB' });
    await berries.getByRole('button', { name: 'Skip' }).click();
    await expect(berries.getByText('Skipped')).toBeVisible();

    await page.getByRole('button', { name: 'Add all 4' }).click();
    await expect(page.getByRole('status')).toContainText('Added 4 items');
    // Nothing is left undecided, so the shortcut goes away (the skipped line stays skipped).
    await expect(page.locator('.action-bar')).toHaveCount(0);

    // Undo is per line: only the yogurt goes back to review.
    await yogurt.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('status')).toContainText('Undone');
    await expect(yogurt.getByRole('button', { name: 'Add', exact: true })).toBeVisible();
    await expect(page.getByTestId('op').filter({ hasText: 'WHOLE MILK 1 GAL' }).getByText('Added')).toBeVisible();
  });

  test('re-add the undone and skipped lines for the inventory tests', async ({ page }) => {
    await signIn(page);
    await page.goto(`/review/${state().proposal_id}`);
    for (const line of ['STRAWBERRIES 2 LB', 'GRK YOGURT 2X32 OZ']) {
      const op = page.getByTestId('op').filter({ hasText: line });
      await op.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(op.getByText('Added')).toBeVisible();
    }
  });
});
