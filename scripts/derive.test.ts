// Pure unit tests for src/lib/derive.ts — §6, the checklist core rules, the
// "heart of the app". No async, no storage: the derivation is a pure function
// of (items, prevStatus). Run: `npm run test:derive`.
//
// Same explicit-assertion harness as test:sync / test:db (no framework).
import { deriveStatus, applyStatus, progress } from '../src/lib/derive';
import type { Card } from '../src/lib/types';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log('  ok         ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + ' ' + extra);
     }
};

// A minimal card with a given checklist; status + completedAt are what we assert.
const card = (itemsDone: boolean[], status: Card['status'], completedAt: string | null = null): Card =>
   ({
     id: 'c',
    title: 'c',
    notes: '',
    status,
    items: itemsDone.map((done, i) => ({ id: 'i' + i, text: 'i' + i, done })),
    order: 0,
    createdAt: '0',
    updatedAt: '0',
    completedAt,
    archivedAt: null,
    someday: false,
    repeat: false,
     } as Card);

// --- deriveStatus -------------------------------------------------------------
check('no items -> status unchanged (plain card sticks)', deriveStatus([], 'doing') === 'doing');
check('all checked -> done', deriveStatus([true, true], 'todo') === 'done');
check('some checked -> doing', deriveStatus([true, false], 'todo') === 'doing');
check('none checked, was done -> todo (uncheck all reuses the card)', deriveStatus([false, false], 'done') === 'todo');
check('none checked, was todo -> stays todo', deriveStatus([false, false], 'todo') === 'todo');
check('none checked, was doing -> stays doing', deriveStatus([false, false], 'doing') === 'doing');
check('first check on a to-do card moves it to doing', deriveStatus([true, false, false], 'todo') === 'doing');
check('last check moves to done', deriveStatus([false, true, false], 'doing') === 'doing');
check('adding an unchecked item to a done card -> doing', deriveStatus([true, true, false], 'done') === 'doing');

// --- applyStatus --------------------------------------------------------------
{
  const c = card([false, false], 'todo');
  const changed = applyStatus(c, '2026-01-01T00:00:00Z');
  check('applyStatus no items/none-checked: no change, returns false', changed === false && c.status === 'todo');
  check('applyStatus clears completedAt when not done', c.completedAt === null);
}
{
  const c = card([true, false], 'todo');
  const changed = applyStatus(c, '2026-01-01T00:00:00Z');
  check('applyStatus some-checked -> doing, returns true', changed === true && c.status === 'doing');
}
{
  const c = card([true, true], 'doing');
  const changed = applyStatus(c, '2026-01-01T00:00:00Z');
  check('applyStatus all-checked -> done, stamps now', changed === true && c.status === 'done' && c.completedAt === '2026-01-01T00:00:00Z');
}
{
  // Preserves an existing completedAt when the card is already done.
  const c = card([true, true], 'done', '2025-12-01T00:00:00Z');
  const changed = applyStatus(c, '2026-01-01T00:00:00Z');
  check('applyStatus stays done: preserves completedAt, returns false', changed === false && c.status === 'done' && c.completedAt === '2025-12-01T00:00:00Z');
}
{
  // Uncheck one item on a done card -> doing, completedAt cleared.
  const c = card([true, false], 'done', '2025-12-01T00:00:00Z');
  const changed = applyStatus(c, '2026-01-01T00:00:00Z');
  check('applyStatus uncheck-on-done -> doing, clears completedAt', changed === true && c.status === 'doing' && c.completedAt === null);
}
{
  // Remove all items -> back to a plain card, keeps last status.
  const c = card([], 'done', '2025-12-01T00:00:00Z');
  const changed = applyStatus(c, '2026-01-01T00:00:00Z');
  check('applyStatus empty items keeps last status (done)', changed === false && c.status === 'done');
}

// --- progress -----------------------------------------------------------------
check('progress counts done/total', JSON.stringify(progress([{ done: true }, { done: false }, { done: true }])) === JSON.stringify({ done: 2, total: 3 }));
check('progress of empty is 0/0', JSON.stringify(progress([])) === JSON.stringify({ done: 0, total: 0 }));

console.log('');
console.log(failures === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
