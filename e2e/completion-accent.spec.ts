import { test, expect, isPhone, openView, openColumn, panel } from './journeys';

test('completion icons use the accent while empty rings match the unfinished track', async ({ app, api }, info) => {
  await openView(app, 'board');
  const board = app.locator('.board');
  const empty = await board.locator('.ring6-todo').first().evaluate(e => getComputedStyle(e).backgroundColor);
  const progress = await board.locator('.ring6-doing').first().evaluate(e => getComputedStyle(e).backgroundImage);
  const done = await board.locator('.ring6-done').first().evaluate(e => ({ color: getComputedStyle(e).color, border: getComputedStyle(e).borderTopColor }));
  expect(progress).toContain(empty);
  expect(progress).toContain(done.color);
  expect(done.border).toBe(done.color);
  const checked = await board.locator('.card-inline-item.checked .inline-box').first().evaluate(e => ({ color: getComputedStyle(e).color, border: getComputedStyle(e).borderTopColor }));
  expect(checked).toEqual(done);
  const card = (await api.cards()).find(c => c.status === 'doing' && c.items.some((i: { done: boolean }) => i.done));
  await openColumn(app, 'doing');
  await board.locator(`[data-card-id="${card.id}"]`).getByRole('heading').click();
  const editor = panel(app);
  const local = await editor.locator('.dt-row.checked .dt-box').first().evaluate(e => ({ color: getComputedStyle(e).color, border: getComputedStyle(e).borderTopColor }));
  expect(local.border).toBe(local.color);
  expect(await editor.locator('.ring6-doing').evaluate(e => getComputedStyle(e).backgroundImage)).toContain(local.color);
  await app.screenshot({ path: info.outputPath(`completion-accent-${isPhone() ? 'phone' : 'desktop'}.png`) });
});
