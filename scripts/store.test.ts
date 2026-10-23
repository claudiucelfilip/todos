import { isCardDone } from '../shared/notes.mjs';
// Store behaviour (src/hooks/useStore.ts) under fake-indexeddb + a minimal DOM
// shim: seeding, ordering, toasts (§15.1), undo restore incl. IndexedDB diff,
// Repeat, rejected moves, archive, export/import, storage failure.
// Run: `npm run test:store`.
import 'fake-indexeddb/auto';

// --- DOM shim (only what the store touches) -----------------------------------
const mem = new Map<string, string>();
const storage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
};
const listeners = new Map<string, Set<(e: any) => void>>();
const win: any = {
  addEventListener: (t: string, fn: any) => { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(fn); },
  removeEventListener: (t: string, fn: any) => listeners.get(t)?.delete(fn),
  dispatchEvent: (e: any) => { listeners.get(e.type)?.forEach((fn) => fn(e)); return true; },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: storage,
  sessionStorage: storage,
  location: { hash: '', href: 'http://x/', pathname: '/', search: '' },
  history: { replaceState() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
};
(globalThis as any).window = win;
(globalThis as any).localStorage = storage;
(globalThis as any).sessionStorage = storage;
(globalThis as any).document = {
  documentElement: { dataset: {}, style: { setProperty() {} }, setAttribute() {}, getAttribute: () => null },
  querySelector: () => null,
  addEventListener() {}, removeEventListener() {},
};
(globalThis as any).CustomEvent = class CustomEvent { type: string; detail: any; constructor(t: string, i?: any) { this.type = t; this.detail = i?.detail; } };
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log('  ok           ' + name);
  else { failures++; console.log('  FAIL ' + name + ' ' + extra); }
};
const tick = () => new Promise((r) => setTimeout(r, 5));

const { actions, state, getToast, undoDepth } = await import('../src/hooks/useStore');
const { loadBoard } = await import('../src/lib/db');
const { DEFAULT_SETTINGS } = await import('../src/lib/types');
const fixture = JSON.parse((await import('node:fs')).readFileSync('fixtures/board.json', 'utf8'));
// The fixture's Done dates are fixed; keep them inside the 14-day archive window whatever today is.
{
  const done = fixture.cards.filter((c: any) => c.completedAt).sort((a: any, b: any) => b.completedAt.localeCompare(a.completedAt));
  done.forEach((c: any, i: number) => { c.completedAt = new Date(Date.now() - (1 + 2 * i) * 86400000).toISOString(); });
}

const titles = (status?: string) => state.board.cards.filter((c) => !c.archivedAt && (!status || c.status === status)).map((c) => c.title);
const ordinaryLabels = (c: { labels: string[] }) => c.labels.filter((id) => !id.startsWith('workflow:'));
const find = (title: string) => state.board.cards.find((c) => c.title === title)!;
const idb = async () => (await loadBoard(DEFAULT_SETTINGS)).cards;

// --- §4.5 first launch: seed once, never re-seed -------------------------------
await actions.init();
check('first launch seeds only the Welcome card', titles().join() === 'Welcome. Tap me.' && find('Welcome. Tap me.').items.length === 3, titles().join());
check('the Welcome seed has a per-device random id (not "welcome")', find('Welcome. Tap me.').id !== 'welcome' && find('Welcome. Tap me.').id.length > 8, find('Welcome. Tap me.').id);
actions.deleteCardById(find('Welcome. Tap me.').id);
await tick();
await actions.reload();
check('deleting the Welcome card leaves a clean board on the next launch (no re-seed)', state.board.cards.length === 0, String(state.board.cards.length));
actions.dismissToast();

// --- F4: a device that already has a sync token at first launch does not seed --------
mem.delete('kept.seeded');
storage.setItem('kept.apiToken', 'paired-token');
await actions.reload();
check('first launch with a sync token present skips the Welcome seed (paired device bootstraps from the server)', state.board.cards.length === 0, String(state.board.cards.length));
storage.removeItem('kept.apiToken');
// dropSeed(): removes a never-synced Welcome card silently (no toast, no undo entry)
mem.delete('kept.seeded');
await actions.reload();
check('re-seeded for the test', titles().join() === 'Welcome. Tap me.');
actions.dropSeed();
check('dropSeed removes the lone Welcome card without a toast', state.board.cards.length === 0 && getToast() === null);
mem.delete('kept.seeded');
await actions.reload();
await tick();
const seed = state.board.cards[0];
actions.toggleItem(seed.id, seed.items[0].id);
actions.dropSeed();
check('dropSeed keeps a Welcome card the user already touched', state.board.cards.some((c) => c.id === seed.id));
actions.deleteCardById(seed.id); actions.dismissToast();
const keep = actions.addCardFromText('Keep me', 'todo')!;
actions.dropSeed();
check('dropSeed is a no-op when the board is not just the seed', !!find('Keep me'));
actions.deleteCardById(keep.id); actions.dismissToast();

// --- §7.2 composer: ordering + "Added to Doing" --------------------------------
const milk = actions.addCardFromText('Milk', 'todo')!;
const bread = actions.addCardFromText('Bread', 'todo')!;
check('new cards appear at the top of To do', bread.order < milk.order && milk.status === 'todo');
check('creating a card shows no toast', getToast() === null);
const g = actions.addCardFromText('Groceries\nEggs\n- Spinach\n[x] Lemons', 'todo')!;
check('a list with a checked line typed into To do lands in Doing', g.status === 'doing' && g.items.map((i) => i.text).join() === 'Eggs,Spinach,Lemons' && g.items[2].done);
check('landing elsewhere toasts "Added to Doing"', getToast()?.message === 'Added to Doing', getToast()?.message);
actions.dismissToast();
const notesCard = actions.addCardFromText('Plan\nline one\nline two', 'todo', 'notes')!;
check('notes mode keeps the rest as notes', notesCard.items.length === 0 && notesCard.notes === 'line one\nline two' && notesCard.status === 'todo');

// --- §6 toggles: silent; rejected Doing toasts the hint --------------------------
actions.toggleItem(g.id, g.items[0].id);
check('toggling an item shows no toast', getToast() === null);
actions.checkAllAction(g.id);
check('check all automatically sets Done', find('Groceries').status === 'done');
actions.moveCardAction(g.id, 'doing');
check('fully checked lists may stay in Doing', find('Groceries').status === 'doing');
actions.dismissToast();

// --- §7.6 plain card circle: todo -> done (top of Done, completedAt) -> todo ----
actions.toggleCircle(milk.id);
check('circle on a plain card marks it done with completedAt', find('Milk').status === 'done' && !!find('Milk').completedAt);
check('Done is sorted by completion time, newest first', actions.column('done')[0].title === 'Milk', actions.column('done').map((c) => c.title).join());
actions.toggleCircle(milk.id);
check('circle again returns a plain card to To do (§17)', find('Milk').status === 'todo' && find('Milk').completedAt === null);

// --- §7.8 delete + undo, stacking, IndexedDB diff -------------------------------
actions.deleteCardById(bread.id);
check('delete toasts §15.1 copy', getToast()?.message === "Deleted 'Bread'", getToast()?.message);
actions.deleteCardById(notesCard.id);
check('a second delete stacks into one toast', getToast()?.message === 'Deleted 2 cards', getToast()?.message);
actions.undo();
actions.undo();
await tick();
check('two undos restore both cards in memory', !!find('Bread') && !!find('Plan'));
check('undo writes the restored cards back to IndexedDB', (await idb()).some((c) => c.title === 'Bread'));
actions.dismissToast();

// undo of a create-like action must REMOVE rows from IndexedDB too
actions.importBoard(fixture, 'replace');
await tick();
check('import replace swaps the board', titles().length === 8 && !find('Milk'), String(titles().length));
check('import toasts nothing but is undoable', getToast() !== null && typeof getToast()?.undo === 'function');
actions.undo();
await tick();
const rows = await idb();
check('undoing the import removes the imported rows from IndexedDB', !rows.some((c) => c.title === 'Renew passport') && rows.some((c) => c.title === 'Milk'), rows.map((c) => c.title).join());
actions.dismissToast();

// --- §4.2b Repeat ----------------------------------------------------------------
actions.importBoard(fixture, 'replace');
await tick();
actions.dismissToast();
const groc = find('Groceries');
check('fixture Groceries is a Doing repeat card with 2 of 7', groc.status === 'doing' && groc.repeat && groc.items.filter((i) => i.done).length === 2);
actions.checkAllAction(groc.id);
const copies = state.board.cards.filter((c) => c.title === 'Groceries');
check('completing a Repeat card keeps the original in Done and adds an unchecked copy in To do', copies.length === 2 && copies.some((c) => c.status === 'done') && copies.some((c) => c.status === 'todo' && c.repeat && c.items.every((i) => !i.done)), copies.map((c) => c.status).join());
check('repeat toasts "Groceries is back in To do"', getToast()?.message === 'Groceries is back in To do', getToast()?.message);
actions.dismissToast();

