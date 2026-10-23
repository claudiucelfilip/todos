// §13.3 merge rules, shared by server.js and the client: per-field LWW by ts,
// items by id (add wins over nothing, delete wins over edit, check LWW),
// tombstones, derivation on replay. Run: `npm run test:merge`.
import { applyAction, emptyState, snapshot, pruneTombstones, diffCards, diffLabels, stateFromCards } from '../shared/merge.mjs';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('  ok    ' + name);
  else { failures++; console.log('  FAIL ' + name + ' ' + extra); }
};
const T = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const card = (over = {}) => ({
  id: 'c1', title: 'Groceries', notes: '', status: 'todo', order: 0,
  items: [{ id: 'i1', text: 'Milk', done: false }, { id: 'i2', text: 'Eggs', done: false }],
  createdAt: T(0), updatedAt: T(0), completedAt: null, archivedAt: null, someday: false, repeat: false, ...over,
});
const act = (type, payload, ts, deviceId = 'A') => ({ id: type + ts + deviceId, deviceId, ts: T(ts), type, payload });
const cards = (s) => snapshot(s).cards;

// --- card.put / card.set field LWW -------------------------------------------
{
  const s = emptyState();
  applyAction(s, act('card.put', { card: card() }, 1));
  check('card.put creates the card', cards(s).length === 1 && cards(s)[0].title === 'Groceries');
  applyAction(s, act('card.set', { id: 'c1', fields: { title: 'Shopping' } }, 3, 'B'));
  applyAction(s, act('card.set', { id: 'c1', fields: { title: 'Old' } }, 2, 'A'));
  check('field LWW: the later ts wins regardless of arrival order', cards(s)[0].title === 'Shopping', cards(s)[0].title);
  applyAction(s, act('card.set', { id: 'c1', fields: { notes: 'n' } }, 2, 'A'));
  check('a different field with an older ts still applies', cards(s)[0].notes === 'n');
  check('unknown fields are ignored', (applyAction(s, act('card.set', { id: 'c1', fields: { hacker: 1 } }, 9)), cards(s)[0].hacker === undefined));
}

// --- items: add wins, delete wins over edit, check LWW ------------------------
{
  const s = emptyState();
  applyAction(s, act('card.put', { card: card() }, 1));
  applyAction(s, act('item.put', { cardId: 'c1', item: { id: 'i3', text: 'Bread', done: false }, at: 0 }, 2, 'B'));
  check('item.put adds an unknown item at the given position', cards(s)[0].items.map((i) => i.id).join() === 'i3,i1,i2');
  applyAction(s, act('item.set', { cardId: 'c1', itemId: 'i1', done: true }, 3, 'A'));
  applyAction(s, act('item.set', { cardId: 'c1', itemId: 'i2', done: true }, 3, 'B'));
  const c = cards(s)[0];
  check('checks on two different items from two devices both land', c.items.find((i) => i.id === 'i1').done && c.items.find((i) => i.id === 'i2').done);
  check('derivation runs on replay: 2 of 3 checked -> doing', c.status === 'doing');
  applyAction(s, act('item.set', { cardId: 'c1', itemId: 'i1', done: false }, 2, 'B'));
  check('an older uncheck loses to the newer check (LWW)', cards(s)[0].items.find((i) => i.id === 'i1').done === true);
  applyAction(s, act('item.delete', { cardId: 'c1', itemId: 'i3' }, 4, 'A'));
  applyAction(s, act('item.put', { cardId: 'c1', item: { id: 'i3', text: 'Brown bread', done: false } }, 3, 'B'));
  check('delete wins over an older edit', !cards(s)[0].items.some((i) => i.id === 'i3'));
  applyAction(s, act('item.put', { cardId: 'c1', item: { id: 'i3', text: 'Bread', done: false } }, 5, 'B'));
  check('a newer put (undo) restores a deleted item', cards(s)[0].items.some((i) => i.id === 'i3'));
  applyAction(s, act('item.set', { cardId: 'c1', itemId: 'i3', done: true }, 6));
  check('all checked -> done with completedAt on replay', cards(s)[0].status === 'done' && !!cards(s)[0].completedAt);
  applyAction(s, act('items.order', { cardId: 'c1', ids: ['i2', 'i3', 'i1'] }, 7));
  check('items.order reorders by id', cards(s)[0].items.map((i) => i.id).join() === 'i2,i3,i1', cards(s)[0].items.map((i) => i.id).join());
}

