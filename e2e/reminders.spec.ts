// Journey 14 (§13): reminders from the panel.
import { expect, K, localInput, nextWeekday, openFromNotes, panel, test } from './journeys';

test('14. reminder: set Fri 11:07 (a note becomes a to do), clear keeps it where it is', async ({ app, api }) => {
  await openFromNotes(app, 'n3');
  const chip = panel(app).getByTestId('detail-remind');
  await expect(chip).toContainText('Remind');
  await chip.click();
  await app.getByTestId('remind-pick').click();
  const fri = nextWeekday(5, 11, 7);
  await app.getByTestId('remind-input').fill(localInput(fri));
  await app.getByTestId('remind-set').click();

  await expect(chip).toContainText('Fri 11:07');
  await expect.poll(async () => (await api.cards()).find((c) => c.id === K('n3')).remindAt).toBe(fri.toISOString());
  await expect.poll(async () => (await api.cards()).find((c) => c.id === K('n3')).kind).not.toBe('note');
  expect((await api.cards()).find((c) => c.id === K('n3')).status).toBe('todo');

  await panel(app).getByTestId('detail-remind-clear').click();
  await expect(chip).toHaveText(/^\s*Remind\s*$/);
  await expect.poll(async () => (await api.cards()).find((c) => c.id === K('n3')).remindAt).toBeNull();
  const after = (await api.cards()).find((c) => c.id === K('n3'));
  expect(after.kind).not.toBe('note'); // stays a to do
  expect(after.status).toBe('todo');
});
