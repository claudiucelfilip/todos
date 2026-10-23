import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { test as base, expect, type Page } from '@playwright/test';
import { OWNER } from './global-setup';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const json = { 'content-type': 'application/json' };
let counter = 0;
let inviteRoom: Promise<string> | undefined;

export type Theme = 'light' | 'dark' | 'sky';
export type Account = { username: string; password: string; cookie: string; base: string };

const cookieOf = (res: Response) => res.headers.getSetCookie()[0].split(';')[0];

/** Creates a brand-new account (via an owner-issued invitation) and seeds it with the demo board. */
async function createSeededAccount(base: string, tag: string): Promise<Account> {
  const login = await fetch(`${base}/kanban/login`, { method: 'POST', headers: json, body: JSON.stringify(OWNER) });
  const owner = cookieOf(login);
  const post = (route: string, cookie: string, body: unknown) =>
    fetch(base + route, { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify(body) });
  // One invitation room per worker: the owner may hold at most 50 rooms, and a full run makes more accounts than that.
  inviteRoom ??= post('/kanban/rooms', owner, { name: `Invites ${process.pid}` }).then(async (r) => (await r.json()).room.id as string);
  const { url } = await (await post('/kanban/invite', owner, { room: await inviteRoom })).json();
  const token = new URL(url).searchParams.get('invite');
  const username = `t${tag}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const password = `pw-${tag}-e2e-password`;
  const reg = await post('/kanban/register', '', { username, password, token });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  const cookie = cookieOf(reg);
  await run(process.execPath, ['scripts/seed-demo.mjs'], {
    cwd: root,
    env: { ...process.env, TODOS_BASE: base, TODOS_USER: username, TODOS_PASS: password },
  });
  return { username, password, cookie, base };
}

async function useAccount(page: Page, a: Account) {
  const [name, ...rest] = a.cookie.split('=');
  await page.context().addCookies([{ name, value: rest.join('='), url: a.base }]);
}

export async function waitForBoard(page: Page) {
  await page.locator('.app').waitFor();
  await expect(page.locator('.columns, .notes-grid').filter({ visible: true }).first()).toBeVisible();
}

/** Phone: the tab panes have finished sliding (hidden panes are visibility: hidden at rest). */
async function panesSettled(page: Page) {
  await expect(page.locator('.phone-panes[data-moving]')).toHaveCount(0);
}

export async function openView(page: Page, view: 'board' | 'notes') {
  const phone = await page.locator('.app.phone').count();
  if (phone) {
    await page.getByTestId(`view-${view}`).click();
    await panesSettled(page);
    await expect(page.locator(view === 'notes' ? '.notes-grid' : '.column[data-status="todo"]')).toBeVisible();
    return;
  }
  await page.getByTestId(`view-${view}`).click();
  await expect(page.locator(view === 'notes' ? '.notes-grid' : '.columns').first()).toBeVisible();
}

/** Phone shows one column at a time; on desktop every column is visible, so this is a no-op there. */
export async function openColumn(page: Page, column: 'todo' | 'doing' | 'done') {
  if (!(await page.locator('.app.phone').count())) return;
  await page.getByTestId(`nav-${column}`).click();
  await panesSettled(page);
  await expect(page.locator(`.column[data-status="${column}"]`)).toBeVisible();
}

export async function setTheme(page: Page, theme: Theme) {
  if (await page.locator('.app.phone').count()) {
    await page.getByRole('button', { name: 'More options' }).click();
  }
  await page.getByTestId('settings').click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const name = { light: 'Lime & Deep Violet', dark: 'Black & Laser Lime', sky: 'Sky & Lemon' }[theme];
  const option = dialog.getByRole('radio', { name });
  await option.click();
  await expect(option).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
}

export async function openCard(page: Page, title: string) {
  await page.locator('[data-testid^="card-"]').filter({ hasText: title }).first().click();
  await expect(page.locator('.dt-panel, .dt-sheet').first()).toBeVisible();
}

/** Reads the board from the server, for assertions. */
export function makeApi(a: Account) {
  const get = async (route: string) => (await fetch(a.base + route, { headers: { cookie: a.cookie } })).json();
  return {
    snapshot: () => get('/kanban/snapshot') as Promise<{ cards: any[]; labels: any[]; tombstones: any[]; cursor: unknown }>,
    cards: async () => (await get('/kanban/snapshot')).cards as any[],
    cardByTitle: async (title: string) => (await get('/kanban/snapshot')).cards.find((c: any) => c.title === title),
  };
}

type Fixtures = {
  baseURL: string;
  account: Account;
  /** Page already signed in, at '/', board rendered. */
  app: Page;
  api: ReturnType<typeof makeApi>;
  /** Swaps in a brand-new seeded account and reloads (a cheap reset to the demo state). */
  freshBoard: () => Promise<void>;
};

export const test = base.extend<Fixtures>({
  baseURL: async ({}, use) => use(process.env.E2E_BASE!),
  account: async ({ baseURL }, use, testInfo) => {
    const tag = `${testInfo.workerIndex}x${Date.now().toString(36)}${counter++}`;
    const a = await createSeededAccount(baseURL, tag);
    fs.mkdirSync(path.join(root, 'e2e/.auth'), { recursive: true });
    await use(a);
  },
  app: async ({ page, account }, use) => {
    await useAccount(page, account);
    await page.goto('/');
    await waitForBoard(page);
    await use(page);
  },
  api: async ({ account }, use) => use(makeApi(account)),
  freshBoard: async ({ page, account, baseURL }, use, testInfo) => {
    await use(async () => {
      const a = await createSeededAccount(baseURL, `${testInfo.workerIndex}r${Date.now().toString(36)}${counter++}`);
      Object.assign(account, a);
      await page.context().clearCookies();
      await useAccount(page, a);
      await page.goto('/');
      await waitForBoard(page);
    });
  },
});

export { expect };
