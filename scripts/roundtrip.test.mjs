// §13.3 sync round-trip against the REAL server.js in a throwaway temp dir (its
// data file lives next to it, so the repo's data/ is never touched). Two
// clients push/pull through the kanban action log. Run: `npm run test:sync`.
import { startServer, stopServer } from './test-server.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { emptyState, applyAction, snapshot, diffCards, diffLabels } from '../shared/merge.mjs';

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
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-sync-'));
fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(workdir, 'server.js'));
fs.mkdirSync(path.join(workdir, 'shared'));
fs.copyFileSync(path.join(ROOT, 'shared', 'accounts.mjs'), path.join(workdir, 'shared', 'accounts.mjs'));
fs.copyFileSync(path.join(ROOT, 'shared', 'email-auth.mjs'), path.join(workdir, 'shared', 'email-auth.mjs'));
fs.copyFileSync(path.join(ROOT, 'shared', 'assistant.mjs'), path.join(workdir, 'shared', 'assistant.mjs'));
fs.copyFileSync(path.join(ROOT, 'shared', 'assistant-jobs.mjs'), path.join(workdir, 'shared', 'assistant-jobs.mjs'));
for (const f of fs.readdirSync(path.join(ROOT, 'shared')).filter((x) => x.endsWith('.mjs'))) fs.copyFileSync(path.join(ROOT, 'shared', f), path.join(workdir, 'shared', f));
fs.copyFileSync(path.join(ROOT, 'shared', 'merge.mjs'), path.join(workdir, 'shared', 'merge.mjs'));
fs.copyFileSync(path.join(ROOT, 'shared', 'repeat.mjs'), path.join(workdir, 'shared', 'repeat.mjs'));
fs.mkdirSync(path.join(workdir, 'fixtures'));
fs.copyFileSync(path.join(ROOT, 'fixtures', 'board.json'), path.join(workdir, 'fixtures', 'board.json'));

const TOKEN = 'scratch-token-123';
const srvEnv = { cwd: workdir, env: { API_TOKEN: TOKEN } };
const first = await startServer(path.join(workdir, 'server.js'), srvEnv);
const server = first.child;
const PORT = first.port;
const BASE = first.base;

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('  ok    ' + name);
  else { failures++; console.log('  FAIL ' + name + ' ' + extra); }
};
const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
// Realistic clocks: a few seconds around now (tombstones and the log are pruned at 30 days).
const BASE_TS = Date.now() - 60000;
const T = (n) => new Date(BASE_TS + n * 1000).toISOString();

const card = (id, title, items = []) => ({
  id, title, notes: '', status: 'todo', order: 0, items,
  createdAt: T(0), updatedAt: T(0), completedAt: null, archivedAt: null, someday: false, repeat: false,
});

/** A minimal client: local state + outbox; push drains, pull replays. */
function client(deviceId) {
  const state = emptyState();
  let cursor = 0;
  const outbox = [];
  let online = true;
  return {
    id: deviceId,
    get cards() { return snapshot(state).cards; },
    get labels() { return snapshot(state).labels; },
    doLabels(mutate, ts) {
      const before = snapshot(state).labels;
      const actions = diffLabels(before, mutate(JSON.parse(JSON.stringify(before))), ts, deviceId);
      for (const a of actions) applyAction(state, a);
      outbox.push(...actions);
    },
    setOnline(v) { online = v; },
    do(mutate, ts) {
      const before = snapshot(state).cards;
      const after = mutate(JSON.parse(JSON.stringify(before)));
      const actions = diffCards(before, after, ts, deviceId);
      for (const a of actions) applyAction(state, a);
      outbox.push(...actions);
    },
    async push() {
      if (!online || !outbox.length) return;
      const r = await fetch(`${BASE}/kanban/push`, { method: 'POST', headers: auth, body: JSON.stringify({ deviceId, actions: outbox }) });
      if (r.ok) outbox.length = 0;
      return r;
    },
    async pull() {
      if (!online) return;
      const r = await (await fetch(`${BASE}/kanban/pull?since=${cursor}`, { headers: auth })).json();
      if (r.reset) for (const c of r.cards) applyAction(state, { id: 'boot-' + c.id + cursor, deviceId: 'server', ts: c.updatedAt, type: 'card.put', payload: { card: c } });
      if (r.reset) for (const l of r.labels ?? []) applyAction(state, { id: 'bootl-' + l.id + cursor, deviceId: 'server', ts: l.updatedAt, type: 'label.put', payload: { label: l } });
      for (const a of r.actions) if (a.deviceId !== deviceId) applyAction(state, a);
      cursor = r.cursor;
      return r;
    },
    async sync() { await this.push(); await this.pull(); },
  };
}

