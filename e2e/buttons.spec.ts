import { test, expect } from './fixtures';
import { openFromBoard, openLabels, panel, isPhone, openView, openColumn, boardCard, noteCard } from './journeys';
import { studioThemes } from '../shared/appearance.mjs';
import type { Locator, Page } from '@playwright/test';

async function contrast(buttons: Locator) {
  return buttons.evaluateAll(elements => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    const rgba = (value: string) => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].map((v, i) => i === 3 ? v / 255 : v / 255);
    };
    const over = (front: number[], back: number[]) => front.slice(0, 3).map((v, i) => v * front[3] + back[i] * (1 - front[3]));
    const light = (rgb: number[]) => rgb.map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((n, c, i) => n + c * [.2126, .7152, .0722][i], 0);
    return elements.filter(el => {
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width && r.height && s.visibility === 'visible' && Number(s.opacity) > 0 && !el.closest('[hidden],[inert],[aria-hidden="true"]') && !(el as HTMLButtonElement).disabled;
    }).map(el => {
      const s = getComputedStyle(el);
      const paper = rgba(s.getPropertyValue('--control-paper').trim());
      const bg = over(rgba(s.backgroundColor), paper);
      const fg = over(rgba(s.color), bg);
      const a = light(fg), b = light(bg);
      return { name: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 55) || el.className, class: el.className, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), color: s.color, background: s.backgroundColor, radius: s.borderRadius, border: s.borderTopColor };
    });
  });
}
async function check(buttons: Locator, label: string, minimum = 4.5) {
  let rows: Awaited<ReturnType<typeof contrast>> = [];
  await expect.poll(async () => { rows = await contrast(buttons); return rows.length; }, { message: `${label}: controls rendered` }).toBeGreaterThan(0);
  await expect.poll(async () => { rows = await contrast(buttons); return rows.filter(r => r.ratio < minimum); }, { message: `${label}: contrast failures` }).toEqual([]);
  expect(rows.filter(r => !/(?:^| )(?:inline-box|note-box|dt-box|md-box|dt-done-circle|swatch)(?: |$)/.test(r.class)).filter(r => r.radius !== '0px'), label + ': square controls').toEqual([]);
  return rows;
}
async function settings(page: Page) {
  if (await page.locator('.app.phone').count()) await page.getByRole('button', { name: 'More options' }).click();
  await page.getByTestId('settings').click();
  return page.getByRole('dialog', { name: 'Settings', exact: true });
}

