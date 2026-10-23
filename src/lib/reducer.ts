import { isWorkflowLabel, stageOf, stagesOf, flowGroup, workflowLabels, workflowStatus } from '../../shared/workflow.mjs';
// The single write path for the board.
//
// Every mutation funnels through updateCard(id, patch): it merges the patch,
// applies §6 derivation (status + completedAt from the checklist), stamps
// updatedAt, and enforces the §3 limits. Persisting + broadcasting happen in
// the store, not here — the reducer stays pure so it can be unit-tested and
// driven by window.kanban.

import type { Board, Card, CardItem, CardStatus, Label } from './types';
import { applyStatus } from './derive';
import { TITLE_MAX, NOTES_MAX, ITEMS_MAX, ITEM_MAX, analyzeLine } from './parse';
import { normalizeCard, withBuiltins } from './labels';
import { missedOnLeave } from './remind';
import { copyStamp, onceAt, remindResting, repeats, restStamp } from '../../shared/repeat.mjs';

const now = (): string => new Date().toISOString();

function normalize(items: CardItem[]): CardItem[] {
  return items.map((i) => {
    const out: CardItem = { id: i.id, text: i.text.slice(0, ITEM_MAX), done: !!i.done };
    if (i.ref) out.ref = i.ref;
    return out;
  });
}

export function newCard(input: {
  title: string;
  notes?: string;
  items?: CardItem[];
  status?: CardStatus;
  labels?: string[];
  order: number;
  uid: () => string;
  nowIso?: string;
}): Card {
  const ts = input.nowIso ?? now();
  const card: Card = {
    id: input.uid(),
    title: input.title.trim().slice(0, TITLE_MAX),
    notes: (input.notes ?? '').slice(0, NOTES_MAX),
    status: input.status ?? 'todo',
    items: normalize(input.items ?? []).slice(0, ITEMS_MAX),
    order: input.order,
    createdAt: ts,
    updatedAt: ts,
    completedAt: null,
    archivedAt: null,
    someday: false,
    repeat: false,
    labels: [...(input.labels ?? [])],
    remindAt: null,
    remindedAt: null,
  };
  applyStatus(card, ts);
  return card;
}

/**
 * Build a card from a grammar string as the composer uses it: the first line
 * (a "# " prefix is stripped) is the title; every remaining non-empty line
 * becomes an item — a marker sets its done state, a bare line is unchecked.
 */
export function cardFromText(
  text: string,
  order: number,
  uid: () => string,
  status?: CardStatus,
  nowIso?: string,
): Card {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let title = (lines[0] ?? '').trim();
  if (title.startsWith('# ')) title = title.slice(2).trim();
  else if (title === '#') title = '';
  else if (title === '') title = 'Untitled';

  const items = itemsFromLines(lines.slice(1).join('\n'), uid);
  return newCard({ title, items, order, uid, status, nowIso });
}

/** Every non-empty line becomes an item; a marker sets its done state. */
function itemsFromLines(text: string, uid: () => string): CardItem[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const a = analyzeLine(l);
      return { id: uid(), text: (a ? a.body : l.trim()).slice(0, ITEM_MAX), done: a ? a.checked : false };
    });
}

function findCard(board: Board, id: string): Card | undefined {
  return board.cards.find((c) => c.id === id);
}

/** Append items from a grammar string to an existing card. */
export function addItemsToCard(
  card: Card,
  text: string,
  uid: () => string,
  nowIso?: string,
): number {
  const added = itemsFromLines(text, uid);
  const wasDone = card.status === 'done';
  const rested = remindResting(card);
  // New items go after the last unchecked item, in typed order: lists read in the order they were written.
  let at = 0;
  card.items.forEach((i, idx) => { if (!i.done) at = idx + 1; });
  card.items = normalize([...card.items.slice(0, at), ...added, ...card.items.slice(at)]).slice(0, ITEMS_MAX);
  const ts = nowIso ?? now();
  applyStatus(card, ts);
  // §6: an unchecked item added to a Done card returns it to Doing (a plain
  // Done card would otherwise derive to To do with nothing checked).
  if (wasDone && card.status === 'todo' && added.some((i) => !i.done)) card.status = 'doing';
  // Back out of Done with a repeating reminder past its time: never sent late (as in updateCard).
  const stamp = rested && !remindResting(card) ? restStamp(card, ts) : undefined;
  if (stamp !== undefined) card.remindedAt = stamp;
  card.updatedAt = ts;
  return added.length;
}