// --- card delete / tombstones / resurrect by newer put -----------------------
{
  const s = emptyState();
  applyAction(s, act('card.put', { card: card() }, 1));
  applyAction(s, act('card.delete', { id: 'c1' }, 3, 'A'));
  applyAction(s, act('card.set', { id: 'c1', fields: { title: 'Late edit' } }, 2, 'B'));
  check('delete beats an older edit', cards(s).length === 0);
  applyAction(s, act('card.set', { id: 'c1', fields: { title: 'Later edit' } }, 4, 'B'));
  check('a set after a delete does not resurrect the card', cards(s).length === 0);
  applyAction(s, act('card.put', { card: card({ title: 'Back' }) }, 5, 'A'));
  check('a newer card.put (undo) resurrects it', cards(s).length === 1 && cards(s)[0].title === 'Back');
  applyAction(s, act('card.delete', { id: 'c1' }, 6));
  check('snapshot lists the tombstone', snapshot(s).tombstones.includes('c1'));
  pruneTombstones(s, new Date(Date.UTC(2026, 1, 15)).toISOString(), 30);
  check('tombstones older than 30 days are pruned', !snapshot(s).tombstones.includes('c1'));
}

// --- same title on two devices = two cards; plain card status LWW -------------
{
  const s = emptyState();
  applyAction(s, act('card.put', { card: card({ id: 'a', items: [] }) }, 1, 'A'));
  applyAction(s, act('card.put', { card: card({ id: 'b', items: [] }) }, 1, 'B'));
  check('two devices adding the same title create two cards', cards(s).length === 2);
  applyAction(s, act('card.set', { id: 'a', fields: { status: 'done', completedAt: T(2) } }, 2, 'A'));
  check('plain card status syncs as a field', cards(s).find((c) => c.id === 'a').status === 'done');
}

// --- diffCards: the client emits actions from a before/after pair -------------
{
  const before = [card()];
  const after = [card({ title: 'Shopping', items: [{ id: 'i9', text: 'New', done: false }, { id: 'i1', text: 'Milk', done: true }] }), card({ id: 'c2', title: 'Other' })];
  const actions = diffCards(before, after, T(5), 'A');
  const types = actions.map((a) => a.type).sort().join();
  check('diffCards emits set/put/delete for the changed card and a put for the new one', types === 'card.put,card.set,item.delete,item.put,item.set', types);
  const reordered = diffCards([card()], [card({ items: [{ id: 'i2', text: 'Eggs', done: false }, { id: 'i1', text: 'Milk', done: false }] })], T(5), 'A');
  check('diffCards emits items.order for a pure reorder', reordered.length === 1 && reordered[0].type === 'items.order');
  const s = emptyState();
  applyAction(s, act('card.put', { card: card() }, 1));
  for (const a of actions) applyAction(s, a);
  const c = cards(s).find((x) => x.id === 'c1');
  check('replaying the diff reproduces the after state', c.title === 'Shopping' && c.items.map((i) => i.id + (i.done ? '*' : '')).join() === 'i9,i1*' && cards(s).length === 2, JSON.stringify(c.items));
  check('diffCards of identical boards is empty', diffCards(after, after, T(6), 'A').length === 0);
  const del = diffCards(after, [after[0]], T(7), 'A');
  check('diffCards emits card.delete for a removed card', del.length === 1 && del[0].type === 'card.delete' && del[0].payload.id === 'c2');
}

