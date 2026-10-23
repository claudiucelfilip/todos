// Two windows of the app in one browser profile (the installed PWA + a tab): same
// localStorage, same IndexedDB, same cookie, one real server. Edits in either window reach
// the other, both converge to the server board and then stay put (no ping-pong).
// Run: `npm run test:windows`.
import 'fake-indexeddb/auto';
import { tsImport } from 'tsx/esm/api';
import { startServer, stopServer } from './test-server.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// Node 24's undici can throw `setTypeOfService EINVAL` from a socket it is tearing down
// (macOS). It is not a test outcome: note it and carry on instead of crashing the gate.
const benign = (e: unknown) => /setTypeOfService/.test(String((e as Error)?.message ?? e));
process.on('uncaughtException', (e) => { if (benign(e)) console.log('  note  ignored undici setTypeOfService EINVAL'); else { console.log('  FAIL uncaught ' + ((e as Error).stack ?? e)); process.exit(1); } });
process.on('unhandledRejection', (e) => { if (benign(e)) console.log('  note  ignored undici setTypeOfService EINVAL'); else { console.log('  FAIL unhandled ' + ((e as Error)?.stack ?? e)); process.exit(1); } });

// --- one browser profile: shared storage, window events and cookie jar -------------------
const mem = new Map<string, string>();
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) };
const ls = new Map<string, Set<(e: any) => void>>();
(globalThis as any).window = {
  addEventListener: (t: string, fn: any) => { (ls.get(t) ?? ls.set(t, new Set()).get(t)!).add(fn); },
  removeEventListener: (t: string, fn: any) => ls.get(t)?.delete(fn),
  dispatchEvent: (e: any) => { ls.get(e.type)?.forEach((fn) => fn(e)); return true; },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: storage, sessionStorage: storage,
  location: { hash: '', href: 'http://x/', pathname: '/', search: '', origin: 'http://x' },
  history: { replaceState() {} },
};
(globalThis as any).localStorage = storage;
(globalThis as any).sessionStorage = storage;
(globalThis as any).document = { documentElement: { dataset: {}, style: { setProperty() {} }, setAttribute() {}, getAttribute: () => null }, querySelector: () => null, addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
(globalThis as any).CustomEvent = class { type: string; detail: any; constructor(t: string, i?: any) { this.type = t; this.detail = i?.detail; } };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log('  ok    ' + name);
  else { failures++; console.log('  FAIL ' + name + ' ' + extra); }
};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const errors: string[] = [];
console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-windows-'));
const PASS = 'pw-' + Math.random().toString(36).slice(2, 10);
const started = await startServer(path.join(ROOT, 'server.js'), { env: { API_TOKEN: '', TODOS_USER: 'trip', TODOS_PASS: PASS, DATA_DIR: dataDir } });
const BASE: string = started.base;
const basic = { Authorization: 'Basic ' + Buffer.from(`trip:${PASS}`).toString('base64'), 'Content-Type': 'application/json' };
const realFetch = globalThis.fetch;
const jar = new Map<string, string>();
globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = String(url);
  if (!u.startsWith(BASE)) return realFetch(url, init);
  const headers = { ...(init.headers || {}) } as Record<string, string>;
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await realFetch(u, { ...init, headers });
  const sc = res.headers.get('set-cookie');
  if (sc) {
    const [k, v] = sc.split(';')[0].split('=');
    if (v) jar.set(k, v);
    else jar.delete(k);
  }
  return res;
}) as typeof fetch;
const server = async () => (await (await realFetch(`${BASE}/kanban/snapshot`, { headers: basic })).json()) as { cards: any[]; cursor: number };
const pullAll = async () => (await (await realFetch(`${BASE}/kanban/pull?since=0`, { headers: basic })).json()) as { actions: any[] };

// The server already holds a board of five cards, like the real one.
const now = new Date().toISOString();
const card = (id: string, title: string) => ({ id, title, notes: '', status: 'todo', order: 0, items: [], labels: [], createdAt: now, updatedAt: now, completedAt: null, archivedAt: null, someday: false, repeat: false });
await realFetch(`${BASE}/kanban/push`, { method: 'POST', headers: basic, body: JSON.stringify({ deviceId: 'phone', actions: ['s1', 's2', 's3', 's4', 's5'].map((id, i) => ({ id: 'seed-' + id, deviceId: 'phone', ts: now, type: 'card.put', payload: { card: { ...card(id, 'Server ' + (i + 1)), order: i } } })) }) });

