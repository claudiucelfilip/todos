// §13.3 client sync: the real store + SyncEngine (fake-indexeddb, DOM shim)
// against the real server.js, with a scripted second device. Run: `npm run test:syncclient`.
import 'fake-indexeddb/auto';
import { startServer, stopServer } from './test-server.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { applyAction, diffCards, diffLabels, emptyState, snapshot, type SyncAction } from '../shared/merge.mjs';

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

// --- DOM shim ------------------------------------------------------------------
const mem = new Map<string, string>();
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) };
const ls = new Map<string, Set<(e: any) => void>>();
const win: any = {
  addEventListener: (t: string, fn: any) => { (ls.get(t) ?? ls.set(t, new Set()).get(t)!).add(fn); },
  removeEventListener: (t: string, fn: any) => ls.get(t)?.delete(fn),
  dispatchEvent: (e: any) => { ls.get(e.type)?.forEach((fn) => fn(e)); return true; },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: storage, sessionStorage: storage,
  location: { hash: '', href: 'http://x/', pathname: '/', search: '', origin: 'http://x' },
  history: { replaceState() {} },
};
(globalThis as any).window = win;
(globalThis as any).localStorage = storage;
(globalThis as any).document = { documentElement: { dataset: {}, style: { setProperty() {} }, setAttribute() {}, getAttribute: () => null }, querySelector: () => null, addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
(globalThis as any).CustomEvent = class { type: string; detail: any; constructor(t: string, i?: any) { this.type = t; this.detail = i?.detail; } };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log('  ok           ' + name);
  else { failures++; console.log('  FAIL ' + name + ' ' + extra); }
};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// --- server ------------------------------------------------------------------------
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-syncc-'));
fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(workdir, 'server.js'));
fs.mkdirSync(path.join(workdir, 'shared'));
fs.copyFileSync(path.join(ROOT, 'shared', 'merge.mjs'), path.join(workdir, 'shared', 'merge.mjs'));
fs.copyFileSync(path.join(ROOT, 'shared', 'repeat.mjs'), path.join(workdir, 'shared', 'repeat.mjs'));
fs.copyFileSync(path.join(ROOT, 'shared', 'accounts.mjs'), path.join(workdir, 'shared', 'accounts.mjs'));
fs.copyFileSync(path.join(ROOT, 'shared', 'email-auth.mjs'), path.join(workdir, 'shared', 'email-auth.mjs'));
fs.copyFileSync(path.join(ROOT, 'shared', 'assistant.mjs'), path.join(workdir, 'shared', 'assistant.mjs'));
fs.copyFileSync(path.join(ROOT, 'shared', 'assistant-jobs.mjs'), path.join(workdir, 'shared', 'assistant-jobs.mjs'));
for (const f of fs.readdirSync(path.join(ROOT, 'shared')).filter((x) => x.endsWith('.mjs'))) fs.copyFileSync(path.join(ROOT, 'shared', f), path.join(workdir, 'shared', f));
const TOKEN = 'tok-' + Math.random().toString(36).slice(2, 8);
const first = await startServer(path.join(workdir, 'server.js'), { cwd: workdir, env: { API_TOKEN: TOKEN } });
const server = first.child;
const PORT: number = first.port;
const BASE: string = first.base;
const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

