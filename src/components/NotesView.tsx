import { checklistDropTarget, isChecklistDropCenter, markChecklistDrop } from '../lib/card-drop';
import { MarkdownPreview } from './MarkdownBody';
import { gridOrder, masonryLayout, fillMasonryGaps, snappedWidth, type MasonryRect } from '../lib/notes-layout';
export { gridOrder } from '../lib/notes-layout';
// All unarchived notes share a content-sized grid; dragging changes their order.
import { createPortal } from 'react-dom';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Card, CardItem, Label } from '../lib/types';
import { actions, state, useLabels, useReadOnly, useStore } from '../hooks/useStore';
import { cardLabels, passesNotesFilter } from '../lib/labels';
import { LabelPill, SuggestedPill } from './Labels';
import { searchMatches } from '../lib/search';
import { bodyLinks, displayTitle, firstImage, hostOf, isCardDone, parentsOf, stripMd } from '../../shared/notes.mjs';
import { thumbUrl } from '../lib/files';
import { useSwipeRow } from '../hooks/useSwipeRow';
import { useTouchUI } from '../hooks/useLayout';
import { swipeCopy } from '../lib/copy';
import { markSlidOut } from '../lib/slid';
import Ring from './Ring';
import CardContextMenu from './CardContextMenu';
import { useDropdownPresence } from '../hooks/useDropdownPresence';
import { FilterEmpty } from './Labels';
import { useListFlip } from '../lib/flip';
import { edgeScroll } from '../lib/input';

