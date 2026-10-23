// Pure write-path tests for src/lib/reducer.ts — the single mutation path the
// store and window.kanban drive. No async, no storage: given a card/board it
// returns the next card/board. Run: `npm run test:reducer`.
//
// Same explicit-assertion harness as the other scripts (no framework).
import {
  newCard,
  cardFromText,
  addItemsToCard,
  moveCard,
  toggleItem,
  updateCard,
  duplicateCard,
  deleteCard,
  renormaliseColumn,
  canMoveTo,
  columnCards,
  nextOrder,
  checkAll,
  uncheckAll,
  notesToChecklist,
  repeatCopy,
  archiveOlderThan,
  mergeBoards,
  validateBoard,
  removeLabelFromCards,
} from '../src/lib/reducer';
import type { Board, Card, CardItem } from '../src/lib/types';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log('  ok           ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + ' ' + extra);
  }
};

// Deterministic uid + clock so the pure functions are reproducible.
let seq = 0;
const uid = () => 'id' + seq++;
const NOW = '2026-01-01T00:00:00.000Z';
const SETTINGS: Board['settings'] = { reduceMotion: 'system', theme: 'system', archiveAfterDays: 14, lastBackupAt: null };

const item = (text: string, done = false): CardItem => ({ id: uid(), text, done });

// A plain card (no checklist) and a checklist card, both built through newCard.
const plain = () => newCard({ title: 'plain', order: 0, uid, nowIso: NOW });
const checklist = (done: boolean[]) =>
  newCard({
    title: 'task',
    items: done.map((d, i) => ({ id: 'i' + i, text: 'i' + i, done: d })),
    status: 'todo',
    order: 0,
    uid,
    nowIso: NOW,
  });

// --- newCard ------------------------------------------------------------------
{
  const c = newCard({ title: '  Buy  milk   ', order: 3, uid, nowIso: NOW });
  check('newCard trims the title', c.title === 'Buy  milk', c.title);
  check('newCard defaults to to-do when no items derive otherwise', c.status === 'todo');
  check('newCard sets created/updated to nowIso', c.createdAt === NOW && c.updatedAt === NOW);
  check('newCard defaults someday/repeat false', c.someday === false && c.repeat === false);
  check('newCard assigns order', c.order === 3);
}

// --- cardFromText (the composer grammar) --------------------------------------
{
  seq = 0;
  const c = cardFromText('# Ship it\n- [ ] write\ntest\n- [x] done', 5, uid, undefined, NOW);
  check('cardFromText strips a "# " prefix to the title', c.title === 'Ship it', c.title);
  check('cardFromText turns remaining lines into items', c.items.length === 3, JSON.stringify(c.items.map((i) => i.text)));
  check(
    'cardFromText honours [x] as done',
    c.items[2]?.done === true && c.items[0]?.done === false,
    JSON.stringify(c.items.map((i) => i.done)),
  );
}

// --- moveCard -----------------------------------------------------------------
{
  // A plain (no-checklist) card: a manual status sticks.
  check('moveCard on a plain card keeps the chosen status', moveCard(plain(), 'doing', 0, NOW).status === 'doing');
}
{
  // A checklist card moved to done checks every item.
  const c = moveCard(checklist([true, false, false]), 'done', 0, NOW);
  check('moveCard to done checks all items', c.items.every((i) => i.done) && c.status === 'done');
}
{
  // A checklist card moved to to do unchecks every item.
  const c = moveCard(checklist([true, true, true]), 'todo', 0, NOW);
  check('moveCard to do unchecks all items', c.items.every((i) => !i.done) && c.status === 'todo');
}
{
  // §6/§17: Doing is a manual start — nothing gets checked, the card just moves.
  const c = moveCard(checklist([false, false, false]), 'doing', 0, NOW);
  check('moveCard to doing with none checked is a manual start (0/n stays)', c.items.every((i) => !i.done) && c.status === 'doing', JSON.stringify(c.items.map((i) => i.done)) + '/' + c.status);
}
{
  // §6: a fully checked list cannot go to Doing — the move is rejected unchanged.
  const full = checklist([true, true]);
  check('canMoveTo rejects doing on a fully checked list', canMoveTo(full, 'doing') === false);
  check('canMoveTo allows doing on a partly checked list', canMoveTo(checklist([true, false]), 'doing') === true);
  check('canMoveTo allows doing on a plain card', canMoveTo(plain(), 'doing') === true);
  const c = moveCard(full, 'doing', 0, NOW);
  check('moveCard rejected leaves the card untouched', c === full);
}

// --- toggleItem ---------------------------------------------------------------
{
  // Checking the last item of a to-do card moves it to done and stamps it.
  const c = toggleItem(checklist([true, true, false]), 'i2', true, NOW);
  check('toggleItem last check -> done + completedAt', c.status === 'done' && c.completedAt === NOW);
  check('toggleItem stamps updatedAt', c.updatedAt === NOW);
}

// --- updateCard limits --------------------------------------------------------
{
  const overlong = new Array(300).fill('a').join('');
  const c = updateCard(checklist([]), { title: overlong }, NOW);
  check('updateCard truncates the title to TITLE_MAX', c.title.length === 200, 'len=' + c.title.length);
}
{
  // Re-derive on a write: one unchecked item among checked ones -> doing.
  const items = [item('a', true), item('b', true), item('c', false)];
  const c = updateCard(checklist([]), { items }, NOW);
  check('updateCard re-derives status from the checklist', c.status === 'doing' && c.completedAt === null);
}

// --- duplicateCard ------------------------------------------------------------
{
  const src = checklist([true, false]);
  src.someday = true;
  src.repeat = true;
  const srcId = src.id;
  const b: Board = { schemaVersion: 1, cards: [src], settings: SETTINGS };
  const copy = duplicateCard(b, srcId, 9, uid, 'doing', NOW);
  check('duplicateCard makes a new card', !!copy && copy.id !== srcId);
  check('duplicateCard appends a " (copy)" suffix to the title', !!copy && copy.title === src.title + ' (copy)', copy?.title);
  check('duplicateCard gives items new ids', !!copy && copy.items[0]?.id !== src.items[0]?.id);
  check('duplicateCard starts its items unchecked (§7.9 fresh)', !!copy && copy.items.every((i) => !i.done));
  check('duplicateCard carries the target order/status', !!copy && copy.order === 9 && copy.status === 'doing');
  check('duplicateCard copies someday + repeat', !!copy && copy.someday === true && copy.repeat === true);
}

// --- addItemsToCard -----------------------------------------------------------
{
  // New items keep the order they were written: after the last unchecked item, before checked ones.
  const c = newCard({ title: 'order', items: [{ id: 'a', text: 'first', done: false }, { id: 'b', text: 'second', done: false }, { id: 'x', text: 'finished', done: true }], order: 0, uid, nowIso: NOW });
  addItemsToCard(c, 'third\nfourth', uid, NOW);
  addItemsToCard(c, 'fifth', uid, NOW);
  const texts = c.items.map((i) => i.text).join(',');
  check('addItemsToCard appends in written order after the last unchecked item', texts === 'first,second,third,fourth,fifth,finished', texts);
}
{
  // §6: adding an unchecked item to a Done card moves it back to Doing.
  const done = newCard({
    title: 'done',
    items: [{ id: 'd0', text: 'a', done: true }, { id: 'd1', text: 'b', done: true }],
    order: 0,
    uid,
    nowIso: NOW,
   });
  done.completedAt = NOW;
  const added = addItemsToCard(done, 'new thing', uid, NOW);
  check('addItemsToCard adds the new item', added === 1 && done.items.length === 3);
  check('addItemsToCard puts new items after the last unchecked item (here: none, so first)', done.items[0]?.text === 'new thing', JSON.stringify(done.items.map((i) => i.text)));
  check('addItemsToCard an unchecked item on a Done card -> doing', done.status === 'doing', done.status);
  check('addItemsToCard clears completedAt when no longer done', done.completedAt === null, String(done.completedAt));
}
{
  // A complete checklist card stays done and keeps its existing completedAt.
  const done = newCard({
    title: 'done',
    items: [{ id: 'd0', text: 'a', done: true }],
    order: 0,
    uid,
    nowIso: NOW,
   });
  const keepAt = '2025-12-31T23:59:59.000Z';
  done.completedAt = keepAt;
  addItemsToCard(done, '- [x] done too', uid, NOW);
  check('addItemsToCard all-checked adds keep Done + preserve completedAt', done.status === 'done' && done.completedAt === keepAt && done.items.every((i) => i.done), [done.status, done.completedAt, JSON.stringify(done.items.map((i) => i.done))].join('/'));
}