// scripted device B
const bState = emptyState();
let bCursor = 0;
const B = {
  get cards() { return snapshot(bState).cards; },
  get labels() { return snapshot(bState).labels; },
  async doLabels(mutate: (labels: any[]) => any[]) {
    const before = snapshot(bState).labels;
    const actions = diffLabels(before, mutate(JSON.parse(JSON.stringify(before))), new Date().toISOString(), 'B');
    for (const a of actions) applyAction(bState, a);
    await fetch(`${BASE}/kanban/push`, { method: 'POST', headers: auth, body: JSON.stringify({ deviceId: 'B', actions }) });
  },
  async pull() {
    const r = await (await fetch(`${BASE}/kanban/pull?since=${bCursor}`, { headers: auth })).json();
    if (r.reset) for (const c of r.cards) applyAction(bState, { id: 'boot' + c.id, deviceId: 'server', ts: c.updatedAt, type: 'card.put', payload: { card: c } });
    if (r.reset) for (const l of r.labels ?? []) applyAction(bState, { id: 'bootl' + l.id, deviceId: 'server', ts: l.updatedAt, type: 'label.put', payload: { label: l } });
    for (const a of r.actions as SyncAction[]) if (a.deviceId !== 'B') applyAction(bState, a);
    bCursor = r.cursor;
  },
  async do(mutate: (cards: any[]) => any[]) {
    const before = snapshot(bState).cards;
    const after = mutate(JSON.parse(JSON.stringify(before)));
    const actions = diffCards(before, after, new Date().toISOString(), 'B');
    for (const a of actions) applyAction(bState, a);
    await fetch(`${BASE}/kanban/push`, { method: 'POST', headers: auth, body: JSON.stringify({ deviceId: 'B', actions }) });
  },
};

