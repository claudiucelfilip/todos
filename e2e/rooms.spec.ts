// Journey 15 (§13): switching rooms.
import { accountJson, expect, K, openFromNotes, openLabels, openView, panel, pushActions, scope, setTheme, test } from './journeys';

test('15. switch rooms: only that room shows; labels, filters and selection reset; theme stays', async ({ app, account, api }) => {
  // A second (shared) room exists already (the invitation room): seed one card into it through the API.
  const acc = await accountJson(account, '/kanban/account');
  const shared = acc.json.rooms.find((r: any) => !r.private);
  expect(shared).toBeTruthy();
  const now = new Date().toISOString();
  const card = { id: 'room2-card', title: 'Shared room card', notes: '', status: 'todo', order: 0, items: [], labels: [], createdAt: now, updatedAt: now, completedAt: null, archivedAt: null, someday: false, repeat: false, remindAt: null, remindedAt: null, layout: { order: 0, w: 1, h: 1 } };
  await pushActions(account, [{ id: 'a-room2', deviceId: 'e2e', ts: now, type: 'card.put', payload: { card } }], shared.id);

  // State that must reset: a theme (must not), a label filter and a selected card.
  await setTheme(app, 'sky');
  await openView(app, 'notes');
  await openLabels(app);
  await app.getByTestId('labels-row-home').click();
  await app.keyboard.press('Escape');
  await scope(app).locator('[data-testid^="note-"]').first().click({ position: { x: 14, y: 40 } });
  await expect(panel(app)).toBeVisible();
  await app.keyboard.press('Escape');

  await app.getByRole('button', { name: /Switch room/ }).click();
  await app.getByRole('button', { name: new RegExp(shared.name) }).click();
  await expect(app.getByRole('button', { name: new RegExp(`current room ${shared.name}`) })).toBeVisible();
  await app.locator('.app').waitFor();

  await openView(app, 'board');
  await expect(app.getByText('Shared room card').filter({ visible: true }).first()).toBeVisible();
  await expect(app.getByText('Plan the Lisbon trip')).toHaveCount(0);
  await openView(app, 'notes');
  await expect(app.getByText('Shared room card').filter({ visible: true }).first()).toBeVisible();
  await expect(app.getByText('Camping kit')).toHaveCount(0);
  await expect(app.getByTestId('label-filter').first()).not.toContainText(/·\s*\d|^\s*1\s*$/);
  await expect(panel(app)).toHaveCount(0);
  await expect(app.locator('html')).toHaveAttribute('data-material', 'sky-lemon');
  expect(K('x')).toBe('v6-x');
  void api;
});

test('15b. a room owner renames, invites (expiry, New link) and deletes from the ··· menu', async ({ app, account }) => {
  const made = await accountJson(account, '/kanban/rooms', { body: { name: 'Trip crew' } });
  expect(made.status).toBe(200);
  const id = made.json.room.id;
  const rooms = app.locator('.rooms');
  await app.getByRole('button', { name: /Switch room/ }).click();
  // Separators are visible (--line is transparent in every theme)
  expect(await rooms.locator('.rooms-header').evaluate((n) => getComputedStyle(n).borderBottomColor)).not.toBe('rgba(0, 0, 0, 0)');

  await rooms.getByTestId(`room-options-${id}`).click();
  await app.getByRole('menuitem', { name: 'Rename' }).click();
  await rooms.getByLabel('Room name').fill('Lisbon crew');
  await rooms.getByRole('button', { name: 'Save' }).click();
  await expect(rooms).toContainText('Lisbon crew');

  await rooms.getByTestId(`room-options-${id}`).click();
  await app.getByRole('menuitem', { name: 'Invite someone' }).click();
  await rooms.getByRole('button', { name: 'Generate link' }).click();
  const link = rooms.getByLabel('Invitation link');
  await expect(link).toHaveValue(/invite=/);
  const first = await link.inputValue();
  await expect(rooms.locator('.rooms-expiry')).toHaveText(/^Expires \d{1,2} \w{3} · not yet used$/);
  await rooms.getByRole('button', { name: 'New link' }).click();
  await expect(link).not.toHaveValue(first);
  const token = new URL(first).searchParams.get('invite');
  expect((await fetch(`${account.base}/kanban/invitation?token=${token}`)).status, 'the replaced link stops working').toBe(404);
  await rooms.getByRole('button', { name: 'Done' }).click();

  await rooms.getByTestId(`room-options-${id}`).click();
  await app.getByRole('menuitem', { name: 'Delete room' }).click();
  await rooms.getByRole('button', { name: 'Delete room' }).click();
  await expect(rooms).not.toContainText('Lisbon crew');
  expect((await accountJson(account, '/kanban/account')).json.rooms.some((r: any) => r.id === id)).toBe(false);
});