// --- deleteCard ---------------------------------------------------------------
{
  const src = checklist([false]);
  const b: Board = { schemaVersion: 1, cards: [src, checklist([true])], settings: SETTINGS };
  check('deleteCard removes and returns 1', deleteCard(b, src.id) === 1 && b.cards.length === 1);
  check('deleteCard returns 0 for a missing id', deleteCard(b, 'nope') === 0 && b.cards.length === 1);
}

// --- renormaliseColumn --------------------------------------
{
  const cards: Card[] = [
    checklist([false]),
    newCard({ title: 'b', status: 'todo', order: 5, uid, nowIso: NOW }),
    newCard({ title: 'c', status: 'todo', order: 1, uid, nowIso: NOW }),
  ];
  cards[1].status = 'doing';
  cards[2].status = 'doing';
  renormaliseColumn(cards, 'doing');
  check(
    'renormaliseColumn renumbers a column 0,1,2 by order',
    cards[2].order === 0 && cards[1].order === 1,
    JSON.stringify([cards[1].order, cards[2].order]),
  );
}

// --- addItemsToCard keeps typed order after existing items -------------------
{
  const c = newCard({ title: 'l', items: [{ id: 'x', text: 'old', done: false }], order: 0, uid, nowIso: NOW });
  addItemsToCard(c, 'a\nb\nc', uid, NOW);
  check('addItemsToCard multi-line keeps typed order after existing items', c.items.map((i) => i.text).join(',') === 'old,a,b,c', c.items.map((i) => i.text).join(','));
}

// --- columnCards / nextOrder (§4.2) -------------------------------------------
{
  const a = newCard({ title: 'a', status: 'done', order: 0, uid, nowIso: '2026-01-01T00:00:00.000Z' });
  const b = newCard({ title: 'b', status: 'done', order: 1, uid, nowIso: '2026-01-02T00:00:00.000Z' });
  const t1 = newCard({ title: 't1', status: 'todo', order: 5, uid, nowIso: NOW });
  const t2 = newCard({ title: 't2', status: 'todo', order: 2, uid, nowIso: NOW });
  const cards = [a, b, t1, t2];
  check('columnCards sorts Done by completedAt desc, ignoring order', columnCards(cards, 'done').map((c) => c.title).join(',') === 'b,a', columnCards(cards, 'done').map((c) => c.title).join(','));
  check('columnCards sorts To do by order asc', columnCards(cards, 'todo').map((c) => c.title).join(',') === 't2,t1');
  check('columnCards skips archived cards', columnCards([{ ...t1, archivedAt: NOW }, t2], 'todo').length === 1);
  check('nextOrder appends at the bottom (max + 1)', nextOrder(cards, 'todo') === 6, String(nextOrder(cards, 'todo')));
  check('nextOrder on an empty column is 0', nextOrder(cards, 'doing') === 0);
}

// --- checkAll / uncheckAll ----------------------------------------------------
{
  const c = checkAll(checklist([false, false]), NOW);
  check('checkAll checks every item and lands in done', c.items.every((i) => i.done) && c.status === 'done' && c.completedAt === NOW);
  const u = uncheckAll(c, NOW);
  check('uncheckAll clears every item and returns to todo', u.items.every((i) => !i.done) && u.status === 'todo' && u.completedAt === null);
  const started = moveCard(checklist([true, false]), 'doing', 0, NOW);
  check('uncheckAll on a Doing card also resets it to To do (§7.5)', uncheckAll(started, NOW).status === 'todo', uncheckAll(started, NOW).status);
}
{
  // §6 prose: adding an unchecked item to a Done card returns it to Doing — also for a plain Done card.
  const plainDone = moveCard(plain(), 'done', 0, NOW);
  addItemsToCard(plainDone, 'Eggs', uid, NOW);
  check('addItemsToCard on a plain Done card moves it to Doing (0/1)', plainDone.status === 'doing' && plainDone.completedAt === null, plainDone.status);
}

// --- Someday clears on doing / on a check (§4.2a) ----------------------------
{
  const s = checklist([false, false]);
  s.someday = true;
  check('toggleItem checking an item clears someday', toggleItem(s, 'i0', true, NOW).someday === false);
  check('moveCard to doing clears someday', moveCard(s, 'doing', 0, NOW).someday === false);
  check('updateCard title edit keeps someday', updateCard(s, { title: 'x' }, NOW).someday === true);
}

// --- notesToChecklist (§7.4) --------------------------------------------------
{
  const c = newCard({ title: 'n', notes: 'Eggs\n- Spinach\n\n[x] Lemons', order: 0, uid, nowIso: NOW });
  const r = notesToChecklist(c, uid, NOW);
  check('notesToChecklist splits every non-empty note line into an item', r.items.map((i) => i.text).join(',') === 'Eggs,Spinach,Lemons', r.items.map((i) => i.text).join(','));
  check('notesToChecklist honours [x]', r.items[2]?.done === true && r.items[0]?.done === false);
  check('notesToChecklist clears notes and derives status', r.notes === '' && r.status === 'doing');
}

// --- repeatCopy (§4.2b) -------------------------------------------------------
{
  const src = checklist([true, true]);
  src.repeat = true;
  src.notes = 'weekly';
  const cp = repeatCopy(src, 7, uid, NOW);
  check('repeatCopy keeps title + notes, no (copy) suffix', cp.title === src.title && cp.notes === 'weekly', cp.title);
  check('repeatCopy unchecks every item with fresh ids', cp.items.every((i) => !i.done) && cp.items[0]?.id !== src.items[0]?.id);
  check('repeatCopy is a To do repeat card at the given order', cp.status === 'todo' && cp.repeat === true && cp.order === 7 && cp.id !== src.id);
}

// --- archiveOlderThan (§4.3) --------------------------------------------------
{
  const old = newCard({ title: 'old', status: 'done', order: 0, uid, nowIso: '2026-01-01T00:00:00.000Z' });
  const fresh = newCard({ title: 'fresh', status: 'done', order: 1, uid, nowIso: '2026-01-20T00:00:00.000Z' });
  const open = newCard({ title: 'open', status: 'todo', order: 2, uid, nowIso: '2025-01-01T00:00:00.000Z' });
  const b: Board = { schemaVersion: 1, cards: [old, fresh, open], settings: SETTINGS };
  const n = archiveOlderThan(b, 14, '2026-01-21T00:00:00.000Z');
  check('archiveOlderThan archives only done cards past the window', n === 1 && b.cards[0].archivedAt !== null && b.cards[1].archivedAt === null && b.cards[2].archivedAt === null, JSON.stringify(b.cards.map((c) => c.archivedAt)));
  check('archiveOlderThan with 0 days never archives', archiveOlderThan(b, 0, '2030-01-01T00:00:00.000Z') === 0);
}