// Every observable state of a window's board, sampled like a rAF loop would.
const view = (cards: any[]) => JSON.stringify(cards.filter((c) => !c.archivedAt).map((c) => [c.id, c.title, c.status, !!c.someday, c.order, c.items.map((i: any) => i.id + (i.done ? '*' : '')).join()]).sort());
type Win = Awaited<ReturnType<typeof open>>;
async function open(name: string) {
  const w = (await tsImport('./app-window.ts', import.meta.url)) as typeof import('./app-window');
  const trace: { t: number; v: string }[] = [];
  const sampler = setInterval(() => {
    const v = view(w.state.board.cards);
    if (trace.at(-1)?.v !== v) trace.push({ t: Date.now(), v });
  }, 5);
  return { name, ...w, trace, stopSampling: () => clearInterval(sampler) };
}
const flipsSince = (w: Win, t: number) => w.trace.filter((s) => s.t >= t).length;

const POLL = 1500;
let A: Win | null = null;
let B: Win | null = null;
try {
  A = await open('A');
  B = await open('B');
  check('each window has its own store and engine', A.state !== B.state && A.sync !== B.sync);
  for (const w of [A, B]) {
    // Slow polls, so a window catching up within ~1 s proves the cross-tab hint, not a poll.
    w.syncLib.SYNC_TIMING.visible = POLL; w.syncLib.SYNC_TIMING.hidden = POLL; w.syncLib.SYNC_TIMING.max = POLL * 4;
    w.actions._setHosted(true);
  }
  A.syncLib.setApiBase(BASE);
  // Window A signs in; window B (same profile) finds the session cookie on boot.
  await A.actions.init();
  A.bootSync();
  await tick(100);
  check('window A signs in', (await A.sync.login('trip', PASS)) === 'ok');
  await B.actions.init();
  B.bootSync();
  await tick(POLL + 300);
  let srv = await server();
  check('both windows show the server board after boot', view(A.state.board.cards) === view(srv.cards) && view(B.state.board.cards) === view(srv.cards), `\nA ${view(A.state.board.cards)}\nB ${view(B.state.board.cards)}\nS ${view(srv.cards)}`);

  // --- per-load identity -------------------------------------------------------------
  const idA = A.syncLib.deviceId();
  const idB = B.syncLib.deviceId();
  check('two windows of one profile (a duplicated tab too) stamp distinct ids', idA !== idB, `${idA} ${idB}`);

  // --- edits in A reach B within about a second, and the other way round ---------------------
  const added = A.actions.addCardFromText('Added in A\nOne\nTwo', 'todo')!;
  A.actions.updateCardTitle('s1', 'Renamed in A');
  A.actions.moveCardAction('s2', 'doing');
  const tEditA = Date.now();
  let seenAt = 0;
  while (Date.now() - tEditA < 3000) {
    await tick(20);
    if (B.state.board.cards.some((c) => c.id === added.id) && B.state.board.cards.find((c) => c.id === 's2')?.status === 'doing' && B.state.board.cards.find((c) => c.id === 's1')?.title === 'Renamed in A') { seenAt = Date.now(); break; }
  }
  check('A\'s edits appear in B', seenAt > 0, view(B.state.board.cards));
  check('...within ~1 s', seenAt > 0 && seenAt - tEditA < 1000, `${seenAt - tEditA} ms`);
  const bAdded = B.actions.addCardFromText('Added in B', 'todo')!;
  B.actions.moveCardAction('s3', 'done');
  const tEditB = Date.now();
  seenAt = 0;
  while (Date.now() - tEditB < 3000) {
    await tick(20);
    if (A.state.board.cards.some((c) => c.id === bAdded.id) && A.state.board.cards.find((c) => c.id === 's3')?.status === 'done') { seenAt = Date.now(); break; }
  }
  check('B\'s edits appear in A within ~1 s', seenAt > 0 && seenAt - tEditB < 1000, seenAt ? `${seenAt - tEditB} ms` : view(A.state.board.cards));

  // --- a move across the Someday divider reaches the other window as someday + order ---------
  A.actions.reorderCard('s4', null, 'todo', true);
  const tPark = Date.now();
  seenAt = 0;
  while (Date.now() - tPark < 3000) {
    await tick(20);
    const s4 = B.state.board.cards.find((c) => c.id === 's4');
    if (s4?.someday && s4.order === A.state.board.cards.find((c) => c.id === 's4')!.order) { seenAt = Date.now(); break; }
  }
  check('a card parked in Someday in A shows parked, in the same place, in B', seenAt > 0, view(B.state.board.cards));

  // --- a checklist reorder in A reaches B as items order ------------------------------------
  const listCard = A.actions.addCardFromText('Order me\nFirst\nSecond\nThird', 'todo')!;
  await tick(900);
  const itemIds = () => A.state.board.cards.find((c) => c.id === listCard.id)!.items.map((i) => i.id);
  const [i1, , i3] = itemIds();
  A.actions.moveItem(listCard.id, i3, i1);
  const want = itemIds().join();
  const tOrder = Date.now();
  seenAt = 0;
  while (Date.now() - tOrder < 3000) {
    await tick(20);
    if (B.state.board.cards.find((c) => c.id === listCard.id)?.items.map((i) => i.id).join() === want) { seenAt = Date.now(); break; }
  }
  check('a checklist reorder in A shows in the same order in B', seenAt > 0, want);

  // --- both converge to the server, then nothing moves (the bug flip-flopped every ~1 s) ------
  await tick(POLL);
  srv = await server();
  check('both windows converge to the server snapshot', view(A.state.board.cards) === view(srv.cards) && view(B.state.board.cards) === view(srv.cards), `\nA ${view(A.state.board.cards)}\nB ${view(B.state.board.cards)}\nS ${view(srv.cards)}`);
  const tStable = Date.now();
  await tick(POLL * 6); // six poll cycles in each window
  check('no window changes its board during 6 further sync cycles', flipsSince(A, tStable) === 0 && flipsSince(B, tStable) === 0, `A ${flipsSince(A, tStable)} B ${flipsSince(B, tStable)}`);
  check('the server saw no further writes either', (await server()).cursor === srv.cursor, `${srv.cursor} → ${(await server()).cursor}`);
  const ids = new Set((await pullAll()).actions.filter((a) => a.deviceId !== 'phone').map((a) => a.deviceId));
  check('pushed actions carry both windows\' ids', ids.has(idA) && ids.has(idB), [...ids].join());

  // --- signed in, the cross-tab message is only a hint: never re-read IndexedDB ---------------
  const stale = { ...card('idb-only', 'Only in IndexedDB'), updatedAt: new Date().toISOString() };
  await A.dbLib.upsertCard(stale as any);
  const syncedBefore = B.sync.status.syncedAt;
  const hintAt = Date.now();
  await tick(5);
  new BroadcastChannel('kept.kanban').postMessage({ type: 'change' });
  let hinted = false;
  while (Date.now() - hintAt < 100) { await tick(5); if (B.sync.status.syncedAt !== syncedBefore) { hinted = true; break; } }
  check('a cross-tab message makes the other window sync at once (before its next poll)', hinted);
  await tick(POLL);
  check('...and never loads the board from IndexedDB', ![...A.trace, ...B.trace].some((s) => s.t >= hintAt && s.v.includes('idb-only')));
  await A.dbLib.removeCard('idb-only');

  // --- an offline edit in one window still lands ---------------------------------------------
  (globalThis as any).navigator.onLine = false;
  ls.get('offline')?.forEach((fn) => fn({}));
  const off = B.actions.addCardFromText('Written offline in B', 'todo')!;
  await tick(700);
  check('offline: the edit shows in B and has not reached the server', B.state.board.cards.some((c) => c.id === off.id) && !(await server()).cards.some((c) => c.id === off.id));
  (globalThis as any).navigator.onLine = true;
  ls.get('online')?.forEach((fn) => fn({}));
  await tick(1000);
  srv = await server();
  check('back online: the offline edit lands on the server and in A', srv.cards.some((c) => c.id === off.id) && A.state.board.cards.some((c) => c.id === off.id));
  check('both windows equal the server again', view(A.state.board.cards) === view(srv.cards) && view(B.state.board.cards) === view(srv.cards));
  const tStable2 = Date.now();
  await tick(POLL * 4);
  check('and stay still', flipsSince(A, tStable2) === 0 && flipsSince(B, tStable2) === 0, `A ${flipsSince(A, tStable2)} B ${flipsSince(B, tStable2)}`);
  check('no sync errors', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
} catch (e) {
  failures++;
  console.log('  FAIL exception ' + ((e as Error).stack ?? e));
} finally {
  for (const w of [A, B]) { w?.stopSampling(); w?.sync.stop(); }
  await stopServer(started.child);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failing` : '\nall passed');
process.exit(failures ? 1 : 0);
