// External API (/kanban/external/*) against the REAL server.js with a temp
// DATA_DIR: auth, create, idempotent update by key, status by key and slackTs,
// labels created once, and that devices receive it all on pull. Run: `npm run test:external`.
import { freePort, startServer, stopServer } from './test-server.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { emptyState, applyAction, snapshot } from '../shared/merge.mjs';

// Node 24's undici can throw `setTypeOfService EINVAL` from a socket it is tearing down
// (macOS). It is not a test outcome: note it and carry on instead of crashing the gate.
const benign = (e) => /setTypeOfService/.test(String(e?.message ?? e));
process.on('uncaughtException', (e) => { if (benign(e)) console.log('  note  ignored undici setTypeOfService EINVAL'); else { console.log('  FAIL uncaught ' + (e?.stack ?? e)); process.exit(1); } });
process.on('unhandledRejection', (e) => { if (benign(e)) console.log('  note  ignored undici setTypeOfService EINVAL'); else { console.log('  FAIL unhandled ' + (e?.stack ?? e)); process.exit(1); } });
const baseFetch = globalThis.fetch;
// A request that hit the same socket bug is retried once.
globalThis.fetch = async (...a) => {
  try { return await baseFetch(...a); } catch (e) { if (benign(e) || benign(e?.cause)) return baseFetch(...a); throw e; }
};

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-ext-'));
const TOKEN = 'device-token-' + Math.random().toString(36).slice(2, 8);
const USER = 'demo';
const PASS = 'correct horse ' + Math.random().toString(36).slice(2, 8);
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('  ok    ' + name);
  else { failures++; console.log('  FAIL ' + name + ' ' + extra); }
};

let logs = '';
async function boot() {
  const h = await startServer(path.join(ROOT, 'server.js'), { port: PORT, env: { API_TOKEN: TOKEN, DATA_DIR: dataDir, TODOS_USER: USER, TODOS_PASS: PASS } });
  logs += h.logs();
  h.child.stdout.on('data', (d) => { logs += d; });
  h.child.stderr.on('data', (d) => { logs += d; process.stdout.write('[srv] ' + d); });
  return h.child;
}
const stop = (srv) => stopServer(srv);

