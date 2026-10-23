// Journeys 8-10 (§13): nest with [[, a nested tick propagates, breadcrumb navigation.
import { expect, K, noteCard, openFromNotes, openView, panel, itemBox, scope, test, toast } from './journeys';

test('8. nest with [[: a note-shaped ref row; cycles are not offered', async ({ app, api }) => {
  // The seed already links Water filter under Camping kit, so link it from another note (Hallway paint).
  await openFromNotes(app, 'n7');
  const add = panel(app).getByTestId('detail-add-items');
  await add.click();
  await add.pressSequentially('[[wat');
  await expect(app.getByRole('listbox', { name: 'Link a note or to do' }).getByRole('option').first()).toContainText('Water filter: which one');
  await add.press('Enter');
  const row = panel(app).locator('.dt-row.ref', { hasText: 'Water filter: which one' });
  await expect(row).toBeVisible();
  await expect(row.locator('.ref-tag')).toContainText(/\d\/\d/);
  await expect.poll(async () => (await api.cards()).find((c) => c.id === K('n7')).items.some((i: any) => i.ref === K('n14'))).toBe(true);

  // Cycle guard: inside Water filter, its parent Camping kit is never offered.
  await app.keyboard.press('Escape'); // the first Esc leaves the add field (§11.24.1)
  await expect(panel(app)).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(panel(app)).toBeHidden();
  await noteCard(app, 'n14').click({ position: { x: 14, y: 40 } });
  const add2 = panel(app).getByTestId('detail-add-items');
  await add2.click();
  await add2.pressSequentially('[[camp');
  const pop = app.getByRole('listbox', { name: 'Link a note or to do' });
  await expect(pop).toBeVisible();
  await expect(pop.getByRole('option', { name: /Camping kit/ })).toHaveCount(0);
});

test('9. a nested tick propagates to the parent row and the grid, and Undo reverses it', async ({ app, api }) => {
  await openFromNotes(app, 'n14');
  await itemBox(app, K('n14-0')).click(); // Ask Rui about the squeeze filter
  await expect.poll(async () => (await api.cards()).find((c) => c.id === K('n16')).labels).toContain('workflow:done');
  // Camping kit: the Water filter row now reads 1/2
  await app.keyboard.press('Escape');
  await expect(panel(app)).toBeHidden();
  await noteCard(app, 'n8').click({ position: { x: 14, y: 40 } });
  await expect(panel(app).locator('.dt-row.ref', { hasText: 'Water filter' }).locator('.ref-tag')).toContainText('1/2');
  // grid card struck
  await app.keyboard.press('Escape');
  await expect(noteCard(app, 'n16')).toHaveClass(/done/);
  // Undo reverses all of it
  await app.getByTestId('toast-undo').click();
  await expect.poll(async () => (await api.cards()).find((c) => c.id === K('n16')).labels).not.toContain('workflow:done');
  await expect(noteCard(app, 'n16')).not.toHaveClass(/done/);
  await noteCard(app, 'n8').click({ position: { x: 14, y: 40 } });
  await expect(panel(app).locator('.dt-row.ref', { hasText: 'Water filter' }).locator('.ref-tag')).toContainText('0/2');
});

test('10. breadcrumb navigation: Esc walks back one level, then closes', async ({ app }) => {
  await openFromNotes(app, 'n8');
  await panel(app).getByRole('button', { name: 'Open Water filter: which one' }).click();
  await panel(app).getByRole('button', { name: 'Open Ask Rui about the squeeze filter' }).click();
  const crumbs = panel(app).getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumbs).toContainText('Camping kit');
  await expect(crumbs).toContainText('Water filter: which one');
  const title = panel(app).getByTestId('detail-title');
  await app.keyboard.press('Escape');
  await expect(title).toHaveValue('Water filter: which one');
  await app.keyboard.press('Escape');
  await expect(title).toHaveValue('Camping kit');
  await app.keyboard.press('Escape');
  await expect(panel(app)).toBeHidden();
});
