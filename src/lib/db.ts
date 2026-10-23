// Board persistence for the Personal Kanban app.
//
// A read cache for offline display plus the outbox; signed in, the server board is
// the truth and replaces what is cached here. Three object stores in the "kept"
// database; v4 deletes the old list-model stores (lists, items, …) and a legacy outbox.
//
//    - "cards"    keyPath "id"        — one row per card.
//    - "settings"                       — rows { key: "board", settings }, { key: "labels", labels }
//                                          (synced board labels) and { key: "labelFilter", ids } (device-only).
//    - "outbox"   autoInc "oid"        — append-only action log (versioned sync, §13.3).
//    - "uploads"  keyPath "id"        — attachment files waiting to upload (v5; bytes as ArrayBuffer).
//
// The outbox holds the §13.3 actions not yet pushed; src/lib/sync.ts drains it.
// The DB layer is React-free so reducer/store tests can drive it under
// fake-indexeddb.

import { storageScope } from './account';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import type { Board, BoardSettings, Card, Label } from './types';
import { normalizeCard, withBuiltins } from './labels';
import type { SyncAction } from '../../shared/merge.mjs';

export interface BoardRow {
  key: 'board';
  settings: BoardSettings;
}
interface LabelsRow {
  key: 'labels';
  labels: Label[];
}
interface FilterRow {
  key: 'labelFilter';
  ids: string[];
}

export interface OutboxRow {
  oid?: number; // auto-incremented on put into the 'outbox' store
  ts: string;
  type: string;
  payloadJson: string;
}

/** A file queued for upload; bytes are an ArrayBuffer (Safari has trouble storing Blobs). */
export interface UploadRow {
  id: string;
  cardId: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
  width?: number;
  height?: number;
  bytes: ArrayBuffer;
  thumb?: ArrayBuffer;
  thumbType?: string;
  error?: string; // a final failure (too large): never retried on its own
}

interface KeptSchema extends DBSchema {
  uploads: { key: string; value: UploadRow };
  cards: { key: string; value: Card; indexes: {} };
  settings: { key: string; value: BoardRow | LabelsRow | FilterRow };
  outbox: { key: number; autoIncrement: true; value: OutboxRow };
}

// Version 3 creates the kanban stores. Earlier versions (list model) already
// exist on real devices; onupgradeneeded here only ADDS stores, it never drops
// the old ones, so pre-existing list rows survive (orphaned, per design).
// Version 4 drops the old list-model stores and any outbox that is not the current
// shape (legacy rows made every sync throw), keeping only cards, settings and outbox.
// Version 5 adds the "uploads" queue.
const DB_VERSION = 5;
const STORES = ['cards', 'settings', 'outbox', 'uploads'];
const ACTION_TYPES = new Set(['card.put', 'card.set', 'card.delete', 'item.put', 'item.set', 'item.delete', 'items.order', 'att.put', 'att.delete', 'label.put', 'label.delete']);

let dbPromise: Promise<IDBPDatabase<KeptSchema>> | null = null;

export function db(): Promise<IDBPDatabase<KeptSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<KeptSchema>(storageScope() ? `kept:${storageScope()}` : 'kept', DB_VERSION, {
      upgrade(d, _old, _new, tx) {
        const raw = d as unknown as IDBPDatabase;
        for (const name of Array.from(raw.objectStoreNames)) if (!STORES.includes(name)) raw.deleteObjectStore(name);
        if (d.objectStoreNames.contains('outbox') && tx.objectStore('outbox').keyPath !== 'oid') {
          warnOnce('[sync] dropped a legacy outbox (old format rows are never sent)');
          d.deleteObjectStore('outbox');
        }
        if (!d.objectStoreNames.contains('cards')) d.createObjectStore('cards', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings');
        if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'oid', autoIncrement: true });
        if (!d.objectStoreNames.contains('uploads')) d.createObjectStore('uploads', { keyPath: 'id' });
      },
        });
     }
  return dbPromise;
}

// A tiny UUID (crypto when available, fallback otherwise).
export function uid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export interface LoadedBoard extends Board {
  corrupt: number; // cards that failed to read (a "Corrupt record" hint follows)
}

/**
 * Read every card + the settings row. A corrupt record is skipped and counted
 * (the store raises a "1 card couldn't be read" hint when corrupt > 0).
 */
