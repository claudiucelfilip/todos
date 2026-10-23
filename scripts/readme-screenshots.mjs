// Capture the README from a temporary workspace; no personal data or live services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { studioThemes } from '../shared/appearance.mjs';
import { diffCards, diffLabels } from '../shared/merge.mjs';
import { buildIfStale, root, startApp } from './visual/servers.mjs';

const out = path.join(root, 'docs/screenshots');
const showcaseTheme = process.argv[2] || 'Black & Laser Lime';
const showcaseThemeId = studioThemes.find(theme => theme.name === showcaseTheme)?.id;
assert(showcaseThemeId, `Unknown theme: ${showcaseTheme}`);
fs.mkdirSync(out, { recursive: true });
buildIfStale();
process.env.TODOS_AI_URL = 'http://127.0.0.1:9';
const app = await startApp();
let browser;
const captured = [];
try {
  const login = await fetch(`${app.base}/kanban/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'visualowner', password: 'visual-owner-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const headers = { cookie, 'content-type': 'application/json' };
  const snapshot = async () => (await fetch(`${app.base}/kanban/snapshot`, { headers })).json();
  const now = new Date();
  const ts = now.toISOString();
  const nextDay = new Date(now); nextDay.setDate(nextDay.getDate() + 1); nextDay.setHours(9, 0, 0, 0);
  const labels = [
    { id: 'demo-work', name: 'Work', color: '#2F80ED' },
    { id: 'demo-life', name: 'Life', color: '#2E9E6B' },
    { id: 'demo-ideas', name: 'Ideas', color: '#E2699A' },
    { id: 'demo-reading', name: 'Reading', color: '#F5A524' },
  ].map(label => ({ ...label, updatedAt: ts }));
  const source = [
    { id: 'weekend', title: 'Plan a weekend away', status: 'todo', labels: ['demo-life'], notes: 'Somewhere quiet, with a good walk and a late breakfast.', items: ['Choose a place', 'Book a room', 'Pack the camera'], remindAt: nextDay.toISOString() },
    { id: 'website', title: 'Give the website a fresh start', status: 'todo', labels: ['demo-work'], items: ['Sketch the homepage', 'Write a clearer introduction', 'Pick three favourite projects'] },
    { id: 'book', title: 'One chapter before bed', status: 'todo', labels: ['demo-reading'], notes: 'Make a little space for a good book.' },
    { id: 'collection', title: 'Launch the autumn collection', status: 'doing', labels: ['demo-work'], notes: 'A small collection, thoughtfully made. Everything we need for launch, in one place.', items: [{ text: 'Choose the final pieces', done: true }, { text: 'Product photography', ref: 'demo-photos' }, 'Write the launch story', 'Send the first newsletter'] },
    { id: 'reset', title: 'The Sunday reset', status: 'doing', labels: ['demo-life'], items: [{ text: 'Clear the desk', done: true }, 'Plan three good meals', 'Choose one thing for next week'] },
    { id: 'studio', title: 'Book the studio', status: 'done', labels: ['demo-work'], notes: 'A bright room, a big table, and a whole morning to make things.' },
    { id: 'garden', title: 'Plant the kitchen herbs', status: 'done', labels: ['demo-life'], items: [{ text: 'Basil', done: true }, { text: 'Rosemary', done: true }, { text: 'Mint', done: true }] },
    { id: 'pottery', title: 'Try a pottery class', status: 'todo', labels: ['demo-life'], someday: true, notes: 'Something to look forward to.' },
    { id: 'ideas', title: 'A place for the next big idea', labels: ['demo-ideas'], notes: '## Start small\nA notebook of possibilities. Keep the useful fragments, follow the interesting questions, and turn the best ones into a plan.\n\n## Worth exploring\n- A monthly supper club\n- A tiny photo journal\n- A better morning routine' },
    { id: 'photos', title: 'Product photography', labels: ['demo-work'], notes: 'Soft daylight. Honest textures. A little room to breathe.', items: [{ text: 'Make a shot list', done: true }, 'Photograph each piece', 'Choose the final six'] },
    { id: 'meals', title: 'Good things to cook', labels: ['demo-life'], notes: 'Roast squash with tahini. A big pot of tomato soup. Apple cake for the weekend.' },
    { id: 'journal', title: 'Notes from the week', labels: ['demo-ideas'], notes: 'Leave enough space in the plan for something unexpected.' },
  ];
  const cards = source.map((card, order) => ({
    createdAt: ts, updatedAt: ts, completedAt: card.status === 'done' ? ts : null,
    archivedAt: null, someday: false, repeat: false, remindedAt: null, remindAt: null,
    ...card, id: `demo-${card.id}`, status: card.status || 'todo', order,
    titleBy: 'user', kind: card.status ? 'todo' : 'note',
    labels: [...card.labels, ...(card.status ? [`workflow:${card.status}`] : [])],
    items: (card.items || []).map((item, index) => ({ id: `demo-${card.id}-${index}`, text: typeof item === 'string' ? item : item.text, done: false, ...(typeof item === 'object' ? item : {}) })),
  }));
  const seeded = await fetch(`${app.base}/kanban/push`, {
    method: 'POST', headers,
    body: JSON.stringify({ deviceId: 'readme-demo', actions: [...diffLabels([], labels, ts, 'readme-demo'), ...diffCards([], cards, ts, 'readme-demo')] }),
  });
  assert.equal(seeded.status, 200);
  assert.equal((await snapshot()).cards.length, cards.length);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1.5, serviceWorkers: 'block', locale: 'en-GB' });
  const [name, ...value] = cookie.split('=');
  await context.addCookies([{ name, value: value.join('='), url: app.base }]);
  const page = await context.newPage();
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  await page.goto(app.base);
  await page.getByTestId('card-demo-weekend').waitFor();
  await page.getByTestId('settings').click();
  let settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('radio', { name: showcaseTheme, exact: true }).click();
  await settings.getByRole('radio', { name: 'Dots', exact: true }).click();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-material'), showcaseThemeId);
  const capture = async (target, file) => {
    await target.evaluate(() => document.fonts.ready);
    await target.locator('.phone-panes[data-moving]').waitFor({ state: 'hidden' });
    await target.waitForTimeout(800);
    assert(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');
    await target.mouse.move(0, 0);
    await target.screenshot({ path: path.join(out, file), type: 'jpeg', quality: 88, animations: 'disabled' });
    captured.push(file);
  };
  await capture(page, 'board-desktop.jpg');
  await page.getByTestId('view-notes').click();
  await page.getByTestId('note-demo-collection').click();
  await page.getByTestId('detail-title').waitFor();
  assert.equal(await page.getByTestId('detail-title').inputValue(), 'Launch the autumn collection');
  await capture(page, 'notes-desktop.jpg');
  await page.getByTestId('detail-close').click();
  await page.getByTestId('settings').click();
  settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('radio', { name: 'Ice & Cherry', exact: true }).click();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByTestId('view-board').click();
  await capture(page, 'board-light.jpg');
  await page.getByTestId('settings').click();
  settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('radio', { name: showcaseTheme, exact: true }).click();
  await settings.getByRole('radiogroup', { name: 'Theme', exact: true }).screenshot({ path: path.join(out, 'theme-palettes.jpg'), type: 'jpeg', quality: 90, animations: 'disabled' });
  captured.push('theme-palettes.jpg');
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  const phoneContext = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'en-GB' });
  await phoneContext.addCookies([{ name, value: value.join('='), url: app.base }]);
  const phone = await phoneContext.newPage();
  phone.on('pageerror', error => failures.push(error.message));
  await phone.goto(app.base);
  await phone.getByTestId('card-demo-weekend').waitFor();
  assert.equal(await phone.locator('html').getAttribute('data-material'), showcaseThemeId);
  await capture(phone, 'board-mobile.jpg');
  await phone.getByTestId('nav-doing').click();
  await phone.locator('.phone-panes[data-moving]').waitFor({ state: 'hidden' });
  await phone.getByTestId('card-demo-collection').click();
  await phone.getByTestId('detail-title').waitFor();
  await capture(phone, 'editor-mobile.jpg');
  await phoneContext.close();
  await page.getByTestId('settings').click();
  settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('radio', { name: showcaseTheme, exact: true }).click();
  await settings.getByRole('button', { name: 'Create flow', exact: true }).click();
  await settings.getByRole('button', { name: 'Use Editorial example', exact: true }).click();
  await settings.getByRole('button', { name: 'Save flow', exact: true }).click();
  await expect.poll(async () => (await snapshot()).labels.filter(label => label.group === 'Editorial').length).toBe(3);
  await settings.locator('.flow-overview').filter({ hasText: 'Editorial' }).getByRole('button', { name: 'Use as board columns' }).click();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  if (await page.getByTestId('toast').count()) await page.getByTestId('toast').getByRole('button', { name: 'Dismiss', exact: true }).click();
  const assignments = { website: 'Draft', ideas: 'Draft', collection: 'Review', photos: 'Review', studio: 'Published', garden: 'Published' };
  await page.evaluate(assignments => {
    const labels = window.kanban.labels();
    for (const [id, name] of Object.entries(assignments)) {
      const card = window.kanban.get(`demo-${id}`);
      const stage = labels.find(label => label.group === 'Editorial' && label.name === name);
      if (!card || !stage) throw new Error(`Demo flow stage missing: ${id}, ${name}`);
      window.kanban.setLabels(card.id, [...card.labels.filter(id => !id.startsWith('workflow:')), stage.id]);
    }
  }, assignments);
  await expect.poll(async () => {
    const data = await snapshot();
    const stages = new Set(data.labels.filter(label => label.group === 'Editorial').map(label => label.id));
    return data.cards.filter(card => card.labels.some(id => stages.has(id))).length;
  }).toBe(Object.keys(assignments).length);
  await expect(page.getByRole('heading', { name: 'Published', exact: true })).toBeVisible();
  await capture(page, 'flows-desktop.jpg');
  await page.getByTestId('settings').click();
  settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Edit Draft behavior' }).click();
  const behavior = settings.getByTestId('label-settings');
  await behavior.getByRole('button', { name: 'Add automation' }).click();
  await behavior.getByRole('combobox', { name: 'When' }).selectOption('complete');
  await behavior.getByRole('combobox', { name: 'For' }).selectOption('owner');
  await behavior.getByRole('combobox', { name: 'Then' }).selectOption('set-group');
  const review = (await snapshot()).labels.find(label => label.group === 'Editorial' && label.name === 'Review');
  assert(review, 'Editorial Review label missing');
  await behavior.getByRole('combobox', { name: 'Label', exact: true }).selectOption(review.id);
  await behavior.getByRole('button', { name: 'Save automation' }).click();
  await expect(behavior).toContainText('Set Editorial Review');
  await settings.evaluate(() => document.fonts.ready);
  await behavior.locator('.automation-section').filter({ hasText: 'Automations' }).first().evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const settingsBounds = await settings.boundingBox();
  assert(settingsBounds, 'Settings dialog has no visible bounds');
  await page.screenshot({ path: path.join(out, 'label-actions.jpg'), type: 'jpeg', quality: 90, animations: 'disabled', clip: { x: settingsBounds.x, y: settingsBounds.y, width: settingsBounds.width, height: Math.min(settingsBounds.height, 340) } });
  captured.push('label-actions.jpg');
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  assert.deepEqual(failures, []);
  fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify({ capturedAt: new Date().toISOString(), source: 'local production build, isolated demo workspace', screenshots: captured, desktopViewport: '1440x960', mobileViewport: '402x874', pageErrors: failures }, null, 2) + '\n');
  console.log(`Captured ${captured.length} screenshots: ${captured.join(', ')}`);
} finally {
  await browser?.close();
  app.stop();
}
