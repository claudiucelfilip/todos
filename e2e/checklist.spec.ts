// Journey 7 (§13): ticked items stay where they are; ··· has Uncheck all.
import { expect, K, openFromNotes, panel, itemBox, test } from './journeys';

test('7. ticked items stay in place; Uncheck all clears the ticks', async ({ app, api }) => {
  await openFromNotes(app, 'n0'); // Saturday shop: Lemons, Parmesan, Oat milk, Dish soap
  const rows = panel(app).locator('.dt-rows [data-testid^="item-"]:not([data-testid$="-handle"])');
  const texts = async () => (await rows.allInnerTexts()).map((t) => t.replace(/[\s⋮]+/g, ' ').trim());
  const before = await texts();
  expect(before).toHaveLength(4);
  await itemBox(app, K('n0-1')).click();
  await expect(panel(app).getByTestId(`item-${K('n0-1')}`)).toHaveClass(/checked/);
  expect(await texts()).toEqual(before); // same order
  // Struck through over the words only: a visible line-through, and no drawn line wider than the text.
  await expect.poll(() => rows.nth(1).evaluate((n) => {
    const t = n.querySelector('.dt-row-text')!;
    const s = getComputedStyle(t);
    const a = getComputedStyle(t, '::after');
    const range = document.createRange();
    range.selectNodeContents(t);
    const textWidth = range.getBoundingClientRect().width;
    const drawn = a.content !== 'none' && a.content !== 'normal' ? parseFloat(a.width) : 0;
    return { through: s.textDecorationLine.includes('line-through') && s.textDecorationColor !== 'rgba(0, 0, 0, 0)', tooWide: drawn > textWidth + 1 };
  })).toEqual({ through: true, tooWide: false });
  await expect.poll(async () => (await api.cards()).find((c) => c.id === K('n0')).items.map((i: any) => i.done)).toEqual([false, true, false, false]);

  await panel(app).getByRole('button', { name: 'Checklist actions' }).click();
  await app.getByRole('menuitem', { name: 'Uncheck all' }).click();
  await expect.poll(async () => (await api.cards()).find((c) => c.id === K('n0')).items.every((i: any) => !i.done)).toBe(true);
  await expect(panel(app).locator('.dt-row.checked')).toHaveCount(0);
});
