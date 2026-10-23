// Journey 21 (§13) and the phone layout (§11.3, §11.14, §11.20.4): tabs, swipes, the glass bar, sheets.
import type { Locator, Page } from '@playwright/test';
import { boardCard, expect, K, noteCard, openColumn, openFromBoard, openLabels, openView, panel, phoneOnly, setTheme, swipe, test } from './journeys';

const tab = (page: Page, t: string) => page.getByTestId(`nav-${t}`);
const box = async (l: Locator) => (await l.boundingBox())!;
/** A spot low on the content with no card within a finger's reach (a card owns its own swipe). */
const freeSpot = (page: Page, fromRight: boolean) =>
  page.evaluate((fromRight) => {
    const busy = (x: number, y: number) =>
      [[0, 0], [-16, 0], [16, 0], [0, -16], [0, 16]].some(([dx, dy]) => {
        const el = document.elementFromPoint(x + dx, y + dy);
        return !el || !!el.closest('[data-swipe-row], .phone-composer, .topbar');
      });
    for (let y = 780; y > 140; y -= 8)
      for (let i = 0; i <= 16; i++) {
        const x = fromRight ? 360 - i * 20 : 40 + i * 20;
        if (!busy(x, y)) return { x, y };
      }
    throw new Error('no free spot');
  }, fromRight);
/** Swipes from a free spot; dir -1 = leftwards (next tab), 1 = rightwards (previous tab). */
async function swipeTabs(page: Page, dir: -1 | 1) {
  const { x, y } = await freeSpot(page, dir < 0);
  await swipe(page, { x, y }, { x: Math.max(8, Math.min(394, x + dir * 180)), y });
}
const settled = (page: Page) => expect(page.locator('.phone-panes[data-moving]')).toHaveCount(0);

/** The raised thumb sits exactly on the selected tab (it is the visible "selected" look). */
async function thumbOn(page: Page, t: string) {
  const pill = page.locator('.phone-nav .pill');
  await expect(pill).toBeVisible();
  await expect.poll(async () => {
    const [p, b] = [await box(pill), await box(tab(page, t))];
    return Math.abs(p.x - b.x) + Math.abs(p.width - b.width);
  }).toBeLessThan(2);
}

