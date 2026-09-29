import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, state } from './helpers';

test.describe('page links from the agent, on a phone', () => {
  test('a link opens that receipt with one tap, without signing in', async ({ page }) => {
    const { proposal_id, link_code } = state();
    await page.goto(`/review/${proposal_id}?login=${link_code}`);
    await expect(page.getByRole('heading', { name: 'Open this receipt' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: 'Open', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'PANTRY CLUB' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/review/${proposal_id}$`));

    // The pass covers this receipt only: anywhere else still asks for a sign-in.
    await page.getByRole('link', { name: 'Inventory' }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Finventory/);
  });

  test('an expired link says so and offers sign-in', async ({ page }) => {
    const { proposal_id, expired_code } = state();
    await page.goto(`/review/${proposal_id}?login=${expired_code}`);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByText('This link has expired or was already used')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in instead' })).toBeVisible();
  });
});
