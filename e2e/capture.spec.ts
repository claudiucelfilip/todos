// Journeys 1-4 (§13) and §11.23: one shared composer for notes and to dos, and long writing.
import type { Page } from '@playwright/test';
import { desktopOnly, expect, findCard, isPhone, K, labelNames, noteCard, openView, openColumn, panel, scope, setTheme, test, toast, tomorrowAt, nextWeekday } from './journeys';

const composer = (page: Page) => page.getByTestId('composer');
const bar = (page: Page) => page.getByTestId('composer-bar');
const addBtn = (page: Page) => page.getByTestId('composer-add');
const box = async (page: Page) => (await composer(page).boundingBox())!;
const draftOf = (page: Page) =>
  page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('draft:')).map(([, v]) => JSON.parse(v)));

test('1. capture a quick note: Enter is a line break, Esc keeps the draft, Add saves and collapses, Undo removes', async ({ app, api }) => {
  await openView(app, 'notes');
  await expect(composer(app)).toHaveCount(1); // one composer in the DOM
  await bar(app).click();
  const body = app.getByRole('textbox', { name: 'Note' });
  await expect(body).toHaveAttribute('placeholder', 'Take a note… markdown works');
  await expect(body).toHaveAttribute('enterkeyhint', 'enter');
  await body.pressSequentially('Buy oat milk');
  await body.press('Enter');
  await body.pressSequentially('and a loaf of bread');
  // Enter did not submit, and Esc closes without adding: the draft waits in the bar.
  await body.press('Escape');
  expect(findCard(await api.cards(), 'Buy oat milk')).toBeUndefined();
  await expect(bar(app).locator('.composer-draft-tag')).toHaveText('Draft');
  await expect(bar(app)).toContainText('Buy oat milk');
  await bar(app).click();
  await addBtn(app).click();

  await expect(toast(app)).toContainText('Note saved');
  // A note collapses and focus moves to the bar.
  await expect(bar(app)).toBeFocused();
  await expect.poll(async () => (await box(app)).height).toBe(isPhone() ? 52 : 48);
  await expect(bar(app)).toContainText('Take a note…');
  await expect.poll(async () => findCard(await api.cards(), 'Buy oat milk')).toBeTruthy();
  const card = findCard(await api.cards(), 'Buy oat milk');
  expect(card.kind).toBe('note');
  expect(`${card.title}\n${card.notes}`).toMatch(/Buy oat milk\s*\n\s*and a loaf of bread/);
  expect(card.labels).toEqual([]); // Inbox
  await expect(scope(app).locator('.notes-grid [data-testid^="note-"]').first()).toContainText('Buy oat milk');

  await app.getByTestId('toast-undo').click();
  await expect.poll(async () => findCard(await api.cards(), 'Buy oat milk')).toBeUndefined();
  await expect(scope(app).getByText('and a loaf of bread')).toHaveCount(0);
});

test('2. capture a to do on the Board: label and reminder are parsed out, the composer stays open and empty', async ({ app, api }) => {
  await openView(app, 'board');
  await openColumn(app, 'todo');
  await app.getByRole('button', { name: /Add a to do/ }).click();
  const body = app.getByRole('textbox', { name: 'To do' });
  await expect(body).toHaveAttribute('placeholder', 'Add a to do… each next line is a step');
  await body.pressSequentially('Call the vet tomorrow 9am #home');
  // The parsed time and label are shown before adding.
  await expect(composer(app).locator('.composer-chip')).toHaveCount(2);
  await body.press('ControlOrMeta+Enter');

  await expect.poll(async () => findCard(await api.cards(), 'Call the vet')).toBeTruthy();
  await expect(toast(app)).toContainText('Added to To do');
  // A to do stays open, empty and focused for the next one.
  await expect(body).toBeVisible();
  await expect(body).toBeFocused();
  await expect(body).toHaveValue('');
  await expect(addBtn(app)).toHaveAttribute('aria-disabled', 'true');
  const snap = await api.snapshot();
  const card = findCard(snap.cards, 'Call the vet');
  expect(card.status).toBe('todo');
  expect(card.kind).not.toBe('note');
  expect(card.title).toBe('Call the vet');
  expect(labelNames(snap, card)).toContain('Home');
  expect(new Date(card.remindAt).getTime()).toBe(tomorrowAt(9).getTime());
  const first = scope(app).locator('section.column.todo .card-face').first();
  await expect(first).toContainText('Call the vet');
  await expect(first).not.toContainText('#home');
  await expect(app.locator(`section.column.todo .card-face[data-card-id="${card.id}"][data-flash]`)).toHaveCount(1);

  // Enter makes a new step; ⇧↵ adds.
  await body.pressSequentially('Pack for camping');
  await body.press('Enter');
  await body.pressSequentially('Tent');
  await body.press('Shift+Enter');
  await expect.poll(async () => findCard(await api.cards(), 'Pack for camping')?.items?.map((i: any) => i.text)).toEqual(['Tent']);
  await expect(body).toBeFocused();
});