// --- §7.9 duplicate below the original, §4.2a someday --------------------------
const passport = find('Renew passport');
const dupId = actions.duplicate(passport.id)!;
const todo = actions.column('todo').map((c) => c.title);
check('duplicate sits directly below the original in To do, unchecked', todo[todo.indexOf('Renew passport') + 1] === 'Renew passport (copy)' && state.board.cards.find((c) => c.id === dupId)!.items.every((i) => !i.done), todo.join());
actions.toggleSomeday(dupId);
check('someday cards leave the open count', actions.counts().someday === 1 && actions.counts().open === todo.length - 1 + actions.column('doing').length, JSON.stringify(actions.counts()));
actions.toggleItem(dupId, state.board.cards.find((c) => c.id === dupId)!.items[0].id);
check('checking an item un-parks it and starts Doing', !state.board.cards.find((c) => c.id === dupId)!.someday && state.board.cards.find((c) => c.id === dupId)!.status === 'doing');

// --- §7.4 items: after the last unchecked item, item cap copy ------------------
actions.addItemsBatch(passport.id, ['Bread', 'Butter']);
{
  const its = find('Renew passport').items;
  const last = its.map((i) => i.done).lastIndexOf(false);
  check('addItemsBatch appends new items after the last unchecked item in typed order', its[last - 1]?.text === 'Bread' && its[last]?.text === 'Butter', its.map((i) => i.text + (i.done ? '✓' : '')).join());
}
check('a batch of two shows no toast', getToast() === null);
actions.addItemsBatch(passport.id, Array.from({ length: 60 }, (_, i) => 'x' + i));
check('a batch over 50 toasts "Added 60 items"', getToast()?.message === 'Added 60 items', getToast()?.message);
actions.dismissToast();
actions.addItemsBatch(passport.id, Array.from({ length: 600 }, (_, i) => 'y' + i));
check('items cap at 500 with the §15.1 hint', find('Renew passport').items.length === 500 && getToast()?.message === 'This list is full (500 items)', getToast()?.message);
actions.dismissToast();

// --- §7.10 / §6 item removal copy -------------------------------------------------
const rt = find('Read Thinking in Systems');
actions.deleteItem(rt.id, rt.items[0].id);
check('removing an item toasts "Removed ‘…’"', getToast()?.message === "Removed 'Chapter 1 — systems thinking'", getToast()?.message);
actions.undo();
actions.dismissToast();
actions.clearChecked(rt.id);
check('clear checked toasts the count', getToast()?.message === 'Cleared 1 item', getToast()?.message);
actions.dismissToast();

// --- §7.11 archive ------------------------------------------------------------------
const doneBefore = actions.column('done').length;
actions.archiveAllDone();
check('archive all toasts the count and empties Done', getToast()?.message === `Archived ${doneBefore} cards` && actions.column('done').length === 0, getToast()?.message);
const archived = state.board.cards.filter((c) => c.archivedAt);
actions.restoreCard(archived[0].id);
check('restore returns a card to Done', state.board.cards.find((c) => c.id === archived[0].id)!.archivedAt === null && state.board.cards.find((c) => c.id === archived[0].id)!.status === 'done');
actions.dismissToast();

// --- §7.13 export ---------------------------------------------------------------------
const json = actions.exportJSON();
const parsed = JSON.parse(json);
check('export is the whole board as v1 JSON', parsed.schemaVersion === 1 && Array.isArray(parsed.cards) && parsed.cards.length === state.board.cards.length);
check('export stamps lastBackupAt', !!state.board.settings.lastBackupAt);
check('export filename is kanban-YYYY-MM-DD.json', /^kanban-\d{4}-\d{2}-\d{2}\.json$/.test(actions.exportFilename()));
check('import of a non-board is refused', actions.importBoard({ nope: 1 }, 'replace') === false && getToast()?.message === "That file isn't a board export.", getToast()?.message);
actions.dismissToast();

// --- D1: hover pauses the toast timer, not just the drain ------------------------
actions.showToast('pausable', { ms: 120 });
actions.pauseToast();
await new Promise((r) => setTimeout(r, 200));
check('a paused toast does not expire', getToast()?.message === 'pausable');
actions.resumeToast();
await new Promise((r) => setTimeout(r, 200));
check('a resumed toast expires after its remaining time', getToast() === null);

// --- §15.1 additions: check all / uncheck all toast with Undo --------------------
const rt2 = find('Read Thinking in Systems');
actions.checkAllAction(rt2.id);
check('check all toasts "Checked N items" with Undo', getToast()?.message === `Checked ${rt2.items.filter((i) => !i.done).length} items` && typeof getToast()?.undo === 'function', getToast()?.message);
actions.dismissToast();
actions.uncheckAllAction(rt2.id);
check('uncheck all toasts "Unchecked N items" with Undo', getToast()?.message === `Unchecked ${rt2.items.length} items` && typeof getToast()?.undo === 'function', getToast()?.message);
actions.dismissToast();

// --- duplicate of a Someday card stays in the Someday group, directly below ---------
const idea = find('Idea: weekly review template');
actions.toggleSomeday(idea.id);
const dupSd = actions.duplicate(idea.id)!;
const sdCards = actions.column('todo').filter((c) => c.someday).map((c) => c.id);
check('duplicate of a Someday card is Someday and sits directly below the original', sdCards.indexOf(dupSd) === sdCards.indexOf(idea.id) + 1, JSON.stringify(sdCards));
actions.toggleSomeday(idea.id); actions.toggleSomeday(dupSd);

// --- Someday divider: moves across it, counts, keyboard, the menu toggle ------------------
{
  const byId = (id: string) => state.board.cards.find((c) => c.id === id)!;
  const regions = () => {
    const col = actions.column('todo');
    return { active: col.filter((c) => !c.someday).map((c) => c.id), someday: col.filter((c) => c.someday).map((c) => c.id) };
  };
  const a = actions.addCardFromText('Div A', 'todo')!.id;
  const b = actions.addCardFromText('Div B', 'todo')!.id;
  const c = actions.addCardFromText('Div C', 'todo')!.id;
  const openBefore = actions.counts().open;
  const todoBefore = actions.counts().todo;
  actions.reorderCard(b, null, 'todo', true);
  check('dropping below the divider parks the card in Someday', byId(b).someday && regions().someday.at(-1) === b, JSON.stringify(regions()));
  check('Someday cards leave the To do count and the open count', actions.counts().todo === todoBefore - 1 && actions.counts().open === openBefore - 1 && actions.counts().someday >= 1, JSON.stringify(actions.counts()));
  actions.reorderCard(c, b, 'todo', true);
  check('ordering within Someday: dropped before another Someday card', regions().someday.indexOf(c) === regions().someday.indexOf(b) - 1, JSON.stringify(regions()));
  actions.reorderCard(c, a, 'todo', false);
  check('dropping above the divider un-parks it, before the target', !byId(c).someday && regions().active.indexOf(c) === regions().active.indexOf(a) - 1, JSON.stringify(regions()));

  // A Doing card dropped into Someday goes to To do + Someday.
  actions.moveCardAction(a, 'doing');
  actions.reorderCard(a, b, 'todo', true);
  check('a Doing card dropped into Someday lands in To do, parked, before the target', byId(a).status === 'todo' && byId(a).someday && regions().someday.indexOf(a) === regions().someday.indexOf(b) - 1, JSON.stringify(regions()));
  actions.reorderCard(a, null, 'done');
  check('moving a parked card to Done clears Someday', byId(a).status === 'done' && !byId(a).someday);

  // ⌘↓ from the last active card crosses the divider; ⌘↑ from the first Someday card comes back.
  const lastActive = regions().active.at(-1)!;
  actions.nudge(lastActive, 1);
  check('⌘↓ on the last active card moves it to the top of Someday', byId(lastActive).someday && regions().someday[0] === lastActive, JSON.stringify(regions()));
  actions.nudge(lastActive, -1);
  check('⌘↑ on the first Someday card moves it back to the bottom of To do', !byId(lastActive).someday && regions().active.at(-1) === lastActive, JSON.stringify(regions()));
  actions.reorderCard(c, null, 'todo', true);
  const sdFirst = regions().someday[0];
  actions.nudge(sdFirst, 1);
  check('⌘↓ within Someday swaps with the next Someday card', regions().someday[1] === sdFirst && byId(sdFirst).someday, JSON.stringify(regions()));
  actions.moveToTop(sdFirst);
  check('Move to top on a Someday card tops Someday (it stays parked)', regions().someday[0] === sdFirst && byId(sdFirst).someday);

  // The card menu / S key: Move to Someday / Move out of Someday.
  actions.moveCardAction(c, 'doing');
  actions.setSomeday(c, true);
  check('Move to Someday on a Doing card: To do, top of Someday', byId(c).status === 'todo' && byId(c).someday && regions().someday[0] === c, JSON.stringify(regions()));
  actions.toggleSomeday(c);
  check('Move out of Someday: bottom of the active cards', !byId(c).someday && regions().active.at(-1) === c, JSON.stringify(regions()));
  actions.setSomeday(c, false);
  check('Move out on an active card is a no-op', !byId(c).someday && regions().active.at(-1) === c);

  // Reminders: a parked card keeps remindAt; leaving after the time marks it missed.
  const past = new Date(Date.now() - 60000).toISOString();
  actions.setReminder(b, past);
  check('a Someday card keeps its reminder time', byId(b).remindAt === past && byId(b).someday);
  actions.moveCardAction(b, 'doing');
  check('leaving Someday after the time: missed (remindedAt = remindAt), not sent late', byId(b).remindedAt === past && !byId(b).someday);
  // Keyboard navigation skips parked cards while Someday is collapsed (one shared, per-device flag).
  actions.setSomeday(c, true);
  check('Someday starts open', state.somedayOpen === true);
  check('open: keyboard order includes parked cards after the active ones', actions.navColumn('todo').map((x) => x.id).join() === actions.visibleColumn('todo').map((x) => x.id).join());
  actions.setSomedayOpen(false);
  check('collapse is stored per device', state.somedayOpen === false && localStorage.getItem('kept.somedayOpen') === '0');
  check('collapsed: keyboard order skips every parked card', actions.navColumn('todo').every((x) => !x.someday) && actions.navColumn('todo').length === actions.visibleColumn('todo').filter((x) => !x.someday).length);
  check('other columns are unaffected', actions.navColumn('doing').length === actions.visibleColumn('doing').length);
  actions.setSomedayOpen(true);
  check('expand restores them and stores 1', actions.navColumn('todo').some((x) => x.someday) && localStorage.getItem('kept.somedayOpen') === '1');
  for (const id of [a, b, c]) actions.deleteCardById(id);
  actions.dismissToast();
}

