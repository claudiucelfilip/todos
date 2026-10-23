import { displayTitle } from '../../shared/notes.mjs';
// §14.3 — window.kanban. Synchronous, validates input, throws descriptive
// errors, goes through the same store actions as the UI (derivation, limits,
// undo and animation apply identically). Also the validator's set-up surface.

import type { AttachmentView, Card, CardStatus, KanbanAPI, KanbanCardInput, KanbanCardView, KanbanListArgs, Label, RemindEvery } from './types';
import { REMIND_EVERY } from '../../shared/repeat.mjs';
import { uploads } from './uploads';

import { fileUrl } from './files';
import { actions, state } from '../hooks/useStore';
import { composeCard } from './parse';
import { searchMatches } from './search';
import { columnCards } from './reducer';
import { cleanLabelName, findLabel, isHexColor } from './labels';

const STATUSES: CardStatus[] = ['todo', 'doing', 'done'];

function cards(): Card[] {
  return state.board.cards;
}

function findCard(idOrTitle: string): Card | undefined {
  const q = idOrTitle.trim().toLowerCase();
  return cards().find((c) => c.id === idOrTitle) ?? cards().find((c) => displayTitle(c).trim().toLowerCase() === q);
}

function view(c: Card): KanbanCardView {
  const { done: finished, ...copy } = JSON.parse(JSON.stringify(c)) as Card;
  return { ...copy, ...(c.kind === 'note' ? { finished: !!finished } : {}), done: c.items.filter((i) => i.done).map((i) => i.text), remaining: c.items.filter((i) => !i.done).map((i) => i.text) };
}

function requireCard(idOrTitle: string): Card {
  if (typeof idOrTitle !== 'string' || !idOrTitle.trim()) throw new Error('A card id or title is required');
  const c = findCard(idOrTitle);
  if (c) return c;
  const hint = closestTitle(idOrTitle);
  throw new Error(`No card matches ‘${idOrTitle}’` + (hint ? `; closest: ‘${hint}’` : ''));
}

function requireStatus(s: unknown): CardStatus {
  if (!STATUSES.includes(s as CardStatus)) throw new Error(`Status must be one of todo, doing, done (got ‘${String(s)}’)`);
  return s as CardStatus;
}

/** Label selectors: ids or case-insensitive names; unknown ones throw with the known names. */
function resolveLabels(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('Labels must be an array of label ids or names');
  return input.map((raw) => {
    const l = findLabel(state.board.labels, String(raw ?? ''));
    if (!l) throw new Error(`No label matches ‘${String(raw)}’; labels: ${state.board.labels.map((x) => x.name).join(', ')}`);
    return l.id;
  });
}

function lines(input: string | string[]): string[] {
  const list = Array.isArray(input) ? input : String(input ?? '').split('\n');
  return list.map((s) => String(s)).filter((s) => s.trim() !== '');
}

/** Item selectors: "*" = all, else an item id or the first unchecked/checked exact text. */
function selectItems(card: Card, items: string | string[], wantDone: boolean): string[] {
  const sel = Array.isArray(items) ? items : [items];
  if (sel.some((s) => String(s).trim() === '*')) return card.items.filter((i) => i.done !== wantDone).map((i) => i.id);
  const out: string[] = [];
  for (const raw of sel) {
    const s = String(raw).trim();
    const byId = card.items.find((i) => i.id === s);
    const hit = byId ?? card.items.find((i) => i.done !== wantDone && i.text === s) ?? card.items.find((i) => i.text === s);
    if (!hit) throw new Error(`No item matches ‘${s}’ on ‘${card.title}’`);
    out.push(hit.id);
  }
  return out;
}