test('3. a time in a note makes it a to do; a chip shows it and × keeps it as plain text', async ({ app, api }) => {
  await openView(app, 'notes');
  await bar(app).click();
  const body = app.getByRole('textbox', { name: 'Note' });
  await body.pressSequentially('Sun lotion');
  await expect(composer(app).locator('.composer-chip')).toHaveCount(0); // a word, not Sunday
  await body.fill('Water the plants Sun');
  await expect(composer(app).locator('.composer-chip')).toContainText('Sun');
  await composer(app).locator('.composer-chip').click();
  await expect(composer(app).locator('.composer-chip')).toHaveCount(0);
  await body.press('Shift+Enter');
  await expect.poll(async () => findCard(await api.cards(), 'Water the plants Sun')).toBeTruthy();
  const kept = findCard(await api.cards(), 'Water the plants Sun');
  expect(kept.kind).toBe('note');
  expect(kept.remindAt ?? null).toBeNull();

  await bar(app).click();
  await body.pressSequentially('Dentist Friday 3pm');
  await body.press('Shift+Enter');
  await expect.poll(async () => findCard(await api.cards(), 'Dentist')).toBeTruthy();
  const card = findCard(await api.cards(), 'Dentist');
  expect(card.kind).not.toBe('note');
  expect(card.status).toBe('todo');
  expect(new Date(card.remindAt).getTime()).toBe(nextWeekday(5, 15, 0).getTime());
  await openView(app, 'board');
  await openColumn(app, 'todo');
  await expect(scope(app).locator('section.column.todo .card-face').first()).toContainText('Dentist');
});

test('4. long writing: expand opens the same note in the panel, caret at the end, markdown rendered', async ({ app, api }) => {
  desktopOnly(); // the phone bar has no expand icon (§11.23)
  await openView(app, 'notes');
  await bar(app).click();
  const body = app.getByRole('textbox', { name: 'Note' });
  const lines = ['## Packing plan', '- tent and pegs', '[trail map](https://example.com/map)', 'Check the weather first', 'Leave by seven'];
  for (const [i, l] of lines.entries()) {
    await body.pressSequentially(l);
    if (i < lines.length - 1) await body.press('Enter');
  }
  await app.getByRole('button', { name: 'Add and open in the panel to write more' }).click();

  await expect(panel(app)).toBeVisible();
  await expect.poll(async () => (await api.cards()).filter((c) => `${c.title}\n${c.notes}`.includes('Packing plan')).length).toBe(1);
  const md = panel(app).getByTestId('detail-notes');
  await expect(md.locator('.md-h2')).toContainText('Packing plan');
  await expect(md.locator('.md-li')).toContainText('tent and pegs');
  await expect(md.locator('a.md-link')).toContainText('trail map');
  const raw = md.locator('textarea');
  await expect(raw).toBeFocused();
  await expect(raw).toHaveValue('Leave by seven');
  expect(await raw.evaluate((t: HTMLTextAreaElement) => t.selectionStart === t.value.length && t.selectionEnd === t.value.length)).toBe(true);
  // owner: expanded keeps the panel's normal insets (header 18, body and footer 22)
  const inset = await panel(app).evaluate((p) => {
    const left = p.getBoundingClientRect().left;
    const x = (sel: string) => Math.round(p.querySelector(sel)!.getBoundingClientRect().left - left);
    const foot = p.querySelector(':scope > .dt-foot')!;
    return { head: x('.dt-status'), title: x('.dt-title-row'), foot: Math.round(foot.getBoundingClientRect().left - left + parseFloat(getComputedStyle(foot).paddingLeft)) };
  });
  expect(inset).toEqual({ head: 18, title: 22, foot: 22 });
  // every card opens at the one width, one column (= the composer); there is no expanded state
  await panel(app).locator('.dt-esc').click();
  await expect(panel(app)).toBeHidden();
  await noteCard(app, 'n8').click({ position: { x: 14, y: 40 } });
  await expect.poll(() => panel(app).evaluate((n) => Math.round(n.getBoundingClientRect().width))).toBe(Math.round((await box(app)).width));
  await expect
    .poll(() =>
      panel(app).evaluate((p) => {
        const left = p.getBoundingClientRect().left;
        const x = (sel: string) => Math.round(p.querySelector(sel)!.getBoundingClientRect().left - left);
        return { head: x('.dt-status'), title: x('.dt-title-row') };
      }),
    )
    .toEqual({ head: 18, title: 22 });
  expect(K('x')).toBe('v6-x');
});