// --- validateBoard / mergeBoards (§7.13) --------------------------------------
{
  const good = { schemaVersion: 1, cards: [checklist([false])], settings: SETTINGS };
  check('validateBoard accepts a v1 export', validateBoard(good) !== null);
  check('validateBoard refuses a non-board object', validateBoard({ hello: 1 }) === null);
  check('validateBoard refuses an unknown schemaVersion', validateBoard({ ...good, schemaVersion: 99 }) === null);
  check('validateBoard refuses cards without ids', validateBoard({ ...good, cards: [{ title: 'x' }] }) === null);
}
{
  const mine = checklist([false]);
  mine.updatedAt = '2026-01-05T00:00:00.000Z';
  const theirsOlder = { ...mine, title: 'older', updatedAt: '2026-01-01T00:00:00.000Z' };
  const newcomer = checklist([true]);
  const merged = mergeBoards(
    { schemaVersion: 1, cards: [mine], settings: SETTINGS },
    { schemaVersion: 1, cards: [theirsOlder, newcomer], settings: SETTINGS },
  );
  check('mergeBoards adds unknown ids', merged.cards.length === 2);
  check('mergeBoards keeps the newer updatedAt for known ids', merged.cards.find((c) => c.id === mine.id)?.title === 'task');
  const theirsNewer = { ...mine, title: 'newer', updatedAt: '2026-02-01T00:00:00.000Z' };
  const m2 = mergeBoards({ schemaVersion: 1, cards: [mine], settings: SETTINGS }, { schemaVersion: 1, cards: [theirsNewer], settings: SETTINGS });
  check('mergeBoards takes the incoming card when it is newer', m2.cards[0].title === 'newer');
}

// --- labels + links -------------------------------------------------------------
{
  const c = newCard({ title: 'l', order: 0, uid, nowIso: NOW, labels: ['a', 'b'] });
  check('newCard takes labels; default is []', c.labels.join() === 'a,b' && plain().labels.length === 0);
  const u = updateCard(c, { labels: ['b', 'a', 'b'] }, NOW);
  check('updateCard sets labels, deduped, order kept', u.labels.join() === 'b,a');
  const withLinks = updateCard(c, { links: [{ title: 'Doc', url: 'https://x.test' }], ext: { key: 'k' } }, NOW);
  check('updateCard sets links and ext', withLinks.links?.[0].url === 'https://x.test' && withLinks.ext?.key === 'k');
  const legacy = { ...plain() } as Partial<Card>;
  delete legacy.labels;
  check('updateCard gives an old card without labels an empty array', Array.isArray(updateCard(legacy as Card, { title: 'x' }, NOW).labels));
  const changed = removeLabelFromCards([c, plain(), newCard({ title: 'm', order: 1, uid, nowIso: NOW, labels: ['a'] })], 'a', NOW);
  check('removeLabelFromCards returns only the changed cards, stripped', changed.length === 2 && changed.every((x) => !x.labels.includes('a')) && changed[0].labels.join() === 'b');
  const board: Board = { schemaVersion: 1, cards: [c], labels: [], settings: SETTINGS };
  const dup = duplicateCard(board, c.id, 1, uid, 'todo', NOW)!;
  check('duplicate keeps labels', dup.labels.join() === 'a,b');
  const rep = repeatCopy({ ...withLinks, repeat: true }, 0, uid, NOW);
  check('Repeat copy keeps labels and links, not the external ref', rep.labels.join() === 'a,b' && rep.links?.length === 1 && rep.ext === undefined);
  const v = validateBoard({ schemaVersion: 1, cards: [{ ...legacy, labels: undefined }], settings: SETTINGS });
  check('validateBoard normalises cards without labels and seeds the built-in label', !!v && Array.isArray(v.cards[0].labels) && v.labels.some((l) => l.id === 'sherlock'));
  const v2 = validateBoard({ schemaVersion: 1, cards: [], labels: [{ id: 'w', name: 'Work', color: '#123456' }, { id: 'bad', name: 'x', color: 'red' }], settings: SETTINGS });
  check('validateBoard keeps valid labels and drops malformed ones', !!v2 && v2.labels.some((l) => l.id === 'w') && !v2.labels.some((l) => l.id === 'bad'));
  const m = mergeBoards({ schemaVersion: 1, cards: [], labels: [{ id: 'w', name: 'Mine', color: '#111111' }], settings: SETTINGS }, { schemaVersion: 1, cards: [], labels: [{ id: 'w', name: 'Theirs', color: '#222222' }, { id: 'h', name: 'Home', color: '#333333' }], settings: SETTINGS });
  check('mergeBoards adds unknown labels and keeps mine', m.labels.length === 2 && m.labels.find((l) => l.id === 'w')?.name === 'Mine');
}