test('text actions have readable fills, borders and focus states across all ten themes', async ({ app }, testInfo) => {
  test.setTimeout(120000);
  await app.route('**/kanban/sherlock?*', route => route.fulfill({ json: { available: true, connected: false } }));
  const evidence: unknown[] = [];
  for (const theme of studioThemes) {
    const dialog = await settings(app);
    await dialog.getByRole('radio', { name: theme.name, exact: true }).click();
    evidence.push({ theme: theme.id, surface: 'settings', buttons: await check(dialog.locator('.btn, .iconbtn'), theme.id + ' settings') });
    await expect(dialog).toHaveCSS('border-radius','0px');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    evidence.push({ theme: theme.id, surface: 'header', buttons: await check(app.locator('.topbar button').filter({ visible: true }), theme.id + ' header') });
    await openFromBoard(app, 't2', 'todo');
    const ask = panel(app).getByRole('button', { name: 'Ask Sherlock', exact: true });
    await expect(ask).toBeVisible();
    for (const selector of ['.dt-row','.dt-row-wrap','.dt-add-input']) { for (const el of await panel(app).locator(selector).all()) await expect(el).toHaveCSS('border-radius','0px'); }
    await expect(panel(app).locator('.dt-box').first()).toHaveCSS('border-radius','50%');
    evidence.push({ theme: theme.id, surface: 'editor', buttons: await check(panel(app).locator('button:not(.label-pill-x)'), theme.id + ' editor') });
    await ask.focus();
    await app.keyboard.press('Tab');
    await ask.focus();
    const focus = await ask.evaluate(el => { const s = getComputedStyle(el); return { width: s.outlineWidth, style: s.outlineStyle, color: s.outlineColor }; });
    expect(focus.style).toBe('solid'); expect(focus.width).toBe('2px');
    const size = await ask.boundingBox();
    if (isPhone()) expect(size!.height).toBeGreaterThanOrEqual(44);
    if (theme.id === 'sky-lemon' || theme.id === 'ink-pool-blue') await app.screenshot({ path: testInfo.outputPath(`editor-${theme.id}.png`) });
    if (isPhone()) await ask.tap(); else await ask.click();
    await expect(panel(app).getByRole('textbox', { name: 'Message to Sherlock' })).toBeVisible();
    await check(panel(app).locator('.sh-send,.sh-follow'), theme.id + ' Sherlock composer');
    await panel(app).getByRole('button', { name: 'Cancel', exact: true }).click();
    await app.keyboard.press('Escape');
    await app.getByRole('button', { name: 'Open assistant', exact:true }).click();
    await check(app.getByTestId('assistant').locator('button'), theme.id + ' assistant');
    await app.getByTestId('assistant').getByRole('button', { name: 'Close assistant', exact:true }).click();
  }
  await testInfo.attach('button-contrast.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
});

test('rooms, reminder choices, label automations and menus keep their action hierarchy', async ({ app }, testInfo) => {
  const dialog = await settings(app);
  await dialog.getByRole('radio', { name: 'Sky & Lemon', exact: true }).click();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await app.getByRole('button', { name: /Switch room, current room/ }).click();
  await app.getByRole('button', { name: 'New shared room' }).click();
  await app.getByRole('textbox', { name: /Room name/ }).fill('Button audit');
  const create = app.getByRole('button', { name: 'Create room', exact: true });
  await check(app.locator('.rooms-button'), 'room creation');
  await expect(create).toBeEnabled();
  await app.getByRole('button', { name: 'Cancel', exact: true }).click();
  await app.getByRole('button', { name: 'Close rooms', exact: true }).click();

  await openFromBoard(app, 't2', 'todo');
  await panel(app).getByTestId('detail-remind').click();
  await check(app.locator('.remind-pop button:not(:disabled)'), 'reminder actions');
  await panel(app).getByTestId('detail-remind').click();
  await expect(app.locator('.remind-pop')).toHaveCount(0);
  await panel(app).getByRole('button', { name: 'Card menu', exact: true }).click();
  await expect(app.locator('.dt-menu')).toBeVisible();
  const remove = app.getByRole('menuitem', { name: 'Delete', exact: true });
  await check(app.locator('.dt-menu button'), 'card menu');
  const danger = await remove.evaluate(el => getComputedStyle(el).color);
  const ordinary = await app.getByRole('menuitem', { name: 'Duplicate', exact: true }).evaluate(el => getComputedStyle(el).color);
  expect(danger).not.toBe(ordinary);
  await app.keyboard.press('Escape'); await app.keyboard.press('Escape');

  await openLabels(app);
  await app.getByRole('button', { name: 'Edit Done', exact: true }).click();
  await app.locator('.automation-summary').first().click();
  await check(app.locator('.automation-buttons button'), 'automation actions');
  await app.screenshot({ path: testInfo.outputPath('automation-buttons.png') });
  await app.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('notices and markdown markers use their own surface colors', async ({ app }, testInfo) => {
  test.setTimeout(90000);
  for (const theme of studioThemes) {
    const dialog = await settings(app);
    await dialog.getByRole('radio', { name: theme.name, exact: true }).click();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await app.evaluate(() => window.dispatchEvent(new CustomEvent('kanban:updated', { detail: { version: 'test' } })));
    const banner = app.getByTestId('banner-updated');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveCSS('border-radius','0px');
    await check(banner.locator('.mono,button'), theme.id + ' notification');
    expect(await banner.evaluate(el => getComputedStyle(el, '::before').backgroundColor)).not.toBe('rgb(255, 255, 255)');
    if (theme.id === 'sky-lemon') await app.screenshot({ path: testInfo.outputPath('notification.png') });
    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await openFromBoard(app, 't3', 'todo');
    await expect(panel(app).locator('.md-mark').first()).toBeVisible();
    const markers = await panel(app).locator('.md-mark').evaluateAll(els => els.map(el => ({ marker: getComputedStyle(el).color, line: getComputedStyle(el.parentElement!).color })));
    for (const marker of markers) expect(marker.marker).toBe(marker.line);
    await app.keyboard.press('Escape');
  }
});

test('lifted board and grid notes retain their theme color and translucent material', async ({ app }, testInfo) => {
  test.setTimeout(90000);
  for (const theme of studioThemes.filter(t => ['sky-lemon','ink-pool-blue','lime-deep-violet'].includes(t.id))) {
    const dialog = await settings(app);
    await dialog.getByRole('radio', { name: theme.name, exact: true }).click();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    for (const view of ['board','notes'] as const) {
      if (isPhone() && view === 'notes') continue;
      await openView(app, view); await openColumn(app, 'todo');
      const source = view === 'board' ? boardCard(app, 't2') : noteCard(app, 't2');
      await source.scrollIntoViewIfNeeded();
      await source.evaluate(async el => { for (let n: Element | null = el; n; n = n.parentElement) await Promise.all(n.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); });
      const box = (await source.boundingBox())!;
      const x = box.x + 60, y = box.y + 20;
      const original = await source.evaluate(el => { const s = getComputedStyle(el); return { color: s.color, backdrop: s.backdropFilter }; });
      let cdp;
      if (isPhone()) {
        cdp = await app.context().newCDPSession(app);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x,y,id:1 }] });
        await app.waitForTimeout(450);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x:x+30,y:y+40,id:1 }] });
      } else {
        await app.mouse.move(x,y); await app.mouse.down(); await app.mouse.move(x+30,y+40,{steps:4});
      }
      const ghost = app.locator(view === 'board' ? '.drag-ghost' : '.grid-ghost .note-card');
      await expect(ghost).toBeVisible();
      const material = await ghost.evaluate(el => { const s = getComputedStyle(el); return { color:s.color, backdrop:s.backdropFilter, background:s.backgroundColor, opacity:s.opacity }; });
      expect(material.color).toBe(original.color);
      expect(material.backdrop).toBe(original.backdrop);
      expect(material.opacity).toBe('1');
      const alpha = material.background.match(/(?:\/|,)\s*([\d.]+)\)$/)?.[1];
      expect(Number(alpha)).toBeGreaterThan(0);
      expect(Number(alpha)).toBeLessThan(1);
      await app.screenshot({ path:testInfo.outputPath(`drag-${theme.id}-${view}.png`) });
      if (cdp) { await cdp.send('Input.dispatchTouchEvent', { type:'touchCancel',touchPoints:[] }); await cdp.detach(); }
      else { await app.keyboard.press('Escape'); await app.mouse.up(); }
      await expect(ghost).toHaveCount(0);
    }
  }
});