test('5. the Add button: ink when there is text, a disabled well when empty, no Close', async ({ app }) => {
  await bar(app).click();
  const add = addBtn(app);
  await expect(composer(app).getByRole('button', { name: 'Close' })).toHaveCount(0);
  await expect(composer(app).getByText('Close', { exact: true })).toHaveCount(0);
  const look = () =>
    add.evaluate((b) => {
      const s = getComputedStyle(b);
      const r = b.getBoundingClientRect();
      const probe = document.createElement('i');
      document.body.append(probe);
      probe.style.color = 'var(--ink)';
      const ink = getComputedStyle(probe).color;
      probe.style.color = 'var(--seg-well)';
      const well = getComputedStyle(probe).color;
      probe.remove();
      return { h: r.height, w: r.width, radius: s.borderRadius, bg: s.backgroundColor, ink, well, shadow: s.boxShadow !== 'none', disabled: b.getAttribute('aria-disabled'), native: (b as HTMLButtonElement).disabled };
    });
  const empty = await look();
  expect(empty).toMatchObject({ h: isPhone() ? 40 : 32, radius: '9px', disabled: 'true', native: false, shadow: false });
  expect(empty.w).toBeGreaterThanOrEqual(isPhone() ? 72 : 64);
  expect(empty.bg).toBe(empty.well);
  await composer(app).locator('textarea').fill('Something');
  const ready = await look();
  expect(ready).toMatchObject({ disabled: 'false', shadow: true });
  expect(ready.bg).toBe(ready.ink);
  await expect(composer(app).getByRole('button', { name: 'Discard' })).toBeVisible();
});

for (const [theme, name] of [['dark', 'Dark'], ['light', 'Leaf']] as const) {
  test(`6. ${name}: Add stays reachable with a toast showing`, async ({ app, api }) => {
    await setTheme(app, theme);
    await openView(app, 'board');
    await openColumn(app, 'todo');
    await bar(app).click();
    const body = app.getByRole('textbox', { name: 'To do' });
    await body.fill('First of two');
    await addBtn(app).click();
    await expect(toast(app)).toBeVisible();
    await body.fill('Second of two');
    // Once the open animation settles, nothing (the toast included) covers Add.
    await expect.poll(() => composer(app).evaluate((c) => c.getBoundingClientRect().height === parseFloat(c.style.height))).toBe(true);
    const hit = await addBtn(app).evaluate((b) => {
      const r = b.getBoundingClientRect();
      const pts = [[r.left + 4, r.top + 4], [r.right - 4, r.bottom - 4], [r.left + r.width / 2, r.top + r.height / 2]];
      return pts.map(([x, y]) => { const e = document.elementFromPoint(x, y); return b.contains(e) ? 'ok' : `${x},${y}:${e?.className}`; }).join(' ');
    });
    expect(hit).toBe('ok ok ok');
    // and the toast sits clear of the composer once it has settled
    await expect
      .poll(async () => {
        const t = (await toast(app).boundingBox())!;
        const c = await box(app);
        return t.y + t.height <= c.y || t.y >= c.y + c.height || t.x >= c.x + c.width || t.x + t.width <= c.x;
      })
      .toBe(true);
    await addBtn(app).click();
    await expect.poll(async () => findCard(await api.cards(), 'Second of two')).toBeTruthy();
  });
}

