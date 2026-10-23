// §11.24.1 one Esc from anywhere, §11.24.5 top-bar controls keep the panel, §11.24.3 / .6 title and breadcrumb.
import { desktopOnly, expect, K, noteCard, openFromNotes, openLabels, openView, panel, pushActions, setTheme, test, toast } from './journeys';
import type { Page } from '@playwright/test';

const blur = (app: Page) => app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const openPanel = (app: Page) => app.locator('.dt-panel:not([inert]), .dt-sheet:not([inert])');

for (const theme of ['dark', 'light'] as const) {
  test(`Esc with nothing focused (${theme}): the Labels menu closes first, then the panel`, async ({ app }) => {
    desktopOnly();
    await setTheme(app, theme);
    await openFromNotes(app, 'n8');
    await openLabels(app);
    await expect(openPanel(app)).toBeVisible(); // opening Labels didn't minimise the panel
    await blur(app);
    expect(await app.evaluate(() => document.activeElement === document.body)).toBe(true);
    await app.keyboard.press('Escape');
    await expect(app.locator('.labels-menu')).toBeHidden();
    await expect(openPanel(app)).toBeVisible();
    await blur(app);
    await app.keyboard.press('Escape');
    await expect(openPanel(app)).toHaveCount(0);
    await expect(app.getByTestId('detail-dock')).toHaveCount(0);
  });
}

test('Esc closes the panel from the body on every view and the phone sheet', async ({ app }) => {
  for (const view of ['notes', 'board'] as const) {
    await openView(app, view);
    if (view === 'notes') await noteCard(app, 'n6').click({ position: { x: 14, y: 40 } });
    else await app.locator(`[data-testid="card-${K('t1')}"]`).first().click({ position: { x: 14, y: 14 } });
    await expect(openPanel(app)).toBeVisible();
    await blur(app);
    await app.keyboard.press('Escape');
    await expect(openPanel(app)).toHaveCount(0);
  }
});

test('Esc in a field blurs it first; the next Esc closes the panel', async ({ app }) => {
  await openFromNotes(app, 'n8');
  const title = panel(app).getByTestId('detail-title');
  await title.click();
  await expect(title).toBeFocused();
  await app.keyboard.press('Escape');
  await expect(title).not.toBeFocused();
  await expect(openPanel(app)).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(openPanel(app)).toHaveCount(0);
});

test('breadcrumb: the last crumb is the child title, Esc goes back one level, then closes', async ({ app }) => {
  await openFromNotes(app, 'n8');
  await panel(app).getByRole('button', { name: 'Open Water filter: which one' }).click();
  const crumbs = panel(app).getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumbs).toBeVisible();
  await expect(crumbs.locator('.dt-crumb')).toHaveText(['Camping kit›']);
  const here = crumbs.locator('.dt-crumb-here');
  await expect(here).toHaveText('Water filter: which one');
  await expect(crumbs).not.toContainText('this note');
  expect(await here.evaluate((e) => e.tagName)).toBe('SPAN'); // not a link
  expect(await here.evaluate((e) => getComputedStyle(e).color)).toBe(await app.evaluate(() => {
    const p = document.createElement('span');
    p.style.color = 'var(--ink-2)';
    document.body.append(p);
    const c = getComputedStyle(p).color;
    p.remove();
    return c;
  }));
  await blur(app);
  await app.keyboard.press('Escape');
  await expect(panel(app).getByTestId('detail-title')).toHaveValue('Camping kit');
  await expect(crumbs).toHaveCount(0);
  await app.keyboard.press('Escape');
  await expect(openPanel(app)).toHaveCount(0);
});

test('top-bar controls keep the panel open: Labels, search, the view switch and the room switch', async ({ app }) => {
  desktopOnly();
  await openFromNotes(app, 'n8');
  const stillOpen = async () => {
    await expect(openPanel(app)).toBeVisible();
    await expect(app.getByTestId('detail-dock')).toHaveCount(0);
  };
  await app.getByTestId('label-filter').click();
  await stillOpen();
  // Enter in the Labels field never reaches the board or the panel.
  await app.getByPlaceholder('Find or add a label').fill('Home');
  await app.keyboard.press('Enter');
  await app.getByPlaceholder('Find or add a label').fill('');
  await app.keyboard.press('Enter');
  await expect(app.locator('.labels-menu')).toBeVisible();
  await stillOpen();
  await app.keyboard.press('Escape');
  await app.getByTestId('search').click();
  await stillOpen();
  await app.getByTestId('view-board').click();
  await stillOpen();
  await app.getByTestId('view-notes').click();
  await stillOpen();
  await app.getByRole('button', { name: /Switch room/ }).click();
  await stillOpen();
  await app.keyboard.press('Escape'); // closes the rooms popover only
  await stillOpen();
  // A click on the page itself still minimises to the dock.
  await app.locator('.pane:not([inert]) main').first().dispatchEvent('pointerdown', { bubbles: true });
  await expect(app.getByTestId('detail-dock')).toBeVisible();
});

