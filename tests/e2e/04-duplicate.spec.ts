import { expect, test } from '@playwright/test';
import { signIn, state } from './helpers';

test('a possible duplicate receipt warns and needs confirmation before applying', async ({ page }) => {
  await signIn(page);
  await page.goto(`/review/${state().dup_proposal_id}`);
  const warning = page.getByRole('alert').filter({ hasText: 'may already be recorded' });
  await expect(warning).toBeVisible();
  // One warning only: the duplicate box carries the other reasons.
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.getByTestId('verdict')).toHaveCount(0);
  await expect(warning).toContainText('worth a glance');
  await expect(warning.getByRole('link', { name: 'Open the earlier receipt' })).toBeVisible();
  const apply = page.getByRole('button', { name: /Add all \d+/ });
  await expect(apply).toBeDisabled();
  await page.getByLabel('This is a different purchase').check();
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByRole('status')).toContainText('Added');
});