/**
 * The core write: merge a patch, derive status, stamp time, enforce limits.
 * Returns a new card (the reducer stays pure).
 */
export function updateCard(
  card: Card,
  patch: Partial<Pick<Card, 'title' | 'notes' | 'items' | 'status' | 'someday' | 'repeat' | 'archivedAt' | 'labels' | 'links' | 'ext' | 'remindAt' | 'remindEvery' | 'notify' | 'attachments' | 'kind' | 'titleBy' | 'done' | 'layout' | 'suggestedLabel' | 'via'>> & {
    order?: number;
  },
  nowIso?: string,
): Card {
  const ts = nowIso ?? now();
  const next: Card = { ...card, items: normalize(card.items ?? []), labels: card.labels ?? [] };

  if (patch.title !== undefined) next.title = patch.title.trim().slice(0, TITLE_MAX);
  if (patch.notes !== undefined) next.notes = patch.notes.slice(0, NOTES_MAX);
  if (patch.items !== undefined) next.items = normalize(patch.items).slice(0, ITEMS_MAX);
  if (patch.someday !== undefined) next.someday = patch.someday;
  if (patch.repeat !== undefined) next.repeat = patch.repeat;
  if (patch.notify !== undefined) next.notify = patch.notify;
  if (patch.archivedAt !== undefined) next.archivedAt = patch.archivedAt;
  // Manual status is allowed for plain cards; §6 overrides it when items change.
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.order !== undefined) next.order = patch.order;
  if (patch.labels !== undefined) next.labels = [...new Set(patch.labels)];
  if (patch.links !== undefined) {
    if (patch.links.length) next.links = patch.links.map((l) => ({ ...l }));
    else delete next.links;
  }
  // Optional fields: null / undefined-by-intent = absent, as the merge keeps them.
  for (const k of ['kind', 'titleBy', 'done', 'suggestedLabel', 'via'] as const) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === null || v === undefined || v === false) delete (next as Partial<Card>)[k];
    else (next as unknown as Record<string, unknown>)[k] = v;
  }
  if (next.kind === 'todo') delete next.kind; // absent = to do
  if (next.kind !== 'note') delete next.done; // to dos keep status
  if ('layout' in patch) {
    if (patch.layout) next.layout = { ...patch.layout };
    else delete next.layout;
  }
  if (patch.ext !== undefined) next.ext = { ...patch.ext };
  if (patch.attachments !== undefined) {
    if (patch.attachments.length) next.attachments = patch.attachments.map((a) => ({ ...a }));
    else delete next.attachments; // none = absent, as the merge keeps it
  }
  // A new or cleared reminder is not sent yet.
  if (patch.remindAt !== undefined && patch.remindAt !== (card.remindAt ?? null)) {
    next.remindAt = patch.remindAt;
    next.remindedAt = null;
    if (!card.remindAt && next.remindEvery) next.remindEvery = null; // a new reminder starts as once (a leftover repeat never revives)
  }
  if (patch.remindEvery !== undefined && patch.remindEvery !== (card.remindEvery ?? null)) {
    // Back to once: the upcoming slot stays as a single reminder.
    if (!patch.remindEvery && repeats(card) && next.remindAt && next.remindAt === card.remindAt) {
      next.remindAt = onceAt(card, Date.parse(ts));
      next.remindedAt = null;
    }
    next.remindEvery = patch.remindEvery;
  }
  if (!next.remindAt && next.remindEvery) next.remindEvery = null; // no time, nothing to repeat

  if (next.workflowVersion === 1) {
    if (patch.labels !== undefined) {
      const added = patch.labels.find((id) => id.startsWith('workflow:') && !card.labels.includes(id));
      next.labels = workflowLabels(next.labels, added ? added.slice(9) as CardStatus : workflowStatus(next));
    } else if (patch.kind === 'note') next.labels = workflowLabels(next.labels, null);
    else if (patch.status !== undefined) next.labels = workflowLabels(next.labels, patch.status);
    else if (patch.done !== undefined) next.labels = workflowLabels(next.labels, patch.done ? 'done' : null);
  }

  // §6: re-derive status + completedAt from the checklist on every write.
  applyStatus(next, ts);
  // §4.2a: leaving To do, or checking anything, un-parks a Someday card.
  if (next.someday && (next.status !== 'todo' || next.items.some((i) => i.done))) next.someday = false;
  next.updatedAt = ts;
  // Reminders rest in Someday (repeating ones also in Done); one whose time passed meanwhile is never sent late.
  if (remindResting(card) && !remindResting(next)) return missedOnLeave(next, ts);
  return next;
}

