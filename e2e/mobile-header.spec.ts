import { test, expect, isPhone, openView, accountJson } from './journeys';

test('installed iPhone header does not reserve the status bar twice', async ({ app }, info) => {
  test.skip(!isPhone(), 'Installed iPhone layout.');
  await app.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await app.reload();
  await expect(app.locator('html')).toHaveAttribute('data-ios-standalone', '');
  await expect(app.locator('html')).toHaveAttribute('data-ios-windowed', '');
  for (const view of ['board', 'notes'] as const) {
    await openView(app, view);
    await expect(app.locator('.topbar')).toHaveCSS('padding-top', '8px');
    await expect(app.locator('.topbar')).toHaveCSS('padding-bottom', '8px');
    expect((await app.locator('.topbar').boundingBox())!.height).toBe(60);
    if (view === 'board') {
      const header = (await app.locator('.topbar').boundingBox())!;
      const tabs = (await app.locator('.phone-column-pills').boundingBox())!;
      expect(tabs.y).toBe(header.y + header.height);
      expect(tabs.height).toBe(44);
    }
    await expect(app.locator('.topbar')).toHaveCSS('backdrop-filter', /blur\(18px\)/);
    await expect(app.locator('.topbar')).not.toHaveCSS('box-shadow', 'none');
    if (view === 'board') {
      const geometry = await app.locator('.column.todo .column-body').evaluate(el => {
        const cards = el.querySelectorAll('.card-face');
        const first = cards[0].getBoundingClientRect(), next = cards[1].getBoundingClientRect();
        const tabs = document.querySelector('.phone-column-pills')!.getBoundingClientRect();
        return { top: first.top - tabs.bottom, between: next.top - first.bottom };
      });
      expect(geometry.top).toBe(20);
      expect(geometry.between).toBe(20);
      const item = app.locator('.column.todo .card-inline-item').first();
      await expect(item).toHaveCSS('font-size', await app.locator('.phone-column-pill').first().evaluate(el => getComputedStyle(el).fontSize));
    }
    await app.screenshot({ path: info.outputPath(`installed-${view}-header.png`) });
  }
  const edgeColor = await app.locator('body').evaluate(el => getComputedStyle(el, '::before').backgroundColor);
  await app.getByTestId('composer-bar').click();
  await expect(app.locator('.dt-sheet')).not.toHaveCSS('box-shadow', 'none');
  expect(await app.locator('body').evaluate(el => getComputedStyle(el, '::before').backgroundColor)).toBe(edgeColor);
});

