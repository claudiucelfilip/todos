// Personal Kanban — data model (§3).
//
// Notes share one model; workflow labels determine board placement.
//
// The old list model (TodoList/TodoItem) is retired. The IndexedDB name
// "kept" and the "kept.*" localStorage prefixes are PRESERVED so local data
// across devices survives; the old rows are simply orphaned (no migration).

export const SCHEMA_VERSION = 1 as const;

export type CardStatus = 'todo' | 'doing' | 'done';

export interface CardItem {
  id: string;
  text: string; // <=200 characters; on a ref row, the linked card's title when it was linked (shown if it is deleted)
  done: boolean; // on a ref row, mirrors the linked card (its done, or status 'done')
  ref?: string; // the row IS this card (a nested note / to do)
}

export type CardKind = 'note' | 'todo';
export type TitleBy = 'user' | 'auto' | 'ai';

/** Notes order, optional free sizing, and the latest resize anchor. */
export interface CardLayout {
  order: number;
  w?: 1 | 2;
  h?: 1 | 2;
  height?: number; // explicit resized height; absent sizes to content
  width?: number; // width in grid tracks, including partial tracks
  anchor?: { x: number; y: number }; // x in grid tracks, y in pixels
}

export interface AutomationRule {
  id: string;
  condition: 'complete' | 'partial' | 'incomplete' | 'child-doing';
  scope: 'workflow' | 'owner' | `label:${string}`;
  action: 'set-group' | 'add' | 'remove';
  target: string;
  enabled: boolean;
}

/** A board-level, user-defined label; cards reference it by id. */
export interface Label {
  id: string;
  name: string; // <=40, trimmed
  color: string; // #RRGGBB
  group?: string | null;
  flowStage?: { order: number; finished: boolean } | null;
  removeOnView?: boolean; // clear when the note is visible in its editor
  automations?: AutomationRule[]; // absent = built-in defaults; [] = no rules
  updatedAt?: string; // ISO; absent on a locally seeded built-in
}

export interface CardLink {
  title: string;
  url: string; // http(s)
}

/** Reference to the external record a card was captured from (wiki capture / Slack). */
export interface CardExt {
  key: string;
  slackTs?: string;
  slackChannel?: string;
  seenLinks?: string[]; // urls the server already delivered; a removed one is not re-added
}

export type RemindEvery = 'hour' | 'day' | 'weekday' | 'week' | 'month';

export interface Card {
  draft?: boolean; // unsaved editor card, never synced
  reopenStage?: string | null;
  workflowVersion?: 1; // labels own placement; status/kind mirror older API clients
  id: string; // uuid v4
  title: string; // <=200, trimmed, single line
  notes: string; // <=5000
  status: CardStatus; // compatibility mirror of the workflow label
  items: CardItem[]; // <=500
  order: number; // float; re-normalised within its column on write
  createdAt: string; // ISO
  updatedAt: string; // ISO
  completedAt: string | null; // ISO when the card is done
  archivedAt: string | null; // ISO when archived
  someday: boolean;
  repeat: boolean; // recurring marker
  labels: string[]; // label ids, ordered
  links?: CardLink[];
  ext?: CardExt;
  remindAt?: string | null; // ISO UTC; setting it clears remindedAt
  remindedAt?: string | null; // stamped by the server when the push went out
  remindEvery?: RemindEvery | null; // repeats on this cadence until the card is done (shared/repeat.mjs)
  notify?: boolean; // false keeps the scheduled time visible without a Todos push
  attachments?: Attachment[]; // absent when none; merged per attachment id (att.put / att.delete)
  kind?: CardKind; // compatibility mirror: note when there is no workflow label
  titleBy?: TitleBy | null; // who wrote `title`: the user, the page fetch, the assistant; absent = nobody
  done?: boolean; // legacy notes only; migrated cards use the Done label
  layout?: CardLayout; // the Notes grid place; absent = after the placed ones, newest first
  suggestedLabel?: string | null; // a label id the assistant proposes, until accepted or dismissed
  via?: 'siri' | 'share' | null; // captured from Siri or the share sheet (the footer says so)
}

