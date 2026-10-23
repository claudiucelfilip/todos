// Reminders: the server scheduler against a stub ntfy (never ntfy.sh). Due / not due /
// already sent / re-armed / 12 h cutoff / retry cap / archived or deleted skipped, the
// topic file, the notify endpoints, and remindAt + replace on the external API.
// Run: `npm run test:reminders`.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { freePort, startServer, stopServer } from './test-server.mjs';
import { dueAt as dueOf, nextRemind } from '../shared/repeat.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('  ok    ' + name);
  else { failures++; console.log('  FAIL ' + name + ' ' + extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- stub ntfy --------------------------------------------------------------------------
const pushes = [];
let failTitles = /FAIL/;
const ntfy = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    // ntfy JSON publishing: POST <server>/ with { topic, title, message, tags, priority, click, actions }.
    let json = null;
    try { json = JSON.parse(body); } catch { /* not JSON */ }
    const title = json?.title ?? decodeTitle(String(req.headers['title'] || ''));
    pushes.push({ path: req.url, method: req.method, headers: req.headers, json, title, body: json?.message ?? body, at: Date.now() });
    if (failTitles.test(title)) { res.writeHead(500); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"x"}');
  });
});
function decodeTitle(h) {
  const m = h.match(/^=\?UTF-8\?B\?(.+)\?=$/i);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : h;
}
const NTFY_PORT = await freePort();
await new Promise((r) => ntfy.listen(NTFY_PORT, '127.0.0.1', r));
const NTFY = `http://127.0.0.1:${NTFY_PORT}`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-remind-'));
const TOKEN = 'rt-' + Math.random().toString(36).slice(2, 8);
let logs = '';
const boot = async (port) => {
  const h = await startServer(path.join(ROOT, 'server.js'), { port, env: { API_TOKEN: TOKEN, DATA_DIR: dataDir, NTFY_SERVER: NTFY, REMINDER_TICK_MS: '120', TODOS_USER: 'demo', TODOS_PASS: 'pw', APP_URL: 'https://todos.example' } });
  logs += h.logs();
  h.child.stdout.on('data', (d) => (logs += d));
  h.child.stderr.on('data', (d) => (logs += d));
  return h;
};
let srv = await boot();
const BASE = srv.base;
const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
const iso = (ms) => new Date(Date.now() + ms).toISOString();
let n = 0;
const card = (id, title, over = {}) => ({ id, title, notes: '', status: 'todo', order: 0, items: [], labels: [], createdAt: iso(-60000), updatedAt: iso(-60000), completedAt: null, archivedAt: null, someday: false, repeat: false, remindAt: null, remindedAt: null, ...over });
const push = (actions) => fetch(`${BASE}/kanban/push`, { method: 'POST', headers: auth, body: JSON.stringify({ deviceId: 'D', actions: actions.map((a) => ({ id: 'a' + ++n, deviceId: 'D', ts: new Date().toISOString(), ...a })) }) });
const put = (c) => push([{ type: 'card.put', payload: { card: c } }]);
const snap = async () => (await (await fetch(`${BASE}/kanban/snapshot`, { headers: auth })).json()).cards;
const cardOf = async (id) => (await snap()).find((c) => c.id === id);
const pushesFor = (title) => pushes.filter((p) => p.title === title);