test('mobile header keeps workspace, views and actions on one accessible row', async ({ app, account }, info) => {
  test.skip(!isPhone(), 'Compact mobile header.');
  for (const width of [320, 375, 402, 430]) {
    await app.setViewportSize({ width, height: 874 });
    await openView(app, 'board');
    const row = app.locator('.topbar > .topbar-row').first();
    expect(await row.evaluate(el => {
      const nodes = [...el.querySelectorAll<HTMLElement>('.room-switch,.view-switch button,.topbar-actions .iconbtn')].filter(e => e.getBoundingClientRect().width);
      const boxes = nodes.map(e => e.getBoundingClientRect()).sort((a, b) => a.left - b.left);
      return boxes.every((b, i) => b.width >= 44 && b.height >= 44 && b.left >= 0 && b.right <= innerWidth && (!i || b.left >= boxes[i - 1].right));
    })).toBe(true);
    await expect(app.locator('.room-switch > span:not(.room-avatar)')).toBeHidden();
    expect(await app.locator('.topbar').evaluate(el => {
      const style = getComputedStyle(el);
      const safe = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0;
      return parseFloat(style.paddingTop) - safe === parseFloat(style.paddingBottom);
    })).toBe(true);
    const header = (await app.locator('.topbar').boundingBox())!;
    expect(header.height).toBeLessThanOrEqual(112);
    await expect.poll(async () => Math.round((await app.getByTestId('phone-panes').boundingBox())!.y)).toBe(0);
    await openView(app, 'notes');
    expect((await app.locator('.topbar').boundingBox())!.height).toBeLessThanOrEqual(64);
    await app.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(app.getByPlaceholder('Search')).toBeFocused();
    await expect.poll(async () => Math.round((await app.locator('.phone-search-layer').boundingBox())!.y)).toBe(Math.round((await app.locator('.topbar').boundingBox())!.height));
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  const rooms = (await accountJson(account, '/kanban/account')).json.rooms;
  const shared = rooms.find((room: { private: boolean }) => !room.private);
  await app.getByRole('button', { name: /Switch room/ }).click();
  await expect(app.getByRole('dialog', { name: 'Your rooms' })).toContainText(shared.name);
  await expect(app.locator('.rooms-row').filter({ hasText: shared.name }).locator('.room-avatar')).toBeVisible();
  await app.screenshot({ path: info.outputPath('workspace-identities.png') });
  await app.locator('.rooms-row').filter({ hasText: shared.name }).locator('.rooms-select').click();
  await expect(app.locator('.room-switch')).toHaveAttribute('title', shared.name);
  await expect(app.locator('.room-switch .room-avatar')).toBeVisible();
  await openView(app, 'board');
  await app.locator('.phone-panes .columns').evaluate(el => Promise.all(el.getAnimations().map(a => a.finished.catch(() => {}))));
  await expect.poll(async () => {
    const b = (await app.locator('.phone-panes .column.todo').boundingBox())!;
    return Math.abs(b.x + b.width / 2 - 215);
  }).toBeLessThanOrEqual(1);
  await app.screenshot({ path: info.outputPath('compact-mobile-header.png') });
});

test('Board and Notes content scroll behind the fixed glass headers', async ({ app }, info) => {
  test.skip(!isPhone(), 'Phone scroll layout.');
  await app.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await app.reload();
  await app.setViewportSize({ width: 402, height: 500 });
  await openView(app, 'board');
  const boardScroll = app.locator('.column.todo .column-body');
  await boardScroll.evaluate(el => { el.scrollTop = 100; });
  await expect.poll(async () => boardScroll.evaluate(el => el.scrollTop)).toBe(100);
  const board = await app.evaluate(() => ({
    cardTop: document.querySelector('.column.todo .card-face')!.getBoundingClientRect().top,
    tabsBottom: document.querySelector('.phone-column-pills')!.getBoundingClientRect().bottom,
    headerBottom: document.querySelector('.topbar')!.getBoundingClientRect().bottom,
  }));
  expect(board.cardTop).toBeLessThan(board.tabsBottom);
  expect(board.cardTop).toBeLessThan(board.headerBottom);
  await expect(app.locator('.phone-column-pills')).toHaveCSS('backdrop-filter', /blur\(18px\)/);
  await app.screenshot({ path: info.outputPath('board-under-glass.png') });

  await openView(app, 'notes');
  await app.locator('.phone-notes-pane').evaluate(el => Promise.all(el.getAnimations().map(a => a.finished.catch(() => {}))));
  const notesScroll = app.locator('.notes-view.phone .notes-scroll');
  await notesScroll.evaluate(el => { el.scrollTop = 70; });
  await expect.poll(async () => notesScroll.evaluate(el => el.scrollTop)).toBe(70);
  const notes = await app.evaluate(() => ({
    cardTop: document.querySelector('.phone-notes-pane .note-card')!.getBoundingClientRect().top,
    headerBottom: document.querySelector('.topbar')!.getBoundingClientRect().bottom,
  }));
  expect(notes.cardTop).toBeLessThan(notes.headerBottom);
  await app.screenshot({ path: info.outputPath('notes-under-glass.png') });
});

test('mobile note composer plus aligns with checklist controls', async ({ app }) => {
  test.skip(!isPhone(), 'Phone composer alignment.');
  await openView(app, 'notes');
  await app.locator('.phone-notes-pane').evaluate(el => Promise.all(el.getAnimations().map(a => a.finished.catch(() => {}))));
  for (const width of [320, 402, 430]) {
    await app.setViewportSize({ width, height: 874 });
    const alignment = await app.evaluate(() => {
      const button = document.querySelector<HTMLElement>('.composer-bar[data-view="notes"]')!;
      const box = document.querySelector<HTMLElement>('[data-testid="note-v6-d1"] .note-box')!;
      const buttonRect = button.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      const plusCenter = buttonRect.left + parseFloat(getComputedStyle(button).paddingLeft) + parseFloat(getComputedStyle(button, '::before').width) / 2;
      return { plusCenter, checklistCenter: boxRect.left + boxRect.width / 2 };
    });
    expect(Math.abs(alignment.plusCenter - alignment.checklistCenter)).toBeLessThanOrEqual(1);
  }
});


test('fullscreen iPhone editor covers the status area and keeps controls below it', async ({ app }) => {
  test.skip(!isPhone(), 'Installed iPhone layout.');
  await app.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await app.reload();
  await app.evaluate(() => {
    document.documentElement.style.setProperty('--safe-top', '62px');
    dispatchEvent(new Event('resize'));
  });
  await expect(app.locator('html')).not.toHaveAttribute('data-ios-windowed');
  await expect(app.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'black-translucent');
  const header = (await app.locator('.topbar > .topbar-row').first().boundingBox())!;
  await app.getByTestId('composer-bar').click();
  await expect.poll(async () => Math.round((await app.locator('.dt-sheet').boundingBox())!.y)).toBe(0);
  const panelHeader = (await app.locator('.dt-sheet .dt-top').boundingBox())!;
  expect(panelHeader.y).toBeGreaterThanOrEqual(62);
  await expect.poll(async () => {
    const box = (await app.locator('.dt-sheet .dt-top').boundingBox())!;
    return box.y + box.height / 2;
  }).toBe(header.y + header.height / 2);
});

test('pointer search enters smoothly and keeps the input ready', async ({ app }) => {
  test.skip(!isPhone(), 'Mobile search transition.');
  await app.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(app.getByPlaceholder('Search')).toBeFocused();
  await expect(app.locator('.topbar-row-search')).toHaveCSS('transition-duration', '0.22s, 0.22s');
  await app.getByPlaceholder('Search').fill('passport');
  await expect(app.getByPlaceholder('Search')).toHaveValue('passport');
  await app.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(app.locator('.topbar-row-search')).toHaveCount(0);
  await app.emulateMedia({ reducedMotion: 'reduce' });
  await app.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(app.locator('.topbar-row-search')).toHaveCSS('transform', 'none');
});

test('mobile search does not expose the filtered board underneath', async ({ app }) => {
  test.skip(!isPhone(), 'Mobile search overlay.');
  await openView(app, 'board');
  await app.getByRole('button', { name: 'Search', exact: true }).click();
  await app.getByPlaceholder('Search').fill('garden gate');
  await expect(app.locator('.phone-search-results')).toBeVisible();
  await expect(app.locator('.phone-panes')).toBeHidden();
  await expect(app.locator('.phone-notes-pane')).toBeHidden();
  await expect(app.getByTestId('composer-bar')).toHaveCount(0);
  await app.getByPlaceholder('Search').fill('no-such-note-918273');
  await expect(app.locator('.phone-search-empty')).toBeVisible();
  await expect(app.locator('.phone-panes')).toBeHidden();
  await app.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(app.locator('.phone-panes')).toBeVisible();
  await expect(app.getByTestId('composer-bar')).toBeVisible();
});
