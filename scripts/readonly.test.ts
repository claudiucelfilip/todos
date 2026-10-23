// View-only link, client side: the store's read-only guard (every action not on the view
// allow-list leaves the board, undo, toast and IndexedDB alone), the window.kanban guard, and the
// SyncEngine as a viewer against the real server (snapshot only, never push / pull / outbox;
// revocation clears the cached board). Run: `npm run test:readonly`.
import 'fake-indexeddb/auto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { startServer, stopServer } from './test-server.mjs';

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
const dataset: Record<string, string> = {};
(globalThis as any).window = win;
(globalThis as any).localStorage = storage;
// A tiny cookie jar shared by fetch (all cookies, like a browser) and document.cookie (non-HttpOnly only).
const jar = new Map<string, { value: string; httpOnly: boolean }>();
const setCookie = (line: string, fromServer: boolean) => {
  const [pair, ...attrs] = line.split(';').map((x) => x.trim());
  const i = pair.indexOf('=');
  const name = pair.slice(0, i);
  const value = pair.slice(i + 1);
  if (attrs.some((a) => /^max-age=0$/i.test(a)) || value === '') jar.delete(name);
  else jar.set(name, { value, httpOnly: fromServer && attrs.some((a) => /^httponly$/i.test(a)) });
};
const doc: any = { documentElement: { style: { setProperty() {} }, setAttribute() {}, getAttribute: () => null, dataset }, querySelector: () => null, addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
Object.defineProperty(doc, 'cookie', {
  get: () => [...jar].filter(([, c]) => !c.httpOnly).map(([k, c]) => `${k}=${c.value}`).join('; '),
  set: (v: string) => setCookie(v, false),
});
(globalThis as any).document = doc;
(globalThis as any).CustomEvent = class { type: string; detail: any; constructor(t: string, i?: any) { this.type = t; this.detail = i?.detail; } };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

// Every request the app makes is logged; cookies go both ways through the jar, as in a browser.
const calls: string[] = [];
const baseFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  calls.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`);
  const cookie = [...jar].map(([k, c]) => `${k}=${c.value}`).join('; ');
  const res = await baseFetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), ...(cookie ? { Cookie: cookie } : {}) } });
  for (const line of res.headers.getSetCookie?.() ?? []) setCookie(line, true);
  return res;
}) as typeof fetch;
const marker = () => /(?:^|; )todos_viewer=1(?:;|$)/.test(doc.cookie);

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log('  ok           ' + name);
  else { failures++; console.log('  FAIL ' + name + ' ' + extra); }
};
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const { actions, state, getToast, undoDepth, setReadOnly, isReadOnly, VIEW_ACTIONS } = await import('../src/hooks/useStore');
const { loadBoard, outboxCount } = await import('../src/lib/db');
const { DEFAULT_SETTINGS } = await import('../src/lib/types');
const { installKanbanAPI } = await import('../src/lib/kanban-api');
const { guardKanbanAPI, API_READS } = await import('../src/lib/readonly');
const fixture = JSON.parse(readFileSync('fixtures/board.json', 'utf8'));
{
  const done = fixture.cards.filter((c: any) => c.completedAt).sort((a: any, b: any) => b.completedAt.localeCompare(a.completedAt));
  done.forEach((c: any, i: number) => { c.completedAt = new Date(Date.now() - (1 + 2 * i) * 86400000).toISOString(); });
}
const idbCards = async () => JSON.stringify((await loadBoard(DEFAULT_SETTINGS)).cards.map((c) => c).sort((a, b) => a.id.localeCompare(b.id)));
const boardJson = () => JSON.stringify(state.board);

let srv: Awaited<ReturnType<typeof startServer>> | null = null;
const OWNER_PASS = 'p-' + Math.random().toString(36).slice(2);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-ro-'));
try {
  // ================= the store guard =================================================
  await actions.init();
  actions.importBoard(fixture, 'replace');
  actions.dismissToast();
  await tick();
  const withItems = state.board.cards.find((c) => c.items.length > 1 && !c.archivedAt)!;
  const done = state.board.cards.find((c) => c.status === 'done' && !c.archivedAt) ?? withItems;
  actions.addCardLink(withItems.id, { title: 'L', url: 'https://example.com/l' });
  actions.addAttachment(withItems.id, { id: 'att-12345678', name: 'a.png', type: 'image/png', size: 3, createdAt: new Date().toISOString() });
  const lbl = actions.createLabel('Home', '#2F80ED', withItems.id)!;
  actions.archiveCard(done.id);
  actions.dismissToast();
  await tick();
  check('there is an undo step before read-only', undoDepth() > 0);

  setReadOnly(true);
  await tick();
  check('read-only: <html data-readonly>', dataset.readonly === 'true');
  check('entering read-only drops the undo stack and the toast', undoDepth() === 0 && getToast() === null);
  const before = boardJson();
  const idbBefore = await idbCards();
  const card = state.board.cards.find((c) => c.id === withItems.id)!;
  const item = card.items[0];
  const archived = state.board.cards.find((c) => c.archivedAt)!;
  // Arguments per action; anything not listed gets the card id. Every action key is exercised.
  const ARGS: Record<string, unknown[]> = {
    addCardFromText: ['Sneaky\nitem', 'todo'],
    addCardsFromGrammar: ['A\n---\nB'],
    updateCardTitle: [card.id, 'Renamed'],
    updateCardNotes: [card.id, 'changed notes'],
    moveCardAction: [card.id, 'done'],
    reorderCard: [card.id, null, 'doing'],
    dropInColumn: [card.id, null, lbl.id],
    nudge: [card.id, 1],
    toggleItem: [card.id, item.id],
    setItemsDone: [card.id, card.items.map((i) => i.id), true],
    addItem: [card.id, 'x'],
    linkCard: [card.id, state.board.cards.find(c => c.id !== card.id && !c.archivedAt && !card.items.some(i => i.ref === c.id))!.id],
    addItemsBatch: [card.id, ['x', 'y']],
    editItem: [card.id, item.id, 'edited'],
    deleteItem: [card.id, item.id],
    moveItem: [card.id, item.id, null],
    nudgeItem: [card.id, item.id, 1],
    setSomeday: [card.id, true],
    restoreCard: [archived.id],
    deleteArchived: [archived.id],
    createLabel: ['Evil', '#123456', card.id],
    updateLabel: [lbl.id, { name: 'Renamed label' }],
    deleteLabel: [lbl.id],
    toggleCardLabel: [card.id, lbl.id],
    setCardLabels: [card.id, []],
    setReminder: [card.id, new Date(Date.now() + 3600000).toISOString()],
    addAttachment: [card.id, { id: 'att-87654321', name: 'b.png', type: 'image/png', size: 3, createdAt: new Date().toISOString() }],
    removeAttachment: [card.id, 'att-12345678'],
    removeCardLink: [card.id, 'https://example.com/l'],
    addCardLink: [card.id, { title: 'M', url: 'https://example.com/m' }],
    importBoard: [{ ...fixture, cards: [] }, 'replace'],
    importText: ['Imported\n- a'],
    applyRemote: [[], [card.id], null],
    undoSnap: [1],
    exportJSON: [],
    archiveExpired: [],
    archiveAllDone: [],
    deleteAllArchived: [],
    dropSeed: [],
    undo: [],
  };
  const denied = Object.keys(actions).filter((k) => !VIEW_ACTIONS.has(k));
  const changedBy: string[] = [];
  for (const k of denied) {
    const snapshotBefore = boardJson();
    (actions as any)[k](...(ARGS[k] ?? [card.id]));
    if (boardJson() !== snapshotBefore || getToast() !== null || undoDepth() !== 0) changedBy.push(k);
  }
  await tick(30);
  check(`all ${denied.length} board-changing actions are no-ops (board, undo, toast)`, changedBy.length === 0 && boardJson() === before, changedBy.join(', '));
  check('…and nothing reached IndexedDB', (await idbCards()) === idbBefore);
  check('the guard covers the actions the spec names', ['addCardFromText', 'deleteCardById', 'toggleCircle', 'moveCardAction', 'reorderCard', 'toggleItem', 'setReminder', 'removeAttachment', 'undo', 'importBoard', 'updateLabel', 'archiveExpired'].every((k) => denied.includes(k)));
  check('denied results keep their shapes', JSON.stringify(actions.addCardsFromGrammar('a')) === '[]' && actions.archiveExpired() === 0 && actions.importBoard(fixture, 'merge') === false && actions.addAttachment(card.id, { id: 'z-12345678', name: 'z', type: 'x/y', size: 1, createdAt: '' }) === false);

  // View actions still work.
  actions.setSomedayOpen(!state.somedayOpen);
  const sd = state.somedayOpen;
  actions.setSomedayOpen(!sd);
  check('Someday expand / collapse works', state.somedayOpen === !sd);
  actions.setLabelFilter([lbl.id]);
  check('label columns work in read-only view', state.labelFilter.join() === lbl.id && actions.visibleColumn(lbl.id).every((c) => c.labels.includes(lbl.id)));
  check('workflow columns stay independent of column selection', actions.visibleColumn(card.status).map((c) => c.id).join() === actions.column(card.status).map((c) => c.id).join());
  actions.setLabelFilter([]);
  const keep = state.board.settings.archiveAfterDays;
  actions.updateSettings({ theme: 'dark', reduceMotion: 'on', archiveAfterDays: keep === 0 ? 7 : 0 });
  check('appearance settings apply; others are ignored', state.board.settings.theme === 'dark' && state.board.settings.reduceMotion === 'on' && state.board.settings.archiveAfterDays === keep, JSON.stringify(state.board.settings));
  actions.updateSettings({ background: 'Plum' });
  check('viewers can change their room background', state.board.settings.background === 'Plum');
  actions.updateSettings({ theme: 'system', reduceMotion: 'system' });
  check('legacy theme selection clears the background override', state.board.settings.background === undefined);
  actions.updateSettings({ studioTheme: 'sky-lemon', studioPattern: 'waves', archiveAfterDays: keep === 0 ? 7 : 0 });
  check('viewers can choose Studio themes and patterns without changing board settings', state.board.settings.studioTheme === 'sky-lemon' && state.board.settings.studioPattern === 'waves' && state.board.settings.archiveAfterDays === keep);
  check('counts / columns read', actions.counts().open >= 0 && Array.isArray(actions.column('todo')));

  // replaceBoard still applies (the snapshot arriving), and an unchanged one changes nothing.
  const cards0 = state.board.cards;
  actions.replaceBoard(JSON.parse(JSON.stringify(cards0)), JSON.parse(JSON.stringify(state.board.labels)));
  check('an unchanged snapshot keeps the same objects (no re-render, no flicker)', state.board.cards === cards0);
  const changed = JSON.parse(JSON.stringify(cards0));
  changed.find((c: any) => c.id === card.id).title = 'From the owner';
  actions.replaceBoard(changed, state.board.labels);
  check('replaceBoard applies a real change', state.board.cards.find((c) => c.id === card.id)!.title === 'From the owner');
  check('…and only that card is a new object', state.board.cards.filter((c, i) => c !== cards0[i]).length === 1);
  await tick(30);
  check('replaceBoard still writes the read cache', (await loadBoard(DEFAULT_SETTINGS)).cards.find((c) => c.id === card.id)?.title === 'From the owner');

  // ================= window.kanban ===================================================
  installKanbanAPI();
  guardKanbanAPI(win.kanban);
  const k = win.kanban;
  check('kanban.list / get / labels / exportText read', k.list().length > 0 && k.get(card.id)?.title === 'From the owner' && k.labels().length > 0 && k.exportText().length > 0);
  const writes = Object.keys(k).filter((key) => typeof k[key] === 'function' && !API_READS.has(key));
  const silent: string[] = [];
  for (const key of writes) {
    try {
      k[key](card.id, 'x', 'y');
      silent.push(key);
    } catch (e) {
      if (!/view only/.test((e as Error).message)) silent.push(`${key}: ${(e as Error).message}`);
    }
  }
  check(`every window.kanban write (${writes.length}) throws "view only"`, silent.length === 0 && writes.includes('addCard') && writes.includes('remove') && writes.includes('attach') && writes.includes('undo'), silent.join(', '));
  check('…and the board is unchanged', state.board.cards.find((c) => c.id === card.id)!.title === 'From the owner');

  setReadOnly(false);
  check('leaving read-only: edits work again', !!actions.addCardFromText('Owner edit', 'todo') && !dataset.readonly);
  check('…and window.kanban writes again', !!k.addCard('Owner API card'));

  // ================= the sync engine as a viewer ========================================
  const TOKEN = 'ro-' + Math.random().toString(36).slice(2, 10);
  srv = await startServer(path.resolve('server.js'), { env: { API_TOKEN: TOKEN, DATA_DIR: dataDir, TODOS_USER: 'o', TODOS_PASS: OWNER_PASS, APP_URL: 'http://127.0.0.1:9' } });
  const bearer = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
  const ts = () => new Date().toISOString();
  const srvCard = (id: string, title: string) => ({ id, title, notes: 'n', status: 'todo', order: 1, items: [{ id: id + '-i', text: 'item', done: false }], labels: [], createdAt: ts(), updatedAt: ts(), completedAt: null, archivedAt: null, someday: false, repeat: false });
  let an = 0;
  const serverPush = (acts: any[]) => baseFetch(`${srv!.base}/kanban/push`, { method: 'POST', headers: bearer, body: JSON.stringify({ deviceId: 'O', actions: acts.map((a) => ({ id: 'o' + ++an, deviceId: 'O', ts: ts(), ...a })) }) });
  await serverPush([{ type: 'card.put', payload: { card: srvCard('s1', 'Server one') } }, { type: 'card.put', payload: { card: srvCard('s2', 'Server two') } }]);
  const share = await (await baseFetch(`${srv.base}/kanban/share`, { method: 'POST', headers: bearer, body: '{}' })).json();
  const serverText = async () => (await baseFetch(`${srv!.base}/kanban/snapshot`, { headers: bearer })).text();

  // A browser that was ever editable here (or another window) left edits and an upload behind.
  const { enqueueActions, saveUpload, loadUploads } = await import('../src/lib/db');
  await enqueueActions([{ id: 'evil-' + Date.now(), deviceId: 'X', ts: ts(), type: 'card.put', payload: { card: srvCard('evil', 'EDITED-BY-VIEWER') } } as any]);
  await saveUpload({ id: 'up-evil-1', cardId: 's1', name: 'x.txt', type: 'text/plain', size: 1, createdAt: ts(), bytes: new ArrayBuffer(1) } as any);
  check('setup: unsent edits and an upload are waiting', (await outboxCount()) === 1 && (await loadUploads()).length === 1);

  // The link: both cookies land in the jar; then localStorage is wiped (the marker is a cookie, it survives).
  const r = await fetch(`${srv.base}/view/${String(share.url).split('/view/')[1]}`); // never the APP_URL host
  check('the link redirects to / and sets the marker', r.status === 302 && r.headers.get('location') === '/' && marker());
  storage.clear?.();
  for (const k of [...mem.keys()]) mem.delete(k);
  const serverBefore = await serverText();
  calls.length = 0;

  const { setApiBase, SYNC_TIMING } = await import('../src/lib/sync');
  SYNC_TIMING.visible = 60000; // this suite syncs by hand
  setApiBase(srv.base);
  const { bootSync, sync } = await import('../src/lib/sync-boot');
  check('marker cookie → read-only before the server is asked (localStorage empty)', isReadOnly() && sync.status.viewer === true && calls.length === 0);
  calls.length = 0;
  bootSync();
  for (let i = 0; i < 100 && !sync.status.syncedAt; i++) await tick(20);
  check('probe: the server says viewer → viewer mode, read-only', sync.status.viewer === true && isReadOnly() && sync.status.user === null, JSON.stringify(sync.status));
  check('everything unsent on the device was discarded (outbox, queued uploads)', (await outboxCount()) === 0 && (await loadUploads()).length === 0 && sync.status.pending === 0);
  check('the board is exactly the server snapshot', state.board.cards.map((c) => c.title).sort().join() === 'Server one,Server two', state.board.cards.map((c) => c.title).join());
  check('nothing was pushed or pulled', !calls.some((c) => /push|pull/.test(c)), calls.join(' | '));

  check('a local edit is refused', actions.addCardFromText('Viewer edit', 'todo') === undefined && !state.board.cards.some((c) => c.title === 'Viewer edit'));
  const s1 = state.board.cards.find((c) => c.id === 's1')!;
  const listBefore = state.board.cards;
  await sync.sync();
  check('an unchanged snapshot changes nothing (same objects)', state.board.cards === listBefore && state.board.cards.find((c) => c.id === 's1') === s1);
  await serverPush([{ type: 'card.put', payload: { card: { ...srvCard('s2', 'Server two, renamed'), updatedAt: ts() } } }]);
  await sync.sync();
  check('an owner edit arrives through the snapshot', state.board.cards.find((c) => c.id === 's2')?.title === 'Server two, renamed');
  check('…and the other card keeps its object', state.board.cards.find((c) => c.id === 's1') === s1);
  check('only session + snapshot were ever requested', calls.every((c) => c === 'GET /kanban/session' || c === 'GET /kanban/snapshot' || c.startsWith('GET /view/')), calls.join(' | '));

  // The owner signs in on this browser after the viewer tried to edit: the server board is untouched.
  const serverMid = await serverText();
  check('owner sign-in from viewer mode', (await sync.login('o', OWNER_PASS)) === 'ok' && !isReadOnly() && sync.status.viewer === false);
  await tick(600);
  check('…starts from the server board: nothing the viewer did was pushed (byte-identical)', (await serverText()) === serverMid && !(await serverText()).includes('EDITED-BY-VIEWER') && serverBefore.length > 0);
  check('…and the marker is gone (the owner\'s device starts editable)', !marker());
  check('…and so is the view cookie: this browser is the owner\'s now', !jar.has('todos_view'));
  await sync.signOut();
  check('signing out leaves a plain signed-out browser (no marker)', !marker());
  // The link again on this browser: a viewer once more.
  await fetch(`${srv.base}/view/${String(share.url).split('/view/')[1]}`);
  check('opening the link again sets the marker', marker());
  await sync.probe();
  for (let i = 0; i < 100 && !(sync.status.viewer && sync.status.syncedAt); i++) await tick(20);
  check('…and the session answers viewer again', sync.status.viewer === true && isReadOnly());

  // Revoked: the cached board goes, "no longer shared" shows (read-only stays), the marker is cleared.
  await baseFetch(`${srv.base}/kanban/share`, { method: 'DELETE', headers: bearer });
  await sync.sync();
  await tick(50);
  check('revoked → unshared, not a login, still read-only', sync.status.unshared === true && sync.status.needsLogin === false && sync.status.viewer === false && isReadOnly(), JSON.stringify(sync.status));
  check('the cached board is cleared (memory and IndexedDB), marker cleared', state.board.cards.length === 0 && (await loadBoard(DEFAULT_SETTINGS)).cards.length === 0 && !marker());
  check('…and nothing unsent is left behind', (await outboxCount()) === 0);
  // Rows forged on the "no longer shared" page (devtools) must not ride along with a later owner sign-in.
  await enqueueActions([{ id: 'evil2-' + Date.now(), deviceId: 'X', ts: ts(), type: 'card.put', payload: { card: srvCard('evil2', 'EDITED-AFTER-REVOKE') } } as any]);
  const serverRevoked = await serverText();
  sync.showLogin();
  check('"Sign in" leads to the normal login', sync.status.needsLogin === true && sync.status.unshared === false && !isReadOnly());
  check('owner sign-in after the link was revoked', (await sync.login('o', OWNER_PASS)) === 'ok' && !isReadOnly());
  await tick(600);
  check('…pushes nothing a viewer left behind (server byte-identical, outbox empty)', (await serverText()) === serverRevoked && !(await serverText()).includes('EDITED-AFTER-REVOKE') && (await outboxCount()) === 0);
  await sync.signOut();

  // A browser that was never a viewer: a 401 is the login, never a wiped board.
  const { SyncEngine } = await import('../src/lib/sync');
  jar.clear();
  let replaced = 0;
  const other = new SyncEngine(() => [], () => { replaced++; }, () => []);
  await other.probe();
  check('no marker + 401 → the login, the cached board is not touched', other.status.needsLogin === true && other.status.unshared === false && replaced === 0);
  // A stale marker with a dead link → "no longer shared", marker cleared.
  doc.cookie = 'todos_viewer=1; Path=/';
  jar.set('todos_view', { value: 'dead-token', httpOnly: true });
  const stale = new SyncEngine(() => [], () => { replaced++; }, () => []);
  check('stale marker: starts as a viewer', stale.status.viewer === true);
  await stale.probe();
  check('stale marker + dead link → "no longer shared", marker cleared', stale.status.unshared === true && stale.status.needsLogin === false && !marker() && replaced === 1);
  // The owner opened their own link on a signed-in device: read-only until the server answers, and nothing of theirs is discarded.
  jar.clear();
  const signIn = new SyncEngine(() => [], () => {}, () => []);
  check('setup: the owner is signed in on this browser', (await signIn.login('o', OWNER_PASS)) === 'ok');
  doc.cookie = 'todos_viewer=1; Path=/';
  let discards = 0;
  const own = new SyncEngine(() => [], () => {}, () => []);
  own.onDiscard = async () => { discards++; };
  check('owner with the marker: starts read-only', own.status.viewer === true);
  await own.probe();
  check('...the server answers owner: editable, marker cleared, unsent edits kept', own.status.viewer === false && !!own.status.user && !marker() && discards === 0, JSON.stringify([own.status.viewer, own.status.user, marker(), discards]));
} catch (e) {
  failures++;
  console.log('  FAIL exception ' + ((e as Error)?.stack ?? e));
} finally {
  if (srv) await stopServer(srv.child);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