// --- labels: per-label LWW, tombstones, resurrect; card labels/links/ext as fields ---
{
  const s = emptyState();
  const L = (over = {}) => ({ id: 'l1', name: 'Work', color: '#2E9E6B', ...over });
  applyAction(s, act('label.put', { label: L() }, 1));
  check('label.put creates a label', snapshot(s).labels.length === 1 && snapshot(s).labels[0].name === 'Work');
  applyAction(s, act('label.put', { label: L({ name: 'Job' }) }, 3, 'B'));
  applyAction(s, act('label.put', { label: L({ name: 'Old' }) }, 2, 'A'));
  check('label LWW: the later ts wins regardless of arrival order', snapshot(s).labels[0].name === 'Job');
  applyAction(s, act('label.put', { label: L({ color: 'red' }) }, 4));
  check('an invalid color keeps the previous one', snapshot(s).labels[0].color === '#2E9E6B');
  applyAction(s, act('label.delete', { id: 'l1' }, 6));
  applyAction(s, act('label.put', { label: L({ name: 'Stale' }) }, 5, 'B'));
  check('label delete beats an older put', snapshot(s).labels.length === 0 && snapshot(s).labelTombstones.includes('l1'));
  applyAction(s, act('label.put', { label: L({ name: 'Back' }) }, 7));
  check('a newer label.put (undo) resurrects the label', snapshot(s).labels[0]?.name === 'Back' && !snapshot(s).labelTombstones.includes('l1'));
  applyAction(s, act('label.delete', { id: 'l1' }, 8));
  pruneTombstones(s, new Date(Date.UTC(2026, 1, 15)).toISOString(), 30);
  check('label tombstones older than 30 days are pruned', !snapshot(s).labelTombstones.includes('l1'));

  applyAction(s, act('card.put', { card: card({ labels: ['l1'] }) }, 1));
  applyAction(s, act('card.set', { id: 'c1', fields: { labels: ['l1', 'l2'] } }, 3, 'B'));
  applyAction(s, act('card.set', { id: 'c1', fields: { labels: [] } }, 2, 'A'));
  check('card labels are a whole-array LWW field', cards(s)[0].labels.join() === 'l1,l2', JSON.stringify(cards(s)[0].labels));
  applyAction(s, act('card.set', { id: 'c1', fields: { links: [{ title: 'Doc', url: 'https://x.test/a' }], ext: { key: 'k1' } } }, 4));
  check('links and ext sync as fields', cards(s)[0].links?.[0].url === 'https://x.test/a' && cards(s)[0].ext?.key === 'k1');
  applyAction(s, act('card.set', { id: 'c1', fields: { ext: null } }, 5));
  check('a null ext clears the field', cards(s)[0].ext === undefined);
  const old = emptyState();
  applyAction(old, act('card.put', { card: (({ labels, ...c }) => c)(card()) }, 1));
  check('a card without labels (old data) gets an empty array', Array.isArray(cards(old)[0].labels) && cards(old)[0].labels.length === 0);
}

// --- diffLabels / diffCards over the new fields; stateFromCards stamps labels ----------
{
  const a = [{ id: 'l1', name: 'Work', color: '#111111' }, { id: 'l2', name: 'Home', color: '#222222' }];
  const b = [{ id: 'l1', name: 'Job', color: '#111111' }, { id: 'l3', name: 'New', color: '#333333' }];
  const out = diffLabels(a, b, T(9), 'A');
  const kinds = out.map((x) => x.type + ':' + (x.payload.id ?? x.payload.label.id)).sort().join();
  check('diffLabels emits delete for a removed label and put for edited/new ones', kinds === 'label.delete:l2,label.put:l1,label.put:l3', kinds);
  check('diffLabels of identical lists is empty', diffLabels(a, JSON.parse(JSON.stringify(a)), T(9), 'A').length === 0);
  const c0 = card({ labels: ['l1'], links: [{ title: 'A', url: 'https://a.test' }] });
  const same = diffCards([c0], [JSON.parse(JSON.stringify(c0))], T(9), 'A');
  check('diffCards compares labels/links by value (a clone emits nothing)', same.length === 0, JSON.stringify(same));
  const ch = diffCards([c0], [{ ...c0, labels: ['l1', 'l2'] }], T(9), 'A');
  check('diffCards emits a labels field change', ch.length === 1 && ch[0].type === 'card.set' && ch[0].payload.fields.labels.join() === 'l1,l2');
  const s = stateFromCards([], [{ id: 'sherlock', name: 'Sherlock', color: '#7C5CFF' }]);
  applyAction(s, act('label.put', { label: { id: 'sherlock', name: 'Detective', color: '#7C5CFF' } }, 1, 'B'));
  check('an unstamped (seeded) label loses to any real edit', snapshot(s).labels[0].name === 'Detective');
}

// --- reminders sync as fields -------------------------------------------------------------
{
  const s = emptyState();
  applyAction(s, act('card.put', { card: card() }, 1));
  applyAction(s, act('card.set', { id: 'c1', fields: { remindAt: T(100), remindedAt: null } }, 2, 'A'));
  applyAction(s, act('card.set', { id: 'c1', fields: { remindedAt: T(101) } }, 3, 'server'));
  check('remindAt / remindedAt sync as LWW fields', cards(s)[0].remindAt === T(100) && cards(s)[0].remindedAt === T(101));
  const d = diffCards([card({ remindAt: null, remindedAt: null })], [card({ remindAt: T(5), remindedAt: null })], T(9), 'A');
  check('diffCards emits a remindAt change', d.length === 1 && d[0].payload.fields.remindAt === T(5));
}