try {
  const { actions, state } = await import('../src/hooks/useStore');
  const { setApiBase, SYNC_TIMING } = await import('../src/lib/sync');
  check('timing: 30 s polls while visible, none while hidden (one person, not real-time)', SYNC_TIMING.visible === 30000 && SYNC_TIMING.hidden === 0);
  SYNC_TIMING.visible = 1500; // this suite waits for polls
  const { bootSync, sync } = await import('../src/lib/sync-boot');
  setApiBase(BASE);

  await actions.init();
  actions.deleteCardById(state.board.cards[0].id); // drop the Welcome seed
  actions.dismissToast();
  await tick();
  bootSync();
  check('not signed in: engine idle', sync.status.signedIn === false);

  // --- D1: a rejected token is a clear, unpaired state ----------------------------------
  await sync.signIn('wrong-token');
  check('401: not signed in, token rejected, no synced-at', sync.status.signedIn === false && sync.status.rejected === true && sync.status.syncedAt === null && sync.status.lastError === 'Token rejected', JSON.stringify(sync.status));
  check('401 is not a stall', sync.status.failingSince === null);

  // --- sign in on an empty server, local writes flow to the server -------------
  await sync.signIn(TOKEN);
  check('a good token clears the rejected flag', sync.status.rejected === false);
  check('signIn stores the token and syncs', sync.status.signedIn && sync.status.syncedAt !== null && sync.status.pending === 0);
  const blank = actions.createBlank('todo');
  const g = actions.addCardFromText('Groceries\nMilk\nEggs', 'todo')!;
  await tick(600); // debounced push
  await B.pull();
  check('a local card reaches device B', B.cards.length === 1 && B.cards[0].title === 'Groceries' && B.cards[0].items.length === 2, JSON.stringify(B.cards));
  check('an empty editor draft never reaches the other device during unrelated writes', !B.cards.some((c: any) => c.id === blank.id) && state.board.cards.some((c) => c.id === blank.id && c.draft));
  actions.discardBlank(blank.id);
  check('outbox drained', sync.status.pending === 0);

  // --- D2: a remote change lands within the 5 s budget without a manual sync -------
  const t0 = Date.now();
  await B.do((cards) => { cards[0].items[1].done = true; return cards; });
  while (Date.now() - t0 < 6000 && !state.board.cards.find((c) => c.id === g.id)!.items.find((i) => i.text === 'Eggs')!.done) await tick(100);
  const elapsed = Date.now() - t0;
  check('remote change arrives on the next poll (visible tab)', elapsed < 5000, elapsed + 'ms');
  const local = state.board.cards.find((c) => c.id === g.id)!;
  check('remote partial progress starts Doing', local.items.find((i) => i.text === 'Eggs')!.done && local.status === 'doing', JSON.stringify(local.items) + local.status);
  check('remote change is tagged so the face skips the pulse', state.lastChangeType === 'remote');

  // --- concurrent checks converge both ways --------------------------------------
  actions.toggleItem(g.id, local.items.find((i) => i.text === 'Milk')!.id);
  await tick(600);
  await B.pull();
  check('device B sees both items checked and Done', B.cards[0].items.every((i: any) => i.done) && B.cards[0].status === 'done', JSON.stringify(B.cards[0]));
  check('local workflow label is Done too', state.board.cards.find((c) => c.id === g.id)!.status === 'done');

  // --- remote delete removes locally; local undo (card.put) resurrects everywhere ---
  await B.do((cards) => cards.filter((c) => c.id !== g.id));
  await sync.sync();
  check('remote delete removes the card locally', !state.board.cards.some((c) => c.id === g.id));
  const m = actions.addCardFromText('Call mum', 'todo')!;
  actions.deleteCardById(m.id);
  actions.undo();
  actions.dismissToast();
  await tick(600);
  await B.pull();
  check('delete + undo converges to the card existing on B', B.cards.some((c: any) => c.id === m.id), JSON.stringify(B.cards.map((c: any) => c.title)));

  // --- an edit whose push debounce fires while a run is in flight is pushed right after it ---
  {
    const wrapped = globalThis.fetch;
    let slow = true;
    globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
      if (slow && String(a[0]).includes('/kanban/pull')) { slow = false; await tick(1500); }
      return wrapped(...a);
    }) as typeof fetch;
    void sync.sync(); // pull held for 1.5 s
    await tick(50);
    const t0 = Date.now();
    const racer = actions.addCardFromText('Made mid-run', 'todo')!; // its 400 ms debounce fires mid-run
    let seen = 0;
    while (Date.now() - t0 < 6000) { await B.pull(); if (B.cards.some((c: any) => c.id === racer.id)) { seen = Date.now() - t0; break; } await tick(50); }
    globalThis.fetch = wrapped;
    check('an edit made during an in-flight run is pushed when that run ends, not at the next poll', seen > 0 && seen < 2000, seen ? `${seen} ms` : 'never');
  }

  // --- labels: local create + toggle reach B; B's rename and delete land locally -----------
  const lc = actions.addCardFromText('Tagged', 'todo')!;
  const work = actions.createLabel('Work', '#2E9E6B', lc.id)!;
  await tick(600);
  await B.pull();
  check('a local label and card label reach device B', B.labels.some((l: any) => l.id === work.id && l.name === 'Work') && B.cards.find((c: any) => c.id === lc.id)?.labels.filter((id: string) => !id.startsWith('workflow:')).join() === work.id, JSON.stringify(B.labels));
  check('the unedited built-in label is not pushed', !B.labels.some((l: any) => l.id === 'sherlock'));
  actions.resizeCard(lc.id, 2, 280, { width: 1.65, anchor: { x: 2.35, y: 160 } });
  await tick(600);
  await sync.sync();
  await B.pull();
  check('Notes width and pixel height reach a second device', B.cards.find((c: any) => c.id === lc.id)?.layout?.w === 2 && B.cards.find((c: any) => c.id === lc.id)?.layout?.height === 280);
  check('free width and masonry anchor reach a second device', B.cards.find((c: any) => c.id === lc.id)?.layout?.width === 1.65 && B.cards.find((c: any) => c.id === lc.id)?.layout?.anchor?.x === 2.35);
  actions.resizeCard(lc.id, 1, null);
  await tick(600);
  await sync.sync();
  await B.pull();
  check('fit-content reset removes pixel height on a second device', B.cards.find((c: any) => c.id === lc.id)?.layout?.height === undefined);
  check('fit-content reset removes free width and anchor on a second device', B.cards.find((c: any) => c.id === lc.id)?.layout?.width === undefined && B.cards.find((c: any) => c.id === lc.id)?.layout?.anchor === undefined);
  await B.doLabels((ls) => ls.map((l) => (l.id === work.id ? { ...l, name: 'Job', color: '#E5484D' } : l)));
  await sync.sync();
  check('a remote rename + recolor lands locally', state.board.labels.find((l) => l.id === work.id)?.name === 'Job' && state.board.labels.find((l) => l.id === work.id)?.color === '#E5484D');
  check('the built-in label survives a remote label change', state.board.labels.some((l) => l.id === 'sherlock'));
  actions.setLabelFilter([work.id]);
  await B.doLabels((ls) => ls.filter((l) => l.id !== work.id));
  await B.do((cards) => cards.map((c) => ({ ...c, labels: (c.labels ?? []).filter((x: string) => x !== work.id) })));
  await sync.sync();
  check('a remote label delete removes it locally, from the card and from the filter', !state.board.labels.some((l) => l.id === work.id) && state.board.cards.find((c) => c.id === lc.id)!.labels.filter((id) => !id.startsWith('workflow:')).length === 0 && state.labelFilter.length === 0);
  actions.deleteLabel('sherlock');
  actions.updateLabel('sherlock', { color: '#000000' });
  await tick(600);
  await B.pull();
  check('an edited built-in label syncs like any other', B.labels.find((l: any) => l.id === 'sherlock')?.color === '#000000');
  actions.dismissToast();

  // --- the external API writes land on this device with labels, links and ext ------------
  const extToken = fs.readFileSync(path.join(workdir, 'data', 'external-token'), 'utf8').trim();
  const created = await (await fetch(`${BASE}/kanban/external/card`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${extToken}` }, body: JSON.stringify({ key: 'wiki:1', title: 'From the wiki', links: [{ title: 'Page', url: 'https://wiki.test/1' }], labels: [{ id: 'sherlock', name: 'Sherlock', color: '#7C5CFF' }] }) })).json();
  await sync.sync();
  const got = state.board.cards.find((c) => c.id === created.id);
  check('an external card arrives with labels, links and ext', !!got && got.labels.join() === 'sherlock,workflow:todo' && got.notes.includes('(https://wiki.test/1)') && got.ext?.key === 'wiki:1', JSON.stringify(got));
  check('an existing built-in label is not overwritten by the capture', state.board.labels.find((l) => l.id === 'sherlock')?.color === '#000000');
  await fetch(`${BASE}/kanban/external/status`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${extToken}` }, body: JSON.stringify({ key: 'wiki:1', status: 'done' }) });
  await sync.sync();
  const doneExt = state.board.cards.find((c) => c.id === created.id)!;
  check('an external status change arrives: Done with completedAt', doneExt.status === 'done' && !!doneExt.completedAt);
  actions.updateCardNotes(created.id, doneExt.notes.replace('[Page](https://wiki.test/1)', '').trim());
  actions.dismissToast();
  await tick(600);
  await B.pull();
  check('a local link removal (its line deleted) reaches device B', !B.cards.find((c: any) => c.id === created.id)?.notes.includes('wiki.test/1'));

  // --- undo never deletes what arrived from elsewhere in the meantime --------------------
  const undoLabel = actions.createLabel('Before capture')!;
  const cap = await (await fetch(`${BASE}/kanban/external/card`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${extToken}` }, body: JSON.stringify({ key: 'wiki:undo', title: 'Captured meanwhile' }) })).json();
  await tick(600);
  await sync.sync();
  check('the captured card arrived', state.board.cards.some((c) => c.id === cap.id));
  const serverCursor = async () => ((await (await fetch(`${BASE}/kanban/snapshot`, { headers: auth })).json()) as { cursor: number }).cursor;
  const cursorBefore = await serverCursor();
  actions.undo();
  await tick(600);
  await sync.sync();
  check('undo removes the local label but keeps the captured card', !state.board.labels.some((l) => l.id === undoLabel.id) && state.board.cards.some((c) => c.id === cap.id));
  const log = await (await fetch(`${BASE}/kanban/pull?since=${cursorBefore}`, { headers: auth })).json();
  check('undo pushed no card.delete for the captured card', !log.actions.some((a: any) => a.type === 'card.delete' && a.payload.id === cap.id), JSON.stringify(log.actions.map((a: any) => a.type)));
  check('undo pushed the label delete', log.actions.some((a: any) => a.type === 'label.delete' && a.payload.id === undoLabel.id));
  const snapNow = await (await fetch(`${BASE}/kanban/snapshot`, { headers: auth })).json();
  check('the server still has the captured card', snapNow.cards.some((c: any) => c.id === cap.id));
  // The validator's repro: label on an external card, then a capture adds a link and a status move lands; undo.
  const extH = { 'Content-Type': 'application/json', Authorization: `Bearer ${extToken}` };
  const tb = await (await fetch(`${BASE}/kanban/external/card`, { method: 'POST', headers: extH, body: JSON.stringify({ key: 'brief:1', title: 'Test brief', links: [{ title: 'First', url: 'https://t.test/first' }] }) })).json();
  await sync.sync();
  const briefLabel = actions.createLabel('Brief', undefined, tb.id)!;
  await tick(600);
  await sync.sync();
  await fetch(`${BASE}/kanban/external/card`, { method: 'POST', headers: extH, body: JSON.stringify({ key: 'brief:1', title: 'Test brief', links: [{ title: 'Later', url: 'https://t.test/later' }] }) });
  await fetch(`${BASE}/kanban/external/status`, { method: 'POST', headers: extH, body: JSON.stringify({ key: 'brief:1', status: 'doing' }) });
  await sync.sync();
  const cur0 = await serverCursor();
  actions.undo();
  await tick(600);
  await sync.sync();
  const tbNow = state.board.cards.find((c) => c.id === tb.id)!;
  check('undo drops the label but keeps the later status, link and seenLinks on the same card', tbNow.labels.join() === 'workflow:doing' && tbNow.status === 'doing' && tbNow.notes.includes('(https://t.test/later)') && !!tbNow.ext?.seenLinks?.includes('https://t.test/later') && !state.board.labels.some((l) => l.id === briefLabel.id), JSON.stringify(tbNow));
  const pushed = (await (await fetch(`${BASE}/kanban/pull?since=${cur0}`, { headers: auth })).json()).actions.filter((a: any) => a.type === 'card.set' && a.payload.id === tb.id);
  check('undo pushes only the labels field for that card', pushed.length === 1 && Object.keys(pushed[0].payload.fields).join() === 'labels', JSON.stringify(pushed.map((a: any) => a.payload.fields)));
  const srvTb = (await (await fetch(`${BASE}/kanban/external/card?key=brief:1`, { headers: extH })).json()).card;
  check('the server keeps status Doing and both links after the undo', srvTb.status === 'doing' && srvTb.links.length === 2 && srvTb.labels.join() === 'workflow:doing');
  actions.dismissToast();

  const lrn = actions.addCardFromText('Rename race', 'todo')!;
  actions.toggleCardLabel(lrn.id, 'sherlock');
  await tick(600);
  await B.pull();
  await B.doLabels((ls) => ls.map((l) => (l.id === 'sherlock' ? { ...l, name: 'Holmes' } : l)));
  await sync.sync();
  actions.undo();
  await tick(600);
  await sync.sync();
  await B.pull();
  check('undo after a remote label rename keeps the rename locally and on B', state.board.labels.find((l) => l.id === 'sherlock')?.name === 'Holmes' && B.labels.find((l: any) => l.id === 'sherlock')?.name === 'Holmes');
  check('undo reverted only the card label toggle', state.board.cards.find((c) => c.id === lrn.id)!.labels.filter((id) => !id.startsWith('workflow:')).length === 0 && B.cards.find((c: any) => c.id === lrn.id)?.labels.filter((id: string) => !id.startsWith('workflow:')).length === 0);
  actions.dismissToast();

  // --- offline queue, then reconnect -------------------------------------------------
  (globalThis as any).navigator.onLine = false;
  ls.get('offline')?.forEach((fn) => fn({}));
  actions.addCardFromText('Offline idea', 'todo');
  await tick(600);
  check('offline: the change waits in the outbox', sync.status.pending >= 1, String(sync.status.pending));
  (globalThis as any).navigator.onLine = true;
  ls.get('online')?.forEach((fn) => fn({}));
  await tick(300);
  await sync.sync();
  await B.pull();
  check('reconnect drains the queue to device B', B.cards.some((c: any) => c.title === 'Offline idea') && sync.status.pending === 0);

  // --- F3: after a real outage the status recounts "N changes waiting" to 0 ------------------
  await stopServer(server);
  actions.addCardFromText('While down', 'todo');
  await tick(700);
  await sync.sync();
  check('server down: the change waits and the engine is failing', sync.status.pending >= 1 && sync.status.failingSince !== null, JSON.stringify(sync.status));
  const server2 = (await startServer(path.join(workdir, 'server.js'), { cwd: workdir, port: PORT, env: { API_TOKEN: TOKEN } })).child;
  ls.get('online')?.forEach((fn) => fn({}));
  await tick(300);
  await sync.sync();
  await tick(100);
  check('server back: outbox drained and status shows 0 pending, not failing', sync.status.pending === 0 && sync.status.failingSince === null && sync.status.syncedAt !== null, JSON.stringify(sync.status));
  await B.pull();
  check('the outage-time card reached device B', B.cards.some((c: any) => c.title === 'While down'));
  await stopServer(server2);

  // --- sign out keeps local data ----------------------------------------------------------
  const n = state.board.cards.length;
  sync.signOut();
  check('sign out wipes the token, keeps local cards', sync.status.signedIn === false && state.board.cards.length === n && !localStorage.getItem('kept.apiToken'));
  check('sign out clears the synced-at marker', sync.status.syncedAt === null && !localStorage.getItem('kept.syncedAt'));

  // --- username + password login, no token (a server with TODOS_USER, cookie jar in fetch) ---
  const work2 = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-login-'));
  const PASS2 = 'pw-' + Math.random().toString(36).slice(2, 10);
  const login2 = await startServer(path.join(ROOT, 'server.js'), { env: { API_TOKEN: '', TODOS_USER: 'demo', TODOS_PASS: PASS2, DATA_DIR: work2 } });
  const loginSrv = login2.child;
  const PORT2: number = login2.port;
  const BASE2: string = login2.base;
  const jar = new Map<string, string>();
  const seen: { url: string; init: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    if (!u.startsWith(BASE2)) return realFetch(url, init);
    seen.push({ url: u, init });
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
  const basic2 = { Authorization: 'Basic ' + Buffer.from(`demo:${PASS2}`).toString('base64'), 'Content-Type': 'application/json' };
  // Cache Storage as the service worker shares it: the attachment cache and the "signed out" marker.
  const cacheStore = new Map<string, Map<string, unknown>>();
  (globalThis as any).caches = {
    async open(n: string) {
      if (!cacheStore.has(n)) cacheStore.set(n, new Map());
      const m = cacheStore.get(n)!;
      return { put: async (k: string, v: unknown) => void m.set(String(k), v), match: async (k: string) => m.get(String(k)), delete: async (k: string) => m.delete(String(k)), keys: async () => [...m.keys()] };
    },
    async delete(n: string) { return cacheStore.delete(n); },
  };
  const { FILES_CACHE, FILES_STATE, SIGNED_OUT } = await import('../src/lib/file-cache');
  const viewedFile = () => cacheStore.set(FILES_CACHE, new Map([['/kanban/files/abcdefgh1', 'bytes']]));
  const markedOut = () => !!cacheStore.get(FILES_STATE)?.has(SIGNED_OUT);
  const settleCaches = () => tick(50);
  try {
    setApiBase(BASE2);
    viewedFile();
    await sync.probe();
    await settleCaches();
    check('no token + 401 from the server → login required, not signed in', sync.status.needsLogin === true && sync.status.signedIn === false, JSON.stringify(sync.status));
    check('...and files cached for offline viewing are dropped and the worker told the device is signed out', !cacheStore.has(FILES_CACHE) && markedOut());
    const offlineCard = actions.addCardFromText('Made before login', 'todo')!;
    await tick(600);
    check('before login the change waits in the outbox', sync.status.pending >= 1, String(sync.status.pending));
    check('a wrong password → invalid, still on the login', (await sync.login('demo', 'nope')) === 'invalid' && sync.status.needsLogin === true);
    const loginResult = await sync.login('demo', PASS2);
    if (loginResult !== 'ok') {
      const r = await realFetch(`${BASE2}/kanban/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo', password: PASS2 }) });
      console.log('  debug direct login', r.status, await r.text(), 'pass', JSON.stringify(PASS2), 'port', PORT2);
    }
    check('the right password → ok', loginResult === 'ok', loginResult);
    check('the signed-in user is remembered on the device', localStorage.getItem('kept.syncUser') === 'demo');
    check('after login: signed in as the user, synced, nothing waiting', sync.status.signedIn && sync.status.user === 'demo' && !sync.status.needsLogin && !!sync.status.syncedAt && sync.status.pending === 0, JSON.stringify(sync.status));
    await settleCaches();
    check('signed in again: the worker may serve cached files', !markedOut());
    // The session expires (cookie gone / revoked): a sync gets the server's 401.
    viewedFile();
    const saved = new Map(jar);
    jar.clear();
    await sync.sync();
    await settleCaches();
    check('an expired session goes to the login and drops the cached files', sync.status.needsLogin === true && !cacheStore.has(FILES_CACHE) && markedOut(), JSON.stringify(sync.status));
    for (const [k, v] of saved) jar.set(k, v);
    await sync.probe();
    await settleCaches();
    check('...and a new session lifts the marker', sync.status.signedIn && !markedOut());
    const srvSnap = await (await realFetch(`${BASE2}/kanban/snapshot`, { headers: basic2 })).json();
    check('local changes made before login reached the server', srvSnap.cards.some((c: any) => c.id === offlineCard.id), String(srvSnap.cards.length));
    check('no request carried an Authorization header; all used credentials same-origin', seen.length > 0 && seen.every((r) => !r.init.headers?.Authorization && r.init.credentials === 'same-origin'));
    await realFetch(`${BASE2}/kanban/push`, { method: 'POST', headers: basic2, body: JSON.stringify({ deviceId: 'Z', actions: [{ id: 'z1', deviceId: 'Z', ts: new Date().toISOString(), type: 'card.put', payload: { card: { id: 'from-z', title: 'From another device', status: 'todo', items: [], labels: [], order: 0 } } }] }) });
    await sync.sync();
    check('the session syncs other devices\' changes', state.board.cards.some((c) => c.id === 'from-z'));
    const { statusLine } = await import('../src/lib/sync-line');
    const { SyncEngine } = await import('../src/lib/sync');
    (globalThis as any).navigator.onLine = false;
    ls.get('offline')?.forEach((fn) => fn({}));
    check('offline: the account stays (user kept) and the line says when it last synced', sync.status.user === 'demo' && /^Offline · last synced (just now|\d+ (min|h|d) ago)$/.test(statusLine(sync.status)), statusLine(sync.status));
    const cold = new SyncEngine(() => [], () => {});
    check('a relaunch offline still knows the last user', cold.status.user === 'demo' && cold.status.online === false);
    (globalThis as any).navigator.onLine = true;
    ls.get('online')?.forEach((fn) => fn({}));
    check('online again: "Synced · …"', /^Synced · /.test(statusLine({ ...sync.status, syncing: false, pending: 0 })), statusLine(sync.status));
    sync.stop();
    await sync.probe();
    check('a relaunch with the cookie: no token + 200 → syncing without a login', sync.status.signedIn && !sync.status.needsLogin);
    await sync.signOut();
    check('sign out forgets the remembered user', localStorage.getItem('kept.syncUser') === null && sync.status.user === null);
    check('sign out clears the cookie, keeps local data and shows the login', jar.size === 0 && sync.status.needsLogin && !sync.status.signedIn && state.board.cards.some((c) => c.id === offlineCard.id));
    await settleCaches();
    check('sign out drops cached files and marks the device signed out', !cacheStore.has(FILES_CACHE) && markedOut());
    setApiBase('http://127.0.0.1:1');
    await sync.probe();
    check('an unreachable server never shows the login', sync.status.needsLogin === false && !sync.status.signedIn);
  } finally {
    globalThis.fetch = realFetch;
    await stopServer(loginSrv);
    fs.rmSync(work2, { recursive: true, force: true });
  }

  // --- signed in, the board is the server's: local-only cards are dropped, never uploaded ---
  const work3 = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-truth-'));
  const TOKEN3 = 'truth-' + Math.random().toString(36).slice(2, 8);
  const truth = await startServer(path.join(ROOT, 'server.js'), { env: { API_TOKEN: TOKEN3, DATA_DIR: work3 } });
  const truthSrv = truth.child;
  const BASE3: string = truth.base;
  const auth3 = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN3}` };
  const snap3 = async () => (await (await fetch(`${BASE3}/kanban/snapshot`, { headers: auth3 })).json()) as { cards: any[]; labels: any[] };
  const t3 = new Date().toISOString();
  await fetch(`${BASE3}/kanban/push`, { method: 'POST', headers: auth3, body: JSON.stringify({ deviceId: 'S', actions: [{ id: 's-1', deviceId: 'S', ts: t3, type: 'card.put', payload: { card: { id: 'server-only', title: 'Server card', notes: '', status: 'todo', order: 0, items: [], labels: [], createdAt: t3, updatedAt: t3, completedAt: null, archivedAt: null, someday: false, repeat: false } } }] }) });
  const { setToken, SyncEngine: Engine } = await import('../src/lib/sync');
  const ids = (cards: any[]) => cards.map((c) => c.id).sort().join();
  try {
    // Device A (the store) holds a cached local board and, like the live Mac, an old cursor.
    const cached = (id: string) => ({ id, title: 'Cached ' + id, notes: '', status: 'todo' as const, order: 0, items: [], labels: [], createdAt: t3, updatedAt: t3, completedAt: null, archivedAt: null, someday: false, repeat: false });
    actions.applyRemote(['c-1', 'c-2', 'c-3', 'c-4'].map(cached), [], null);
    await tick();
    const localIds = state.board.cards.map((c) => c.id);
    check('device A starts with a local board of its own', localIds.length > 3);
    setApiBase(BASE3);
    await sync.signIn(TOKEN3);
    localStorage.setItem('kept.syncCursor', '5');
    await sync.sync();
    let srv = await snap3();
    check('after signing in, device A shows exactly the server board', ids(state.board.cards) === ids(srv.cards) && ids(srv.cards) === 'server-only', ids(state.board.cards));
    check('none of A\'s local-only cards were uploaded', !srv.cards.some((c) => localIds.includes(c.id)));

    // Device B: its own storage and its own old local board.
    sync.stop();
    const aStore = new Map(mem);
    mem.clear();
    let bCards: any[] = [{ id: 'phone-only', title: 'Phone only', notes: '', status: 'todo', order: 0, items: [], labels: [], createdAt: t3, updatedAt: t3, completedAt: null, archivedAt: null, someday: false, repeat: false }];
    let bLabels: any[] = [];
    const devB = new Engine(() => bCards, (cards, labels) => { bCards = cards; bLabels = labels; }, () => bLabels);
    setApiBase(BASE3);
    setToken(TOKEN3);
    devB.rebase();
    await devB.sync();
    srv = await snap3();
    check('device B also shows exactly the server board; its local card is not uploaded', ids(bCards) === ids(srv.cards) && !srv.cards.some((c) => c.id === 'phone-only'));
    bCards = bCards.map((c) => (c.id === 'server-only' ? { ...c, title: 'Edited on B', updatedAt: new Date().toISOString() } : c));
    devB.onLocalChange('update');
    await devB.sync();
    devB.stop();
    mem.clear();
    for (const [k, v] of aStore) mem.set(k, v);
    await sync.sync();
    check('B\'s edit reaches A; both show identical boards', JSON.stringify(state.board.cards.map((c) => [c.id, c.title])) === JSON.stringify(bCards.map((c) => [c.id, c.title])) && state.board.cards[0]?.title === 'Edited on B');
    sync.stop();
  } finally {
    await stopServer(truthSrv);
    fs.rmSync(work3, { recursive: true, force: true });
  }
} catch (e) {
  failures++;
  console.log('  FAIL exception ' + ((e as Error).stack ?? e));
} finally {
  await stopServer(server);
  fs.rmSync(workdir, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
