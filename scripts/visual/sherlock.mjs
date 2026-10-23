import { chromium, webkit } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { startServer, stopServer } from '../test-server.mjs';
import { sherlockFixture } from '../sherlock-fixture.mjs';

const mock = await sherlockFixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-sherlock-ui-'));
fs.writeFileSync(path.join(dir, 'sherlock-config.json'), JSON.stringify(mock.config));
const server = await startServer('server.js', { env: { DATA_DIR: dir, TODOS_USER: 'owner', TODOS_PASS: 'fixture-password', API_TOKEN: 'fixture-api', SHERLOCK_POLL_MS: '999999' } });
const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-api' };
const post = async (route, body) => { const res = await fetch(server.base + route, { method: 'POST', headers, body: JSON.stringify(body) }); return res.json(); };
try {
for (const [name, engine, phone] of [['desktop', chromium, false], ['phone', chromium, true], ['webkit-phone', webkit, true]]) {
 if (process.env.SHERLOCK_BROWSER && process.env.SHERLOCK_BROWSER !== name) continue;
 const browser = await engine.launch({ headless: true });
 try {
 const context = await browser.newContext({ viewport: phone ? { width: 402, height: 874 } : { width: 1440, height: 1000 }, isMobile: phone, hasTouch: phone });
 await context.addInitScript(() => { if (!localStorage.getItem('kept.syncedAt')) localStorage.setItem('kept.syncedAt', '2026-01-01T00:00:00.000Z'); });
 const login = await context.request.post(server.base + '/kanban/login', { data: { username: 'owner', password: 'fixture-password' } }); assert(login.ok());
 const created = await post('/kanban/external/card', { key: `ui:${name}`, title: `Appointment ${name}`, notes: 'Arrange the appointment.', status: 'todo' });
 const id = created.id;
 const page = await context.newPage(); page.on('pageerror',e=>console.log('BROWSER ERROR',e.message)); await page.goto(`${server.base}/#card/${id}`);
 const panel = page.locator('.dt-panel, .dt-sheet'); await panel.waitFor({timeout:10000}).catch(async e=>{console.log(await page.locator('body').innerText());await page.screenshot({path:'/private/tmp/sherlock-ui-failure.png'});throw e});
 await page.evaluate(() => document.fonts.ready);
 const ask = page.getByRole('button', { name: 'Ask Sherlock', exact: true }); await ask.scrollIntoViewIfNeeded(); if (phone) await ask.tap(); else await ask.click();
 const input = page.getByRole('textbox', { name: 'Message to Sherlock' }); await input.waitFor({timeout:8000}).catch(async e=>{console.log(name,await page.locator('body').innerText());await page.screenshot({path:'/private/tmp/sherlock-webkit-failure.png'});throw e}); assert(await input.evaluate(el => el === document.activeElement));
 await page.waitForTimeout(400);
 const focusedBox = await input.boundingBox();
 for (const focused of [true, false]) {
  if (!focused) await input.evaluate(el => el.blur());
  const material = await input.evaluate(el => { const s = getComputedStyle(el); return [s.backgroundColor, s.boxShadow, s.borderTopWidth, s.outlineStyle]; });
  assert.deepEqual(material, ['rgba(0, 0, 0, 0)', 'none', '0px', 'none']);
  assert.deepEqual(await input.boundingBox(), focusedBox);
 }
 await input.focus();
 if (name !== 'webkit-phone') await page.locator('.sh-handoff').screenshot({ path: `/private/tmp/todos-sherlock-composer-${name}.png` });
 await input.fill('Which documents do I need?'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
 await page.getByRole('button', { name: 'Ask Sherlock', exact: true }).click(); assert.equal(await input.inputValue(), 'Which documents do I need?');
 mock.fail = 'slack'; await page.getByRole('button', { name: 'Send to Sherlock', exact: true }).click();
 await page.getByRole('alert').filter({ hasText: 'Couldn’t send' }).waitFor(); assert.match(await page.locator('.sh-error').innerText(), /limiting requests/);
 await page.getByText('Technical details', { exact: true }).click(); assert.match(await page.locator('.sh-diagnostics pre').innerText(), /SLACK_RATELIMITED/);
 assert.equal(await page.locator('body').evaluate(el => el.scrollWidth <= innerWidth), true);
 await page.reload(); await input.waitFor(); assert.equal(await input.inputValue(), 'Which documents do I need?');
 mock.fail = ''; await page.getByRole('button', { name: 'Retry', exact: true }).click(); await page.getByRole('link', { name: 'Open Slack thread' }).waitFor();
 assert.equal(await input.count(), 0); const snapshot = await (await fetch(server.base + '/kanban/snapshot', { headers })).json();
 const card = snapshot.cards.find(c => c.id === id); assert(card.labels.includes('workflow:todo')); assert(card.labels.includes('sherlock'));
 const threadLink = page.getByRole('link', { name: 'Open Slack thread' });
 const target = await threadLink.getAttribute('href'); assert.equal(new URL(target).pathname, `/thread/${card.ext.slackTs}`);
 assert.equal(await threadLink.getAttribute('target'), '_blank');
 await page.getByRole('button', { name: 'Send follow-up', exact: true }).click(); await input.fill('Keep this follow-up draft.');
 await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.getByRole('button', { name: 'Send follow-up', exact: true }).click(); assert.equal(await input.inputValue(), 'Keep this follow-up draft.'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
 // A backgrounded panel must not consume the notification.
 const other = await context.newPage(); await other.goto('about:blank'); await other.bringToFront();
 mock.messages.push({ channel: 'DM', thread_ts: card.ext.slackTs, ts: `${1900000000 + (phone ? name === 'phone' ? 1 : 2 : 0)}.000001`, user: 'BOT', text: 'Bring your referral and ID. The clinic accepts appointments by phone.' });
 await context.request.get(server.base + `/kanban/sherlock?id=${id}`);
 await new Promise(r => setTimeout(r, 800));
 let latest = (await (await fetch(server.base + '/kanban/snapshot', { headers })).json()).cards.find(c => c.id === id); assert(latest.labels.includes('sherlock:replied'));
 await other.close(); await page.bringToFront();
 // Explicit reload exercises revisiting as well as the foreground event.
 await page.reload(); await page.locator('.sh-summary').waitFor(); await page.locator('.sh-summary').scrollIntoViewIfNeeded();
 assert.equal(await page.locator('.sh-summary').innerText(), 'Bring your referral and ID.');
 assert.equal(await threadLink.getAttribute('href'), target);
 assert(await threadLink.evaluate(el => getComputedStyle(el).textDecorationLine.includes('underline')));
 const summaryBox = await page.locator('.sh-summary').boundingBox(), linkBox = await threadLink.boundingBox();
 assert(linkBox.y >= summaryBox.y + summaryBox.height);
 const opened = await Promise.all([page.waitForEvent('popup'), threadLink.click()]);
 await opened[0].waitForLoadState(); assert.equal(opened[0].url(), target); await opened[0].close();
 await page.waitForTimeout(1500);
 latest = (await (await fetch(server.base + '/kanban/snapshot', { headers })).json()).cards.find(c => c.id === id); assert(!latest.labels.includes('sherlock:replied')); assert(latest.labels.includes('workflow:todo'));
 assert.equal(await page.getByRole('button', { name: 'Mark read' }).count(), 0);
 const reviewId = `review-${name}`, now = new Date().toISOString();
 await post('/kanban/push', { deviceId: 'review-fixture', actions: [
  { id: `label-${name}`, type: 'label.put', ts: now, payload: { label: { id: reviewId, name: 'Review', color: '#E2B56A', removeOnView: true } } },
  { id: `apply-${name}`, type: 'card.set', ts: now, payload: { id, fields: { labels: [...latest.labels, reviewId] } } },
 ] });
 await page.reload(); await panel.waitFor(); await page.waitForTimeout(1200);
 latest = (await (await fetch(server.base + '/kanban/snapshot', { headers })).json()).cards.find(c => c.id === id); assert(!latest.labels.includes(reviewId));
 if (await page.getByRole('button', { name: 'Cancel', exact: true }).count()) await page.getByRole('button', { name: 'Cancel', exact: true }).click();
 if (name !== 'webkit-phone') await page.screenshot({ path: `/private/tmp/todos-sherlock-${name}.png`, fullPage: true });
 const importedRoot = `${1700000000 + (name === 'desktop' ? 0 : name === 'phone' ? 1 : 2)}.000001`;
 mock.messages.push({ channel: 'DM', ts: importedRoot, user: 'BOT', text: 'The project brief is ready. Here are the details.' });
 const imported = await post('/kanban/external/card', { key: `wiki:ui-${name}`, title: 'Imported project brief', slackChannel: 'DM', slackTs: importedRoot, labels: [{ id: 'sherlock', name: 'Sherlock', color: '#AC8BFA' }] });
 await context.request.get(server.base + `/kanban/sherlock?id=${imported.id}`);
 let importedCard = (await (await fetch(server.base + '/kanban/snapshot', { headers })).json()).cards.find(c => c.id === imported.id);
 assert(importedCard.labels.includes('sherlock:replied')); assert(importedCard.labels.includes('workflow:todo'));
 await page.goto(`${server.base}/?imported=${name}#card/${imported.id}`);
 await page.locator('.sh-summary').waitFor(); await page.locator('.sh-summary').scrollIntoViewIfNeeded();
 assert.equal(await page.locator('.sh-summary').innerText(), 'The project brief is ready.');
 assert.equal(await page.getByRole('button', { name: 'Ask Sherlock', exact: true }).count(), 0);
 assert.equal(new URL(await threadLink.getAttribute('href')).pathname, `/thread/${importedRoot}`);
 await page.getByRole('button', { name: 'Send follow-up', exact: true }).click();
 await input.fill('Explain the first step.'); await page.getByRole('button', { name: 'Send to Sherlock', exact: true }).click();
 await input.waitFor({ state: 'hidden' }); assert.equal(mock.deliveries.at(-1).thread, importedRoot);
 await page.waitForTimeout(1500);
 importedCard = (await (await fetch(server.base + '/kanban/snapshot', { headers })).json()).cards.find(c => c.id === imported.id);
 assert(!importedCard.labels.includes('sherlock:replied')); assert.equal(importedCard.ext.key, `wiki:ui-${name}`);
 console.log(`${name}: imported Wiki reply label, summary, canonical thread, visible acknowledgment and same-thread follow-up passed.`);
 console.log(`${name}: focus, draft retention after cancel/reload, explained failure/retry, labels/To do, same-thread follow-up, background reply retention and visible summary acknowledgment passed.`);
 } finally { await browser.close(); }
}
} finally { await stopServer(server.child); await mock.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
