import { expect, openCard, openColumn, openView, test } from './fixtures';

test('loads the seeded board, switches to Notes, opens a card', async ({ app }) => {
  await openColumn(app, 'doing');
  await expect(app.getByText('Plan the Lisbon trip').filter({ visible: true }).first()).toBeVisible();
  await openView(app, 'notes');
  await expect(app.getByText('Camping kit').first()).toBeVisible();
  await openView(app, 'board');
  await openColumn(app, 'doing');
  await openCard(app, 'Plan the Lisbon trip');
  // desktop: floating .dt-panel; phone: bottom sheet .dt-sheet
  await expect(app.locator('.dt-panel, .dt-sheet').first()).toBeVisible();
});
