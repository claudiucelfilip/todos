// Siri capture against the REAL server.js with a temp DATA_DIR: the per-user token from
// Settings, POST /kanban/capture (spoken reminder times, dictated checklists, the spoken
// reply), rooms kept apart, limits, revoking, and the signed shortcut files. Run: `npm run test:capture`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, stopServer } from './test-server.mjs';
import http from 'node:http';
import { splitItems, parseCapture, captureItems, sayCapture } from '../shared/capture.mjs';
import { sameWords, createDictationSplitter } from '../shared/split.mjs';
import { extractWhen } from '../shared/when.mjs';
import { shortcutXml, SHORTCUTS, signingAvailable } from '../shared/shortcut-file.mjs';
import { validateIntent, understand } from '../shared/intent.mjs';
import { privateAddress, pageTitle } from '../shared/page-title.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-capture-'));
let server;
let checks = 0;
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks++; console.log('ok', name); };

// --- pure parsing ---------------------------------------------------------------------------
const monday = Date.parse('2026-10-05T10:40:00+03:00');
const when = (text) => extractWhen(text, { now: monday, offset: 180 });
check('a spoken time leaves the title', when('water the plants tomorrow at 9am'), { title: 'water the plants', remindAt: '2026-10-06T06:00:00.000Z' });
check('"at 6" is the evening, "at 9" the next morning once 9 is gone', [when('call mom at 6').remindAt, when('call mom at 9').remindAt], ['2026-10-05T15:00:00.000Z', '2026-10-06T06:00:00.000Z']);
check('weekdays, next week, dates, relative spans', [when('rent on Friday').remindAt, when('rent next Monday at 10:30').remindAt, when('dentist October 12 at 3pm').remindAt, when('milk in 2 hours').remindAt, when('taxes next week').remindAt], ['2026-10-09T06:00:00.000Z', '2026-10-12T07:30:00.000Z', '2026-10-12T12:00:00.000Z', '2026-10-05T09:40:00.000Z', '2026-10-12T06:00:00.000Z']);
check('periods: tonight, tomorrow afternoon, this evening', [when('call tonight at 7').remindAt, when('taxes tomorrow afternoon').remindAt, when('taxes this evening').remindAt], ['2026-10-05T16:00:00.000Z', '2026-10-06T12:00:00.000Z', '2026-10-05T16:00:00.000Z']);
check('Romanian', [when('udă florile mâine la 9'), when('sună mama diseară').remindAt], [{ title: 'udă florile', remindAt: '2026-10-06T06:00:00.000Z' }, '2026-10-05T17:00:00.000Z']);
check('plain todos stay plain', [when('meet at the station'), when('buy 3 kg of apples'), when('late night snack'), when('morning routine')].map((r) => r.remindAt), [null, null, null, null]);
check('"remind me to" is dropped', when('remind me to take the bins out tomorrow').title, 'take the bins out');
check('the server zone is used without a device offset', extractWhen('x tomorrow at 9', { now: monday, tz: 'Europe/Bucharest' }).remindAt, '2026-10-06T06:00:00.000Z');
check('dictated items split on commas and "and", skip "no", drop the full stop', [splitItems('milk, eggs and bread.'), splitItems('No.'), splitItems(['a', 'a', ''])], [['milk', 'eggs', 'bread'], [], ['a']]);
check('parseCapture: title, items, reminder from the device clock', parseCapture({ title: 'Groceries tomorrow at 9.', items: 'milk and eggs', now: '2026-10-05T10:40:00+03:00' }, { now: monday }), { title: 'Groceries', items: ['milk', 'eggs'], notes: '', remindAt: '2026-10-06T06:00:00.000Z', offset: 180 });
check('parseCapture: explicit remindAt wins, bad ones answer', [parseCapture({ title: 'x tomorrow', remindAt: '2030-01-02T08:00:00Z' }).remindAt, parseCapture({ title: 'x', remindAt: 'soon' }).error, parseCapture({ title: ' . ' }).error], ['2030-01-02T08:00:00.000Z', "couldn't understand the reminder time", 'title is required']);
check('the reply reads in the device zone', sayCapture({ title: 'Dentist', items: ['a', 'b'], remindAt: '2026-10-06T06:00:00.000Z', offset: 180 }), 'Added “Dentist” with 2 items: a, b. Reminder Tuesday 6 October at 09:00.');
const xml = shortcutXml('todo', { base: 'https://todos.example', token: 'tok_abc' });
check('the shortcut file carries the token, the route, the watch flag, the prompt and the follow-up question', [xml.includes('Bearer tok_abc'), xml.includes('https://todos.example/kanban/capture'), xml.includes('WatchKit'), xml.includes('What would you like?'), xml.includes('ISO 8601'), xml.includes('Which items'), (xml.match(/is.workflow.actions.conditional/g) || []).length], [true, true, true, true, true, true, 3]);
const share = shortcutXml('send', { base: 'https://todos.example', token: 'tok_abc' });
check('the share-sheet shortcut takes links and text from the sheet and notifies', [share.includes('ActionExtension'), share.includes('WFURLContentItem'), share.includes('ExtensionInput'), share.includes('is.workflow.actions.notification'), share.includes('WatchKit')], [true, true, true, true, false]);
check('three shortcuts: two Siri phrases and the share sheet', Object.values(SHORTCUTS).map((s) => s.say), ['Hey Siri, update my board', 'Share sheet → Send to Todos']);
const boardCards = [{ id: 'c1', title: 'Groceries' }, { id: 'c2', title: 'Water the plants' }];
check('validateIntent: the model may pick and group words, never invent or point at a missing card', [
  validateIntent('{"action":"add_items","card":"c1","items":["carrots","coconut milk"]}', 'update my checklist groceries and add carrots and coconut milk', boardCards),
  validateIntent('{"action":"add_items","card":"c1","items":["bananas"]}', 'add carrots to groceries', boardCards),
  validateIntent('{"action":"rename","card":"c9","title":"x"}', 'rename x', boardCards),
  validateIntent('{"action":"remind","card":"c2"}', 'water the plants', boardCards)?.action,
], [{ action: 'add_items', card: boardCards[0], items: ['carrots', 'coconut milk'] }, null, null, 'remind']);
check('understand: an exact title plus a time is a reminder without the model; "x with a, b" is a checklist', [
  await understand('remind me about water the plants tomorrow at 9', boardCards, null, { now: monday, offset: 180 }),
  (await understand('add a checklist groceries with pants, milk and coconut milk', boardCards, null, { now: monday, offset: 180 })).intent,
  (await understand('remind me about groceries', boardCards, null, { now: monday, offset: 180 })).error,
], [{ intent: { action: 'remind', card: boardCards[1] }, remindAt: '2026-10-06T06:00:00.000Z' }, { action: 'create', title: 'groceries', items: ['pants', 'milk', 'coconut milk'] }, undefined]);
check('validateIntent: "a few items" is a request for items; the flag written as the action still counts', [
  validateIntent('{"action":"add_items","card":"c1","items":["a few items"]}', 'add a few items to groceries', boardCards),
  validateIntent('{"action":"needsItems","card":null,"title":"trip","items":null,"needsItems":true}', 'make a checklist called trip', boardCards),
], [{ action: 'add_items', card: boardCards[0], items: [], needsItems: true }, { action: 'create', title: 'trip', items: [], needsItems: true }]);
check('validateIntent: a checklist with no items asks even when the model forgot the flag; a plain todo does not', [validateIntent('{"action":"create","card":null,"title":"siri test","items":[]}', 'add a checklist called siri test', boardCards), validateIntent('{"action":"create","card":null,"title":"call mom","items":[]}', 'call mom', boardCards)], [{ action: 'create', title: 'siri test', items: [], needsItems: true }, { action: 'create', title: 'call mom', items: [] }]);
check('validateIntent: a "new" checklist named like an existing card adds to that card', validateIntent('{"action":"create","card":null,"title":"water the plants","items":[],"needsItems":true}', 'add a checklist to water the plants', boardCards), { action: 'add_items', card: boardCards[1], items: [], needsItems: true });
check('understand: with a model that answers nonsense the fallback still creates, and a checklist still asks', [(await understand('call the plumber', boardCards, async () => 'nope', { now: monday })).intent, (await understand('add a checklist called trip', boardCards, null, { now: monday })).intent], [{ action: 'create', title: 'call the plumber', items: [] }, { action: 'create', title: 'trip', items: [], needsItems: true }]);
check('sameWords: grouping is fine, changing words is not', [sameWords('Milk bread peanut butter', ['Milk', 'bread', 'peanut butter']), sameWords('milk bread', ['milk', 'bread', 'eggs']), sameWords('milk bread', ['milk'])], [true, false, false]);
check('captureItems: separators never ask the model; one word neither', [await captureItems('milk, eggs', async () => { throw new Error('no'); }), await captureItems('milk', async () => ['x'])], [['milk', 'eggs'], ['milk']]);
check('captureItems: the model groups a separator-less dictation; a failure keeps one item', [await captureItems('milk bread peanut butter', async () => ['milk', 'bread', 'peanut butter']), await captureItems('milk bread', async () => { throw new Error('down'); })], [['milk', 'bread', 'peanut butter'], ['milk bread']]);

