import { expect, openFromNotes, panel, isPhone, test } from './journeys';

test('label picker stays readable, anchored and usable without shifting the editor', async ({ app, api }, testInfo) => {
  if (isPhone()) await app.getByRole('button', { name: 'More options' }).click();
  await app.getByTestId('settings').click();
  const settings = app.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('radio', { name: 'Royal Blue & Acid Green', exact: true }).click();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(settings).toBeHidden();
  await openFromNotes(app, 'n8');
  await panel(app).evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {}))); });
  const trigger = panel(app).getByTestId('detail-add-label');
  const before = await trigger.boundingBox();
  await trigger.click();
  const picker = app.getByRole('dialog', { name: 'Add label', exact: true });
  await expect(picker).toBeVisible();
  const after = await trigger.boundingBox();
  expect(after?.x).toBe(before?.x);
  expect(after?.y).toBe(before?.y);
  await expect(panel(app).locator('.dt-remind-anchor')).toBeVisible();
  expect(await picker.evaluate((el) => el.parentElement?.classList.contains('app'))).toBe(true);
  const surface = await picker.evaluate((el) => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, position: style.position };
  });
  expect(surface.position).toBe('fixed');
  expect(await picker.evaluate(el => getComputedStyle(el).backdropFilter)).toContain('blur(16px)');
  const none = picker.getByRole('radio', { name: 'None', exact: true });
  await expect(none).toBeFocused();
  await none.press('ArrowDown');
  await expect(picker.getByRole('radio', { name: 'To do', exact: true })).toBeChecked();
  await app.keyboard.press('ArrowDown');
  await expect(picker.getByRole('radio', { name: 'Doing', exact: true })).toBeChecked();
  await expect.poll(async () => (await api.cards()).find((c) => c.id === 'v6-n8').labels).toContain('workflow:doing');
  await app.screenshot({ path: testInfo.outputPath('label-picker-initial.png') });
  await picker.getByRole('button', { name: 'New label…', exact: true }).click();
  await expect(picker.getByRole('textbox', { name: 'New label', exact: true })).toBeFocused();
  const name = 'A long label for planning next project';
  await picker.getByRole('textbox', { name: 'New label', exact: true }).fill(name);
  await picker.getByTestId('label-new-add').click();
  const check = picker.getByRole('checkbox', { name, exact: true });
  await expect(check).toBeChecked();
  await check.uncheck();
  await check.check();
  await expect.poll(async () => (await api.snapshot()).labels.some((l) => l.name === name)).toBe(true);
  const bounds = await picker.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(12);
  expect(bounds!.y).toBeGreaterThanOrEqual(12);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(app.viewportSize()!.width - 12);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(app.viewportSize()!.height - 12);
  await app.screenshot({ path: testInfo.outputPath('label-picker.png') });
  await app.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(panel(app)).toBeVisible();
  await trigger.click();
  await expect(picker.getByRole('radio', { name: 'Doing', exact: true })).toBeFocused();
  await app.keyboard.press('Escape');
});

for (const width of [320, 402]) {
  test(`phone label creation stays reachable above a panned keyboard at ${width}px`, async ({ app, api }, info) => {
    test.skip(!isPhone(), 'Phone visual viewport.');
    await app.setViewportSize({ width, height:874 });
    await app.addInitScript(() => {
      Object.defineProperty(window.visualViewport!, 'height', { get: () => (window as any).__labelVvh ?? window.innerHeight });
      Object.defineProperty(window.visualViewport!, 'offsetTop', { get: () => (window as any).__labelVvt ?? 0 });
    });
    await app.reload();
    await openFromNotes(app, 'n8');
    await panel(app).getByTestId('detail-add-label').click();
    const picker=app.getByRole('dialog', {name:'Add label',exact:true});
    await picker.getByRole('button',{name:'New label…',exact:true}).click();
    await app.evaluate(() => {
      (window as any).__labelVvh=300;
      (window as any).__labelVvt=80;
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect.poll(async () => (await picker.boundingBox())!.y).toBe(92);
    const name=picker.getByRole('textbox',{name:'New label',exact:true});
    await name.fill(`Phone label ${width}`);
    await expect(name).toHaveCSS('font-size','16px');
    const add=picker.getByTestId('label-new-add');
    const bounds=(await picker.boundingBox())!;
    expect(bounds.x).toBe(12);
    expect(bounds.width).toBe(width-24);
    expect(bounds.y+bounds.height).toBeLessThanOrEqual(368);
    for(const control of [picker.getByRole('button',{name:'Close labels'}),name,add]) {
      const b=(await control.boundingBox())!;
      expect(b.y).toBeGreaterThanOrEqual(92);
      expect(b.y+b.height).toBeLessThanOrEqual(368);
    }
    expect(await picker.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await picker.locator('button[data-swatch]').last().click();
    await expect(picker.locator('button[data-swatch]').last()).toHaveAttribute('aria-checked','true');
    await app.screenshot({path:info.outputPath('phone-label-keyboard.png')});
    await add.click();
    await expect.poll(async ()=>(await api.snapshot()).labels.some(l=>l.name===`Phone label ${width}`)).toBe(true);
    await expect(picker.getByRole('checkbox',{name:`Phone label ${width}`,exact:true})).toBeChecked();
    await picker.getByRole('button',{name:'Close labels'}).click();
    await expect(picker).toBeHidden();
    await expect(panel(app)).toBeVisible();
  });
}
