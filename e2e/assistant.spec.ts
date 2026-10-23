// Journeys 22-24 (§12, §13): the assistant, with the built-in window.__assistantMock instead of a model.
import { boardCard, desktopOnly, expect, isPhone, K, mockAssistant, openColumn, openFromBoard, openView, panel, phoneOnly, test } from './journeys';

const reply = (message: string, focus: any) => ({
  reply: 'Here is a way to do it.',
  delayMs: 2500,
  proposals: focus
    ? [{ type: 'checklist', cardId: focus.id, title: focus.title, notes: '', items: ['Pick dates', 'Book the tram pass', 'Plan day trips'] }]
    : [{ type: 'create', title: 'Plan the week', notes: 'Start with the open items.', items: ['Review Doing', 'Pick one thing'] }],
});
const assistant = (page: import('@playwright/test').Page) => page.getByTestId('assistant');
const items = async (api: any, key: string) => (await api.cards()).find((c: any) => c.id === K(key)).items;

test('22. assistant with card context: progress, one proposal, apply flashes the card, Undo removes the items', async ({ app, api }) => {
  await mockAssistant(app, reply);
  await app.reload();
  await app.locator('.app').waitFor();
  await openFromBoard(app, 'd1', 'doing');
  if (isPhone()) {
    await panel(app).getByRole('button', { name: 'Card menu' }).click();
    await app.getByTestId('menu-assistant').click();
  } else await panel(app).locator('.dt-ask').click();

  await expect(assistant(app)).toBeVisible();
  await expect(app.getByTestId('assistant-context')).toContainText('About: Plan the Lisbon trip');
  await assistant(app).getByRole('button', { name: /Break this into steps/ }).click();
  await expect(assistant(app).getByRole('status')).toContainText(/Working on your request · \d+ s/);
  await expect(assistant(app).getByRole('button', { name: 'Stop' }).first()).toBeVisible();
  const apply = assistant(app).getByRole('button', { name: 'Add 3 steps' });
  await expect(apply).toBeVisible();
  const before = (await items(api, 'd1')).length;
  await apply.click();
  await expect.poll(async () => (await items(api, 'd1')).length).toBe(before + 3);
  await expect(assistant(app)).toBeVisible(); // still on the assistant
  await expect(assistant(app)).toContainText('Added to');
  await expect(app.locator(`[data-card-id="${K('d1')}"][data-flash]`).first()).toBeAttached();
  await assistant(app).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await items(api, 'd1')).length).toBe(before);
});

test('23. the assistant never mutates on its own', async ({ app, api }) => {
  await mockAssistant(app, reply);
  await app.reload();
  await app.locator('.app').waitFor();
  const snapshot = async () => JSON.stringify((await api.cards()).map((c: any) => ({ ...c, updatedAt: 0 })).sort((a: any, b: any) => a.id.localeCompare(b.id)));
  const before = await snapshot();
  await app.getByRole('button', { name: 'Open assistant' }).click();
  await assistant(app).getByRole('button', { name: /Plan my day/ }).click();
  await expect(assistant(app).getByTestId('assistant-proposal')).toBeVisible();
  await app.waitForTimeout(500);
  expect(await snapshot()).toBe(before);
  await expect(assistant(app).getByRole('button', { name: 'Add to To do' })).toBeVisible(); // proposed, not applied
});

test('24. assistant on the phone: full-screen panel, composer above the keyboard, apply keeps the sheet open', async ({ app, api }) => {
  phoneOnly();
  // Fake an on-screen keyboard: shrink the visual viewport on demand.
  await app.addInitScript(() => {
    Object.defineProperty(window.visualViewport!, 'height', { get: () => (window as any).__vvh ?? window.innerHeight });
    Object.defineProperty(window.visualViewport!, 'offsetTop', { get: () => (window as any).__vvt ?? 0 });
  });
  await mockAssistant(app, reply);
  await app.reload();
  await app.locator('.app').waitFor();
  await app.getByRole('button', { name: 'Open assistant' }).click();
  const sheet = assistant(app);
  await expect(sheet).toBeVisible();
  await sheet.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished.catch(() => {}))));
  expect((await sheet.boundingBox())!.y).toBe(0);
  expect((await sheet.boundingBox())!.height).toBe(874);

  await sheet.getByRole('textbox').focus();
  await app.evaluate(() => {
    (window as any).__vvh = 500;
    (window as any).__vvt = 60;
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(() => app.evaluate(() => document.documentElement.style.getPropertyValue('--kb'))).toBe('314px');
  await expect.poll(async () => (await sheet.locator('.assistant-compose').boundingBox())!.y + (await sheet.locator('.assistant-compose').boundingBox())!.height).toBeLessThanOrEqual(562);

  await expect(sheet.locator('.assistant-viewport')).toHaveCSS('height', '500px');
  await expect(sheet.locator('.assistant-viewport')).toHaveCSS('margin-top', '60px');
  expect((await sheet.boundingBox())!.height).toBe(874);
  await app.screenshot({ path: 'test-results/assistant-fullscreen-keyboard.png' });

  await app.evaluate(() => {
    (window as any).__vvt = undefined;
    (window as any).__vvh = undefined;
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await sheet.getByRole('button', { name: /Plan my day/ }).click();
  await sheet.getByRole('button', { name: 'Add to To do' }).click();
  await expect(sheet).toBeVisible(); // the sheet stays open
  expect((await sheet.boundingBox())!.height).toBe(874);
  const created = async () => (await api.cards()).find((c: any) => c.title === 'Plan the week');
  await expect.poll(created).toBeTruthy();
  await expect(app.locator(`[data-card-id="${(await created()).id}"][data-flash]`).first()).toBeAttached();
  await sheet.getByRole('button', { name: 'Close assistant' }).click();
  await expect(sheet).not.toBeVisible();
  await expect(app.locator(`.phone-panes .card-face[data-card-id="${(await created()).id}"]`)).toBeVisible();
  void desktopOnly; void boardCard; void openColumn; void openView;
});
