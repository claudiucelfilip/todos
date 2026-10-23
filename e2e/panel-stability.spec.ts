import { boardCard, desktopOnly, expect, noteCard, openFromBoard, openFromNotes, panel, test } from './journeys';

for (const creating of [false, true]) {
  test(`${creating ? 'new' : 'existing'} editor stays settled when typing alternates with clicks`, async ({ app }, testInfo) => {
    if (creating) await app.getByTestId('composer-bar').click();
    else await openFromNotes(app, 'n0');
    const editor = panel(app);
    await editor.evaluate(async el => {
      await Promise.all(el.getAnimations().map(a => a.finished.catch(() => {})));
      (window as any).__panelRestarts = [];
      el.addEventListener('animationstart', event => {
        if (event.target === el) (window as any).__panelRestarts.push((event as AnimationEvent).animationName);
      });
    });
    const title = editor.getByTestId('detail-title');
    for (let i = 0; i < 3; i++) {
      await title.press('End');
      await title.press('x');
      await title.click();
    }
    expect(await app.evaluate(() => (window as any).__panelRestarts)).toEqual([]);
    await expect(editor).toBeVisible();
    await app.screenshot({ path: testInfo.outputPath('settled-panel.png') });
  });
}

for (const view of ['notes', 'board']) {
  test(`clicking the active card in ${view} keeps the same editor open`, async ({ app }) => {
    desktopOnly();
    if (view === 'notes') await openFromNotes(app, 'n0');
    else await openFromBoard(app, 't1', 'todo');
    const editor = panel(app);
    await editor.evaluate(async el => {
      await Promise.all(el.getAnimations().map(a => a.finished.catch(() => {})));
      (window as any).__activeEditor = el;
    });
    const url = app.url();
    const activeCard = view === 'notes' ? noteCard(app, 'n0') : boardCard(app, 't1');
    for (let i = 0; i < 3; i++) {
      await activeCard.click({ position: { x: 14, y: 40 } });
      expect(await editor.evaluate(el => el === (window as any).__activeEditor)).toBe(true);
      await expect(app.locator('.exit-clone')).toHaveCount(0);
      expect(app.url()).toBe(url);
    }
    const otherCard = view === 'notes' ? noteCard(app, 't1') : boardCard(app, 't2');
    await otherCard.click({ position: { x: 14, y: 40 } });
    await expect(editor).toBeVisible();
    expect(app.url()).not.toBe(url);
    await app.locator('.topbar').click({ position: { x: 700, y: 20 } });
    await expect(app.locator('.dt-panel:not(.exit-clone)')).toHaveCount(0);
  });
}
