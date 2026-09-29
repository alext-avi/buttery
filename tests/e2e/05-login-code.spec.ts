import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, state } from './helpers';

test.describe('agent-minted login codes on a phone', () => {
  test('a link with a login code signs a fresh browser in and cleans the URL', async ({ page }) => {
    const { proposal_id, link_code } = state();
    await page.goto(`/review/${proposal_id}?login=${link_code}`);
    await expect(page.getByRole('heading', { name: 'PANTRY CLUB' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/review/${proposal_id}$`));
  });

  test('an expired code lands on the login screen with a friendly message', async ({ page }) => {
    await page.goto(`/inventory?login=${state().expired_code}`);
    await expect(page).toHaveURL(/\/login\?reason=expired/);
    await expect(page.getByText('That sign-in link has expired or was already used')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('typing a code on /login signs in and goes to next', async ({ page }) => {
    await page.goto('/login?next=%2Fsettings');
    await page.getByLabel('Enter the code from your assistant').fill(state().typed_code.toLowerCase().replace('-', ''));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });
});
