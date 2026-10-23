// window.kanban (§14.3) + URL intents (§14.2) + dates (§5.2). Run: `npm run test:api`.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';

const mem = new Map<string, string>();
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, String(v)), removeItem: (k: string) => void mem.delete(k) };
const ls = new Map<string, Set<(e: any) => void>>();
const win: any = {
  addEventListener: (t: string, fn: any) => { (ls.get(t) ?? ls.set(t, new Set()).get(t)!).add(fn); },
  removeEventListener: (t: string, fn: any) => ls.get(t)?.delete(fn),
  dispatchEvent: (e: any) => { ls.get(e.type)?.forEach((fn) => fn(e)); return true; },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: storage, sessionStorage: storage,
  location: { hash: '', href: 'http://x/', pathname: '/', search: '' },
  history: { replaceState() {} },
};
(globalThis as any).window = win;
(globalThis as any).localStorage = storage;
(globalThis as any).document = { documentElement: { dataset: {}, style: { setProperty() {} }, setAttribute() {}, getAttribute: () => null }, querySelector: () => null, addEventListener() {}, removeEventListener() {} };
(globalThis as any).CustomEvent = class { type: string; detail: any; constructor(t: string, i?: any) { this.type = t; this.detail = i?.detail; } };

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log('  ok           ' + name);
  else { failures++; console.log('  FAIL ' + name + ' ' + extra); }
};
const tick = () => new Promise((r) => setTimeout(r, 5));

const { actions, state } = await import('../src/hooks/useStore');
const { installKanbanAPI } = await import('../src/lib/kanban-api');
const { parseIntent } = await import('../src/lib/intents');
const { relativeDate } = await import('../src/lib/dates');
const { staggerIndex } = await import('../src/lib/presence');
const fixture = JSON.parse(readFileSync('fixtures/board.json', 'utf8'));
// The fixture's Done dates are fixed; keep them inside the 14-day archive window whatever today is.
{
  const done = fixture.cards.filter((c: any) => c.completedAt).sort((a: any, b: any) => b.completedAt.localeCompare(a.completedAt));
  done.forEach((c: any, i: number) => { c.completedAt = new Date(Date.now() - (1 + 2 * i) * 86400000).toISOString(); });
}

await actions.init();
installKanbanAPI();
const k = win.kanban;
check('window.kanban is installed with version 1', k && k.version === 1);

k.importBoard(fixture, 'replace');
await tick();
actions.dismissToast();

// --- list / get are synchronous and return full read-only card copies ---------
const all = k.list();
check('list() is synchronous and returns the 8 fixture cards', Array.isArray(all) && all.length === 8, String(all?.length));
check('list() cards carry item ids and flags', typeof all[0].items?.[0]?.id === 'string' && 'repeat' in all[0] && 'someday' in all[0]);
check('list() views also give done[]/remaining[] item texts', Array.isArray(all[0].done) && Array.isArray(all[0].remaining));
check('list({status}) filters by column', k.list({ status: 'done' }).length === 2);
check('list({query}) matches title, notes and items', k.list({ query: 'brake' }).length === 1 && k.list({ query: 'Milk' }).length === 1);
check('list() copies are detached from the store', (all[0].title = 'zzz', state.board.cards[0].title !== 'zzz'));
// D14: list() is in display order — todo, doing, done; Done by completedAt desc.
{
  const order = k.list().map((c: any) => c.status);
  const firstDoing = order.indexOf('doing'), firstDone = order.indexOf('done');
  check('list() groups columns in display order', order.lastIndexOf('todo') < firstDoing && order.lastIndexOf('doing') < firstDone, order.join());
  k.setStatus('Idea: weekly review template', 'doing');
  const doing = k.list({ status: 'doing' }).map((c: any) => c.title);
  check('a moved card lists last in its column (bottom append), as the board shows it', doing[doing.length - 1] === 'Idea: weekly review template', doing.join());
  k.setStatus('Idea: weekly review template', 'todo');
}
check('get() by case-insensitive title', k.get('groceries')?.title === 'Groceries');
check('get() of an unknown card is null', k.get('nope') === null);

