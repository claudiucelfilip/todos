import { diffCards } from '../shared/merge.mjs';
import { expect, isPhone, K, openFromNotes, openView, panel, pushActions, test } from './journeys';

test('notes drag scrolls toward the top and shows only an accent insertion line', async ({ app }) => {
  test.skip(isPhone(), 'Notes mouse arrangement is desktop only');
  await openView(app, 'notes');
  const scroller = app.locator('.pane:not([inert]) .notes-scroll');
  await scroller.evaluate(async el => {
    await Promise.all(el.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
  });
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const startScroll = await scroller.evaluate(el => el.scrollTop);
  expect(startScroll).toBeGreaterThan(0);
  const sourceId = await scroller.locator('.notes-grid > [data-grid-id]').evaluateAll(els => {
    const visible = els.filter(el => {
      const r = el.getBoundingClientRect();
      return r.top > 120 && r.bottom < innerHeight - 20;
    });
    return (visible.at(-1) as HTMLElement | undefined)?.dataset.gridId;
  });
  expect(sourceId).toBeTruthy();
  const source = scroller.locator(`[data-grid-id="${sourceId}"]`);
  const count = await scroller.locator('.notes-grid > .note-card').count();
  const from = (await source.boundingBox())!;
  const bounds = (await scroller.boundingBox())!;
  const start = { x: from.x + 35, y: from.y + 30 };
  expect(await app.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-grid-id]')?.getAttribute('data-grid-id'), start)).toBe(sourceId);
  await app.mouse.move(start.x, start.y);
  await app.mouse.down();
  await app.mouse.move(start.x + 13, start.y + 13, { steps: 3 });
  await expect(scroller.locator('.notes-grid > .note-card')).toHaveCount(count);
  await expect(app.locator('.grid-ghost')).toBeVisible();
  await app.mouse.move(bounds.x + 10, bounds.y + 10);
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeLessThan(startScroll);
  const line = scroller.locator('.grid-insertion-line');
  await expect(line).toBeVisible();
  expect(await line.evaluate(el => Math.round(el.getBoundingClientRect().height))).toBe(3);
  expect(await line.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(await app.evaluate(() => {
    const sample = document.createElement('div');
    sample.style.backgroundColor = 'var(--studio-accent)';
    document.body.append(sample);
    const color = getComputedStyle(sample).backgroundColor;
    sample.remove();
    return color;
  }));
  await app.keyboard.press('Escape');
  await app.mouse.up();
  await expect(line).toHaveCount(0);
});

test('board cards scroll their column and show only an accent insertion line', async ({ app, account, api }) => {
  test.skip(isPhone(), 'Desktop column scrolling uses a separate drag path');
  const original = (await api.cards()).find(card => card.id === K('t1'));
  const extra = Array.from({ length: 32 }, (_, index) => ({
    ...original,
    id: `long-card-${index}`,
    title: `Long board card ${index + 1}`,
    order: 100 + index,
    labels: [...original.labels],
    remindAt: null,
    layout: { order: 100 + index, w: 1, h: 1 },
  }));
  await pushActions(account, diffCards([], extra, new Date().toISOString(), 'board-drag-scroll'));
  await app.reload();
  await openView(app, 'board');
  const scroller = app.locator('.pane:not([inert]) .column.todo .column-body');
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const startScroll = await scroller.evaluate(el => el.scrollTop);
  expect(startScroll).toBeGreaterThan(0);
  const source = scroller.locator('[data-card-id="long-card-31"]');
  await source.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  const bounds = (await scroller.boundingBox())!;
  await app.mouse.move(from.x + 40, from.y + 35);
  await app.mouse.down();
  await app.mouse.move(from.x + 55, from.y + 50, { steps: 3 });
  await expect(app.locator('.drag-ghost')).toBeVisible();
  const line = scroller.locator('.drop-placeholder');
  await expect(line).toBeVisible();
  expect(await line.evaluate(el => Math.round(el.getBoundingClientRect().height))).toBe(3);
  expect(await line.evaluate(el => getComputedStyle(el, '::before').backgroundColor)).toBe(await app.evaluate(() => {
    const sample = document.createElement('div');
    sample.style.backgroundColor = 'var(--studio-accent)';
    document.body.append(sample);
    const color = getComputedStyle(sample).backgroundColor;
    sample.remove();
    return color;
  }));
  await expect(scroller.locator('.drag-origin-slot')).toHaveCount(0);
  await app.mouse.move(bounds.x + 35, bounds.y + 12);
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeLessThan(startScroll);
  await app.keyboard.press('Escape');
  await app.mouse.up();
});

test('phone board cards scroll upward during a long-press drag', async ({ app, account, api }) => {
  test.skip(!isPhone(), 'Phone touch scrolling uses a separate drag path');
  const original = (await api.cards()).find(card => card.id === K('t1'));
  const extra = Array.from({ length: 32 }, (_, index) => ({
    ...original,
    id: `phone-long-card-${index}`,
    title: `Long phone card ${index + 1}`,
    order: 100 + index,
    labels: [...original.labels],
    remindAt: null,
    layout: { order: 100 + index, w: 1, h: 1 },
  }));
  await pushActions(account, diffCards([], extra, new Date().toISOString(), 'phone-board-drag-scroll'));
  await app.reload();
  await openView(app, 'board');
  const scroller = app.locator('.board.phone .column.todo .column-body');
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const source = scroller.locator('[data-card-id="phone-long-card-31"]');
  await source.scrollIntoViewIfNeeded();
  const startScroll = await scroller.evaluate(el => el.scrollTop);
  expect(startScroll).toBeGreaterThan(0);
  const from = (await source.boundingBox())!;
  const bounds = (await scroller.boundingBox())!;
  const cdp = await app.context().newCDPSession(app);
  const point = (x: number, y: number) => [{ x, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x + 35, from.y + 35) });
  await expect(app.locator('.drag-ghost')).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(bounds.x + 35, bounds.y + 12) });
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeLessThan(startScroll);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await cdp.detach();
});