export async function loadBoard(defaults: BoardSettings): Promise<LoadedBoard> {
  const d = await db();
  const [cards, settingsRow, labelsRow] = await Promise.all([d.getAll('cards'), d.get('settings', 'board'), d.get('settings', 'labels')]);
  const clean: Card[] = [];
  let corrupt = 0;
  for (const c of cards as Card[]) {
    if (c && typeof c.id === 'string' && Array.isArray(c.items)) clean.push(normalizeCard(c));
    else corrupt++;
    }
  if (corrupt > 0) console.warn(`${corrupt} card${corrupt === 1 ? '' : 's'} couldn't be read`); // §15.1; the UI banner reads `corrupt`
  clean.sort((a, b) => a.order - b.order);
  return {
    schemaVersion: 1,
    cards: clean,
    labels: withBuiltins(labelsRow && 'labels' in labelsRow ? labelsRow.labels : []),
    settings: settingsRow && 'settings' in settingsRow ? settingsRow.settings : defaults,
    corrupt,
   };
}

export async function upsertCard(card: Card): Promise<void> {
  await (await db()).put('cards', card);
}

export async function removeCard(id: string): Promise<void> {
  await (await db()).delete('cards', id);
}

export async function loadSettings(fallback: BoardSettings): Promise<BoardSettings> {
  const row = await (await db()).get('settings', 'board');
  return row && 'settings' in row ? row.settings : fallback;
}

export async function saveLabels(labels: Label[]): Promise<void> {
  await (await db()).put('settings', { key: 'labels', labels } satisfies LabelsRow, 'labels');
}

/** The label filter is per device: stored here, never synced. */
export async function loadLabelFilter(): Promise<string[]> {
  const row = await (await db()).get('settings', 'labelFilter');
  return row && 'ids' in row && Array.isArray(row.ids) ? row.ids.filter((x) => typeof x === 'string') : [];
}

export async function saveLabelFilter(ids: string[]): Promise<void> {
  await (await db()).put('settings', { key: 'labelFilter', ids } satisfies FilterRow, 'labelFilter');
}

export async function saveSettings(settings: BoardSettings): Promise<void> {
  await (await db()).put(
    'settings',
    { key: 'board', settings } satisfies BoardRow,
    'board',
   );
}

// --- sync outbox (§13.3) -------------------------------------------------------

/** Append actions to the outbox; the sync engine pushes and then clears them. */
export async function enqueueActions(actions: SyncAction[]): Promise<void> {
  if (!actions.length) return;
  const tx = (await db()).transaction('outbox', 'readwrite');
  for (const a of actions) void tx.store.put({ ts: a.ts, type: a.type, payloadJson: JSON.stringify(a) });
  await tx.done;
}

const warned = new Set<string>();
/** One console line per distinct message per page load. */
function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(msg);
}

export function isCurrentAction(a: unknown): a is SyncAction {
  const x = a as SyncAction | null;
  return !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.ts === 'string' && ACTION_TYPES.has(x.type) && !!x.payload && typeof x.payload === 'object';
}

/** Valid current-format actions only; anything else is deleted with one console.warn, never thrown. */
export async function readOutbox(): Promise<{ oid: number; action: SyncAction }[]> {
  const d = await db();
  const rows = (await d.getAll('outbox')) as unknown[];
  const ok: { oid: number; action: SyncAction }[] = [];
  const bad: IDBValidKey[] = [];
  for (const r of rows as (Partial<OutboxRow> & Record<string, unknown>)[]) {
    let action: unknown = null;
    try {
      action = typeof r.payloadJson === 'string' ? JSON.parse(r.payloadJson) : null;
    } catch {
      /* unreadable */
    }
    if (typeof r.oid === 'number' && isCurrentAction(action)) ok.push({ oid: r.oid, action });
    else if (typeof r.oid === 'number') bad.push(r.oid);
  }
  if (bad.length) {
    warnOnce(`[sync] dropped ${bad.length} outbox row(s) that are not current-format actions`);
    try {
      const tx = d.transaction('outbox', 'readwrite');
      for (const k of bad) void tx.store.delete(k as number);
      await tx.done;
    } catch {
      /* best effort; they are skipped either way */
    }
  }
  return ok;
}

export async function clearOutbox(oids: number[]): Promise<void> {
  if (!oids.length) return;
  const tx = (await db()).transaction('outbox', 'readwrite');
  for (const oid of oids) void tx.store.delete(oid);
  await tx.done;
}

/** Everything this device has not sent (outbox + queued uploads): a view link never sends it, nor does a later sign-in. */
export async function discardUnsent(): Promise<void> {
  const tx = (await db()).transaction(['outbox', 'uploads'], 'readwrite');
  void tx.objectStore('outbox').clear();
  void tx.objectStore('uploads').clear();
  await tx.done;
}

export async function saveUpload(row: UploadRow): Promise<void> {
  await (await db()).put('uploads', row);
}

export async function loadUploads(): Promise<UploadRow[]> {
  return (await db()).getAll('uploads');
}

export async function deleteUpload(id: string): Promise<void> {
  await (await db()).delete('uploads', id);
}

export async function outboxCount(): Promise<number> {
  return (await db()).count('outbox');
}
