// Notes (v5/v6) data layer: titles, markdown stripping, linked rows through the merge, migration.
import { applyAction, diffCards, emptyState, snapshot, stateFromCards } from '../shared/merge.mjs';
import { cleanTitle, needsLabel, needsTitle, pickLabel } from '../shared/note-ai.mjs';
import { bodyLinks, displayTitle, firstImage, isCardDone, migrateCard, parentsOf, shortTitle, stripMd, wouldCycle } from '../shared/notes.mjs';
import { migrateLinkedNotes } from '../shared/workflow.mjs';

let failed = 0;
let passed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : `\n   got ${JSON.stringify(actual)}\n  want ${JSON.stringify(expected)}`}`);
}

const ts = (n) => new Date(Date.UTC(2026, 9, 6, 10, 0, n)).toISOString();
const base = (o) => ({ id: 'x', title: '', notes: '', status: 'todo', order: 0, items: [], labels: [], createdAt: ts(0), updatedAt: ts(0), completedAt: null, archivedAt: null, someday: false, repeat: false, ...o });

// --- titles ---------------------------------------------------------------------
check('stripMd drops marks, keeps words', stripMd('## Dough\n- [ ] Mix **well**\n![s](a.jpg)\n[The Loaf](https://x.test)'), 'Dough\nMix well\n\nThe Loaf');
check('a typed title wins', displayTitle(base({ title: 'Renew passport', notes: 'whatever' })), 'Renew passport');
check('no title: the first line of the body', displayTitle(base({ notes: '\n# Guest Wi-Fi details are in the router app.\nmore' })), 'Guest Wi-Fi details are in the router app.');
check('a long first line is cut at a word with an ellipsis', shortTitle('Ask the landlord whether the boiler service is booked before November please'), 'Ask the landlord whether the boiler service is booked…');
check('empty: Untitled', displayTitle(base({})), 'Untitled');
check('first image is the thumbnail', firstImage('text\n![swatches](/kanban/files/abc)\n![b](c)'), { alt: 'swatches', url: '/kanban/files/abc' });
check('body links skip images, keep bare urls', bodyLinks('[Reference](https://example.org) ![i](https://x/i.png) see https://a.test/b'), [{ title: 'Reference', url: 'https://example.org' }, { title: '', url: 'https://a.test/b' }]);

// --- done-ness ------------------------------------------------------------------------
check('a note is done by its flag, a to do by status', [isCardDone(base({ kind: 'note', done: true })), isCardDone(base({ kind: 'note', status: 'done' })), isCardDone(base({ status: 'done' }))], [true, false, true]);

// --- merge: kind / done / layout / ref --------------------------------------------------------
{
  const s = emptyState();
  const note = base({ id: 'n1', kind: 'note', notes: 'Camping kit', items: [{ id: 'i1', text: 'Tent pegs', done: true }, { id: 'i2', text: 'Water filter', done: false, ref: 'n2' }], layout: { order: 3, w: 1, h: 2 } });
  for (const a of diffCards([], [note], ts(1), 'A')) applyAction(s, a);
  const got = snapshot(s).cards[0];
  check('a note with every row ticked but one is not derived (status stays, no completedAt)', [got.kind, got.status, got.completedAt], ['note', 'todo', null]);
  check('a ref row survives the merge with its ref', got.items.map((i) => i.ref ?? null), [null, 'n2']);
  check('layout survives', got.layout, { order: 3, w: 1, h: 2 });
  // Ticking the ref row: the app writes the mirrored done; deleting the child clears the ref.
  const after = { ...got, items: got.items.map((i) => (i.id === 'i2' ? { id: 'i2', text: 'Water filter', done: false } : i)) };
  for (const a of diffCards([got], [after], ts(2), 'A')) applyAction(s, a);
  check('clearing a ref travels as an item.put with ref null', snapshot(s).cards[0].items[1].ref, undefined);
  const doneNote = { ...snapshot(s).cards[0], done: true, completedAt: ts(3) };
  for (const a of diffCards([snapshot(s).cards[0]], [doneNote], ts(3), 'B')) applyAction(s, a);
  check('a note finished on another device: done + completedAt', [snapshot(s).cards[0].done, snapshot(s).cards[0].completedAt], [true, ts(3)]);
  const reopened = { ...snapshot(s).cards[0], done: false, completedAt: null };
  for (const a of diffCards([snapshot(s).cards[0]], [reopened], ts(4), 'B')) applyAction(s, a);
  check('reopening removes done (absent, not false)', 'done' in snapshot(s).cards[0], false);
  // A to do parent derives from mirrored ref rows.
  const t = emptyState();
  const todo = base({ id: 't1', items: [{ id: 'r1', text: 'Offsite room', done: false, ref: 'n9' }] });
  for (const a of diffCards([], [todo], ts(5), 'A')) applyAction(t, a);
  const ticked = { ...snapshot(t).cards[0], items: [{ id: 'r1', text: 'Offsite room', done: true, ref: 'n9' }] };
  for (const a of diffCards([snapshot(t).cards[0]], [ticked], ts(6), 'A')) applyAction(t, a);
  check('a to do whose only row (a linked note) finished is Done', snapshot(t).cards[0].status, 'done');
  const toNote = { ...snapshot(t).cards[0], kind: 'note' };
  const placed = stateFromCards([toNote]);
  check('a card arriving as a note keeps kind through stateFromCards', snapshot(placed).cards[0].kind, 'note');
}

// --- linked rows: parents and cycles ------------------------------------------------------------
{
  const cards = [base({ id: 'a', items: [{ id: '1', text: '', done: false, ref: 'b' }] }), base({ id: 'b', items: [{ id: '2', text: '', done: false, ref: 'c' }] }), base({ id: 'c' })];
  check('parents of a card', parentsOf(cards, 'c').map((c) => c.id), ['b']);
  check('linking a under c would loop (c is inside a)', wouldCycle(cards, 'c', 'a'), true);
  check('linking c under a is fine', wouldCycle(cards, 'a', 'c'), false);
  check('a card is never its own row', wouldCycle(cards, 'a', 'a'), true);
}

// --- migration ---------------------------------------------------------------------------------
{
  const parent = base({ id: 'parent', items: [{ id: 'row', text: 'Photos', done: false, ref: 'linked' }] });
  const linked = base({ id: 'linked', kind: 'note', workflowVersion: 1, labels: ['project'], items: [{ id: 'a', text: 'Take', done: true }, { id: 'b', text: 'Edit', done: false }] });
  const unrelated = base({ id: 'unrelated', kind: 'note', workflowVersion: 1 });
  const migrated = migrateLinkedNotes([parent, linked, unrelated]);
  check('an existing linked note becomes Doing with its progress and labels', [migrated[1].kind, migrated[1].status, migrated[1].labels], [undefined, 'doing', ['project', 'workflow:doing']]);
  check('an unrelated note stays a note', migrated[2], unrelated);
  check('linked-note migration is idempotent', migrateLinkedNotes(migrated), migrated);
  check('an older linked note also gains a workflow stage', migrateLinkedNotes([parent, { ...linked, workflowVersion: undefined }])[1].labels, ['project', 'workflow:doing']);
}
{
  const old = base({ notes: 'Keep this reference', someday: true, links: [{ title: 'Reference [page]', url: 'https://example.org' }], attachments: [{ id: 'f1', name: 'photo.png', type: 'image/png', size: 1, createdAt: ts(0) }, { id: 'f2', name: 'guide.pdf', type: 'application/pdf', size: 1, createdAt: ts(0) }] });
  const m = migrateCard(old);
  check('migration: Someday becomes a note', [m.kind, m.someday], ['note', false]);
  check('migration: links and files become markdown lines under a blank line', m.notes, 'Keep this reference\n\n[Reference page](https://example.org)\n![photo.png](/kanban/files/f1)\n[guide.pdf](/kanban/files/f2)');
  check('migration: links go, attachments stay', ['links' in m, m.attachments.length], [false, 2]);
  check('migration twice adds nothing', migrateCard(m), null);
  check('a plain card needs no migration', migrateCard(base({ notes: 'x' })), null);
  check('a Someday card already Done stays a to do', migrateCard(base({ someday: true, status: 'done' }))?.kind, undefined);
}

// --- the assistant's jobs --------------------------------------------------------------------------
{
  const long = 'Ask the landlord whether the boiler service is booked before November, the certificate is in the drawer.';
  check('a long untitled note wants a title', needsTitle(base({ kind: 'note', notes: long }), undefined), true);
  check('a typed title is never replaced', needsTitle(base({ kind: 'note', notes: long, title: 'Boiler', titleBy: 'user' }), undefined), false);
  check('a short first line with more lines is its own title', needsTitle(base({ kind: 'note', notes: 'Boiler\n' + long }), undefined), false);
  check('once titled, only a big change asks again', [needsTitle(base({ kind: 'note', notes: long, title: 'Boiler', titleBy: 'ai' }), long.length), needsTitle(base({ kind: 'note', notes: long + ' ' + long, title: 'Boiler', titleBy: 'ai' }), long.length)], [false, true]);
  check('model titles are cleaned or refused', [cleanTitle('"Boiler service."\n'), cleanTitle(''), cleanTitle('x '.repeat(40))], ['Boiler service', null, null]);
  const labels = [{ id: 'h', name: 'Home' }, { id: 'w', name: 'Work' }];
  check('a label answer maps to an id; none and unknown are null', [pickLabel('Home.', labels), pickLabel('none', labels), pickLabel('Garden', labels)], ['h', null, null]);
  check('only unlabelled notes get a suggestion, once', [needsLabel(base({ kind: 'note', notes: 'Fix the garden gate' }), 0), needsLabel(base({ kind: 'note', notes: 'Fix the garden gate', labels: ['h'] }), 0), needsLabel(base({ kind: 'note', notes: 'Fix the garden gate' }), 1)], [true, false, false]);
}

console.log(`\n${failed ? `RESULT: ${failed} FAILED` : 'RESULT: ALL PASS'} (${passed} passed)`);
process.exit(failed ? 1 : 0);
