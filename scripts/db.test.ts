// Hermetic data-layer test for src/lib/db.ts — the IndexedDB layer (via `idb`)
// that `test:sync` never touches: it exercises the *real* db.ts against
// `fake-indexeddb` (a spec-conformant IndexedDB shim for Node). This is the
// coverage that would have caught the 2026-09-01 "stuck on Loading…" class of
// bug (a broken open/upgrade path) instead of shipping it. Run: `npm run test:db`.
//
// No test framework — the same explicit assertion harness as test:sync
// (prints ok/FAIL, exits non-zero on any failure). Runs TypeScript directly via
// `tsx` and uses `fake-indexeddb` for the IDB globals. Node >= 18.
import 'fake-indexeddb/auto';
import {
   db,
  uid,
  loadBoard,
  upsertCard,
  removeCard,
  loadSettings,
  saveSettings,
  enqueueActions,
  readOutbox,
  clearOutbox,
  outboxCount,
  saveLabels,
  loadLabelFilter,
  saveLabelFilter,
} from '../src/lib/db';
import type { BoardSettings, Card } from '../src/lib/types';
import { DEFAULT_SETTINGS } from '../src/lib/types';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log('  ok        ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + ' ' + extra);
    }
};
const nowIso = () => new Date().toISOString();

// Build a valid Card for upsert/remove scenarios.
function makeCard(over: Partial<Card> = {}): Card {
  const ts = nowIso();
  return {
    id: over.id ?? uid(),
    title: over.title ?? 'Card',
    notes: over.notes ?? '',
    status: over.status ?? 'todo',
    items: over.items ?? [],
    order: over.order ?? 0,
    createdAt: over.createdAt ?? ts,
    updatedAt: over.updatedAt ?? ts,
    completedAt: over.completedAt ?? null,
    archivedAt: over.archivedAt ?? null,
    someday: over.someday ?? false,
    repeat: over.repeat ?? false,
    labels: over.labels ?? [],
     };
}

// db.ts caches a single module-level connection, and fake-indexeddb exposes one
// global `indexedDB`, so every scenario shares the same `kept` database. Reset
// the *data* (not the connection) before scenarios that assume a clean slate.
const reset = async () => {
  const d = await db();
  await d.clear('cards');
  await d.clear('settings');
  await d.clear('outbox');
};

