import { PNG } from 'pngjs';
import { test, expect, isPhone, openView, pushActions } from './journeys';

for (const theme of ['Royal Blue & Acid Green', 'Ice & Cherry', 'Lime & Deep Violet', 'Ink & Pool Blue']) {
test(`${theme}: scrolling cards visibly changes the backdrop through the open editor`, async ({ app, account }, info) => {
  test.skip(isPhone(), 'Desktop overlapping editor.');
  const now = new Date().toISOString();
  await pushActions(account, Array.from({ length: 24 }, (_, i) => ({
    id: `glass-action-${i}`, deviceId: 'glass-test', ts: now, type: 'card.put',
    payload: { card: { id: `glass-${i}`, title: i % 2 ? `Finished ${i}` : `Finished researching the details and writing a clear plan for the next stage ${i}`, notes: '', labels: ['workflow:done'], workflowVersion: 1, status: 'done', order: -100 + i, items: [], createdAt: now, updatedAt: now, completedAt: now, archivedAt: null } },
  })));
  await app.reload();
  await app.getByTestId('settings').click();
  const settings = app.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('radio', { name: theme, exact: true }).click();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await openView(app, 'board');
  await app.getByTestId('composer-bar').click();
  const editor = app.locator('.dt-panel').filter({ visible: true });
  await editor.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished.catch(() => {}))));
  const bounds = (await editor.boundingBox())!;
  const clip = { x: bounds.x + 48, y: bounds.y + 480, width: 280, height: 220 };
  const before = PNG.sync.read(await app.screenshot({ clip, path: info.outputPath('backdrop-before.png') }));
  const done = app.locator('.pane:not([inert]) .column.done .column-body');
  const doneBounds = (await done.boundingBox())!;
  await app.mouse.move(doneBounds.x + 12, doneBounds.y + 100);
  await app.mouse.wheel(0, 157);
  await expect.poll(() => done.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  await app.screenshot();
  const after = PNG.sync.read(await app.screenshot({ clip, path: info.outputPath('backdrop-after.png') }));
  let changed = 0, total = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const difference = (Math.abs(before.data[i] - after.data[i]) + Math.abs(before.data[i + 1] - after.data[i + 1]) + Math.abs(before.data[i + 2] - after.data[i + 2])) / 3;
    total += difference;
    if (difference >= 6) changed++;
  }
  const pixels = before.width * before.height;
  console.log({ averagePixelChange: total / pixels, visiblyChangedFraction: changed / pixels });
  expect(changed / pixels).toBeGreaterThan(.1);
  await app.screenshot({ path: info.outputPath('editor-with-scrolled-backdrop.png') });
});

}
