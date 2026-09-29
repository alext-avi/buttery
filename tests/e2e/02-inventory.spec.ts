import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, signIn, state } from './helpers';

test.describe.serial('inventory on a phone', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    const res = await page.request.post(`/api/proposals/${state().proposal_id}/resolve`, {
      data: { decisions: [], accept_remaining: true, apply: true, idempotency_key: `e2e-inv-${Date.now()}` },
    });
    expect(res.ok()).toBe(true);
  });

  test('shows what to use soon with estimate labels', async ({ page }) => {
    await page.goto('/inventory');
    await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();
    const chicken = page.getByTestId('lot').filter({ hasText: 'Chicken breast' }).first();
    await expect(chicken).toContainText('est.');
    await expect(chicken).toContainText('1 × 3 lb');
    await expectNoHorizontalScroll(page);
  });

  test('filters by location', async ({ page }) => {
    await page.goto('/inventory?location=pantry');
    await expect(page.getByText('Nothing here yet')).toBeVisible();
  });

  test('an item explains its evidence and can be undone', async ({ page }) => {
    await page.goto('/inventory');
    await page.getByTestId('lot').filter({ hasText: 'Chicken breast' }).first().click();
    await expect(page.getByRole('heading', { name: 'Chicken breast' })).toBeVisible();
    await expect(page.getByText('Receipt · PANTRY CLUB · 2026-09-28')).toBeVisible();
    await expect(page.getByText('CHKN BREAST 3 LB')).toBeVisible();
    await expect(page.getByText(/Estimated: bought 2026-09-28 \+ 5d/)).toBeVisible();
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Undo this receipt' }).first().click();
    await expect(page.getByRole('status')).toContainText('Undid');
    await expect(page.getByText('voided')).toBeVisible();
  });
});
