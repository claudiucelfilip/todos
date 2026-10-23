import type { Page } from '@playwright/test';
import { accountJson, expect, isPhone, openFromNotes, panel, pushActions, rgbaOf, setFields, test } from './journeys';

const themes = [
  ['Sky & Lemon', 'sky-lemon', '#f4ff24'],
  ['Violet & Chartreuse', 'violet-chartreuse', '#cbff00'],
  ['Indigo & Hot Pink', 'indigo-hot-pink', '#ff338f'],
  ['Ice & Cherry', 'ice-cherry', '#65e5ce'],
  ['Black & Laser Lime', 'black-laser-lime', '#baff00'],
  ['Royal Blue & Acid Green', 'royal-blue-acid-green', '#a6ff00'],
  ['Grape & Signal Yellow', 'grape-signal-yellow', '#fff000'],
  ['Lime & Deep Violet', 'lime-deep-violet', '#6c25ef'],
  ['Signal Red & Ice', 'signal-red-ice', '#66e4ff'],
  ['Ink & Pool Blue', 'ink-pool-blue', '#00bcff'],
] as const;
const patterns = [
  ['Dots', 'dots'], ['Fine grid', 'grid'], ['Crosses', 'crosses'], ['Diagonal', 'diagonal'],
  ['Waves', 'waves'], ['Hexagons', 'hexagons'], ['Micro checker', 'checker'], ['Plain', 'plain'],
] as const;

async function settings(page: Page) {
  if (isPhone()) await page.getByRole('button', { name: 'More options' }).click();
  await page.getByTestId('settings').click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function chooseTheme(page: Page, name: string) {
  const dialog = await settings(page);
  await dialog.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name, exact: true }).click();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('nearby reminders use the readable card footer color in the dark theme', async ({ app, account }) => {
  await chooseTheme(app, 'Black & Laser Lime');
  await pushActions(account, [setFields('v6-t1', { remindAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() })]);
  await app.reload();
  const badge = app.locator('.phone-panes:not([hidden]) [data-testid="card-v6-t1"] .card-remind, .board:not(.phone) [data-testid="card-v6-t1"] .card-remind').first();
  await expect(badge).toHaveClass(/soon/);
  const colors = await badge.evaluate(el => ({
    badge: getComputedStyle(el).color,
    footer: getComputedStyle(el.closest('.card-meta')!).color,
  }));
  expect(colors.badge).toBe(colors.footer);
  await badge.screenshot({ path: test.info().outputPath('readable-reminder.png') });
});

test('dark and light shadows keep the canvas chroma as they darken it', async ({ app }) => {
  test.skip(isPhone(), 'Desktop shadow surfaces');
  for (const name of ['Black & Laser Lime', 'Ink & Pool Blue', 'Sky & Lemon']) {
    await chooseTheme(app, name);
    const colors = await app.evaluate(() => {
      const sample = (token: string) => {
        const el = document.createElement('div');
        el.style.backgroundColor = `var(${token})`;
        document.body.append(el);
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d')!;
        context.fillStyle = getComputedStyle(el).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        el.remove();
        return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
      };
      return { canvas: sample('--variant-canvas'), shadow: sample('--glass-shadow-ink') };
    });
    const saturation = (channels: number[]) => (Math.max(...channels) - Math.min(...channels)) / Math.max(...channels);
    expect(Math.max(...colors.shadow)).toBeLessThan(Math.max(...colors.canvas));
    expect(saturation(colors.shadow)).toBeGreaterThanOrEqual(saturation(colors.canvas) - 0.05);
  }
});

test('installed phone status backdrop and both glass bars use the selected header tint', async ({ app }) => {
  test.skip(!isPhone(), 'Installed iOS appearance is phone-specific');
  await app.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true, configurable: true }));
  await app.reload();
  await expect(app.locator('html')).toHaveAttribute('data-ios-standalone', '');
  for (const name of ['Sky & Lemon', 'Ink & Pool Blue']) {
    await chooseTheme(app, name);
    const colors = await app.evaluate(() => ({
      backdrop: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      header: getComputedStyle(document.querySelector('.topbar')!, '::before').backgroundColor,
      subheader: getComputedStyle(document.querySelector('.phone-column-pills')!, '::before').backgroundColor,
      meta: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content,
      token: getComputedStyle(document.documentElement).getPropertyValue('--studio-blue').trim(),
    }));
    expect(colors.backdrop).toBe(colors.body);
    expect(colors.header).toBe(colors.subheader);
    expect(colors.meta?.toLowerCase()).toBe(colors.token.toLowerCase());
  }
});