// --- leaving Done: Reopen / To do on a fully checked list lands in To do ------------------
{
  const doneCard = card({ status: 'done', completedAt: T(1), items: [{ id: 'i1', text: 'Milk', done: true }, { id: 'i2', text: 'Eggs', done: true }, { id: 'i3', text: 'Bread', done: true }] });
  const replay = (actions) => { const s = emptyState(); applyAction(s, act('card.put', { card: doneCard }, 1)); for (const a of actions) applyAction(s, a); return cards(s)[0]; };
  const reopened = { ...doneCard, status: 'todo', completedAt: null, order: 7, items: doneCard.items.map((i) => ({ ...i, done: false })) };
  const acts = diffCards([doneCard], [reopened], T(5), 'A');
  const firstSet = acts.findIndex((a) => a.type === 'card.set');
  check('diffCards emits item changes before the card.set', firstSet === acts.length - 1 && acts.slice(0, firstSet).every((a) => a.type.startsWith('item')), acts.map((a) => a.type).join());
  const r = replay(acts);
  check('Reopen / To do on a checked list replays to To do (not Doing)', r.status === 'todo' && r.completedAt === null && r.items.every((i) => !i.done), r.status);
  // Clients on the previous bundle still send card.set first: the explicit To do still wins.
  const oldOrder = [acts[firstSet], ...acts.slice(0, firstSet)];
  const r2 = replay(oldOrder);
  check('...also when card.set arrives before the item changes (old clients)', r2.status === 'todo' && r2.completedAt === null, r2.status);
  const partial = { ...doneCard, status: 'doing', completedAt: null, items: doneCard.items.map((i) => (i.id === 'i2' ? { ...i, done: false } : i)) };
  const p1 = replay(diffCards([doneCard], [partial], T(5), 'A'));
  check('a partial uncheck from Done still goes to Doing', p1.status === 'doing' && p1.completedAt === null, p1.status);
  const p2 = replay([...diffCards([doneCard], [partial], T(5), 'A')].reverse());
  check('...in either action order', p2.status === 'doing', p2.status);
  const open = { ...doneCard, status: 'todo', completedAt: null, items: doneCard.items.map((i) => ({ ...i, done: false })) };
  const back = { ...open, status: 'done', completedAt: T(9), items: open.items.map((i) => ({ ...i, done: true })) };
  const s = emptyState();
  applyAction(s, act('card.put', { card: open }, 1));
  for (const a of diffCards([open], [back], T(9), 'A')) applyAction(s, a);
  check('check all to Done still works', cards(s)[0].status === 'done' && !!cards(s)[0].completedAt);
  // An explicit To do from an OLDER batch must not override later checks.
  const s3 = emptyState();
  applyAction(s3, act('card.put', { card: doneCard }, 1));
  applyAction(s3, act('card.set', { id: 'c1', fields: { status: 'todo' } }, 2, 'A'));
  for (const id of ['i1', 'i2', 'i3']) applyAction(s3, act('item.set', { cardId: 'c1', itemId: id, done: false }, 3, 'B'));
  applyAction(s3, act('item.set', { cardId: 'c1', itemId: 'i1', done: true }, 4, 'B'));
  check('a later check on another device moves it to Doing as usual', cards(s3)[0].status === 'doing', cards(s3)[0].status);
}

// --- a move across the Someday divider syncs as someday + order -----------------------------
{
  const before = card({ items: [], order: 2 });
  const after = { ...before, someday: true, order: -1 };
  const acts = diffCards([before], [after], T(5), 'A');
  check('crossing the divider is one card.set with someday + order', acts.length === 1 && acts[0].type === 'card.set' && acts[0].payload.fields.someday === true && acts[0].payload.fields.order === -1, JSON.stringify(acts));
  const s = emptyState();
  applyAction(s, act('card.put', { card: before }, 1));
  for (const a of acts) applyAction(s, a);
  check('...and another replica converges on it', cards(s)[0].someday === true && cards(s)[0].order === -1);
  applyAction(s, act('card.set', { id: 'c1', fields: { someday: false, remindedAt: T(3) } }, 6, 'B'));
  check('leaving Someday syncs the missed stamp in the same write', cards(s)[0].someday === false && cards(s)[0].remindedAt === T(3));
}