// --- addCard: text grammar or object -----------------------------------------
const g = k.addCard('Weekend\nSaturday market\n\n- [ ] Oat milk\n- [x] Eggs\nSpinach');
check('addCard(text) parses the grammar: notes before the first marker, bare lines after it are items', g.notes === 'Saturday market' && g.items.map((i: any) => i.text).join() === 'Oat milk,Eggs,Spinach' && g.status === 'doing', JSON.stringify([g.notes, g.items.map((i: any) => i.text)]));
const o = k.addCard({ title: 'Obj', notes: 'n', items: ['a', 'b'], status: 'doing' });
check('addCard(object) builds title/notes/items and honours status', o.title === 'Obj' && o.notes === 'n' && o.items.length === 2 && o.status === 'doing');
actions.dismissToast();

// --- addItems / check / uncheck ----------------------------------------------
const before = k.get('Groceries').items.length;
const after = k.addItems('Groceries', ['Bread', 'Butter']);
const lastOpen = after.items.map((i: any) => i.done).lastIndexOf(false);
check('addItems appends after the last unchecked item, in order, and returns the card', after.items.length === before + 2 && after.items[lastOpen - 1].text === 'Bread' && after.items[lastOpen].text === 'Butter', JSON.stringify(after.items.map((i: any) => i.text + (i.done ? '✓' : ''))));
const byText = k.check('Groceries', 'Bread');
check('check by exact text checks the first unchecked match', byText.items.find((i: any) => i.text === 'Bread').done === true);
const byId = k.check('Groceries', after.items.find((i: any) => i.text === 'Butter').id);
check('check by item id', byId.items.find((i: any) => i.text === 'Butter').done === true);
const allDone = k.check('Groceries', '*');
check('check("*") completes the card', allDone.status === 'done' && allDone.items.every((i: any) => i.done));
actions.dismissToast();
const un = k.uncheck('Groceries', '*');
check('uncheck("*") returns the card to To do', un.status === 'todo');

// --- setStatus / remove / errors -----------------------------------------------
check('setStatus applies the same item rules (done = check all)', k.setStatus('Renew passport', 'done').items.every((i: any) => i.done));
let msg = '';
try { k.addItems('Grocery', 'x'); } catch (e: any) { msg = e.message; }
check('unknown title throws naming the closest match (§14.3 wording)', msg === "No card matches ‘Grocery’; closest: ‘Groceries’", msg);
const h = k.remove('Fix bike brakes');
check('remove returns an undo handle and removes the card', typeof h.undo === 'function' && k.get('Fix bike brakes') === null);
h.undo();
check('remove().undo() restores the card', k.get('Fix bike brakes') !== null);
actions.dismissToast();

// --- exportText round-trip via importText (merge) -------------------------------
const text = k.exportText();
check('exportText separates cards with ---', text.split('\n---\n').length === k.list().length);
const one = k.exportText('Read Thinking in Systems');
check('exportText(card) is the grammar: title, items as - [ ] / - [x]', one.startsWith('Read Thinking in Systems\n') && one.includes('- [x] Chapter 1') && one.includes('- [ ] Chapter 2'), one);
const n0 = k.list().length;
const parsedBack = k.importText(one);
check('importText merges grammar text as new cards', parsedBack === 1 && k.list().length === n0 + 1);
actions.dismissToast();

// --- subscribe / events --------------------------------------------------------------
let fired = 0;
const off = k.subscribe(() => fired++);
k.addCard('Ping');
await tick();
check('subscribe fires after a committed change', fired >= 1);
off();

