import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, state } from './helpers';

test.describe('page links from the agent, on a phone', () => {
  test('a link opens that receipt directly, without signing in, and keeps working', async ({ page, browser }) => {
    const { proposal_id, link_code } = state();
    await page.goto(`/review/${proposal_id}?login=${link_code}`);
    await expect(page.getByRole('heading', { name: 'PANTRY CLUB' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/review/${proposal_id}$`));
    await expectNoHorizontalScroll(page);

    // The pass covers this receipt only: anywhere else still asks for a sign-in.
    await page.getByRole('link', { name: 'Inventory' }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Finventory/);

    // The same link works again in another browser while it's live.
    const other = await browser.newPage();
    await other.goto(`/review/${proposal_id}?login=${link_code}`);
    await expect(other.getByRole('heading', { name: 'PANTRY CLUB' })).toBeVisible();
    await other.close();
  });

  test('an expired link lands on sign-in with a message', async ({ page }) => {
    const { proposal_id, expired_code } = state();
    await page.goto(`/review/${proposal_id}?login=${expired_code}`);
    await expect(page).toHaveURL(/\/login\?reason=link_expired/);
    await expect(page.getByText('That link has expired')).toBeVisible();
  });
});