/** The next step for a card (§6: a complete list goes to Done). */
export function swipeRightAction(card: Card): { to: CardStatus; label: 'Start' | 'Done' | 'Reopen' } {
  if (card.status === 'done') return { to: 'todo', label: 'Reopen' };
  if (card.status === 'doing' || !canMoveTo(card, 'doing')) return { to: 'done', label: 'Done' };
  return { to: 'doing', label: 'Start' };
}

/** §6: a fully checked list cannot be (re)started by hand; everything else moves. */
export function canMoveTo(card: Card, status: CardStatus): boolean {
  if (card.workflowVersion === 1) return true;
  if (status !== 'doing' || card.items.length === 0) return true;
  return !card.items.every((i) => i.done);
}

/**
 * Move a card to a column (§6). Plain cards take the status directly. On a
 * checklist card "done" = check all, "todo" = uncheck all, "doing" = manual
 * start (items untouched); a fully checked list is rejected and returned as-is.
 */
export function moveCard(
  card: Card,
  status: CardStatus,
  order: number,
  nowIso?: string,
): Card {
  if (card.workflowVersion === 1) return updateCard(card, { labels: workflowLabels(card.labels, status), order }, nowIso);
  if (!canMoveTo(card, status)) return card;
  if (card.items.length === 0) {
    return updateCard({ ...card, order }, { status, order }, nowIso);
  }
  const target =
    status === 'done'
      ? card.items.map((i) => ({ ...i, done: true }))
      : status === 'todo'
        ? card.items.map((i) => ({ ...i, done: false }))
        : card.items;
  return updateCard(card, { items: target, status, order }, nowIso);
}

export function checkAll(card: Card, nowIso?: string): Card {
  return updateCard(card, { items: card.items.map((i) => ({ ...i, done: true })) }, nowIso);
}

/** §7.5 "Uncheck all" resets the list for reuse: back to To do even from Doing. */
export function uncheckAll(card: Card, nowIso?: string): Card {
  return updateCard(card, { items: card.items.map((i) => ({ ...i, done: false })), status: 'todo' }, nowIso);
}

/** §4.2: cards of one column in display order. Done sorts by completedAt desc. */
export function columnCards(cards: ReadonlyArray<Card>, status: CardStatus): Card[] {
  const col = cards.filter((c) => (c.workflowVersion === 1 ? workflowStatus(c) === status : c.status === status && c.kind !== 'note') && !c.archivedAt && !c.draft);
  if (status === 'done') {
    return col.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '') || b.order - a.order);
  }
  // To do: the active cards, then the Someday region below the divider.
  return col.sort((a, b) => Number(!!a.someday) - Number(!!b.someday) || a.order - b.order);
}

/** §4.2: new and arriving cards append at the bottom of their column. */
export function nextOrder(cards: ReadonlyArray<Card>, status: CardStatus): number {
  let max = -1;
  for (const c of cards) if ((c.workflowVersion === 1 ? workflowStatus(c) === status : c.status === status && c.kind !== 'note') && !c.archivedAt && c.order > max) max = c.order;
  return max + 1;
}

/** §7.4: split the notes into items (same markers as the grammar) and clear them. */
export function notesToChecklist(card: Card, uid: () => string, nowIso?: string): Card {
  const items = itemsFromLines(card.notes, uid);
  return updateCard(card, { notes: '', items: [...items, ...card.items] }, nowIso);
}

