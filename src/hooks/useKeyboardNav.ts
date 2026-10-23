import { boardColumns } from '../lib/board-columns';
import { useEffect, useRef } from 'react';
import type { CardStatus } from '../lib/types';
import { actions, state, isReadOnly } from './useStore';

// §7.12 — desktop keyboard navigation with no field focused.
const COLS: CardStatus[] = ['todo', 'doing', 'done'];

function isField(el: Element | null): boolean {
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    !!(el as HTMLElement).isContentEditable
  );
}

// Keys on these belong to the control (Space presses a button, arrows move a radio group).
const CONTROL =
  'button, a[href], input, textarea, select, label, [contenteditable], [role=radio], [role=checkbox], [role=menuitem], [role=option]';
const OVERLAY = '[role=dialog], .label-pop, .dt-menu, .dialog-backdrop, .dt-sheet-root, .dt-panel';

/** Board shortcuts only run on the bare board: not from a control, and not while an overlay is open or focused. */
export function boardKeyBlocked(
  target: Element | null,
  active: Element | null,
  overlayOpen: boolean,
): boolean {
  if (overlayOpen) return true;
  for (const el of [target, active]) {
    if (!el || typeof el.closest !== 'function') continue;
    if (isField(el) || el.closest(CONTROL) || el.closest(OVERLAY)) return true;
  }
  return false;
}

/** Text fields keep their own undo; a select has none, so the board's undo still applies there. */
const ownsUndo = (el: Element | null) => isField(el) && el!.tagName !== 'SELECT';

/** The key came from a field — judged by its target, not by activeElement, which an
 *  inline editor may already have unmounted by the time this listener runs (D3). */
function fromField(e: KeyboardEvent): boolean {
  return isField(e.target as Element | null) || isField(document.activeElement);
}

export function useKeyboardNav(opts: {
  enabled: boolean;
  selectedId: string | null;
  setSelectedId(id: string | null): void;
  openCardId: string | null;
  openCard(id: string, restore?: boolean): void;
  closeDetail(): void;
  focusSearch(): void;
  showShortcuts(): void;
  dialogOpen: boolean;
}): void {
  const ref = useRef(opts);
  ref.current = opts;
  // Selection remembered per column.
  const memo = useRef<Record<string, string | null>>({ todo: null, doing: null, done: null });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const o = ref.current;
      const meta = e.metaKey || e.ctrlKey;
      const ro = isReadOnly(); // a view-only link: moving around and opening cards only

      // Cmd+Z undo works everywhere except inside text fields (they own their undo).
      if (
        meta &&
        e.key.toLowerCase() === 'z' &&
        !e.shiftKey &&
        !ownsUndo(e.target as Element | null) &&
        !ownsUndo(document.activeElement) &&
        !ro
      ) {
        e.preventDefault();
        actions.undo();
        return;
      }
      if (!o.enabled) return;
      if (e.key === 'Escape') return; // App's one Esc handler (§11.24.1)
      const overlayOpen =
        !!o.openCardId || o.dialogOpen || !!document.querySelector('.label-pop:not([data-closing]), .dt-menu:not([data-closing])');
      if (
        fromField(e) ||
        boardKeyBlocked(e.target as Element | null, document.activeElement, overlayOpen)
      )
        return;
      if ((e.key === '/' || (meta && e.key.toLowerCase() === 'k')) && !e.altKey) {
        e.preventDefault();
        o.focusSearch();
        return;
      }
      if (e.key === '?' && !ro) {
        e.preventDefault();
        o.showShortcuts();
        return;
      }
      if (e.key.toLowerCase() === 'n' && !meta && !ro) {
        e.preventDefault();
        (document.querySelector('[data-testid=composer-bar]') as HTMLElement | null)?.click();
        return;
      }

      const columns = boardColumns(state.board.labels, state.labelFilter).map((c) => c.status);
      const focusedColumn = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.column')?.dataset.status;
      const sel = o.selectedId ? columns.flatMap((c) => actions.visibleColumn(c)).find((c) => c.id === o.selectedId) : undefined;
      const col = focusedColumn && columns.includes(focusedColumn) ? focusedColumn : columns.find((c) => sel && actions.visibleColumn(c).some((x) => x.id === sel.id)) ?? columns[0];
      if (!col) return;
      const cards = actions.navColumn(col); // parked cards are skipped while Someday is collapsed
      const idx = sel ? cards.findIndex((c) => c.id === sel.id) : -1;

      const select = (id: string | null) => {
        o.setSelectedId(id);
        if (id) {
          const card = actions.visibleColumn(col).find((c) => c.id === id) ?? null;
          if (card) memo.current[col] = id;
          const node = document.querySelector<HTMLElement>(`.column[data-status="${col}"] [data-testid="card-${id}"]`);
          node?.scrollIntoView({ block: 'nearest' });
          node?.focus({ preventScroll: true });
        }
      };

      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          e.preventDefault();
          if (meta) {
            if (sel && !ro) actions.nudge(sel.id, e.key === 'ArrowUp' ? -1 : 1);
            return;
          }
          if (!cards.length) return;
          const next =
            idx < 0
              ? 0
              : Math.min(cards.length - 1, Math.max(0, idx + (e.key === 'ArrowDown' ? 1 : -1)));
          select(cards[next].id);
          return;
        }
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault();
          const ci = columns.indexOf(col);
          const target = columns[ci + (e.key === 'ArrowRight' ? 1 : -1)];
          if (!target) return;
          const tcards = actions.navColumn(target);
          if (!tcards.length) return;
          const remembered = memo.current[target];
          const pick =
            remembered && tcards.some((c) => c.id === remembered)
              ? remembered
              : tcards[Math.min(Math.max(idx, 0), tcards.length - 1)].id;
          o.setSelectedId(pick);
          memo.current[target] = pick;
          const node = document.querySelector<HTMLElement>(`.column[data-status="${target}"] [data-testid="card-${pick}"]`);
          node?.scrollIntoView({ block: 'nearest' });
          node?.focus({ preventScroll: true });
          return;
        }
        case 'Enter':
          if (sel) {
            e.preventDefault();
            o.openCard(sel.id, true);
          }
          return;
      }
      if (ro) return; // every key below changes the board
      switch (e.key) {
        case ' ':
          if (sel) {
            e.preventDefault();
            actions.toggleCircle(sel.id);
          }
          return;
        case '1':
        case '2':
        case '3':
          if (sel) {
            e.preventDefault();
            actions.moveCardAction(sel.id, COLS[Number(e.key) - 1]);
          }
          return;
        case 's':
        case 'S':
          if (sel && !meta) {
            e.preventDefault();
            actions.placeCard(sel.id, 'note'); // v5: S (was Someday) makes it a note
          }
          return;
        case 'r':
        case 'R':
          if (sel && !meta) {
            e.preventDefault();
            actions.toggleRepeat(sel.id);
          }
          return;
        case 'Backspace':
          if (sel && meta) {
            e.preventDefault();
            actions.deleteCardById(sel.id);
            o.setSelectedId(null);
          }
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
