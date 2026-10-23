import { test, expect, isPhone, panel, openView } from './journeys';

test('control hover fades without moving layout and keyboard focus stays immediate', async ({ app }, info) => {
  test.skip(isPhone(), 'Hover is a fine-pointer interaction.');
  await app.getByTestId('composer-bar').click();
  const editor = panel(app);
  await expect(editor).toHaveAttribute('data-entry-settled', '');
  await expect(app.locator('html')).toHaveAttribute('data-sync-quiet', 'false');
  const button = editor.locator('.dt-remind-btn');
  const before = await button.evaluate(el => ({ color: getComputedStyle(el).backgroundColor, width: el.getBoundingClientRect().width }));
  await button.hover();
  const transitions = await button.evaluate(el => el.getAnimations().map(a => (a as CSSTransition).transitionProperty));
  expect(transitions).toContain('background-color');
  await button.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished.catch(() => {}))));
  const after = await button.evaluate(el => ({ color: getComputedStyle(el).backgroundColor, width: el.getBoundingClientRect().width }));
  expect(after.color).not.toBe(before.color);
  expect(after.width).toBe(before.width);
  await app.screenshot({ path: info.outputPath('editor-control-hover.png') });
  await button.focus();
  await app.keyboard.press('Tab');
  expect(await app.locator(':focus').evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
});


test('checklist highlights surround the ring without shifting its content edge', async ({ app }, info) => {
  test.skip(isPhone(), 'Hover is a fine-pointer interaction.');
  for (const view of ['board', 'notes'] as const) {
    await openView(app, view);
    const row = app.locator(view === 'board' ? '.column.todo .card-inline-item:not(.ref)' : '.notes-view .note-item:not(.ref)').filter({ visible: true }).first();
    await row.hover();
    await row.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished.catch(() => {}))));
    const spacing = await row.evaluate(el => {
      const row = el.getBoundingClientRect();
      const ring = el.querySelector('.inline-box,.note-box')!.getBoundingClientRect();
      const card = el.closest('.card-face,.note-card')!;
      const title = card.querySelector('.card-title,.note-title')!.getBoundingClientRect();
      return { left: ring.left - row.left, top: ring.top - row.top, bottom: row.bottom - ring.bottom, alignment: ring.left - title.left };
    });
    expect(spacing.left).toBe(5);
    expect(spacing.top).toBeGreaterThanOrEqual(5);
    expect(spacing.bottom).toBeGreaterThanOrEqual(5);
    expect(spacing.alignment).toBe(0);
    await app.screenshot({ path: info.outputPath(`${view}-checklist-hover.png`) });
  }
});
