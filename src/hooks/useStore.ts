import { cleanBehavior, groupedLabels, settleAutomations } from '../../shared/automations.mjs';
import { belongsToColumn, workflowColumn } from '../lib/board-columns';
import { gridOrder } from '../lib/notes-layout';
import { applyWorkflow, completionLabels, isFlowStage, stageOf, stagesOf, flowGroup, linkedTodo, migrateWorkflow, workflowLabels, isWorkflowLabel } from '../../shared/workflow.mjs';
// Kanban store — single board, all cards. Status is always derived (§6).
//
// Module-level state shared with the window.kanban singleton; a React hook
// subscribes to it. The reducer (src/lib/reducer.ts) is pure; this store owns
// ordering, persistence, undo, toasts (§15.1 copy only), Repeat spawning,
// archive, import/export, storage failure and cross-tab broadcast.

import type { AssistantProposal } from '../lib/assistant';
import { currentAccount, personalSettings, savePersonalSettings, scopedKey } from '../lib/account';
import { useEffect, useState } from 'react';
import type { Attachment, Board, BoardSettings, Card, CardItem, CardLink, CardStatus, Label, RemindEvery } from '../lib/types';
import { REMIND_EVERY, remindResting } from '../../shared/repeat.mjs';
import { missedOnLeave } from '../lib/remind';
import { applyStatus } from '../lib/derive';
import { DEFAULT_SETTINGS } from '../lib/types';
import {
  addItemsToCard,
  archiveOlderThan,
  canMoveTo,
  cardFromText,
  columnCards,
  duplicateCard,
  mergeBoards,
  moveCard as reducerMoveCard,
  moveItemTo,
  newCard,
  nudgeItemIn,
  nextOrder,
  notesToChecklist,
  removeItems,
  removeLabelFromCards,
  repeatCopy,
  toggleItem as reducerToggleItem,
  updateCard,
  validateBoard,
} from '../lib/reducer';
import { ITEM_MAX, ITEMS_MAX, parseCard, splitCards } from '../lib/parse';
import { trailingChecklist } from '../lib/trailing-checklist';
import { loadBoard, loadLabelFilter, loadSettings, removeCard, saveLabelFilter, saveLabels, saveSettings, uid, upsertCard } from '../lib/db';
import { INBOX_FILTER, NOTES_NONE_FILTER, LABEL_PALETTE, SHERLOCK, cleanLabelName, findLabel, isHexColor, normalizeCard, withBuiltins } from '../lib/labels';
import { applyTheme, applyReduceMotion } from './useTheme';
import { copy } from '../lib/copy';
import { welcomeCard } from '../lib/fixtures';
import { getToken } from '../lib/sync';
import { markSeen, quietFor } from '../lib/seen';
import { displayTitle, isCardDone, isNote, parentsOf, wouldCycle } from '../../shared/notes.mjs';
import type { CardLayout } from '../lib/types';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const SOMEDAY_KEY = 'kept.somedayOpen';

export const state: {
  board: Board;
  ready: boolean;
  storageFailed: boolean;
  corrupt: number;
  lastChangeType: string;
  /** Active label filter (ids); per device, not synced, outside undo. The Board's. */
  labelFilter: string[];
  /** The Notes view's own filter (§11.11: per view, for the session). */
  notesFilter: string[];
  /** Someday section expanded; per device (localStorage), shared by the board and keyboard nav. */
  somedayOpen: boolean;
  /** A view-only link: every board-changing action is a no-op (see the guard after `actions`). */
  readOnly: boolean;
} = {
  board: { schemaVersion: 1, cards: [], labels: [{ ...SHERLOCK }], settings: DEFAULT_SETTINGS },
  ready: false,
  storageFailed: false,
  corrupt: 0,
  lastChangeType: '',
  labelFilter: [],
  notesFilter: readNotesFilter(),
  somedayOpen: readSomedayOpen(),
  readOnly: false,
};

function readSomedayOpen(): boolean {
  try {
    return localStorage.getItem(scopedKey(SOMEDAY_KEY)) !== '0';
  } catch {
    return true;
  }
}

// §13.3 — the sync engine hears every committed change (set by App/sync bootstrap).
let commitHook: ((type: string) => void) | null = null;
export function setCommitHook(fn: ((type: string) => void) | null): void {
  commitHook = fn;
}
// Signed in, another window's change is a hint to sync, never a reason to re-read IndexedDB.
let crossTabHook: (() => boolean) | null = null;
export function setCrossTabHook(fn: (() => boolean) | null): void {
  crossTabHook = fn;
}

const SEEDED_KEY = 'kept.seeded';
const CHANNEL = 'kept.kanban';
const listeners = new Set<() => void>();
let notifyScheduled = false;
let channel: BroadcastChannel | null = null;
let lastChangeType = 'change';

function notify(type = 'change', card?: Card): void {
  if (type === 'remote' || type === 'reload') {
    markSeen(state.board.cards.map(c => c.id));
    quietFor(600);
  } else quietFor(0);
  lastChangeType = type;
  state.lastChangeType = type;
  if (notifyScheduled) return;
  notifyScheduled = true;
  queueMicrotask(() => {
    notifyScheduled = false;
    for (const fn of listeners) fn();
    window.dispatchEvent(new CustomEvent('kanban:change', { detail: { type: lastChangeType, card } }));
    commitHook?.(lastChangeType);
  });
}

// ---------------------------------------------------------------------------
// Persistence (write-through; a failure flips storageFailed, §13.4)
// ---------------------------------------------------------------------------

let failWrites = false; // test hook
let writeSeq = 0;
let lastFailSeq = 0;

function markFailed(seq: number): void {
  lastFailSeq = Math.max(lastFailSeq, seq);
  if (!state.storageFailed) {
    state.storageFailed = true;
    notify();
  }
}

async function persist(card: Card): Promise<void> {
  const seq = ++writeSeq;
  try {
    if (failWrites) throw new Error('write blocked');
    await upsertCard(card);
    // Only a write started after the last failure proves storage is back.
    if (state.storageFailed && seq > lastFailSeq) {
      state.storageFailed = false;
      notify();
    }
  } catch {
    markFailed(seq);
  }
}

async function persistLabels(): Promise<void> {
  const seq = ++writeSeq;
  try {
    if (failWrites) throw new Error('write blocked');
    await saveLabels(state.board.labels);
  } catch {
    markFailed(seq);
  }
}

async function unpersist(id: string): Promise<void> {
  const seq = ++writeSeq;
  try {
    if (failWrites) throw new Error('write blocked');
    await removeCard(id);
  } catch {
    markFailed(seq);
  }
}

const NOTES_FILTER_KEY = 'kept.notesFilter';
function readNotesFilter(): string[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(NOTES_FILTER_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function saveNotesFilter(): void {
  try {
    sessionStorage.setItem(NOTES_FILTER_KEY, JSON.stringify(state.notesFilter));
  } catch {
    /* storage blocked */
  }
}

/** Undo or a remote change can remove a filtered label; a dead id would hide every card. */
function pruneFilter(): void {
  const ids = new Set([...state.board.labels.map((l) => l.id), INBOX_FILTER, NOTES_NONE_FILTER]);
  if (!state.notesFilter.every((id) => ids.has(id))) {
    state.notesFilter = state.notesFilter.filter((id) => ids.has(id));
    saveNotesFilter();
  }
  if (state.labelFilter.every((id) => ids.has(id))) return;
  state.labelFilter = state.labelFilter.filter((id) => ids.has(id));
  void saveLabelFilter(state.labelFilter).catch(() => {});
}

export function broadcast(): void {
  channel?.postMessage({ type: 'change' });
}

// ---------------------------------------------------------------------------
// Undo (§7.8) + toasts (§15.1)
// ---------------------------------------------------------------------------

/**
 * One undo step records only what its action changed: per card / label, the
 * before-values of the fields (and checklist items) that differ between the
 * action's before and after. Created entities are deleted on undo, deleted ones
 * come back whole. Everything else, including later sync changes to the same
 * card, survives an undo.
 */
type Change<T> =
  | { kind: 'created' }
  | { kind: 'deleted'; before: T }
  | { kind: 'patch'; fields: Record<string, unknown>; items?: ItemsPatch; labels?: { added: string[]; removed: string[]; before: string[] } };
interface ItemsPatch {
  before: Map<string, CardItem | null>; // null = added by the action
  order: string[]; // item ids before the action
  reordered: boolean;
}
interface Snap {
  id: number;
  label: string;
  base: Board | null; // full copy until sealed, then dropped
  cards: Map<string, Change<Card>>;
  labels: Map<string, Change<Label>>;
  settings?: BoardSettings;
}
const undoStack: Snap[] = [];
const UNDO_MAX = 10;
let snapSeq = 0;

export type Toast = {
  id: number;
  message: string;
  undo: (() => void) | null;
  ms: number;
  expiresAt: number;
  kind?: string;
  count?: number;
};
let currentToast: Toast | null = null;
let toastId = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let toastRemaining = 0; // ms left while paused (hover / focus, §11.9)
let toastPaused = false;

function armToast(ms: number): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastTimer = null;
    currentToast = null;
    notify();
  }, ms);
}

function pauseToast(): void {
  if (!currentToast || toastPaused) return;
  toastPaused = true;
  toastRemaining = Math.max(0, currentToast.expiresAt - Date.now());
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
}

function resumeToast(): void {
  if (!currentToast || !toastPaused) return;
  toastPaused = false;
  currentToast = { ...currentToast, expiresAt: Date.now() + toastRemaining };
  armToast(toastRemaining);
  notify();
}