// --- labels (window.kanban) -------------------------------------------------------------
{
  check('labels() lists the built-in Sherlock label', k.labels().some((l: any) => l.id === 'sherlock' && l.name === 'Sherlock' && l.color === '#7C5CFF'));
  const work = k.addLabel({ name: 'Work', color: '#2E9E6B' });
  check('addLabel returns {id,name,color}', typeof work.id === 'string' && work.name === 'Work' && work.color === '#2E9E6B');
  let threw = '';
  try { k.addLabel({ name: 'Bad', color: 'green' }); } catch (e) { threw = (e as Error).message; }
  check('addLabel rejects a non-#RRGGBB color', /#RRGGBB/.test(threw), threw);
  threw = '';
  try { k.addLabel({ name: '  ' }); } catch (e) { threw = (e as Error).message; }
  check('addLabel needs a name', /name/.test(threw));
  const lc = k.addCard({ title: 'Labelled', labels: ['work', 'SHERLOCK'] });
  check('addCard({labels}) resolves names case-insensitively, in order', lc.labels.join() === `${work.id},sherlock,workflow:todo`, JSON.stringify(lc.labels));
  const byId = k.addCard({ title: 'By id', labels: [work.id] });
  check('addCard({labels}) accepts ids', byId.labels.join() === `${work.id},workflow:todo`);
  threw = '';
  try { k.addCard({ title: 'Nope', labels: ['missing'] }); } catch (e) { threw = (e as Error).message; }
  check('an unknown label throws and names the known labels', /No label matches ‘missing’/.test(threw) && /Work/.test(threw), threw);
  check('a rejected addCard creates nothing', k.get('Nope') === null);
  const set = k.setLabels('Labelled', ['sherlock']);
  check('setLabels replaces the card labels', set.labels.join() === 'sherlock');
  k.undo();
  check('setLabels is undoable', k.get('Labelled').labels.join() === `${work.id},sherlock,workflow:todo`);
  check('list({label}) by name filters cards', k.list({ label: 'work' }).map((c: any) => c.title).sort().join() === 'By id,Labelled');
  check('list({label}) by id', k.list({ label: 'sherlock' }).map((c: any) => c.title).join() === 'Labelled');
  check('list({query: "#work"}) matches labelled cards', k.list({ query: '#work' }).length === 2);
  k.remove('Labelled'); k.remove('By id');
  actions.dismissToast();
}

// --- board shortcuts never fire from controls, popovers, the detail or a sheet -------------
{
  const { boardKeyBlocked } = await import('../src/hooks/useKeyboardNav');
  // Minimal element fakes: `inside` lists the selectors this element sits inside (closest()).
  const el = (tagName: string, inside: string[] = []) => ({ tagName, isContentEditable: false, closest: (sel: string) => (sel.split(',').some((x) => inside.includes(x.trim())) ? {} : null) }) as unknown as Element;
  const card = el('ARTICLE');
  check('a focused card takes board keys', !boardKeyBlocked(card, card, false));
  check('nothing focused (body) takes board keys', !boardKeyBlocked(el('BODY'), el('BODY'), false));
  check('a swatch button blocks board keys', boardKeyBlocked(el('BUTTON', ['button', '[role=radio]']), null, false));
  check('a link blocks board keys', boardKeyBlocked(el('A', ['a[href]']), null, false));
  check('a text field blocks board keys', boardKeyBlocked(el('INPUT', ['input']), null, false));
  check('anything inside a popover or dialog blocks board keys', boardKeyBlocked(el('DIV', ['[role=dialog]']), null, false) && boardKeyBlocked(el('LI', ['.label-pop']), null, false));
  check('focus inside an overlay blocks even when the key target is the body', boardKeyBlocked(el('BODY'), el('SPAN', ['.dt-panel']), false));
  check('an open detail / popover / sheet blocks board keys from a card', boardKeyBlocked(card, card, true));
}
{
  const { rovingIndex, swatchTabIndex } = await import('../src/lib/labels');
  check('roving: ArrowRight/Down move forward and wrap', rovingIndex(0, 'ArrowRight', 11) === 1 && rovingIndex(10, 'ArrowDown', 11) === 0);
  check('roving: ArrowLeft/Up move back and wrap', rovingIndex(3, 'ArrowLeft', 11) === 2 && rovingIndex(0, 'ArrowUp', 11) === 10);
  check('roving: Home/End jump', rovingIndex(5, 'Home', 11) === 0 && rovingIndex(5, 'End', 11) === 10);
  check('roving: other keys are not handled', rovingIndex(5, ' ', 11) === null && rovingIndex(5, 'Tab', 11) === null);
  check('only the checked swatch is tabbable', swatchTabIndex('#2E9E6B') === 1);
  check('a custom color makes the custom swatch tabbable', swatchTabIndex('#010203') === 11);
}

// --- reminders via window.kanban ----------------------------------------------------------
{
  const c = k.addCard({ title: 'Remind via API' });
  const when = new Date(Date.UTC(2030, 0, 2, 7, 0)).toISOString();
  const v = k.remind(c.id, '2030-01-02T09:00:00+02:00');
  check('remind(card, iso) stores UTC', v.remindAt === when, v.remindAt);
  check('remind(card, null) clears', k.remind('Remind via API', null).remindAt === null);
  let err = '';
  try { k.remind(c.id, 'tomorrow-ish'); } catch (e) { err = (e as Error).message; }
  check('remind rejects an unparseable time', /ISO/.test(err), err);
  k.remove(c.id);
  actions.dismissToast();
}

// --- kanban.attach / attachments / detach ----------------------------------------------------
{
  const { setUploadTransport, uploads } = await import('../src/lib/uploads');
  setUploadTransport(async ({ url, headers }) => (url.endsWith('/thumb') ? { status: 200, body: {} } : { status: 200, body: { id: headers['X-File-Id'], name: decodeURIComponent(headers['X-Filename']), type: headers['Content-Type'], size: 5 } }));
  await uploads.init();
  const c = k.addCard({ title: 'Attach via API' });
  const a = await k.attach('Attach via API', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt');
  check('attach(card, blob, name) resolves with the attachment and its url', a.name === 'hello.txt' && a.type === 'text/plain' && a.url === `/kanban/files/${a.id}` && !a.pending, JSON.stringify(a));
  const list = k.attachments(c.id);
  check('attachments(card) lists them with urls', list.length === 1 && list[0].id === a.id && list[0].url === a.url);
  check('get() carries them too', k.get(c.id).attachments.length === 1);
  let err = '';
  try { await k.attach(c.id, 'not a blob'); } catch (e) { err = (e as Error).message; }
  check('attach rejects a non-Blob', /Blob or File/.test(err), err);
  k.detach(c.id, a.id);
  check('detach(card, id) removes it (undoable)', k.attachments(c.id).length === 0);
  k.undo();
  check('...and undo brings it back', k.attachments(c.id).length === 1);
  err = '';
  try { k.detach(c.id, 'nope'); } catch (e) { err = (e as Error).message; }
  check('detach of an unknown attachment throws', /No attachment/.test(err), err);
  k.remove(c.id);
  actions.dismissToast();
}

// --- links in items round-trip through the grammar ----------------------------------------------
{
  const text = 'Trip\n\n- [ ] Book [hotel](https://h.test/a_(b)?x=1)\n- [x] Read https://x.test/guide.';
  const c = k.addCard(text);
  check('markdown links in items survive addCard untouched', c.items[0].text === 'Book [hotel](https://h.test/a_(b)?x=1)' && c.items[1].text === 'Read https://x.test/guide.', JSON.stringify(c.items));
  const out = k.exportText(c.id);
  check('exportText writes them back verbatim', out.includes('- [ ] Book [hotel](https://h.test/a_(b)?x=1)') && out.includes('- [x] Read https://x.test/guide.'), out);
  k.remove(c.id);
  k.importText(out);
  const back = k.get('Trip');
  check('importText reads them back the same', back?.items.map((i: any) => i.text).join('|') === 'Book [hotel](https://h.test/a_(b)?x=1)|Read https://x.test/guide.', JSON.stringify(back?.items));
  k.remove(back.id);
  actions.dismissToast();
}

// --- a link whose words are "x" is a link, not a checkbox marker ---------------------------
{
  const c = k.addCard('Grammar\n\n- [ ] first');
  const after = k.addItems(c.id, ['[x](https://ex.com/grammar)', '- [X](https://ex.com/b)', '[x] really done']);
  const t = (s: string) => after.items.find((i: any) => i.text === s);
  check('"[x](url)" stays an unchecked item with its link', !!t('[x](https://ex.com/grammar)') && !t('[x](https://ex.com/grammar)').done, JSON.stringify(after.items));
  check('"- [X](url)" stays an unchecked item with its link', !!t('[X](https://ex.com/b)') && !t('[X](https://ex.com/b)').done, JSON.stringify(after.items));
  check('"[x] text" is still a checked item', !!t('really done') && t('really done').done, JSON.stringify(after.items));
  k.remove(c.id);
  actions.dismissToast();
}

// --- kanban.someday(card, bool) ----------------------------------------------------------
{
  const c = k.addCard({ title: 'Park via API', status: 'doing' });
  const v = k.someday(c.id, true);
  check('someday(card, true) parks it in To do', v.someday === true && v.status === 'todo');
  const order = k.list({ status: 'todo' }).map((x: any) => x.id);
  check('list() shows Someday cards after the active To do cards', order.indexOf(c.id) > Math.max(...k.list({ status: 'todo' }).filter((x: any) => !x.someday).map((x: any) => order.indexOf(x.id))));
  check('someday(card, false) un-parks it', k.someday('Park via API', false).someday === false);
  k.someday(c.id, true);
  check('setStatus(doing) on a parked card clears Someday', k.setStatus(c.id, 'doing').someday === false);
  let err = '';
  try { k.someday(c.id, 'yes'); } catch (e) { err = (e as Error).message; }
  check('someday rejects a non-boolean', /true or false/.test(err), err);
  k.remove(c.id);
  actions.dismissToast();
}

// --- §14.2 URL intents ------------------------------------------------------------------
const add = parseIntent('#/add?text=Groceries%0A-%20%5B%20%5D%20Eggs%0A-%20%5Bx%5D%20Milk&status=todo&nonce=abc');
check('parseIntent add', add?.kind === 'add' && add.text === 'Groceries\n- [ ] Eggs\n- [x] Milk' && add.status === 'todo' && add.nonce === 'abc', JSON.stringify(add));
const ai = parseIntent('#/card/abc/add-items?text=Bread%0AButter');
check('parseIntent add-items', ai?.kind === 'add-items' && ai.card === 'abc' && ai.text === 'Bread\nButter');
const ch = parseIntent('#/card/Groceries/check?items=Eggs,i2');
check('parseIntent check splits items on commas', ch?.kind === 'check' && ch.items.join('|') === 'Eggs|i2');
check('parseIntent uncheck', parseIntent('#/card/x/uncheck?items=a')?.kind === 'uncheck');
const st = parseIntent('#/card/x/status?set=done');
check('parseIntent status', st?.kind === 'status' && st.status === 'done');
const f = parseIntent('#/find?q=milk');
check('parseIntent find', f?.kind === 'find' && f.q === 'milk');
check('parseIntent ignores plain card/column routes', parseIntent('#card/abc') === null && parseIntent('#doing') === null && parseIntent('') === null);
check('parseIntent title= targeting', parseIntent('#/card/x/check?items=a&title=Groceries')?.card === 'Groceries');

// --- §11.2 / §16 stagger: below 50 items stagger (cap 8 steps); 50+ enter as one group ---
check('staggerIndex staggers 5 items', staggerIndex(5, 3) === 3);
check('staggerIndex caps the delay step at 8', staggerIndex(20, 15) === 8);
check('staggerIndex is -1 for a single item', staggerIndex(1, 0) === -1);
check('staggerIndex is -1 for fifty items (one group)', staggerIndex(50, 10) === -1 && staggerIndex(120, 3) === -1);
check('staggerIndex still staggers 49 items', staggerIndex(49, 2) === 2);

// --- §5.2 dates -------------------------------------------------------------------------
const now = new Date('2026-09-22T12:00:00');
check('relativeDate today', relativeDate('2026-09-22T08:00:00', now) === 'Today');
check('relativeDate yesterday', relativeDate('2026-09-21T23:00:00', now) === 'Yesterday');
check('relativeDate weekday within 7 days', relativeDate('2026-09-17T10:00:00', now) === 'Thu', relativeDate('2026-09-17T10:00:00', now));
check('relativeDate month + day beyond a week', relativeDate('2026-09-03T10:00:00', now) === 'Sep 3', relativeDate('2026-09-03T10:00:00', now));
check('relativeDate adds the year when it differs', relativeDate('2025-09-03T10:00:00', now) === 'Sep 3, 2025', relativeDate('2025-09-03T10:00:00', now));

console.log('');
console.log(failures === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