// --- resync without changes is invisible: replaceBoard keeps objects and emits nothing ------------
{
  actions.addCardFromText('Stable one');
  actions.addCardFromText('Stable two\nitem');
  await tick();
  const before = state.board.cards;
  const beforeLabels = state.board.labels;
  // What a pull hands over: equal data, fresh objects, keys in another order.
  const shuffle = (o: any): any => (Array.isArray(o) ? o.map(shuffle) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [k, shuffle(v)])) : o);
  const fresh = JSON.parse(JSON.stringify(before)).map(shuffle).reverse();
  let notified = 0;
  const off = () => { notified++; };
  win.addEventListener('kanban:change', off);
  actions.replaceBoard(fresh, JSON.parse(JSON.stringify(beforeLabels)));
  await tick();
  check('an identical board (other key order, new objects): same array, same labels, no change event', state.board.cards === before && state.board.labels === beforeLabels && notified === 0, `notified ${notified}`);
  const changed = fresh.map((c: any) => (c.title === 'Stable one' ? { ...c, title: 'Stable one (edited)', updatedAt: new Date().toISOString() } : c));
  actions.replaceBoard(changed, JSON.parse(JSON.stringify(beforeLabels)));
  await tick();
  const two = before.find((c) => c.title === 'Stable two')!;
  check('one remote edit: only that card is a new object; every other card keeps its identity', state.board.cards.find((c) => c.id === two.id) === two && state.board.cards.filter((c) => !before.includes(c)).map((c) => c.title).join() === 'Stable one (edited)' && notified === 1, `notified ${notified}`);
  check('...and the board keeps its order (no reshuffle from the server list)', state.board.cards.map((c) => c.id).join() === before.map((c) => c.id).join());
  win.removeEventListener('kanban:change', off);
  const { seenCards } = await import('../src/lib/seen');
  actions.replaceBoard([...state.board.cards, { ...before[0], id: 'boot-new', title: 'From bootstrap' }], state.board.labels, true);
  check('a silent replace (bootstrap / login) marks new cards as already seen: no entrance', seenCards.has('boot-new'));
  for (const t of ['Stable one (edited)', 'Stable two', 'From bootstrap']) { const c = state.board.cards.find((x) => x.title === t); if (c) actions.deleteCardById(c.id); }
  actions.dismissToast();
}

// --- checklist reorder: drag / ⌥↑↓ within a group, synced as items order -----------------------
{
  const c = actions.addCardFromText('Reorder me\nOne\nTwo\nThree\nFour')!;
  const get = () => state.board.cards.find((x) => x.id === c.id)!;
  const order = () => get().items.map((i) => i.text).join();
  const idOf = (t: string) => get().items.find((i) => i.text === t)!.id;
  actions.moveItem(c.id, idOf('Three'), idOf('One'));
  check('moveItem puts an item before another', order() === 'Three,One,Two,Four', order());
  actions.toggleItem(c.id, idOf('Two'));
  actions.toggleItem(c.id, idOf('Four'));
  actions.moveItem(c.id, idOf('Four'), idOf('Two'));
  check('...ticked items move the same way', order() === 'Three,One,Four,Two', order());
  actions.moveItem(c.id, idOf('Three'), idOf('Four'));
  check('an unticked item can land among ticked ones and keeps its state', order() === 'One,Three,Four,Two' && !get().items.find((i) => i.text === 'Three')!.done, order());
  actions.nudgeItem(c.id, idOf('One'), 1);
  check('nudgeItem moves one step', order() === 'Three,One,Four,Two', order());
  actions.nudgeItem(c.id, idOf('One'), 1);
  check('...and past a ticked item (ticked items stay in place, no groups)', order() === 'Three,Four,One,Two', order());
  check('ticking starts Doing and reordering preserves it', get().status === 'doing');
  actions.deleteCardById(c.id);
  actions.dismissToast();
}

// --- attachments: attach / remove / undo, the offline upload queue -------------------------
{
  const { uploads, setUploadTransport } = await import('../src/lib/uploads');
  const { loadUploads } = await import('../src/lib/db');
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let mode: 'ok' | 'down' | 'big' = 'ok';
  setUploadTransport(async ({ url, headers, onProgress }) => {
    calls.push({ url, headers });
    onProgress?.(0.5);
    if (mode === 'down') return { status: 0, body: null };
    if (mode === 'big') return { status: 413, body: { error: 'file_too_large', maxBytes: 25 } };
    if (url.endsWith('/thumb')) return { status: 200, body: { ok: true } };
    return { status: 200, body: { id: headers['X-File-Id'], name: decodeURIComponent(headers['X-Filename']), type: headers['Content-Type'], size: 3, url: `/kanban/files/${headers['X-File-Id']}` } };
  });
  await uploads.init();
  const host = actions.addCardFromText('With files')!;
  const find = () => state.board.cards.find((c) => c.id === host.id)!;
  const u1 = await uploads.add(host.id, new Blob(['abc'], { type: 'text/plain' }), 'notes one.txt');
  check('attach uploads with the name, type and a client file id', calls[0]?.url.endsWith('/kanban/files') && calls[0].headers['X-Filename'] === encodeURIComponent('notes one.txt') && calls[0].headers['Content-Type'] === 'text/plain' && calls[0].headers['X-File-Id'] === u1.id, JSON.stringify(calls[0]));
  check('...and the card carries the attachment once it landed', find().attachments?.length === 1 && find().attachments![0].id === u1.id && find().attachments![0].name === 'notes one.txt' && find().attachments![0].size === 3);
  check('nothing left in the queue', uploads.list(host.id).length === 0 && (await loadUploads()).length === 0);
  actions.dismissToast();
  actions.removeAttachment(host.id, u1.id);
  check('remove drops it and offers Undo', !find().attachments && getToast()?.message === "Removed 'notes one.txt'" && !!getToast()?.undo, getToast()?.message);
  getToast()!.undo!();
  check('Undo brings it back', find().attachments?.[0]?.id === u1.id);
  actions.dismissToast();

  // Offline: queued in IndexedDB, shown as pending, uploaded on reconnect.
  (globalThis as any).navigator.onLine = false;
  const n0 = calls.length;
  const u2 = await uploads.add(host.id, new Blob(['xyz'], { type: 'image/png' }), 'shot.png');
  check('offline: the upload waits in the queue (pending), not on the card', u2.state === 'queued' && uploads.list(host.id).length === 1 && find().attachments!.length === 1 && calls.length === n0);
  check('...persisted in IndexedDB (survives a reload)', (await loadUploads()).some((r) => r.id === u2.id && r.name === 'shot.png'));
  (globalThis as any).navigator.onLine = true;
  listeners.get('online')?.forEach((fn) => fn({}));
  await uploads.idle();
  check('back online: it uploads and lands on the card', find().attachments!.some((a) => a.id === u2.id) && (await loadUploads()).length === 0 && uploads.list(host.id).length === 0);

  // A failure keeps it (retry); too large never retries.
  mode = 'down';
  const u3 = await uploads.add(host.id, new Blob(['q']), 'flaky.bin');
  check('a failed upload stays, marked failed', uploads.list(host.id)[0]?.state === 'failed' && uploads.list(host.id)[0].id === u3.id);
  mode = 'ok';
  await uploads.retry(u3.id);
  check('retry uploads it', find().attachments!.some((a) => a.id === u3.id) && uploads.list(host.id).length === 0);
  mode = 'big';
  const u4 = await uploads.add(host.id, new Blob(['q']), 'huge.mov');
  check('413: failed with a clear reason', uploads.list(host.id)[0]?.state === 'failed' && uploads.list(host.id)[0].error === 'file_too_large');
  mode = 'ok';
  const n1 = calls.length;
  listeners.get('online')?.forEach((fn) => fn({}));
  await uploads.idle();
  check('...and is not retried on its own', calls.length === n1 && uploads.list(host.id).length === 1);
  uploads.cancel(u4.id);
  await uploads.idle();
  check('cancel drops it from the queue', uploads.list(host.id).length === 0 && !(await loadUploads()).some((r) => r.id === u4.id));

  // The card is deleted while the file waits: the upload is dropped, nothing re-creates the card.
  (globalThis as any).navigator.onLine = false;
  const gone = actions.addCardFromText('Short-lived')!;
  await uploads.add(gone.id, new Blob(['z']), 'z.txt');
  actions.deleteCardById(gone.id);
  actions.dismissToast();
  (globalThis as any).navigator.onLine = true;
  listeners.get('online')?.forEach((fn) => fn({}));
  await uploads.idle();
  check('an upload for a deleted card is dropped', !state.board.cards.some((c) => c.id === gone.id) && (await loadUploads()).length === 0);
  const dupAtt = actions.duplicate(host.id)!;
  check('duplicate keeps the attachments', state.board.cards.find((c) => c.id === dupAtt)!.attachments!.length === find().attachments!.length);
  actions.deleteCardById(dupAtt);
  actions.deleteCardById(host.id);
  actions.dismissToast();
}

