// Checklist rows support inline editing, touch gestures, and linked notes.
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import ChecklistItemMenu from './ChecklistItemMenu';
import { useDropdownPresence } from '../hooks/useDropdownPresence';
import type { CardItem } from '../lib/types';
import { useSwipeRow } from '../hooks/useSwipeRow';
import { useTouchUI } from '../hooks/useLayout';
import { lockTouchScroll } from '../hooks/useItemDrag';
import { itemCopy, swipeCopy } from '../lib/copy';
import { markSlidOut } from '../lib/slid';
import { collapseThen } from '../lib/motion';
import { dragMode } from '../lib/input';
import { linkify, plainText } from '../lib/linkify';
import { ITEM_MAX } from '../lib/parse';
import { useLinkShortcuts } from './LinkPrompt';

interface Props {
  item: CardItem;
  phone: boolean;
  enterIndex: number; // -1 = no enter animation
  hidden?: boolean; // lifted: the ghost and the slot stand in for it
  onToggle(): void;
  onEdit(text: string): void;
  onSplit(before: string, after: string): void;
  onDelete(): void;
  onPromote(): void;
  editOnMount?: boolean; // the half an Enter just split off: opens in the editor, caret at the start
  onEditStarted?(): void;
  onDragStart(wrap: HTMLElement, x: number, y: number, release: () => void): void;
  onNudge(dir: -1 | 1): void;
  /** v6 §5: the row IS a card. Its text opens it (no inline edit); the box finishes it. */
  linked?: { title: string; tag: string; onOpen(): void };
}

const LONG_PRESS = 350;
const MOVE_PX = 6; // mouse drag threshold, and the touch move that turns a hold into a drag
const SCROLL_PX = 8; // touch movement before the hold: a scroll or a swipe