test('checklist drag keeps editor text, border and action colors', async ({ app }) => {
  const dialog = await settings(app);
  await dialog.getByRole('radio', { name:'Sky & Lemon', exact:true }).click();
  await dialog.getByRole('button', { name:'Close', exact:true }).click();
  await openFromBoard(app,'t2','todo');
  const row = panel(app).locator('.dt-row').first();
  await row.scrollIntoViewIfNeeded();
  await row.evaluate(async el => { for (let n: Element | null = el; n; n=n.parentElement) await Promise.all(n.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); });
  const style = await row.evaluate(el => {
    const s = getComputedStyle(el), t = getComputedStyle(el.querySelector('.dt-row-text')!);
    return { color:t.color, border:s.borderBottomColor, font:t.fontSize, padding:s.padding };
  });
  const box = (await row.boundingBox())!;
  const x=box.x+80, y=box.y+20;
  let cdp;
  if (isPhone()) {
    cdp = await app.context().newCDPSession(app);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});
    await app.waitForTimeout(500);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+30,id:1}]});
  } else {
    await app.mouse.move(x,y); await app.mouse.down(); await app.mouse.move(x,y+30,{steps:4});
  }
  const ghost=app.locator('.dt-row-ghost .dt-row');
  await expect(ghost).toBeVisible();
  expect(await ghost.evaluate(el => {
    const s=getComputedStyle(el),t=getComputedStyle(el.querySelector('.dt-row-text')!);
    return {color:t.color,border:s.borderBottomColor,font:t.fontSize,padding:s.padding};
  })).toEqual(style);
  if(cdp) { await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]}); await cdp.detach(); }
  else { await app.keyboard.press('Escape'); await app.mouse.up(); }
});