test('the dock is never blank: an untitled, empty note reads Untitled note in --muted; its title field says Add a title', async ({ app, account }) => {
  desktopOnly();
  const now = new Date().toISOString();
  const card = { id: 'blank-note', kind: 'note', title: '', notes: '', status: 'todo', order: 0, items: [], labels: [], createdAt: now, updatedAt: now, completedAt: null, archivedAt: null, someday: false, repeat: false, remindAt: null, remindedAt: null };
  await pushActions(account, [{ id: 'a-blank', deviceId: 'e2e', ts: now, type: 'card.put', payload: { card } }]);
  await app.reload();
  await openView(app, 'notes');
  await app.locator('.pane:not([inert]) [data-testid="note-blank-note"]').click({ position: { x: 14, y: 40 } });
  await expect(openPanel(app)).toBeVisible();
  const title = panel(app).getByTestId('detail-title');
  await expect(title).toHaveAttribute('placeholder', 'Add a title');
  await expect(title).toBeFocused(); // a blank card opens on its title, not the add-item field
  await panel(app).getByTestId('detail-minimize').click();
  const dockTitle = app.getByTestId('detail-dock').locator('.dock-title');
  await expect(dockTitle).toHaveText('Untitled note');
  await expect(dockTitle).toHaveClass(/untitled/);
});

test('an untitled note with a body: the title field reads Add a title and the body shows in full', async ({ app }) => {
  await openFromNotes(app, 'n3');
  await expect(panel(app).getByTestId('detail-title')).toHaveAttribute('placeholder', 'Add a title');
  await expect(panel(app).getByTestId('detail-title')).toHaveValue('');
  await expect(panel(app)).toContainText('Wifi at mum’s: Rosalind-1947');
  await expect(panel(app).getByTestId('detail-add-items')).not.toBeFocused();
});

test('the toast Undo never shows the stack depth', async ({ app }) => {
  await openView(app, 'notes');
  for (const key of ['n11', 'n17']) {
    await openFromNotes(app, key);
    await panel(app).locator('.dt-foot').getByRole('button', { name: 'Delete' }).click();
    await expect(openPanel(app)).toHaveCount(0);
  }
  await expect(toast(app).getByTestId('toast-undo')).toHaveText('Undo');
});

test('⌘B on a bold word takes the bold off; again puts it back', async ({ app, api }) => {
  desktopOnly();
  await openFromNotes(app, 'n7');
  await panel(app).locator('.md-p', { hasText: 'Pigeon' }).click();
  const line = panel(app).locator('textarea.md-raw');
  await expect(line).toBeFocused();
  const v = await line.inputValue();
  const at = v.indexOf('Pigeon') + 2;
  await line.evaluate((el: HTMLTextAreaElement, at) => el.setSelectionRange(at, at), at);
  await app.keyboard.press('ControlOrMeta+b');
  await expect(line).toHaveValue(/Ball Pigeon for/);
  await expect(line).not.toHaveValue(/\*\*\*\*/);
  await app.keyboard.press('ControlOrMeta+b');
  await expect(line).toHaveValue(/Ball \*\*Pigeon\*\* for/);
  void api;
});

test('the sparkle shows the selected look while the assistant is open', async ({ app }) => {
  desktopOnly();
  const sparkle = app.getByRole('button', { name: 'Open assistant' });
  await expect(sparkle).toHaveAttribute('aria-pressed', 'false');
  const restBg = await sparkle.evaluate((e) => getComputedStyle(e).backgroundColor);
  await sparkle.click();
  await expect(sparkle).toHaveAttribute('aria-pressed', 'true');
  await app.mouse.move(10, 600); // off the button: no hover tint
  const sel = await app.evaluate(() => {
    const p = document.createElement('span');
    p.style.background = 'var(--surface-sel)';
    document.body.append(p);
    const c = getComputedStyle(p).backgroundColor;
    p.remove();
    return c;
  });
  await expect.poll(() => sparkle.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(sel);
  expect(restBg).not.toBe(sel);
});

test('Settings: the suggest helper sits under its label', async ({ app }) => {
  desktopOnly();
  await app.getByTestId('settings').click();
  const row = app.locator('.settings-row-help');
  test.skip(!(await row.count()), 'no account suggest row');
  const label = await row.locator('> span').evaluate((s) => {
    const r = document.createRange();
    r.setStart(s.firstChild!, 0);
    r.setEnd(s.firstChild!, s.firstChild!.textContent!.length);
    return r.getBoundingClientRect().bottom;
  });
  const helper = (await row.locator('small').boundingBox())!;
  expect(helper.y).toBeGreaterThanOrEqual(Math.round(label));
});
