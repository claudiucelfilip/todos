import { accountJson, expect, isPhone, test } from './journeys';

for (const [name, id, color] of [
  ['Sky & Lemon', 'sky-lemon', 'rgb(204, 238, 255)'],
  ['Ink & Pool Blue', 'ink-pool-blue', 'rgb(16, 26, 38)'],
]) {
  test(`refresh keeps ${name} throughout account loading`, async ({ app, account }) => {
    if (isPhone()) await app.getByRole('button', { name: 'More options' }).click();
    await app.getByTestId('settings').click();
    const settings = app.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('radio', { name, exact: true }).click();
    await expect.poll(async () => (await accountJson(account, '/kanban/account')).json.preferences.studioTheme).toBe(id);
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await app.addInitScript(() => {
      (window as any).__paintColors = [];
      const sample = () => {
        (window as any).__paintColors.push(getComputedStyle(document.documentElement).backgroundColor);
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await app.route('**/kanban/session*', async route => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await route.continue();
    });
    await app.reload();
    await expect(app.locator('.app')).toBeVisible();
    await expect(app.locator('html')).toHaveAttribute('data-material', id);
    const colors = await app.evaluate(() => (window as any).__paintColors as string[]);
    expect(colors.length).toBeGreaterThan(10);
    expect([...new Set(colors)]).toEqual([color]);
  });
}
