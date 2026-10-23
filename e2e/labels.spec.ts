import { isCardDone } from '../shared/notes.mjs';
// Journeys 11-13 (§13): filter by label, create a label with a colour, accept a suggestion.
import { expect, isPhone, K, labelNames, noteCard, openFromNotes, openLabels, openView, panel, scope, test, toast } from './journeys';

const gridIds = async (page: import('@playwright/test').Page) =>
  (await scope(page).locator('.notes-grid [data-testid^="note-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.replace('note-', '')))).sort();

test('11. filter by label: only Home cards stay; All brings everything back', async ({ app, api }) => {
  await openView(app, 'notes');
  const all = await gridIds(app);
  const snap = await api.snapshot();
  const home = snap.cards.filter((c) => !c.archivedAt && !isCardDone(c) && labelNames(snap, c).includes('Home')).map((c) => c.id).sort();
  expect(home.length).toBeGreaterThan(2);
  expect(all.length).toBeGreaterThan(home.length);

  await openLabels(app);
  await app.getByTestId('labels-row-all').click();
  await app.getByTestId('labels-row-all').click();
  await app.getByTestId('labels-row-home').click();
  await app.keyboard.press('Escape');
  await expect(app.getByTestId('label-filter').first()).toContainText(isPhoneText('Labels · 1'));
  await expect.poll(() => gridIds(app)).toEqual(home);

  await openLabels(app);
  await app.getByTestId('labels-row-all').click();
  await app.keyboard.press('Escape');
  await expect.poll(() => gridIds(app)).toEqual(snap.cards.filter(c => !c.archivedAt && !c.draft).map(c => c.id).sort());
});
function isPhoneText(desktop: string) {
  return test.info().project.name === 'phone' ? '1' : desktop;
}

test('12. create a label with a colour: the grid stays unfiltered, the menu stays open and the panel picker offers it', async ({ app, api }) => {
  await openView(app, 'notes');
  const before = await gridIds(app);
  await openLabels(app);
  // 11 presets plus the custom swatch, in the shared filter panel (as drawn).
  const menu = app.locator('.labels-menu');
  if (!isPhone()) expect(Math.round((await menu.boundingBox())!.width)).toBe(410);
  const find = app.getByPlaceholder('Find or add a label');
  await find.fill('Garden');
  await expect(app.getByTestId('labels-create')).toBeVisible();
  const swatches = app.locator('.labels-create').getByRole('radio');
  await expect(swatches).toHaveCount(11);
  await expect(app.locator('.labels-create .swatch-custom')).toHaveCount(1);
  const third = await swatches.nth(2).getAttribute('aria-label');
  await swatches.nth(2).click();
  await find.focus();
  await find.press('Enter');

  await expect.poll(async () => (await api.snapshot()).labels.find((l: any) => l.name === 'Garden')?.color.toLowerCase()).toBe(third!.toLowerCase());
  const garden = (await api.snapshot()).labels.find((l: any) => l.name === 'Garden');
  // §11.24.2: no filter, the new row highlighted, the menu still open, and a toast says so.
  await expect(menu).toBeVisible();
  await expect(app.getByTestId('label-settings')).toBeVisible();
  await app.getByRole('button', { name: 'Back to labels', exact: true }).click();
  await expect(app.getByTestId(`labels-row-${garden.id}`)).toHaveAttribute('aria-checked', 'true');
  await expect(app.locator('.labels-row.fresh')).toContainText('Garden');
  await expect(toast(app)).toContainText("Label 'Garden' created");
  if (!isPhone()) await expect(app.getByTestId('label-filter').first()).toHaveText('Labels');
  await expect(app.getByTestId('filter-empty')).toHaveCount(0);
  await expect.poll(() => gridIds(app)).toEqual(before);
  await app.keyboard.press('Escape');
  await expect(app.getByRole('dialog', { name: /Labels/ })).toBeHidden();
  await expect(app.locator('.phone-more-menu')).toHaveCount(0); // one Esc: no ··· menu left behind
  // offered in the panel's label picker
  await scope(app).locator('[data-testid^="note-"]').first().click({ position: { x: 14, y: 40 } });
  await expect(panel(app)).toBeVisible();
  await panel(app).getByTestId('detail-add-label').click();
  await expect(app.getByRole('dialog', { name: /label/i }).getByText('Garden')).toBeVisible();
});

test('12b. a filter with no cards says so, counts the title, and Clear filter brings the grid back', async ({ app, api }) => {
  await openView(app, 'notes');
  const all = await gridIds(app);
  const total = (await api.cards()).filter(c => !c.archivedAt && !c.draft).length;
  await openLabels(app);
  await app.getByTestId('labels-row-all').click();
  await app.getByTestId('labels-row-all').click();
  const find = app.getByPlaceholder('Find or add a label');
  await find.fill('Garden');
  await find.press('Enter');
  await app.getByRole('button', { name: 'Back to labels', exact: true }).click();
  const garden = app.locator('.labels-row', { hasText: 'Garden' }).getByRole('menuitemcheckbox');
  await garden.click();
  await app.keyboard.press('Escape');
  if (isPhone()) await app.keyboard.press('Escape');
  const empty = app.getByTestId('filter-empty');
  await expect(empty).toContainText('No cards labelled Garden');
  await expect(app.getByText('Nothing here yet')).toHaveCount(0);
  const heading = empty.locator('.filter-empty-title');
  expect(await heading.evaluate((e) => [getComputedStyle(e).fontSize, getComputedStyle(e).fontWeight])).toEqual(['20px', '600']);
  if (!isPhone()) await expect(app.locator('.topbar-title h1')).toHaveText(`Notes 0 of ${total}`);
  await empty.getByRole('button', { name: 'Clear filter' }).click();
  await expect.poll(() => gridIds(app)).toEqual(all);
  if (!isPhone()) await expect(app.locator('.topbar-title h1')).toHaveText(`Notes ${all.length} of ${total}`);
});

test('13. accept a label suggestion: the dashed chip becomes a solid label everywhere', async ({ app, api }) => {
  await openView(app, 'notes');
  const chip = noteCard(app, 'n0').getByRole('button', { name: 'Add label Errands, suggested' });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect.poll(async () => labelNames(await api.snapshot(), (await api.cards()).find((c) => c.id === K('n0')))).toContain('Errands');
  expect((await api.cards()).find((c) => c.id === K('n0')).suggestedLabel).toBeFalsy();
  await expect(app.getByRole('button', { name: /Add label Errands, suggested/ })).toHaveCount(0);
  await expect(noteCard(app, 'n0')).toContainText('Errands');
  await noteCard(app, 'n0').click({ position: { x: 14, y: 40 } });
  await expect(panel(app).getByRole('button', { name: /Add label Errands, suggested/ })).toHaveCount(0);
  await expect(panel(app).locator('.label-pill', { hasText: 'Errands' })).toBeVisible();
});
