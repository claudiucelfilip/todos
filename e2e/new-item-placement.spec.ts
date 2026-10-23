import { expect, isPhone, openColumn, openView, test } from './journeys';

test('a new to do appears first and switches from Done to To do', async ({ app, api }) => {
  test.skip(!isPhone(), 'Phone column navigation');
  await openView(app, 'board');
  await openColumn(app, 'done');
  await app.getByTestId('composer-bar').click();
  await app.locator('.dt-sheet .md-raw').fill('A fresh to do');
  await expect(app.getByTestId('nav-todo')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await api.cards()).find((c) => c.notes === 'A fresh to do')).toBeTruthy();
  await app.getByTestId('detail-close').click();
  await expect(app.locator('section.column.todo [data-testid^="card-"]').first()).toContainText('A fresh to do');
});

test('a new note appears first in Notes', async ({ app }) => {
  await openView(app, 'notes');
  await app.getByTestId('composer-bar').click();
  await app.locator(isPhone() ? '.dt-sheet .md-raw' : '.dt-panel .md-raw').fill('A fresh note');
  await app.getByTestId('detail-close').click();
  await expect(app.locator('.notes-grid [data-testid^="note-"]').first()).toContainText('A fresh note');
});

test('a captured to do appears above older cards', async ({ app }) => {
  await openView(app, 'board');
  await openColumn(app, 'todo');
  await app.evaluate(() => window.kanban?.addCard('Captured at the top'));
  await expect(app.locator('section.column.todo [data-testid^="card-"]').first()).toContainText('Captured at the top');
});