// --- attachments: per attachment by id, LWW with tombstones ------------------------------------
{
  const att = (id, over = {}) => ({ id, name: id + '.png', type: 'image/png', size: 10, createdAt: T(1), ...over });
  const s = emptyState();
  applyAction(s, act('card.put', { card: card() }, 1));
  applyAction(s, act('att.put', { cardId: 'c1', att: att('a1') }, 2, 'A'));
  applyAction(s, act('att.put', { cardId: 'c1', att: att('b1', { createdAt: T(2) }) }, 2, 'B'));
  check('concurrent att.put from two devices: both survive', (cards(s)[0].attachments ?? []).map((a) => a.id).join() === 'a1,b1', JSON.stringify(cards(s)[0].attachments));
  applyAction(s, act('att.delete', { cardId: 'c1', attId: 'a1' }, 3, 'A'));
  check('att.delete removes it', cards(s)[0].attachments.map((a) => a.id).join() === 'b1');
  applyAction(s, act('att.put', { cardId: 'c1', att: att('a1') }, 2, 'C'));
  check('an older att.put (a slow device) does not resurrect a deleted attachment', cards(s)[0].attachments.map((a) => a.id).join() === 'b1');
  applyAction(s, act('att.put', { cardId: 'c1', att: att('a1') }, 4, 'A'));
  check('undo: a newer att.put restores it', cards(s)[0].attachments.map((a) => a.id).join() === 'a1,b1');
  applyAction(s, act('att.delete', { cardId: 'c1', attId: 'a1' }, 3, 'B'));
  check('a delete older than the restore loses', cards(s)[0].attachments.some((a) => a.id === 'a1'));
  applyAction(s, act('att.put', { cardId: 'c1', att: att('b1', { name: 'renamed.png', createdAt: T(2) }) }, 5, 'A'));
  check('a newer put updates the metadata (LWW)', cards(s)[0].attachments.find((a) => a.id === 'b1').name === 'renamed.png');
  const unsafe = emptyState();
  applyAction(unsafe, act('card.put', { card: card() }, 1));
  applyAction(unsafe, act('att.put', { cardId: 'c1', att: { id: 'z', name: 'x'.repeat(500), type: 7, size: 'big', extra: 'dropped' } }, 2));
  const z = cards(unsafe)[0].attachments[0];
  check('att fields are cleaned (name capped, unknown fields dropped)', z.name.length === 200 && z.type === 'application/octet-stream' && z.size === 0 && !('extra' in z), JSON.stringify(z));
  // diff + replay, and old data without the field
  const before = card({ items: [] });
  const after = { ...before, attachments: [att('n1'), att('n2', { createdAt: T(2) })] };
  const d1 = diffCards([before], [after], T(6), 'A');
  check('diff: two new attachments → two att.put', d1.filter((a) => a.type === 'att.put').length === 2 && d1.every((a) => a.type === 'att.put'), JSON.stringify(d1.map((a) => a.type)));
  const d2 = diffCards([after], [{ ...after, attachments: [att('n2', { createdAt: T(2) })] }], T(7), 'A');
  check('diff: a removed attachment → att.delete', d2.length === 1 && d2[0].type === 'att.delete' && d2[0].payload.attId === 'n1');
  const d3 = diffCards([after], [{ ...after, attachments: [] }], T(8), 'A');
  check('diff: [] and absent are the same "none"', diffCards([{ ...before, attachments: [] }], [before], T(8), 'A').length === 0 && d3.length === 2);
  const r = emptyState();
  applyAction(r, act('card.put', { card: before }, 1));
  for (const a of [...d1, ...d2]) applyAction(r, a);
  check('replay reproduces the attachments', cards(r)[0].attachments.map((a) => a.id).join() === 'n2');
  applyAction(r, act('att.delete', { cardId: 'c1', attId: 'n2' }, 9));
  check('the last attachment gone: the field is dropped (none = absent)', !('attachments' in cards(r)[0]));
  const old = emptyState();
  applyAction(old, act('card.put', { card: card() }, 1));
  check('old data without attachments loads fine', !('attachments' in cards(old)[0]));
  const boot = stateFromCards([{ ...card(), attachments: [att('k1')] }]);
  check('bootstrap (card.put) carries attachments', cards(boot)[0].attachments[0].id === 'k1');
  const gone = emptyState();
  applyAction(gone, act('card.put', { card: card() }, 1));
  applyAction(gone, act('att.put', { cardId: 'c1', att: att('p1') }, 2));
  applyAction(gone, act('att.delete', { cardId: 'c1', attId: 'p1' }, 3));
  pruneTombstones(gone, new Date(Date.parse(T(3)) + 31 * 86400000).toISOString(), 30);
  check('attachment tombstones older than 30 days are pruned', !gone.meta.c1.att?.p1);
}

console.log('');
console.log(failures === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