/** §4.2b: the fresh To do copy a Repeat card spawns on reaching Done. */
export function repeatCopy(src: Card, order: number, uid: () => string, nowIso?: string): Card {
  const copy = newCard({
    title: src.title,
    notes: src.notes,
    items: src.items.map((i) => ({ ...i, id: uid(), done: false })),
    status: 'todo',
    order,
    uid,
    nowIso,
  });
  copy.repeat = true;
  // A repeating reminder carries on with the copy, from its next slot (shared/repeat.mjs copyStamp).
  if (repeats(src) && src.remindAt) {
    copy.remindEvery = src.remindEvery;
    copy.remindAt = src.remindAt;
    copy.remindedAt = copyStamp(src, copy.createdAt);
  }
  copy.labels = src.workflowVersion === 1 ? workflowLabels(src.labels, 'todo') : [...(src.labels ?? [])];
  if (src.workflowVersion === 1) copy.workflowVersion = 1;
  if (src.links?.length) copy.links = src.links.map((l) => ({ ...l }));
  if (src.attachments?.length) copy.attachments = src.attachments.map((a) => ({ ...a }));
  return copy;
}

/** §4.3: archive done cards whose completedAt is older than `days` (0 = never). */
export function archiveOlderThan(board: Board, days: number, nowIso?: string): number {
  if (!days || days <= 0) return 0;
  const ts = nowIso ?? now();
  const cutoff = new Date(ts).getTime() - days * 86400000;
  let n = 0;
  board.cards = board.cards.map((c) => {
    const finished = c.kind === 'note' ? !!c.done : c.status === 'done';
    if (c.workflowVersion === 1 && !c.labels.some(isWorkflowLabel)) return c;
    if (!finished || c.archivedAt || !c.completedAt) return c;
    if (new Date(c.completedAt).getTime() >= cutoff) return c;
    n++;
    return { ...c, archivedAt: ts };
  });
  return n;
}

const STATUSES: CardStatus[] = ['todo', 'doing', 'done'];

/** §3: accept a JSON export; null when it is not a v1 board. */
export function validateBoard(input: unknown): Board | null {
  if (!input || typeof input !== 'object') return null;
  const b = input as Partial<Board>;
  if (b.schemaVersion !== 1 || !Array.isArray(b.cards)) return null;
  for (const c of b.cards as Partial<Card>[]) {
    if (!c || typeof c.id !== 'string' || typeof c.title !== 'string') return null;
    if (!STATUSES.includes(c.status as CardStatus)) return null;
    if (!Array.isArray(c.items)) return null;
  }
  const cards = (b.cards as Card[]).map((c) => normalizeCard({
    ...c,
    notes: typeof c.notes === 'string' ? c.notes : '',
    order: typeof c.order === 'number' ? c.order : 0,
    createdAt: c.createdAt ?? now(),
    updatedAt: c.updatedAt ?? c.createdAt ?? now(),
    completedAt: c.completedAt ?? null,
    archivedAt: c.archivedAt ?? null,
    someday: !!c.someday,
    repeat: !!c.repeat,
    items: normalize(c.items).slice(0, ITEMS_MAX),
  }));
  const settings = b.settings && typeof b.settings === 'object' ? b.settings : undefined;
  const labels = withBuiltins(Array.isArray(b.labels) ? (b.labels as Label[]) : []);
  return { schemaVersion: 1, cards, labels, settings: settings as Board['settings'] };
}

/** §7.13 Merge: unknown ids are added; known ids keep the newer updatedAt. */
export function mergeBoards(current: Board, incoming: Board): Board {
  const byId = new Map(current.cards.map((c) => [c.id, c]));
  for (const c of incoming.cards) {
    const mine = byId.get(c.id);
    if (!mine || (c.updatedAt ?? '') > (mine.updatedAt ?? '')) byId.set(c.id, c);
  }
  const labels = new Map((current.labels ?? []).map((l) => [l.id, l]));
  for (const l of incoming.labels ?? []) if (!labels.has(l.id)) labels.set(l.id, l);
  return { ...current, cards: [...byId.values()], labels: [...labels.values()] };
}

/** Strip a label id from every card that carries it; returns only the changed cards. */
export function removeLabelFromCards(cards: ReadonlyArray<Card>, labelId: string, nowIso?: string): Card[] {
  return cards.filter((c) => c.labels?.includes(labelId)).map((c) => updateCard(c, { labels: c.labels.filter((id) => id !== labelId) }, nowIso));
}

/** Re-normalise the orders within one column so they are 0, 1, 2, … in order. */
export function renormaliseColumn(cards: Card[], status: CardStatus): void {
  const inCol = cards.filter((c) => c.status === status).sort((a, b) => a.order - b.order);
  inCol.forEach((c, i) => {
    c.order = i;
  });
}

