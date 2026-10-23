// Journey 16 (§13, §11.21, §11.24.7): search.
import { expect, K, panel, scope, test, isPhone, openView, setTheme } from './journeys';
import type { Page } from '@playwright/test';

async function openSearch(app: Page) {
  if (isPhone()) {
    await app.getByRole('button', { name: 'Search' }).click();
  } else {
    // Board is the launch view; ⌘K from the page body.
    await app.keyboard.press('ControlOrMeta+k');
    await expect(app.getByTestId('search')).toBeFocused();
  }
}
const resultsOf = (app: Page) => (isPhone() ? app.locator('.phone-search-layer') : app.getByRole('listbox', { name: /search results/i }));

for (const theme of ['dark', 'light'] as const) {
  test(`16. search (${theme}): result rows show ring, title, snippet, dot and tag; Enter opens the first in the panel`, async ({ app }) => {
    await setTheme(app, theme);
    const before = await scope(app).locator('[data-testid^="note-"], [data-testid^="card-"]').count(); // the page behind
    await openSearch(app);
    await app.getByTestId('search').fill('sourdough');
    const results = resultsOf(app);
    await expect(results.locator('.search-pop-count')).toHaveText('2 results for "sourdough"');
    // Owner: as drawn, the Board and grid stay as they are behind the results (the phone has its own layer).
    if (!isPhone()) expect(await scope(app).locator('[data-testid^="note-"], [data-testid^="card-"]').count()).toBe(before);
    await expect(app.locator('.search-matches')).toHaveCount(0); // the field shows no count of its own
    const rows = results.locator('.search-row');
    await expect(rows).toHaveCount(2);
    const loaf = results.getByTestId(`search-result-${K('n6')}`);
    const learn = results.getByTestId(`search-result-${K('n13')}`);
    // ring in the card's state, title, `{label} · {date}` (only the title matched), the first label's pill, a lowercase tag
    await expect(loaf.locator('[data-ring="note"]')).toHaveCount(1);
    await expect(loaf.locator('.search-row-title')).toHaveText('Sourdough, basic loaf');
    await expect(loaf.locator('.search-row-snippet')).toContainText(/^Home · \d+ \w{3}$/);
    await expect(loaf.locator('.label-pill')).toHaveText('Home');
    await expect(loaf.locator('.search-row-tag')).toHaveText('note');
    // a finished note: filled ring, struck title, tag `done`
    await expect(learn.locator('[data-ring="done"]')).toHaveCount(1);
    await expect(learn.locator('.search-row-tag')).toHaveText('done');
    expect(await learn.locator('.search-row-title').evaluate((e) => getComputedStyle(e).textDecorationLine)).toBe('line-through');
    await expect(loaf).toHaveAttribute('aria-selected', 'true'); // the first row is preselected
    if (!isPhone()) {
      await expect(results.locator('.search-pop-keys')).toHaveText('↑↓ move · ↵ open · esc close');
      // 400 px, right-aligned to the field, 52 px rows
      const pop = (await results.boundingBox())!;
      const field = (await app.locator('.topbar-search').boundingBox())!;
      expect(Math.round(pop.width)).toBe(400);
      expect(Math.round(pop.x + pop.width)).toBe(Math.round(field.x + field.width));
      expect(Math.round((await loaf.boundingBox())!.height)).toBe(52);
      // ↓ moves the selection, ↑ back
      await app.getByTestId('search').press('ArrowDown');
      await expect(learn).toHaveAttribute('aria-selected', 'true');
      await app.getByTestId('search').press('ArrowUp');
    }
    await app.getByTestId('search').press('Enter');
    await expect(panel(app)).toBeVisible();
    await expect(panel(app).getByTestId('detail-title')).toHaveValue('Sourdough, basic loaf');
  });
}

test('16b. search with no results says so and nothing else; Esc closes the results', async ({ app }) => {
  await openSearch(app);
  await app.getByTestId('search').fill('zzqx');
  const results = resultsOf(app);
  await expect(results).toHaveText('No cards match "zzqx"');
  await expect(results.locator('.search-row')).toHaveCount(0);
  await app.getByTestId('search').press('Escape');
  await expect(app.locator('.search-pop, .phone-search-layer')).toHaveCount(0);
});

test('16c. search from Notes opens the card without switching view', async ({ app }) => {
  await openView(app, 'notes');
  await openSearch(app);
  await app.getByTestId('search').fill('torch');
  // a checklist match shows the line around it
  const row = resultsOf(app).getByTestId(`search-result-${K('n8')}`);
  await expect(row.locator('.search-row-snippet')).toContainText('Head torch batteries');
  await row.click();
  await expect(panel(app).getByTestId('detail-title')).toHaveValue('Camping kit');
  if (!isPhone()) await expect(app.locator('.app')).toHaveAttribute('data-view', 'notes');
});