for (const [name, theme] of [['Dark', 'dark'], ['Leaf', 'light']] as const) {
  test.describe(name, () => {
    test.beforeEach(async ({ app }) => {
      phoneOnly();
      await setTheme(app, theme);
    });

    test('21. swipe anywhere on the content switches tabs; the thumb and panes follow', async ({ app, api }) => {
      await openColumn(app, 'todo');
      await thumbOn(app, 'todo');
      // Low on the screen, under the cards (the old swipe only worked in the top 560 px).
      await swipe(app, { x: 300, y: 700 }, { x: 80, y: 700 }); // fixed spot: To do has three cards above it
      await expect(tab(app, 'doing')).toHaveAttribute('aria-checked', 'true');
      await settled(app);
      await expect(app.locator('section.column.doing')).toBeVisible();
      await expect(app.locator('section.column.todo')).toBeHidden();
      await thumbOn(app, 'doing');
      // The Doing pane fills the screen: it starts at the left edge.
      expect(Math.round((await box(app.locator('section.column.doing'))).x)).toBe(0);

      // Back to To do, then on to Notes: Notes ↔ To do swipes too.
      await swipeTabs(app, 1);
      await expect(tab(app, 'todo')).toHaveAttribute('aria-checked', 'true');
      await settled(app);
      await swipeTabs(app, 1);
      await expect(tab(app, 'notes')).toHaveAttribute('aria-checked', 'true');
      await settled(app);
      await expect(app.locator('.notes-grid')).toBeVisible();
      await thumbOn(app, 'notes');
      // The grid is mostly cards: scroll to its end, where there is room beside the last row.
      await app.locator('.notes-scroll').evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
      await swipeTabs(app, -1);
      await expect(tab(app, 'todo')).toHaveAttribute('aria-checked', 'true');

      // Swipe right on a note card: it is in To do (a swipe on a card belongs to the card).
      await openView(app, 'notes');
      await app.locator('.notes-scroll').evaluate((el) => el.scrollTo({ top: 0, behavior: 'instant' }));
      const card = await box(noteCard(app, 'n3'));
      await swipe(app, { x: card.x + 30, y: card.y + card.height / 2 }, { x: card.x + card.width - 10, y: card.y + card.height / 2 });
      await expect.poll(async () => (await api.cards()).find((c) => c.id === K('n3')).kind).not.toBe('note');
      expect((await api.cards()).find((c) => c.id === K('n3')).status).toBe('todo');
      await expect(tab(app, 'notes')).toHaveAttribute('aria-checked', 'true'); // the card swipe didn't switch tabs
      await openColumn(app, 'todo');
      await expect(boardCard(app, 'n3')).toBeVisible();
    });

    test('a tab tap slides the panes by one screen per tab, in step with the thumb', async ({ app }) => {
      await openColumn(app, 'todo');
      const panes = app.getByTestId('phone-panes');
      await tab(app, 'done').click();
      // Mid-slide the track is between the two tabs, and the thumb is between the two cells.
      await expect.poll(() => panes.evaluate((el) => el.hasAttribute('data-moving'))).toBe(true);
      const mid = await panes.evaluate((el) => el.scrollLeft / el.clientWidth);
      expect(mid).toBeGreaterThan(1);
      expect(mid).toBeLessThan(3);
      await settled(app);
      expect(await panes.evaluate((el) => el.scrollLeft / el.clientWidth)).toBe(3);
      await thumbOn(app, 'done');
    });

    test('the tab row is part of the one glass bar; nothing overlaps it', async ({ app }) => {
      const bar = app.locator('.app > .topbar');
      const nav = app.locator('.phone-nav');
      // One element carries the glass and the bottom edge, and the tabs are inside it.
      await expect(bar.locator('.phone-nav')).toHaveCount(1);
      const b = await box(bar);
      const n = await box(nav);
      expect(b.y).toBe(0);
      expect(n.y + n.height).toBe(b.y + b.height);
      expect(await nav.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe('none');
      expect(await bar.evaluate((el) => getComputedStyle(el).backdropFilter)).not.toBe('none');
      // The raised tab's shadow is clipped at the bar's edge.
      expect(await nav.evaluate((el) => getComputedStyle(el).overflow)).toBe('hidden');
      // Each tab's centre hits that tab, on every tab and both views.
      for (const v of ['todo', 'notes'] as const) {
        await openView(app, v === 'todo' ? 'board' : 'notes');
        for (const t of ['notes', 'todo', 'doing', 'done']) {
          const r = await box(tab(app, t));
          const hit = await app.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid^="nav-"]')?.getAttribute('data-testid'), [r.x + r.width / 2, r.y + r.height / 2]);
          expect(hit).toBe(`nav-${t}`);
        }
        // The content starts under the bar.
        const first = app.locator(v === 'todo' ? 'section.column.todo .card-face' : '.notes-grid [data-testid^="note-"]').first();
        expect((await box(first)).y).toBeGreaterThanOrEqual(b.y + b.height);
      }
    });

    test('the ··· menu closes on a tab tap, on search and when Labels opens; Labels is a bottom sheet', async ({ app }) => {
      const more = app.getByRole('button', { name: 'More options' });
      const menu = app.locator('.phone-more-menu');
      await more.click();
      await expect(menu).toBeVisible();
      await tab(app, 'notes').click(); // a tab the menu doesn't cover
      await expect(menu).toHaveCount(0);
      await expect(tab(app, 'notes')).toHaveAttribute('aria-checked', 'true');

      await more.click();
      await app.getByRole('button', { name: 'Search' }).click();
      await expect(menu).toHaveCount(0);
      await app.getByRole('button', { name: 'Cancel' }).click();

      await openLabels(app); // asserts the menu is gone
      const sheet = app.locator('.labels-menu');
      await expect.poll(async () => Math.round((await box(sheet)).y + (await box(sheet)).height)).toBe(app.viewportSize()!.height);
      const s = await box(sheet);
      const vp = app.viewportSize()!;
      expect(Math.round(s.x)).toBe(0);
      expect(Math.round(s.width)).toBe(vp.width);
      expect(Math.round(s.y + s.height)).toBe(vp.height);
      expect(await sheet.evaluate((el) => getComputedStyle(el).backdropFilter)).not.toBe('none');
      // Rows are finger-sized.
      expect((await box(sheet.getByTestId('labels-row-all'))).height).toBeGreaterThanOrEqual(44);
      await app.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(menu).toHaveCount(0);
    });

    test('card sheet: full height with ×, reminder chip has its bell, no ghost chip, 44 px targets', async ({ app }) => {
      await openFromBoard(app, 't3', 'todo'); // Q4 roadmap review: a label, a note row, no reminder
      const sheet = app.locator('.dt-sheet');
      await expect(sheet).toBeVisible();
      await expect.poll(async () => Math.round((await box(sheet)).y)).toBe(0);
      expect(Math.round((await box(sheet)).height)).toBe(app.viewportSize()!.height);

      // Hit areas: probe 21 px above and below each small control's centre.
      const hits = async (l: Locator, dy = 21) => {
        const r = await box(l);
        return l.evaluate((el, [x, y1, y2]) => [y1, y2].every((y) => el.contains(document.elementFromPoint(x, y))), [r.x + r.width / 2, r.y + r.height / 2 - dy, r.y + r.height / 2 + dy]);
      };
      expect(await hits(sheet.getByTestId('detail-add-label'))).toBe(true);
      const remind = sheet.getByTestId('detail-remind');
      expect(await hits(remind)).toBe(true);
      await expect(remind.locator('svg')).toBeVisible();
      const x = sheet.locator('.label-pill-x').first();
      expect(await hits(x, 11)).toBe(true);
      const refOpen = sheet.locator('.ref-open').first();
      const ro = await box(refOpen);
      expect(Math.min(ro.width, ro.height)).toBeGreaterThanOrEqual(44);

      // The picker opens below the chip; the chip is not under the picker.
      await remind.click();
      const pop = sheet.locator('.remind-pop');
      await expect(pop).toBeVisible();
      const [c, p] = [await box(remind), await box(pop)];
      expect(c.y + c.height).toBeLessThanOrEqual(p.y);
      await pop.getByRole('button', { name: /Tomorrow/ }).click();
      await expect(remind).toContainText(/\d{1,2}:\d{2}/);
      await expect(remind.locator('svg')).toBeVisible();

      // × closes, and focus returns to the card.
      await sheet.getByTestId('detail-close').click();
      await expect(sheet).toBeHidden();
      await expect.poll(() => app.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(`card-${K('t3')}`);
    });
  });
}
