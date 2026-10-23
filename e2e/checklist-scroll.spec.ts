import { diffCards } from '../shared/merge.mjs';
import { test, expect, isPhone, openColumn, openView } from './journeys';

test('a five-item checklist with two completed items scrolls to the completed rows', async ({ app, api, account }) => {
  const original = (await api.cards()).find(c => c.title === 'Routine checkup');
  const updated = {
    ...original,
    items: Array.from({ length: 5 }, (_, i) => ({ id: `scroll-${i}`, text: `Garden step ${i + 1}`, done: i >= 3 })),
  };
  const response = await app.request.post(`${account.base}/kanban/push`, {
    headers: { cookie: account.cookie },
    data: { deviceId: 'checklist-scroll', actions: diffCards([original], [updated], new Date().toISOString(), 'checklist-scroll') },
  });
  expect(response.ok()).toBe(true);
  await app.reload();
  await openView(app, 'board');
  await openColumn(app, (await api.cardByTitle('Routine checkup')).status);
  const card = app.locator(`.card-face[data-card-id="${original.id}"]`);
  const list = card.getByRole('group', { name: 'Checklist' });
  await expect(list.locator('.card-inline-item')).toHaveCount(5);
  await expect(card.locator('.card-count')).toHaveCount(0);
  await expect(card.locator('.card-meta')).not.toContainText('2/5');
  await list.scrollIntoViewIfNeeded();
  const box = (await list.boundingBox())!;
  if (isPhone()) {
    const cdp = await app.context().newCDPSession(app);
    const x = Math.round(box.x + 100), y = Math.round(box.y + 80);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 5; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 12 }] });
      await app.waitForTimeout(30);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await app.mouse.move(box.x + 100, box.y + 50);
    await app.mouse.wheel(0, 100);
  }
  await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  const last = list.getByRole('button', { name: 'Garden step 5', exact: true });
  await expect(last).toHaveAttribute('aria-pressed', 'true');
  await last.click();
  await expect.poll(async () => (await api.cardByTitle('Routine checkup')).items.find((i: { id: string }) => i.id === 'scroll-4').done).toBe(false);
  await expect(list.locator('.card-inline-item')).toHaveCount(5);
  await expect(app.locator('.dt-panel:visible, .dt-sheet:visible')).toHaveCount(0);
  expect(await list.evaluate(el => getComputedStyle(el).scrollbarWidth)).toBe('none');
  for (const footer of await app.locator('.card-meta:empty').all()) {
    await expect(footer).toBeHidden();
  }
  await openView(app, 'notes');
  const note = app.locator(`.note-card[data-card-id="${original.id}"]`);
  await expect(note.locator('.note-foot')).not.toContainText(/\d+\/\d+/);
  await app.screenshot({ path: `/private/tmp/todos-five-item-scroll-${isPhone() ? 'phone' : 'desktop'}.png` });
});