const run = async () => {
       // 1. open + upgrade works at all — the regression class of "stuck on Loading…".
  await reset();
  check('db() opens + upgrade runs without throwing', true);

       // 2. loadBoard on an empty db returns the defaults and zero corrupt records.
  await reset();
      {
    const board = await loadBoard(DEFAULT_SETTINGS);
    check('empty loadBoard -> 0 cards', board.cards.length === 0, 'got ' + board.cards.length);
    check('empty loadBoard -> settings are the defaults', JSON.stringify(board.settings) === JSON.stringify(DEFAULT_SETTINGS), JSON.stringify(board.settings));
    check('empty loadBoard -> corrupt is 0', board.corrupt === 0, 'got ' + board.corrupt);
    check('empty loadBoard -> schemaVersion 1', board.schemaVersion === 1, 'got ' + board.schemaVersion);
        }

       // 3. upsertCard then loadBoard reads it back, sorted by order.
  await reset();
      {
    await upsertCard(makeCard({ id: 'c-a', order: 5, title: 'five' }));
    await upsertCard(makeCard({ id: 'c-b', order: 2, title: 'two' }));
    await upsertCard(makeCard({ id: 'c-c', order: 8, title: 'eight' }));
    const board = await loadBoard(DEFAULT_SETTINGS);
    check('loadBoard read back all 3 cards', board.cards.length === 3, 'got ' + board.cards.length);
    const ids = board.cards.map((c) => c.id);
    check('loadBoard returns cards sorted by order', JSON.stringify(ids) === JSON.stringify(['c-b', 'c-a', 'c-c']), JSON.stringify(ids));
        }

       // 4. upsertCard with the same id overwrites, not appends.
  await reset();
      {
    await upsertCard(makeCard({ id: 'c-x', title: 'first', notes: 'v1' }));
    await upsertCard(makeCard({ id: 'c-x', title: 'second', notes: 'v2' }));
    const board = await loadBoard(DEFAULT_SETTINGS);
    check('upsert overwrites same id -> still 1 card', board.cards.length === 1, 'got ' + board.cards.length);
    check('upsert kept the latest value', board.cards[0]?.title === 'second' && board.cards[0]?.notes === 'v2', JSON.stringify(board.cards[0] ?? null));
        }

       // 5. removeCard deletes just that card.
  await reset();
      {
    await upsertCard(makeCard({ id: 'keep' }));
    await upsertCard(makeCard({ id: 'drop' }));
    await removeCard('drop');
    const board = await loadBoard(DEFAULT_SETTINGS);
    check('removeCard removed only the target', board.cards.length === 1 && board.cards[0]?.id === 'keep', JSON.stringify(board.cards.map((c) => c.id)));
        }

       // 6. saveSettings / loadSettings round-trip; absent settings yield the fallback.
  await reset();
      {
    const fallback = DEFAULT_SETTINGS;
    check('loadSettings absent -> fallback', JSON.stringify(await loadSettings(fallback)) === JSON.stringify(fallback));

    const saved: BoardSettings = { ...DEFAULT_SETTINGS, theme: 'dark', archiveAfterDays: 30 };
    await saveSettings(saved);
    const loaded = await loadSettings(fallback);
    check('saveSettings then loadSettings round-trips', JSON.stringify(loaded) === JSON.stringify(saved), JSON.stringify(loaded) + ' vs ' + JSON.stringify(saved));

        // loadBoard picks up the persisted settings row too.
    const board = await loadBoard(fallback);
    check('loadBoard reads persisted settings', JSON.stringify(board.settings) === JSON.stringify(saved), JSON.stringify(board.settings));
        }

       // 7. a corrupt record is skipped and counted (the "Corrupt record" hint).
  await reset();
      {
      // Store a valid card and a corrupt one; only the valid one survives.
    await upsertCard(makeCard({ id: 'good', order: 0 }));
        // A record with an id (so it stores) but no items array is corrupt.
    const bad = { id: 'bad', title: 'corrupt', status: 'todo', order: 1 };
    await (await db()).put('cards', bad as unknown as Card);
    const board = await loadBoard(DEFAULT_SETTINGS);
    check('corrupt record is skipped', board.cards.length === 1 && board.cards[0]?.id === 'good', JSON.stringify(board.cards.map((c) => c.id)));
    check('corrupt record is counted', board.corrupt === 1, 'got ' + board.corrupt);
        }

       // 8. outbox: enqueueActions appends; readOutbox returns them in oid order;
      // clearOutbox removes pushed rows. The outbox never leaks into the card load.
  await reset();
      {
    check('outbox starts empty', (await outboxCount()) === 0);
    const act = (type: string, payload: object, n: number) => ({ id: 'a' + n, deviceId: 'D', ts: new Date(n).toISOString(), type: type as 'card.put', payload: payload as Record<string, unknown> });
    await enqueueActions([act('card.put', { card: { id: 'x' } }, 1), act('item.set', { cardId: 'x', itemId: 'i', done: true }, 2), act('card.delete', { id: 'y' }, 3)]);

    const rows = await readOutbox();
    check('readOutbox returns all 3 enqueued actions', rows.length === 3, 'got ' + rows.length);
    check('rows carry the full action', rows[0]?.action.type === 'card.put' && rows[1]?.action.type === 'item.set' && rows[2]?.action.payload.id === 'y', JSON.stringify(rows.map((r) => r.action.type)));
    check('rows are oid-ordered', rows[0].oid < rows[1].oid && rows[1].oid < rows[2].oid);
    await clearOutbox(rows.slice(0, 2).map((r) => r.oid));
    const left = await readOutbox();
    check('clearOutbox removes exactly the pushed rows', left.length === 1 && left[0].action.id === 'a3', JSON.stringify(left.map((r) => r.action.id)));

        // Enqueueing actions must not pollute the card store.
    const board = await loadBoard(DEFAULT_SETTINGS);
    check('outbox stays separate from cards', board.cards.length === 0, 'got ' + board.cards.length);
        }

  // --- labels: board labels + the device-only filter live in the settings store ---
  {
    await reset();
    const fresh = await loadBoard(DEFAULT_SETTINGS);
    check('a board with no labels row still has the built-in Sherlock label', fresh.labels.length === 4 && fresh.labels[0].id === 'sherlock' && fresh.labels[0].color === '#7C5CFF');
    await saveLabels([{ id: 'w', name: 'Work', color: '#2E9E6B' }, { id: 'sherlock', name: 'Detective', color: '#000000' }]);
    const b = await loadBoard(DEFAULT_SETTINGS);
    check('saved labels load back; a renamed built-in is kept, not re-seeded', b.labels.length === 5 && b.labels.find((l) => l.id === 'sherlock')?.name === 'Detective');
    check('labels do not disturb settings', (await loadSettings(DEFAULT_SETTINGS)).archiveAfterDays === DEFAULT_SETTINGS.archiveAfterDays);
    const legacy = makeCard({ id: 'old' }) as Partial<Card>;
    delete legacy.labels;
    await (await db()).put('cards', legacy as Card);
    const withOld = await loadBoard(DEFAULT_SETTINGS);
    check('an old card row without labels loads with labels: []', Array.isArray(withOld.cards.find((c) => c.id === 'old')?.labels));
    check('the label filter defaults to none', (await loadLabelFilter()).length === 0);
    await saveLabelFilter(['w']);
    check('the label filter round-trips', (await loadLabelFilter()).join() === 'w');
  }
};

try {
  await run();
} catch (e) {
  failures++;
  console.log('THREW: ' + (e && (e as Error).stack ? (e as Error).stack : String(e)));
}
console.log('');
console.log(failures === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failures} FAILED`);
// fake-indexeddb keeps connections open; force exit so CI terminates promptly
// while still giving stdout a beat to flush.
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 100);