// --- §13.4 storage failure ----------------------------------------------------------
actions._failWrites(true);
const c2 = actions.addCardFromText('Offline thought', 'todo')!;
await tick();
check('a failed write flags storageFailed and keeps the card in memory', state.storageFailed === true && !!find('Offline thought'));
actions._failWrites(false);
await actions.retryWrites();
check('retry clears the flag and persists', state.storageFailed === false && (await idb()).some((c) => c.id === c2.id));

// --- labels: create / edit / delete with undo; card toggles; filter; composer ----------
{
  actions.dismissToast();
  check('the board always has the built-in Sherlock label', state.board.labels.some((l) => l.id === 'sherlock' && l.name === 'Sherlock' && l.color === '#7C5CFF'));
  const card = actions.addCardFromText('Label me', 'todo')!;
  const work = actions.createLabel('  Work  ', '#2E9E6B', card.id)!;
  check('createLabel trims the name and applies it to the card in one write', work.name === 'Work' && ordinaryLabels(find('Label me')).join() === work.id);
  check('createLabel with a taken name reuses the label', actions.createLabel('work')!.id === work.id && state.board.labels.filter((l) => l.name === 'Work').length === 1);
  actions.undo();
  check('undo of create+apply removes the label and the card label', !state.board.labels.some((l) => l.id === work.id) && ordinaryLabels(find('Label me')).length === 0);
  const home = actions.createLabel('Home')!;
  check('a label without a color gets a palette color', /^#[0-9A-F]{6}$/i.test(home.color));
  actions.updateLabel(home.id, { name: 'House', color: '#123456' });
  check('updateLabel renames and recolors', state.board.labels.find((l) => l.id === home.id)?.name === 'House' && state.board.labels.find((l) => l.id === home.id)?.color === '#123456');
  actions.updateLabel(home.id, { color: 'blue' });
  check('updateLabel ignores an invalid color', state.board.labels.find((l) => l.id === home.id)?.color === '#123456');
  actions.undo();
  check('undo reverts a label edit', state.board.labels.find((l) => l.id === home.id)?.name === 'Home');

  actions.toggleCardLabel(card.id, home.id);
  actions.toggleCardLabel(card.id, 'sherlock');
  check('toggleCardLabel adds labels in order', ordinaryLabels(find('Label me')).join() === `${home.id},sherlock`);
  actions.toggleCardLabel(card.id, home.id);
  check('toggleCardLabel removes a label', ordinaryLabels(find('Label me')).join() === 'sherlock');
  actions.undo();
  check('undo reverts a card label toggle', ordinaryLabels(find('Label me')).join() === `${home.id},sherlock`);
  actions.toggleCardLabel(card.id, 'nope');
  check('toggleCardLabel ignores unknown labels', ordinaryLabels(find('Label me')).join() === `${home.id},sherlock`);

  const other = actions.addCardFromText('Also home', 'doing')!;
  actions.toggleCardLabel(other.id, home.id);
  actions.dismissToast();
  const depth = undoDepth();
  actions.deleteLabel(home.id);
  check('deleteLabel strips it from every card in one undoable write', !state.board.labels.some((l) => l.id === home.id) && ordinaryLabels(find('Label me')).join() === 'sherlock' && ordinaryLabels(find('Also home')).length === 0 && undoDepth() === Math.min(depth + 1, 10));
  check('deleteLabel toasts "Deleted label" with Undo', getToast()?.message === "Deleted label 'Home'" && !!getToast()?.undo);
  await tick();
  check('the stripped cards are persisted', ordinaryLabels((await idb()).find((c) => c.id === other.id)!).length === 0);
  getToast()!.undo!();
  check('undo restores the label and every card label', state.board.labels.some((l) => l.id === home.id) && ordinaryLabels(find('Also home')).join() === home.id && ordinaryLabels(find('Label me')).join() === `${home.id},sherlock`);
  await tick();
  check('labels persist to IndexedDB', (await loadBoard(DEFAULT_SETTINGS)).labels.some((l) => l.id === home.id));
  actions.deleteLabel('sherlock');
  check('the built-in label cannot be deleted', state.board.labels.some((l) => l.id === 'sherlock'));
  actions.dismissToast();

  // Filter: device-local, persisted, drops unknown ids; the composer applies it to new cards.
  actions.setLabelFilter([home.id, 'ghost']);
  check('setLabelFilter keeps only known ids', state.labelFilter.join() === home.id);
  await tick();
  const { loadLabelFilter } = await import('../src/lib/db');
  check('the filter persists per device', (await loadLabelFilter()).join() === home.id);
  const fc = actions.addCardFromText('Filtered new', 'todo', 'checklist', state.labelFilter)!;
  check('a card created with filter labels carries them', ordinaryLabels(fc).join() === home.id);
  actions.deleteLabel(home.id);
  check('deleting a filtered label drops it from the filter', state.labelFilter.length === 0);
  actions.undo();
  const temp = actions.createLabel('Temp')!;
  actions.setLabelFilter([temp.id]);
  actions.undo();
  check('undoing a filtered label\'s creation drops it from the filter', state.labelFilter.length === 0);
  actions.setLabelFilter([]);

  // Links: remove is undoable and toasts.
  const withLink = actions.addCardFromText('Linked', 'todo')!;
  actions.addCardLink(withLink.id, { title: 'Spec', url: 'https://spec.test/a' });
  actions.addCardLink(withLink.id, { title: '', url: 'https://spec.test/b' });
  actions.addCardLink(withLink.id, { title: 'dup', url: 'https://spec.test/a' });
  check('addCardLink appends, deduped by url', find('Linked').links?.map((l) => l.url).join() === 'https://spec.test/a,https://spec.test/b');
  actions.removeCardLink(withLink.id, 'https://spec.test/a');
  check('removeCardLink removes and toasts with Undo', find('Linked').links?.length === 1 && getToast()?.message === "Removed link 'Spec'" && !!getToast()?.undo);
  actions.undo();
  check('undo restores the link', find('Linked').links?.length === 2);
  actions.dismissToast();

  // Remote label lists replace the local one (built-in kept).
  actions.applyRemote([], [], [{ id: 'r1', name: 'Remote', color: '#654321', updatedAt: new Date().toISOString() }]);
  check('applyRemote with labels replaces the list and keeps the built-in', state.board.labels.some((l) => l.id === 'r1') && state.board.labels.some((l) => l.id === 'sherlock') && !state.board.labels.some((l) => l.id === home.id));
}

// --- undo reverts only what the undone action touched; remote changes survive ---------
{
  actions.dismissToast();
  const now = () => new Date().toISOString();
  const remote = (id: string, title: string) => ({ id, title, notes: '', status: 'todo' as const, order: 50, items: [], labels: [], createdAt: now(), updatedAt: now(), completedAt: null, archivedAt: null, someday: false, repeat: false });
  const made = actions.createLabel('Undo me')!;
  actions.applyRemote([remote('remote-1', 'Arrived from sync')], [], null);
  actions.undo();
  check('undo after a remote card arrives: the remote card survives', !!state.board.cards.find((c) => c.id === 'remote-1'));
  check('undo still reverts the local action (label gone)', !state.board.labels.some((l) => l.id === made.id));
  await tick();
  check('the surviving remote card stays in IndexedDB', (await idb()).some((c) => c.id === 'remote-1'));

  const tgt = actions.addCardFromText('Undo target', 'todo')!;
  const lab = actions.createLabel('Stable')!;
  actions.toggleCardLabel(tgt.id, lab.id);
  const renamed = state.board.labels.map((l) => (l.id === lab.id ? { ...l, name: 'Renamed remotely', updatedAt: now() } : l));
  actions.applyRemote([], [], renamed);
  actions.undo();
  check('undo after a remote label rename: the rename survives', state.board.labels.find((l) => l.id === lab.id)?.name === 'Renamed remotely');
  check('undo reverted the card label toggle', ordinaryLabels(find('Undo target')).length === 0);

  const del = actions.addCardFromText('Delete me', 'todo')!;
  actions.deleteCardById(del.id);
  actions.applyRemote([remote('remote-2', 'Second arrival')], [], null);
  const edited = { ...find('Arrived from sync'), title: 'Edited remotely', updatedAt: now() };
  actions.applyRemote([edited], [], null);
  actions.undo();
  check('undo of a delete restores the card and keeps later remote edits', !!find('Delete me') && !!find('Second arrival') && !!find('Edited remotely'));
  actions.dismissToast();

  const rep = actions.addCardFromText('Repeat undo\nOne', 'todo')!;
  actions.toggleRepeat(rep.id);
  const before = state.board.cards.length;
  actions.setCardDone(rep.id, true);
  check('completing a Repeat card spawned its copy', state.board.cards.length === before + 1);
  actions.undo();
  check('undo removes the copy a Repeat card spawned (a creation is deleted on undo)', state.board.cards.length === before && find('Repeat undo').status === 'todo');
  actions.dismissToast();
}

// --- undo restores only the fields / items the action changed on a card -----------------
{
  actions.dismissToast();
  const now = () => new Date().toISOString();
  const base = { id: 'ext-1', title: 'Test brief', notes: '', status: 'todo' as const, order: 60, labels: [], createdAt: now(), updatedAt: now(), completedAt: null, archivedAt: null, someday: false, repeat: false,
    items: [{ id: 'x1', text: 'One', done: false }, { id: 'x2', text: 'Two', done: false }, { id: 'x3', text: 'Three', done: false }],
    links: [{ title: 'First', url: 'https://t.test/1' }], ext: { key: 'brief', seenLinks: ['https://t.test/1'] } };
  actions.applyRemote([base], [], null);
  const brief = actions.createLabel('Brief', undefined, 'ext-1')!;
  check('create + apply put the label on the card', ordinaryLabels(find('Test brief')).join() === brief.id);
  const cur = find('Test brief');
  actions.applyRemote([{ ...cur, links: [...cur.links!, { title: 'Later', url: 'https://t.test/later' }], ext: { key: 'brief', seenLinks: ['https://t.test/1', 'https://t.test/later'] }, notes: 'remote notes', updatedAt: now() }], [], null);
  actions.undo();
  const after = find('Test brief');
  check('undo reverts the field the action changed (labels) and the label itself', after.labels.length === 0 && !state.board.labels.some((l) => l.id === brief.id));
  check('undo keeps later remote links, ext.seenLinks and notes on the same card', after.links?.length === 2 && after.ext?.seenLinks?.length === 2 && after.notes === 'remote notes', JSON.stringify(after));

  actions.deleteItem('ext-1', 'x1');
  const mid = find('Test brief');
  actions.applyRemote([{ ...mid, status: 'doing', items: mid.items.map((i) => (i.id === 'x2' ? { ...i, done: true } : i)), updatedAt: now() }], [], null);
  check('the remote check moved the card to Doing', find('Test brief').status === 'doing');
  actions.undo();
  const it = find('Test brief');
  check('undo restores the deleted item in place and keeps the remote check', it.items.map((i) => i.id).join() === 'x1,x2,x3' && it.items.find((i) => i.id === 'x2')!.done, JSON.stringify(it.items));
  check('status stays derived from the items after undo (Doing)', it.status === 'doing');

  const plain = actions.addCardFromText('Plain for undo', 'todo')!;
  actions.moveCardAction(plain.id, 'done');
  actions.archiveCard(plain.id);
  const archived = find('Plain for undo');
  actions.applyRemote([{ ...archived, title: 'Renamed remotely', updatedAt: now() }], [], null);
  actions.undo();
  const un = state.board.cards.find((c) => c.id === plain.id)!;
  check('undo of archive clears archivedAt but keeps a later remote rename', un.archivedAt === null && un.title === 'Renamed remotely', JSON.stringify(un));
  actions.dismissToast();
}

// --- reminders: set / change / clear, all undoable ----------------------------------------
{
  actions.dismissToast();
  const r = actions.addCardFromText('Call the dentist', 'todo')!;
  const t1 = new Date(Date.now() + 3600000).toISOString();
  actions.setReminder(r.id, t1);
  check('setReminder stores remindAt (UTC ISO) and no remindedAt', find('Call the dentist').remindAt === t1 && find('Call the dentist').remindedAt === null);
  actions.undo();
  check('undo clears a new reminder', find('Call the dentist').remindAt === null);
  actions.setReminder(r.id, t1);
  actions.applyRemote([{ ...find('Call the dentist'), remindedAt: new Date(Date.now() + 3700000).toISOString() }], [], null);
  const t2 = new Date(Date.now() + 7200000).toISOString();
  actions.setReminder(r.id, t2);
  check('changing remindAt re-arms (clears remindedAt)', find('Call the dentist').remindAt === t2 && find('Call the dentist').remindedAt === null);
  actions.setReminder(r.id, null);
  check('clearing a reminder', find('Call the dentist').remindAt === null);
  check('clearing shows "Reminder cleared" with Undo', getToast()?.message === 'Reminder cleared' && !!getToast()?.undo);
  getToast()!.undo!();
  check('the toast\'s Undo restores the reminder', find('Call the dentist').remindAt === t2);
  actions.setReminder(r.id, null);
  actions.undo();
  check('undo brings a cleared reminder back', find('Call the dentist').remindAt === t2);
  actions.setReminder(r.id, 'not a date');
  check('an invalid time is ignored', find('Call the dentist').remindAt === t2);

  // repeat
  const dentist = () => find('Call the dentist');
  actions.setRemindEvery(dentist().id, 'day');
  check('setRemindEvery stores the repeat and keeps a pending time', dentist().remindEvery === 'day' && dentist().remindAt === t2);
  actions.undo();
  check('undo removes the repeat', !dentist().remindEvery && dentist().remindAt === t2);
  actions.setRemindEvery(dentist().id, 'yearly' as never);
  check('an unknown repeat is ignored', !dentist().remindEvery);
  const { dueAt } = await import('../shared/repeat.mjs');
  const sentAt = new Date(Date.now() - 2 * 86400000).toISOString();
  actions.applyRemote([{ ...dentist(), remindAt: sentAt, remindedAt: new Date(Date.parse(sentAt) + 1000).toISOString() }], [], null);
  actions.setRemindEvery(dentist().id, 'week');
  const dueWeek = dueAt(dentist())!;
  check('repeat on a reminder already sent: pending again at its next slot, anchor kept', dentist().remindEvery === 'week' && dentist().remindAt === sentAt && Date.parse(dueWeek) > Date.now() && new Date(dueWeek).getDay() === new Date(sentAt).getDay(), JSON.stringify([dentist().remindAt, dentist().remindedAt, dueWeek]));
  actions.setRemindEvery(dentist().id, null);
  check('back to once: a single reminder at that upcoming slot', !dentist().remindEvery && dentist().remindAt === dueWeek && dentist().remindedAt === null);
  actions.undo();
  check('undo brings the repeat and its anchor back', dentist().remindEvery === 'week' && dentist().remindAt === sentAt);
  // Undo out of Done after the time passed: never a late push (the reminder waits for its next slot).
  {
    const u = actions.addCardFromText('Water the plants\nFill the can', 'todo')!;
    actions.setReminder(u.id, new Date(Date.now() + 3600000).toISOString());
    actions.setRemindEvery(u.id, 'day');
    actions.setCardDone(u.id, true); // its own undo step
    // Its time passes while it rests in Done (here: the anchor moves into the past).
    actions.applyRemote([{ ...find('Water the plants'), remindAt: new Date(Date.now() - 60000).toISOString() }], [], null);
    check('a Done repeating card past its time is unsent and resting', find('Water the plants').status === 'done' && Date.parse(dueAt(find('Water the plants'))!) < Date.now());
    actions.undo();
    const back = find('Water the plants');
    check('undo out of Done past the time: it waits for the next slot (no late push)', back.status === 'todo' && Date.parse(dueAt(back)!) > Date.now(), JSON.stringify([back.status, back.remindAt, back.remindedAt]));
  }
  actions.setReminder(dentist().id, null);
  check('clearing the reminder clears the repeat', dentist().remindAt === null && !dentist().remindEvery);
  actions.setRemindEvery(dentist().id, 'day');
  check('a repeat without a reminder is ignored', !dentist().remindEvery);
  actions.undo();
  check('undo brings the reminder and its repeat back', !!dentist().remindAt && dentist().remindEvery === 'week');
  actions.setReminder(dentist().id, t2);
  actions.setRemindEvery(dentist().id, null);
}

// Composer capture includes its properties in one synced card and one undo step.
{
  const before = undoDepth();
  const at = new Date(Date.now() + 86400000).toISOString();
  const captured = actions.addCardFromText('Captured appointment\nBring documents', 'todo', 'checklist', ['sherlock'], { remindAt: at, remindEvery: 'week', atTop: true, undo: true })!;
  check('composer capture contains labels, schedule and items', captured.labels.includes('sherlock') && captured.remindAt === at && captured.remindEvery === 'week' && captured.items.length === 1);
  check('composer capture goes before the queue and adds one undo step', actions.visibleColumn('todo')[0]?.id === captured.id && undoDepth() === Math.min(before + 1, 10));
  check('composer toast offers Undo', getToast()?.message === "Added 'Captured appointment'" && !!getToast()?.undo);
  getToast()?.undo?.();
  check('one composer Undo removes the card and all its properties', !state.board.cards.some(c => c.id === captured.id));

  const list = actions.addCardFromText('Put back regression\nOne\nTwo')!;
  actions.toggleItem(list.id, list.items[0].id);
  actions.moveCardAction(list.id, 'doing');
  actions.putBackCard(list.id);
  check('Put back returns to To do and preserves checks', find('Put back regression').status === 'todo' && find('Put back regression').items[0].done);
  check('Put back offers its own Undo', getToast()?.message === "Put back 'Put back regression'" && !!getToast()?.undo);
  getToast()?.undo?.();
  check('Put back Undo restores Doing and prior checks', find('Put back regression').status === 'doing' && find('Put back regression').items[0].done && !find('Put back regression').items[1].done);
}

// Sync snapshots stay still, while the next local edit resumes normal feedback.
{
  const { isQuiet, seenCards } = await import('../src/lib/seen');
  const incoming = { ...find('Put back regression'), title: 'Remote arrival' };
  seenCards.delete(incoming.id);
  actions.applyRemote([incoming], [], null);
  check('remote updates suppress motion and mark incoming cards seen', isQuiet() && seenCards.has(incoming.id));
  actions.updateCardTitle(incoming.id, 'Local edit');
  check('a local edit immediately resumes motion', !isQuiet());
}

// Assistant changes are literal, unchecked, and reversible in one step.
{
  win.location.origin = 'http://x';
  (globalThis as any).location = win.location;
  win.fetch = async () => new Response(JSON.stringify({ user: 'assistant-test', personalRoom: 'personal', rooms: [{ id: 'personal', name: 'Personal' }], preferences: {} }), { headers: { 'content-type': 'application/json' } });
  await (await import('../src/lib/account')).prepareAccount();
  actions.applyAssistantProposal({ type: 'create', title: '# Literal title', notes: '- Keep as notes', items: ['[x] Not completed', 'First step'] });
  const card = find('# Literal title');
  check('assistant keeps text literal and steps unchecked', card?.notes === '- Keep as notes' && card.items.length === 2 && card.items.every(i => !i.done) && card.items[0].text === '[x] Not completed');
  getToast()?.undo?.();
  check('one Undo removes the whole suggested task', !state.board.cards.some(c => c.id === card.id));
  const target = actions.addCardFromText('Assistant steps target')!;
  actions.applyAssistantProposal({ type: 'checklist', cardId: target.id, title: target.title, notes: '', items: ['[x] Literal step', '[x] Literal step'] });
  check('assistant steps are deduplicated and unchecked', find(target.title).items.length === 1 && !find(target.title).items[0].done);
  getToast()?.undo?.();
  check('Undo restores task before suggested steps', find(target.title).items.length === 0);
  actions.moveCardAction(target.id, 'done');
  let rejected = false;
  try { actions.applyAssistantProposal({ type: 'checklist', cardId: target.id, title: target.title, notes: '', items: ['New step'] }); } catch { rejected = true; }
  check('assistant rejects steps for a task completed after its response', rejected);
}

// --- splitItem: Enter inside an item's text makes the rest the next item ----------------------
{
  actions.addCardFromText('Split me', 'todo');
  const c = find('Split me');
  actions.addItemsBatch(c.id, ['first', 'milk and eggs', 'last']);
  const mid = find('Split me').items[1];
  const newId = actions.splitItem(c.id, mid.id, 'milk ', ' eggs');
  const after = find('Split me');
  check('split: the head keeps its id and text, the tail is a new item right after it', !!newId && after.items.map((i) => i.text).join('|') === 'first|milk|eggs|last' && after.items[1].id === mid.id && after.items[2].id === newId);
  check('split with nothing on one side is a plain edit, no new item', actions.splitItem(c.id, mid.id, 'milk', '   ') === null && find('Split me').items.length === 4 && find('Split me').items[1].text === 'milk');
  actions.toggleItem(c.id, after.items[2].id);
  const doneId = actions.splitItem(c.id, after.items[2].id, 'eg', 'gs');
  check('split keeps the done state on both halves', !!doneId && find('Split me').items.filter((i) => i.done).map((i) => i.text).join('|') === 'eg|gs');
}

// --- notes (v5 / v6): ring cycle, linked rows, deleting a child, reminders on notes ------------
{
  const byId = (id: string) => state.board.cards.find((c) => c.id === id)!;
  const n = actions.addNote('Boiler service\nAsk the landlord', { undo: true })!;
  check('a note: kind note, no title (it derives), not on the board', n.kind === 'note' && n.title === '' && !actions.column('todo').some((c) => c.id === n.id));
  actions.cycleRing(n.id);
  check('ring promotes a note to the top of To do', byId(n.id).labels.includes('workflow:todo') && actions.column('todo')[0]?.id === n.id);
  check('ring toast', getToast()?.message === "'Boiler service' is in To do");
  actions.cycleRing(n.id);
  check('ring completes a to do', byId(n.id).labels.includes('workflow:done'));
  actions.cycleRing(n.id);
  check('ring reopens the to do', byId(n.id).labels.includes('workflow:todo'));
  actions.undo();
  check('undo restores completion', isCardDone(byId(n.id)));

  const parent = actions.addCardFromText('Plan the trip', 'todo')!;
  const child = actions.addNote('Camping kit')!;
  check('link a note under a to do', actions.linkCard(parent.id, child.id) && byId(parent.id).items.some((i) => i.ref === child.id));
  check('linking a plain note gives it To do status', byId(child.id).kind !== 'note' && byId(child.id).labels.includes('workflow:todo'));
  actions.undo();
  check('undo linking restores the plain note and removes its row', byId(child.id).kind === 'note' && !byId(parent.id).items.some(i => i.ref === child.id));
  actions.linkCard(parent.id, child.id);
  check('linking it twice is refused', !actions.linkCard(parent.id, child.id));
  check('a loop is refused', !actions.linkCard(child.id, parent.id));
  const row = byId(parent.id).items.find((i) => i.ref === child.id)!;
  actions.toggleItem(parent.id, row.id);
  check('ticking the row finishes the note', isCardDone(byId(child.id)) && !!byId(child.id).completedAt);
  check('linked completion finishes its parent', byId(parent.id).status === 'done');
  actions.setCardDone(child.id, false);
  check('reopening the note unticks the row and the parent leaves Done', !byId(parent.id).items.find((i) => i.ref === child.id)!.done && byId(parent.id).status === 'doing');
  actions.deleteCardById(child.id);
  const left = byId(parent.id).items.find((i) => i.id === row.id)!;
  check('deleting the child turns its row into text', !!left && !left.ref && left.text === 'Camping kit');
  actions.undo();
  check('undo brings the child and the link back', !!state.board.cards.find((c) => c.id === child.id) && byId(parent.id).items.find((i) => i.id === row.id)!.ref === child.id);

  const linked = actions.linkNewTodo(parent.id, 'Water filter')!;
  check('[[ new to do: has To do status and is linked', linked.kind !== 'note' && linked.labels.includes('workflow:todo') && byId(parent.id).items.some((i) => i.ref === linked.id));

  const r = actions.addNote('Renew passport')!;
  actions.setReminder(r.id, new Date(Date.now() + 86400000).toISOString());
  check('a reminder on a note places it in To do', byId(r.id).kind === undefined && byId(r.id).status === 'todo' && !!byId(r.id).remindAt);

  const t = actions.addNote('Some long body')!;
  actions.setTitle(t.id, 'Mine');
  check('a typed title belongs to the user', byId(t.id).title === 'Mine' && byId(t.id).titleBy === 'user');
  actions.setTitle(t.id, '');
  check('clearing it derives again', byId(t.id).title === '' && !byId(t.id).titleBy);

  actions.arrange([t.id, r.id]);
  check('arrange writes order without a size', byId(t.id).layout?.w === undefined && byId(t.id).layout?.order === 0 && byId(r.id).layout?.order === 1);
  actions.placeCard(parent.id, 'note');
  check('a to do can become a note again', byId(parent.id).kind === 'note');
}

// Unified editor and workflow labels: migration, drafts, placement and later remote moves.
{
  const { migrateWorkflow } = await import('../shared/workflow.mjs');
  const oldTask = { ...fixture.cards[0], status: 'doing' as const, labels: ['sherlock'], layout: { order: 3, w: 2 as const, h: 2 as const } };
  const migrated = migrateWorkflow(oldTask);
  check('migration retains the body, items, ordinary labels and layout order', migrated.notes === oldTask.notes && migrated.items === oldTask.items && migrated.labels.join() === 'sherlock,workflow:doing' && migrated.layout?.order === 3);
  check('migration is idempotent', JSON.stringify(migrateWorkflow(migrated)) === JSON.stringify(migrated));
  const labelledDraft = actions.createBlank(null, ['sherlock']);
  check('adding inside an ordinary column preselects its label', labelledDraft.labels.join() === 'sherlock' && labelledDraft.draft === true);
  actions.discardBlank(labelledDraft.id);
  const draft = actions.createBlank('todo');
  await tick();
  check('an empty editor is not counted, exported or persisted', !actions.column('todo').some((c) => c.id === draft.id) && !JSON.parse(actions.exportJSON()).cards.some((c: any) => c.id === draft.id) && !(await idb()).some((c) => c.id === draft.id));
  actions.discardBlank(draft.id);
  check('closing an empty editor leaves no note', !state.board.cards.some((c) => c.id === draft.id));
  const note = actions.createBlank();
  actions.setTitle(note.id, 'Unified flow');
  await tick();
  check('the first edit saves the same note without a workflow label', !find('Unified flow').draft && find('Unified flow').labels.length === 0 && (await idb()).some((c) => c.id === note.id));
  actions.toggleCardLabel(note.id, 'workflow:todo');
  actions.toggleCardLabel(note.id, 'workflow:doing');
  check('choosing Doing replaces To do and Board follows the label', find('Unified flow').labels.join() === 'workflow:doing' && actions.column('doing').some((c) => c.id === note.id));
  actions.addItemsBatch(note.id, ['One', 'Two']);
  actions.checkAllAction(note.id);
  check('complete checklist moves a workflow note to Done', find('Unified flow').status === 'done' && find('Unified flow').items.every((i) => i.done));
  actions.cycleRing(note.id);
  check('the ring reopens automatic Done into its previous Doing stage', find('Unified flow').labels.join() === 'workflow:doing');
  actions.cycleRing(note.id);
  check('the ring finishes it manually and keeps progress', find('Unified flow').labels.join() === 'workflow:done' && find('Unified flow').items.every((i) => i.done));
  actions.toggleCardLabel(note.id, 'sherlock');
  actions.applyRemote([{ ...find('Unified flow'), labels: ['sherlock', 'workflow:doing'], status: 'doing', updatedAt: new Date().toISOString() }], [], null);
  actions.undo();
  check('undoing an ordinary label leaves a later workflow move intact', find('Unified flow').labels.join() === 'workflow:doing');
  actions.advanceCard(note.id);
  check('swipe advances Doing to Done and preserves checklist progress', find('Unified flow').labels.join() === 'workflow:done' && find('Unified flow').items.every((i) => i.done));
  actions.advanceCard(note.id);
  check('swipe and ring reopen Done into its previous Doing stage', find('Unified flow').labels.join() === 'workflow:doing');
}

// Resizing keeps grid order, persists dimensions and remains undoable.
{
  const { gridOrder } = await import('../src/lib/notes-layout');
  const visible = () => gridOrder(state.board.cards.filter((c) => !c.archivedAt && !c.draft));
  const before = visible().map((c) => c.id).join();
  const card = actions.addCardFromText('Resize regression', 'todo')!;
  const order = visible().map((c) => c.id).join();
  const original = state.board.cards.find((c) => c.id === card.id)!;
  actions.resizeCard(card.id, 2, 280);
  await tick();
  check('resizing never moves a new card among existing cards', visible().map((c) => c.id).join() === order);
  const saved = (await idb()).find((c) => c.id === card.id)!;
  check('resized width and height survive storage', saved.layout?.w === 2 && saved.layout?.height === 280);
  check('resizing retains workflow and content', saved.labels.join() === original.labels.join() && saved.title === original.title);
  actions.undo();
  check('undo restores dimensions and grid order', !state.board.cards.find((c) => c.id === card.id)!.layout && visible().map((c) => c.id).join() === order);
  actions.resizeCard(card.id, 2, 280);
  actions.resizeCard(card.id, 1, null);
  check('fit content removes the explicit height', state.board.cards.find((c) => c.id === card.id)!.layout?.height === undefined);
  actions.resizeCard(card.id, 2, 320, { width: 1.65, anchor: { x: 2.35, y: 160 } });
  await tick();
  const freeSize = (await idb()).find(c => c.id === card.id)!;
  check('continuous width and resize anchor survive storage', freeSize.layout?.width === 1.65 && freeSize.layout?.anchor?.x === 2.35 && freeSize.layout?.anchor?.y === 160);
  actions.undo();
  check('undo restores the size before free resizing', !state.board.cards.find(c => c.id === card.id)!.layout?.width && !state.board.cards.find(c => c.id === card.id)!.layout?.anchor);
  actions.resizeCard(card.id, 2, 320, { width: 1.65, anchor: { x: 2.35, y: 160 } });
  actions.arrange(visible().map(c => c.id));
  check('drag arrangement releases resize anchors without losing widths', !state.board.cards.find(c => c.id === card.id)!.layout?.anchor && state.board.cards.find(c => c.id === card.id)!.layout?.width === 1.65);
  actions.resizeCard(card.id, 1, null);
  check('fit content restores natural width and removes the anchor', !state.board.cards.find(c => c.id === card.id)!.layout?.width && !state.board.cards.find(c => c.id === card.id)!.layout?.anchor);
  actions.deleteCardById(card.id);
  check('resizing keeps all other cards', visible().map((c) => c.id).join() === before);
}

console.log('');
{
  const { boardColumns, DEFAULT_BOARD_LABELS } = await import('../src/lib/board-columns');
  const home = actions.createLabel('Column test', '#E5484D')!;
  const card = actions.addCardFromText('Shared column note', 'doing')!;
  actions.setCardLabels(card.id, ['workflow:doing', home.id]);
  actions.setLabelFilter([...DEFAULT_BOARD_LABELS, home.id]);
  check('selected labels define columns in workflow order', boardColumns(state.board.labels, state.labelFilter).map((c) => c.status).join() === `todo,doing,done,${home.id}`);
  check('a note appears in workflow and ordinary label columns', actions.visibleColumn('doing').some((c) => c.id === card.id) && actions.visibleColumn(home.id).some((c) => c.id === card.id));
  actions.setLabelFilter(['workflow:todo', home.id]);
  check('deselected labels remove columns without removing notes', boardColumns(state.board.labels, state.labelFilter).length === 2 && actions.visibleColumn(home.id).some((c) => c.id === card.id));
  actions.setLabelFilter([]);
  check('no selected labels means no columns', boardColumns(state.board.labels, state.labelFilter).length === 0);
  const other = actions.createLabel('Other column', '#12A6B8')!;
  const before = undoDepth();
  actions.dropInColumn(card.id, null, other.id);
  const changed = state.board.cards.find((c) => c.id === card.id)!;
  check('ordinary drop preserves workflow and other labels', changed.labels.includes(home.id) && changed.labels.includes(other.id) && changed.labels.includes('workflow:doing'));
  check('ordinary drop is one undo step', undoDepth() === Math.min(before + 1, 10));
  actions.undo();
  check('undo removes only the added label', !state.board.cards.find((c) => c.id === card.id)!.labels.includes(other.id));
  actions.dropInColumn(card.id, null, 'done');
  const done = state.board.cards.find((c) => c.id === card.id)!;
  check('workflow drop replaces workflow and keeps ordinary labels', done.labels.includes(home.id) && done.labels.includes('workflow:done') && !done.labels.includes('workflow:doing'));
  actions.archiveCard(card.id);
  check('archived notes leave ordinary columns too', !actions.visibleColumn(home.id).some((c) => c.id === card.id));
  const plain = actions.addNote('Plain note drop')!;
  actions.setCardLabels(plain.id, [home.id]);
  actions.dropInColumn(plain.id, null, 'todo');
  check('plain note drops into To do even when its compatibility status is already todo', actions.visibleColumn('todo').some((c) => c.id === plain.id) && state.board.cards.find((c) => c.id === plain.id)!.labels.includes(home.id));
  actions.undo();
  check('undo workflow drop restores a plain note', !actions.visibleColumn('todo').some((c) => c.id === plain.id));
  actions.setLabelFilter(DEFAULT_BOARD_LABELS);
}

// A list-only note keeps the title it showed while typing.
{
  const card = actions.createBlank('todo');
  actions.finishBodyEditing(card.id, '- Buy apples\n- Buy bread');
  const changed = state.board.cards.find(c => c.id === card.id)!;
  check('list-only conversion keeps its derived title', changed.title === 'Buy apples' && changed.titleBy === 'auto');
  actions.undo();
  check('undo list-only conversion restores the untitled body', state.board.cards.find(c => c.id === card.id)!.title === '' && state.board.cards.find(c => c.id === card.id)!.notes === '- Buy apples\n- Buy bread');
}

// Conversion is one reversible change, retaining the latest keystrokes and existing rows.
{
  const card = actions.addNote('Trailing list conversion')!;
  actions.addItem(card.id, 'Existing item');
  const text = '## Context\n\n- Earlier example\n\nMore context\n\n- First task\n- [x] Second task';
  const depth = undoDepth();
  actions.finishBodyEditing(card.id, text);
  const converted = state.board.cards.find(c => c.id === card.id)!;
  check('conversion preserves earlier Markdown', converted.notes === '## Context\n\n- Earlier example\n\nMore context');
  check('conversion appends rows and keeps checked state', converted.items.map(i => `${i.text}:${i.done}`).join('|') === 'Existing item:false|First task:false|Second task:true');
  check('conversion is one undo step', undoDepth() === Math.min(depth + 1, 10));
  actions.undo();
  const restored = state.board.cards.find(c => c.id === card.id)!;
  check('undo restores the whole typed list and original checklist', restored.notes === text && restored.items.length === 1);
  actions.finishBodyEditing(card.id, '- Parent\n  - Child');
  check('nested list remains in the body', state.board.cards.find(c => c.id === card.id)!.notes === '- Parent\n  - Child');
  actions.addItemsBatch(card.id, Array(499).fill('Keep'));
  actions.finishBodyEditing(card.id, '- Do not lose this');
  const capped = state.board.cards.find(c => c.id === card.id)!;
  check('full checklist retains the list in the body', capped.items.length === 500 && capped.notes === '- Do not lose this');
}

{
  const parent = actions.addNote('Parent context', { labels: ['workflow:doing', 'label-project'] })!;
  actions.addItemsBatch(parent.id, ['Write the project plan', 'Review the result']);
  const original = state.board.cards.find(c => c.id === parent.id)!;
  const [first, second] = original.items;
  const depth = undoDepth();
  const child = actions.promoteItem(parent.id, first.id)!;
  const linked = state.board.cards.find(c => c.id === parent.id)!;
  check('promoted item becomes a To do with its complete text and ordinary labels', child.notes === first.text && child.labels.includes('workflow:todo') && child.labels.includes('label-project') && !child.labels.includes('workflow:doing'));
  check('promotion preserves the item identity as the note identity', child.id === first.id);
  check('promotion retains row id, order, text and completion as a link', linked.items[0].id === first.id && linked.items[0].ref === child.id && linked.items[0].text === first.text && !linked.items[0].done && linked.items[1].id === second.id);
  check('promotion does not change the parent body or labels', linked.notes === original.notes && linked.labels.join() === original.labels.join());
  check('promotion is one undo step', undoDepth() === Math.min(depth + 1, 10));
  const count = state.board.cards.length;
  check('promoting a linked row opens its existing to do', actions.promoteItem(parent.id, first.id)?.id === child.id && state.board.cards.length === count);
  actions.setCardDone(child.id, true);
  check('promoted child completion still mirrors its parent row', state.board.cards.find(c => c.id === parent.id)!.items[0].done);
  actions.undo();
  actions.undo();
  check('undo promotion restores the original checklist and removes the child', !state.board.cards.some(c => c.id === child.id) && !state.board.cards.find(c => c.id === parent.id)!.items[0].ref);
  actions.setItemsDone(parent.id, [second.id], true);
  const completed = actions.promoteItem(parent.id, second.id)!;
  check('promoting a checked row preserves completion', completed.labels.includes('workflow:done') && !!completed.completedAt && state.board.cards.find(c => c.id === parent.id)!.items[1].done);
  const todo = actions.promoteItem(parent.id, first.id)!;
  check('promotion always creates a to do', todo.kind !== 'note' && todo.labels.includes('workflow:todo'));
}

{
  const parent = actions.addNote('Bulk parent', { labels: ['workflow:todo'] })!;
  const child = actions.addNote('Bulk child', { labels: ['workflow:todo'] })!;
  actions.addItem(child.id, 'Child task');
  actions.linkCard(parent.id, child.id);
  actions.addItem(parent.id, 'Parent task');
  const depth = undoDepth();
  actions.checkAllAction(parent.id);
  check('explicit check all finishes linked notes and parent', state.board.cards.find(c => c.id === child.id)!.status === 'done' && state.board.cards.find(c => c.id === parent.id)!.status === 'done', JSON.stringify(state.board.cards.filter(c => c.id === parent.id || c.id === child.id).map(c => ({status:c.status, labels:c.labels,items:c.items}))));
  check('explicit parent completion does not check descendants', !state.board.cards.find(c => c.id === child.id)!.items[0].done);
  check('bulk linked completion is one undo step', undoDepth() === Math.min(depth + 1, 10));
  actions.undo();
  check('undo bulk restores the linked child and parent', state.board.cards.find(c => c.id === child.id)!.status === 'todo' && state.board.cards.find(c => c.id === parent.id)!.items.every(i => !i.done));
  actions.checkAllAction(parent.id);
  actions.uncheckAllAction(parent.id);
  check('uncheck all reopens the linked child and clears parent rows', state.board.cards.find(c => c.id === child.id)!.status === 'todo' && state.board.cards.find(c => c.id === parent.id)!.items.every(i => !i.done));
}

{
  const byId = (id: string) => state.board.cards.find(c => c.id === id)!;
  const stageDrafts = ['Draft', 'Review', 'Published'].map((name, n) => ({ name, finished: n === 2 }));
  check('create a custom flow', actions.saveFlow(null, 'Editorial', stageDrafts));
  const flow = () => state.board.labels.filter(l => l.group === 'Editorial').sort((a, b) => a.flowStage!.order - b.flowStage!.order);
  const [draft, review, published] = flow();
  const note = actions.addNote('Custom flow article')!;
  actions.setCardLabels(note.id, [draft.id]);
  actions.advanceCard(note.id);
  check('swipe advances custom Draft to Review', byId(note.id).labels.includes(review.id));
  actions.setCardDone(note.id, true);
  check('custom finish uses Published without a Done label', byId(note.id).labels.join() === published.id && byId(note.id).status === 'done');
  const completionTime = byId(note.id).completedAt;
  actions.setTitle(note.id, 'Edited custom article');
  check('editing a finished custom note preserves its completion time', byId(note.id).completedAt === completionTime);
  actions.setCardDone(note.id, false);
  check('custom ring reopens to Review', byId(note.id).labels.join() === review.id);
  actions.undo();
  check('undo reopening restores Published', byId(note.id).status === 'done' && byId(note.id).labels.includes(published.id));
  actions.setCardDone(note.id, false);
  const copied = actions.duplicate(note.id)!;
  check('duplicate starts in the same custom flow', byId(copied).labels.includes(draft.id) && !byId(copied).labels.some(id => id.startsWith('workflow:')));
  actions.setCardLabels(note.id, [published.id]);
  const nextStages = flow().map(l => ({ id: l.id, name: l.name, finished: l.id === review.id }));
  actions.saveFlow('Editorial', 'Editorial', nextStages);
  check('changing finished stage updates existing completion', byId(note.id).status !== 'done' && byId(note.id).completedAt === null);
  actions.undo();
  check('undo flow editing restores completion', byId(note.id).status === 'done' && state.board.labels.find(l => l.id === published.id)!.flowStage!.finished);
  actions.placeCard(note.id, 'note');
  check('Make note removes its custom stage', byId(note.id).kind === 'note' && !byId(note.id).labels.includes(published.id));
  actions.undo();
  actions.placeCard(note.id, 'todo');
  check('switching to Todos replaces the custom flow', byId(note.id).labels.join() === 'workflow:todo');
  await tick();
}

console.log(failures === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