test('plain checklist rows center their text and drag with a thin accent line', async ({ app }) => {
  test.skip(isPhone(), 'Mouse drag geometry is desktop only');
  await openFromNotes(app, 'n8');
  const row = panel(app).locator('.dt-row:not(.ref)', { hasText: 'Tent pegs' });
  await row.scrollIntoViewIfNeeded();
  await panel(app).evaluate(async el => {
    await Promise.all(el.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
  });
  const centers = await row.evaluate(el => {
    const box = el.querySelector('.dt-box')!.getBoundingClientRect();
    const text = el.querySelector('.dt-item-text-field')!.getBoundingClientRect();
    return [box.top + box.height / 2, text.top + text.height / 2];
  });
  expect(Math.abs(centers[0] - centers[1])).toBeLessThanOrEqual(1);
  const from = (await row.boundingBox())!;
  await app.mouse.move(from.x + 44, from.y + 20);
  await app.mouse.down();
  await app.mouse.move(from.x + 60, from.y + 38, { steps: 3 });
  const line = panel(app).locator('.dt-row-slot');
  await expect(line).toBeVisible();
  expect(await line.evaluate(el => Math.round(el.getBoundingClientRect().height))).toBe(3);
  expect(await line.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(await app.evaluate(() => {
    const sample = document.createElement('div');
    sample.style.backgroundColor = 'var(--studio-accent)';
    document.body.append(sample);
    const color = getComputedStyle(sample).backgroundColor;
    sample.remove();
    return color;
  }));
  await app.keyboard.press('Escape');
  await app.mouse.up();
});

test('a long checklist scrolls upward while a row is held at its top edge', async ({ app, account, api }) => {
  test.skip(isPhone(), 'Mouse drag geometry is desktop only');
  const items = Array.from({ length: 40 }, (_, index) => ({ id: `long-step-${index}`, text: `Step ${index + 1}`, done: false }));
  const original = (await api.cards()).find(card => card.id === K('n8'));
  await pushActions(account, diffCards([original], [{ ...original, items }], new Date().toISOString(), 'drag-scroll'));
  await app.reload();
  await openFromNotes(app, 'n8');
  const scroller = panel(app).locator('.dt-scroll');
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const startScroll = await scroller.evaluate(el => el.scrollTop);
  expect(startScroll).toBeGreaterThan(0);
  const source = panel(app).locator('.dt-row:not(.ref)', { hasText: 'Step 40' });
  await source.scrollIntoViewIfNeeded();
  await panel(app).evaluate(async el => {
    await Promise.all(el.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
  });
  const from = (await source.boundingBox())!;
  const bounds = (await scroller.boundingBox())!;
  await app.mouse.move(from.x + 44, from.y + 20);
  await app.mouse.down();
  await app.mouse.move(from.x + 60, from.y + 38, { steps: 3 });
  await expect(panel(app).locator('.dt-row-slot')).toBeVisible();
  await app.mouse.move(bounds.x + 40, bounds.y + 12);
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeLessThan(startScroll);
  await app.keyboard.press('Escape');
  await app.mouse.up();
});