test('all ten picked themes have thumbnails and apply their accent color', async ({ app }, info) => {
  const dialog = await settings(app);
  const group = dialog.getByRole('radiogroup', { name: 'Theme', exact: true });
  await expect(group.getByRole('radio')).toHaveCount(10);
  for (const [name, id, accent] of themes) {
    const option = group.getByRole('radio', { name, exact: true });
    await expect(option.locator('.studio-mini')).toBeVisible();
    await expect(option.locator('.mini-state')).toHaveCount(6);
    await option.click();
    await expect(option).toHaveAttribute('aria-checked', 'true');
    await expect(group.locator('[aria-checked="true"]')).toHaveCount(1);
    await expect(app.locator('html')).toHaveAttribute('data-material', id);
    await expect.poll(() => app.locator('html').evaluate(el => getComputedStyle(el).getPropertyValue('--studio-accent').trim().toLowerCase())).toBe(accent);
  }
  await group.screenshot({ path: info.outputPath('theme-previews.png') });
});

test('patterns switch independently and both choices persist to the account and survive a page reload', async ({ app, account }) => {
  const dialog = await settings(app);
  const patternGroup = dialog.getByRole('radiogroup', { name: 'Pattern', exact: true });
  await expect(patternGroup.getByRole('radio')).toHaveCount(8);
  for (const [name, id] of patterns) {
    await patternGroup.getByRole('radio', { name, exact: true }).click();
    await expect(app.locator('html')).toHaveAttribute('data-pattern', id);
    const mask = await app.locator('.app').evaluate(el => {
      const style = getComputedStyle(el, '::before');
      return { display: style.display, mask: style.maskImage || style.webkitMaskImage };
    });
    if (id === 'plain') expect(mask.display === 'none' || mask.mask === 'none').toBe(true);
    else { expect(mask.display).not.toBe('none'); expect(mask.mask).not.toBe('none'); }
  }
  await patternGroup.getByRole('radio', { name: 'Waves', exact: true }).click();
  await dialog.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: 'Ink & Pool Blue', exact: true }).click();
  await expect(app.locator('html')).toHaveAttribute('data-pattern', 'waves');
  await expect.poll(async () => {
    const { json } = await accountJson(account, '/kanban/account');
    return [json.preferences.studioTheme, json.preferences.studioPattern];
  }).toEqual(['ink-pool-blue', 'waves']);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await app.goto(new URL('/', app.url()).href);
  await expect(app.locator('html')).toHaveAttribute('data-material', 'ink-pool-blue');
  await expect(app.locator('html')).toHaveAttribute('data-pattern', 'waves');
  const reopened = await settings(app);
  await expect(reopened.getByRole('radio', { name: 'Ink & Pool Blue', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(reopened.getByRole('radio', { name: 'Waves', exact: true })).toHaveAttribute('aria-checked', 'true');
});

test('keyboard choices preserve the other appearance setting and fit the viewport', async ({ app }) => {
  const dialog = await settings(app);
  const waves = dialog.getByRole('radio', { name: 'Waves', exact: true });
  await waves.press('Enter');
  await waves.press('ArrowRight');
  const hexagons = dialog.getByRole('radio', { name: 'Hexagons', exact: true });
  await expect(hexagons).toBeFocused();
  await expect(hexagons).toHaveAttribute('aria-checked', 'true');
  const sky = dialog.getByRole('radio', { name: 'Sky & Lemon', exact: true });
  await sky.press('Enter');
  await sky.press('ArrowRight');
  await expect(dialog.getByRole('radio', { name: 'Violet & Chartreuse', exact: true })).toBeFocused();
  await expect(app.locator('html')).toHaveAttribute('data-pattern', 'hexagons');
  const bounds = await dialog.boundingBox();
  const viewport = app.viewportSize()!;
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});

for (const [name, lightInk] of [['Sky & Lemon', false], ['Lime & Deep Violet', true]] as const) {
  test(`${name}: editor glass keeps controls readable and translucent`, async ({ app }) => {
    await chooseTheme(app, name);
    await openFromNotes(app, 'n0');
    const editor = panel(app);
    await editor.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
    const material = await editor.evaluate(el => {
      const s = getComputedStyle(el);
      const glass = getComputedStyle(el, '::before');
      return { blur: s.backdropFilter || s.getPropertyValue('-webkit-backdrop-filter'), blend: s.mixBlendMode, opacity: s.opacity, glass: glass.backgroundColor };
    });
    expect(material.blur).toContain('blur(16px)');
    expect(material.blend).toBe('normal');
    expect(material.opacity).toBe('1');
    expect(material.glass).not.toBe('rgba(0, 0, 0, 0)');
    for (const [locator, property] of [
      [editor.getByTestId('detail-title'), 'color'],
      [editor.getByTestId('detail-add-label'), 'border-top-color'],
    ] as const) {
      const [r, g, b, alpha] = await rgbaOf(locator, property);
      expect(Math.max(r, g, b) - Math.min(r, g, b), `${property} carries a subtle surface tint`).toBeLessThanOrEqual(31);
      expect(alpha).toBeGreaterThan(0);
      if (property === 'color') expect(alpha).toBe(1);
      else expect(alpha).toBeLessThan(1);
      if (lightInk) expect(Math.min(r, g, b)).toBeGreaterThanOrEqual(224);
      else expect(Math.max(r, g, b)).toBeLessThanOrEqual(31);
    }
    const field = editor.getByTestId('detail-add-items');
    const [r, g, b, alpha] = await rgbaOf(field, 'background-color');
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(31);
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(0.2);
    expect(await editor.locator('.ring6-hole').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  });
}


test('capture bar and floating editor share the same frosted material in every theme', async ({app},testInfo) => {
  test.setTimeout(90000);
  const material = (el: Element) => {
    const s=getComputedStyle(el),before=getComputedStyle(el,'::before'),after=getComputedStyle(el,'::after');
    return {blur:s.backdropFilter || s.getPropertyValue('-webkit-backdrop-filter'),fill:s.getPropertyValue('--glass-fill').trim(),tint:before.backgroundColor,chroma:before.filter,overlay:after.backgroundColor,overlayOpacity:after.opacity,opacity:s.opacity};
  };
  for (const [name,id] of themes) {
    await chooseTheme(app,name);
    const bar=app.getByTestId('composer');
    const capture=await bar.evaluate(material);
    expect(capture.fill).toBe('51.2%');
    expect(capture.blur).toBe('blur(16px) saturate(0.5) contrast(1.25)');
    expect(capture.chroma).toBe('saturate(1)');
    if(id==='sky-lemon') await app.screenshot({path:testInfo.outputPath('capture-glass.png')});
    await app.getByTestId('composer-bar').click();
    const editor=app.locator('.dt-panel, .dt-sheet').filter({visible:true}).first();
    await editor.evaluate(el=>Promise.all(el.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
    await expect(editor).toBeVisible();
    expect(await editor.evaluate(material)).toEqual(capture);
    if (!isPhone()) {
      const header = (await app.locator('.topbar').boundingBox())!;
      expect((await editor.boundingBox())!.y).toBe(header.y + header.height);
    }
    const tintBounds=await editor.evaluate(el=>{const s=getComputedStyle(el,'::after');return {height:parseFloat(s.height),width:parseFloat(s.width),panelHeight:el.clientHeight,panelWidth:el.clientWidth};});
    expect(tintBounds.height).toBe(tintBounds.panelHeight);
    expect(tintBounds.width).toBe(tintBounds.panelWidth);
    if(['sky-lemon','ink-pool-blue','lime-deep-violet'].includes(id)) await app.screenshot({path:testInfo.outputPath(`${id}-editor-glass.png`)});
    await editor.locator('.dt-float-close,.dt-sheet-close').filter({visible:true}).click();
    await expect(editor).toBeHidden();
  }
});


test('phone tint covers the whole editor when the keyboard opens', async ({app},testInfo) => {
  test.skip(!isPhone(),'phone keyboard viewport');
  await app.addInitScript(() => { Object.defineProperty(window.visualViewport!, 'height', {get:()=> (window as any).__testViewportHeight ?? window.innerHeight}); });
  await app.reload();
  await chooseTheme(app,'Sky & Lemon');
  await app.getByTestId('composer-bar').click();
  const editor=app.locator('.dt-panel, .dt-sheet').filter({visible:true}).first();
  await editor.getByRole('textbox',{name:'Note body'}).focus();
  await app.evaluate(()=>{(window as any).__testViewportHeight=500;window.visualViewport!.dispatchEvent(new Event('resize'));});
  await expect(app.locator('html')).toHaveCSS('--kb','374px');
  await expect.poll(()=>editor.evaluate(el=>{const s=getComputedStyle(el,'::after');return {tintHeight:parseFloat(s.height),panelHeight:el.clientHeight};})).toEqual({tintHeight:874,panelHeight:874});
  await expect(editor.locator('.dt-scroll')).toHaveCSS('height','874px');
  await expect(editor).toHaveCSS('--glass-fill','51.2%');
  await app.screenshot({path:testInfo.outputPath('phone-keyboard-glass.png')});
});


test('installed phone header keeps its glass while search retains its overlay', async ({ app }) => {
  test.skip(!isPhone(), 'Installed phone material.');
  await app.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true, configurable: true }));
  await app.reload();
  await expect(app.locator('html')).toHaveAttribute('data-ios-standalone', '');
  await expect(app.locator('.topbar')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(app.locator('.topbar')).toHaveCSS('backdrop-filter', /blur\(18px\)/);
  await app.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(app.locator('.phone-search-layer')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});