// --- label pill colors keep text contrast >= 4.5 in both themes -------------------------
{
  const { pillColors, contrastRatio, LABEL_PALETTE } = await import('../src/lib/labels');
  check('contrastRatio black/white is 21', Math.round(contrastRatio('#000000', '#FFFFFF')) === 21);
  const worst: string[] = [];
  for (const hex of [...LABEL_PALETTE, '#000000', '#FFFFFF', '#FFFF00', '#00FF00', '#808080', '#0000FF', '#171B21']) {
    const p = pillColors(hex);
    for (const t of ['light', 'dark'] as const) {
      const r = contrastRatio(p[t].fg, p[t].bg);
      if (r < 4.5) worst.push(`${hex} ${t} ${r.toFixed(2)}`);
    }
  }
  check('every pill (presets + extreme customs) has text contrast >= 4.5 in light and dark', worst.length === 0, worst.join('; '));
  const p = pillColors('#7C5CFF');
  check('pill colors are #RRGGBB and the tint keeps the hue (not grey)', /^#[0-9A-F]{6}$/.test(p.light.bg) && /^#[0-9A-F]{6}$/.test(p.dark.fg) && p.light.bg !== '#FFFFFF');
}

// --- accent buttons: text on the accent fill reads at >= 4.5 in both themes ---------------
{
  const { contrastRatio } = await import('../src/lib/labels');
  const { studioThemes } = await import('../shared/appearance.mjs');
  const { tone } = await import('../src/lib/appearance');
  for (const theme of studioThemes) {
    const neutral = tone(theme.canvas) === 'dark' ? 255 : 0;
    const channels = [1, 3, 5].map(i => parseInt(theme.canvas.slice(i, i + 2), 16));
    const fill = '#' + channels.map(c => Math.round(neutral * .92 + c * .08).toString(16).padStart(2, '0')).join('');
    check(`primary button text contrast >= 4.5 (${theme.name})`, contrastRatio(theme.canvas, fill) >= 4.5);
  }
  const chrome = (await import('node:fs')).readFileSync('src/styles/chrome.css', 'utf8');
  const remindCss = (await import('node:fs')).readFileSync('src/styles/remind.css', 'utf8');
  check('soon reminders use the same readable color as other card footers', /\.card-remind\s*\{[^}]*color:\s*var\(--muted\)/.test(remindCss) && !/\.card-remind\.soon\s*\{/.test(remindCss));
  check('.btn-accent uses the fill + on-accent tokens', /\.btn-accent\s*\{[^}]*var\(--accent-fill\)[^}]*var\(--on-accent\)/.test(chrome));
}

// --- phone swipe gesture (pure) ---------------------------------------------------------
{
  const { swipeStart, swipeMove, swipeEnd, restOffset, SWIPE } = await import('../src/lib/swipe');
  const cfg = { width: 300, left: true, right: true };
  const at = (xs: [number, number, number][], base = 0) => xs.reduce((s, [x, y, t]) => swipeMove(s, x, y, t, cfg), swipeStart(base, 100, 100, 0));
  check('under 10 px nothing is decided', at([[106, 104, 16]]).phase === 'pending');
  check('mostly vertical after 10 px → scroll, the card does not move', at([[103, 115, 16]]).phase === 'scroll' && at([[103, 115, 16]]).offset === 0);
  check('once a scroll, always a scroll', at([[103, 115, 16], [160, 118, 32]]).phase === 'scroll');
  const sw = at([[112, 103, 16], [140, 104, 32]]);
  check('mostly horizontal → swipe; the card follows the finger 1:1', sw.phase === 'swiping' && sw.offset === 40);
  check('a disallowed direction does not move', at([[60, 101, 16]].map(([x, y, t]) => [x, y, t] as [number, number, number])).offset === -40 &&
    [[60, 101, 16]].reduce((s, [x, y, t]) => swipeMove(s, x, y, t, { ...cfg, left: false }), swipeStart(0, 100, 100, 0)).offset === 0);
  const commitAt = 300 * SWIPE.commitRatio; // 120
  const armed = at([[90, 100, 16], [100 - commitAt - 1, 100, 400]]);
  check('crossing 40 % of the width arms the action', armed.armed === 'left' && at([[90, 100, 16], [100 - commitAt + 5, 100, 400]]).armed === null);
  const far = at([[90, 100, 16], [100 - 200, 100, 800]]);
  check('beyond the commit threshold the card rubber-bands (moves less than the finger)', far.offset > -200 && far.offset < -commitAt);
  const pastAt = (px: number) => -at([[90, 100, 16], [100 - px, 100, 800]]).offset;
  const d1 = pastAt(commitAt + 40) - pastAt(commitAt), d2 = pastAt(commitAt + 80) - pastAt(commitAt + 40), d3 = pastAt(commitAt + 160) - pastAt(commitAt + 120);
  check('rubber band gets progressively stiffer (each 40 px of finger moves the card less)', d1 > d2 && d2 > d3 && d3 > 0, `${d1.toFixed(1)} > ${d2.toFixed(1)} > ${d3.toFixed(1)}`);
  check('...and never passes a hard limit', pastAt(2000) < commitAt + 300 * 0.3 + 1);
  check('release past the threshold → commit', swipeEnd(armed).kind === 'commit' && (swipeEnd(armed) as any).dir === 'left');
  const mid = at([[90, 100, 16], [100 - 90, 100, 600]]);
  check('release between 72 px and the threshold → open, resting at -88 px', swipeEnd(mid).kind === 'open' && restOffset(swipeEnd(mid), 300) === -88);
  const small = at([[90, 100, 16], [100 - 50, 100, 600]]);
  check('release under 72 px → close', swipeEnd(small).kind === 'close' && restOffset(swipeEnd(small), 300) === 0);
  const flick = at([[90, 100, 10], [100 - 50, 100, 60]]);
  check('a fast flick (> 0.5 px/ms) commits even when short', swipeEnd(flick).kind === 'commit');
  const back = at([[110, 100, 10], [150, 100, 200], [120, 100, 220]]);
  check('a flick against the reveal direction does not commit', swipeEnd(back).kind !== 'commit');
  check('swipe right commits to the right', (swipeEnd(at([[110, 100, 16], [100 + commitAt + 10, 100, 500]])) as any).dir === 'right');
  const tapOpen = swipeStart(-88, 100, 100, 0);
  check('a tap on an open row closes it', swipeEnd(tapOpen).kind === 'close');
  check('a tap on a closed row does nothing', swipeEnd(swipeStart(0, 100, 100, 0)).kind === 'none');
  const fromOpen = at([[92, 100, 16], [100 - 40, 100, 500]], -88);
  check('from open, a further swipe past the threshold arms and commits', fromOpen.armed === 'left' && swipeEnd(fromOpen).kind === 'commit');
  const shut = at([[110, 100, 16], [160, 100, 500]], -88);
  check('from open, swiping back closes', swipeEnd(shut).kind === 'close');
  check('a commit rests the card off-screen', restOffset({ kind: 'commit', dir: 'left' }, 300) === -300 && restOffset({ kind: 'commit', dir: 'right' }, 300) === 300);
}

// --- swipe right: the status action per column (§6 rules) ------------------------------
{
  const { swipeRightAction } = await import('../src/lib/reducer');
  const mk = (status: 'todo' | 'doing' | 'done', done: boolean[] = []) => ({ ...newCard({ title: 's', order: 0, uid, nowIso: NOW, items: done.map((d, i) => ({ id: 'q' + i, text: 'q', done: d })) }), status });
  check('To do → Start (Doing)', JSON.stringify(swipeRightAction(mk('todo'))) === JSON.stringify({ to: 'doing', label: 'Start' }));
  check('Doing → Done', JSON.stringify(swipeRightAction(mk('doing', [true, false]))) === JSON.stringify({ to: 'done', label: 'Done' }));
  check('Done → Reopen (To do)', JSON.stringify(swipeRightAction(mk('done', [true]))) === JSON.stringify({ to: 'todo', label: 'Reopen' }));
  check('a complete list cannot start: Start becomes Done', JSON.stringify(swipeRightAction(mk('todo', [true, true]))) === JSON.stringify({ to: 'done', label: 'Done' }));
  const moved = moveCard(mk('done', [true, true]), 'todo', 0, NOW);
  check('Reopen on a checklist unchecks all (same rule as the status control)', moved.status === 'todo' && moved.items.every((i) => !i.done));
  const fin = moveCard(mk('doing', [true, false]), 'done', 0, NOW);
  check('Done on a checklist checks all', fin.status === 'done' && fin.items.every((i) => i.done));
}

// --- reminders: quick chips, display formats, remindAt clears remindedAt -------------------
{
  const { reminderChips, formatRemindFace, formatRemindRow, remindState } = await import('../src/lib/remind');
  const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);
  const keys = (now: Date) => reminderChips(now).map((c) => c.key).join();
  const chip = (now: Date, key: string) => reminderChips(now).find((c) => c.key === key)!.at;
  const wed = at(2026, 9, 23, 14, 20); // a Wednesday
  check('all chips at 14:20', keys(wed) === 'later,evening,tomorrow,monday');
  check('Later today = +3 h rounded to the hour (17:20 → 17:00)', chip(wed, 'later').getTime() === at(2026, 9, 23, 17).getTime());
  check('Later today rounds up from :30 (14:40 → 18:00)', chip(at(2026, 9, 23, 14, 40), 'later').getTime() === at(2026, 9, 23, 18).getTime());
  check('This evening = 18:00 today', chip(wed, 'evening').getTime() === at(2026, 9, 23, 18).getTime());
  check('Tomorrow 9:00', chip(wed, 'tomorrow').getTime() === at(2026, 9, 24, 9).getTime());
  check('Next Monday 9:00 from a Wednesday', chip(wed, 'monday').getTime() === at(2026, 9, 28, 9).getTime());
  check('Next Monday from a Monday is a week later', chip(at(2026, 9, 28, 8), 'monday').getTime() === at(2026, 10, 5, 9).getTime());
  check('Next Monday from a Sunday is the next day', chip(at(2026, 9, 27, 20), 'monday').getTime() === at(2026, 9, 28, 9).getTime());
  check('month wrap: Tomorrow from Sep 30 is Oct 1', chip(at(2026, 9, 30, 10), 'tomorrow').getTime() === at(2026, 10, 1, 9).getTime());
  check('"This evening" hidden from 17:00', !keys(at(2026, 9, 23, 17, 0)).includes('evening') && keys(at(2026, 9, 23, 16, 59)).includes('evening'));
  check('"Later today" hidden from 21:00', !keys(at(2026, 9, 23, 21, 0)).includes('later') && keys(at(2026, 9, 23, 20, 59)).includes('later'));
  check('face: same day → "9:00"', formatRemindFace(at(2026, 9, 23, 19), wed) === '19:00');
  check('face: within the week → "Thu 9:00"', formatRemindFace(at(2026, 9, 24, 9), wed) === 'Thu 9:00');
  check('face: further out → "24 Oct"', formatRemindFace(at(2026, 10, 24, 9), wed) === '24 Oct');
  check('face: another year → "3 Jan 2027"', formatRemindFace(at(2027, 1, 3, 9), wed) === '3 Jan 2027');
  check('row: "Today, 19:00"', formatRemindRow(at(2026, 9, 23, 19), wed) === 'Today, 19:00');
  check('row: "Tomorrow, 9:00"', formatRemindRow(at(2026, 9, 24, 9), wed) === 'Tomorrow, 9:00');
  check('row: "Mon 28 Sep, 9:00"', formatRemindRow(at(2026, 9, 28, 9), wed) === 'Mon 28 Sep, 9:00');
  const iso = (d: Date) => d.toISOString();
  check('state: pending and soon within 24 h', JSON.stringify(remindState({ remindAt: iso(at(2026, 9, 24, 9)), remindedAt: null }, wed)) === JSON.stringify({ kind: 'pending', soon: true }));
  check('state: pending, not soon beyond 24 h', remindState({ remindAt: iso(at(2026, 9, 26, 9)), remindedAt: null }, wed).kind === 'pending' && !remindState({ remindAt: iso(at(2026, 9, 26, 9)), remindedAt: null }, wed).soon);
  check('state: sent', remindState({ remindAt: iso(at(2026, 9, 22, 9)), remindedAt: iso(at(2026, 9, 22, 9, 1)) }, wed).kind === 'sent');
  check('state: none', remindState({ remindAt: null, remindedAt: null }, wed).kind === 'none');
  check('state: a re-armed reminder (remindedAt before remindAt) is pending', remindState({ remindAt: iso(at(2026, 9, 25, 9)), remindedAt: iso(at(2026, 9, 22, 9)) }, wed).kind === 'pending');
  const c = updateCard({ ...plain(), remindAt: iso(at(2026, 9, 22, 9)), remindedAt: iso(at(2026, 9, 22, 9)) }, { remindAt: iso(at(2026, 9, 25, 9)) }, NOW);
  check('setting remindAt clears remindedAt', c.remindAt === iso(at(2026, 9, 25, 9)) && c.remindedAt === null);
  const cleared = updateCard(c, { remindAt: null }, NOW);
  check('clearing remindAt works', cleared.remindAt === null && cleared.remindedAt === null);
  check('a new card has no reminder', plain().remindAt === null && plain().remindedAt === null);
}

