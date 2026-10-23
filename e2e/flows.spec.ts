import { test, expect, isPhone, openFromNotes, panel, closePanel, pushActions, setFields } from './journeys';
import type { Page } from '@playwright/test';

async function settings(page: Page) {
  if (isPhone()) await page.getByRole('button', { name: 'More options' }).click();
  await page.getByTestId('settings').click();
  return page.getByRole('dialog', { name: 'Settings', exact: true });
}

test('create a flow, move a note, finish/reopen, and reload with saved history', async ({ app, api }, info) => {
  const dialog = await settings(app);
  await dialog.getByRole('button', { name: 'Create flow', exact: true }).click();
  await dialog.getByRole('button', { name: 'Use Editorial example', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save flow', exact: true }).click();
  await expect(dialog.locator('.flow-overview').filter({ hasText: 'Editorial' })).toContainText('Published');
  await expect.poll(async () => (await api.snapshot()).labels.filter(l => l.group === 'Editorial').length).toBe(3);
  await dialog.locator('.flow-overview').filter({ hasText: 'Editorial' }).getByRole('button', { name: 'Use as board columns' }).click();
  await expect(dialog).toBeInViewport();
  await app.screenshot({ path: info.outputPath('flows-settings.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await openFromNotes(app, 'n0');
  const editor = panel(app);
  await editor.getByTestId('detail-add-label').click();
  const picker = app.getByRole('dialog', { name: 'Add label', exact: true });
  await expect(picker.getByRole('radio', { name: 'Done', exact: true })).toBeEnabled();
  await expect(picker.getByRole('radio', { name: 'Published', exact: true })).toBeEnabled();
  await expect(picker.getByRole('radio', { name: 'To do', exact: true })).toBeEnabled();
  await expect(picker.getByRole('radio', { name: 'Doing', exact: true })).toBeEnabled();
  await picker.getByRole('radio', { name: 'Draft', exact: true }).check();
  await picker.getByRole('radio', { name: 'Review', exact: true }).check();
  await app.keyboard.press('Escape');
  await expect(editor.locator('.dt-chips')).toContainText('Review');
  await editor.getByRole('button', { name: 'Mark done', exact: true }).click();
  await expect(editor.locator('.dt-chips')).toContainText('Published');
  await expect.poll(async () => (await api.cards()).find(c => c.id === 'v6-n0')?.status).toBe('done');
  const saved = (await api.cards()).find(c => c.id === 'v6-n0');
  expect(saved.reopenStage).toBe((await api.snapshot()).labels.find(l => l.name === 'Review')?.id);
  expect(saved.archivedAt).toBeNull();
  await editor.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(editor.locator('.dt-chips')).toContainText('Review');
  await expect(editor.locator('.dt-chips')).not.toContainText('To do');
  await expect.poll(async () => (await api.cards()).find(c => c.id === 'v6-n0')?.status).toBe('doing');
  await editor.getByRole('button', { name: 'Mark done', exact: true }).click();
  await expect.poll(async () => (await api.cards()).find(c => c.id === 'v6-n0')?.status).toBe('done');
  await app.reload();
  await expect(panel(app)).toBeVisible();
  await expect(panel(app).locator('.dt-chips')).toContainText('Published');
  await panel(app).getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(panel(app).locator('.dt-chips')).toContainText('Review');
  await app.screenshot({ path: info.outputPath('flow-note-review.png'), animations: 'disabled' });
  await closePanel(app);
  const reopened = await settings(app);
  await reopened.getByRole('button', { name: 'Edit Editorial flow', exact: true }).click();
  await reopened.getByRole('textbox', { name: 'Stage 2', exact: true }).fill('Ready for review');
  await reopened.getByRole('button', { name: 'Save flow', exact: true }).click();
  await expect(reopened.getByRole('status')).toContainText('1 note');
  await reopened.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect.poll(async () => (await api.snapshot()).labels.some(l => l.name === 'Ready for review')).toBe(true);
  await reopened.getByRole('button', { name: 'Close', exact: true }).click();
  await openFromNotes(app, 'n0');
  await expect(panel(app).locator('.dt-chips')).toContainText('Ready for review');
  expect(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test('offline completion syncs and another device can change the same custom stage', async ({ app, api, account }) => {
  const stages = ['Draft', 'Review', 'Published'].map((name, order) => ({ id: `offline-${order}`, name, color: '#123456', group: 'Offline editorial', flowStage: { order, finished: order === 2 } }));
  await pushActions(account, stages.map(label => ({ ...setFields('', {}), type: 'label.put', payload: { label } })));
  await app.reload();
  await openFromNotes(app, 'n0');
  await panel(app).getByTestId('detail-add-label').click();
  await app.getByRole('dialog', { name: 'Add label', exact: true }).getByRole('radio', { name: 'Review', exact: true }).check();
  await app.keyboard.press('Escape');
  await expect.poll(async () => (await api.cards()).find(c => c.id === 'v6-n0')?.labels.includes('offline-1')).toBe(true);
  await app.context().setOffline(true);
  try {
    await panel(app).getByRole('button', { name: 'Mark done', exact: true }).click();
    await expect(panel(app).locator('.dt-chips')).toContainText('Published');
    expect((await api.cards()).find(c => c.id === 'v6-n0')?.labels).toContain('offline-1');
  } finally { await app.context().setOffline(false); }
  await expect.poll(async () => (await api.cards()).find(c => c.id === 'v6-n0')?.labels.includes('offline-2')).toBe(true);
  await expect.poll(async () => (await api.cards()).find(c => c.id === 'v6-n0')?.status).toBe('done');
  await pushActions(account, [setFields('v6-n0', { labels: ['offline-1'] })]);
  await expect(panel(app).locator('.dt-chips')).toContainText('Review');
  await expect(panel(app).getByRole('button', { name: 'Mark done', exact: true })).toBeVisible();
  expect((await api.cards()).find(c => c.id === 'v6-n0')?.completedAt).toBeNull();
});


test('an existing label group becomes a flow with an impact preview and undo', async ({ app, api, account }) => {
  const labels = ['Idea', 'Released'].map((name, n) => ({ id: `existing-${n}`, name, color: '#123456', group: 'Writing' }));
  await pushActions(account, labels.map(label => ({ ...setFields('', {}), type: 'label.put', payload: { label } })));
  await pushActions(account, [setFields('v6-n0', { labels: ['existing-0', 'workflow:doing'] })]);
  await app.reload();
  const dialog = await settings(app);
  await dialog.getByRole('button', { name: 'Create flow', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Start from', exact: true }).selectOption('Writing');
  await expect(dialog.getByRole('textbox', { name: 'Stage 1', exact: true })).toHaveValue('Idea');
  await dialog.getByRole('button', { name: 'Save flow', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('1 note');
  await dialog.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect.poll(async () => (await api.cards()).find(c => c.id === 'v6-n0')?.labels).toEqual(['existing-0']);
  await expect.poll(async () => (await api.snapshot()).labels.find(l => l.id === 'existing-1')?.flowStage?.finished).toBe(true);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await app.getByTestId('toast').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await api.cards()).find(c => c.id === 'v6-n0')?.labels).toEqual(['existing-0', 'workflow:doing']);
  await expect.poll(async () => (await api.snapshot()).labels.find(l => l.id === 'existing-1')?.flowStage).toBeFalsy();
});