// A stand-in for the local model: answers a JSON array for the dictation it is sent.
let modelAnswer = (text) => JSON.stringify(text.split(' '));
const model = http.createServer((req, res) => { let raw = ''; req.on('data', (c) => raw += c); req.on('end', () => { const text = JSON.parse(raw).messages.at(-1).content; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: modelAnswer(text) } }] })); }); });
await new Promise((r) => model.listen(0, '127.0.0.1', r));
const modelUrl = `http://127.0.0.1:${model.address().port}`;
const splitter = createDictationSplitter({ endpoint: modelUrl, timeout: 2000 });
check('the splitter accepts the model grouping', await splitter('milk bread'), ['milk', 'bread']);
modelAnswer = () => '["milk", "bread", "eggs"]';
check('...and rejects invented words', await splitter('milk bread').then(() => 'accepted', (e) => e.message), 'model changed the words');
modelAnswer = (text) => '```json\n' + JSON.stringify(text.split(' ')) + '\n```';
check('...fences tolerated', await splitter('a b'), ['a', 'b']);
modelAnswer = (text) => {
  if (!text.includes('Request: ')) return JSON.stringify(text.split(' ')); // the dictation splitter
  const request = /Request: (.*)$/s.exec(text)?.[1] ?? '';
  const cards = JSON.parse(/Cards: (\[.*?\])\n/s.exec(text)?.[1] ?? '[]');
  const id = (title) => cards.find((c) => c.title === title)?.id ?? null;
  if (request === 'add carrots and olive oil to pantry') return JSON.stringify({ action: 'add_items', card: id('pantry'), items: ['carrots', 'olive oil'] });
  if (request === 'rename pantry to shopping') return JSON.stringify({ action: 'rename', card: id('pantry'), title: 'shopping' });
  if (request === 'add a note to shopping: use the loyalty card') return JSON.stringify({ action: 'notes', card: id('shopping'), notes: 'use the loyalty card' });
  if (request === 'remind me about shopping') return JSON.stringify({ action: 'remind', card: id('shopping') });
  if (request === 'add a checklist pantry with milk and eggs') return JSON.stringify({ action: 'create', card: null, title: 'pantry', items: ['milk', 'eggs'] });
  if (request === 'add some items to shopping') return JSON.stringify({ action: 'add_items', card: id('shopping'), items: [], needsItems: true });
  if (request === 'make a checklist called trip') return JSON.stringify({ action: 'create', card: null, title: 'trip', items: [], needsItems: true });
  return JSON.stringify({ action: 'create', card: null, title: request, items: [] });
};
check('private addresses are refused for shared links', [privateAddress('10.1.1.1'), privateAddress('127.0.0.1'), privateAddress('169.254.1.1'), privateAddress('::1'), privateAddress('::ffff:192.168.1.1'), privateAddress('8.8.8.8'), privateAddress('2a00:1450::1'), privateAddress('::ffff:7f00:1'), privateAddress('::ffff:808:808')], [true, true, true, true, true, false, false, true, false]);
{
  const drip = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<html><head>'); setInterval(() => res.write(' '), 200).unref(); });
  await new Promise((r) => drip.listen(0, '127.0.0.1', r));
  const t0 = Date.now();
  check('a slow-drip page gives up at the deadline', [await pageTitle(`http://127.0.0.1:${drip.address().port}/`, { timeout: 500, allowLocal: true }), Date.now() - t0 < 2000], ['', true]);
  drip.close();
}
const page = http.createServer((req, res) => { res.writeHead(req.url === '/go' ? 302 : 200, req.url === '/go' ? { location: '/article' } : { 'content-type': 'text/html; charset=utf-8' }); res.end(req.url === '/go' ? '' : '<html><head><title>  How to &amp; why: Kanban\n boards </title></head><body>x</body></html>'); });
await new Promise((r) => page.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${page.address().port}`;

try {
  server = await startServer('server.js', { env: { DATA_DIR: dir, TODOS_USER: 'owner', TODOS_PASS: 'test-owner-password', API_TOKEN: 'test-api-token', APP_URL: 'https://todos.example', TODOS_AI_URL: modelUrl, TODOS_FETCH_LOCAL: '1' } });
  const request = async (route, { user, method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(server.base + route, { method, headers: { ...(user ? { Cookie: user } : {}), ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const type = res.headers.get('content-type') || '';
    return { res, data: /json/.test(type) ? await res.clone().json() : /text\/plain/.test(type) ? await res.clone().text() : null };
  };
  const login = async (username, password) => { const { res } = await request('/kanban/login', { method: 'POST', body: { username, password } }); check(`login ${username}`, res.status, 200); return res.headers.getSetCookie()[0].split(';')[0]; };
  const tokenOf = (username) => Object.entries(JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8')).shortcuts).find(([, s]) => s.user === username)?.[0];
  const capture = (token, body, accept) => request('/kanban/capture', { method: 'POST', body, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(accept ? { Accept: accept } : {}) } });

  check('settings need a session', (await request('/kanban/shortcuts')).res.status, 401);
  const owner = await login('owner', 'test-owner-password');
  const before = await request('/kanban/shortcuts', { user: owner });
  check('Siri is off at first; two shortcuts are offered, without keys yet', [before.data.enabled, before.data.shortcuts.map((s) => s.kind), before.data.shortcuts[0].url], [false, ['todo', 'send'], 'https://todos.example/kanban/shortcuts/todo.shortcut']);
  check('no file before setup', (await request('/kanban/shortcuts/todo.shortcut', { user: owner })).res.status, 404);
  check('capture without a token is 401', (await capture(null, { title: 'x' })).res.status, 401);
  const on = await request('/kanban/shortcuts', { user: owner, method: 'POST' });
  check('setup turns it on and never returns the token', [on.data.enabled, typeof on.data.created, JSON.stringify(on.data).includes(tokenOf('owner'))], [true, 'number', false]);
  const token = tokenOf('owner');
  check('the token is 32 random bytes base64url', /^[A-Za-z0-9_-]{43}$/.test(token), true);
  check('a session cookie alone cannot capture', (await request('/kanban/capture', { user: owner, method: 'POST', body: { title: 'x' } })).res.status, 401);

  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const nowIso = new Date(now.getTime() + offset * 60000).toISOString().replace(/\.\d{3}Z$/, '') + `${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
  const todo = await capture(token, { title: 'Water the plants tomorrow at 9.', now: nowIso });
  const tomorrow9 = new Date(now); tomorrow9.setDate(now.getDate() + 1); tomorrow9.setHours(9, 0, 0, 0);
  check('a todo with a spoken time: title cleaned, reminder tomorrow 09:00 local', [todo.res.status, todo.data.ok, todo.data.title, todo.data.remindAt, todo.data.items], [200, true, 'Water the plants', tomorrow9.toISOString(), []]);
  const list = await capture(token, { title: 'Groceries', items: 'milk, eggs and bread', now: nowIso }, 'text/plain');
  check('a list answers Siri in plain text', [list.res.status, list.res.headers.get('content-type'), list.data], [200, 'text/plain; charset=utf-8', 'Added “Groceries” with 3 items: milk, eggs, bread.']);
  const dictated = await capture(token, { title: 'Shopping', items: 'Milk bread chicken potatoes.' });
  check('a dictation without separators is split by the model', dictated.data.items, ['Milk', 'bread', 'chicken', 'potatoes']);
  // One spoken sentence: create, add items, rename, note, remind.
  const say = (sentence, accept) => capture(token, { say: sentence, now: nowIso }, accept);
  const spoken1 = await say('add a checklist pantry with milk and eggs');
  check('spoken: a new checklist', [spoken1.res.status, spoken1.data.action, spoken1.data.title, spoken1.data.items, spoken1.data.said], [200, 'create', 'pantry', ['milk', 'eggs'], 'Added “pantry” with 2 items: milk, eggs.']);
  const spoken2 = await say('add carrots and olive oil to pantry', 'text/plain');
  check('spoken: items added to the existing card, Siri told', [spoken2.res.status, spoken2.data], [200, 'Added 2 items to “pantry”: carrots, olive oil.']);
  const spoken3 = await say('rename pantry to shopping');
  check('spoken: rename', [spoken3.data.action, spoken3.data.title, spoken3.data.said], ['rename', 'shopping', 'Renamed “pantry” to “shopping”.']);
  const spoken4 = await say('add a note to shopping: use the loyalty card');
  check('spoken: a note', [spoken4.data.action, spoken4.data.said], ['notes', 'Added a note to “shopping”: use the loyalty card.']);
  const spoken5 = await say('remind me about shopping tomorrow at 9');
  check('spoken: a reminder on the existing card', [spoken5.data.action, spoken5.data.remindAt, spoken5.data.said.startsWith('Reminder for “shopping” set for')], ['remind', tomorrow9.toISOString(), true]);
  const spoken6 = await say('remind me about shopping', 'text/plain');
  check('spoken: no time → Siri hears the problem, status 200', [spoken6.res.status, spoken6.data], [200, 'I didn\'t catch a time for “shopping”.']);
  check('spoken: the same, as JSON, is a 400', (await say('remind me about shopping')).res.status, 400);
  const asked = await say('add some items to shopping', 'text/plain');
  check('spoken: items wanted but none named → Siri asks', [asked.res.status, asked.data], [200, 'Which items for “shopping”?']);
  const answered = await capture(token, { say: 'add some items to shopping', items: 'bread, cheese and olives', now: nowIso }, 'text/plain');
  check('spoken: the dictated answer lands on the same card', answered.data, 'Added 3 items to “shopping”: bread, cheese, olives.');
  const askedNew = await say('make a checklist called trip');
  check('spoken: a checklist without items asks too', [askedNew.data.ask, askedNew.data.said], ['items', 'Which items for “trip”?']);
  const madeNew = await capture(token, { say: 'make a checklist called trip', items: 'passport charger', now: nowIso });
  check('spoken: ...and is created with the dictated items', [madeNew.data.action, madeNew.data.title, madeNew.data.items], ['create', 'trip', ['passport', 'charger']]);
  const shoppingCard = (await request('/kanban/snapshot', { user: owner })).data.cards.find((c) => c.title === 'shopping');
  check('the spoken changes all landed on one card', [shoppingCard.items.map((i) => i.text), shoppingCard.notes, shoppingCard.remindAt], [['milk', 'eggs', 'carrots', 'olive oil', 'bread', 'cheese', 'olives'], 'use the loyalty card', tomorrow9.toISOString()]);
  // The share sheet: a link gets its page title; text becomes a card; a loopback link is refused for its title.
  const shared1 = await capture(token, { url: `${pageUrl}/go`, text: `${pageUrl}/go` });
  check('shared link: the page title (after a redirect) names the card, the link is attached', [shared1.res.status, shared1.data.title, shared1.data.said], [200, 'How to & why: Kanban boards', 'Saved “How to & why: Kanban boards”.']);
  const sharedCard = (await request('/kanban/snapshot', { user: owner })).data.cards.find((c) => c.id === shared1.data.id);
  check('...a note in Inbox from the share sheet, the link in its markdown body', [sharedCard.kind, sharedCard.via, sharedCard.titleBy, sharedCard.links, sharedCard.notes], ['note', 'share', 'auto', undefined, `[How to & why: Kanban boards](${pageUrl}/go)`]);
  const shared2 = await capture(token, { text: 'Call Dan about the roof\nHe said Tuesday' });
  check('shared text: first line is the title, the rest notes', [shared2.data.title, (await request('/kanban/snapshot', { user: owner })).data.cards.find((c) => c.id === shared2.data.id).notes], ['Call Dan about the roof', 'He said Tuesday']);
  check('shared nothing is 400', (await capture(token, { text: '' })).res.status, 400);
  const snap = (await request('/kanban/snapshot', { user: owner })).data;
  const groceries = snap.cards.find((c) => c.title === 'Groceries');
  const plants = snap.cards.find((c) => c.title === 'Water the plants');
  check('a list without a time is a note in Inbox; a spoken time makes a to do with the reminder', [groceries.items.map((i) => [i.text, i.done]), groceries.kind, groceries.via, plants.kind, plants.status, plants.remindAt], [[['milk', false], ['eggs', false], ['bread', false]], 'note', 'siri', undefined, 'todo', tomorrow9.toISOString()]);
  check('bad bodies answer 400', [(await capture(token, { title: '' })).res.status, (await capture(token, { title: 'x', remindAt: 'soon' })).data.error], [400, "couldn't understand the reminder time"]);

  // Another account captures into its own room only.
  const shared = (await request('/kanban/rooms', { user: owner, method: 'POST', body: { name: 'Household' } })).data.room;
  const invite = new URL((await request('/kanban/invite', { user: owner, method: 'POST', body: { room: shared.id } })).data.url).searchParams.get('invite');
  const reg = await request('/kanban/register', { method: 'POST', body: { username: 'partner', password: 'partner-password', token: invite } });
  const partner = reg.res.headers.getSetCookie()[0].split(';')[0];
  await request('/kanban/shortcuts', { user: partner, method: 'POST' });
  const ptoken = tokenOf('partner');
  check('each user has their own token', ptoken !== token && !!ptoken, true);
  await capture(ptoken, { title: 'Partner thing' });
  const partnerRoom = (await request('/kanban/session', { user: partner })).data.personalRoom;
  check('the partner card is in the partner room, not on the owner board', [(await request('/kanban/snapshot', { user: partner, headers: { 'X-Todos-Room': partnerRoom } })).data.cards.some((c) => c.title === 'Partner thing'), (await request('/kanban/snapshot', { user: owner })).data.cards.some((c) => c.title === 'Partner thing')], [true, false]);

  // Files: the install links carry a 10-minute key, so a phone browser without the cookie can fetch them.
  const links = (await request('/kanban/shortcuts', { user: owner })).data.shortcuts;
  const key = new URL(links[0].url).searchParams.get('key');
  check('install links carry a key, the same for both files', [/^[A-Za-z0-9_-]{43}$/.test(key), new URL(links[1].url).searchParams.get('key')], [true, key]);
  check('a wrong or missing key without a session is 401', [(await request('/kanban/shortcuts/todo.shortcut')).res.status, (await request(`/kanban/shortcuts/todo.shortcut?key=${'B'.repeat(43)}`)).res.status], [401, 401]);
  check('the key cannot reach the settings routes', (await request(`/kanban/shortcuts?key=${key}`)).res.status, 401);
  const file = await request(`/kanban/shortcuts/todo.shortcut?key=${key}`);
  if (signingAvailable()) {
    const bytes = Buffer.from(await file.res.arrayBuffer());
    check('the signed shortcut downloads as a file', [file.res.status, file.res.headers.get('content-type'), file.res.headers.get('content-disposition'), bytes.length > 1000], [200, 'application/octet-stream', 'attachment; filename="Update my board.shortcut"', true]);
  } else check('without macOS signing the file answers 503', file.res.status, 503);
  check('an unknown shortcut is 404', (await request('/kanban/shortcuts/nope.shortcut', { user: owner })).res.status, 404);

  // Replace and revoke.
  await request('/kanban/shortcuts', { user: owner, method: 'POST' });
  check('setting up again replaces the token: the old shortcut stops working', [(await capture(token, { title: 'x' })).res.status, (await capture(tokenOf('owner'), { title: 'x' })).res.status], [401, 200]);
  check('new shortcuts end the earlier download key', (await request(`/kanban/shortcuts/todo.shortcut?key=${key}`)).res.status, 401);
  const key2 = new URL((await request('/kanban/shortcuts', { user: owner })).data.shortcuts[0].url).searchParams.get('key');
  const off = await request('/kanban/shortcuts', { user: owner, method: 'DELETE' });
  check('turning off ends the download key too', (await request(`/kanban/shortcuts/todo.shortcut?key=${key2}`)).res.status, 401);
  check('turning Siri off', [off.data.enabled, tokenOf('owner'), (await capture(ptoken, { title: 'still partner' })).res.status], [false, undefined, 200]);

  // Limits.
  for (let i = 0; i < 10; i++) await capture('A'.repeat(43), { title: 'x' });
  check('ten wrong tokens lock captures from that address', (await capture(ptoken, { title: 'x' })).res.status, 429);
} finally {
  if (server) await stopServer(server.child ?? server);
  model.close();
  page.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`${checks} checks passed`);
