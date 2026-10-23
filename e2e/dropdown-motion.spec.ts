import { expect, isPhone, openFromBoard, test } from './journeys';

test('card menus animate in and out when tapped', async ({ app }) => {
  await openFromBoard(app, 't2', 'todo');
  const trigger = app.getByRole('button', { name: 'Card menu', exact: true });
  const menu = app.locator('.dt-menu.dt-menu-float');
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS('animation-name', 'dropdown-open');
  await trigger.click();
  await expect(menu).toHaveAttribute('data-closing', 'true');
  await expect(menu).toHaveCSS('animation-name', 'dropdown-close');
  await expect(menu).toHaveCount(0);
});

test('phone options animate in and out; reduced motion skips the animation', async ({ app }) => {
  test.skip(!isPhone(), 'Phone options menu');
  const trigger = app.getByRole('button', { name: 'More options' });
  const menu = app.locator('.phone-more-menu');
  await trigger.click();
  await expect(menu).toHaveCSS('animation-name', 'dropdown-open');
  await trigger.click();
  await expect(menu).toHaveAttribute('data-closing', 'true');
  await expect(menu).toHaveCSS('animation-name', 'dropdown-close');
  await expect(menu).toHaveCount(0);

  await app.evaluate(() => document.documentElement.setAttribute('data-reduce-motion', 'on'));
  await trigger.click();
  await expect(menu).toHaveCSS('animation-name', 'none');
  await trigger.click();
  await expect(menu).toHaveCount(0);
});

test('room switcher closes with its anchored or phone-sheet motion', async ({ app }) => {
  await app.getByRole('button', { name: /Switch room, current room/ }).click();
  const menu = app.getByRole('dialog', { name: 'Rooms' });
  await expect(menu).toBeVisible();
  await app.getByRole('button', { name: 'Close rooms' }).click();
  const leaving = app.locator('.rooms[data-closing]');
  await expect(leaving).toHaveCSS('animation-name', isPhone() ? 'dropdown-sheet-close' : 'dropdown-close');
  await expect(app.locator('.rooms')).toHaveCount(0);
});
