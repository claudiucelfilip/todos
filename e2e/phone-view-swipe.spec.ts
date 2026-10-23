import { expect, isPhone, K, noteCard, openView, swipe, test } from './journeys';

async function backgroundSpot(app: Parameters<typeof swipe>[0], direction: 'left' | 'right') {
  await app.locator('.phone-notes-pane:not([hidden]),.phone-panes:not([hidden])').evaluate(async el => {
    await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
  return app.evaluate((dir) => {
    const pane = document.querySelector<HTMLElement>('.phone-notes-pane:not([hidden]),.phone-panes:not([hidden])')!;
    const bounds = pane.getBoundingClientRect();
    for (let y = Math.min(bounds.bottom - 80, innerHeight - 88); y > bounds.top + 30; y -= 8) {
      for (let x = dir === 'left' ? bounds.right - 34 : bounds.left + 34; dir === 'left' ? x > bounds.left + 180 : x < bounds.right - 180; x += dir === 'left' ? -16 : 16) {
        const free = [[0,0],[0,-12],[0,12],[-12,0],[12,0]].every(([dx,dy]) => {
          const target = document.elementFromPoint(x + dx, y + dy);
          return target && pane.contains(target) && !target.closest('[data-swipe-row],button,a,input,textarea,.composer-layer');
        });
        if (free) return { x, y };
      }
    }
    throw new Error('No free swipe area');
  }, direction);
}

async function swipeBackground(app: Parameters<typeof swipe>[0], direction: 'left' | 'right') {
  const from = await backgroundSpot(app, direction);
  await swipe(app, from, { x: from.x + (direction === 'left' ? -180 : 180), y: from.y });
}

test('phone swipe traverses Board columns before reaching Notes', async ({ app }) => {
  test.skip(!isPhone(), 'Phone gesture');
  await expect(app.locator('.view-switch button')).toHaveText(['Board', 'Notes']);
  await openView(app, 'board');
  await expect(app.getByTestId('nav-todo')).toHaveAttribute('aria-checked', 'true');
  const tabLeft = await app.locator('.phone-column-pills').evaluate(el => el.getBoundingClientRect().left);
  const headerHeight = await app.locator('.topbar').evaluate(el => el.getBoundingClientRect().height);
  const boardGeometry = await app.evaluate(() => ({
    headerBottom: document.querySelector('.topbar')!.getBoundingClientRect().bottom,
    tabsTop: document.querySelector('.phone-column-pills')!.getBoundingClientRect().top,
    tabsBottom: document.querySelector('.phone-column-pills')!.getBoundingClientRect().bottom,
    columnsTop: document.querySelector('.board.phone .columns')!.getBoundingClientRect().top,
  }));
  expect(boardGeometry.tabsTop).toBe(boardGeometry.headerBottom);
  expect(boardGeometry.columnsTop).toBe(0);
  const actions = await app.evaluate(() => {
    const more = document.querySelector<HTMLElement>('.phone-menu-anchor > button')!.getBoundingClientRect();
    const add = document.querySelector<HTMLElement>('.phone-column-add')!.getBoundingClientRect();
    const tab = document.querySelector<HTMLElement>('.phone-column-pill')!.getBoundingClientRect();
    return { moreX: more.left + more.width / 2, addX: add.left + add.width / 2, addY: add.top + add.height / 2, tabY: tab.top + tab.height / 2 };
  });
  expect(Math.abs(actions.moreX - actions.addX)).toBeLessThan(2);
  expect(Math.abs(actions.tabY - actions.addY)).toBeLessThan(2);
  await app.screenshot({ path: test.info().outputPath('board-header.png') });
  await swipeBackground(app, 'right');
  await expect(app.locator('.app')).toHaveAttribute('data-view', 'board');
  await expect(app.getByTestId('nav-todo')).toHaveAttribute('aria-checked', 'true');
  await swipeBackground(app, 'left');
  await expect(app.getByTestId('nav-doing')).toHaveAttribute('aria-checked', 'true');
  expect(await app.locator('.phone-column-pills').evaluate(el => el.getBoundingClientRect().left)).toBe(tabLeft);
  await swipeBackground(app, 'left');
  await expect(app.getByTestId('nav-done')).toHaveAttribute('aria-checked', 'true');
  await swipeBackground(app, 'left');
  await expect(app.locator('.app')).toHaveAttribute('data-view', 'notes');
  await expect(app.locator('.phone-notes-pane')).toBeVisible();
  expect(await app.locator('.topbar').evaluate(el => el.getBoundingClientRect().height)).toBe(headerHeight);
  await app.locator('.phone-notes-pane').evaluate(async el => {
    await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
  await app.screenshot({ path: test.info().outputPath('notes-header.png') });
  await app.locator('.phone-notes-pane .notes-scroll').evaluate(el => { el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }); });
  await swipeBackground(app, 'left');
  await expect(app.locator('.app')).toHaveAttribute('data-view', 'notes');
  await swipeBackground(app, 'right');
  await expect(app.locator('.app')).toHaveAttribute('data-view', 'board');
  await expect(app.getByTestId('nav-done')).toHaveAttribute('aria-checked', 'true');
});

test('swiping right on a note navigates to Board without moving the note', async ({ app, api }) => {
  test.skip(!isPhone(), 'Phone gesture');
  await openView(app, 'notes');
  const card = noteCard(app, 'n3');
  await card.scrollIntoViewIfNeeded();
  const bounds = (await card.boundingBox())!;
  const y = bounds.y + Math.min(36, bounds.height / 2);
  await swipe(app, { x: bounds.x + 32, y }, { x: bounds.x + bounds.width - 20, y });
  await expect(app.locator('.app')).toHaveAttribute('data-view', 'board');
  await expect(app.getByTestId('nav-done')).toHaveAttribute('aria-checked', 'true');
  const unchanged = (await api.cards()).find(card => card.id === K('n3'));
  expect(unchanged.kind).toBe('note');
});

test('swiping left on a Board card switches to Notes without deleting the card', async ({ app, api }) => {
  test.skip(!isPhone(), 'Phone gesture');
  await app.getByTestId('nav-done').click();
  const card = app.locator('.phone-panes .column[data-status="done"] article.card-face').first();
  await card.scrollIntoViewIfNeeded();
  await app.locator('.phone-panes .columns').evaluate(async el => {
    await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
  const id = await card.getAttribute('data-card-id');
  const bounds = (await card.boundingBox())!;
  const y = bounds.y + Math.min(48, bounds.height / 2);
  await swipe(app, { x: bounds.x + bounds.width / 2, y }, { x: bounds.x + 30, y });
  await expect(app.locator('.app')).toHaveAttribute('data-view', 'notes');
  expect((await api.cards()).some(card => card.id === id)).toBe(true);
});

test('swiping left reveals Delete without deleting until tapped', async ({ app, api }, testInfo) => {
  test.skip(!isPhone(), 'Phone gesture');
  await openView(app, 'notes');
  const card = noteCard(app, 'n3');
  await card.scrollIntoViewIfNeeded();
  const bounds = (await card.boundingBox())!;
  const y = bounds.y + Math.min(36, bounds.height / 2);
  await swipe(app, { x: bounds.x + bounds.width - 24, y }, { x: bounds.x + 24, y });
  const row = app.locator(`.note-swipe[data-grid-id="${K('n3')}"]`);
  await expect(row).toHaveClass(/swipe-left/);
  expect((await api.cards()).some(card => card.id === K('n3'))).toBe(true);
  await expect(row.locator('.swipe-bg-delete')).toHaveCSS('opacity', '1');
  await row.locator('.card-swipe-inner').evaluate(async el => {
    await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
  const edges = await row.evaluate(el => ({
    card: el.querySelector('.note-card')!.getBoundingClientRect().right,
    action: el.querySelector('.swipe-action')!.getBoundingClientRect().left,
  }));
  expect(Math.abs(edges.card - edges.action)).toBeLessThan(1);
  await expect(row.locator('.swipe-action')).toHaveCSS('background-color', 'rgb(176, 24, 50)');
  await expect(row.locator('.swipe-action')).toHaveCSS('color', 'rgb(255, 255, 255)');
  await app.screenshot({ path: testInfo.outputPath('delete-revealed.png') });
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect.poll(async () => (await api.cards()).some(card => card.id === K('n3'))).toBe(false);
  const toast = app.getByTestId('toast');
  await expect(toast.getByTestId('toast-undo')).toBeVisible();
  await expect(toast).toHaveCSS('padding-top', '8px');
  await expect(toast).toHaveCSS('padding-bottom', '8px');
  await app.screenshot({ path: testInfo.outputPath('undo-notice.png') });
  await toast.getByTestId('toast-undo').click();
  await expect.poll(async () => (await api.cards()).some(card => card.id === K('n3'))).toBe(true);
});

test('phone swipe returns to the last custom Board column', async ({ app }) => {
  test.skip(!isPhone(), 'Phone gesture');
  await app.getByRole('button', { name: 'More options' }).click();
  await app.getByTestId('settings').click();
  const settings = app.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Create flow', exact: true }).click();
  await settings.getByRole('button', { name: 'Use Editorial example', exact: true }).click();
  await settings.getByRole('button', { name: 'Save flow', exact: true }).click();
  await settings.locator('.flow-overview').filter({ hasText: 'Editorial' }).getByRole('button', { name: 'Use as board columns' }).click();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(app.getByRole('radio', { name: /Draft/ })).toHaveAttribute('aria-checked', 'true');
  await swipeBackground(app, 'left');
  await expect(app.getByRole('radio', { name: /Review/ })).toHaveAttribute('aria-checked', 'true');
  await swipeBackground(app, 'left');
  await expect(app.getByRole('radio', { name: /Published/ })).toHaveAttribute('aria-checked', 'true');
  await swipeBackground(app, 'left');
  await expect(app.locator('.app')).toHaveAttribute('data-view', 'notes');
  await app.locator('.phone-notes-pane .notes-scroll').evaluate(el => { el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }); });
  await swipeBackground(app, 'right');
  await expect(app.locator('.app')).toHaveAttribute('data-view', 'board');
  await expect(app.getByRole('radio', { name: /Published/ })).toHaveAttribute('aria-checked', 'true');
  await expect(app.getByTestId('nav-todo')).toHaveCount(0);
});

test('adjacent Board and Notes panes follow a boundary drag before it settles', async ({ app }) => {
  test.skip(!isPhone(), 'Phone gesture');
  await app.getByTestId('nav-done').click();
  const from = await backgroundSpot(app, 'left');
  const cdp = await app.context().newCDPSession(app);
  const point = (x: number) => [{ x, y: from.y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x) });
  for (const dx of [-15, -30, -45, -60]) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(from.x + dx) });
  }
  const positions = await app.evaluate(() => ({
    board: document.querySelector('.phone-panes')!.getBoundingClientRect().left,
    tabs: document.querySelector('.phone-column-pills')!.getBoundingClientRect().left,
    notes: document.querySelector('.phone-notes-pane')!.getBoundingClientRect().left,
    width: innerWidth,
  }));
  expect(positions.board).toBeLessThan(-40);
  expect(positions.tabs).toBe(positions.board);
  expect(positions.notes).toBeGreaterThan(positions.width - 80);
  expect(positions.notes).toBeLessThan(positions.width);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(from.x - 10) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await expect(app.locator('.app')).toHaveAttribute('data-view', 'board');
  await expect.poll(() => app.locator('.phone-panes').evaluate(el => Math.round(el.getBoundingClientRect().left))).toBe(0);
});

