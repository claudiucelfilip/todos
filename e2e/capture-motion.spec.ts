import { test, expect, panel } from './journeys';

test('capture expands visibly, keeps focus, and does not replay while typing', async ({ app }, info) => {
  await app.evaluate(() => {
    document.addEventListener('animationstart', event => {
      const el = event.target as HTMLElement;
      if (el.matches('.dt-panel.creating, .dt-sheet.creating')) el.getAnimations().forEach(a => a.pause());
    });
  });
  await app.getByTestId('composer-bar').click();
  const editor = panel(app);
  const frames = await editor.evaluate(async el => {
    const animation = el.getAnimations()[0];
    if (!animation) throw new Error('Capture entrance missing');
    animation.pause();
    const result: number[] = [];
    for (const time of [0, 100, 200, 399]) {
      animation.currentTime = time;
      result.push(new DOMMatrixReadOnly(getComputedStyle(el).transform).m42);
    }
    animation.currentTime = 100;
    return result;
  });
  for (let i = 1; i < frames.length; i++) expect(frames[i]).toBeLessThan(frames[i - 1]);
  expect(frames[3]).toBeLessThan(1);
  await app.screenshot({ path: info.outputPath('capture-in-progress.png') });
  await editor.evaluate(el => el.getAnimations().forEach(a => a.finish()));
  const body = editor.getByRole('textbox', { name: 'Note body' });
  await expect(body).toBeFocused();
  await body.fill('Typing stays immediate');
  await body.press('A');
  expect(await editor.evaluate(el => el.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
  await expect(editor).toHaveCSS('clip-path', 'none');
  await app.screenshot({ path: info.outputPath('capture-open.png') });
});

test('reduced motion opens capture without expansion', async ({ app }) => {
  await app.emulateMedia({ reducedMotion: 'reduce' });
  await app.getByTestId('composer-bar').click();
  await expect(panel(app)).toBeVisible();
  expect(await panel(app).evaluate(el => el.getAnimations().length)).toBe(0);
});


test('existing editor slides continuously from the right', async ({ app }, info) => {
  await app.evaluate(() => {
    document.addEventListener('animationstart', event => {
      const el = event.target as HTMLElement;
      if (el.matches('.dt-panel, .dt-sheet')) el.getAnimations().forEach(a => a.pause());
    });
  });
  await app.locator('.column[data-status="todo"] article.card-face').first().click({ position: { x: 14, y: 14 } });
  const editor = panel(app);
  const positions = await editor.evaluate(el => {
    const animation = el.getAnimations()[0];
    if (!animation) throw new Error('Editor slide missing');
    const result: number[] = [];
    for (const time of [0, 100, 200, 399]) {
      animation.currentTime = time;
      result.push(new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);
    }
    animation.currentTime = 100;
    return { values: result, width: el.clientWidth };
  });
  expect(positions.values[0]).toBeCloseTo(positions.width, 0);
  for (let i = 1; i < positions.values.length; i++) expect(positions.values[i]).toBeLessThan(positions.values[i - 1]);
  expect(positions.values[3]).toBeLessThan(1);
  await app.screenshot({ path: info.outputPath('editor-slide-midpoint.png') });
  await editor.evaluate(el => el.getAnimations().forEach(a => a.finish()));
  await expect(editor).toHaveAttribute('data-entry-settled', '');
});
