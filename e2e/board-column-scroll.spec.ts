import { test, expect, isPhone, openView, pushActions, setFields, K } from './journeys';

test('desktop columns scroll independently with fixed headings', async ({ app, account }, info) => {
  test.skip(isPhone(), 'Desktop columns; phone uses its own scrolling layout.');
  await pushActions(account, [setFields(K('n0'), { notes: 'Long board content.\n'.repeat(180), labels: ['workflow:todo'] })]);
  await app.reload();
  await openView(app, 'board');
  const bodies = app.locator('.pane:not([inert]) .column-body');
  const done = app.locator('.pane:not([inert]) .column.done .column-body');
  const todo = app.locator('.pane:not([inert]) .column.todo .column-body');
  const header = app.locator('.pane:not([inert]) .column.todo .column-header');
  const top = (await header.boundingBox())!.y;
  await expect(todo).toHaveCSS('overflow-y', 'auto');
  expect(Math.round((await todo.boundingBox())!.y + (await todo.boundingBox())!.height)).toBe(app.viewportSize()!.height);
  const box = (await todo.boundingBox())!;
  const headerBounds = (await header.boundingBox())!;
  expect(box.y).toBe(headerBounds.y + headerBounds.height);
  expect((await todo.locator('.card-face').first().boundingBox())!.y).toBe(box.y + 20);
  await app.mouse.move(box.x + 20, box.y + 80);
  await app.mouse.wheel(0, 400);
  await expect.poll(() => todo.evaluate(e => e.scrollTop)).toBeGreaterThan(0);
  expect(await done.evaluate(e => e.scrollTop)).toBe(0);
  expect((await header.boundingBox())!.y).toBe(top);
  expect(await app.locator('.pane-board').evaluate(e => e.scrollTop)).toBe(0);
  expect(await bodies.evaluateAll(els => els.every(e => e.getBoundingClientRect().bottom <= innerHeight))).toBe(true);
  await app.screenshot({ path: info.outputPath('independent-columns.png') });
});
