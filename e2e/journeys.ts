// Shared helpers for the §13 journey specs: locators scoped to the visible pane, API helpers, gestures.
import { randomUUID } from 'node:crypto';
import { expect, openColumn, openView, setTheme, test, type Account } from './fixtures';
import type { Locator, Page } from '@playwright/test';

export { expect, openColumn, openView, setTheme, test };

/** v6 seed ids are `v6-<key>`. */
export const K = (key: string) => `v6-${key}`;
export const isPhone = () => test.info().project.name === 'phone';
export const desktopOnly = () => test.skip(isPhone(), 'desktop only (floating panel, hover, keyboard)');
export const phoneOnly = () => test.skip(!isPhone(), 'phone only (touch gestures, bottom sheets)');

/** Both views stay mounted side by side (phone: as tab panes): only the showing one counts. */
export const scope = (page: Page): Locator =>
  isPhone()
    ? page.locator('.app .phone-notes-pane:not([hidden]), .app .phone-panes:not([hidden]) .board.phone')
    : page.locator('.pane:not([inert])');
export const boardCard = (page: Page, key: string) => scope(page).locator(`[data-testid="card-${K(key)}"]`);
export const noteCard = (page: Page, key: string) => scope(page).locator(`[data-testid="note-${K(key)}"]`);
export const ring = (page: Page, key: string) => scope(page).getByTestId(`card-${K(key)}-circle`);
export const panel = (page: Page) => page.locator('.dt-panel, .dt-sheet').first();
export const toast = (page: Page) => page.getByTestId('toast');
export const itemBox = (page: Page, itemId: string) => panel(page).getByTestId(`item-${itemId}`).locator('.dt-box');

/** Opens a card from the Notes grid (clicks the body, never the ring). */
export async function openFromNotes(page: Page, key: string) {
  await openView(page, 'notes');
  await noteCard(page, key).click({ position: { x: 14, y: 40 } });
  await expect(panel(page)).toBeVisible();
}

/** Opens a card from the Board (phone: switches to its column first). */
export async function openFromBoard(page: Page, key: string, column: 'todo' | 'doing' | 'done') {
  await openView(page, 'board');
  await openColumn(page, column);
  await boardCard(page, key).click({ position: { x: 14, y: 14 } });
  await expect(panel(page)).toBeVisible();
}

export async function closePanel(page: Page) {
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
}

// ---- server state ------------------------------------------------------------------------------

export type Snap = Awaited<ReturnType<ReturnType<typeof import('./fixtures').makeApi>['snapshot']>>;

export const labelNames = (snap: Snap, card: { labels?: string[] }) =>
  (card.labels ?? []).map((id) => snap.labels.find((l: any) => l.id === id)?.name).filter(Boolean) as string[];

/** The card whose title or body contains `text` (the app may store a title-less note under its first line). */
export const findCard = (cards: any[], text: string) =>
  cards.find((c) => `${c.title}\n${c.notes}`.includes(text) && !String(c.id).startsWith('v6-'));

export async function accountJson(a: Account, route: string, init: { method?: string; body?: unknown; room?: string } = {}) {
  const res = await fetch(a.base + route + (init.room ? `${route.includes('?') ? '&' : '?'}room=${encodeURIComponent(init.room)}` : ''), {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', cookie: a.cookie, ...(init.room ? { 'x-todos-room': init.room } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

/** Pushes raw sync actions (as another device would). */
export async function pushActions(a: Account, actions: any[], room?: string) {
  const res = await accountJson(a, '/kanban/push', { body: { deviceId: `e2e-${randomUUID().slice(0, 8)}`, actions }, room });
  expect(res.status).toBe(200);
}
export const setFields = (id: string, fields: Record<string, unknown>) => ({
  id: randomUUID(),
  deviceId: 'e2e-device',
  ts: new Date().toISOString(),
  type: 'card.set',
  payload: { id, fields },
});

// ---- dates ---------------------------------------------------------------------------------------

/** The next given weekday (0 = Sunday) strictly after today, at h:m local. */
export function nextWeekday(dow: number, h: number, m: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + (((dow - d.getDay() + 7) % 7) || 7));
  d.setHours(h, m, 0, 0);
  return d;
}
export const tomorrowAt = (h: number, m = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0);
  return d;
};
export const localInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

// ---- touch ---------------------------------------------------------------------------------------

/** A real touch swipe (CDP), so touchstart/move/end reach the app. */
export async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8) {
  const cdp = await page.context().newCDPSession(page);
  const at = (x: number, y: number) => [{ x, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from.x, from.y) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: at(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps),
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

// ---- assistant mock ------------------------------------------------------------------------------

export type MockReply = { reply: string; proposals: any[]; delayMs?: number; error?: string };
/** Installs window.__assistantMock before the app loads (the model is not available in tests). */
export async function mockAssistant(page: Page, make: (message: string, focus: any) => MockReply) {
  await page.addInitScript(`window.__assistantMock = ${make.toString()};`);
}

/** Computed colour of an element as [r, g, b, a] (resolved through a canvas, so color-mix() etc. work). */
export async function rgbaOf(el: Locator, prop: string): Promise<[number, number, number, number]> {
  return el.evaluate((node, p) => {
    const raw = getComputedStyle(node).getPropertyValue(p);
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = raw;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255] as [number, number, number, number];
  }, prop);
}
export function hueSat([r, g, b]: number[]): { hue: number; sat: number } {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  const l = (max + min) / 2;
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d) {
    if (max === R) hue = ((G - B) / d) % 6;
    else if (max === G) hue = (B - R) / d + 2;
    else hue = (R - G) / d + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return { hue, sat };
}

/** Opens the Labels menu (phone: from the ··· menu). */
export async function openLabels(page: Page) {
  if (isPhone()) {
    if (!(await page.locator('.phone-more-menu').count())) await page.getByRole('button', { name: 'More options' }).click();
    await page.locator('.phone-more-menu').getByTestId('phone-labels').click();
    await expect(page.locator('.phone-more-menu')).toHaveCount(0); // §11.20.4: the ··· menu closes
  } else await page.getByTestId('label-filter').click();
  await expect(page.getByRole('dialog', { name: /Labels/ })).toBeVisible();
}