// --- card face: the first link as a chip, "+N" for the rest -------------------------------
{
  const { faceLink } = await import('../src/lib/labels');
  const base = plain();
  check('no links → nothing', faceLink(base) === null);
  const one = faceLink({ ...base, links: [{ title: 'Sherlock on Slack', url: 'https://slack.test/x' }] });
  check('one link → its title, no more', one?.text === 'Sherlock on Slack' && one.url === 'https://slack.test/x' && one.more === 0);
  const three = faceLink({ ...base, links: [{ title: '', url: 'https://www.wiki.test/p' }, { title: 'b', url: 'https://b.test' }, { title: 'c', url: 'https://c.test' }] });
  check('an untitled first link shows its host; +2 for the rest', three?.text === 'wiki.test' && three.more === 2);
}

// --- stale app after a deploy: when to reload on a service-worker takeover ---------------
{
  const { reloadDecision } = await import('../src/lib/sw-reload');
  const ok = { hadController: true, lastReloadAgoMs: null, fieldFocused: false, unsentInput: false, hidden: true, busy: false, sinceLoadMs: 60000 };
  check('first install (no previous controller) → ignore', reloadDecision({ ...ok, hadController: false }) === 'ignore');
  check('a new worker took over while the app is in the background → reload', reloadDecision(ok) === 'reload');
  check('reloaded moments ago (loop guard) → ignore', reloadDecision({ ...ok, lastReloadAgoMs: 5000 }) === 'ignore');
  check('an old guard does not block a later deploy', reloadDecision({ ...ok, lastReloadAgoMs: 10 * 60000 }) === 'reload');
  check('in front of the user, never: visible → wait (the open card, popovers and scroll stay)', reloadDecision({ ...ok, hidden: false }) === 'wait');
  check('...even with nothing open', reloadDecision({ ...ok, hidden: false, busy: false }) === 'wait');
  check('right after launch, nothing open yet → reload (the user has not started)', reloadDecision({ ...ok, hidden: false, sinceLoadMs: 1500 }) === 'reload');
  check('right after launch but a card is already open → wait', reloadDecision({ ...ok, hidden: false, sinceLoadMs: 1500, busy: true }) === 'wait');
  check('unsent input → wait, even hidden', reloadDecision({ ...ok, unsentInput: true }) === 'wait');
  check('locking the phone with a card open defers an app update', reloadDecision({ ...ok, busy: true }) === 'wait');
  check('hidden with a focused field but nothing unsent → reload', reloadDecision({ ...ok, fieldFocused: true }) === 'reload');
}

