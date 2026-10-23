import { test, expect, pushActions } from './journeys';

test('a signed-in board never flashes the local backup reminder during refresh', async ({ app, account }) => {
  const now = new Date().toISOString();
  await pushActions(account, Array.from({ length: 55 }, (_, i) => ({
    id: `backup-action-${i}`, deviceId: 'backup-test', ts: now, type: 'card.put',
    payload: { card: { id: `backup-${i}`, title: `Saved card ${i}`, notes: '', labels: ['workflow:todo'], workflowVersion: 1, status: 'todo', order: i, items: [], createdAt: now, updatedAt: now, completedAt: null, archivedAt: null } },
  })));
  await app.reload();
  await expect(app.locator('[data-card-id="backup-54"]').first()).toHaveCount(1);
  let probes = 0;
  let resumed = false;
  await app.route('**/kanban/session*', async route => {
    probes++;
    if (probes > 1) await new Promise(resolve => setTimeout(resolve, 1000));
    await route.continue();
    if (probes > 1) resumed = true;
  });
  await app.addInitScript(() => {
    (window as any).__backupFlash = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="banner-backup"]')) (window as any).__backupFlash = true;
    }).observe(document, { childList: true, subtree: true });
  });
  await app.reload();
  await expect.poll(() => probes).toBeGreaterThanOrEqual(2);
  await expect.poll(() => resumed).toBe(true);
  await expect(app.locator('[data-card-id="backup-54"]').first()).toHaveCount(1);
  expect(await app.evaluate(() => (window as any).__backupFlash)).toBe(false);
  await expect(app.getByTestId('banner-backup')).toHaveCount(0);
});
