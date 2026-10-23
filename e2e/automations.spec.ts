import { test, expect, openLabels, isPhone } from './journeys';

const menu = (page: import('@playwright/test').Page) => page.locator('.labels-menu');
async function editLabel(page: import('@playwright/test').Page, name: string) {
  await openLabels(page);
  await menu(page).getByRole('button', { name: `Edit ${name}`, exact: true }).click();
  await expect(page.getByTestId('label-settings')).toBeVisible();
}

test('label rules can be disabled, restored and edited without changing notes', async ({ app, api }) => {
  const before = (await api.cards()).map(c => [c.id, c.labels, c.items]);
  await editLabel(app, 'Done');
  const toggle = app.getByRole('switch', { name: 'Enable automation 1', exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await api.snapshot()).labels.find(l => l.id === 'workflow:done')?.automations?.[0]?.enabled).toBe(false);
  await app.getByRole('button', { name: 'Restore default automations' }).click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await app.locator('.automation-summary').first().click();
  await expect(app.locator('.automation-editor')).toBeVisible();
  await app.locator('.automation-editor').getByLabel('When', { exact: true }).selectOption('partial');
  await app.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(app.locator('.automation-summary').first()).toContainText('All checklist items are complete');
  expect((await api.cards()).map(c => [c.id, c.labels, c.items])).toEqual(before);
  const box = await menu(app).boundingBox(); const viewport = app.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  await app.screenshot({ path: `/private/tmp/todos-automations-${isPhone() ? 'phone' : 'desktop'}.png` });
});

test('create a label, group and automation from the filter panel; save, reload and delete rule', async ({ app, api }) => {
  await openLabels(app);
  await app.getByPlaceholder('Find or add a label').fill('Garden automation');
  await app.getByTestId('labels-create').click();
  const settings = app.getByTestId('label-settings');
  await expect(settings).toBeVisible();
  await settings.getByRole('switch', { name: 'Remove when note is opened', exact: true }).click();
  await expect.poll(async () => (await api.snapshot()).labels.find(l => l.name === 'Garden automation')?.removeOnView).toBe(true);
  await settings.getByRole('combobox', { name: 'Label group', exact: true }).fill('Area');
  await settings.getByRole('combobox', { name: 'Label group', exact: true }).press('Tab');
  await settings.getByRole('button', { name: 'Add automation' }).click();
  await settings.locator('.automation-editor').getByLabel('When', { exact: true }).selectOption('complete');
  await settings.locator('.automation-editor').getByLabel('Then', { exact: true }).selectOption('add');
  await settings.locator('.automation-editor').getByLabel('Label', { exact: true }).selectOption('workflow:done');
  await settings.getByRole('button', { name: 'Save automation', exact: true }).click();
  await expect.poll(async () => (await api.snapshot()).labels.find(l => l.name === 'Garden automation')?.automations?.length).toBe(1);
  await app.reload();
  await editLabel(app, 'Garden automation');
  await expect(settings.getByRole('switch', { name: 'Remove when note is opened', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(settings.getByRole('combobox', { name: 'Label group', exact: true })).toHaveValue('Area');
  await settings.locator('.automation-summary').click();
  await settings.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(async () => (await api.snapshot()).labels.find(l => l.name === 'Garden automation')?.automations?.length).toBe(0);
  await app.getByRole('button', { name: 'Back to labels', exact: true }).click();
  await expect(app.getByPlaceholder('Find or add a label')).toBeVisible();
});

test('the saved rules preview follows nested progress, and outside tap closes the panel', async ({ app }) => {
  await editLabel(app, 'Doing');
  await app.getByText('Try with sample items', { exact: true }).click();
  await app.getByLabel('Buy ingredients is Doing', { exact: true }).check();
  await expect(app.locator('.automation-preview-result')).toContainText('Doing');
  await app.getByLabel('Buy ingredients linked note', { exact: true }).check();
  await app.getByLabel('Set the table', { exact: true }).check();
  await expect(app.locator('.automation-preview-result')).toContainText('Done');
  await app.getByLabel('Set the table', { exact: true }).uncheck();
  await app.getByLabel('Buy ingredients linked note', { exact: true }).uncheck();
  await expect(app.locator('.automation-preview-result')).not.toContainText('Done');
  await expect(app.locator('.automation-preview-result')).toContainText('Doing');
  if (isPhone()) await app.locator('.labels-scrim').click({ position: { x: 3, y: 3 } });
  else await app.locator('.topbar-title').click();
  await expect(menu(app)).toHaveCount(0);
});