export function getToast(): Toast | null {
  return currentToast;
}
export function undoDepth(): number {
  return undoStack.length;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function showToast(message: string, opts: { undo?: (() => void) | null; ms?: number; kind?: string; count?: number } = {}): void {
  const ms = opts.ms ?? 5000;
  toastPaused = false;
  currentToast = { id: ++toastId, message, undo: opts.undo ?? null, ms, expiresAt: Date.now() + ms, kind: opts.kind, count: opts.count };
  armToast(ms);
  notify();
}

function dismissToast(): void {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  toastPaused = false;
  currentToast = null;
  notify();
}

let pending: Snap | null = null;

/** Open an undo step before a destructive/bulk action. Returns the snap id. */
function pushUndo(label: string): number {
  sealUndo();
  const snap: Snap = { id: ++snapSeq, label, base: clone(state.board), cards: new Map(), labels: new Map() };
  pending = snap;
  undoStack.unshift(snap);
  while (undoStack.length > UNDO_MAX) undoStack.pop();
  // Actions are synchronous: by the next microtask the step's writes are all in.
  queueMicrotask(sealUndo);
  return snap.id;
}

/** Close the open step: keep before-states of what changed since pushUndo, drop the copy. */
function sealUndo(): void {
  const snap = pending;
  if (!snap || !snap.base) return;
  pending = null;
  const base = snap.base;
  snap.base = null;
  touched(snap.cards, base.cards, state.board.cards);
  touched(snap.labels, base.labels, state.board.labels);
  if (JSON.stringify(base.settings) !== JSON.stringify(state.board.settings)) snap.settings = base.settings;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function touched<T extends { id: string }>(out: Map<string, Change<T>>, before: T[], after: T[]): void {
  const now = new Map(after.map((x) => [x.id, x]));
  const was = new Set(before.map((x) => x.id));
  for (const x of before) {
    const y = now.get(x.id);
    if (!y) out.set(x.id, { kind: 'deleted', before: x });
    else if (!same(x, y)) out.set(x.id, fieldPatch(x, y));
  }
  for (const id of now.keys()) if (!was.has(id)) out.set(id, { kind: 'created' });
}

/** Before-values of the fields that changed (undefined = the field was absent); items per item. */
function fieldPatch<T extends { id: string }>(before: T, after: T): Change<T> {
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (k === 'id' || k === 'updatedAt' || k === 'items' || k === 'labels') continue;
    if (!same(b[k], a[k])) fields[k] = b[k];
  }
  let items: ItemsPatch | undefined;
  if (Array.isArray(b.items) && !same(b.items, a.items)) {
    const bi = b.items as CardItem[];
    const ai = (a.items ?? []) as CardItem[];
    const aMap = new Map(ai.map((i) => [i.id, i]));
    const bIds = new Set(bi.map((i) => i.id));
    const map = new Map<string, CardItem | null>();
    for (const i of bi) if (!same(i, aMap.get(i.id))) map.set(i.id, i);
    for (const i of ai) if (!bIds.has(i.id)) map.set(i.id, null);
    const common = (list: CardItem[], other: Set<string>) => list.filter((i) => other.has(i.id)).map((i) => i.id).join();
    items = { before: map, order: bi.map((i) => i.id), reordered: common(bi, new Set(aMap.keys())) !== common(ai, bIds) };
  }
  const oldLabels = Array.isArray(b.labels) ? b.labels as string[] : [];
  const newLabels = Array.isArray(a.labels) ? a.labels as string[] : [];
  const labels = same(oldLabels, newLabels) ? undefined : { added: newLabels.filter((id) => !oldLabels.includes(id)), removed: oldLabels.filter((id) => !newLabels.includes(id)), before: oldLabels };
  return { kind: 'patch', fields, items, labels };
}

/** Apply a patch's before-values onto the entity as it is now. */
function applyPatch<T extends { id: string }>(cur: T, p: Extract<Change<T>, { kind: 'patch' }>): T {
  const next = { ...cur } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p.fields)) {
    if (v === undefined) delete next[k];
    else next[k] = clone(v);
  }
  if (p.labels) {
    const current = (next.labels ?? []) as string[];
    const currentWorkflow = current.find(isWorkflowLabel);
    const removed = p.labels.removed.filter((id) => !isWorkflowLabel(id) || !currentWorkflow || p.labels!.added.includes(currentWorkflow));
    const restored = [...new Set([...current.filter((id) => !p.labels!.added.includes(id)), ...removed])];
    const rank = (id: string) => p.labels!.before.includes(id) ? p.labels!.before.indexOf(id) : Number.MAX_SAFE_INTEGER;
    next.labels = restored.sort((a, b) => rank(a) - rank(b));
  }
  if (p.items) {
    let list = [...((next.items ?? []) as CardItem[])];
    for (const [id, before] of p.items.before) {
      if (!before) {
        list = list.filter((i) => i.id !== id);
        continue;
      }
      const at = list.findIndex((i) => i.id === id);
      if (at >= 0) list[at] = { ...before };
      else {
        // Back in front of the next item that preceded it before the action and still exists.
        const later = p.items.order.slice(p.items.order.indexOf(id) + 1);
        const pos = list.findIndex((i) => later.includes(i.id));
        list.splice(pos < 0 ? list.length : pos, 0, { ...before });
      }
    }
    if (p.items.reordered) {
      const rank = (id: string) => (p.items!.order.includes(id) ? p.items!.order.indexOf(id) : Number.MAX_SAFE_INTEGER);
      list = list.map((i, n) => ({ i, n })).sort((x, y) => rank(x.i.id) - rank(y.i.id) || x.n - y.n).map((x) => x.i);
    }
    next.items = list;
  }
  return next as T;
}

/** Put back only what the step changed, in memory and in IndexedDB. */
function restore(snap: Snap): void {
  sealUndo();
  const ts = new Date().toISOString();
  for (const [id, ch] of snap.cards) {
    const cur = findById(id);
    if (ch.kind === 'created') {
      if (!cur) continue;
      state.board.cards = state.board.cards.filter((c) => c.id !== id);
      void unpersist(id);
      continue;
    }
    let c: Card;
    if (ch.kind === 'deleted') c = clone(ch.before);
    else if (cur) {
      c = applyPatch(cur, ch);
      applyStatus(c, ts); // status stays derived from the items as they are now
      if (remindResting(cur) && !remindResting(c)) c = missedOnLeave(c, ts); // undone out of Done / Someday: never a late push
      c.updatedAt = ts;
    } else continue; // deleted elsewhere since: nothing to patch
    if (cur) replace(c);
    else state.board.cards = [...state.board.cards, c];
    void persist(c);
  }
  if (snap.labels.size) {
    let labels = state.board.labels;
    for (const [id, ch] of snap.labels) {
      const cur = labels.find((l) => l.id === id);
      if (ch.kind === 'created') labels = labels.filter((l) => l.id !== id);
      else if (ch.kind === 'deleted') labels = cur ? labels.map((l) => (l.id === id ? clone(ch.before) : l)) : [...labels, clone(ch.before)];
      else if (cur) labels = labels.map((l) => (l.id === id ? { ...applyPatch(l, ch), updatedAt: ts } : l));
    }
    state.board.labels = labels;
    void persistLabels();
  }
  if (snap.settings) {
    state.board.settings = clone(snap.settings);
    void saveSettings(state.board.settings);
  }
  for (const card of state.board.cards) {
    if (card.workflowVersion !== 1) continue;
    const next = applyWorkflow({ ...card, labels: groupedLabels(card.labels, state.board.labels) }, ts, state.board.labels);
    if (stableJson(next) !== stableJson(card)) { replace(next); void persist(next); }
  }
  pruneFilter();
  broadcast();
}

function undoTop(): void {
  const snap = undoStack.shift();
  if (!snap) return;
  restore(snap);
  if (toastTimer) clearTimeout(toastTimer);
  currentToast = null;
  notify('undo');
}

/** Undo one specific snapshot if it is still on the stack (window.kanban.remove().undo). */
function undoSnap(id: number): void {
  const idx = undoStack.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const [snap] = undoStack.splice(idx, 1);
  restore(snap);
  if (currentToast && idx === 0) {
    if (toastTimer) clearTimeout(toastTimer);
    currentToast = null;
  }
  notify('undo');
}

// ---------------------------------------------------------------------------
// Commit helpers
// ---------------------------------------------------------------------------

/** JSON with object keys sorted, so equal data compares equal whatever order the keys arrived in. */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
}

function findById(id: string): Card | undefined {
  return state.board.cards.find((c) => c.id === id);
}

function replace(next: Card): void {
  state.board.cards = state.board.cards.map((c) => (c.id === next.id ? next : c));
}

/**
 * Commit a changed card: place it in the board, spawn the Repeat copy when it
 * just reached Done (§4.2b), persist, broadcast, notify.
 */
function settleProgress(before: Card[], now: string): void {
  const settled = settleAutomations(state.board.cards, state.board.labels, before, now);
  state.board.cards = settled;
  for (const card of settled) {
    const previous = before.find(c => c.id === card.id);
    if (card === previous) continue;
    void persist(card);
    if (previous && card.repeat && (card.workflowVersion !== 1 || card.labels.some(isWorkflowLabel)) && card.status === 'done' && previous.status !== 'done') {
      const cp = repeatCopy(card, nextOrder(state.board.cards, 'todo'), uid);
      state.board.cards = [...state.board.cards, cp];
      void persist(cp);
      showToast(copy.repeatBackInTodo(card.title));
    }
  }
}

function commit(prev: Card | undefined, next: Card, type = 'update'): Card {
  const before = state.board.cards;
  if (next.draft) { next = { ...next }; delete next.draft; }
  next = { ...next, labels: groupedLabels(next.labels, state.board.labels) };
  if (next.workflowVersion === 1) applyWorkflow(next, next.updatedAt, state.board.labels, prev);
  else applyStatus(next, next.updatedAt);
  if (prev && prev.kind === 'note' && next.kind !== 'note') {
    next = { ...next, order: topOrder(next.status, next.id) };
  } else if (prev && prev.status !== next.status && next.kind !== 'note') {
    next = { ...next, order: nextOrder(state.board.cards.filter(c => c.id !== next.id), next.status) };
  }
  replace(next);
  settleProgress(before, next.updatedAt);
  const result = findById(next.id)!;
  broadcast();
  notify(type, result);
  return result;
}

/** The order that puts a card at the top of its column. */
function topOrder(status: CardStatus, except?: string): number {
  const orders = state.board.cards.filter((c) => c.id !== except && c.status === status && !c.archivedAt && c.kind !== 'note' && !c.someday).map((c) => c.order);
  return orders.length ? Math.min(...orders) - 1 : 0;
}

