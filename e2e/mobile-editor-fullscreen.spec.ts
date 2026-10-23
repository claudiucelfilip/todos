import { test, expect, isPhone, panel } from './journeys';

test('mobile capture fills the screen while its content follows the keyboard viewport', async ({ app }, info) => {
  test.skip(!isPhone(), 'Mobile editor and keyboard geometry.');
  await app.addInitScript(() => {
    Object.defineProperty(window.visualViewport!, 'height', { get: () => (window as any).__editorHeight ?? window.innerHeight });
    Object.defineProperty(window.visualViewport!, 'offsetTop', { get: () => (window as any).__editorTop ?? 0 });
  });
  await app.reload();
  await app.getByTestId('composer-bar').click();
  const editor = panel(app);
  await expect(editor).toBeVisible();
  await editor.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished.catch(() => {}))));
  const bounds = (await editor.boundingBox())!;
  expect(bounds.y).toBe(0);
  expect(bounds.height).toBe(874);
  const ring = (await editor.locator('.dt-top > .ring6-btn').boundingBox())!;
  const caption = (await editor.locator('.dt-new').boundingBox())!;
  expect(caption.x - ring.x - ring.width).toBeLessThanOrEqual(4);
  await expect(editor.getByTestId('detail-add-label')).toHaveCSS('height', '44px');
  await expect(editor.locator('.dt-remind-btn')).toHaveCSS('height', '44px');
  await expect(editor.locator('.dt-chips > .label-pill').first()).toHaveCSS('height', '44px');
  await editor.getByRole('textbox', { name: 'Note body' }).focus();
  await app.evaluate(() => {
    (window as any).__editorHeight = 500;
    (window as any).__editorTop = 60;
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(editor.locator('.dt-scroll')).toHaveCSS('height', '814px');
  await expect(editor.locator('.dt-scroll')).toHaveCSS('margin-top', '60px');
  // Content paints behind the floating accessory toolbar instead of ending above it.
  expect((await editor.locator('.dt-scroll').boundingBox())!.y + (await editor.locator('.dt-scroll').boundingBox())!.height).toBe(874);
  await expect(editor.locator('.dt-scroll')).toHaveCSS('padding-bottom', '338px');
  // Native iOS changes innerHeight as it pans, without changing keyboard height.
  await app.evaluate(() => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 650 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(() => app.locator('html').evaluate(el => (el as HTMLElement).style.getPropertyValue('--kb'))).toBe('374px');
  expect((await editor.boundingBox())!.height).toBe(874);
  const input = editor.getByTestId('detail-add-items');
  await input.focus();
  // The keyboard resizes after focus; the full field must remain above it.
  await app.evaluate(() => {
    (window as any).__editorHeight = 320;
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(() => input.evaluate(el => Math.ceil(el.getBoundingClientRect().bottom))).toBeLessThanOrEqual(356);
  await input.fill('An item above the keyboard');
  await input.press('Enter');
  await expect(editor.locator('.dt-row-text')).toContainText('An item above the keyboard');
  await input.fill('A second item');
  await app.screenshot({ path: info.outputPath('fullscreen-editor-keyboard.png') });
  await input.press('Enter');
  await expect(editor.locator('.dt-row-text').last()).toHaveText('A second item');
  await expect.poll(() => input.evaluate(el => Math.ceil(el.getBoundingClientRect().bottom))).toBeLessThanOrEqual(356);
});
