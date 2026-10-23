// The server board is the only board. A device with a pre-existing local board and a
// legacy IndexedDB (old stores, old-format outbox) signs in and shows exactly the server
// board; nothing local is uploaded except real edits through the outbox. Two devices
// converge; an offline edit goes up on reconnect; a 401 goes back to the login.
// Run: `npm run test:serverboard`.
import 'fake-indexeddb/auto';
import { startServer, stopServer } from './test-server.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { applyAction, emptyState, snapshot, diffCards, type SyncAction } from '../shared/merge.mjs';

// Node 24's undici can throw `setTypeOfService EINVAL` from a socket it is tearing down
// (macOS). It is not a test outcome: note it and carry on instead of crashing the gate.
const benign = (e: unknown) => /setTypeOfService/.test(String((e as Error)?.message ?? e));
process.on('uncaughtException', (e) => { if (benign(e)) console.log('  note  ignored undici setTypeOfService EINVAL'); else { console.log('  FAIL uncaught ' + ((e as Error).stack ?? e)); process.exit(1); } });
process.on('unhandledRejection', (e) => { if (benign(e)) console.log('  note  ignored undici setTypeOfService EINVAL'); else { console.log('  FAIL unhandled ' + ((e as Error)?.stack ?? e)); process.exit(1); } });
const baseFetch = globalThis.fetch;
// A request that hit the same socket bug is retried once.
globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
  try { return await baseFetch(...a); } catch (e) { if (benign(e) || benign((e as { cause?: unknown })?.cause)) return baseFetch(...a); throw e; }
}) as typeof fetch;

// --- DOM shim --------------------------------------------------------------------------
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
(globalThis as any).document = { documentElement: { dataset: {}, style: { setProperty() {} }, setAttribute() {}, getAttribute: () => null }, querySelector: () => null, addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
(globalThis as any).CustomEvent = class { type: string; detail: any; constructor(t: string, i?: any) { this.type = t; this.detail = i?.detail; } };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log('  ok    ' + name);
  else { failures++; console.log('  FAIL ' + name + ' ' + extra); }
};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const warns: string[] = [];
const errors: string[] = [];
const realWarn = console.warn;
const realError = console.error;
console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };

// --- a legacy device database: old stores, an old-format outbox, a local board --------
const now = new Date().toISOString();
const localCard = (id: string, title: string) => ({ id, title, notes: '', status: 'todo', order: 0, items: [], labels: [], createdAt: now, updatedAt: now, completedAt: null, archivedAt: null, someday: false, repeat: false });
await new Promise<void>((resolve, reject) => {
  const req = indexedDB.open('kept', 3);
  req.onupgradeneeded = () => {
    const d = req.result;
    d.createObjectStore('lists', { keyPath: 'id' }).put({ id: 'l1', name: 'Old list' });
    d.createObjectStore('items', { keyPath: 'id' }).put({ id: 'i1', list_id: 'l1', text: 'old' });
    d.createObjectStore('meta', { keyPath: 'key' }).put({ key: 'junk', v: 1 });
    const out = d.createObjectStore('outbox', { keyPath: 'id' });
    out.put({ id: 'legacy-1', type: 'item_toggle', payload: { list_id: 'l1', item_id: 'i1' }, ts: now, applied: false });
    out.put({ id: 'legacy-2', type: 'list_create', payload: { list_id: 'l2' }, ts: now, applied: true });
    const cards = d.createObjectStore('cards', { keyPath: 'id' });
    cards.put(localCard('local-1', 'Mac-only card'));
    cards.put(localCard('local-2', 'Another Mac-only card'));
    d.createObjectStore('settings');
  };
  req.onsuccess = () => { req.result.close(); resolve(); };
  req.onerror = () => reject(req.error);
});