try {
  const topicFile = path.join(dataDir, 'ntfy-topic');
  const topic = fs.readFileSync(topicFile, 'utf8').trim();
  check('the topic file is "todos-" + 16 hex, mode 0600', /^todos-[0-9a-f]{16}$/.test(topic) && (fs.statSync(topicFile).mode & 0o777) === 0o600, topic);

  // due / not due / archived / deleted
  const oddUrl = 'https://example.com/list?a=1,2;b=3&c="x"';
  await put(card('due', 'Buy milk', { notes: 'Lidl on the way\nsecond line', remindAt: iso(-1000), links: [{ title: 'List', url: oddUrl }] }));
  await put(card('later', 'Not yet', { remindAt: iso(3600000) }));
  await put(card('silent', 'Scheduled without push', { remindAt: iso(-1000), notify: false }));
  await put(card('arch', 'Archived one', { remindAt: iso(-1000), status: 'done', archivedAt: iso(-500), completedAt: iso(-600) }));
  await put(card('gone', 'Deleted one', { remindAt: iso(-1000) }));
  await push([{ type: 'card.delete', payload: { id: 'gone' } }]);
  await sleep(700);
  const p = pushesFor('Buy milk');
  const j = p[0]?.json ?? {};
  check('a due reminder is published once as ntfy JSON to the server root, for the topic', p.length === 1 && p[0].path === '/' && p[0].method === 'POST' && j.topic === topic, JSON.stringify(pushes.map((x) => [x.path, x.title])));
  check('push fields: title, tags, priority, click deep link', j.title === 'Buy milk' && JSON.stringify(j.tags) === '["alarm_clock"]' && j.priority === 4 && j.click === 'https://todos.example/#card/due', JSON.stringify(j));
  check('push message is the first line of the notes', j.message === 'Lidl on the way');
  check('a link with "," and ";" survives intact as a view action', JSON.stringify(j.actions) === JSON.stringify([{ action: 'view', label: 'Open link', url: oddUrl }]), JSON.stringify(j.actions));
  const due = await cardOf('due');
  check('remindedAt is written through the log (devices see it)', !!due.remindedAt && due.remindedAt >= due.remindAt);
  const log = (await (await fetch(`${BASE}/kanban/pull?since=0`, { headers: auth })).json()).actions;
  check('...as a card.set from device "server"', log.some((a) => a.type === 'card.set' && a.payload.id === 'due' && a.deviceId === 'server' && a.payload.fields.remindedAt));
  check('a future reminder is not sent', pushesFor('Not yet').length === 0 && !(await cardOf('later')).remindedAt);
  check('a silent scheduled card keeps its time without a push', pushesFor('Scheduled without push').length === 0 && (await cardOf('silent')).notify === false && !(await cardOf('silent')).remindedAt);
  await push([{ type: 'card.set', payload: { id: 'silent', fields: { notify: true } } }]);
  await sleep(300);
  check('turning notifications on sends the pending reminder', pushesFor('Scheduled without push').length === 1);
  check('archived and deleted cards are skipped', pushesFor('Archived one').length === 0 && pushesFor('Deleted one').length === 0);
  await sleep(500);
  check('an already sent reminder is not sent again', pushesFor('Buy milk').length === 1);

  // a changed remindAt re-arms (the device sets a new time; remindedAt cleared)
  await push([{ type: 'card.set', payload: { id: 'due', fields: { remindAt: iso(-200), remindedAt: null } } }]);
  await sleep(600);
  check('changing remindAt re-arms: sent again', pushesFor('Buy milk').length === 2);

  // body fallback + non-ASCII title
  await put(card('plain', 'Cumpărături ☕', { remindAt: iso(-1000) }));
  await sleep(600);
  const pl = pushesFor('Cumpărături ☕');
  check('a non-ASCII title arrives intact; message falls back to "Reminder"; no actions without links', pl.length === 1 && pl[0].body === 'Reminder' && !pl[0].json?.actions);

  // the 12 h cutoff
  await put(card('late13', 'Thirteen hours late', { remindAt: iso(-13 * 3600000) }));
  await put(card('late11', 'Eleven hours late', { remindAt: iso(-11 * 3600000) }));
  await sleep(600);
  check('more than 12 h late: marked reminded without a push', pushesFor('Thirteen hours late').length === 0 && !!(await cardOf('late13')).remindedAt);
  check('less than 12 h late: still sent', pushesFor('Eleven hours late').length === 1);

  // Someday: paused while parked; resumes when moved out in time; missed (never late) otherwise
  await put(card('sd-due', 'Parked and due', { someday: true, remindAt: iso(-1000) }));
  await put(card('sd-soon', 'Parked, due soon', { someday: true, remindAt: iso(900) }));
  await sleep(1300);
  check('a due reminder on a Someday card is not sent', pushesFor('Parked and due').length === 0 && pushesFor('Parked, due soon').length === 0);
  const sdDue = await cardOf('sd-due');
  check('...and the card keeps remindAt, with no remindedAt', !!sdDue.remindAt && sdDue.remindedAt === null);
  await put(card('sd-resume', 'Parked then resumed', { someday: true, remindAt: iso(900) }));
  await sleep(200);
  await push([{ type: 'card.set', payload: { id: 'sd-resume', fields: { someday: false } } }]);
  await sleep(1200);
  check('moved out while still in the future: armed again and sent on time', pushesFor('Parked then resumed').length === 1);
  // The app's missed rule: leaving after the time stamps remindedAt = remindAt in the same write.
  await push([{ type: 'card.set', payload: { id: 'sd-due', fields: { someday: false, remindedAt: sdDue.remindAt } } }]);
  await sleep(500);
  check('moved out after the time (missed stamp): never sent late', pushesFor('Parked and due').length === 0 && (await cardOf('sd-due')).remindedAt === sdDue.remindAt);
  // The server applies the same rule when it moves a card out (external status).
  const extTok = { 'Content-Type': 'application/json', Authorization: `Bearer ${fs.readFileSync(path.join(dataDir, 'external-token'), 'utf8').trim()}` };
  const created = await (await fetch(`${BASE}/kanban/external/card`, { method: 'POST', headers: extTok, body: JSON.stringify({ key: 'sd:ext', title: 'Parked external' }) })).json();
  const sdAt = iso(-500);
  await push([{ type: 'card.set', payload: { id: created.id, fields: { someday: true, remindAt: sdAt } } }]);
  await sleep(400);
  const moved = await (await fetch(`${BASE}/kanban/external/status`, { method: 'POST', headers: extTok, body: JSON.stringify({ key: 'sd:ext', status: 'doing' }) })).json();
  await sleep(500);
  const extCard = await cardOf(created.id);
  check('external status out of Someday after the time: missed, not sent', moved.changed && !extCard.someday && extCard.remindedAt === sdAt && pushesFor("Parked external").length === 0, JSON.stringify(extCard));
  check('a sent reminder is stamped strictly after its time (so it never reads as missed)', (await cardOf('due')).remindedAt > (await cardOf('due')).remindAt);

  // retry cap
  await put(card('flaky', 'FAIL always', { remindAt: iso(-1000) }));
  await sleep(1400);
  const tries = pushesFor('FAIL always').length;
  check('a failing push is retried each tick, at most 5 attempts, then marked reminded', tries === 5 && !!(await cardOf('flaky')).remindedAt, String(tries));
  await sleep(400);
  check('...and not retried after that', pushesFor('FAIL always').length === 5);
  check('the failure is logged; the topic never is', /reminder/i.test(logs) && !logs.includes(topic));

  // repeating reminders: the anchor stays, a push stamps remindedAt, the next slot after it is due
  const dueMs = (c) => Date.parse(dueOf(c));
  const at0 = iso(-1000);
  await put(card('rep', 'Take the pills', { remindAt: at0, remindEvery: 'day' }));
  await sleep(700);
  let rep = await cardOf('rep');
  check('a repeating reminder is sent once when due', pushesFor('Take the pills').length === 1);
  check('...the anchor stays, remindedAt is stamped, and the next slot is ahead', rep.remindAt === at0 && rep.remindedAt > at0 && rep.remindEvery === 'day' && dueOf(rep) === nextRemind(at0, 'day', Date.parse(rep.remindedAt)) && dueMs(rep) > Date.now(), JSON.stringify(rep));
  await sleep(500);
  check('...and it is not sent again before that slot', pushesFor('Take the pills').length === 1);
  // the next slot arrives (here: the anchor moved so that a slot has just passed): sent again
  const at1 = new Date(Date.now() - 86400000 - 500).toISOString();
  await push([{ type: 'card.set', payload: { id: 'rep', fields: { remindAt: at1, remindedAt: new Date(Date.now() - 86400000 + 5000).toISOString() } } }]);
  await sleep(700);
  rep = await cardOf('rep');
  check('the next slot is sent too, and the one after is ahead', pushesFor('Take the pills').length === 2 && rep.remindAt === at1 && dueMs(rep) > Date.now(), JSON.stringify(rep));
  // hourly: one hour on, or 8:00 after the quiet hours
  const atH = iso(-1000);
  await put(card('nag', 'Call the bank', { remindAt: atH, remindEvery: 'hour' }));
  await sleep(700);
  const nag = await cardOf('nag');
  const h = new Date(dueOf(nag)).getHours();
  check('hourly: sent, next slot within the hour or after the quiet hours', pushesFor('Call the bank').length === 1 && dueMs(nag) > Date.now() && dueMs(nag) - Date.now() <= 11 * 3600000 && h >= 8 && h < 22, dueOf(nag));
  // a one-off already sent that a device switches to repeat (it could not know) is never stuck
  await put(card('late-rep', 'Sent then repeated', { remindAt: iso(-1000) }));
  await sleep(600);
  await push([{ type: 'card.set', payload: { id: 'late-rep', fields: { remindEvery: 'hour' } } }]);
  await sleep(500);
  const lr = await cardOf('late-rep');
  check('a sent one-off switched to repeat is pending at its next slot, not stuck', pushesFor('Sent then repeated').length === 1 && dueMs(lr) > Date.now() && lr.remindEvery === 'hour', JSON.stringify(lr));
  // an offline clear arriving after the push still clears (the server never rewrites remindAt)
  await put(card('off-clear', 'Cleared offline', { remindAt: iso(500), remindEvery: 'day' }));
  const clearedAt = iso(50); // tapped × before the push went out, delivered after it
  await sleep(1000);
  await push([{ type: 'card.set', ts: clearedAt, payload: { id: 'off-clear', fields: { remindAt: null, remindEvery: null } } }]);
  await sleep(400);
  const oc = await cardOf('off-clear');
  check('a clear made before the push (synced after it) stays cleared', pushesFor('Cleared offline').length === 1 && oc.remindAt === null && (oc.remindEvery ?? null) === null, JSON.stringify(oc));
  // a device with a fast clock re-times a reminder (remindedAt: null, stamped "later" than now): one push, not one per tick
  for (const [id, title, every] of [['skew-rep', 'Fast clock repeating', 'hour'], ['skew-once', 'Fast clock one-off', null]]) {
    await put(card(id, title, { remindAt: iso(-90000000), remindedAt: iso(-89000000), remindEvery: every }));
    await push([{ type: 'card.set', ts: iso(60000), payload: { id, fields: { remindAt: iso(300), remindedAt: null } } }]);
    await sleep(1500);
    const sk = await cardOf(id);
    check(`${title}: sent once although the device's write is 60 s "later" (the stamp still wins)`, pushesFor(title).length === 1 && !!sk.remindedAt && (every ? dueMs(sk) > Date.now() : sk.remindedAt > sk.remindAt), `${pushesFor(title).length} ${JSON.stringify([sk.remindAt, sk.remindedAt])}`);
  }
  // a write whose timestamp is not a time is ignored; one from the far future cannot hold a field for ever
  await put(card('bad-ts', 'Bad timestamp', { remindAt: iso(-90000000), remindedAt: iso(-89000000), remindEvery: 'day' }));
  const badRes = await (await push([{ type: 'card.set', ts: 'zzzz', payload: { id: 'bad-ts', fields: { remindAt: iso(300), remindedAt: null } } }])).json();
  await push([{ type: 'card.set', ts: '9999-12-31T23:59:59.999Z', payload: { id: 'bad-ts', fields: { title: 'Far future write' } } }]);
  await push([{ type: 'card.set', ts: '9999-12-31T23:59:59.999Z', payload: { id: 'bad-ts', fields: { remindAt: iso(300), remindedAt: null } } }]);
  await sleep(1500);
  const bt = await cardOf('bad-ts');
  check('a write with a timestamp that is not a time is ignored', badRes.applied === 0);
  check('a write stamped in year 9999: its reminder is sent once and stamped (the server still wins the field)', pushesFor('Far future write').length === 1 && !!bt.remindedAt && dueMs(bt) > Date.now(), `${pushesFor('Far future write').length} ${JSON.stringify([bt.remindAt, bt.remindedAt])}`);
  // a garbage stamp from sync (end of the Date range) never takes the scheduler or the server down
  await put(card('poison', 'Poisoned stamp', { remindAt: iso(-1000), remindEvery: 'day', remindedAt: '+275760-09-13T00:00:00.000Z' }));
  await put(card('after-poison', 'After the poison', { remindAt: iso(300) }));
  await sleep(1000);
  check('a stamp at the end of the Date range: no crash, nothing sent for it, other reminders still go out', pushesFor('Poisoned stamp').length === 0 && pushesFor('After the poison').length === 1 && (await fetch(`${BASE}/healthz`)).ok);
  await push([{ type: 'card.delete', payload: { id: 'poison' } }]);
  // after an outage a repeating reminder is judged by its latest slot: the old ones are dropped, a recent one is sent once
  await put(card('outage', 'Back after an outage', { remindAt: iso(-5 * 86400000 - 2 * 3600000), remindEvery: 'day', remindedAt: iso(-5 * 86400000 - 3600000) }));
  await sleep(700);
  const og = await cardOf('outage');
  check('5 days of missed daily slots, the latest 2 h ago: one push, next slot ahead', pushesFor('Back after an outage').length === 1 && dueMs(og) > Date.now(), `${pushesFor('Back after an outage').length} ${dueOf(og)}`);
  // Done: a repeating reminder rests, and waits for its next slot (never late) when reopened
  await put(card('rep-done', 'Done and repeating', { status: 'done', completedAt: iso(-5000), remindAt: iso(-1000), remindEvery: 'day' }));
  await sleep(600);
  check('a repeating reminder on a Done card is not sent', pushesFor('Done and repeating').length === 0 && (await cardOf('rep-done')).remindedAt === null);
  const rd = await (await fetch(`${BASE}/kanban/external/status?id=rep-done`, { method: 'POST', headers: extTok, body: JSON.stringify({ status: 'todo' }) })).json();
  await sleep(600);
  const reopened = await cardOf('rep-done');
  check('reopened by the server after the time: next slot ahead, never sent late', rd.changed && pushesFor('Done and repeating').length === 0 && dueMs(reopened) > Date.now() && reopened.remindEvery === 'day', JSON.stringify(reopened));
  // back to once on a Done card whose time passed: a single reminder at the upcoming slot, no late push
  await put(card('rep-once', 'Done then once', { status: 'done', completedAt: iso(-5000), remindAt: iso(-1000), remindEvery: 'day' }));
  await fetch(`${BASE}/kanban/external/card?id=rep-once`, { method: 'POST', headers: extTok, body: JSON.stringify({ remindEvery: null }) });
  await sleep(600);
  const ro = await cardOf('rep-once');
  check('repeat switched off on a Done card past its time: no late push, one reminder at the next slot', pushesFor('Done then once').length === 0 && (ro.remindEvery ?? null) === null && Date.parse(ro.remindAt) > Date.now() && ro.remindedAt === null, JSON.stringify(ro));
  // more than 12 h late: skipped to the next slot without a push
  await put(card('rep-late', 'Very late repeating', { remindAt: iso(-13 * 3600000), remindEvery: 'week' }));
  await sleep(600);
  const rl = await cardOf('rep-late');
  check('more than 12 h late: no push, next slot ahead', pushesFor('Very late repeating').length === 0 && dueMs(rl) > Date.now(), JSON.stringify(rl));
  // a failing push gives up after the cap and still moves on
  await put(card('rep-fail', 'FAIL repeating', { remindAt: iso(-1000), remindEvery: 'week' }));
  await sleep(1500);
  const rf = await cardOf('rep-fail');
  check('a push that keeps failing gives up and waits for the next slot', pushesFor('FAIL repeating').length === 5 && dueMs(rf) > Date.now(), `${pushesFor('FAIL repeating').length} ${dueOf(rf)}`);
  // Someday: paused; leaving after the time waits for the next slot instead of reading missed
  await put(card('rep-sd', 'Parked repeating', { someday: true, remindAt: iso(-1000), remindEvery: 'day' }));
  await sleep(500);
  await fetch(`${BASE}/kanban/external/card?id=rep-sd`, { method: 'POST', headers: extTok, body: JSON.stringify({ someday: false }) });
  await sleep(500);
  const rs = await cardOf('rep-sd');
  check('un-parked by the server after the time: next slot ahead, no push', pushesFor('Parked repeating').length === 0 && dueMs(rs) > Date.now() && !rs.someday && rs.remindEvery === 'day', JSON.stringify(rs));

  // missed while down: sent on start when < 12 h late
  await stopServer(srv.child);
  failTitles = /FAIL/;
  const before = pushes.length;
  // Written straight into the data file while the server is down.
  const file = path.join(dataDir, 'kanban.json');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  disk.state.cards['missed'] = card('missed', 'Missed while down', { remindAt: iso(-2 * 3600000) });
  fs.writeFileSync(file, JSON.stringify(disk));
  srv = await boot(srv.port);
  await sleep(300);
  check('a reminder missed while the server was down is sent on start', pushes.slice(before).some((x) => x.title === 'Missed while down'));
  check('the topic survives a restart', fs.readFileSync(topicFile, 'utf8').trim() === topic);

  // settings endpoints
  check('notify-topic needs auth', (await fetch(`${srv.base}/kanban/notify-topic`)).status === 401);
  const basic = { Authorization: 'Basic ' + Buffer.from('demo:pw').toString('base64') };
  const nt = await (await fetch(`${srv.base}/kanban/notify-topic`, { headers: basic })).json();
  check('notify-topic returns the topic and the subscribe URL', nt.topic === topic && nt.subscribeUrl === `${NTFY}/${topic}`, JSON.stringify(nt));
  const before2 = pushes.length;
  const tr = await fetch(`${srv.base}/kanban/notify-test`, { method: 'POST', headers: basic });
  check('notify-test sends a push', tr.status === 200 && pushes.length === before2 + 1 && pushes[pushes.length - 1].json?.topic === topic);
  check('notify-test needs auth', (await fetch(`${srv.base}/kanban/notify-test`, { method: 'POST' })).status === 401);

  // precise delivery: a slow tick (3 s) still delivers within ~1 s of the time
  await stopServer(srv.child);
  const slow = await startServer(path.join(ROOT, 'server.js'), { port: srv.port, env: { API_TOKEN: TOKEN, DATA_DIR: dataDir, NTFY_SERVER: NTFY, REMINDER_TICK_MS: '3000', TODOS_USER: 'demo', TODOS_PASS: 'pw' } });
  srv = slow;
  await sleep(200);
  const dueAt = Date.now() + 1200;
  await put(card('precise', 'On the dot', { remindAt: new Date(dueAt).toISOString() }));
  await sleep(2200);
  const pp = pushesFor('On the dot');
  check('a reminder due between ticks is pushed within ~1 s of its time (not at the next tick)', pp.length === 1 && pp[0].at >= dueAt && pp[0].at - dueAt < 1000, pp.length ? `${pp[0].at - dueAt} ms` : 'not sent');
  await sleep(1500);
  check('...and only once', pushesFor('On the dot').length === 1);

  // external API: remindAt on create and update; replace
  const ext = { 'Content-Type': 'application/json', Authorization: `Bearer ${fs.readFileSync(path.join(dataDir, 'external-token'), 'utf8').trim()}` };
  const post = (b, qs = '') => fetch(`${srv.base}/kanban/external/card${qs}`, { method: 'POST', headers: ext, body: JSON.stringify(b) });
  const future = iso(86400000);
  const c1 = await (await post({ key: 'r:1', title: 'From capture', notes: 'n1', remindAt: future })).json();
  check('external create accepts remindAt', c1.created && (await cardOf(c1.id)).remindAt === future);
  const later = iso(2 * 86400000);
  await post({ key: 'r:1', title: 'ignored', remindAt: later });
  let e1 = await cardOf(c1.id);
  check('external update can set a reminder (title untouched without replace)', e1.remindAt === later && e1.remindedAt === null && e1.title === 'From capture');
  await post({ key: 'r:1', title: 'New title', notes: 'new notes', replace: ['title', 'notes'] });
  e1 = await cardOf(c1.id);
  check('replace: ["title","notes"] overwrites just those fields', e1.title === 'New title' && e1.notes === 'new notes' && e1.remindAt === later);
  await post({ key: 'r:1', title: 'Only title', notes: 'not this', replace: ['title'] });
  e1 = await cardOf(c1.id);
  check('replace: ["title"] leaves notes alone', e1.title === 'Only title' && e1.notes === 'new notes');
  check('replace with an unknown field is 400', (await post({ key: 'r:1', title: 'x', replace: ['status'] })).status === 400);
  check('replace that is not an array is 400', (await post({ key: 'r:1', title: 'x', replace: 'title' })).status === 400);
  check('an invalid remindAt is 400', (await post({ key: 'r:2', title: 'x', remindAt: 'soon' })).status === 400);
  await post({ key: 'r:1', title: 'x', remindAt: null });
  check('remindAt: null on update clears the reminder', (await cardOf(c1.id)).remindAt === null);

  // the external API: remindEvery
  const c3 = await (await post({ key: 'r:3', title: 'Standup', remindAt: future, remindEvery: 'weekday' })).json();
  check('external create accepts remindEvery', (await cardOf(c3.id)).remindEvery === 'weekday');
  await post({ key: 'r:3', title: 'x', remindEvery: 'week' });
  check('external update changes remindEvery (time kept)', (await cardOf(c3.id)).remindEvery === 'week' && (await cardOf(c3.id)).remindAt === future);
  check('an unknown remindEvery is 400', (await post({ key: 'r:3', title: 'x', remindEvery: 'yearly' })).status === 400);
  check('remindEvery without a reminder time is 400 on create', (await post({ key: 'r:4', title: 'No time', remindEvery: 'day' })).status === 400);
  check('...and on a card that has none', (await post({ remindEvery: 'day' }, `?id=${c1.id}`)).status === 400 && ((await cardOf(c1.id)).remindEvery ?? null) === null);
  const rows = (await (await fetch(`${BASE}/kanban/external/cards?q=Standup`, { headers: extTok })).json()).cards;
  check('the cards list carries remindEvery and the next time due', rows?.[0]?.remindEvery === 'week' && rows?.[0]?.remindNext === future, JSON.stringify(rows?.[0]));
  await fetch(`${srv.base}/kanban/external/status?id=${c3.id}`, { method: 'POST', headers: ext, body: JSON.stringify({ status: 'done' }) });
  const restRow = (await (await fetch(`${srv.base}/kanban/external/cards?q=Standup&status=done`, { headers: ext })).json()).cards?.[0];
  check('...but no next time while the card rests in Done', restRow?.remindEvery === 'week' && !('remindNext' in restRow), JSON.stringify(restRow));
  await fetch(`${srv.base}/kanban/external/status?id=${c3.id}`, { method: 'POST', headers: ext, body: JSON.stringify({ status: 'todo' }) });
  await post({ key: 'r:3', title: 'x', remindEvery: null });
  check('remindEvery: null goes back to once', ((await cardOf(c3.id)).remindEvery ?? null) === null && (await cardOf(c3.id)).remindAt === future);
  await post({ key: 'r:3', title: 'x', remindEvery: 'day' });
  await post({ key: 'r:3', title: 'x', remindAt: null });
  check('clearing the reminder clears the repeat', ((await cardOf(c3.id)).remindEvery ?? null) === null);
  // a leftover repeat on a card without a time (two writes that tied) never revives with a new time
  await push([{ type: 'card.set', payload: { id: c3.id, fields: { remindEvery: 'day' } } }]);
  await post({ key: 'r:3', title: 'x', remindAt: future });
  check('a new reminder starts as once even if a repeat was left behind', (await cardOf(c3.id)).remindAt === future && ((await cardOf(c3.id)).remindEvery ?? null) === null);
  // turning repeat on for a reminder already sent: pending again at its next slot, anchor kept
  const dueBefore = await cardOf('due');
  await post({ remindEvery: 'day' }, '?id=due');
  const dueRep = await cardOf('due');
  check('repeat on an already sent reminder: pending again at its next slot', dueRep.remindAt === dueBefore.remindAt && Date.parse(dueOf(dueRep)) > Date.now() && dueRep.remindEvery === 'day', JSON.stringify(dueRep));
} catch (e) {
  failures++;
  console.log('  FAIL exception ' + (e?.stack ?? e));
} finally {
  await stopServer(srv.child);
  ntfy.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