// --- springs: a damped oscillator sampled into linear() / keyframes ---------------------------
{
  const { springCurve, springEasing, springKeyframes, springState, springComputeCount, SPRINGS, springToken, progressVelocity } = await import('../src/lib/spring');
  const crit = { mass: 1, stiffness: 100, damping: 20 };
  check('critically damped: no overshoot', springCurve(crit).overshoot === 0);
  const zeta = 0.5;
  const under = { mass: 1, stiffness: 100, damping: 2 * zeta * 10 };
  const expected = Math.exp((-zeta * Math.PI) / Math.sqrt(1 - zeta * zeta)); // 16.3 %
  check('underdamped: overshoot matches exp(-ζπ/√(1-ζ²))', Math.abs(springCurve(under).overshoot - expected) < 0.005, `${springCurve(under).overshoot} vs ${expected}`);
  const settledFrom = (spec: any, ms: number) => { for (let t = ms; t < ms + 600; t += 5) { const st = springState(spec, t); if (Math.abs(st.x - 1) >= 0.001 || Math.abs(st.v) >= 0.01) return false; } return true; };
  for (const spec of [crit, under, SPRINGS.heavy]) {
    const c = springCurve(spec);
    const before = springState(spec, c.ms - 2);
    check(`duration = settling (${c.ms} ms): at rest from there on, not 2 ms earlier`, settledFrom(spec, c.ms) && (Math.abs(before.x - 1) >= 0.001 || Math.abs(before.v) >= 0.01));
  }
  const vals = (e: string) => e.slice(7, -1).split(',').map(Number);
  const mono = (a: number[]) => a.every((v, i) => i === 0 || v >= a[i - 1] - 1e-9);
  const ce = springEasing(crit).easing;
  check('linear() string runs 0 … 1', /^linear\(0, .*, 1\)$/.test(ce));
  check('critically damped and overdamped easings are monotone', mono(vals(ce)) && mono(vals(springEasing({ mass: 1, stiffness: 100, damping: 40 }).easing)));
  check('an underdamped easing is not monotone (it overshoots)', !mono(vals(springEasing(under).easing)) && Math.max(...vals(springEasing(under).easing)) > 1);
  const n0 = springComputeCount();
  const a = springCurve({ ...crit }); const b = springCurve({ ...crit });
  check('curves are cached', a === b && springComputeCount() === n0);
  const kf = springKeyframes(SPRINGS.heavy, (p) => ({ transform: `translateX(${p * 100}px)` }));
  check('keyframes: offsets 0 → 1 and the last frame at the target', kf.keyframes[0].offset === 0 && kf.keyframes[kf.keyframes.length - 1].offset === 1 && kf.keyframes[kf.keyframes.length - 1].transform === 'translateX(100px)');
  const sn = springCurve(SPRINGS.snappy), ge = springCurve(SPRINGS.gentle), he = springCurve(SPRINGS.heavy), re = springCurve(SPRINGS.release);
  check(`snappy: no visible overshoot, ~150 ms (${sn.ms} ms, ${(sn.overshoot * 100).toFixed(2)} %)`, sn.overshoot < 0.001 && sn.ms >= 125 && sn.ms <= 180);
  check(`gentle: overshoot ≤ 2 %, ~230 ms (${ge.ms} ms, ${(ge.overshoot * 100).toFixed(2)} %)`, ge.overshoot > 0 && ge.overshoot <= 0.02 && ge.ms >= 200 && ge.ms <= 260);
  check(`heavy: mass > 1, ~3 % overshoot, under 300 ms (${he.ms} ms, ${(he.overshoot * 100).toFixed(2)} %)`, SPRINGS.heavy.mass > 1 && he.overshoot >= 0.02 && he.overshoot <= 0.04 && he.ms >= 240 && he.ms < 300);
  const t50 = (v: number) => springCurve({ ...SPRINGS.release, velocity: v }).points.findIndex((p) => p >= 0.5);
  check('release: a fast flick carries momentum (reaches halfway sooner than a slow release)', t50(15) < t50(2) && t50(2) <= t50(0) && re.overshoot < 0.005);
  const { capOvershoot } = await import('../src/lib/spring');
  const over = (dist: number, v: number) => springCurve({ ...SPRINGS.release, velocity: capOvershoot(SPRINGS.release, v, dist, 3) }).overshoot * dist;
  check('capOvershoot keeps momentum overshoot within 3 px (20 px and 300 px distances)', over(20, 60) <= 3 && over(300, 60) <= 3 && over(20, 60) > 0);
  check('...and leaves a gentle release untouched', capOvershoot(SPRINGS.release, 2, 60, 3) === 2);
    check('progressVelocity: 1.2 px/ms over 120 px = 10 /s', progressVelocity(1.2, 120) === 10 && progressVelocity(1, 0) === 0);
  const css = (await import('node:fs')).readFileSync('src/index.css', 'utf8');
  for (const name of ['snappy', 'gentle', 'heavy', 'release'] as const) {
    const t = springToken(name);
    const compact = css.replace(/\s/g, '');
    check(`index.css --spring-${name} matches the spring (${t.ms} ms)`, compact.includes(`--spring-${name}:${t.easing};`.replace(/\s/g, '')) && compact.includes(`--spring-${name}-ms:${t.ms}ms;`));
  }
  check('a cubic-bezier fallback exists for browsers without linear()', /@supports not \(transition-timing-function: linear\(0, 1\)\)/.test(css));
}