/** Toggle a single item; §6 derivation runs inside updateCard. */
export function toggleItem(card: Card, itemId: string, done: boolean, nowIso?: string): Card {
  const items = card.items.map((i) => (i.id === itemId ? { ...i, done } : i));
  return updateCard(card, { items }, nowIso);
}

/** Remove items by id (used by "clear N checked"). */
export function removeItems(card: Card, ids: string[], nowIso?: string): Card {
  const set = new Set(ids);
  return updateCard(card, { items: card.items.filter((i) => !set.has(i.id)) }, nowIso);
}

/** Duplicate a card into a target column (default To Do). */
export function duplicateCard(
  board: Board,
  cardId: string,
  order: number,
  uid: () => string,
  status?: CardStatus,
  nowIso?: string,
): Card | undefined {
  const src = findCard(board, cardId);
  if (!src) return undefined;
  const ts = nowIso ?? now();
   // §7.9 — a duplicate starts fresh: a " (copy)" suffix and every item
   // unchecked, so it is a new attempt at the same work (lands in To Do).
  const copy = newCard(
    {
      title: src.title + ' (copy)',
      notes: src.notes,
      items: src.items.map((i) => ({ ...i, id: uid(), done: false })),
      status,
      order,
      uid,
      nowIso: ts,
    },
  );
  copy.someday = src.someday;
  copy.repeat = src.repeat;
  copy.labels = src.workflowVersion === 1 ? workflowLabels(src.labels, 'todo') : [...(src.labels ?? [])];
  const stage = stageOf(src, board.labels);
  if (stage && !isWorkflowLabel(stage.id)) {
    const first = stagesOf(flowGroup(stage), board.labels)[0];
    copy.labels = [...src.labels.filter(id => id !== stage.id), first.id];
  }
  if (src.workflowVersion === 1) copy.workflowVersion = 1;
  if (src.links?.length) copy.links = src.links.map((l) => ({ ...l }));
  if (src.attachments?.length) copy.attachments = src.attachments.map((a) => ({ ...a }));
  return copy;
}

/** Delete a card from the board. */
export function deleteCard(board: Board, cardId: string): number {
  const before = board.cards.length;
  board.cards = board.cards.filter((c) => c.id !== cardId);
  return before - board.cards.length; // 1 if deleted, 0 otherwise
}

/** Move `id` before `beforeId` (null = the end). Ticked items keep their place, so there are no groups. */
export function moveItemTo<T extends { id: string }>(items: ReadonlyArray<T>, id: string, beforeId: string | null): T[] {
  const moving = items.find((i) => i.id === id);
  if (!moving) return [...items];
  const rest = items.filter((i) => i.id !== id);
  const at = beforeId ? rest.findIndex((i) => i.id === beforeId) : -1;
  rest.splice(at < 0 ? rest.length : at, 0, moving);
  return rest;
}

/** One step up or down in the list. */
export function nudgeItemIn<T extends { id: string }>(items: ReadonlyArray<T>, id: string, dir: -1 | 1): T[] {
  const k = items.findIndex((i) => i.id === id);
  const j = k + dir;
  if (k < 0 || j < 0 || j >= items.length) return [...items];
  const before = dir < 0 ? items[j].id : items[j + 1]?.id ?? null;
  return moveItemTo(items, id, before);
}

/** Reorder an item to a new position within a card's items array. */
export function reorderItems(card: Card, fromId: string, toId: string, nowIso?: string): Card {
  const from = card.items.findIndex((i) => i.id === fromId);
  const to = card.items.findIndex((i) => i.id === toId);
  if (from < 0 || to < 0 || from === to) return card;
  const items = [...card.items];
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved);
  return updateCard(card, { items }, nowIso);
}

/** Archive every non-archived card matching a query (used by "archive in search"). */
export function archiveMatching(board: Board, query: string, nowIso?: string): number {
  const ts = nowIso ?? now();
  const q = query.trim().toLowerCase();
  if (q === '') return 0;
  const hits = new Set<string>();
  for (const c of board.cards) {
    if (c.archivedAt) continue;
    const hay = [c.title, c.notes, ...c.items.map((i) => i.text)].join('\n').toLowerCase();
    if (hay.includes(q)) hits.add(c.id);
  }
  const n = hits.size;
  board.cards = board.cards.map((c) => (hits.has(c.id) ? { ...c, archivedAt: ts } : c));
  return n;
}