/** A file on the server (/kanban/files/<id>); `thumb` = a small preview exists at …/thumb. */
export interface Attachment {
  id: string;
  name: string;
  type: string; // mime
  size: number; // bytes
  createdAt: string;
  width?: number;
  height?: number;
  thumb?: boolean;
}

export type ThemeMode = 'system' | 'light' | 'dark' | 'sky';
export type MotionMode = 'system' | 'on' | 'off';

export interface BoardSettings {
  studioTheme?: string;
  studioPattern?: string;
  background?: import('./backgrounds').BackgroundName;
  reduceMotion: MotionMode; // 'system' follows the OS media query
  theme: ThemeMode;
  archiveAfterDays: number; // 7 | 14 | 30 | 0 (never)
  lastBackupAt: string | null;
  /** v5 §4: the assistant titles long notes and suggests labels (account preference, on by default). */
  suggest?: boolean;
}

export interface Board {
  schemaVersion: typeof SCHEMA_VERSION;
  cards: Card[];
  labels: Label[];
  settings: BoardSettings;
}

export const DEFAULT_SETTINGS: BoardSettings = {
  reduceMotion: 'system',
  theme: 'system',
  archiveAfterDays: 14,
  lastBackupAt: null,
};

// ----- window.kanban public surface (§14.3) ---------------------------------

export interface KanbanListArgs {
  status?: CardStatus;
  label?: string; // id or name, case-insensitive
  query?: string;
  includeArchived?: boolean;
}

/** A detached copy of a card plus done[]/remaining[] item texts for convenience. */
export interface AttachmentView extends Attachment {
  url: string;
  pending?: boolean;
}

export interface KanbanCardView extends Omit<Card, 'done'> {
  /** A note's own done flag (the card's `done`), renamed: `done` here lists the checked item texts. */
  finished?: boolean;
  done: string[];
  remaining: string[];
}

export type KanbanCardInput =
  | string
  | { title: string; notes?: string; items?: string[]; status?: CardStatus; labels?: string[] };

export interface KanbanAPI {
  version: 1;
  list(args?: KanbanListArgs): KanbanCardView[];
  get(idOrTitle: string): KanbanCardView | null;
  addCard(input: KanbanCardInput): KanbanCardView;
  addItems(idOrTitle: string, lines: string | string[]): KanbanCardView;
  check(idOrTitle: string, items: string | string[]): KanbanCardView;
  uncheck(idOrTitle: string, items: string | string[]): KanbanCardView;
  setStatus(idOrTitle: string, status: CardStatus): KanbanCardView;
  someday(idOrTitle: string, on: boolean): KanbanCardView;
  /** Upload and attach; resolves once stored (or with pending: true when queued offline). */
  attach(idOrTitle: string, file: Blob, name?: string): Promise<AttachmentView>;
  attachments(idOrTitle: string): AttachmentView[];
  detach(idOrTitle: string, attachmentId: string): KanbanCardView;
  remove(idOrTitle: string): { undo(): void };
  labels(): Label[];
  addLabel(input: { name: string; color?: string }): Label;
  setLabels(idOrTitle: string, idsOrNames: string[]): KanbanCardView;
  /** `every` (optional) sets or clears (null) the repeat; omitted keeps it. */
  remind(idOrTitle: string, isoOrNull: string | null, every?: RemindEvery | null): KanbanCardView;
  exportText(idOrTitle?: string): string;
  exportJSON(): string;
  importBoard(board: unknown, mode?: 'replace' | 'merge'): boolean;
  importText(text: string): number;
  subscribe(fn: (detail: { type: string; card?: Card }) => void): () => void;
  on(event: 'kanban:change', fn: (detail: { type: string; card?: Card }) => void): () => void;
  undo(): void;
}

declare global {
  interface Window {
    kanban?: KanbanAPI;
  }
}