let server = await boot();
try {
  const tokenFile = path.join(dataDir, 'external-token');
  const EXT = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  check('the external token is generated as 32 random bytes hex', /^[0-9a-f]{64}$/.test(EXT));
  check('the token file is mode 0600', (fs.statSync(tokenFile).mode & 0o777) === 0o600, (fs.statSync(tokenFile).mode & 0o777).toString(8));
  check('the token is never logged', !logs.includes(EXT));

  const ext = { 'Content-Type': 'application/json', Authorization: `Bearer ${EXT}` };
  const post = (p, body, headers = ext) => fetch(BASE + p, { method: 'POST', headers, body: JSON.stringify(body) });

  // --- auth -------------------------------------------------------------------------
  const noAuth = await post('/kanban/external/card', { key: 'k', title: 't' }, { 'Content-Type': 'application/json' });
  check('401 without a token', noAuth.status === 401);
  const wrong = await post('/kanban/external/card', { key: 'k', title: 't' }, { ...ext, Authorization: 'Bearer nope' });
  check('401 with a wrong token', wrong.status === 401);
  check('the external token does not open device sync', (await fetch(`${BASE}/kanban/pull?since=0`, { headers: ext })).status === 401);

  // --- validation -------------------------------------------------------------------
  check('400 without key', (await post('/kanban/external/card', { title: 't' })).status === 400);
  check('400 without title', (await post('/kanban/external/card', { key: 'k' })).status === 400);
  check('400 on a non-http link', (await post('/kanban/external/card', { key: 'k', title: 't', links: [{ title: 'x', url: 'javascript:alert(1)' }] })).status === 400);
  const badStatus = await post('/kanban/external/card', { key: 'k', title: 't', status: 'later' });
  check('400 on a bad status, with an error message', badStatus.status === 400 && typeof (await badStatus.json()).error === 'string');

  // --- create -----------------------------------------------------------------------
  const sherlock = { id: 'sherlock', name: 'Sherlock', color: '#7C5CFF' };
  const wiki = { id: 'wiki', name: 'Wiki', color: '#2F80ED' };
  const r1 = await post('/kanban/external/card', {
    key: 'wiki:page-1', title: 'Read the capture', notes: 'From the wiki',
    links: [{ title: 'Page', url: 'https://wiki.test/page-1' }], labels: [sherlock, wiki], slackTs: '1700000000.0001', slackChannel: 'C1',
  });
  const b1 = await r1.json();
  check('200 with the external token; created', r1.status === 200 && b1.ok && b1.created === true && typeof b1.id === 'string', JSON.stringify(b1));
  const got = await (await fetch(`${BASE}/kanban/external/card?key=${encodeURIComponent('wiki:page-1')}`, { headers: ext })).json();
  const c = got.card;
  check('GET by key returns the card', got.ok && c.id === b1.id);
  check('a plain card in To do with labels, links and ext', c.status === 'todo' && c.items.length === 0 && c.labels.join() === 'sherlock,wiki,workflow:todo' && c.links.length === 1 && c.ext.key === 'wiki:page-1' && c.ext.slackTs === '1700000000.0001' && c.ext.slackChannel === 'C1', JSON.stringify(c));
  check('GET for an unknown key is 404', (await fetch(`${BASE}/kanban/external/card?key=nope`, { headers: ext })).status === 404);

  const r2 = await (await post('/kanban/external/card', { key: 'wiki:page-2', title: 'Second', labels: [wiki] })).json();
  const c2 = (await (await fetch(`${BASE}/kanban/external/card?key=wiki:page-2`, { headers: ext })).json()).card;
  check('a new card lands at the top of its column', c2.order < c.order, `${c2.order} vs ${c.order}`);

  // --- idempotent update --------------------------------------------------------------
  const r3 = await (await post('/kanban/external/card', {
    key: 'wiki:page-1', title: 'Changed title', notes: 'changed', status: 'done',
    links: [{ title: 'Page again', url: 'https://wiki.test/page-1' }, { title: 'Thread', url: 'https://slack.test/t/1' }],
    labels: [{ id: 'wiki', name: 'Renamed by capture', color: '#000000' }], slackTs: '1700000000.0002',
  })).json();
  const u = (await (await fetch(`${BASE}/kanban/external/card?key=wiki:page-1`, { headers: ext })).json()).card;
  check('the same key updates instead of creating', r3.ok && r3.created === false && r3.id === b1.id);
  check('links merge, deduped by url', u.links.map((l) => l.url).join() === 'https://wiki.test/page-1,https://slack.test/t/1', JSON.stringify(u.links));
  check('title and status are untouched on update; notes only gain the new link line', u.title === 'Read the capture' && u.notes === 'From the wiki\n\n[Page](https://wiki.test/page-1)\n[Thread](https://slack.test/t/1)' && u.status === 'todo', JSON.stringify(u.notes));
  check('slackTs is updated', u.ext.slackTs === '1700000000.0002' && u.ext.slackChannel === 'C1');

  // --- status by key and by slackTs ------------------------------------------------------
  const s1 = await (await post('/kanban/external/status', { key: 'wiki:page-1', status: 'doing' })).json();
  check('status by key changes the card', s1.ok && s1.id === b1.id && s1.changed === true);
  const s2 = await (await post('/kanban/external/status', { key: 'wiki:page-1', status: 'doing' })).json();
  check('the same status again is a no-op', s2.ok && s2.changed === false);
  const s3 = await (await post('/kanban/external/status', { slackTs: '1700000000.0002', status: 'done' })).json();
  const d = (await (await fetch(`${BASE}/kanban/external/card?key=wiki:page-1`, { headers: ext })).json()).card;
  check('status by slackTs moves it to Done and stamps completedAt', s3.ok && s3.changed && d.status === 'done' && !!d.completedAt);
  await post('/kanban/external/status', { key: 'wiki:page-1', status: 'todo' });
  const t = (await (await fetch(`${BASE}/kanban/external/card?key=wiki:page-1`, { headers: ext })).json()).card;
  check('leaving Done clears completedAt', t.status === 'todo' && t.completedAt === null);
  check('status for an unknown card is 404', (await post('/kanban/external/status', { key: 'nope', status: 'done' })).status === 404);
  check('status needs key or slackTs', (await post('/kanban/external/status', { status: 'done' })).status === 400);

  // --- devices receive everything through the action log --------------------------------
  const dev = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
  check('the device token also works on external routes', (await fetch(`${BASE}/kanban/external/card?key=wiki:page-1`, { headers: dev })).status === 200);
  const pull = await (await fetch(`${BASE}/kanban/pull?since=0`, { headers: dev })).json();
  const types = new Set(pull.actions.map((a) => a.type));
  check('pull returns the external actions from device "server"', pull.actions.length > 0 && pull.actions.every((a) => a.deviceId === 'server' && typeof a.id === 'string'), JSON.stringify([...types]));
  const labelPuts = pull.actions.filter((a) => a.type === 'label.put');
  check('each label is created once (no overwrite of an existing one)', labelPuts.length === 5 && labelPuts.find((a) => a.payload.label.id === 'wiki').payload.label.name === 'Wiki', JSON.stringify(labelPuts.map((a) => a.payload.label)));
  const replay = emptyState();
  for (const a of pull.actions) applyAction(replay, a);
  const rc = snapshot(replay).cards.find((x) => x.id === b1.id);
  check('replaying the pull on a device reproduces the server card', rc && rc.status === 'todo' && (rc.notes.match(/\]\(https:/g) ?? []).length === 2 && rc.labels.join() === 'sherlock,wiki,workflow:todo' && snapshot(replay).cards.some((x) => x.id === r2.id));
  check('replayed labels match', snapshot(replay).labels.filter((l) => !l.id.startsWith('workflow:')).map((l) => l.name).sort().join() === 'Sherlock,Wiki');

  // --- a link removed on a device is not re-added by a later capture ---------------------
  const before = (await (await fetch(`${BASE}/kanban/external/card?key=wiki:page-1`, { headers: ext })).json()).card;
  check('ext.seenLinks records every delivered url', JSON.stringify(before.ext.seenLinks) === JSON.stringify(['https://wiki.test/page-1', 'https://slack.test/t/1']), JSON.stringify(before.ext));
  await fetch(`${BASE}/kanban/push`, { method: 'POST', headers: dev, body: JSON.stringify({ deviceId: 'A', actions: [{ id: 'rmlink', deviceId: 'A', ts: new Date().toISOString(), type: 'card.set', payload: { id: b1.id, fields: { notes: before.notes.replace('\n[Thread](https://slack.test/t/1)', '') } } }] }) });
  await post('/kanban/external/card', { key: 'wiki:page-1', title: 'x', links: [{ title: 'Thread', url: 'https://slack.test/t/1' }, { title: 'New', url: 'https://wiki.test/new' }] });
  const after = (await (await fetch(`${BASE}/kanban/external/card?key=wiki:page-1`, { headers: ext })).json()).card;
  check('a url the user removed is not re-added; a never-delivered one is', after.links.map((l) => l.url).join() === 'https://wiki.test/page-1,https://wiki.test/new', JSON.stringify(after.links));
  check('seenLinks grows with the new url', after.ext.seenLinks.includes('https://wiki.test/new'));

  // --- a new card in an empty server column still sorts above local-only cards --------
  const empty = await (await post('/kanban/external/card', { key: 'doing:1', title: 'Into Doing', status: 'doing' })).json();
  const d1 = (await (await fetch(`${BASE}/kanban/external/card?key=doing:1`, { headers: ext })).json()).card;
  check('an empty column gets a time-derived order far above any local order', d1.order <= -1e9, String(d1.order));
  await new Promise((r) => setTimeout(r, 1100));
  await post('/kanban/external/card', { key: 'doing:2', title: 'Into Doing later', status: 'doing' });
  const d2 = (await (await fetch(`${BASE}/kanban/external/card?key=doing:2`, { headers: ext })).json()).card;
  check('a later capture sorts above the earlier one', d2.order < d1.order && !!empty.ok);
  await post('/kanban/external/status', { key: 'doing:1', status: 'todo' });
  const moved = (await (await fetch(`${BASE}/kanban/external/card?key=doing:1`, { headers: ext })).json()).card;
  const todoOrders = (await (await fetch(`${BASE}/kanban/snapshot`, { headers: dev })).json()).cards.filter((c) => c.status === 'todo' && c.id !== moved.id).map((c) => c.order);
  check('a status move appends below everything in the column, local cards included', moved.order > Math.max(...todoOrders) && moved.order >= 1e9, String(moved.order));

  // --- a user rename survives a later capture; the token survives a restart ---------------
  await fetch(`${BASE}/kanban/push`, { method: 'POST', headers: dev, body: JSON.stringify({ deviceId: 'A', actions: [{ id: 'ren1', deviceId: 'A', ts: new Date().toISOString(), type: 'label.put', payload: { label: { id: 'wiki', name: 'Docs', color: '#12A6B8' } } }] }) });
  await post('/kanban/external/card', { key: 'wiki:page-3', title: 'Third', labels: [wiki] });
  const snap = await (await fetch(`${BASE}/kanban/snapshot`, { headers: dev })).json();
  check('snapshot includes labels; a user rename is not overwritten by a capture', snap.labels.find((l) => l.id === 'wiki')?.name === 'Docs', JSON.stringify(snap.labels));
  const note = { ...snap.cards.find((c) => c.id === b1.id), id: 'unlabelled-note', ext: { key: 'note:test' }, labels: ['wiki'], workflowVersion: 1, kind: 'note', status: 'todo' };
  await fetch(`${BASE}/kanban/push`, { method: 'POST', headers: dev, body: JSON.stringify({ deviceId: 'A', actions: [{ id: 'note-create', deviceId: 'A', ts: new Date().toISOString(), type: 'card.put', payload: { card: note } }] }) });
  await post('/kanban/external/status', { key: 'note:test', status: 'todo' });
  const movedNote = (await (await fetch(`${BASE}/kanban/external/card?key=note:test`, { headers: ext })).json()).card;
  check('an unlabelled note moves into To do without losing ordinary labels', movedNote.labels.join() === 'wiki,workflow:todo' && movedNote.kind !== 'note');
  await stop(server);
  server = await boot();
  // --- login: session cookie, logout, Basic, Bearer, rate limit ------------------------------
  const login = (body, headers = {}) => fetch(`${BASE}/kanban/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
  check('GET /kanban/session without a cookie is 401', (await fetch(`${BASE}/kanban/session`)).status === 401);
  check('pull without any credentials is 401', (await fetch(`${BASE}/kanban/pull?since=0`)).status === 401);
  const t0 = Date.now();
  const bad = await login({ username: USER, password: 'nope' }, { 'cf-connecting-ip': '10.0.0.1' });
  check('a wrong password is 401 after a small delay, with no cookie', bad.status === 401 && Date.now() - t0 >= 250 && !bad.headers.get('set-cookie'));
  check('a wrong username is 401', (await login({ username: 'someone', password: PASS }, { 'cf-connecting-ip': '10.0.0.1' })).status === 401);
  const ok = await login({ username: USER, password: PASS });
  const sc = ok.headers.get('set-cookie') || '';
  check('login sets the session cookie', ok.status === 200 && (await ok.json()).user === USER && /^todos_session=[^;]+/.test(sc), sc);
  check('the cookie is HttpOnly, SameSite=Lax, Path=/, a year long', /HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc) && /Path=\//.test(sc) && /Max-Age=31536000/.test(sc));
  check('over plain http the cookie is not Secure', !/;\s*Secure/i.test(sc));
  const viaTunnel = (await login({ username: USER, password: PASS }, { 'x-forwarded-proto': 'https' })).headers.get('set-cookie') || '';
  const viaCf = (await login({ username: USER, password: PASS }, { 'cf-visitor': '{"scheme":"https"}' })).headers.get('set-cookie') || '';
  check('behind https (x-forwarded-proto or cf-visitor) the cookie is Secure', /;\s*Secure/i.test(viaTunnel) && /;\s*Secure/i.test(viaCf));
  check('the session secret is stored 0600 in DATA_DIR', (fs.statSync(path.join(dataDir, 'session-secret')).mode & 0o777) === 0o600);
  check('the password and secret are never logged', !logs.includes(PASS) && !logs.includes(fs.readFileSync(path.join(dataDir, 'session-secret'), 'utf8').trim()));
  const cookie = cookieOf(ok);
  const sess = await fetch(`${BASE}/kanban/session`, { headers: { cookie } });
  check('GET /kanban/session with the cookie → { ok, user }', sess.status === 200 && (await sess.json()).user === USER);
  check('the cookie opens pull, push and snapshot', (await fetch(`${BASE}/kanban/pull?since=0`, { headers: { cookie } })).status === 200 &&
    (await fetch(`${BASE}/kanban/snapshot`, { headers: { cookie } })).status === 200 &&
    (await fetch(`${BASE}/kanban/push`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'C', actions: [] }) })).status === 200);
  const [pl, sig] = cookie.split('=')[1].split('.');
  const forged = `todos_session=${pl}.${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`;
  check('a tampered cookie is refused', (await fetch(`${BASE}/kanban/pull?since=0`, { headers: { cookie: forged } })).status === 401);
  check('the cookie does not open the external routes', (await fetch(`${BASE}/kanban/external/card?key=wiki:page-1`, { headers: { cookie } })).status === 401);
  const basic = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
  check('Basic with the user/password opens pull', (await fetch(`${BASE}/kanban/pull?since=0`, { headers: { Authorization: basic } })).status === 200);
  check('Basic with a wrong password is 401', (await fetch(`${BASE}/kanban/pull?since=0`, { headers: { Authorization: 'Basic ' + Buffer.from(`${USER}:x`).toString('base64'), 'cf-connecting-ip': '10.0.0.9' } })).status === 401);
  check('Bearer API_TOKEN still opens pull', (await fetch(`${BASE}/kanban/pull?since=0`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status === 200);
  const out = await fetch(`${BASE}/kanban/logout`, { method: 'POST', headers: { cookie } });
  check('logout clears the cookie', out.status === 200 && /todos_session=;/.test(out.headers.get('set-cookie') || '') && /Max-Age=0/.test(out.headers.get('set-cookie') || ''));
  for (let i = 0; i < 10; i++) await login({ username: USER, password: 'guess' + i }, { 'cf-connecting-ip': '10.0.0.2' });
  const limited = await login({ username: USER, password: PASS }, { 'cf-connecting-ip': '10.0.0.2' });
  check('after 10 failures in 10 min an IP is rate-limited (429), even with the right password', limited.status === 429);
  check('another IP can still log in', (await login({ username: USER, password: PASS }, { 'cf-connecting-ip': '10.0.0.3' })).status === 200);
  // Forwarded client IPs are trusted only from the loopback tunnel, never from a LAN peer.
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (lan) {
    const lanLogin = (ip, pw) => fetch(`http://${lan}:${PORT}/kanban/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip, 'x-forwarded-for': ip }, body: JSON.stringify({ username: USER, password: pw }) });
    for (let i = 0; i < 10; i++) await lanLogin('203.0.113.' + i, 'guess');
    const r = await lanLogin('203.0.113.99', PASS);
    check('a LAN peer cannot dodge the rate limit by rotating cf-connecting-ip / x-forwarded-for', r.status === 429, String(r.status));
  } else console.log('  skip  no LAN interface: forwarded-header spoofing not checked');
  const viaXff = [];
  for (let i = 0; i < 10; i++) viaXff.push((await login({ username: USER, password: 'x' + i }, { 'x-forwarded-for': '10.0.0.7, 172.16.0.1' })).status);
  check('behind the local tunnel the first x-forwarded-for address is the rate-limit key', (await login({ username: USER, password: PASS }, { 'x-forwarded-for': '10.0.0.7' })).status === 429 && (await login({ username: USER, password: PASS }, { 'x-forwarded-for': '10.0.0.8' })).status === 200);

  // Sessions expire server-side after a year (iat), even with a valid signature.
  const secret = fs.readFileSync(path.join(dataDir, 'session-secret'), 'utf8').trim();
  const key = crypto.createHmac('sha256', secret).update(`v1\0${USER}\0${PASS}`).digest();
  const forge = (iat) => {
    const payload = Buffer.from(JSON.stringify({ u: USER, iat })).toString('base64url');
    return `todos_session=${payload}.${crypto.createHmac('sha256', key).update(payload).digest('base64url')}`;
  };
  check('a correctly signed fresh session is accepted', (await fetch(`${BASE}/kanban/session`, { headers: { cookie: forge(Date.now() - 1000) } })).status === 200);
  check('a session older than a year is refused', (await fetch(`${BASE}/kanban/session`, { headers: { cookie: forge(Date.now() - 366 * 86400000) } })).status === 401);
  check('a session issued in the future is refused', (await fetch(`${BASE}/kanban/session`, { headers: { cookie: forge(Date.now() + 86400000) } })).status === 401);
  check('the startup log names the real bind address', /listening on 0\.0\.0\.0:/.test(logs), logs.split('\n')[0]);

  await stop(server);
  server = await boot();
  check('a session survives a server restart', (await fetch(`${BASE}/kanban/session`, { headers: { cookie } })).status === 200);
  check('the external token is reused after a restart', fs.readFileSync(tokenFile, 'utf8').trim() === EXT && (await fetch(`${BASE}/kanban/external/card?key=wiki:page-3`, { headers: ext })).status === 200);
  check('the data file lives in DATA_DIR', fs.existsSync(path.join(dataDir, 'kanban.json')));
} catch (e) {
  failures++;
  console.log('  FAIL exception ' + (e?.stack ?? e));
} finally {
  await stop(server).catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