function closestTitle(q: string): string | undefined {
  const target = q.trim().toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const c of cards()) {
    const lower = c.title.toLowerCase();
    const score = lower.includes(target) || target.includes(lower) ? 0 : distance(target, lower);
    if (score < bestScore) {
      bestScore = score;
      best = c.title;
    }
  }
  return best;
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function installKanbanAPI(): void {
  const api: KanbanAPI = {
    version: 1,

    list(args?: KanbanListArgs): KanbanCardView[] {
      // Display order: To do, Doing, Done as the board shows them; archived last.
      const statuses: CardStatus[] = args?.status ? [requireStatus(args.status)] : STATUSES;
      let out: Card[] = statuses.flatMap((s) => columnCards(cards(), s));
      if (args?.includeArchived) out = out.concat(cards().filter((c) => c.archivedAt && (!args.status || c.status === args.status)));
      if (args?.query) out = out.filter((c) => searchMatches(c, args.query!, state.board.labels));
      if (args?.label !== undefined) {
        const [id] = resolveLabels([args.label]);
        out = out.filter((c) => c.labels.includes(id));
      }
      return out.map(view);
    },

    get(idOrTitle: string): KanbanCardView | null {
      const c = findCard(String(idOrTitle ?? ''));
      return c ? view(c) : null;
    },

    addCard(input: KanbanCardInput): KanbanCardView {
      let card: Card | undefined;
      if (typeof input === 'string') {
        if (!input.trim()) throw new Error('Card text is empty');
        card = actions.addCardFromText(input, 'todo', 'grammar');
      } else {
        if (!input || typeof input.title !== 'string' || !input.title.trim()) throw new Error('A card needs a title');
        const status = input.status === undefined ? 'todo' : requireStatus(input.status);
        const labelIds = input.labels === undefined ? [] : resolveLabels(input.labels);
        const text = [input.title, ...(input.notes ? [input.notes] : []), ...lines(input.items ?? []).map((i) => `- ${i}`)].join('\n');
        card = actions.addCardFromText(text, status, 'grammar', labelIds);
      }
      if (!card) throw new Error('Card was not created');
      return view(card);
    },

    addItems(idOrTitle: string, input: string | string[]): KanbanCardView {
      const card = requireCard(idOrTitle);
      const ls = lines(input);
      if (!ls.length) throw new Error('No items to add');
      actions.addItemsBatch(card.id, ls, { undo: true });
      return view(requireCard(card.id));
    },

    check(idOrTitle: string, items: string | string[]): KanbanCardView {
      const card = requireCard(idOrTitle);
      actions.setItemsDone(card.id, selectItems(card, items, true), true);
      return view(requireCard(card.id));
    },

    uncheck(idOrTitle: string, items: string | string[]): KanbanCardView {
      const card = requireCard(idOrTitle);
      actions.setItemsDone(card.id, selectItems(card, items, false), false);
      return view(requireCard(card.id));
    },

    setStatus(idOrTitle: string, status: CardStatus): KanbanCardView {
      const card = requireCard(idOrTitle);
      actions.moveCardAction(card.id, requireStatus(status));
      return view(requireCard(card.id));
    },

    someday(idOrTitle: string, on: boolean): KanbanCardView {
      const card = requireCard(idOrTitle);
      if (typeof on !== 'boolean') throw new Error(`Someday takes true or false (got ‘${String(on)}’)`);
      actions.setSomeday(card.id, on);
      return view(requireCard(card.id));
    },

    async attach(idOrTitle: string, file: Blob, name?: string): Promise<AttachmentView> {
      const card = requireCard(idOrTitle);
      if (typeof Blob === 'undefined' || !(file instanceof Blob)) throw new Error('attach needs a Blob or File');
      const u = await uploads.add(card.id, file, name);
      const att = requireCard(card.id).attachments?.find((a) => a.id === u.id);
      if (att) return { ...att, url: fileUrl(att.id) };
      if (u.state === 'failed' && u.error === 'file_too_large') throw new Error(`‘${u.name}’ is too large (25 MB at most)`);
      return { id: u.id, name: u.name, type: u.type, size: u.size, createdAt: u.createdAt, url: fileUrl(u.id), pending: true };
    },

    attachments(idOrTitle: string): AttachmentView[] {
      return (requireCard(idOrTitle).attachments ?? []).map((a) => ({ ...a, url: fileUrl(a.id) }));
    },

    detach(idOrTitle: string, attachmentId: string): KanbanCardView {
      const card = requireCard(idOrTitle);
      if (!card.attachments?.some((a) => a.id === attachmentId)) throw new Error(`No attachment ‘${attachmentId}’ on ‘${card.title}’`);
      actions.removeAttachment(card.id, attachmentId);
      return view(requireCard(card.id));
    },

    remove(idOrTitle: string): { undo(): void } {
      const card = requireCard(idOrTitle);
      const snap = actions.deleteCardById(card.id);
      return { undo: () => { if (snap !== undefined) actions.undoSnap(snap); } };
    },

    labels(): Label[] {
      return structuredClone(state.board.labels);
    },

    addLabel(input: { name: string; color?: string }): Label {
      if (!input || typeof input.name !== 'string' || !cleanLabelName(input.name)) throw new Error('A label needs a name');
      if (input.color !== undefined && !isHexColor(input.color)) throw new Error(`Color must be #RRGGBB (got ‘${String(input.color)}’)`);
      const l = actions.createLabel(input.name, input.color);
      if (!l) throw new Error('Label was not created');
      return { id: l.id, name: l.name, color: l.color };
    },

    setLabels(idOrTitle: string, idsOrNames: string[]): KanbanCardView {
      const card = requireCard(idOrTitle);
      actions.setCardLabels(card.id, resolveLabels(idsOrNames));
      return view(requireCard(card.id));
    },

    remind(idOrTitle: string, isoOrNull: string | null, every?: RemindEvery | null): KanbanCardView {
      const card = requireCard(idOrTitle);
      if (isoOrNull !== null && (typeof isoOrNull !== 'string' || Number.isNaN(new Date(isoOrNull).getTime()))) {
        throw new Error(`A reminder needs an ISO date-time or null (got ‘${String(isoOrNull)}’)`);
      }
      if (every !== undefined && every !== null && !REMIND_EVERY.includes(every)) {
        throw new Error(`A repeat is one of ${REMIND_EVERY.join(', ')} or null (got ‘${String(every)}’)`);
      }
      actions.setReminder(card.id, isoOrNull);
      if (every !== undefined && isoOrNull !== null) actions.setRemindEvery(card.id, every);
      return view(requireCard(card.id));
    },

    exportText(idOrTitle?: string): string {
      if (idOrTitle) return composeCard(requireCard(idOrTitle));
      return cards().filter((c) => !c.archivedAt).map(composeCard).join('\n---\n');
    },

    exportJSON(): string {
      return actions.exportJSON();
    },

    importBoard(board: unknown, mode: 'replace' | 'merge' = 'replace'): boolean {
      const parsed = typeof board === 'string' ? JSON.parse(board) : board;
      return actions.importBoard(parsed, mode);
    },

    importText(text: string): number {
      return actions.importText(String(text ?? ''));
    },

    subscribe(fn) {
      const handler = (e: Event) => fn((e as CustomEvent).detail ?? { type: 'change' });
      window.addEventListener('kanban:change', handler);
      return () => window.removeEventListener('kanban:change', handler);
    },

    on(_event, fn) {
      return api.subscribe(fn);
    },

    undo() {
      actions.undo();
    },
  };

  window.kanban = api;
  window.dispatchEvent(new CustomEvent('kanban:install'));
}
