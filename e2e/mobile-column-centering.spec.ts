import { test, expect, isPhone, openColumn, openView, swipe } from './journeys';

test('mobile columns center after tab selection, swipes and viewport changes', async ({ app }, info) => {
  test.skip(!isPhone(), 'Phone paging geometry.');
  await openView(app, 'board');
  for (const width of [320, 375, 402, 430]) {
    await app.setViewportSize({ width, height: 874 });
    for (const status of ['todo', 'doing', 'done'] as const) {
      await openColumn(app, status);
      const column = app.locator(`.phone-panes .column.${status}`);
      await app.locator('.phone-panes .columns').evaluate(el => Promise.all(el.getAnimations().map(a => a.finished.catch(() => {}))));
      await expect.poll(async () => {
        const b = (await column.boundingBox())!;
        return Math.abs(b.x + b.width / 2 - width / 2);
      }).toBeLessThanOrEqual(1);
      const b = (await column.boundingBox())!;
      expect(b.x).toBeCloseTo(16, 0);
      expect(b.x + b.width).toBeCloseTo(width - 16, 0);
      const neighbors = await column.evaluate(el => [el.previousElementSibling, el.nextElementSibling]
        .filter(Boolean).map(sibling => {
          const rect = sibling!.getBoundingClientRect();
          return { left: rect.left, right: rect.right };
        }));
      for (const neighbor of neighbors) expect(neighbor.right <= 0 || neighbor.left >= width).toBe(true);
    }
  }
  await openColumn(app, 'doing');
  await expect(app.locator('.phone-panes .column.doing .column-header')).toBeHidden();
  const tabs = (await app.locator('.phone-column-pills').boundingBox())!;
  await swipe(app, { x: 350, y: tabs.y + tabs.height + 10 }, { x: 70, y: tabs.y + tabs.height + 10 });
  await expect(app.getByTestId('nav-done')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => {
    const b = (await app.locator('.phone-panes .column.done').boundingBox())!;
    return Math.abs(b.x + b.width / 2 - 215);
  }).toBeLessThanOrEqual(1);
  await app.screenshot({ path: info.outputPath('done-column-centered.png') });
});

test('pulling down leaves search closed; the header search button still opens it', async ({app}) => {
  test.skip(!isPhone(), 'Phone search gesture.');
  await openView(app,'board');
  await openColumn(app,'todo');
  const tabs=(await app.locator('.phone-column-pills').boundingBox())!;
  await swipe(app,{x:200,y:tabs.y+tabs.height+10},{x:200,y:tabs.y+tabs.height+200});
  await expect(app.getByRole('searchbox',{name:'Search cards'})).toBeHidden();
  await app.getByRole('button',{name:'Search',exact:true}).click();
  await expect(app.getByRole('searchbox',{name:'Search cards'})).toBeVisible();
});
