import { test, expect } from './fixtures';

const editor = '.dt-panel, .dt-sheet';

test('keyboard open and close are immediate; pointer restores motion', async ({ app }) => {
  const card = app.locator('.column[data-status="todo"] article.card-face').first();
  await card.focus();
  await app.keyboard.press('Enter');
  await expect(app.locator(editor).first()).toBeVisible();
  expect(await app.locator(editor).first().evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  expect(await app.locator('html').getAttribute('data-motion-input')).toBe('keyboard');
  await app.keyboard.press('Escape');
  await expect(app.locator(editor)).toHaveCount(0);
  await expect(app.locator('.exit-clone')).toHaveCount(0);
  await card.click({ position: { x: 14, y: 14 } });
  await expect(app.locator(editor).first()).toBeVisible();
  expect(await app.locator('html').getAttribute('data-motion-input')).toBe('pointer');
  const duration = await app.locator(editor).first().evaluate(el => parseFloat(getComputedStyle(el).animationDuration));
  expect(duration).toBeGreaterThan(0);
  expect(duration).toBeLessThanOrEqual(0.4);
});

test('OS and explicit reduced motion suppress movement, delays and pseudo-element transitions', async ({ app }) => {
  await app.emulateMedia({ reducedMotion: 'reduce' });
  for (const setting of ['system', 'on']) {
    await app.locator('html').evaluate((el, setting) => el.setAttribute('data-reduce-motion', setting), setting);
    const card = app.locator('.column[data-status="todo"] article.card-face').first();
    await card.click({ position: { x: 14, y: 14 } });
    await expect(app.locator(editor).first()).toBeVisible();
    const motion = await app.locator(editor).first().evaluate(el => {
      const style = getComputedStyle(el);
      const pseudo = getComputedStyle(el, '::after');
      return { name: style.animationName, property: style.transitionProperty, delay: style.transitionDelay, pseudo: pseudo.transitionProperty };
    });
    expect(motion.name).toBe('none');
    expect(motion.property).not.toMatch(/transform|width|height|left|top/);
    expect(motion.pseudo).not.toMatch(/transform|width|height|left|top/);
    expect(motion.delay).toBe('0s');
    await app.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(app.locator(editor)).toHaveCount(0);
    await expect(app.locator('.exit-clone')).toHaveCount(0);
  }
});

test('rapid pointer open and close leaves no exit clones or hidden live cards', async ({ app }) => {
  const card = app.locator('.column[data-status="todo"] article.card-face').first();
  for (let i = 0; i < 3; i++) {
    await card.click({ position: { x: 14, y: 14 } });
    await expect(app.locator(editor).first()).toBeVisible();
    await app.getByRole('button', { name: 'Close', exact: true }).first().click();
  }
  await expect(app.locator('.exit-clone')).toHaveCount(0);
  await expect(app.locator('.move-hidden')).toHaveCount(0);
});

test('switching to reduced motion finishes an in-flight browser animation', async ({ app }) => {
  const count = await app.locator('.columns').evaluate(el => {
    el.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 10000 });
    return el.getAnimations().filter(a => a.playState === 'running').length;
  });
  expect(count).toBeGreaterThan(0);
  await app.locator('html').evaluate(el => el.setAttribute('data-reduce-motion', 'on'));
  await expect.poll(() => app.locator('.columns').evaluate(el => el.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
});

test('phone column paging settles within 300ms and respects reduced motion', async ({ app }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone paging');
  await app.getByTestId('nav-doing').click();
  const duration = await app.locator('.columns').evaluate(el => Math.max(0, ...el.getAnimations().map(a => Number(a.effect?.getTiming().duration) || 0)));
  expect(duration).toBeLessThanOrEqual(300);
  await expect.poll(() => app.locator('.columns').evaluate(el => el.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
  await app.locator('html').evaluate(el => el.setAttribute('data-reduce-motion', 'on'));
  await app.getByTestId('nav-todo').click();
  expect(await app.locator('.columns').evaluate(el => el.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
});

test('phone Board and Notes slide both ways, reverse cleanly, and skip motion for keyboard and reduced motion', async ({ app }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone view transition');
  const board = app.locator('.phone-panes');
  const notes = app.locator('.phone-notes-pane');
  const views = app.locator('.phone-panes, .phone-notes-pane');
  const freeze = () => views.evaluateAll(elements => {
    let transforms = 0;
    for (const el of elements) for (const animation of el.getAnimations()) {
      if ((animation as CSSTransition).transitionProperty === 'transform') transforms++;
      animation.pause();
      animation.currentTime = 120;
    }
    return transforms;
  });
  const finish = () => views.evaluateAll(elements => elements.forEach(el => el.getAnimations().forEach(a => a.finish())));
  await app.getByTestId('view-notes').click();
  expect(await freeze()).toBe(2);
  const entering = await notes.boundingBox();
  const leaving = await board.boundingBox();
  expect(entering!.x).toBeGreaterThan(16);
  expect(entering!.x).toBeLessThan(app.viewportSize()!.width);
  expect(leaving!.x).toBeLessThan(0);
  expect(leaving!.x).toBeGreaterThan(-app.viewportSize()!.width);
  await expect(board).toHaveAttribute('inert', '');
  await expect(notes).not.toHaveAttribute('inert', '');
  await app.screenshot({ path: testInfo.outputPath('phone-view-slide-midpoint.png') });
  await finish();
  await expect(board).toBeHidden();
  await expect(notes).toBeVisible();

  await app.getByTestId('view-board').click();
  expect(await freeze()).toBe(2);
  expect((await board.boundingBox())!.x).toBeLessThan(0);
  expect((await notes.boundingBox())!.x).toBeGreaterThan(16);
  // Reverse the transition before it reaches the end.
  await app.getByTestId('view-notes').click();
  await expect.poll(() => notes.evaluate(el => Math.round(el.getBoundingClientRect().left))).toBe(16);
  await expect(board).toBeHidden();

  await app.getByTestId('view-board').focus();
  await app.keyboard.press('Enter');
  expect(await views.evaluateAll(elements => elements.flatMap(el => el.getAnimations()).length)).toBe(0);
  await expect(board).toBeVisible();
  await expect(notes).toBeHidden();

  for (const setting of ['on', 'system']) {
    await app.emulateMedia({ reducedMotion: 'reduce' });
    await app.locator('html').evaluate((el, value) => el.setAttribute('data-reduce-motion', value), setting);
    await app.getByTestId('view-notes').click();
    expect(await views.evaluateAll(elements => elements.flatMap(el => el.getAnimations()).filter(a => (a as CSSTransition).transitionProperty === 'transform').length)).toBe(0);
    await expect(board).toBeHidden();
    await expect(notes).toBeVisible();
    await app.getByTestId('view-board').click();
  }
});
