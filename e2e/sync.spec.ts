// Journey 25 (§13): offline edit syncs when back online, per field, no duplicates.
import { expect, K, openFromBoard, panel, pushActions, setFields, test } from './journeys';

test('25. offline: a title edit syncs on reconnect, a different field edited elsewhere is kept, no duplicate card', async ({ app, api, account, context }) => {
  const count = (await api.cards()).length;
  await openFromBoard(app, 'd2', 'doing'); // Groceries
  await context.setOffline(true);
  await expect(app.getByTestId('sync-hint')).toBeVisible({ timeout: 2000 }).catch(() => {});
  const title = panel(app).getByTestId('detail-title');
  await title.fill('Groceries for Sunday');
  await title.blur();
  // Meanwhile another device edits a different field of the same card.
  await pushActions(account, [setFields(K('d2'), { notes: 'Edited on another device' })]);
  expect((await api.cards()).find((c) => c.id === K('d2')).title).toBe('Groceries'); // not synced while offline

  await context.setOffline(false);
  await expect.poll(async () => (await api.cards()).find((c) => c.id === K('d2')).title).toBe('Groceries for Sunday');
  const cards = await api.cards();
  expect(cards).toHaveLength(count);
  expect(cards.filter((c) => c.title.startsWith('Groceries'))).toHaveLength(1);
  expect(cards.find((c) => c.id === K('d2')).notes).toBe('Edited on another device');
});