test('Board to Notes keeps moving smoothly after release', async ({ app }) => {
  test.skip(!isPhone(), 'Phone gesture');
  await app.getByTestId('nav-done').click();
  const from = await backgroundSpot(app, 'left');
  const cdp = await app.context().newCDPSession(app);
  const point = (x: number) => [{ x, y: from.y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x) });
  for (const dx of [-20, -40, -60, -80, -100]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(from.x + dx) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const progress = await app.evaluate(() => {
    const board = document.querySelector<HTMLElement>('.phone-panes')!;
    const notes = document.querySelector<HTMLElement>('.phone-notes-pane')!;
    const animation = board.getAnimations()[0];
    const start = board.getBoundingClientRect().left;
    animation.currentTime = 40;
    const at40 = board.getBoundingClientRect().left;
    const gap = notes.getBoundingClientRect().left - board.getBoundingClientRect().left;
    return { start, at40, gap, duration: animation.effect!.getTiming().duration as number, width: innerWidth };
  });
  expect(progress.start).toBeGreaterThan(-180);
  expect(progress.at40).toBeLessThan(progress.start - 15);
  expect(progress.at40).toBeGreaterThan(-260);
  expect(progress.duration).toBeGreaterThan(450);
  expect(progress.gap).toBeGreaterThan(progress.width);
  await expect(app.locator('.app')).toHaveAttribute('data-view', 'notes');
  await expect.poll(() => app.locator('.phone-notes-pane').evaluate(el => Math.round(el.getBoundingClientRect().left))).toBe(16);
  await cdp.detach();
});