const nameOf = (c: Card): string => displayTitle(c);

/** An empty card to build a note from (order is unused until it is placed). */
function newCardBase(): Card {
  return newCard({ title: '', order: 0, uid });
}

function insert(card: Card, type = 'create'): Card {
  card = migrateWorkflow(card);
  const before = state.board.cards;
  state.board.cards = [...before, card];
  settleProgress(before, card.updatedAt);
  const result = findById(card.id)!;
  broadcast();
  notify(type, result);
  return result;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

let initialised = false;
// Built for the backend's origin (production). Tests flip it through _setHosted.
let hosted = !!(import.meta as { env?: { PROD?: boolean } }).env?.PROD;
let dailyTimer: ReturnType<typeof setInterval> | null = null;

export type ComposerMode = 'checklist' | 'notes' | 'grammar';

export const actions = {
  undo: undoTop,

  discardBlank(id: string): void {
    const card = findById(id);
    if (!card?.draft) return;
    state.board.cards = state.board.cards.filter((c) => c.id !== id);
    notify('draft');
  },

  createBlank(status: CardStatus | null = null, labels: string[] = []): Card {
    const card = migrateWorkflow({ ...newCardBase(), kind: 'note' as const });
    card.labels = workflowLabels(labels, status);
    const column = status ? actions.visibleColumn(status) : labels.length ? actions.visibleColumn(labels[0]) : [];
    card.order = column.length ? Math.min(...column.map((c) => c.order)) - 1 : 0;
    const draft = { ...migrateWorkflow(card), draft: true };
    state.board.cards = [...state.board.cards, draft];
    notify('draft', draft);
    return draft;
  },
  undoSnap,
  dismissToast,
  showToast,
  pauseToast,
  resumeToast,

  init(): Promise<void> {
    if (initialised) return Promise.resolve();
    initialised = true;
    return (async () => {
      await actions.reload();
      if (currentAccount() && !currentAccount()!.preferences.theme) savePersonalSettings({ theme: state.board.settings.theme, reduceMotion: state.board.settings.reduceMotion });
      applyTheme(state.board.settings.theme, state.board.settings.background, state.board.settings);
      applyReduceMotion(state.board.settings.reduceMotion);
      // §13.2 cross-tab: signed in, the other tab syncs; local-only, it re-reads the store.
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(scopedKey(CHANNEL));
        channel.onmessage = () => {
          if (!crossTabHook?.()) void actions.reload();
        };
      }
      // §4.3 auto-archive on launch and daily while open.
      actions.archiveExpired();
      if (!dailyTimer) dailyTimer = setInterval(() => actions.archiveExpired(), 86400000);
      state.ready = true;
      notify('ready');
    })();
  },

  /** Re-read IndexedDB (launch, cross-tab). Seeds the Welcome card once (§4.5). */
  async reload(): Promise<void> {
    sealUndo();
    const loaded = await loadBoard(DEFAULT_SETTINGS);
    const settings = personalSettings(await loadSettings(loaded.settings));
    state.somedayOpen = readSomedayOpen();
    let cards = loaded.cards.map(c => migrateWorkflow(c, loaded.labels));
    state.corrupt = loaded.corrupt;
    // A device that already holds a sync token bootstraps from the shared board instead (F4).
    // The hosted app (a backend exists) never seeds: the server board is the only board.
    if (cards.length === 0 && loaded.corrupt === 0 && !localStorage.getItem(SEEDED_KEY) && !getToken() && !hosted) {
      // Per-device random id: deleting the seed on one device must not tombstone another's.
      const seed = welcomeCard(0, undefined, uid());
      cards = [seed];
      void persist(seed);
    }
    if (cards.length > 0) localStorage.setItem(SEEDED_KEY, '1');
    state.board = { schemaVersion: 1, cards, labels: withBuiltins(loaded.labels), settings: { ...DEFAULT_SETTINGS, ...settings } };
    const ids = new Set([...loaded.labels.map((l) => l.id), INBOX_FILTER]);
    state.labelFilter = (await loadLabelFilter().catch(() => [] as string[])).filter((id) => ids.has(id));
    notify('reload');
  },

  column(status: CardStatus): Card[] {
    return columnCards(state.board.cards, status);
  },

  /** A note appears in each column whose label it carries. */
  visibleColumn(status: string): Card[] {
    const workflow = workflowColumn(status);
    if (workflow) return columnCards(state.board.cards, workflow);
    return state.board.cards.filter((c) => belongsToColumn(c, status)).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  },

  /** Keyboard order: the visible column, minus parked cards while Someday is collapsed. */
  navColumn(status: string): Card[] {
    const col = actions.visibleColumn(status);
    return status === 'todo' && !state.somedayOpen ? col.filter((c) => !c.someday) : col;
  },

  setSomedayOpen(open: boolean): void {
    if (state.somedayOpen === open) return;
    state.somedayOpen = open;
    try {
      localStorage.setItem(scopedKey(SOMEDAY_KEY), open ? '1' : '0');
    } catch {
      /* ignore */
    }
    notify('someday-view');
  },

  /** Header counters: Someday cards never count as open (§4.2a). */
  counts(): { open: number; someday: number; done: number; todo: number; doing: number } {
    let todo = 0, doing = 0, done = 0, someday = 0;
    for (const c of state.board.cards) {
      if (c.archivedAt || c.draft || c.kind === 'note') continue;
      if (c.status === 'done') done++;
      else if (c.someday) someday++;
      else if (c.status === 'todo') todo++;
      else doing++;
    }
    return { open: todo + doing, someday, done, todo, doing };
  },

  /**
   * Composer / API create. `mode` 'checklist' (default): line 1 title, rest
   * items; 'notes': rest is notes; 'grammar': §14.1 (notes until first marker).
   */
  addCardFromText(
    text: string,
    status: CardStatus = 'todo',
    mode: ComposerMode = 'checklist',
    labels: string[] = [],
    opts: { remindAt?: string | null; remindEvery?: RemindEvery | null; atTop?: boolean; undo?: boolean; toast?: string } = {},
  ): Card | undefined {
    if (!text.trim()) return undefined;
    let card: Card;
    if (mode === 'notes') {
      const lines = text.replace(/\r\n/g, '\n').split('\n');
      const first = lines.findIndex((l) => l.trim() !== '');
      const title = first < 0 ? '' : lines[first].replace(/^#\s+/, '').trim();
      const notes = lines.slice(first + 1).join('\n').replace(/^\n+|\s+$/g, '');
      card = cardFromText(title, nextOrder(state.board.cards, status), uid, status);
      card = updateCard(card, { notes });
    } else if (mode === 'grammar') {
      const p = parseCard(text, uid);
      card = cardFromText(p.title || 'Untitled', nextOrder(state.board.cards, status), uid, status);
      card = updateCard(card, { notes: p.notes, items: p.items });
      if (p.dropped > 0) showToast(copy.itemCap());
    } else {
      card = cardFromText(text, nextOrder(state.board.cards, status), uid, status);
    }
    if (labels.length) card = { ...card, labels: [...new Set(labels)] };
    if (card.status !== status) {
      card = { ...card, order: nextOrder(state.board.cards, card.status) };
      showToast(copy.landedElsewhere(label(card.status)));
    }
    if (opts.remindAt) card = updateCard(card, { remindAt: opts.remindAt, remindEvery: opts.remindEvery ?? null });
    if (opts.atTop !== false && card.status !== 'done') {
      const orders = state.board.cards
        .filter(c => c.status === card.status && !c.archivedAt && !c.someday)
        .map(c => c.order);
      card = { ...card, order: orders.length ? Math.min(...orders) - 1 : 0 };
    }
    if (opts.undo) pushUndo('add card');
    const added = insert(card);
    if (opts.undo) showToast(opts.toast ?? `Added '${card.title}'`, { undo: undoTop });
    return added;
  },

  /** Applies a suggestion; returns the card it landed on, its undo step and the items it added (§12.5). */
  applyAssistantProposal(proposal: AssistantProposal): { cardId: string; snap: number; itemIds: string[] } {
    if (state.readOnly || !currentAccount()) throw new Error('Sign in to apply suggestions.');
    const lines = proposal.items.map(text => text.trim().replace(/[\r\n]+/g, ' ').slice(0, 200)).filter(Boolean).slice(0, 20);
    if (proposal.type === 'create') {
      const title = proposal.title.trim().replace(/[\r\n]+/g, ' ').slice(0, 200);
      if (!title) throw new Error('A task needs a title.');
      const snap = pushUndo('add suggested task');
      // §12.5: a new task lands at the top of To do.
      const orders = state.board.cards.filter(c => c.status === 'todo' && !c.archivedAt && !c.someday).map(c => c.order);
      const base = cardFromText(title, orders.length ? Math.min(...orders) - 1 : 0, uid, 'todo');
      const items = lines.map(text => ({ id: uid(), text, done: false }));
      const card = insert(updateCard(base, { title, notes: proposal.notes.slice(0, 2000), items }));
      showToast(`Added '${title}'`, { undo: undoTop });
      return { cardId: card.id, snap, itemIds: items.map(i => i.id) };
    }
    const card = findById(proposal.cardId || '');
    if (!card || card.archivedAt || card.status === 'done') throw new Error('This task is no longer available for new steps.');
    const fresh = [...new Set(lines)].filter(text => !card.items.some(item => item.text === text));
    if (fresh.length > ITEMS_MAX - card.items.length) throw new Error('This task has too many checklist items.');
    if (!fresh.length) throw new Error('These steps are already on the task.');
    const snap = pushUndo('add suggested steps');
    const items = fresh.map(text => ({ id: uid(), text, done: false }));
    commit(card, updateCard(card, { items: [...card.items, ...items] }), 'items');
    showToast('Added checklist steps', { undo: undoTop });
    return { cardId: card.id, snap, itemIds: items.map(i => i.id) };
  },

  /** §14.1 bulk text: cards separated by "---". Returns the created cards. */
  addCardsFromGrammar(text: string, status: CardStatus = 'todo'): Card[] {
    const out: Card[] = [];
    for (const section of splitCards(text).reverse()) {
      const c = actions.addCardFromText(section, status, 'grammar');
      if (c) out.push(c);
    }
    return out.reverse();
  },

  updateCardTitle(id: string, title: string): void {
    const card = findById(id);
    if (!card) return;
    const t = title.trim().slice(0, 200);
    if (!t || t === card.title) return;
    commit(card, updateCard(card, { title: t }));
  },

  updateCardNotes(id: string, notes: string): void {
    const card = findById(id);
    if (!card || notes === card.notes) return;
    commit(card, updateCard(card, { notes: notes.slice(0, 5000) }));
  },

  finishBodyEditing(id: string, notes: string): string | undefined {
    actions.updateCardNotes(id, notes);
    const card = findById(id);
    if (!card) return;
    const tail = trailingChecklist(card.notes);
    if (!tail) return card.notes;
    if (tail.items.length > ITEMS_MAX - card.items.length) {
      showToast(copy.itemCap());
      return card.notes;
    }
    pushUndo('convert trailing list');
    const items = tail.items.map((item) => ({ ...item, id: uid() }));
    const title = !card.title.trim() && !tail.notes.trim() ? { title: displayTitle(card), titleBy: 'auto' as const } : {};
    commit(card, updateCard(card, { ...title, notes: tail.notes, items: [...card.items, ...items] }), 'items');
    showToast('Moved list to checklist', { undo: undoTop });
    return tail.notes;
  },

  /** Status control / drag / keyboard 1-2-3. Returns the card, or undefined when rejected. */
  moveCardAction(id: string, status: CardStatus): Card | undefined {
    const card = findById(id);
    if (!card || (card.status === status && (card.workflowVersion !== 1 || card.labels.includes(`workflow:${status}`)))) return card;
    if (!canMoveTo(card, status)) {
      showToast(copy.checkAllRejected());
      return undefined;
    }
    const moved = reducerMoveCard(card, status, nextOrder(state.board.cards, status));
    return commit(card, moved, 'move');
  },

  /** Returning a list clears its checks; Undo restores the whole move. */
  putBackCard(id: string): void {
    const card = findById(id);
    if (!card || card.status !== 'doing') return;
    pushUndo('put back');
    actions.moveCardAction(id, 'todo');
    showToast(`Put back '${card.title}'`, { undo: undoTop });
  },

  /** Card-face circle (§2 matrix): plain toggles todo/done; checklist checks/unchecks all. */
  toggleCircle(id: string): void {
    const card = findById(id);
    if (!card) return;
    if (card.workflowVersion === 1) { actions.setCardDone(id, !isCardDone(card)); return; }
    if (card.items.length === 0) {
      const to: CardStatus = card.status === 'done' ? 'todo' : 'done';
      commit(card, reducerMoveCard(card, to, nextOrder(state.board.cards, to)), 'move');
      return;
    }
    if (card.status === 'done') actions.uncheckAllAction(id);
    else actions.checkAllAction(id);
  },

  checkAllAction(id: string): void {
    const card = findById(id);
    if (!card || card.items.length === 0) return;
    const n = card.items.filter((i) => !i.done).length;
    if (n > 0) showToast(copy.checkedAll(n), { undo: undoTop });
    actions.setItemsDone(id, card.items.map(i => i.id), true);
  },

  uncheckAllAction(id: string): void {
    const card = findById(id);
    if (!card || card.items.length === 0) return;
    const n = card.items.filter((i) => i.done).length;
    actions.setItemsDone(id, card.items.map(i => i.id), false);
    if (n > 0) showToast(copy.uncheckedAll(n), { undo: undoTop });
  },

  /** Label-column drops keep other labels; one Undo restores the move. */
  dropInColumn(id: string, beforeId: string | null, column: string, someday = false): void {
    const workflow = workflowColumn(column);
    const card = findById(id);
    if (!card || card.archivedAt) return;
    if (workflow) {
      pushUndo('move note');
      if (isNote(card)) actions.placeCard(id, workflow, { toast: false });
      actions.reorderCard(id, beforeId, workflow, someday);
      showToast(`'${nameOf(card)}' is in ${label(workflow)}`, { undo: undoTop });
      return;
    }
    const destination = state.board.labels.find((l) => l.id === column);
    if (!destination) return;
    const rows = actions.visibleColumn(column).filter((c) => c.id !== id);
    const i = beforeId ? rows.findIndex((c) => c.id === beforeId) : -1;
    const order = i < 0 ? (rows[rows.length - 1]?.order ?? -1) + 1 : i === 0 ? rows[0].order - 1 : (rows[i - 1].order + rows[i].order) / 2;
    pushUndo('move note');
    commit(card, updateCard(card, { labels: [...new Set([...card.labels, column])], order }), 'labels');
    showToast(`Added ${destination.name} to '${nameOf(card)}'`, { undo: undoTop });
  },

  /** Reorder within the workflow column and optional Someday region. */
  reorderCard(id: string, beforeId: string | null, toStatus: CardStatus, someday?: boolean): void {
    const card = findById(id);
    if (!card) return;
    if (toStatus === 'done') {
      if (card.status !== 'done') actions.moveCardAction(id, 'done');
      return; // Done is sorted by completedAt; not reorderable (§4.2)
    }
    let moved = card;
    if (card.status !== toStatus) {
      const m = actions.moveCardAction(id, toStatus);
      if (!m) return;
      moved = m;
    }
    const sd = toStatus === 'todo' && (someday ?? (beforeId ? !!findById(beforeId)?.someday : moved.someday));
    const col = columnCards(state.board.cards, toStatus).filter((c) => c.id !== id && !!c.someday === sd);
    const idx = beforeId ? col.findIndex((c) => c.id === beforeId) : -1;
    let order: number;
    if (idx < 0) order = (col[col.length - 1]?.order ?? -1) + 1;
    else if (idx === 0) order = col[0].order - 1;
    else order = (col[idx - 1].order + col[idx].order) / 2;
    const nc = updateCard(moved, { order, someday: sd });
    replace(nc);
    void persist(nc);
    broadcast();
    notify('reorder', nc);
  },

  /** Top of the card's column, or of Someday for a parked card. */
  moveToTop(id: string): void {
    const card = findById(id);
    if (!card || card.status === 'done') return;
    const first = columnCards(state.board.cards, card.status).find((c) => !!c.someday === card.someday);
    if (!first || first.id === id) return;
    actions.reorderCard(id, first.id, card.status, card.someday);
  },

  /** Cmd+↑/↓: swap with the neighbour; in To do one step crosses the Someday divider. */
  nudge(id: string, dir: -1 | 1): void {
    const card = findById(id);
    if (!card || card.status === 'done') return;
    const col = columnCards(state.board.cards, card.status);
    const i = col.findIndex((c) => c.id === id);
    const j = i + dir;
    if (i < 0) return;
    if (card.status === 'todo') {
      const region = col.filter((c) => !!c.someday === card.someday);
      const r = region.findIndex((c) => c.id === id);
      if (!card.someday && dir > 0 && r === region.length - 1) {
        actions.reorderCard(id, col.find((c) => c.someday)?.id ?? null, 'todo', true);
        return;
      }
      if (card.someday && dir < 0 && r === 0) {
        actions.reorderCard(id, null, 'todo', false);
        return;
      }
    }
    if (j < 0 || j >= col.length) return;
    const before = dir < 0 ? col[j].id : col[j + 1]?.id ?? null;
    actions.reorderCard(id, before, card.status, card.someday);
  },

  toggleItem(cardId: string, itemId: string): void {
    const card = findById(cardId);
    const item = card?.items.find((i) => i.id === itemId);
    if (!card || !item) return;
    // A row that IS a card: ticking it finishes that card; every parent row follows (v6 §1).
    if (item.ref && findById(item.ref)) {
      actions.setCardDone(item.ref, !item.done);
      return;
    }
    pushUndo('check item');
    commit(card, reducerToggleItem(card, itemId, !item.done), 'check');
  },

  /** Set several items at once in ONE write (API check/uncheck, "*"). */
  setItemsDone(cardId: string, ids: string[], done: boolean): void {
    const card = findById(cardId);
    if (!card || !ids.length) return;
    const set = new Set(ids);
    if (!card.items.some((i) => set.has(i.id) && i.done !== done)) return;
    pushUndo('check items');
    for (const item of card.items) if (set.has(item.id) && item.ref && findById(item.ref)) actions.setCardDone(item.ref, done, { toast: false });
    const current = findById(cardId)!;
    commit(current, updateCard(current, { items: current.items.map(i => set.has(i.id) && !i.ref ? { ...i, done } : i) }), 'check');
  },

  /** Add-items field: every non-empty line is an item, appended after the last unchecked one. */
  addItem(cardId: string, text: string): void {
    actions.addItemsBatch(cardId, text.replace(/\r\n/g, '\n').split('\n'));
  },

  addItemsBatch(cardId: string, lines: string[], opts: { undo?: boolean } = {}): void {
    const card = findById(cardId);
    const clean = lines.filter((l) => l.trim() !== '');
    if (!card || clean.length === 0) return;
    const room = ITEMS_MAX - card.items.length;
    if (room <= 0) {
      showToast(copy.itemCap());
      return;
    }
    if (opts.undo || clean.length > 1) pushUndo('add items');
    const work = clone(card);
    const added = addItemsToCard(work, clean.slice(0, room).join('\n'), uid);
    commit(card, work, 'items');
    if (clean.length > room) showToast(copy.itemCap());
    else if (added > 50) showToast(copy.addItems(added));
  },

  editItem(cardId: string, itemId: string, text: string): void {
    const card = findById(cardId);
    if (!card) return;
    const t = text.trim().slice(0, ITEM_MAX);
    if (!t) {
      actions.deleteItem(cardId, itemId);
      return;
    }
    commit(card, updateCard(card, { items: card.items.map((i) => (i.id === itemId ? { ...i, text: t } : i)) }));
  },

  /** Enter inside an item's text: the text before the caret stays, the rest becomes the next item. Returns its id. */
  splitItem(cardId: string, itemId: string, before: string, after: string): string | null {
    const card = findById(cardId);
    if (!card) return null;
    const head = before.trim().slice(0, ITEM_MAX);
    const tail = after.trim().slice(0, ITEM_MAX);
    if (!head || !tail) {
      actions.editItem(cardId, itemId, head || tail);
      return null;
    }
    const idx = card.items.findIndex((i) => i.id === itemId);
    if (idx < 0) return null;
    if (card.items.length >= ITEMS_MAX) {
      showToast(copy.itemCap());
      actions.editItem(cardId, itemId, `${head} ${tail}`);
      return null;
    }
    const id = uid();
    const items = [...card.items];
    items[idx] = { ...items[idx], text: head };
    items.splice(idx + 1, 0, { id, text: tail, done: items[idx].done });
    commit(card, updateCard(card, { items }));
    return id;
  },

  deleteItem(cardId: string, itemId: string): void {
    const card = findById(cardId);
    const it = card?.items.find((i) => i.id === itemId);
    if (!card || !it) return;
    pushUndo('remove item');
    commit(card, removeItems(card, [itemId]));
    showToast(copy.itemRemoved(it.text), { undo: undoTop });
  },

  clearChecked(cardId: string): void {
    const card = findById(cardId);
    if (!card) return;
    const done = card.items.filter((i) => i.done);
    if (!done.length) return;
    pushUndo('clear checked');
    commit(card, removeItems(card, done.map((i) => i.id)));
    showToast(copy.itemsCleared(done.length), { undo: undoTop });
  },

  /** Checklist drag: `itemId` before `beforeId` (null = end) within its unchecked / checked group. */
  moveItem(cardId: string, itemId: string, beforeId: string | null): void {
    const card = findById(cardId);
    if (!card) return;
    const items = moveItemTo(card.items, itemId, beforeId);
    if (items.map((i) => i.id).join() === card.items.map((i) => i.id).join()) return;
    commit(card, updateCard(card, { items }), 'items');
  },

  /** ⌥↑/⌥↓ on a checklist row: one step within its group. */
  nudgeItem(cardId: string, itemId: string, dir: -1 | 1): void {
    const card = findById(cardId);
    if (!card) return;
    const items = nudgeItemIn(card.items, itemId, dir);
    if (items.map((i) => i.id).join() === card.items.map((i) => i.id).join()) return;
    commit(card, updateCard(card, { items }), 'items');
  },

  turnNotesIntoChecklist(cardId: string): void {
    const card = findById(cardId);
    if (!card || card.items.length > 0 || !card.notes.trim()) return;
    pushUndo('notes to checklist');
    commit(card, notesToChecklist(card, uid));
  },

  /** Delete (no confirmation). Consecutive deletes stack into one toast (§7.8). */
  deleteCardById(id: string): number | undefined {
    const card = findById(id);
    if (!card) return undefined;
    const snapId = pushUndo('delete card');
    const before = state.board.cards;
    state.board.cards = state.board.cards.filter((c) => c.id !== id);
    void unpersist(id);
    // A deleted child turns its rows back into plain text (its title), ref removed (v6 §1).
    for (const p of parentsOf(state.board.cards, id)) {
      const np = updateCard(p, { items: p.items.map((i) => (i.ref === id ? { id: i.id, text: nameOf(card).slice(0, ITEM_MAX), done: i.done } : i)) });
      replace(np);
      void persist(np);
    }
    settleProgress(before, new Date().toISOString());
    broadcast();
    notify('delete', card);
    const stacked = currentToast?.kind === 'delete' ? (currentToast.count ?? 1) + 1 : 1;
    showToast(stacked > 1 ? copy.severalDeleted(stacked) : copy.cardDeleted(nameOf(card)), { undo: undoTop, kind: 'delete', count: stacked });
    return snapId;
  },

  duplicate(cardId: string): string | undefined {
    const card = findById(cardId);
    if (!card) return undefined;
    // §7.9: directly below the original when it is in To do (within its group —
    // a Someday original gets a Someday copy right under it), else at the bottom.
    const col = columnCards(state.board.cards, 'todo').filter((c) => c.someday === card.someday);
    const idx = col.findIndex((c) => c.id === cardId);
    let order: number;
    if (idx < 0) order = nextOrder(state.board.cards, 'todo');
    else if (idx === col.length - 1) order = col[idx].order + 1;
    else order = (col[idx].order + col[idx + 1].order) / 2;
    const dup = duplicateCard(state.board, cardId, order, uid, 'todo');
    if (!dup) return undefined;
    dup.someday = card.status === 'todo' && card.someday;
    insert(dup);
    return dup.id;
  },

  toggleSomeday(id: string): void {
    const card = findById(id);
    if (card) actions.setSomeday(id, !card.someday);
  },

  /** Menu / S / status control: parking lands at the top of Someday, un-parking at the bottom of To do. */
  setSomeday(id: string, on: boolean): void {
    const card = findById(id);
    if (!card || card.archivedAt || card.someday === on) return;
    if (on) actions.reorderCard(id, columnCards(state.board.cards, 'todo').find((c) => c.someday && c.id !== id)?.id ?? null, 'todo', true);
    else actions.reorderCard(id, null, 'todo', false);
  },

  toggleRepeat(id: string): void {
    const card = findById(id);
    if (!card) return;
    commit(card, updateCard(card, { repeat: !card.repeat }));
  },

  // ---- notes (v5 / v6) -------------------------------------------------------

  /** A note from the Notes composer: the text is its body; the title derives until one is typed. */
  addNote(text: string, opts: { labels?: string[]; undo?: boolean; title?: string; toast?: string } = {}): Card | undefined {
    const body = text.replace(/\r\n/g, '\n').replace(/^\n+|\s+$/g, '');
    const title = (opts.title ?? '').trim().slice(0, 200);
    if (!body.trim() && !title) return undefined;
    let card: Card = migrateWorkflow({ ...newCardBase(), kind: 'note' });
    card = updateCard(card, { notes: body.slice(0, 5000), kind: 'note', labels: [...new Set(opts.labels ?? [])], ...(title ? { title, titleBy: 'user' as const } : {}) });
    if (opts.undo) pushUndo('add note');
    const added = insert(card);
    if (opts.undo) showToast(opts.toast ?? `Added '${nameOf(card)}'`, { undo: undoTop });
    return added;
  },

  /** The ring promotes a note, completes a to do, then reopens it. */
  cycleRing(id: string): void {
    const card = findById(id);
    if (!card || card.archivedAt) return;
    if (isNote(card)) actions.placeCard(id, 'todo');
    else actions.setCardDone(id, !isCardDone(card));
  },

  /** Swipe advances one stage; finished notes reopen to their previous open stage. */
  advanceCard(id: string): void {
    const card = findById(id);
    if (!card || card.archivedAt) return;
    const t = nameOf(card);
    pushUndo('ring');
    if (isCardDone(card)) {
      actions.setCardDone(id, false, { toast: false });
      showToast(`'${t}' reopened`, { undo: undoTop });
    } else if (isNote(card)) {
      actions.placeCard(id, 'todo', { toast: false });
      showToast(`'${t}' is in To do`, { undo: undoTop });
    } else if (card.workflowVersion === 1 && !card.labels.some(isWorkflowLabel)) {
      const stage = stageOf(card, state.board.labels);
      const stages = stagesOf(stage && flowGroup(stage), state.board.labels);
      const target = stages[stages.findIndex(l => l.id === stage?.id) + 1];
      if (target) {
        commit(card, updateCard(card, { labels: [...card.labels.filter(id => id !== stage?.id), target.id] }), 'move');
        showToast(`'${t}' is in ${target.name}`, { undo: undoTop });
      }
    } else if (card.status === 'todo') {
      if (!canMoveTo(card, 'doing')) return;
      commit(card, reducerMoveCard(card, 'doing', nextOrder(state.board.cards, 'doing')), 'move');
      showToast(`'${t}' started`, { undo: undoTop });
    } else {
      commit(card, reducerMoveCard(card, 'done', nextOrder(state.board.cards, 'done')), 'move');
      showToast(`'${t}' done`, { undo: undoTop });
    }
  },

  /** Note → a column (top of it), or a to do → a note again. One write, so Undo reverts it whole. */
  placeCard(id: string, to: CardStatus | 'note', opts: { toast?: boolean } = {}): void {
    const card = findById(id);
    if (!card) return;
    if (card.workflowVersion === 1) {
      if (opts.toast !== false) pushUndo('place');
      const labels = card.labels.filter(id => !state.board.labels.some(l => l.id === id && isFlowStage(l)));
      if (to !== 'note') labels.push(`workflow:${to}`);
      commit(card, updateCard(card, { labels }), 'kind');
      if (opts.toast !== false) showToast(`'${nameOf(card)}' is ${to === 'note' ? 'a note' : `in ${label(to)}`}`, { undo: undoTop });
      return;
    }
    if (to === 'note') {
      if (isNote(card)) return;
      if (opts.toast !== false) pushUndo('make note');
      const done = card.status === 'done';
      commit(card, updateCard(card, { kind: 'note', done, someday: false }), 'kind');
      if (opts.toast !== false) showToast(`'${nameOf(card)}' is a note again`, { undo: undoTop });
      return;
    }
    if (opts.toast !== false) pushUndo('place');
    if (isNote(card)) {
      // Items keep their ticks; status follows them unless the target says otherwise.
      let next = updateCard(card, { kind: 'todo', status: to, order: topOrder(to, id) });
      if (next.status !== to && canMoveTo(next, to)) next = reducerMoveCard(next, to, topOrder(to, id));
      next = { ...next, order: next.status === to ? topOrder(to, id) : next.order };
      commit(card, next, 'kind');
    } else if (card.status !== to) {
      if (!canMoveTo(card, to)) {
        showToast(copy.checkAllRejected());
        return;
      }
      commit(card, reducerMoveCard(card, to, nextOrder(state.board.cards, to)), 'move');
    }
    if (opts.toast !== false) showToast(`'${nameOf(card)}' is in ${label(to)}`, { undo: undoTop });
  },

  /** Finish or reopen in the current flow; a plain note uses Todos. */
  setCardDone(id: string, done: boolean, opts: { toast?: boolean } = {}): void {
    const card = findById(id);
    if (!card || isCardDone(card) === done) return;
    if (opts.toast !== false) pushUndo(done ? 'done' : 'reopen');
    if (card.workflowVersion === 1) commit(card, updateCard(card, { labels: completionLabels(card, done, state.board.labels) }), 'check');
    else if (isNote(card)) commit(card, updateCard(card, { done }), 'check');
    else if (done) commit(card, reducerMoveCard(card, 'done', nextOrder(state.board.cards, 'done')), 'move');
    else {
      // Reopen: Doing when some rows are ticked, else To do; the ticks stay.
      const to: CardStatus = card.items.some((i) => i.done) && card.items.some((i) => !i.done) ? 'doing' : 'todo';
      const items = card.items.every((i) => i.done) ? card.items.map((i) => ({ ...i, done: false })) : card.items;
      commit(card, updateCard(card, { items, status: to }), 'move');
    }
    if (opts.toast !== false) showToast(`'${nameOf(card)}' ${done ? 'done' : 'reopened'}`, { undo: undoTop });
  },

  /** Typed title: the user owns it from now on (the assistant never rewrites it). Empty = derive again. */
  setTitle(id: string, title: string): void {
    const card = findById(id);
    if (!card) return;
    const t = title.replace(/\s*\n\s*/g, ' ').trim().slice(0, 200);
    if (t === card.title && (card.titleBy === 'user' || !t)) return;
    commit(card, updateCard(card, { title: t, titleBy: t ? 'user' : null }));
  },

  /** Link `childId` as a row of `parentId` (v6 §5); refused when it would loop or is already there. */
  linkCard(parentId: string, childId: string, opts: { at?: number } = {}): boolean {
    const parent = findById(parentId);
    const child = findById(childId);
    if (!parent || !child || parent.items.some((i) => i.ref === childId)) return false;
    if (wouldCycle(state.board.cards, parentId, childId)) return false;
    if (parent.items.length >= ITEMS_MAX) {
      showToast(copy.itemCap());
      return false;
    }
    pushUndo('link');
    if (isNote(child)) commit(child, updateCard(child, { labels: linkedTodo(child).labels }), 'kind');
    const linkedChild = findById(childId)!;
    const row: CardItem = { id: uid(), text: nameOf(linkedChild).slice(0, ITEM_MAX), done: isCardDone(linkedChild), ref: childId };
    let at = opts.at ?? 0;
    if (opts.at === undefined) parent.items.forEach((i, idx) => { if (!i.done) at = idx + 1; });
    const items = [...parent.items.slice(0, at), row, ...parent.items.slice(at)];
    commit(parent, updateCard(parent, { items }), 'items');
    showToast(`Linked '${nameOf(child)}' under '${nameOf(parent)}'`, { undo: undoTop });
    return true;
  },

  /** Keep the original row as a link; creating the child is one undo step. */
  promoteItem(parentId: string, itemId: string): Card | undefined {
    const parent = findById(parentId);
    const item = parent?.items.find((row) => row.id === itemId);
    if (!parent || !item) return undefined;
    if (item.ref) return findById(item.ref);
    pushUndo('make item a to do');
    const labels = workflowLabels(parent.labels, item.done ? 'done' : 'todo');
    const child = insert(updateCard(migrateWorkflow({ ...newCardBase(), id: item.id, kind: 'note' }), {
      notes: item.text,
      labels,
    }));
    const current = findById(parentId)!;
    commit(current, updateCard(current, { items: current.items.map(row => row.id === itemId ? { ...row, ref: child.id } : row) }), 'items');
    showToast(`Made '${nameOf(child)}' a to do`, { undo: undoTop });
    return child;
  },

  /** `[[query` with no match creates a linked to do in one undo step. */
  linkNewTodo(parentId: string, text: string): Card | undefined {
    const parent = findById(parentId);
    const body = text.trim().slice(0, 5000);
    if (!parent || !body) return undefined;
    pushUndo('link new to do');
    const child = insert(updateCard(newCardBase(), { notes: body, labels: workflowLabels([], 'todo') }));
    const row: CardItem = { id: uid(), text: nameOf(child).slice(0, ITEM_MAX), done: false, ref: child.id };
    let at = 0;
    parent.items.forEach((i, idx) => { if (!i.done) at = idx + 1; });
    const p = findById(parentId)!;
    commit(p, updateCard(p, { items: [...p.items.slice(0, at), row, ...p.items.slice(at)] }), 'items');
    showToast(`Linked '${nameOf(child)}' under '${nameOf(p)}'`, { undo: undoTop });
    return child;
  },

  /** Grid place (v6 §3): `orderIds` is the whole grid order after a drag; sizes per card. */
  arrange(orderIds: string[], toast?: string): void {
    pushUndo('arrange');
    let changed = false;
    orderIds.forEach((id, i) => {
      const c = findById(id);
      if (!c) return;
      const layout: CardLayout = { ...c.layout, order: i };
      delete layout.anchor;
      if (c.layout?.order === i && !c.layout.anchor) return;
      const nc = { ...c, layout, updatedAt: new Date().toISOString() };
      replace(nc);
      void persist(nc);
      changed = true;
    });
    if (!changed) return;
    broadcast();
    notify('arrange');
    if (toast) showToast(toast, { undo: undoTop });
  },

  resizeCard(id: string, width: 1 | 2, height: number | null, geometry?: Pick<CardLayout, 'width' | 'anchor'>): void {
    const card = findById(id);
    if (!card) return;
    pushUndo('resize');
    gridOrder(state.board.cards.filter((c) => !c.archivedAt && !c.draft)).forEach((c, order) => {
      const layout: CardLayout = { ...c.layout, order };
      delete layout.anchor;
      if (c.id === id) {
        layout.w = width;
        if (geometry) Object.assign(layout, geometry);
        else delete layout.width;
        if (height === null) delete layout.height;
        else layout.height = Math.max(84, Math.min(1000, Math.round(height)));
      }
      if (stableJson(layout) !== stableJson(c.layout)) commit(c, updateCard(c, { layout }), 'arrange');
    });
    showToast('Card resized', { undo: undoTop });
  },

  acceptSuggestedLabel(id: string): void {
    const card = findById(id);
    const lid = card?.suggestedLabel;
    if (!card || !lid) return;
    pushUndo('accept label');
    const labels = state.board.labels.some((l) => l.id === lid) && !card.labels.includes(lid) ? [...card.labels, lid] : card.labels;
    commit(card, updateCard(card, { labels, suggestedLabel: null }), 'labels');
    const name = state.board.labels.find((l) => l.id === lid)?.name;
    if (name) showToast(`Filed under ${name}`, { undo: undoTop });
  },

  dismissSuggestedLabel(id: string): void {
    const card = findById(id);
    if (!card?.suggestedLabel) return;
    commit(card, updateCard(card, { suggestedLabel: null }), 'labels');
  },

  // ---- archive (§4.3, §7.11) ------------------------------------------------

  archiveExpired(): number {
    const before = state.board.cards;
    const n = archiveOlderThan(state.board, state.board.settings.archiveAfterDays);
    if (n > 0) {
      for (const c of state.board.cards) if (!before.includes(c)) void persist(c);
      broadcast();
      notify('archive');
    }
    return n;
  },

  archiveCard(id: string): void {
    const card = findById(id);
    if (!card || card.status !== 'done' || card.archivedAt) return;
    pushUndo('archive');
    commit(card, updateCard(card, { archivedAt: new Date().toISOString() }), 'archive');
    showToast(copy.archived(1), { undo: undoTop, ms: 10000 });
  },

  archiveAllDone(): void {
    const done = columnCards(state.board.cards, 'done');
    if (!done.length) return;
    pushUndo('archive all');
    const ts = new Date().toISOString();
    for (const c of done) {
      const nc = updateCard(c, { archivedAt: ts });
      replace(nc);
      void persist(nc);
    }
    broadcast();
    notify('archive');
    showToast(copy.archived(done.length), { undo: undoTop, ms: 10000 });
  },

  restoreCard(id: string): void {
    const card = findById(id);
    if (!card || !card.archivedAt) return;
    commit(card, updateCard(card, { archivedAt: null }), 'restore');
  },

  deleteArchived(id: string): void {
    const card = findById(id);
    if (!card || !card.archivedAt) return;
    pushUndo('delete archived');
    const before = state.board.cards;
    state.board.cards = state.board.cards.filter((c) => c.id !== id);
    void unpersist(id);
    settleProgress(before, new Date().toISOString());
    broadcast();
    notify('delete', card);
    showToast(copy.cardDeleted(card.title), { undo: undoTop, ms: 30000 });
  },

  deleteAllArchived(): void {
    const gone = state.board.cards.filter((c) => c.archivedAt);
    if (!gone.length) return;
    pushUndo('delete all archived');
    state.board.cards = state.board.cards.filter((c) => !c.archivedAt);
    for (const c of gone) void unpersist(c.id);
    broadcast();
    notify('delete');
    showToast(copy.severalDeleted(gone.length), { undo: undoTop, ms: 30000 });
  },

  // ---- labels + links -----------------------------------------------------------

  /** Create a label (or reuse one with the same name); optionally apply it to a card in the same undo step. */
  createLabel(name: string, color?: string, applyTo?: string): Label | undefined {
    const n = cleanLabelName(name);
    if (!n) return undefined;
    const existing = findLabel(state.board.labels, n);
    if (existing) {
      if (applyTo) actions.setCardLabels(applyTo, [...(findById(applyTo)?.labels ?? []), existing.id]);
      return existing;
    }
    pushUndo('create label');
    const used = new Set(state.board.labels.map((l) => l.color.toUpperCase()));
    const c = isHexColor(color) ? color : LABEL_PALETTE.find((p) => !used.has(p)) ?? LABEL_PALETTE[state.board.labels.length % LABEL_PALETTE.length];
    const l: Label = { id: uid(), name: n, color: c, updatedAt: new Date().toISOString() };
    state.board.labels = [...state.board.labels, l];
    void persistLabels();
    const card = applyTo ? findById(applyTo) : undefined;
    if (card) commit(card, updateCard(card, { labels: [...card.labels, l.id] }), 'labels');
    else {
      broadcast();
      notify('labels');
    }
    return l;
  },

  saveFlow(group: string | null, name: string, stages: { id?: string; name: string; finished: boolean }[]): boolean {
    const nextGroup = cleanLabelName(name);
    const names = stages.map(s => cleanLabelName(s.name));
    if (!nextGroup || nextGroup.toLowerCase() === 'workflow' || names.length < 2 || names.length > 12 || names.some(n => !n) || new Set(names.map(n => n.toLowerCase())).size !== names.length || stages.filter(s => s.finished).length !== 1 || stages[0].finished || state.board.labels.some(l => l.group !== group && l.group?.toLowerCase() === nextGroup.toLowerCase())) return false;
    const current = group ? state.board.labels.filter(l => l.group === group) : [];
    if (stages.some(s => s.id && !current.some(l => l.id === s.id))) return false;
    pushUndo(group ? 'edit flow' : 'create flow');
    const now = new Date().toISOString();
    const before = state.board.cards;
    const updated: Label[] = stages.map((stage, order) => ({ ...(current.find(l => l.id === stage.id) ?? { id: uid(), color: LABEL_PALETTE[order % LABEL_PALETTE.length] }), name: names[order], group: nextGroup, flowStage: { order, finished: stage.finished }, updatedAt: now }));
    // Removed stages become ordinary labels, preserving every note and saved rule.
    const ids = new Set(updated.map(l => l.id));
    state.board.labels = state.board.labels.map(l => current.some(c => c.id === l.id) ? ids.has(l.id) ? updated.find(n => n.id === l.id)! : { ...l, group: null, flowStage: null, updatedAt: now } : l);
    state.board.labels.push(...updated.filter(l => !current.some(c => c.id === l.id)));
    for (const card of state.board.cards) {
      const stage = updated.find(l => card.labels.includes(l.id));
      const selected = stage ? [...card.labels.filter(id => id !== stage.id), stage.id] : card.labels;
      const next = card.workflowVersion === 1 ? applyWorkflow({ ...card, labels: groupedLabels(selected, state.board.labels) }, now, state.board.labels) : card;
      if (stableJson(next) !== stableJson(card)) { replace({ ...next, updatedAt: now }); void persist({ ...next, updatedAt: now }); }
    }
    settleProgress(before, now);
    void persistLabels(); broadcast(); notify('labels');
    showToast(`${nextGroup} flow saved`, { undo: undoTop });
    return true;
  },

  updateLabel(id: string, patch: Partial<Pick<Label, 'name' | 'color' | 'group' | 'automations' | 'removeOnView' | 'flowStage'>>): void {
    const cur = state.board.labels.find(l => l.id === id);
    if (!cur) return;
    const builtin = isWorkflowLabel(id);
    const name = !builtin && patch.name !== undefined ? cleanLabelName(patch.name) || cur.name : cur.name;
    const color = !builtin && patch.color !== undefined && isHexColor(patch.color) ? patch.color : cur.color;
    const next = { ...cur, ...cleanBehavior(patch, cur), name, color };
    if (patch.group !== undefined && !patch.group?.trim()) delete next.group;
    if (stableJson(next) === stableJson(cur)) return;
    pushUndo('edit label');
    state.board.labels = state.board.labels.map(l => l.id === id ? { ...next, updatedAt: new Date().toISOString() } : l);
    const before = state.board.cards;
    // Group changes resolve existing conflicts without running progress rules.
    for (const card of state.board.cards) {
      const labels = groupedLabels(card.labels, state.board.labels);
      const next = card.workflowVersion === 1 ? applyWorkflow({ ...card, labels }, new Date().toISOString(), state.board.labels, card) : { ...card, labels };
      if (stableJson(next) !== stableJson(card)) { replace(next); void persist(next); }
    }
    settleProgress(before, new Date().toISOString());
    void persistLabels();
    broadcast();
    notify('labels');
  },

  /** Delete a label and strip it from every card in one undoable write. The built-in stays. */
  deleteLabel(id: string): void {
    if (isWorkflowLabel(id)) return;
    const cur = state.board.labels.find((l) => l.id === id);
    if (!cur || cur.flowStage || id === SHERLOCK.id) return;
    pushUndo('delete label');
    state.board.labels = state.board.labels.filter((l) => l.id !== id);
    for (const c of removeLabelFromCards(state.board.cards, id)) {
      replace(c);
      void persist(c);
    }
    void persistLabels();
    if (state.labelFilter.includes(id)) actions.setLabelFilter(state.labelFilter.filter((x) => x !== id));
    if (state.notesFilter.includes(id)) actions.setNotesFilter(state.notesFilter.filter((x) => x !== id));
    broadcast();
    notify('labels');
    showToast(copy.labelDeleted(cur.name), { undo: undoTop });
  },

  toggleCardLabel(cardId: string, labelId: string): void {
    const card = findById(cardId);
    if (!card || !state.board.labels.some((l) => l.id === labelId)) return;
    const has = card.labels.includes(labelId);
    actions.setCardLabels(cardId, has ? card.labels.filter((x) => x !== labelId) : [...card.labels, labelId]);
  },

  setCardLabels(cardId: string, ids: string[]): void {
    const card = findById(cardId);
    if (!card) return;
    const next = groupedLabels(ids, state.board.labels);
    if (next.join() === card.labels.join()) return;
    pushUndo('card labels');
    commit(card, updateCard(card, { labels: next }), 'labels');
  },

  /** Set, change or clear (null) a reminder; one undo step. The time is stored as UTC ISO. */
  setReminder(cardId: string, at: string | null): void {
    const card = findById(cardId);
    if (!card) return;
    let iso: string | null = null;
    if (at !== null) {
      const t = new Date(at);
      if (Number.isNaN(t.getTime())) return;
      iso = t.toISOString();
    }
    if (iso === (card.remindAt ?? null)) return;
    pushUndo('reminder');
    // v5 §1: a reminder on a note places it in To do, in the same undo step.
    if (iso && isNote(card) && !card.done) {
      commit(card, updateCard(card, { remindAt: iso, kind: 'todo', status: 'todo', order: topOrder('todo', cardId) }), 'reminder');
      showToast(`'${nameOf(card)}' is in To do`, { undo: undoTop });
      return;
    }
    commit(card, updateCard(card, { remindAt: iso }), 'reminder');
    if (iso === null) showToast(copy.reminderCleared(), { undo: undoTop });
  },

  /** Make a reminder repeat (or stop, null); it keeps repeating until the card is done. */
  setRemindEvery(cardId: string, every: RemindEvery | null): void {
    const card = findById(cardId);
    if (!card?.remindAt || (every !== null && !REMIND_EVERY.includes(every))) return;
    if ((card.remindEvery ?? null) === every) return;
    pushUndo('reminder');
    commit(card, updateCard(card, { remindEvery: every }), 'reminder');
  },

  setReminderNotify(cardId: string, notify: boolean): void {
    const card = findById(cardId);
    if (!card || (card.notify !== false) === notify) return;
    pushUndo('reminder notifications');
    commit(card, updateCard(card, { notify }), 'reminder');
  },

  /** A file that reached the server joins the card (a synced att.put). False when the card is gone. */
  addAttachment(cardId: string, att: Attachment): boolean {
    const card = findById(cardId);
    if (!card) return false;
    commit(card, updateCard(card, { attachments: [...(card.attachments ?? []).filter((a) => a.id !== att.id), att] }), 'attach');
    return true;
  },

  removeAttachment(cardId: string, attId: string): void {
    const card = findById(cardId);
    const att = card?.attachments?.find((a) => a.id === attId);
    if (!card || !att) return;
    pushUndo('remove attachment');
    commit(card, updateCard(card, { attachments: (card.attachments ?? []).filter((a) => a.id !== attId) }), 'attach');
    showToast(copy.attachmentRemoved(att.name), { undo: undoTop });
  },

  removeCardLink(cardId: string, url: string): void {
    const card = findById(cardId);
    const link = card?.links?.find((l) => l.url === url);
    if (!card || !link) return;
    pushUndo('remove link');
    commit(card, updateCard(card, { links: (card.links ?? []).filter((l) => l.url !== url) }));
    showToast(copy.linkRemoved(link.title || link.url), { undo: undoTop });
  },

  addCardLink(cardId: string, link: CardLink): void {
    const card = findById(cardId);
    if (!card || card.links?.some((l) => l.url === link.url)) return;
    commit(card, updateCard(card, { links: [...(card.links ?? []), link] }));
  },

  /** Device-local: persisted in IndexedDB, never synced, not part of undo. */
  setNotesFilter(ids: string[]): void {
    const known = new Set([...state.board.labels.map((l) => l.id), INBOX_FILTER, NOTES_NONE_FILTER]);
    state.notesFilter = [...new Set(ids)].filter((id) => known.has(id));
    saveNotesFilter();
    notify('filter');
  },

  setLabelFilter(ids: string[]): void {
    const known = new Set([...state.board.labels.map((l) => l.id), INBOX_FILTER]);
    state.labelFilter = [...new Set(ids)].filter((id) => known.has(id));
    void saveLabelFilter(state.labelFilter).catch(() => {});
    notify('filter');
  },

  // ---- settings, export, import (§7.13) -------------------------------------

  updateSettings(partial: Partial<BoardSettings>): void {
    if (partial.theme && !partial.background) partial = { ...partial, background: undefined };
    savePersonalSettings(partial);
    state.board.settings = { ...state.board.settings, ...partial };
    void saveSettings(state.board.settings);
    if (partial.theme || partial.background || partial.studioTheme || partial.studioPattern) applyTheme(state.board.settings.theme, state.board.settings.background, state.board.settings);
    if (partial.reduceMotion) applyReduceMotion(partial.reduceMotion);
    if (partial.archiveAfterDays !== undefined) actions.archiveExpired();
    broadcast();
    notify('settings');
  },

  exportFilename(): string {
    return `kanban-${new Date().toISOString().slice(0, 10)}.json`;
  },

  /** Whole board as pretty JSON; stamps lastBackupAt (§7.13). */
  exportJSON(): string {
    actions.updateSettings({ lastBackupAt: new Date().toISOString() });
    return JSON.stringify({ ...state.board, cards: state.board.cards.filter((c) => !c.draft) }, null, 2);
  },

  /** Import a parsed export. Returns false (and toasts) when it is not a board. */
  importBoard(input: unknown, mode: 'replace' | 'merge'): boolean {
    const board = validateBoard(input);
    if (!board) {
      showToast(copy.badImport());
      return false;
    }
    pushUndo('import');
    const before = state.board.cards.map((c) => c.id);
    const next = mode === 'replace' ? { ...state.board, cards: board.cards, labels: board.labels } : mergeBoards(state.board, board);
    // Device settings stay device-local; Replace only takes the board's retention window.
    if (mode === 'replace' && typeof board.settings?.archiveAfterDays === 'number') {
      next.settings = { ...state.board.settings, archiveAfterDays: board.settings.archiveAfterDays };
    }
    next.cards = next.cards.map(c => c.workflowVersion === 1 ? applyWorkflow({ ...c, labels: groupedLabels(c.labels, next.labels) }, c.updatedAt, next.labels) : c);
    state.board = next;
    const after = new Set(next.cards.map((c) => c.id));
    for (const id of before) if (!after.has(id)) void unpersist(id);
    for (const c of next.cards) void persist(c);
    void persistLabels();
    void saveSettings(next.settings);
    localStorage.setItem(SEEDED_KEY, '1');
    actions.archiveExpired();
    broadcast();
    notify('import');
    showToast(mode === 'replace' ? copy.importReplaced(board.cards.length) : copy.importMerged(board.cards.length), { undo: undoTop, ms: 30000 });
    return true;
  },

  /** Import a .md/.txt in the §14.1 grammar (cards split on ---), Merge semantics. */
  importText(text: string): number {
    const sections = splitCards(text);
    if (!sections.length) {
      showToast(copy.badImport());
      return 0;
    }
    pushUndo('import text');
    const cards = actions.addCardsFromGrammar(text, 'todo');
    showToast(copy.importMerged(cards.length), { undo: undoTop, ms: 30000 });
    return cards.length;
  },

  /** First sync (login or pairing): a board that is only the untouched Welcome seed starts from the shared board (F4). */
  dropSeed(): void {
    const live = state.board.cards.filter((c) => !c.archivedAt);
    // Only an untouched seed: any edit or check stamps updatedAt past createdAt.
    if (live.length !== 1 || live[0].title !== 'Welcome. Tap me.' || live[0].updatedAt !== live[0].createdAt) return;
    const seed = live[0];
    state.board.cards = state.board.cards.filter((c) => c.id !== seed.id);
    void unpersist(seed.id);
    localStorage.setItem(SEEDED_KEY, '1');
    notify('reload'); // not a local edit: the sync engine must not diff it into an action
  },

  // ---- sync: background changes update quietly ----

  /**
   * Signed in: the board becomes exactly the server state (plus pending local edits). Equal cards
   * keep their objects (and the board its array and order), so a sync without changes is no change
   * at all: no notify, no writes, no re-render. `silent` (the first snapshot after launch or login)
   * marks every card as already seen, so nothing plays an entrance.
   */
  replaceBoard(cards: Card[], labels: Label[], silent = false): void {
    sealUndo();
    const prevById = new Map(state.board.cards.map((c) => [c.id, c]));
    const nextById = new Map<string, Card>();
    let changed = cards.length !== state.board.cards.length;
    for (const raw of cards) {
      const n = normalizeCard(raw, labels);
      const p = prevById.get(n.id);
      const same = !!p && stableJson(p) === stableJson(n);
      nextById.set(n.id, same ? p! : n);
      if (!same) changed = true;
    }
    const nextLabels = withBuiltins(labels);
    const labelsSame = stableJson(nextLabels) === stableJson(state.board.labels);
    if (silent) {
      markSeen(nextById.keys());
      quietFor(400);
    }
    if (!changed && labelsSame) return;
    // Existing cards keep their place in the array; new ones follow in the server's order.
    const drafts = state.board.cards.filter((c) => c.draft);
    const next = [...drafts, ...state.board.cards.filter((c) => !c.draft && nextById.has(c.id)).map((c) => nextById.get(c.id)!), ...[...nextById.values()].filter((c) => !prevById.has(c.id))];
    for (const c of state.board.cards) if (!c.draft && !nextById.has(c.id)) void unpersist(c.id);
    for (const c of next) if (!c.draft && c !== prevById.get(c.id)) void persist(c);
    state.board.cards = next;
    if (!labelsSame) {
      state.board.labels = nextLabels;
      void persistLabels();
      pruneFilter();
    }
    if (next.length) localStorage.setItem(SEEDED_KEY, '1');
    notify('remote'); // no broadcast: every window pulls the server itself
  },

  applyRemote(cards: Card[], deletedIds: string[], labels?: Label[] | null): void {
    sealUndo();
    cards = cards.map(c => normalizeCard(c, labels ?? state.board.labels));
    if (labels) {
      state.board.labels = withBuiltins(labels);
      void persistLabels();
      pruneFilter();
    }
    const gone = new Set(deletedIds);
    const byId = new Map(cards.map((c) => [c.id, c]));
    const next: Card[] = [];
    for (const c of state.board.cards) {
      if (gone.has(c.id)) continue;
      const r = byId.get(c.id);
      if (r) {
        next.push(r);
        byId.delete(c.id);
      } else next.push(c);
    }
    for (const c of byId.values()) next.push(c);
    state.board.cards = next;
    for (const id of gone) void unpersist(id);
    for (const c of cards) void persist(c);
    if (cards.length) localStorage.setItem(SEEDED_KEY, '1');
    broadcast();
    notify('remote');
  },

  // ---- storage failure (§13.4) ---------------------------------------------

  async retryWrites(): Promise<void> {
    state.storageFailed = false;
    for (const c of state.board.cards) await persist(c);
    await persistLabels();
    void saveSettings(state.board.settings);
    notify();
  },

  _failWrites(v: boolean): void {
    failWrites = v;
  },

  _setHosted(v: boolean): void {
    hosted = v;
  },
};

function label(s: CardStatus): string {
  return s === 'todo' ? 'To do' : s === 'doing' ? 'Doing' : 'Done';
}

// ---------------------------------------------------------------------------
// Read-only (a view-only link): ONE guard in front of every action
// ---------------------------------------------------------------------------

/**
 * The only actions that stay live when read-only: they never change the board, write an edit to
 * IndexedDB, open an undo step or toast. Everything else (including actions added later) is a
 * no-op while read-only.
 */
export const VIEW_ACTIONS: ReadonlySet<string> = new Set([
  'init', 'reload', 'column', 'visibleColumn', 'navColumn', 'counts', 'exportFilename',
  'setSomedayOpen', 'setLabelFilter', 'setNotesFilter', // device-local view state
  'updateSettings', // only theme / reduce motion while read-only (below)
  'replaceBoard', // the server snapshot arriving
  'retryWrites', // re-writes the read cache after a storage failure
  'showToast', 'dismissToast', 'pauseToast', 'resumeToast',
  '_failWrites', '_setHosted',
]);
const DENIED: Record<string, unknown> = { addCardsFromGrammar: [], archiveExpired: 0, addAttachment: false, importBoard: false, importText: 0, exportJSON: '' };
const APPEARANCE: (keyof BoardSettings)[] = ['theme', 'background', 'reduceMotion', 'studioTheme', 'studioPattern'];

{
  const table = actions as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const key of Object.keys(table)) {
    const fn = table[key];
    if (typeof fn !== 'function') continue;
    if (key === 'updateSettings') {
      table[key] = (partial: unknown) => {
        if (!state.readOnly) return fn(partial);
        const p = partial as Partial<BoardSettings>;
        const allowed = Object.fromEntries(APPEARANCE.filter((k) => p?.[k] !== undefined).map((k) => [k, p[k]]));
        if (Object.keys(allowed).length) fn(allowed);
      };
    } else if (!VIEW_ACTIONS.has(key)) {
      table[key] = (...args: unknown[]) => (state.readOnly ? DENIED[key] : fn(...args));
    }
  }
}