test('7. the draft is kept: outside click and Esc never add; it survives a view switch and a reload; Discard has Undo', async ({ app, api }) => {
  await openView(app, 'notes');
  await bar(app).click();
  await app.getByRole('textbox', { name: 'Note' }).fill('Half a thought\nsecond line');
  // switch to To do for this draft only
  await composer(app).getByRole('radio', { name: 'To do' }).click();
  await expect(composer(app)).toHaveAttribute('data-target', 'todo');
  // click outside
  await app.mouse.click(isPhone() ? 200 : 900, isPhone() ? 300 : 600);
  await expect(bar(app)).toBeVisible();
  await expect(bar(app)).toContainText('Half a thought');
  expect(await draftOf(app)).toEqual([{ text: 'Half a thought\nsecond line', target: 'todo' }]);
  expect(findCard(await api.cards(), 'Half a thought')).toBeUndefined();

  await openView(app, 'board');
  await expect(bar(app)).toContainText('Half a thought');
  await app.reload();
  await expect(bar(app)).toContainText('Half a thought');
  await expect(bar(app).locator('.composer-draft-tag')).toHaveText('Draft');
  await bar(app).click();
  await expect(app.getByRole('textbox', { name: 'To do' })).toHaveValue('Half a thought\nsecond line');
  await expect(composer(app)).toHaveAttribute('data-target', 'todo');

  await composer(app).getByRole('button', { name: 'Discard' }).click();
  await expect(toast(app)).toContainText('Draft discarded');
  await expect(bar(app)).not.toContainText('Half a thought');
  expect(await draftOf(app)).toEqual([]);
  await app.getByTestId('toast-undo').click();
  await expect(bar(app)).toContainText('Half a thought');
  expect(findCard(await api.cards(), 'Half a thought')).toBeUndefined();
});

test('8. one composer: same place on Board and Notes and still during the slide; panel = composer width', async ({ app }) => {
  desktopOnly();
  await openView(app, 'board');
  const onBoard = await box(app);
  expect(onBoard).toMatchObject({ x: 32, y: 96, width: 445, height: 48 }); // §11.23 at 1440
  const todo = (await app.locator('.pane:not([inert]) section.column.todo').boundingBox())!;
  expect([todo.x, todo.width]).toEqual([onBoard.x, onBoard.width]);
  // sample every frame through the 460 ms slide
  await app.evaluate(() => {
    const el = document.querySelector('[data-testid="composer"]')!;
    const w = window as unknown as { samples: string[] };
    w.samples = [];
    const t0 = performance.now();
    const tick = () => {
      const r = el.getBoundingClientRect();
      w.samples.push(`${r.x},${r.y},${r.width},${r.height}`);
      if (performance.now() - t0 < 700) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await app.getByTestId('view-notes').click();
  await app.waitForTimeout(800);
  const samples = await app.evaluate(() => (window as unknown as { samples: string[] }).samples);
  expect(samples.length).toBeGreaterThan(10);
  expect(new Set(samples)).toEqual(new Set(['32,96,445,48']));
  // the first grid column starts at the composer's left edge
  await expect.poll(async () => Math.round((await app.locator('.pane:not([inert]) .notes-grid').boundingBox())!.x)).toBe(32);
  await noteCard(app, 'n8').click({ position: { x: 14, y: 40 } });
  await expect(panel(app)).toBeVisible();
  await expect.poll(async () => Math.round((await panel(app).boundingBox())!.width)).toBe(445);
});

test('9. wide screens: content capped at 1375 and centred under the full-width bar', async ({ app }) => {
  desktopOnly();
  await app.setViewportSize({ width: 1920, height: 1080 });
  await openView(app, 'board');
  const bar0 = (await app.locator('.topbar').boundingBox())!;
  expect([bar0.x, bar0.width]).toEqual([0, 1920]);
  const cols = await app.locator('.pane:not([inert]) section.column').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.width]; }));
  expect(cols).toEqual([[272, 445], [737, 445], [1202, 445]]);
  expect(await box(app)).toMatchObject({ x: 272, width: 445 });
  await openView(app, 'notes');
  await expect.poll(async () => { const g = (await app.locator('.pane:not([inert]) .notes-grid').boundingBox())!; return [g.x, g.width]; }).toEqual([272, 1375]);
  await noteCard(app, 'n8').click({ position: { x: 14, y: 40 } });
  await expect.poll(async () => { const p = (await panel(app).boundingBox())!; return [p.width, p.x + p.width]; }).toEqual([445, 1900]); // right-aligned to the window
});