interface Props {
  query: string;
  openCardId: string | null;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onOpenCard(id: string): void;
  phone: boolean;
  panel?: 'closed' | 'open';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DRAG_PX = 6;

type Size = { w: 1 | 2; h: 1 | 2 };

const positionStyle = (rect?: MasonryRect): React.CSSProperties => rect ? { position: 'absolute', left: rect.left, top: rect.top, width: rect.width } : {};

/** Completion does not remove a note from the grid. */
export function inGrid(c: Card): boolean {
  return !c.archivedAt && !c.draft;
}

/** Content estimate used before the actual card is measured. */
export function sizeOf(c: Card): Size {
  const long = stripMd(c.notes).length > 90 || c.notes.split('\n').length > 2;
  return { w: (c.layout?.width ?? c.layout?.w ?? 1) > 1 ? 2 : 1, h: c.items.length > 0 || long ? 2 : 1 };
}

/** Unlabelled notes: where Siri, the share sheet and the composer drop things (v5 §6). */
export const inInbox = (c: Card) => c.kind === 'note' && !c.archivedAt && !(c.labels ?? []).length;

/** "2h", "Mon", "28 Sep": the grid footer date. */
export function shortDate(iso: string, now = new Date()): string {
  const t = new Date(iso);
  const ms = now.getTime() - t.getTime();
  if (ms < 60 * 60000) return `${Math.max(1, Math.round(ms / 60000))}m`;
  if (ms < 24 * 3600000) return `${Math.round(ms / 3600000)}h`;
  if (ms < 6 * 86400000) return t.toLocaleDateString('en-GB', { weekday: 'short' });
  return `${t.getDate()} ${MONTHS[t.getMonth()]}`;
}

export default function NotesView({ query, openCardId, selectedId, onSelect, onOpenCard, phone }: Props) {
  const store = useStore();
  const readOnly = store.readOnly;
  // The panel floats over the grid, so opening a card never reflows it.
  const cols = phone ? 1 : 4;
  const q = query.trim();
  const all = useMemo(
    () => gridOrder(store.cards.filter((c) => inGrid(c) && passesNotesFilter(c, store.notesFilter, store.labels))),
    [store.cards, store.notesFilter, store.labels],
  );
  const shown = q ? all.filter((c) => searchMatches(c, query, store.labels)) : all;

  // ---- drag to reorder -----------------------------------------------------------------------
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(0);
  useLayoutEffect(() => {
    const root = gridRef.current;
    if (!root) return;
    const observer = new ResizeObserver(() => setGridWidth(Math.floor(root.getBoundingClientRect().width)));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  const [heights, setHeights] = useState<Record<string, { natural: number; minimum: number }>>({});
  useLayoutEffect(() => {
    const root = gridRef.current;
    if (!root) return;
    const observer = new ResizeObserver((entries) => {
      setHeights((previous) => {
        const next = { ...previous };
        let changed = false;
        const cards = new Set(entries.map(entry => (entry.target as HTMLElement).closest<HTMLElement>('[data-grid-id]')).filter((el): el is HTMLElement => !!el));
        for (const el of cards) {
          const id = el.dataset.gridId;
          if (el.classList.contains('grid-slot')) continue;
          if (!root.contains(el)) continue;
          const main = el.querySelector<HTMLElement>('.note-main');
          const footer = el.querySelector<HTMLElement>('.note-foot');
          let naturalHeight = el.getBoundingClientRect().height;
          let minimum = 84;
          if (!phone && main && footer) {
            const face = el.matches('.note-card') ? el : el.querySelector<HTMLElement>('.note-card')!;
            const style = getComputedStyle(face);
            const children = Array.from(main.children);
            const first = main.firstElementChild as HTMLElement | null;
            const leadHeight = first?.matches('.note-title') ? first.getBoundingClientRect().height : first ? parseFloat(getComputedStyle(first).lineHeight) || 24 : 0;
            const chrome = footer.getBoundingClientRect().height + (parseFloat(getComputedStyle(footer).marginTop) || 0) + (parseFloat(style.rowGap) || 0) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
            minimum = Math.ceil(Math.max(84, chrome + leadHeight));
            naturalHeight = chrome + children.reduce((sum, child) => sum + child.getBoundingClientRect().height, 0) + Math.max(0, children.length - 1) * (parseFloat(getComputedStyle(main).rowGap) || 0);
          }
          const height = Math.ceil(Math.max(84, naturalHeight)) + (phone ? 12 : 20);
          if (id && (next[id]?.natural !== height || next[id]?.minimum !== minimum)) { next[id] = { natural: height, minimum }; changed = true; }
        }
        return changed ? next : previous;
      });
    });
    for (const child of Array.from(root.children)) {
      if (!(child as HTMLElement).dataset.gridId) continue;
      observer.observe(child);
      for (const part of Array.from(child.querySelectorAll('.note-main > :first-child,.note-foot'))) observer.observe(part);
    }
    return () => observer.disconnect();
  }, [shown, phone]);
  const [drag, setDrag] = useState<{ blocked?: boolean; parentId?: string; id: string; order: string[]; x: number; y: number; dx: number; dy: number; w: number; h: number } | null>(null);
  const press = useRef<{ id: string; x: number; y: number; rect: DOMRect; pointer: number } | null>(null);
  const order = shown.map((c) => c.id);
  const byId = useMemo(() => new Map(shown.map((c) => [c.id, c])), [shown]);
  const [resize, setResize] = useState<{ id: string; width: number; height: number; left: number; top: number } | null>(null);
  const sizes = (card: Card): Size => resize?.id === card.id ? { ...sizeOf(card), w: resize.width > (gridWidth - 60) / cols + 1 ? 2 : 1 } : sizeOf(card);
  const track = (gridWidth + 20) / cols;
  const anchored = shown.find(c => c.layout?.anchor);
  const packed = !phone && gridWidth > 0 ? masonryLayout(order.flatMap(id => {
    const card = byId.get(id);
    if (!card) return [];
    const width = Math.floor((card.layout?.width ?? card.layout?.w ?? 1) * track - 20);
    return [{ id, width: resize?.id === id ? resize.width : width, height: Math.max(heights[id]?.minimum ?? 84, resize?.id === id ? resize.height : card.layout?.height ?? (heights[id] ? heights[id].natural - 20 : sizeOf(card).h === 2 ? 240 : 104)) }];
  }), gridWidth, 20, resize ? { id: resize.id, left: resize.left, top: resize.top } : anchored?.layout?.anchor ? { id: anchored.id, left: anchored.layout.anchor.x * track, top: anchored.layout.anchor.y } : undefined) : undefined;
  const placement = packed ? fillMasonryGaps(packed, gridWidth, 20, resize?.id ?? anchored?.id) : undefined;
  const layoutKey = placement ? [...placement].map(([id, r]) => `${id}:${r.left}:${r.top}`).join('|') : order.join('|');
  useListFlip(gridRef, ':scope > [data-grid-id]:not(.grid-slot)', layoutKey, 'data-grid-id');
  const masonryHeight = placement ? Math.max(0, ...[...placement.values()].map(r => r.top + r.height + 20)) : undefined;
  const insertAt = drag && !drag.blocked && !drag.parentId && placement
    ? (() => {
      const index = drag.order.indexOf(drag.id);
      const next = placement.get(drag.order[index + 1]);
      if (next) return { left: next.left, top: next.top, width: next.width };
      const previous = placement.get(drag.order[index - 1]);
      return previous ? { left: previous.left, top: previous.top + previous.height + 10, width: previous.width } : null;
    })()
    : null;

  const dragRef = useRef<typeof drag>(null);
  const checklistTarget = useRef<HTMLElement | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const stopListening = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    stopListening.current?.();
    markChecklistDrop(checklistTarget.current, null);
    document.body.classList.remove('grid-dragging');
  }, []);

  const endDrag = (commit: boolean) => {
    stopListening.current?.();
    stopListening.current = null;
    press.current = null;
    document.body.classList.remove('grid-dragging');
    checklistTarget.current = markChecklistDrop(checklistTarget.current, null);
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setDrag(null);
    if (d.blocked) return;
    if (commit && d.parentId) {
      actions.linkCard(d.parentId, d.id);
      return;
    }
    const before = shownRef.current.map((c) => c.id);
    if (!commit || d.order.join() === before.join()) return;
    // Hidden (filtered) cards keep their place after the shown ones.
    const rest = gridOrder(state.board.cards.filter(inGrid)).map((c) => c.id).filter((id) => !d.order.includes(id));
    actions.arrange([...d.order, ...rest], 'Moved');
  };

  const onMove = (e: PointerEvent) => {
    const p = press.current;
    if (!p) return;
    const d = dragRef.current;
    if (!d) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_PX) return;
      document.body.classList.add('grid-dragging');
      const next = { id: p.id, order: shownRef.current.map((c) => c.id), x: e.clientX, y: e.clientY, dx: p.x - p.rect.left, dy: p.y - p.rect.top, w: p.rect.width, h: p.rect.height };
      dragRef.current = next;
      setDrag(next);
      return;
    }
    // Keep targets still until release; edge drops apply the prospective order.
    const element = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-grid-id]') ?? null;
    const target = checklistDropTarget(element, e.clientX, e.clientY, d.id, state.board.cards);
    checklistTarget.current = markChecklistDrop(checklistTarget.current, target);
    const parentId = target?.dataset.gridId;
    const blocked = !parentId && isChecklistDropCenter(element, e.clientX, e.clientY);
    let over = element?.dataset.gridId;
    if (!over && !parentId && !blocked) {
      const scroller = gridRef.current?.closest<HTMLElement>('.notes-scroll');
      const sr = scroller?.getBoundingClientRect();
      const first = gridRef.current?.querySelector<HTMLElement>('[data-grid-id]:not(.grid-slot)');
      if (sr && first && e.clientX >= sr.left && e.clientX <= sr.right && e.clientY >= sr.top && e.clientY <= sr.bottom && e.clientY < first.getBoundingClientRect().top) over = first.dataset.gridId;
    }
    let order = d.order;
    if (!parentId && !blocked && over && over !== d.id) {
      const originalOrder = shownRef.current.map(card => card.id);
      const to = originalOrder.indexOf(over);
      if (to >= 0) {
        order = originalOrder.filter((id) => id !== d.id);
        order.splice(to, 0, d.id);
      }
    }
    const next = { ...d, x: e.clientX, y: e.clientY, order, parentId, blocked };
    dragRef.current = next;
    setDrag(next);
  };

  const onResize = (event: React.PointerEvent, id: string) => {
    if (readOnly || phone || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const card = (event.currentTarget as HTMLElement).closest<HTMLElement>('.note-card')!;
    const start = card.getBoundingClientRect();
    const startX = event.clientX, startY = event.clientY;
    const grid = gridRef.current!.getBoundingClientRect();
    const cell = (gridWidth - 20 * (cols - 1)) / cols;
    const left = Math.round(start.left - grid.left);
    const top = Math.round(start.top - grid.top);
    let next = { id, width: Math.round(start.width), height: Math.round(start.height), left, top };
    setResize(next);
    const move = (e: PointerEvent) => {
      const { width } = snappedWidth(start.width + e.clientX - startX, gridWidth, cols);
      next = { id, width, left: Math.max(0, Math.min(Math.round(left / track) * track, gridWidth - width)), top, height: Math.max(heights[id]?.minimum ?? 84, Math.min(1000, Math.round(start.height + e.clientY - startY))) };
      setResize(next);
    };
    const finish = (save: boolean) => {
      stopListening.current?.();
      stopListening.current = null;
      setResize(null);
      const height = Math.abs(next.height - start.height) < 4 ? byId.get(id)?.layout?.height ?? null : next.height;
      if (save) actions.resizeCard(id, next.width > cell + 1 ? 2 : 1, height, { width: snappedWidth(next.width, gridWidth, cols).span, anchor: { x: next.left / track, y: next.top } });
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    stopListening.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
    };
  };

  const onPointerDown = (e: React.PointerEvent, id: string) => {
    if (phone || readOnly || e.button !== 0 || e.pointerType === 'touch') return;
    if ((e.target as HTMLElement).closest('button, a, input, textarea, .grid-resize')) return;
    press.current = { id, x: e.clientX, y: e.clientY, rect: (e.currentTarget as HTMLElement).getBoundingClientRect(), pointer: e.pointerId };
    const move = (ev: PointerEvent) => onMoveRef.current(ev);
    const up = () => endDragRef.current(true);
    const cancel = () => endDragRef.current(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !dragRef.current) return;
      ev.preventDefault();
      ev.stopPropagation();
      endDragRef.current(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    stopListening.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
    };
  };
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const endDragRef = useRef(endDrag);
  endDragRef.current = endDrag;
  useEffect(() => {
    if (!drag) return;
    let frame = 0;
    const scroll = () => {
      const d = dragRef.current;
      const scroller = gridRef.current?.closest<HTMLElement>('.notes-scroll');
      if (!d || !scroller) return;
      const r = scroller.getBoundingClientRect();
      const inBounds = d.x >= r.left && d.x <= r.right && d.y >= r.top && d.y <= r.bottom;
      const speed = inBounds ? edgeScroll(d.y, r.top, Math.min(r.bottom, window.innerHeight), 96, 10) : 0;
      const before = scroller.scrollTop;
      if (speed) scroller.scrollTop += speed;
      scroller.dataset.dragScroll = scroller.scrollTop !== before ? speed < 0 ? 'top' : 'bottom' : '';
      if (scroller.scrollTop !== before) onMoveRef.current({ clientX: d.x, clientY: d.y } as PointerEvent);
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    return () => {
      cancelAnimationFrame(frame);
      const scroller = gridRef.current?.closest<HTMLElement>('.notes-scroll');
      if (scroller) delete scroller.dataset.dragScroll;
    };
  }, [Boolean(drag)]);

  // ---- keyboard: arrows move the selection; ⌥ + arrows move the card; ⌥⇧ + arrows resize (v6 §3) ----
  const onKeyDown = (e: React.KeyboardEvent, c: Card) => {
    if (e.target !== e.currentTarget) return;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpenCard(c.id);
      return;
    }
    const dir = arrows[e.key];
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    const ids = shown.map((x) => x.id);
    const i = ids.indexOf(c.id);
    if (e.altKey && !readOnly) {
      const step = dir[0] || dir[1] * cols;
      const j = Math.max(0, Math.min(ids.length - 1, i + step));
      if (j === i) return;
      const next = ids.filter((id) => id !== c.id);
      next.splice(j, 0, c.id);
      const rest = gridOrder(state.board.cards.filter(inGrid)).map((x) => x.id).filter((id) => !next.includes(id));
      actions.arrange([...next, ...rest], 'Moved');
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-grid-id="${c.id}"]`)?.focus());
      return;
    }
    // Plain arrows: the nearest card in that direction, by position on screen.
    const from = (e.currentTarget as HTMLElement).getBoundingClientRect();
    let best: { el: HTMLElement; d: number } | null = null;
    gridRef.current?.querySelectorAll<HTMLElement>('[data-grid-id]').forEach((el) => {
      if (el === e.currentTarget) return;
      const r = el.getBoundingClientRect();
      const dx = r.left + r.width / 2 - (from.left + from.width / 2);
      const dy = r.top + r.height / 2 - (from.top + from.height / 2);
      const along = dir[0] ? dx * dir[0] : dy * dir[1];
      if (along <= 4) return;
      const across = dir[0] ? Math.abs(dy) : Math.abs(dx);
      const d = along + across * 2;
      if (!best || d < best.d) best = { el, d };
    });
    (best as { el: HTMLElement } | null)?.el.focus();
  };

  const inbox = all.filter(inInbox).length;
  const dragged = drag ? byId.get(drag.id) : null;

  return (
    <main className={`notes-view${phone ? ' phone' : ''}${drag ? ' dragging' : ''}${resize ? ' resizing' : ''}`} tabIndex={-1} aria-label="Notes">
      <div className="notes-scroll">
        <div
          ref={gridRef}
          className={`notes-grid${placement ? ' masonry' : ''}`}
          role="list"
          title={phone || readOnly ? undefined : 'Drag to arrange; drop on a note’s center to add to its checklist'}
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, height: masonryHeight }}
          data-cols={cols}
        >
          {order.map((id) => {
            const c = byId.get(id);
            if (!c) return null;
            const size = sizes(c);
            return (
              <NoteCard
                key={id}
                card={c}
                size={size}
                rowSpan={heights[id]?.natural ?? (size.h === 2 ? 260 : 124)}
                cols={cols}
                phone={phone}
                open={openCardId === id}
                selected={selectedId === id}
                faded={!!drag}
                onOpen={onOpenCard}
                onSelect={onSelect}
                onPointerDown={onPointerDown}
                onResize={onResize}
                displayHeight={phone ? undefined : placement?.get(id)?.height ?? c.layout?.height}
                position={placement?.get(id)}
                resizing={resize?.id === id}
                onKeyDown={onKeyDown}
                searchQuery={q || undefined}
              />
            );
          })}
          {insertAt && <div className="grid-insertion-line" style={insertAt} aria-hidden />}
        </div>
        {shown.length === 0 &&
          (q ? (
            <p className="notes-empty">No matches</p>
          ) : store.notesFilter.length ? (
            <FilterEmpty filter={store.notesFilter} labels={store.labels} onClear={() => store.setNotesFilter([])} />
          ) : (
            !store.cards.some((c) => !c.archivedAt) && <p className="notes-empty">Nothing here yet. Write above, or send something from Siri or the share sheet.</p>
          ))}
      </div>
      {dragged && drag && createPortal(
        <div className="grid-ghost" style={{ width: drag.w, height: drag.h, transform: `translate(${drag.x - drag.dx}px, ${drag.y - drag.dy}px) scale(1.03) rotate(.8deg)` }} aria-hidden>
          <NoteCard displayHeight={drag.h} card={dragged} size={sizes(dragged)} cols={cols} phone={false} open={false} selected={false} ghost onOpen={() => {}} />
        </div>,
        document.querySelector('.app') ?? document.body,
      )}
      <span className="sr-only" aria-live="polite">{inbox} in Inbox</span>
    </main>
  );
}

// ---------------------------------------------------------------------------------------------------

interface CardProps {
  card: Card;
  size: Size;
  rowSpan?: number;
  displayHeight?: number;
  position?: MasonryRect;
  resizing?: boolean;
  onResize?(event: React.PointerEvent, id: string): void;
  cols: number;
  phone: boolean;
  open: boolean;
  selected: boolean;
  faded?: boolean;
  ghost?: boolean;
  searchQuery?: string;
  onOpen(id: string): void;
  onSelect?(id: string): void;
  onPointerDown?(e: React.PointerEvent, id: string): void;
  onKeyDown?(e: React.KeyboardEvent, c: Card): void;
}

const NoteCard = memo(function NoteCard({ card, size, rowSpan, displayHeight, position, resizing, onResize, cols, phone, open, selected, faded, ghost, onOpen, onSelect, onPointerDown, onKeyDown }: CardProps) {
  const labels = useLabels();
  const readOnly = useReadOnly();
  const touchUI = useTouchUI();
  const v = noteView(card, labels, size);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const lastMenuAt = useRef(menuAt);
  if (menuAt) lastMenuAt.current = menuAt;
  const menuPresence = useDropdownPresence(!!menuAt);
  const swipeOn = (phone || touchUI) && !readOnly && !ghost;
  const swipe = useSwipeRow({
    enabled: swipeOn,
    left: true,
    right: false,
    confirmCommit: true,
    onCommit: () => {
      markSlidOut(card.id);
      actions.deleteCardById(card.id);
    },
  });

  const article = (
    <article
      className={`note-card${open || selected ? ' open' : ''}${v.done ? ' done' : ''}${ghost ? ' ghost' : ''}`}
      data-grid-id={ghost ? undefined : card.id}
      data-card-id={ghost ? undefined : card.id}
      data-resizing={resizing || undefined}
      data-testid={ghost ? undefined : `note-${card.id}`}
      role="listitem"
      aria-roledescription="sortable"
      aria-label={`${v.name}${v.labelNames ? `, ${v.labelNames}` : ''}`}
      tabIndex={ghost ? -1 : 0}
      style={{
        gridColumn: `span ${Math.min(size.w, cols)}`,
        gridRow: rowSpan ? `span ${rowSpan}` : undefined,
        minHeight: 84,
        height: displayHeight,
        opacity: faded ? 0.7 : undefined,
        ...positionStyle(position),
      }}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onSelect?.(card.id);
      }}
      onPointerDown={(e) => onPointerDown?.(e, card.id)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, a, .grid-resize')) return;
        onOpen(card.id);
      }}
      onKeyDown={(e) => onKeyDown?.(e, card)}
      onContextMenu={(e) => {
        if (readOnly || ghost) return;
        e.preventDefault();
        setMenuAt({ x: e.clientX, y: e.clientY });
      }}
    >
      {!phone && !readOnly && !ghost && <button type="button" className="grid-resize" aria-label={`Resize ${v.name}`} title="Drag to resize; double-click to fit content" onPointerDown={(e) => onResize?.(e, card.id)} onDoubleClick={(e) => { e.stopPropagation(); actions.resizeCard(card.id, 1, null); }} onKeyDown={(e) => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        const height = Math.round(e.currentTarget.closest('.note-card')!.getBoundingClientRect().height);
        const grid = e.currentTarget.closest<HTMLElement>('.notes-grid')!.getBoundingClientRect();
        const rect = e.currentTarget.closest<HTMLElement>('.note-card')!.getBoundingClientRect();
        const track = (Math.floor(grid.width) + 20) / cols;
        const { width, span } = snappedWidth(rect.width + (e.key === 'ArrowLeft' ? -track : e.key === 'ArrowRight' ? track : 0), Math.floor(grid.width), cols);
        const preferredHeight = e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? card.layout?.height ?? null : height + (e.key === 'ArrowUp' ? -40 : 40);
        actions.resizeCard(card.id, span > 1 ? 2 : 1, preferredHeight, { width: span, anchor: { x: Math.max(0, Math.min(Math.round((rect.left - grid.left) / track) * track, grid.width - width)) / track, y: Math.round(rect.top - grid.top) } });
      }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><path d="M7 20A13 13 0 0 0 20 7" strokeDasharray="1 4" /></svg></button>}
      <Ring card={card} readOnly={readOnly || ghost} onClick={() => actions.cycleRing(card.id)} className="note-ring" />
      <div className="note-main">
        {v.showTitle && (
          <h3 className="note-title">
            <span>{v.title}</span>
            {v.ai && (
              <svg className="sparkle" viewBox="0 0 24 24" width="12" height="12" aria-label="Suggested title">
                <path d="M12 3c.6 4.6 3.4 7.4 8 8-4.6.6-7.4 3.4-8 8-.6-4.6-3.4-7.4-8-8 4.6-.6 7.4-3.4 8-8z" />
              </svg>
            )}
          </h3>
        )}
        {v.preview && (
          <div className={`note-preview md-preview${v.showTitle ? '' : ' alone'}`} style={{ WebkitLineClamp: v.clamp }}>
            <MarkdownPreview card={card} value={card.notes} compact />
          </div>
        )}
        {v.items.length > 0 && (
          <div className="note-items">
            {v.items.map((it) => (
              <div key={it.id} className={`note-item${it.done ? ' done' : ''}${it.ref ? ' ref' : ''}`}>
                <span className="note-box" aria-hidden>
                  {it.done && (
                    <svg viewBox="0 0 24 24" width="10" height="10">
                      <path d="m5 12 5 5 9-10" />
                    </svg>
                  )}
                </span>
                <span className="note-item-text">{it.text}</span>
                {it.sub && <span className="mono note-item-sub">{it.sub}</span>}
              </div>
            ))}
            {v.more > 0 && <span className="mono note-more">+{v.more} more</span>}
          </div>
        )}
        {v.thumb && <img className="note-thumb" src={v.thumb} alt="" loading="lazy" draggable={false} />}
      </div>
      <footer className="note-foot mono">
        {v.link && (
          <a href={v.link.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="note-link" title={v.link.url}>
            {hostOf(v.link.url)}
          </a>
        )}
        {v.parent && <span className="note-parent">↑ {v.parent}</span>}
        {v.labels.map((l) => (
          <LabelPill key={l.id} label={l} />
        ))}
        {v.suggest && (
          <SuggestedPill label={v.suggest} className="note-suggest" onAccept={() => !readOnly && actions.acceptSuggestedLabel(card.id)} />
        )}
        <span className="note-spacer" />
        <span className="note-date">{size.w > 1 && v.via ? `${v.via} · ` : ''}{v.date}</span>
      </footer>
    </article>
  );
  const menuPosition = menuAt ?? lastMenuAt.current;
  const menu = menuPresence.mounted && menuPosition && (
    <CardContextMenu card={card} x={menuPosition.x} y={menuPosition.y} closing={menuPresence.closing} onClose={() => setMenuAt(null)} onOpenCard={onOpen} />
  );
  if (!swipeOn)
    return (
      <>
        {article}
        {menu}
      </>
    );
  return (
    <div ref={swipe.wrap} className="card-swipe note-swipe" data-swipe-row data-resizing={resizing || undefined} style={{ gridColumn: `span ${Math.min(size.w, cols)}`, gridRow: rowSpan ? `span ${rowSpan}` : undefined, ...positionStyle(position) }} data-grid-id={card.id}>
      <div className="swipe-bg swipe-bg-delete">
        <button type="button" className="swipe-action swipe-delete" tabIndex={-1} onClick={() => swipe.trigger('left')}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
          </svg>
          <span>{swipeCopy.delete}</span>
        </button>
      </div>
      <div ref={swipe.row} className="card-swipe-inner">
        {article}
      </div>
      {menu}
    </div>
  );
});

/** What a grid card shows (v5 rule 5 with the v6 fix: the title shows whenever there is no preview). */
function noteView(c: Card, labels: ReadonlyArray<Label>, size: Size) {
  const plain = stripMd(c.notes);
  const long = plain.length > 90 || c.notes.split('\n').length > 2;
  const img = firstImage(c.notes);
  const att = img && /^\/kanban\/files\/[\w-]+$/.test(img.url) ? (c.attachments ?? []).find((a) => img.url.endsWith(a.id)) : undefined;
  const thumb = att ? thumbUrl(att) : img && /^https?:/.test(img.url) ? img.url : '';
  const link = bodyLinks(c.notes)[0] ?? c.links?.[0] ?? null;
  const title = c.title.trim();
  const linkOnly = !!link && plain.trim() === (link.title || '').trim();
  const hasPreview = !!plain && !linkOnly && !(title && !long && plain === title);
  const showTitle = (!!title && (long || c.items.length > 0 || !!link || !!thumb)) || !hasPreview;
  const done = isCardDone(c);
  const refCard = (id: string) => state.board.cards.find((x) => x.id === id);
  const rows = c.items.map((it: CardItem) => {
    const r = it.ref ? refCard(it.ref) : undefined;
    return {
      id: it.id,
      ref: !!it.ref,
      done: it.done,
      text: r ? displayTitle(r) : it.text,
      sub: it.ref ? (r && r.items.length ? `${r.items.filter((x) => x.done).length}/${r.items.length}` : r && r.kind !== 'note' ? 'to do' : 'note') : '',
    };
  });
  const showItems = rows.length > 0 && (size.h > 1 || !hasPreview);
  const parents = parentsOf(state.board.cards, c.id);
  const pills = cardLabels(c, labels);
  const suggestLabel = c.suggestedLabel && !pills.length ? labels.find((l) => l.id === c.suggestedLabel) : undefined;
  return {
    name: displayTitle(c),
    title: title || displayTitle(c),
    ai: c.titleBy === 'ai' && !!title,
    showTitle,
    preview: hasPreview ? plain.replace(/\n+/g, showTitle ? ' ' : '\n') : '',
    clamp: showTitle ? 3 : 6,
    items: showItems ? rows.slice(0, 3) : [],
    more: showItems ? Math.max(0, rows.length - 3) : 0,
    prog: rows.length ? `${rows.filter((r) => r.done).length}/${rows.length}` : '',
    link,
    thumb,
    done,
    parent: parents.length ? displayTitle(parents[0]) : '',
    labels: pills,
    labelNames: pills.map((l) => l.name).join(', '),
    suggest: suggestLabel,
    via: c.via === 'siri' ? 'Siri' : c.via === 'share' ? 'Shared' : '',
    date: shortDate(c.createdAt),
  };
}