try {
  // --- auth ------------------------------------------------------------------
  check('push without a token is 401', (await fetch(`${BASE}/kanban/push`, { method: 'POST', body: '{}' })).status === 401);
  check('pull without a token is 401', (await fetch(`${BASE}/kanban/pull?since=0`)).status === 401);
  check('snapshot without a token is 401', (await fetch(`${BASE}/kanban/snapshot`)).status === 401);
  check('without TODOS_USER login is disabled (401)', (await fetch(`${BASE}/kanban/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: '', password: '' }) })).status === 401);
  check('without TODOS_USER the session endpoint is 401 when a token is required', (await fetch(`${BASE}/kanban/session`)).status === 401);

  const A = client('A');
  const B = client('B');

  // --- offline add on A appears on B after A reconnects and B pulls ------------
  A.setOnline(false);
  A.do((cards) => [...cards, card('c1', 'Groceries', [{ id: 'i1', text: 'Milk', done: false }, { id: 'i2', text: 'Eggs', done: false }])], T(1));
  await A.push();
  await B.pull();
  check('offline: B sees nothing yet', B.cards.length === 0);
  A.setOnline(true);
  await A.sync();
  await B.pull();
  check('after reconnect, the card added on A appears on B', B.cards.length === 1 && B.cards[0].title === 'Groceries', JSON.stringify(B.cards));

  // --- checks on different items from both devices converge ------------------
  A.do((cards) => { cards[0].items[0].done = true; return cards; }, T(2));
  B.do((cards) => { cards[0].items[1].done = true; return cards; }, T(2));
  await A.sync(); await B.sync(); await A.sync();
  const a = A.cards[0], b = B.cards[0];
  check('both items checked on A', a.items.every((i) => i.done), JSON.stringify(a.items));
  check('both items checked on B', b.items.every((i) => i.done), JSON.stringify(b.items));
  check('checking every item sets Done on both devices', a.status === 'done' && b.status === 'done' && !!a.completedAt);

  // --- delete beats a later-arriving older edit ------------------------------
  B.do((cards) => cards.filter((c) => c.id !== 'c1'), T(5));
  A.do((cards) => { cards[0].title = 'Groceries (edited)'; return cards; }, T(4));
  await B.sync();
  await A.sync(); // A's older edit arrives after B's delete
  await B.sync();
  check('delete wins on the server: snapshot has no card', (await (await fetch(`${BASE}/kanban/snapshot`, { headers: auth })).json()).cards.length === 0);
  check('A converged to the delete', A.cards.length === 0);

  // --- same title on both devices = two cards; fresh device bootstraps from snapshot
  A.do((cards) => [...cards, card('a1', 'Call mum')], T(6));
  B.do((cards) => [...cards, card('b1', 'Call mum')], T(6));
  await A.sync(); await B.sync(); await A.sync();
  check('two devices adding the same title create two cards', A.cards.length === 2 && B.cards.length === 2);
  const snap = await (await fetch(`${BASE}/kanban/snapshot`, { headers: auth })).json();
  check('snapshot serves the merged board + cursor + tombstones', snap.cards.length === 2 && typeof snap.cursor === 'number' && snap.tombstones.includes('c1'));

  // --- labels: create on A, rename on B, card labels + delete converge ----------
  A.doLabels((ls) => [...ls, { id: 'l1', name: 'Work', color: '#2E9E6B' }], T(7));
  A.do((cards) => { cards.find((c) => c.id === 'a1').labels = ['l1']; return cards; }, T(7));
  await A.sync(); await B.pull();
  check('a label and a card label created on A reach B', B.labels.some((l) => l.name === 'Work') && B.cards.find((c) => c.id === 'a1').labels.join() === 'l1');
  B.doLabels((ls) => ls.map((l) => (l.id === 'l1' ? { ...l, name: 'Job', color: '#E5484D' } : l)), T(8));
  A.doLabels((ls) => ls.map((l) => (l.id === 'l1' ? { ...l, name: 'Older rename' } : l)), T(7.5));
  await B.sync(); await A.sync(); await B.sync();
  check('label renames converge by LWW on both devices', A.labels.find((l) => l.id === 'l1')?.name === 'Job' && B.labels.find((l) => l.id === 'l1')?.color === '#E5484D', JSON.stringify([A.labels, B.labels]));
  B.doLabels((ls) => ls.filter((l) => l.id !== 'l1'), T(9));
  B.do((cards) => cards.map((c) => ({ ...c, labels: (c.labels ?? []).filter((x) => x !== 'l1') })), T(9));
  await B.sync(); await A.sync();
  const lsnap = await (await fetch(`${BASE}/kanban/snapshot`, { headers: auth })).json();
  check('a label delete converges with its card strip; snapshot lists the label tombstone', A.labels.filter((l) => !l.id.startsWith('workflow:')).length === 0 && A.cards.find((c) => c.id === 'a1').labels.length === 0 && lsnap.labelTombstones.includes('l1'), JSON.stringify(lsnap.labels));
  A.doLabels((ls) => [...ls, { id: 'l2', name: 'Home', color: '#2F80ED' }], T(10));
  await A.sync(); await B.pull();

  // --- Reopen on a fully checked list lands in To do on the server and the other device ---
  A.do((cards) => [...cards, { ...card('r1', 'Checked list', [{ id: 'x1', text: 'a', done: false }, { id: 'x2', text: 'b', done: false }]) }], T(11));
  A.do((cards) => cards.map((c) => (c.id === 'r1' ? { ...c, status: 'done', completedAt: T(12), items: c.items.map((i) => ({ ...i, done: true })) } : c)), T(12));
  await A.sync(); await B.pull();
  check('check all → Done on both', A.cards.find((c) => c.id === 'r1').status === 'done' && B.cards.find((c) => c.id === 'r1').status === 'done');
  A.do((cards) => cards.map((c) => (c.id === 'r1' ? { ...c, status: 'todo', completedAt: null, order: 3, items: c.items.map((i) => ({ ...i, done: false })) } : c)), T(13));
  await A.sync(); await B.pull();
  const srvR1 = (await (await fetch(`${BASE}/kanban/snapshot`, { headers: auth })).json()).cards.find((c) => c.id === 'r1');
  check('Reopen → To do on the server and on the other device', srvR1.status === 'todo' && B.cards.find((c) => c.id === 'r1').status === 'todo' && A.cards.find((c) => c.id === 'r1').status === 'todo', `${srvR1.status} / ${B.cards.find((c) => c.id === 'r1').status}`);
  B.do((cards) => cards.map((c) => (c.id === 'r1' ? { ...c, status: 'doing', items: c.items.map((i, n) => ({ ...i, done: n === 0 })) } : c)), T(14));
  await B.sync(); await A.pull();
  check('a partial check afterwards → Doing everywhere', A.cards.find((c) => c.id === 'r1').status === 'doing');
  A.do((cards) => cards.filter((c) => c.id !== 'r1'), T(15));
  await A.sync(); await B.pull();

  // --- pull is incremental by cursor; unknown/old cursor resets ----------------
  const p0 = await (await fetch(`${BASE}/kanban/pull?since=0`, { headers: auth })).json();
  const pLatest = await (await fetch(`${BASE}/kanban/pull?since=${p0.cursor}`, { headers: auth })).json();
  check('pull since the latest cursor returns no actions', pLatest.actions.length === 0 && pLatest.cursor === p0.cursor);
  check('pull from 0 replays the whole log', p0.actions.length === p0.cursor && p0.actions.some(a => a.deviceId === 'server'), String(p0.actions.length));

  // --- the validator's fixture is served read-only by the app server ------------
  const fxRes = await fetch(`${BASE}/fixtures/board.json`);
  check('GET /fixtures/board.json serves the fixture', fxRes.ok && (await fxRes.json()).cards.length === 8);
  check('fixtures are read-only', (await fetch(`${BASE}/fixtures/board.json`, { method: 'POST', body: '{}' })).status === 404);

  // --- bad input ---------------------------------------------------------------
  check('push rejects a non-array body', (await fetch(`${BASE}/kanban/push`, { method: 'POST', headers: auth, body: '{"actions": 1}' })).status === 400);

  // --- durability: restart the server and the log survives --------------------
  await stopServer(server);
  const server2 = (await startServer(path.join(workdir, 'server.js'), { ...srvEnv, port: PORT })).child;
  const snap2 = await (await fetch(`${BASE}/kanban/snapshot`, { headers: auth })).json();
  check('the board survives a server restart', snap2.cards.length === 2 && snap2.labels.some((l) => l.name === 'Home'));
  await stopServer(server2);

  // --- a device behind the compacted log re-bootstraps with cards AND labels ----------
  const file = path.join(workdir, 'data', 'kanban.json');
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  disk.logStart = disk.seq; disk.log = [];
  fs.writeFileSync(file, JSON.stringify(disk));
  const server3 = (await startServer(path.join(workdir, 'server.js'), { ...srvEnv, port: PORT })).child;
  const C = client('C');
  const reset = await C.pull();
  check('reset pull carries labels and label tombstones', reset.reset === true && reset.labels.some((l) => l.name === 'Home') && reset.labelTombstones.includes('l1'), JSON.stringify(reset));
  check('a fresh device bootstraps the labels', C.labels.filter((l) => !l.id.startsWith('workflow:')).map((l) => l.name).join() === 'Home' && C.cards.length === 2);
  await stopServer(server3);
} catch (e) {
  failures++;
  console.log('  FAIL exception ' + (e && e.stack));
} finally {
  await stopServer(server);
  fs.rmSync(workdir, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