// --- Someday: display order, paused reminders, the missed rule --------------------------------
{
  const { remindState } = await import('../src/lib/remind');
  const mk = (id: string, order: number, someday: boolean): Card => ({ ...plain(), id, order, someday });
  const col = columnCards([mk('s1', -5, true), mk('a1', 3, false), mk('s2', 0, true), mk('a2', 1, false)], 'todo').map((c) => c.id).join();
  check('To do lists the active cards first, then Someday, each by order', col === 'a2,a1,s1,s2', col);

  const HOUR = 3600000;
  const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
  const parked = (remindAt: string, remindedAt: string | null = null): Card => ({ ...plain(), someday: true, remindAt, remindedAt });
  const past = updateCard(parked(at(-HOUR)), { someday: false }, NOW);
  check('leaving Someday after the time passed marks the reminder missed (remindedAt = remindAt)', past.remindedAt === past.remindAt && !past.someday, JSON.stringify(past));
  check('...which reads as missed, not sent', remindState(past, new Date(NOW)).kind === 'missed');
  const future = updateCard(parked(at(HOUR)), { someday: false }, NOW);
  check('leaving Someday before the time keeps it pending (armed again)', future.remindedAt === null && remindState(future, new Date(NOW)).kind === 'pending');
  const sent = parked(at(-2 * HOUR), at(-2 * HOUR + 1000));
  check('a reminder already sent before parking stays sent', updateCard(sent, { someday: false }, NOW).remindedAt === sent.remindedAt);
  check('moving a parked card to Doing also applies the missed rule', moveCard(parked(at(-HOUR)), 'doing', 0, NOW).remindedAt === at(-HOUR));
  check('staying in Someday leaves remindedAt alone', updateCard(parked(at(-HOUR)), { title: 'x' }, NOW).remindedAt === null);
  check('a pending reminder on a Someday card is paused (future)', remindState(parked(at(HOUR)), new Date(NOW)).kind === 'paused');
  check('...and while its time passes (never missed while parked)', remindState(parked(at(-HOUR)), new Date(NOW)).kind === 'paused');
  check('a sent reminder on a Someday card still reads sent', remindState(sent, new Date(NOW)).kind === 'sent');
  check('setting a new time while parked is allowed and paused', remindState(updateCard(parked(at(-HOUR)), { remindAt: at(2 * HOUR) }, NOW), new Date(NOW)).kind === 'paused');

  // Repeating reminders (remindEvery): the anchor (remindAt) stays; the time due is the first slot after
  // the last push (dueAt). They rest in Someday and Done and wait for the next slot, never late.
  const { nextRemind, dueAt } = await import('../shared/repeat.mjs');
  const nowMs = Date.parse(NOW);
  const DAY = 24 * HOUR;
  const dueOf = (c: Card) => dueAt(c);
  const rep = (over: Partial<Card> = {}): Card => ({ ...plain(), remindAt: at(-HOUR), remindedAt: null, remindEvery: 'day', ...over });
  const set = updateCard({ ...plain(), remindAt: at(HOUR) }, { remindEvery: 'week' }, NOW);
  check('remindEvery is set on a card with a reminder, time untouched', set.remindEvery === 'week' && set.remindAt === at(HOUR));
  check('clearing the reminder clears the repeat', updateCard(set, { remindAt: null }, NOW).remindEvery === null);
  const orphan = updateCard({ ...plain(), remindAt: null, remindEvery: 'day' }, { remindAt: at(HOUR) }, NOW);
  check('a new reminder starts as once even if a repeat was left behind', orphan.remindAt === at(HOUR) && !orphan.remindEvery);
  check('...while a new time on a repeating reminder keeps the repeat', updateCard(set, { remindAt: at(2 * HOUR) }, NOW).remindEvery === 'week');
  check('no time, nothing to repeat', !updateCard(plain(), { remindEvery: 'day' }, NOW).remindEvery);
  const once = updateCard(rep({ remindAt: at(-3 * DAY), remindedAt: at(-DAY + 1000) }), { remindEvery: null }, NOW);
  check('back to once: the upcoming slot stays as a single pending reminder', once.remindEvery === null && once.remindAt === at(DAY) && once.remindedAt === null && remindState(once, new Date(NOW)).kind === 'pending', JSON.stringify(once));
  const sentOnce: Card = { ...plain(), remindAt: at(-HOUR), remindedAt: at(-HOUR + 1000) };
  const nowRep = updateCard(sentOnce, { remindEvery: 'day' }, NOW);
  check('repeat on a one-off already sent: the anchor stays and the next slot is due (never stuck as sent)', nowRep.remindAt === at(-HOUR) && dueOf(nowRep) === at(DAY - HOUR) && remindState(nowRep, new Date(NOW)).kind === 'pending', JSON.stringify(nowRep));
  const afterPush = rep({ remindAt: at(-HOUR), remindedAt: at(-HOUR + 1500) });
  check('after a push it is pending at the next slot', remindState(afterPush, new Date(NOW)).kind === 'pending' && dueOf(afterPush) === at(DAY - HOUR));
  check('"soon" follows the time due, not the anchor', JSON.stringify(remindState(rep({ remindAt: at(-10 * DAY), remindEvery: 'week', remindedAt: at(-3 * DAY + 1000) }), new Date(NOW))) === JSON.stringify({ kind: 'pending', soon: false }));
  const left = updateCard(rep({ someday: true }), { someday: false }, NOW);
  check('leaving Someday after the time: a repeating reminder waits for its next slot, not missed', left.remindAt === at(-HOUR) && left.remindedAt === NOW && dueOf(left) === at(DAY - HOUR) && remindState(left, new Date(NOW)).kind === 'pending', JSON.stringify(left));
  const done = moveCard(rep({ remindAt: at(HOUR) }), 'done', 0, NOW);
  check('a repeating reminder on a Done card is paused', done.status === 'done' && remindState(done, new Date(NOW)).kind === 'paused' && done.remindAt === at(HOUR));
  check('a one-off reminder on a Done card stays pending', remindState(moveCard({ ...plain(), remindAt: at(HOUR) }, 'done', 0, NOW), new Date(NOW)).kind === 'pending');
  const later = new Date(nowMs + 3 * HOUR).toISOString();
  const reopened = moveCard(done, 'todo', 0, later);
  check('reopened after the time: next slot ahead, never sent late', reopened.remindedAt === later && dueOf(reopened) === nextRemind(at(HOUR), 'day', nowMs + 3 * HOUR) && Date.parse(dueOf(reopened)!) > Date.parse(later) && remindState(reopened, new Date(later)).kind === 'pending', JSON.stringify(reopened));
  check('reopened before the time: the same slot', dueOf(moveCard(done, 'todo', 0, NOW)) === at(HOUR));
  const src = { ...checklist([true, true]), repeat: true, remindAt: at(-HOUR), remindedAt: at(-HOUR + 1500), remindEvery: 'day' as const };
  const cp = repeatCopy(src, 3, uid, NOW);
  check('a Repeat card finished after its reminder: the copy keeps the anchor and reminds at the next slot', cp.remindEvery === 'day' && cp.remindAt === src.remindAt && dueOf(cp) === at(DAY - HOUR), JSON.stringify([cp.remindAt, cp.remindedAt, dueOf(cp)]));
  const cpEarly = repeatCopy({ ...src, remindAt: at(HOUR - DAY), remindedAt: at(HOUR - DAY + 1500) }, 3, uid, NOW);
  check('...finished an hour ahead of its reminder: that one is skipped', dueOf(cpEarly) === at(DAY + HOUR), String(dueOf(cpEarly)));
  const cpAhead = repeatCopy({ ...src, remindAt: at(18 * HOUR), remindedAt: null }, 3, uid, NOW);
  check('...finished well ahead (18 h): the copy still reminds then', dueOf(cpAhead) === at(18 * HOUR), String(dueOf(cpAhead)));
  const cpLate = repeatCopy({ ...src, createdAt: at(-2 * DAY), remindAt: at(HOUR - 3 * DAY), remindedAt: at(HOUR - DAY + 1500) }, 3, uid, NOW);
  check('...finished late, after its reminder fired (the next one an hour away): the next one still reminds', dueOf(cpLate) === at(HOUR), String(dueOf(cpLate)));
  // Adding an item to a Done repeating card past its time brings it back without a late push.
  const doneRep: Card = { ...checklist([true]), status: 'done', completedAt: at(-2 * HOUR), remindAt: at(-HOUR), remindedAt: null, remindEvery: 'day' };
  addItemsToCard(doneRep, 'one more', uid, NOW);
  check('adding an item to a Done repeating card past its time: back in Doing, waiting for the next slot', doneRep.status === 'doing' && doneRep.remindedAt === NOW && dueOf(doneRep) === at(DAY - HOUR), JSON.stringify([doneRep.status, doneRep.remindedAt]));
  const doneOnce: Card = { ...checklist([true]), status: 'done', completedAt: at(-2 * HOUR), remindAt: at(HOUR), remindedAt: null, remindEvery: 'day' };
  addItemsToCard(doneOnce, 'one more', uid, NOW);
  check('...before its time: the same slot, nothing stamped', doneOnce.remindedAt === null && dueOf(doneOnce) === at(HOUR));
  check('a Repeat card without a repeating reminder copies none', !repeatCopy({ ...src, remindEvery: null }, 3, uid, NOW).remindAt);
}

// --- links in text: bare URLs and [words](url) (pure) ------------------------------------------
{
  const { linkTokens, wrapLink, isSafeHref } = await import('../src/lib/links');
  const show = (t: string) => linkTokens(t).map((x) => (x.type === 'link' ? `<${x.text}|${x.href}>` : x.text)).join('');
  check('markdown link shows only its words', show('Book [hotel](https://h.test/a) today') === 'Book <hotel|https://h.test/a> today', show('Book [hotel](https://h.test/a) today'));
  check('bare URLs link', show('see https://x.test/p?q=1 now') === 'see <https://x.test/p?q=1|https://x.test/p?q=1> now');
  check('trailing punctuation stays outside a bare URL', show('Go to https://x.test/a. Then https://y.test/b, done!') === 'Go to <https://x.test/a|https://x.test/a>. Then <https://y.test/b|https://y.test/b>, done!', show('Go to https://x.test/a. Then https://y.test/b, done!'));
  check('parentheses inside a URL are kept when balanced', show('(see https://en.wiki.test/Foo_(bar))') === '(see <https://en.wiki.test/Foo_(bar)|https://en.wiki.test/Foo_(bar)>)', show('(see https://en.wiki.test/Foo_(bar))'));
  check('a markdown URL with parentheses', show('[Foo](https://en.wiki.test/Foo_(bar))') === '<Foo|https://en.wiki.test/Foo_(bar)>', show('[Foo](https://en.wiki.test/Foo_(bar))'));
  check('nested brackets in the words', show('[a [b] c](https://x.test)') === '<a [b] c|https://x.test>', show('[a [b] c](https://x.test)'));
  check('mailto works', show('[mail me](mailto:a@b.test)') === '<mail me|mailto:a@b.test>');
  check('javascript: and other schemes stay plain text', show('[x](javascript:alert(1))') === '[x](javascript:alert(1))' && show('[x](data:text/html,1)') === '[x](data:text/html,1)' && !isSafeHref('javascript:alert(1)') && !isSafeHref(' JAVASCRIPT:x'));
  check('unfinished markdown stays text', show('[a](https://x.test') === '[a](<https://x.test|https://x.test>' && show('[just brackets]') === '[just brackets]', show('[a](https://x.test'));
  check('a URL glued to a word is not a link', show('xhttps://x.test') === 'xhttps://x.test');
  const w = wrapLink('Book hotel now', 5, 10, 'https://h.test');
  check('wrapLink wraps the selection as [selected](url) and puts the caret after it', w!.value === 'Book [hotel](https://h.test) now' && w!.caret === 'Book [hotel](https://h.test)'.length, JSON.stringify(w));
  check('wrapLink with no selection inserts the bare URL', wrapLink('ab', 1, 1, 'https://h.test')!.value === 'ahttps://h.testb');
  check('wrapLink refuses a non-link', wrapLink('ab', 0, 1, 'hello') === null && wrapLink('ab', 0, 1, 'javascript:x') === null);
}