export default function ChecklistRow({ item, phone, enterIndex, hidden, onToggle, onEdit, onSplit, onDelete, onPromote, editOnMount, onEditStarted, onDragStart, onNudge, linked }: Props) {
  const [active, setActive] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsPresence = useDropdownPresence(actionsOpen);
  const actionsButton = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(!!editOnMount);
  const caretAtStart = useRef(!!editOnMount);
  const [draft, setDraft] = useState(item.text);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typed = useRef(false); // only a draft the user changed is saved (a remote edit meanwhile stays)
  const links = useLinkShortcuts(inputRef, draft, (v) => {
    typed.current = true;
    setDraft(v);
  });
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> | null; moved: boolean; armed: boolean; dragging: boolean; checkbox: boolean; release: (() => void) | null } | null>(null);
  const mouse = useRef<{ x: number; y: number } | null>(null);
  const lastPointer = useRef('mouse');
  const suppressClick = useRef(false);

  // The draft starts from the item when editing begins; a remote change meanwhile never overwrites it.
  useEffect(() => {
    if (editing) setDraft(item.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  useEffect(() => {
    if (editOnMount) onEditStarted?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => () => {
    const p = press.current;
    if (p?.timer) clearTimeout(p.timer);
    if (p && !p.dragging) p.release?.();
  }, []);

  const save = () => {
    setEditing(false);
    if (typed.current && draft.trim() !== item.text) onEdit(draft);
    typed.current = false;
  };
  const cancel = () => setEditing(false);

  // Every delete collapses the row in place first (rows below and the sheet follow), then
  // removes it; the presence exit is skipped so nothing re-appears for a frame.
  const removing = useRef(false);
  const removeSmoothly = () => {
    if (removing.current) return;
    removing.current = true;
    collapseThen(swipe.wrap.current, () => {
      markSlidOut(item.id);
      onDelete();
    });
  };
  // Swipe-to-delete follows touch input, whatever the layout.
  const touchUI = useTouchUI();
  const touchRow = phone || touchUI;
  const swipe = useSwipeRow({
    enabled: touchRow && !editing && !actionsOpen,
    left: true,
    right: false,
    confirmCommit: true,
    onCommit: () => removeSmoothly(),
  });

  useEffect(() => {
    if (!active) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (!swipe.wrap.current?.contains(event.target as Node) && !(event.target as Element).closest('.dt-item-menu')) setActive(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [active, swipe.wrap]);

  const unarm = (p: typeof press.current) => {
    swipe.wrap.current?.classList.remove('pressing');
    if (p && !p.dragging) {
      p.release?.();
      if (p.armed) document.body.classList.remove('dragging');
    }
  };
  const startDrag = (x: number, y: number, release: () => void) => {
    const wrap = swipe.wrap.current;
    if (!wrap) return release();
    wrap.classList.remove('pressing');
    onDragStart(wrap, x, y, release);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    lastPointer.current = e.pointerType;
    suppressClick.current = false; // a drag that ended off the row never got its click
    const t = e.target as HTMLElement;
    if (editing || t.closest('a, .ref-open, .dt-row-del, .dt-row-actions, .dt-row-edit, .link-prompt')) return;
    const mode = dragMode(e.pointerType, e.button);
    if (mode === 'threshold') {
      mouse.current = { x: e.clientX, y: e.clientY };
      return;
    }
    if (mode !== 'long-press') return;
    press.current = {
      x: e.clientX,
      y: e.clientY,
      moved: false,
      armed: false,
      dragging: false,
      checkbox: !!t.closest('.dt-box'),
      release: null,
      timer: setTimeout(() => {
        const p = press.current;
        if (!p || p.moved) return;
        // Held still: armed. Moving now drags; letting go edits. Swipes and scrolling stand down.
        p.armed = true;
        p.release = lockTouchScroll();
        document.body.classList.add('dragging');
        swipe.wrap.current?.classList.add('pressing');
        if (navigator.vibrate) navigator.vibrate(8);
      }, LONG_PRESS),
    };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const m = mouse.current;
    if (m && Math.hypot(e.clientX - m.x, e.clientY - m.y) > MOVE_PX) {
      mouse.current = null;
      suppressClick.current = true;
      startDrag(e.clientX, e.clientY, () => {});
      return;
    }
    const p = press.current;
    if (!p || p.dragging) return;
    const d = Math.hypot(e.clientX - p.x, e.clientY - p.y);
    if (!p.armed) {
      // Any real movement before the hold is a swipe or a scroll: no edit, no drag, no toggle.
      if (d > SCROLL_PX) {
        p.moved = true;
        if (p.timer) clearTimeout(p.timer);
        p.timer = null;
      }
      return;
    }
    if (d > MOVE_PX) {
      p.dragging = true;
      startDrag(e.clientX, e.clientY, p.release ?? (() => {}));
    }
  };
  const endPress = (commit: boolean) => {
    mouse.current = null;
    const p = press.current;
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    press.current = null;
    unarm(p);
    if (p.dragging) return; // the drag owns the release
    if (p.armed) {
      if (commit) setEditing(true); // held and let go without moving: edit
      return;
    }
    if (p.moved || swipe.busy()) return; // the swipe (or closing an open row) owns this touch
    if (commit) {
      if (p.checkbox) onToggle();
      else if (linked) linked.onOpen();
      else if (active) setEditing(true);
      else setActive(true);
    }
  };

  const cls = [
    'dt-row',
    item.done ? 'checked' : '',
    editing ? 'editing' : '',
    enterIndex >= 0 ? 'enter' : '',
    linked ? 'ref' : '',
    active ? 'item-active' : '',
    actionsOpen ? 'item-menu-open' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={swipe.wrap}
      className="dt-row-wrap"
      data-swipe-row={touchRow || undefined}
      data-item-id={item.id}
      data-flip-id={item.id}
      data-done={String(item.done)}
      style={hidden ? { display: 'none' } : undefined}
    >
      {touchRow && (
        <div className="swipe-bg swipe-bg-delete">
          <button type="button" className="swipe-action swipe-delete" tabIndex={-1} aria-label={swipeCopy.deleteItemAria(plainText(item.text))} onClick={() => swipe.trigger('left')}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
            </svg>
            <span>{swipeCopy.delete}</span>
          </button>
        </div>
      )}
      <div
        ref={swipe.row}
        className={cls}
        role="checkbox"
        aria-checked={item.done}
        aria-label={plainText(item.text)}
        tabIndex={0}
        data-testid={`item-${item.id}`}
        style={{
          transitionDelay: enterIndex >= 0 ? `${Math.min(enterIndex, 7) * 30}ms` : undefined,
          animationDelay: enterIndex >= 0 ? `${Math.min(enterIndex, 7) * 30}ms` : undefined,
        }}
        onClick={(e) => {
          // Touch and pen toggle on release (endPress); a mouse toggles on click.
          if (editing || lastPointer.current === 'touch' || lastPointer.current === 'pen') return;
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          const t = e.target as HTMLElement;
          if (t.closest('a, .dt-row-del, .dt-row-actions, .dt-row-handle, .dt-row-edit, .link-prompt')) return;
          if (t.closest('.dt-box')) {
            onToggle();
            return;
          }
          // The text is for editing; the box is for ticking. A linked card's text opens it.
          if (linked) linked.onOpen();
          else if (touchRow) { if (active) setEditing(true); else setActive(true); }
          else setEditing(true);
        }}
        onKeyDown={(e) => {
          if (editing || e.target !== e.currentTarget) return;
          if ((e.altKey || e.metaKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            e.stopPropagation();
            onNudge(e.key === 'ArrowUp' ? -1 : 1);
            // The row moved in the DOM: keep the keyboard on it.
            requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="item-${item.id}"]`)?.focus({ preventScroll: false }));
          } else if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            onToggle();
          } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            removeSmoothly();
          } else if (e.key === 'F2' && !linked) {
            setEditing(true);
          }
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => endPress(true)}
        onPointerCancel={() => endPress(false)}
      >
        <span className="dt-row-handle" aria-label={itemCopy.handle(plainText(item.text))} data-testid={`item-${item.id}-handle`}>
          ⋮⋮
        </span>
        <span className="dt-box" aria-hidden>
          <svg viewBox="0 0 16 16" width="16" height="16">
            <path className="dt-box-check" d="M3.5 8.5l3 3 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        {linked ? (
          <span className="dt-row-text dt-ref-text">
            <span>{linked.title}</span>
            <span className="ref-tag mono">{linked.tag}</span>
          </span>
        ) : (
          <div className="dt-item-text-field">
            <span className="dt-row-text" aria-hidden={editing || undefined}>{editing ? draft + '\u200b' : linkify(item.text)}</span>
            {editing && (
              <textarea
                ref={inputRef}
                className="dt-row-edit"
                value={draft}
                autoFocus
                onFocus={(e) => {
                  if (links.prompting) return;
                  if (caretAtStart.current) {
                    caretAtStart.current = false;
                    e.currentTarget.setSelectionRange(0, 0);
                  } else e.currentTarget.select();
                }}
                enterKeyHint="done"
                onChange={(e) => {
                  typed.current = true;
                  setDraft(e.target.value);
                }}
                onPaste={links.onPaste}
                onBlur={(e) => {
                  // Focus moving into the link popover is still editing.
                  if (links.prompting || e.currentTarget.closest('.dt-row-wrap')?.contains(e.relatedTarget as Node | null)) return;
                  save();
                }}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (links.onKeyDown(e)) return;
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    // Text after the caret becomes the next item; otherwise Enter just saves.
                    const el = e.currentTarget;
                    const before = draft.slice(0, el.selectionStart ?? draft.length);
                    const after = draft.slice(el.selectionEnd ?? draft.length);
                    if (before.trim() && after.trim()) {
                      setEditing(false);
                      typed.current = false;
                      onSplit(before, after);
                    } else save();
                  } else if (e.key === 'Escape') cancel();
                }}
                maxLength={ITEM_MAX}
                aria-label="Edit item"
              />
            )}
          </div>
        )}
        {linked && !editing && (
          <button
            type="button"
            className="ref-open"
            aria-label={`Open ${linked.title}`}
            onClick={(e) => {
              e.stopPropagation();
              linked.onOpen();
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m9 6 6 6-6 6" /></svg>
          </button>
        )}
        <button
          ref={actionsButton}
          disabled={editing}
          type="button"
          className="dt-row-actions"
          aria-label={`Options for ${plainText(item.text)}`}
          title="Item options"
          aria-haspopup="menu"
          aria-expanded={actionsOpen}
          onClick={(event) => { event.stopPropagation(); setActionsOpen(open => !open); }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M4 7h9m4 0h3M4 17h3m4 0h9" />
            <circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" />
          </svg>
        </button>
      </div>
      {actionsPresence.mounted && !editing && (
        <ChecklistItemMenu anchor={actionsButton} phone={touchRow} closing={actionsPresence.closing} linked={!!linked} onEdit={() => linked ? linked.onOpen() : setEditing(true)} onClose={() => setActionsOpen(false)} onPromote={onPromote} onDelete={removeSmoothly} />
      )}
      {editing && links.prompt}
    </div>
  );
}
