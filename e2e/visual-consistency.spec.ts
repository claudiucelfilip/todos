import { test, expect, isPhone, openView, noteCard, openFromBoard, panel } from './journeys';

test('a titleless note uses the same text contrast as a titled note', async ({ app }) => {
  await openView(app, 'notes');
  const lead = noteCard(app, 'n3').locator('.note-preview.alone');
  const title = noteCard(app, 'n8').locator('.note-title');
  await expect(lead).toBeVisible();
  await expect(lead).toHaveCSS('color', await title.evaluate(el => getComputedStyle(el).color));
});

test('phone notes give the checklist equal space above and below', async ({ app }) => {
  test.skip(!isPhone(), 'Content-sized phone notes.');
  await openView(app, 'notes');
  const note = noteCard(app, 'd1');
  const gaps = await note.evaluate(el => {
    const title = el.querySelector('.note-title')!.getBoundingClientRect();
    const items = el.querySelector('.note-items')!.getBoundingClientRect();
    const footer = el.querySelector('.note-foot')!.getBoundingClientRect();
    return { above: items.top - title.bottom, below: footer.top - items.bottom };
  });
  expect(gaps.above).toBe(8);
  expect(gaps.below).toBe(gaps.above);
  await expect(note.locator('.note-title')).toHaveCSS('font-size', '16px');
});

test('scroll areas retain local native bounce in browser and installed layouts', async ({ app }) => {
  await openView(app, 'board');
  const body = app.locator('.column.todo .column-body').first();
  await expect(body).toHaveCSS('overscroll-behavior-y', 'contain');
  await openFromBoard(app, 't1', 'todo');
  await expect(panel(app).locator('.dt-scroll')).toHaveCSS('overscroll-behavior-y', 'contain');
  if (!isPhone()) return;
  await expect(panel(app).getByTestId('detail-title')).toHaveCSS('font-size', '22px');
  await app.evaluate(() => document.documentElement.setAttribute('data-ios-standalone', ''));
  await expect(body).toHaveCSS('overscroll-behavior-y', 'contain');
  await expect(panel(app).locator('.dt-scroll')).toHaveCSS('overscroll-behavior-y', 'contain');
  await expect(app.locator('.notes-scroll').first()).toHaveCSS('overscroll-behavior-y', 'contain');
  await panel(app).getByTestId('detail-close').click();
  await openView(app, 'notes');
  await app.getByRole('button', { name: 'More options' }).click();
  await app.getByTestId('settings').click();
  await expect(app.getByRole('dialog', { name: 'Settings' }).locator('.dialog-body')).toHaveCSS('overscroll-behavior-y', 'contain');
});