// --- server with a login, holding the "real" board ---------------------------------------
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-serverboard-'));
const PASS = 'pw-' + Math.random().toString(36).slice(2, 10);
const started = await startServer(path.join(ROOT, 'server.js'), { env: { API_TOKEN: '', TODOS_USER: 'demo', TODOS_PASS: PASS, DATA_DIR: dataDir } });
const server = started.child;
const BASE: string = started.base;
const basic = { Authorization: 'Basic ' + Buffer.from(`demo:${PASS}`).toString('base64'), 'Content-Type': 'application/json' };
const realFetch = globalThis.fetch;
const snap = async () => (await (await realFetch(`${BASE}/kanban/snapshot`, { headers: basic })).json()) as { cards: any[]; labels: any[] };

// Device B: a scripted client on the same account.
const bState = emptyState();
let bCursor = 0;
const B = {
  get cards() { return snapshot(bState).cards; },
  async pull() {
    const r = await (await realFetch(`${BASE}/kanban/pull?since=${bCursor}`, { headers: basic })).json();
    if (r.reset) for (const c of r.cards) applyAction(bState, { id: 'boot' + c.id, deviceId: 'server', ts: c.updatedAt, type: 'card.put', payload: { card: c } });
    for (const a of r.actions as SyncAction[]) if (a.deviceId !== 'B') applyAction(bState, a);
    bCursor = r.cursor;
  },
  async do(mutate: (cards: any[]) => any[]) {
    const before = snapshot(bState).cards;
    const actions = diffCards(before, mutate(JSON.parse(JSON.stringify(before))), new Date().toISOString(), 'B');
    for (const a of actions) applyAction(bState, a);
    await realFetch(`${BASE}/kanban/push`, { method: 'POST', headers: basic, body: JSON.stringify({ deviceId: 'B', actions }) });
  },
};
await B.do((cards) => [...cards, { ...localCard('srv-1', 'Server card'), items: [{ id: 's1', text: 'Milk', done: false }, { id: 's2', text: 'Eggs', done: false }] }]);

// Cookie jar for the app's same-origin requests.
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

const view = (cards: any[]) => JSON.stringify(cards.filter((c) => !c.archivedAt).map((c) => [c.id, c.title, c.status, c.items.map((i: any) => i.id + (i.done ? '*' : '')).join()]).sort());

