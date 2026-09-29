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
    await expect(chicken).toContainText(/Good until about|Best used|Probably past its best/);
    await expect(chicken).toContainText('3 lb');
    await expect(chicken).not.toContainText('1 ×');
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
    await expect(page.getByText('Pantry Club receipt')).toBeVisible();
    await expect(page.getByText('CHKN BREAST 3 LB')).toBeVisible();
    await expect(page.getByText('Estimated from typical shelf life')).toBeVisible();
    await expect(page.getByText('fake-1')).toHaveCount(0);
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Undo this receipt' }).first().click();
    await expect(page.getByRole('status')).toContainText('Undid');
    await expect(page.getByText('fridge · removed')).toBeVisible();
  });
});