// --- checklist reorder (pure): ticked items keep their place, so moves ignore done ------------------
{
  const { moveItemTo, nudgeItemIn } = await import('../src/lib/reducer');
  const it = (id: string, done = false) => ({ id, text: id, done });
  const list = [it('a'), it('x', true), it('b'), it('c'), it('y', true), it('z', true)];
  const ids = (l: { id: string }[]) => l.map((i) => i.id).join('');
  check('move before another row', ids(moveItemTo(list, 'c', 'a')) === 'caxbyz', ids(moveItemTo(list, 'c', 'a')));
  check('move to the end (null)', ids(moveItemTo(list, 'a', null)) === 'xbcyza');
  check('an unticked row can land among ticked ones; done never changes', ids(moveItemTo(list, 'a', 'z')) === 'xbcyaz' && moveItemTo(list, 'y', 'b').find((i) => i.id === 'y')!.done === true);
  check('nudge down passes a ticked row', ids(nudgeItemIn(list, 'a', 1)) === 'xabcyz', ids(nudgeItemIn(list, 'a', 1)));
  check('nudge stops at the ends', ids(nudgeItemIn(list, 'a', -1)) === ids(list) && ids(nudgeItemIn(list, 'z', 1)) === ids(list));
  check('toggling an item keeps its place', ids(toggleItem({ ...plain(), items: list } as Card, 'b', true, NOW).items) === ids(list));
  const long = 'Book [the hotel near the station](https://booking.test/' + 'x'.repeat(300) + ')';
  const c = updateCard(plain(), { items: [{ id: 'l', text: long, done: false }] }, NOW);
  check('item text keeps a long markdown link intact (1000 chars)', c.items[0].text === long);
}

// --- attachment display helpers (pure) ------------------------------------------------------
{
  const { formatSize, fileKind, fileBadge, isImage } = await import('../src/lib/files');
  check('sizes read as B / KB / MB', formatSize(812) === '812 B' && formatSize(14 * 1024) === '14 KB' && formatSize(3.4 * 1024 * 1024) === '3.4 MB' && formatSize(25 * 1024 * 1024) === '25 MB');
  check('kinds by type or extension', fileKind({ type: 'application/pdf', name: 'a' }) === 'pdf' && fileKind({ type: 'application/octet-stream', name: 'x.zip' }) === 'archive' && fileKind({ type: 'image/png', name: 'a.png' }) === 'image' && fileKind({ type: 'text/plain', name: 'n.txt' }) === 'text');
  check('badge: the extension, else the kind', fileBadge({ type: 'application/pdf', name: 'Report.final.pdf' }) === 'PDF' && fileBadge({ type: 'text/plain', name: 'README' }) === 'TEXT');
  check('images the browser shows; not TIFF or PSD', isImage({ type: 'image/jpeg' }) && isImage({ type: 'image/webp' }) && !isImage({ type: 'image/tiff' }) && !isImage({ type: 'image/vnd.adobe.photoshop' }));
}

// --- input-aware interactions (pure) -------------------------------------------------------
{
  const { dragMode, swipeAllowed, edgeScroll, hoverSwitch, quickStep, contextItems } = await import('../src/lib/input');
  check('touch and pen drag after a long press', dragMode('touch', 0) === 'long-press' && dragMode('pen', 0) === 'long-press');
  check('mouse drags on a movement threshold, main button only', dragMode('mouse', 0) === 'threshold' && dragMode('mouse', 2) === null);
  check('no swipe from the left 20 px (iOS back gesture)', !swipeAllowed(19) && swipeAllowed(20) && swipeAllowed(300));
  check('edge scroll: none mid-area', edgeScroll(300, 0, 600) === 0);
  check('edge scroll: up near the top, down near the bottom, faster closer', edgeScroll(10, 0, 600) < 0 && edgeScroll(590, 0, 600) > 0 && edgeScroll(2, 0, 600) < edgeScroll(30, 0, 600));
  check('edge scroll is capped', Math.abs(edgeScroll(-500, 0, 600)) <= 12 && edgeScroll(5000, 0, 600) <= 12);
  let hs = hoverSwitch(null, 'doing', 1000);
  check('hovering a tab does not switch at once', hs.fire === null);
  hs = hoverSwitch(hs.state, 'doing', 1400);
  check('...nor before 500 ms', hs.fire === null);
  hs = hoverSwitch(hs.state, 'doing', 1510);
  check('...and switches once after 500 ms', hs.fire === 'doing');
  check('...only once per visit', hoverSwitch(hs.state, 'doing', 2200).fire === null);
  let hs2 = hoverSwitch(hs.state, 'done', 2300);
  hs2 = hoverSwitch(hs2.state, null, 2500);
  check('leaving the tab resets the timer', hoverSwitch(hoverSwitch(hs2.state, 'done', 2600).state, 'done', 2900).fire === null);
  const t = plain();
  check('quick step: To do → Start (Doing)', JSON.stringify(quickStep(t)) === JSON.stringify({ to: 'doing', label: 'Start' }));
  check('quick step: Doing → Done', quickStep({ ...t, status: 'doing' })?.to === 'done');
  check('quick step: none on Done', quickStep({ ...t, status: 'done' }) === null);
  const items = contextItems(t);
  check('context menu: the ··· items in order', items.map((i) => i.key).join() === 'todo,doing,done,someday,remind,delete', items.map((i) => i.key).join());
  check('context menu: the current column is disabled', items.find((i) => i.key === 'todo')!.disabled && !items.find((i) => i.key === 'doing')!.disabled);
  check('context menu labels', items.map((i) => i.label).join('|') === 'Move to To do|Move to Doing|Move to Done|Make it a note|Remind me|Delete');
  const note = contextItems({ ...t, kind: 'note' });
  check('context menu on a note: every column places it; no "Make it a note"', note.filter((i) => ['todo', 'doing', 'done'].includes(i.key)).every((i) => !i.disabled) && !note.some((i) => i.key === 'someday'));
  check('context menu: Doing is disabled for a fully checked list', contextItems(checklist([true, true])).find((i) => i.key === 'doing')!.disabled === true);
}

// --- a row a swipe slid off-screen skips its presence exit (no snap-back frame) -------------
{
  const { markSlidOut, slidOutRecently } = await import('../src/lib/slid');
  check('an unknown row was not slid out', !slidOutRecently('nope'));
  markSlidOut('row-1');
  check('a row just slid out is recognised (its exit is skipped)', slidOutRecently('row-1'));
  const realNow = Date.now;
  Date.now = () => realNow() + 2000;
  check('...but only briefly (an undo later gets a normal exit next time)', !slidOutRecently('row-1'));
  Date.now = realNow;
}

console.log('');
console.log(failures === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