export function isReadOnly(): boolean {
  return state.readOnly;
}

/** Enter or leave read-only: `<html data-readonly>` drives the CSS; undo and toasts from before are dropped. */
export function setReadOnly(on: boolean): void {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (root?.dataset) {
    if (on) root.dataset.readonly = 'true';
    else delete root.dataset.readonly;
  }
  if (state.readOnly === on) return;
  state.readOnly = on;
  if (on) {
    sealUndo();
    undoStack.length = 0;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    currentToast = null;
  }
  notify('readonly');
}

/** Just the read-only flag: re-renders only when it flips (memoised card faces use this). */
export function useReadOnly(): boolean {
  const [, force] = useState(0);
  useEffect(() => {
    let last = state.readOnly;
    const check = () => {
      if (state.readOnly === last) return;
      last = state.readOnly;
      force((v) => v + 1);
    };
    listeners.add(check);
    return () => {
      listeners.delete(check);
    };
  }, []);
  return state.readOnly;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/** Just the board labels: re-renders only when they change (card faces use this, not useStore). */
export function useLabels(): Label[] {
  const [, force] = useState(0);
  useEffect(() => {
    let last = state.board.labels;
    const check = () => {
      if (state.board.labels === last) return;
      last = state.board.labels;
      force((v) => v + 1);
    };
    listeners.add(check);
    return () => {
      listeners.delete(check);
    };
  }, []);
  return state.board.labels;
}

export function useStore() {
  const [, force] = useState(0);
  useEffect(() => {
    const rerender = () => force((v) => v + 1);
    listeners.add(rerender);
    void actions.init();
    return () => {
      listeners.delete(rerender);
    };
  }, []);

  return {
    ready: state.ready,
    cards: state.board.cards,
    labels: state.board.labels,
    labelFilter: state.labelFilter,
    notesFilter: state.notesFilter,
    somedayOpen: state.somedayOpen,
    settings: state.board.settings,
    storageFailed: state.storageFailed,
    corrupt: state.corrupt,
    toast: currentToast,
    undoDepth: undoStack.length,
    readOnly: state.readOnly,
    ...actions,
  };
}

export type { Board, BoardSettings, Card, CardStatus, Label };