try {
  const { actions, state } = await import('../src/hooks/useStore');
  const { setApiBase } = await import('../src/lib/sync');
  const { bootSync, sync } = await import('../src/lib/sync-boot');
  const { db } = await import('../src/lib/db');
  setApiBase(BASE);

  await actions.init();
  check('the legacy database opens: the cached local board loads', state.board.cards.some((c) => c.id === 'local-1'));
  const stores = Array.from((await db()).objectStoreNames);
  check('the legacy stores (lists, items, meta) are gone after the upgrade', !stores.includes('lists') && !stores.includes('items') && !stores.includes('meta') && stores.includes('outbox'), stores.join());
  bootSync();
  await tick(200);
  check('no session: the login is required and nothing syncs', sync.status.needsLogin && !sync.status.signedIn);

  check('sign in works despite the legacy outbox', (await sync.login('demo', PASS)) === 'ok');
  await tick(100);
  const server1 = await snap();
  check('after sign-in the device shows exactly the server board', view(state.board.cards) === view(server1.cards), view(state.board.cards) + ' vs ' + view(server1.cards));
  check('the pre-existing local cards are not uploaded', !server1.cards.some((c) => c.id.startsWith('local-')));
  check('the sync is healthy (no failure, nothing waiting)', sync.status.failingSince === null && sync.status.lastError === null && sync.status.pending === 0, JSON.stringify(sync.status));
  check('legacy outbox rows were dropped with one console.warn, no throw', warns.filter((w) => /outbox/i.test(w)).length === 1, JSON.stringify(warns));

  // Edits flow both ways; both devices show the same board.
  const a1 = actions.addCardFromText('Added on the Mac\nOne\nTwo', 'todo')!;
  actions.toggleItem('srv-1', 's1');
  await tick(700);
  await B.pull();
  await B.do((cards) => cards.map((c) => (c.id === a1.id ? { ...c, title: 'Renamed on the phone' } : c)));
  await sync.sync();
  await B.pull();
  const server2 = await snap();
  check('two devices show identical boards after sync (and match the server)', view(state.board.cards) === view(B.cards) && view(B.cards) === view(server2.cards), view(state.board.cards) + '\n' + view(B.cards));
  check('the phone\'s rename and the Mac\'s check both landed', state.board.cards.find((c) => c.id === a1.id)?.title === 'Renamed on the phone' && state.board.cards.find((c) => c.id === 'srv-1')!.items.find((i) => i.id === 's1')!.done);

  // A card deleted on the other device disappears here; nothing local brings it back.
  await B.do((cards) => cards.filter((c) => c.id !== a1.id));
  await sync.sync();
  check('a delete on the other device removes the card here', !state.board.cards.some((c) => c.id === a1.id));

  // Offline edit: waits in the outbox, goes up on reconnect, then shows on the other device.
  (globalThis as any).navigator.onLine = false;
  ls.get('offline')?.forEach((fn) => fn({}));
  const off = actions.addCardFromText('Written offline', 'todo')!;
  await tick(700);
  check('offline: the edit shows locally and waits in the outbox', state.board.cards.some((c) => c.id === off.id) && sync.status.pending >= 1 && !(await snap()).cards.some((c) => c.id === off.id));
  (globalThis as any).navigator.onLine = true;
  ls.get('online')?.forEach((fn) => fn({}));
  await tick(300);
  await sync.sync();
  await B.pull();
  check('on reconnect the offline edit is pushed and the other device sees it', (await snap()).cards.some((c) => c.id === off.id) && B.cards.some((c) => c.id === off.id) && sync.status.pending === 0);
  check('still identical after the offline round', view(state.board.cards) === view(B.cards));

  // Reopen (swipe) / To do (detail) on a fully checked list: To do everywhere, not Doing.
  const rl = actions.addCardFromText('Reopen me\nOne\nTwo\nThree', 'todo')!;
  actions.checkAllAction(rl.id);
  actions.setCardDone(rl.id, true);
  actions.dismissToast();
  await tick(700);
  await sync.sync();
  check('check all → Done on the device and the server', state.board.cards.find((c) => c.id === rl.id)!.status === 'done' && (await snap()).cards.find((c) => c.id === rl.id)?.status === 'done');
  actions.moveCardAction(rl.id, 'todo');
  await tick(700);
  await sync.sync();
  await B.pull();
  const srvRl = (await snap()).cards.find((c) => c.id === rl.id);
  check('Reopen / To do → To do on this device, the server and the other device', state.board.cards.find((c) => c.id === rl.id)!.status === 'todo' && srvRl?.status === 'todo' && B.cards.find((c) => c.id === rl.id)?.status === 'todo', `${state.board.cards.find((c) => c.id === rl.id)!.status} / ${srvRl?.status} / ${B.cards.find((c) => c.id === rl.id)?.status}`);
  check('moving the workflow label preserves ticks and clears completedAt', srvRl.items.every((i: any) => i.done) && srvRl.completedAt === null);
  actions.checkAllAction(rl.id);
  actions.dismissToast();
  const one = state.board.cards.find((c) => c.id === rl.id)!.items[1].id;
  actions.toggleItem(rl.id, one);
  await tick(700);
  await sync.sync();
  await B.pull();
  check('a partial uncheck starts Doing on both devices and server', state.board.cards.find((c) => c.id === rl.id)!.status === 'doing' && (await snap()).cards.find((c) => c.id === rl.id)?.status === 'doing' && B.cards.find((c) => c.id === rl.id)?.status === 'doing');
  check('boards still identical', view(state.board.cards) === view(B.cards));

  // Cascades, undo, configurable defaults and raw API writes converge across devices.
  const root = actions.addCardFromText('Automation root')!;
  const middle = actions.addCardFromText('Automation middle')!;
  const leaf = actions.addCardFromText('Automation leaf\nOne')!;
  actions.linkCard(root.id, middle.id);
  actions.linkCard(middle.id, leaf.id);
  await tick(30); await sync.sync();
  const leafItem = state.board.cards.find(c => c.id === leaf.id)!.items[0].id;
  actions.toggleItem(leaf.id, leafItem);
  check('one checklist check finishes a three-level dependency tree locally', [root, middle, leaf].every(c => state.board.cards.find(x => x.id === c.id)!.status === 'done'));
  await tick(30); await sync.sync(); await B.pull();
  check('the same cascade reaches the server and the second device', [root, middle, leaf].every(c => B.cards.find(x => x.id === c.id)!.status === 'done'));
  actions.undo();
  check('one undo restores the leaf and all ancestor labels', [root, middle, leaf].every(c => state.board.cards.find(x => x.id === c.id)!.status === 'todo'));
  await tick(30); await sync.sync();
  const raw = { id: 'raw-auto-check', deviceId: 'api', ts: new Date().toISOString(), type: 'item.set', payload: { cardId: leaf.id, itemId: leafItem, done: true } };
  await realFetch(`${BASE}/kanban/push`, { method: 'POST', headers: basic, body: JSON.stringify({ deviceId: 'api', actions: [raw] }) });
  await sync.sync(); await B.pull();
  check('a raw API checklist edit resolves the full tree on both devices', [root, middle, leaf].every(c => state.board.cards.find(x => x.id === c.id)!.status === 'done' && B.cards.find(x => x.id === c.id)!.status === 'done'));
  actions.updateLabel('workflow:done', { automations: [] });
  await tick(30); await sync.sync();
  check('disabled workflow defaults survive server storage', (await snap()).labels.find(l => l.id === 'workflow:done').automations.length === 0);
  actions.toggleItem(leaf.id, leafItem);
  actions.toggleItem(leaf.id, leafItem);
  check('disabled Done automation keeps the completed leaf in Doing', state.board.cards.find(c => c.id === leaf.id)!.status === 'doing');
  await tick(30); await sync.sync(); await B.pull();
  check('disabled defaults are respected by the server and second device', (await snap()).cards.find(c => c.id === leaf.id).status === 'doing' && B.cards.find(c => c.id === leaf.id)!.status === 'doing');
  const { rulesOf } = await import('../shared/automations.mjs');
  actions.updateLabel('workflow:done', { automations: rulesOf({ id: 'workflow:done', name: 'Done', color: '#0f766e' }) });
  const priority = actions.createLabel('Priority test')!;
  actions.updateLabel(priority.id, { group: 'Priority', automations: [{ id: 'test-add', condition: 'complete', scope: 'owner', action: 'add', target: priority.id, enabled: true }] });
  await tick(30); await sync.sync();
  check('custom groups and rules survive sync', (await snap()).labels.find(l => l.id === priority.id).group === 'Priority' && (await snap()).labels.find(l => l.id === priority.id).automations[0].id === 'test-add');
  actions.updateLabel(priority.id, { group: null });
  await tick(30); await sync.sync();
  check('clearing a group survives sync', !(await snap()).labels.find(l => l.id === priority.id).group);


  // A sync error surfaces (console.error + lastError), then a 401 goes back to the login.
  setApiBase('http://127.0.0.1:1');
  actions.addCardFromText('While unreachable', 'todo');
  await tick(700);
  await sync.sync();
  check('a failing sync is surfaced: lastError set and console.error called', !!sync.status.lastError && !!sync.status.failingSince && errors.some((e) => /sync/i.test(e)), JSON.stringify(sync.status));
  setApiBase(BASE);
  await sync.sync();
  check('the failure clears once the server is back', sync.status.failingSince === null && sync.status.lastError === null);
  jar.clear();
  await sync.sync();
  check('a 401 (session gone) goes to the login and stops syncing', sync.status.needsLogin && !sync.status.signedIn);

  // --- needsLogin comes ONLY from a JSON 401; every other failure keeps the board -------------
  sync.stop();
  const { SyncEngine, SYNC_TIMING } = await import('../src/lib/sync');
  const { statusLine } = await import('../src/lib/sync-line');
  const { enqueueActions, clearOutbox, readOutbox } = await import('../src/lib/db');
  SYNC_TIMING.visible = 40; SYNC_TIMING.hidden = 40; SYNC_TIMING.max = 160;
  setApiBase('http://stub.test');
  const reply = (status: number, body: unknown, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
  const failuresKinds: Record<string, () => Promise<Response>> = {
    'a network error': () => Promise.reject(new TypeError('fetch failed')),
    'a timeout': () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    'an abort': () => Promise.reject(new DOMException('This operation was aborted', 'AbortError')),
    'a 500 JSON': () => Promise.resolve(reply(500, { error: 'boom' })),
    'a 502 HTML page': () => Promise.resolve(reply(502, '<html>Bad gateway</html>', 'text/html')),
    'a non-JSON 401 (proxy page)': () => Promise.resolve(reply(401, '<html>Sign in to the proxy</html>', 'text/html')),
    'a non-JSON 200': () => Promise.resolve(reply(200, '<html></html>', 'text/html')),
  };
  const route = (fns: Record<string, () => Promise<Response>>, fallback: () => Promise<Response>) =>
    (async (url: any) => { const p = new URL(String(url)).pathname; return (fns[p] ?? fallback)(); }) as typeof fetch;
  const engines: InstanceType<typeof SyncEngine>[] = [];
  const mk = () => { const e = new SyncEngine(() => [], () => {}); engines.push(e); return e; };
  localStorage.removeItem('kept.syncUser');
  for (const [kind, fail] of Object.entries(failuresKinds)) {
    globalThis.fetch = route({}, fail);
    const e1 = mk();
    await e1.probe();
    check(`session check with ${kind}: no login`, !e1.status.needsLogin);
    e1.stop();
    globalThis.fetch = route({ '/kanban/session': () => Promise.resolve(reply(200, { ok: true, user: 'demo' })) }, fail);
    const e2 = mk();
    await e2.probe();
    await e2.sync();
    check(`snapshot/pull with ${kind}: no login, the failure is surfaced`, !e2.status.needsLogin && !!e2.status.failingSince && !!e2.status.lastError, JSON.stringify(e2.status));
    e2.stop();
  }
  localStorage.removeItem('kept.syncUser');
  globalThis.fetch = route({}, () => Promise.resolve(reply(401, { error: 'unauthorized' })));
  const j1 = mk();
  await j1.probe();
  check('a JSON 401 from /kanban/session → login', j1.status.needsLogin);
  j1.stop();
  const ok200 = { '/kanban/session': () => Promise.resolve(reply(200, { ok: true, user: 'demo' })) };
  globalThis.fetch = route({ ...ok200, '/kanban/snapshot': () => Promise.resolve(reply(401, { error: 'unauthorized' })) }, () => Promise.resolve(reply(200, { cursor: 0 })));
  const j2 = mk();
  await j2.probe();
  await j2.sync();
  check('a JSON 401 from the snapshot → login', j2.status.needsLogin);
  j2.stop();
  globalThis.fetch = route({ ...ok200, '/kanban/snapshot': () => Promise.resolve(reply(200, { cards: [], cursor: 0 })), '/kanban/pull': () => Promise.resolve(reply(401, { error: 'unauthorized' })) }, () => Promise.resolve(reply(200, { cursor: 0 })));
  const j3 = mk();
  await j3.probe();
  await j3.sync();
  check('after a good bootstrap the session is fine', !j3.status.needsLogin);
  await j3.sync();
  check('a JSON 401 from pull → login', j3.status.needsLogin);
  j3.stop();
  const act = { id: 'q1', deviceId: 'D', ts: new Date().toISOString(), type: 'card.put' as const, payload: { card: { id: 'q1', title: 'queued' } } };
  await enqueueActions([act]);
  globalThis.fetch = route({ ...ok200, '/kanban/push': () => Promise.resolve(reply(401, { error: 'unauthorized' })) }, () => Promise.resolve(reply(200, { cards: [], cursor: 0 })));
  const j4 = mk();
  await j4.probe();
  await j4.sync();
  check('a JSON 401 from push → login', j4.status.needsLogin);
  j4.stop();

  // --- boot while the server is unreachable: keep trying, then sync and flush the outbox --------
  let serverUp = false;
  const pushed: string[] = [];
  const upRoutes = {
    '/kanban/session': () => Promise.resolve(reply(200, { ok: true, user: 'demo' })),
    '/kanban/push': async () => { const rows = await readOutbox(); pushed.push(...rows.map((r) => r.action.id)); return reply(200, { cursor: 1, applied: rows.length }); },
    '/kanban/snapshot': () => Promise.resolve(reply(200, { cards: [{ ...localCard('srv-x', 'On the server') }], labels: [], cursor: 1 })),
    '/kanban/pull': () => Promise.resolve(reply(200, { actions: [], cursor: 1 })),
  };
  globalThis.fetch = (async (url: any, init: any) => (serverUp ? route(upRoutes, () => Promise.resolve(reply(404, {})))(url, init) : Promise.reject(new TypeError('fetch failed')))) as typeof fetch;
  // (a) no remembered user: re-probes on a timer, then syncs on its own.
  localStorage.removeItem('kept.syncUser');
  let shownA: any[] = [];
  const r1 = new SyncEngine(() => [], (cards) => { shownA = cards; });
  engines.push(r1);
  await r1.probe();
  check('unreachable at boot, no remembered user: not signed in, no login', !r1.status.signedIn && !r1.status.needsLogin);
  serverUp = true;
  const tA = Date.now();
  while (Date.now() - tA < 3000 && !(r1.status.signedIn && r1.status.syncedAt)) await tick(20);
  check('when the server comes back the device syncs on its own (no online/visibility event)', r1.status.signedIn && !!r1.status.syncedAt && shownA.some((c) => c.id === 'srv-x'), JSON.stringify(r1.status));
  check('...and the waiting outbox was flushed', pushed.includes('q1') && (await readOutbox()).length === 0);
  r1.stop();
  // (b) a remembered user booting while the server is unreachable counts as signed in, offline.
  serverUp = false;
  localStorage.setItem('kept.syncUser', 'demo');
  localStorage.setItem('kept.syncedAt', new Date(Date.now() - 3600000).toISOString());
  await enqueueActions([{ ...act, id: 'q2' }]);
  const r2 = new SyncEngine(() => [], () => {});
  engines.push(r2);
  await r2.probe();
  check('remembered user + unreachable: signed in, not the login, failure surfaced', r2.status.signedIn && !r2.status.needsLogin && !!r2.status.failingSince && !!r2.status.lastError);
  check('Settings reads "Offline · last synced …", the banner condition holds', /^Offline · last synced 1 h ago$/.test(statusLine(r2.status)) && r2.status.online && !!r2.status.lastError, statusLine(r2.status));
  serverUp = true;
  const tB = Date.now();
  while (Date.now() - tB < 3000 && r2.status.failingSince) await tick(20);
  check('it recovers by itself and flushes the edit made while unreachable', !r2.status.failingSince && pushed.includes('q2'));
  for (const e of engines) e.stop();
  await clearOutbox((await readOutbox()).map((r) => r.oid));
  globalThis.fetch = realFetch;

  // Hosted origin: never seed demo/Welcome cards.
  actions._setHosted(true);
  localStorage.removeItem('kept.seeded');
  const d = await db();
  await d.clear('cards');
  await actions.reload();
  check('the hosted app never seeds a Welcome/demo card', state.board.cards.length === 0, String(state.board.cards.length));
} catch (e) {
  failures++;
  console.log('  FAIL exception ' + ((e as Error).stack ?? e));
} finally {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.error = realError;
  await stopServer(server);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failures} FAILED`);
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 100);
