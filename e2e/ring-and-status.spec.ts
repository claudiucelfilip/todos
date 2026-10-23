// Completion rings use workflow labels; legacy checklists keep their progress behavior.
import { expect, K, openFromBoard, openView, openColumn, panel, ring, boardCard, itemBox, scope, test, toast, pushActions, setFields } from './journeys';

test('a newly saved note moves to the top of To do when its label is added', async ({ app, api }) => {
  await openView(app, 'notes');
  await app.getByTestId('composer-bar').click();
  await panel(app).locator('.md-raw').fill('Test note for the top of To do');
  await panel(app).getByTestId('detail-close').click();
  await expect.poll(async () => (await api.cards()).some(c => `${c.title}\n${c.notes}`.includes('Test note for the top of To do'))).toBe(true);
  const card = (await api.cards()).find(c => `${c.title}\n${c.notes}`.includes('Test note for the top of To do'));
  expect(card?.kind).toBe('note');
  if (!card) throw new Error('The new note was not saved');
  await scope(app).locator(`.note-card[data-card-id="${card.id}"]`).click({ position: { x: 20, y: 40 } });
  await panel(app).getByTestId('detail-add-label').click();
  await app.getByRole('dialog', { name: 'Add label' }).getByRole('radio', { name: 'To do', exact: true }).click();
  await expect.poll(async () => (await api.cards()).find(c => c.id === card.id)?.labels).toContain('workflow:todo');
  if (await app.getByRole('button', { name: 'Close labels' }).count()) await app.getByRole('button', { name: 'Close labels' }).click();
  await panel(app).getByTestId('detail-close').click();
  await openView(app, 'board');
  await openColumn(app, 'todo');
  await expect(app.locator('.column.todo .card-face').first()).toHaveAttribute('data-card-id', card.id);
});

test('5. the ring moves a note to To do, completes it, then reopens it without changing its content', async ({ app, api, account }) => {
  // The demo board predates workflow labels; exercise the current note format.
  await pushActions(account, [setFields(K('n3'), { workflowVersion: 1 })]);
  await app.reload();
  await openView(app, 'notes');
  const original = (await api.cards()).find((c) => c.id === K('n3'));
  const saved = () => api.cards().then(cards => cards.find(c => c.id === K('n3')));
  const liveBoardCard = () => boardCard(app, 'n3').and(app.locator(':not([aria-hidden="true"])'));
  const r = ring(app, 'n3');
  await expect(r).toHaveAttribute('data-ring', 'note');
  await expect(r).toHaveAccessibleName('Add to To do');
  await expect(r.locator('svg')).toBeVisible();
  await r.click();
  await expect(toast(app)).toContainText('To do');
  await expect(r).toHaveAttribute('data-ring', 'todo');
  await expect(r).toHaveAccessibleName('Mark done');
  await expect.poll(async () => (await saved()).labels).toEqual(['workflow:todo']);
  await openView(app, 'board');
  await openColumn(app, 'todo');
  await expect(app.locator('.column.todo .card-face').first()).toHaveAttribute('data-card-id', K('n3'));
  const boardRing = boardCard(app, 'n3').getByTestId(`card-${K('n3')}-circle`);
  await boardRing.click();
  await expect.poll(async () => (await saved()).labels).toEqual(['workflow:done']);
  await expect.poll(async () => (await saved()).status).toBe('done');
  expect(await saved()).toMatchObject({ title: original.title, notes: original.notes, items: original.items });

  await openView(app, 'board');
  await openColumn(app, 'done');
  await expect(liveBoardCard()).toBeVisible();
  await liveBoardCard().getByTestId(`card-${K('n3')}-circle`).click();
  await expect(toast(app)).toContainText('reopened');
  await openColumn(app, 'todo');
  await expect(liveBoardCard()).toBeVisible();
  await expect(liveBoardCard().getByTestId(`card-${K('n3')}-circle`)).toHaveAttribute('data-ring', 'todo');
  await expect.poll(async () => (await saved()).labels).toEqual(['workflow:todo']);
  await expect.poll(async () => (await saved()).status).toBe('todo');
  expect(await saved()).toMatchObject({ title: original.title, notes: original.notes, items: original.items, completedAt: null });

  await app.getByTestId('toast-undo').click();
  await openColumn(app, 'done');
  await expect(liveBoardCard()).toBeVisible();
  await expect.poll(async () => (await saved()).status).toBe('done');
  await app.reload();
  await openView(app, 'board');
  await openColumn(app, 'done');
  await expect(boardCard(app, 'n3').getByTestId(`card-${K('n3')}-circle`)).toHaveAttribute('data-ring', 'done');
  expect(await saved()).toMatchObject({ title: original.title, notes: original.notes, items: original.items, labels: ['workflow:done'] });
});

test('6. legacy checklist progress drives status', async ({ app, api }) => {
  const status = async () => (await api.cards()).find((c) => c.id === K('t2')).status;
  await openFromBoard(app, 't2', 'todo');
  await itemBox(app, K('t2-0')).click();
  await expect.poll(status).toBe('doing');
  await expect(panel(app).locator('.dt-progress')).toContainText('1/2');
  await itemBox(app, K('t2-1')).click();
  await expect.poll(status).toBe('done');
  await itemBox(app, K('t2-1')).click();
  await expect.poll(status).toBe('doing');
  // the ring shows progress on the board
  await app.keyboard.press('Escape');
  await expect(panel(app)).toBeHidden();
  await openColumn(app, 'doing');
  await expect(boardCard(app, 't2').getByTestId(`card-${K('t2')}-circle`)).toHaveAttribute('data-ring', 'doing');
});

test('completion hover follows the ring without painting its hit area', async ({ app }, testInfo) => {
  await openView(app, 'notes');
  for (const key of ['n3','t1','d1']) {
    const button = ring(app,key);
    await expect(button).toBeVisible();
    await button.scrollIntoViewIfNeeded();
    const before = await button.locator('.ring6').evaluate(el => { const style = getComputedStyle(el); return style.backgroundImage + ' ' + style.backgroundColor + ' ' + style.borderColor + ' ' + style.filter; });
    const state = await button.getAttribute('data-ring');
    await button.hover();
    await expect(button).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
    const after = await button.locator('.ring6').evaluate(el => { const style = getComputedStyle(el); return style.backgroundImage + ' ' + style.backgroundColor + ' ' + style.borderColor + ' ' + style.filter; });
    const fine = await app.evaluate(() => matchMedia('(hover:hover) and (pointer:fine)').matches);
    if (fine) expect(after, state + ' ring responds to hover').not.toBe(before);
    else expect(after, 'touch has no synthetic hover feedback').toBe(before);
    if (state === 'doing') await expect(button.locator('.ring6')).toHaveCSS('background-image',/conic-gradient/);
    if (state === 'done') await expect(button.locator('.ring6 svg')).toBeVisible();
    await expect(button).toHaveAttribute('data-ring',state!);
    await app.screenshot({path:testInfo.outputPath(`ring-hover-${state}.png`)});
    await app.mouse.move(0,0);
  }
  await openFromBoard(app,'t2','todo');
  const editorRing = panel(app).locator('button.ring6-btn').first();
  await editorRing.hover();
  await expect(editorRing).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  await app.keyboard.press('Tab');
  await editorRing.focus();
  await expect(editorRing).toHaveCSS('outline-style','solid');
});