test('Board column keeps moving smoothly after release', async ({ app }) => {
  test.skip(!isPhone(), 'Phone gesture');
  const from = await backgroundSpot(app, 'left');
  const cdp = await app.context().newCDPSession(app);
  const point = (x: number) => [{ x, y: from.y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x) });
  for (const dx of [-20, -40, -60, -80, -100]) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(from.x + dx) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const progress = await app.locator('.phone-panes .columns').evaluate(el => {
    const animation = el.getAnimations()[0];
    const start = el.getBoundingClientRect().left;
    animation.currentTime = 40;
    return { start, at40: el.getBoundingClientRect().left, duration: animation.effect!.getTiming().duration as number };
  });
  expect(progress.start).toBeGreaterThan(-180);
  expect(progress.at40).toBeLessThan(progress.start - 15);
  expect(progress.at40).toBeGreaterThan(-260);
  expect(progress.duration).toBeGreaterThan(450);
  await expect(app.getByTestId('nav-doing')).toHaveAttribute('aria-checked', 'true');
  await cdp.detach();
});

test('installed app owns its edge swipe', async ({ app, api }) => {
  test.skip(!isPhone(), 'Phone gesture');
  await app.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true, configurable: true }));
  await app.reload();
  await openView(app, 'notes');
  const card = noteCard(app, 'n3');
  await card.scrollIntoViewIfNeeded();
  const bounds = (await card.boundingBox())!;
  const y = bounds.y + Math.min(36, bounds.height / 2);
  await swipe(app, { x: Math.max(20, bounds.x + 4), y }, { x: bounds.x + bounds.width - 20, y });
  await expect(app.locator('.app')).toHaveAttribute('data-view', 'board');
  expect((await api.cards()).some(card => card.id === K('n3'))).toBe(true);
  await expect(app.locator('html')).toHaveCSS('overscroll-behavior-x', 'none');
});
