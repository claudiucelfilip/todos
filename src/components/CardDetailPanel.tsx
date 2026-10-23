import SherlockHandoff, { useNoteView } from './SherlockHandoff';
import BotDelegation from './BotDelegation';
import { useOutsideDismiss } from '../hooks/useOutsideDismiss';
import { useDropdownPresence } from '../hooks/useDropdownPresence';
import Ring from './Ring';
import { isQuiet } from '../lib/seen';
// §7.3–7.5, §8 — the card detail: desktop floating panel / phone bottom sheet.
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { Card } from '../lib/types';
import { actions, state, useStore } from '../hooks/useStore';
import { composeCard } from '../lib/parse';
import { copy } from '../lib/copy';
import { relativeDate } from '../lib/dates';
import { linkify } from '../lib/linkify';
import AddItemsField from './AddItemsField';
import ChecklistRow from './ChecklistRow';
import { CloseIcon, MoreIcon } from './Icons';
import Roll from './Roll';
import { instantMotion, staggerIndex, usePresence } from '../lib/presence';
import CardMenu, { ChecklistMenu } from './CardMenu';
import { AssistantSparkle } from './AssistantPanel';
import { LabelPicker, LabelPill, SuggestedPill } from './Labels';
import { ReminderRow } from './Reminder';
import { useItemDrag } from '../hooks/useItemDrag';
import { useListFlip } from '../lib/flip';
import { plainText } from '../lib/linkify';
import { attachCopy } from '../lib/copy';
import MarkdownBody, { mdUrl, type MarkdownBodyHandle } from './MarkdownBody';
import { displayTitle, isCardDone, parentsOf } from '../../shared/notes.mjs';
import { uploads } from '../lib/uploads';
import { apiBase } from '../lib/sync';
import { currentAccount, currentRoom, scopedUrl } from '../lib/account';
import { cloneForExit, collapseThen, springAnimate } from '../lib/motion';
import { markSlidOut, slidOutRecently } from '../lib/slid';
import { SPRINGS, springCurve } from '../lib/spring';
import { cardLabels, isHttpUrl } from '../lib/labels';
import { isActionEnter } from '../lib/keys';
import { ChecklistRowView, ReminderText } from './ReadOnly';

interface Props {
  card: Card;
  phone: boolean;
  onClose(): void;
  onOutsideClose?(): void;
  onOpenCard(id: string): void;
  returnFocusTo?: HTMLElement | null;
  /** v6 §7: the panel at half the screen. */
  /** v6 §5: the parents walked through to get here (a breadcrumb); a crumb goes back. */
  crumbs?: string[];
  onCrumb?(index: number): void;
  onOpenChild?(id: string): void;
  /** §12.1: ask the assistant about this card (it takes over the panel's slot). */
  onAskAssistant?(): void;
  /** Put the caret at the end of the body on open (the composer's expand). */
  startAtEnd?: boolean;
}

const NOTES_DEBOUNCE = 300;

const FOCUSABLE =
  'a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])';

export default function CardDetailPanel({
  card,
  phone,
  onClose,
  onOutsideClose,
  onOpenCard,
  returnFocusTo,
  crumbs,
  onCrumb,
  onOpenChild,
  onAskAssistant,
  startAtEnd,
}: Props) {
  const store = useStore();
  const newId = useRef(card.draft ? card.id : null);
  // A view-only link: the same panel to read; every control that changes the card is left out.
  const ro = store.readOnly;
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<MarkdownBodyHandle>(null);
  useNoteView(card, rootRef, ro);
  const restoreFocus = useRef(true);
  useOutsideDismiss(rootRef, () => {
    restoreFocus.current = false;
    (onOutsideClose ?? onClose)();
  }, `.dt-menu-float, .label-picker, .remind-pop, .card-face[data-card-id="${CSS.escape(card.id)}"], .note-card[data-card-id="${CSS.escape(card.id)}"]`);
  const sheetRef = useRef<HTMLDivElement>(null);
  // Input-mode changes must not replay an entrance on an already-open panel.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let mounted = true;
    const settle = () => { if (mounted) el.dataset.entrySettled = ''; };
    const entrance = el.getAnimations();
    if (!entrance.length) settle();
    else Promise.all(entrance.map(animation => animation.finished.catch(() => {}))).then(settle);
    return () => { mounted = false; };
  }, []);

  // ---- close: a clone leaves on the snappy spring (no overshoot, quicker than the open) ----
  useLayoutEffect(() => {
    const mountedAt = performance.now();
    return () => {
      if (performance.now() - mountedAt < 50) return; // StrictMode's dev double-mount
      const el = rootRef.current;
      const ms = springCurve(SPRINGS.snappy).ms;
      if (!phone) {
        const rect = el?.getBoundingClientRect();
        const clone = cloneForExit(el, ms);
        if (clone && rect) {
          Object.assign(clone.style, {
            position: 'fixed',
            top: `${rect.top}px`,
            left: `${rect.left}px`,
            right: 'auto',
            bottom: 'auto',
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            margin: '0',
          });
          springAnimate(clone, SPRINGS.snappy, (p) => ({
            transform: `translateX(${Math.round(rect.width * p)}px)`,
          }));
        }
        return;
      }
      const root = el?.parentElement as HTMLElement | null;
      if (newId.current && el) {
        const rect = el.getBoundingClientRect();
        const clone = cloneForExit(root, 180);
        const sheet = clone?.querySelector<HTMLElement>('.dt-sheet');
        if (!clone || !sheet) return;
        clone.classList.add('capture-exit');
        sheet.style.setProperty('animation', 'none', 'important');
        Object.assign(sheet.style, {
          top: `${Math.round(rect.top)}px`, left: `${Math.round(rect.left)}px`,
          width: `${Math.round(rect.width)}px`, height: `${Math.round(rect.height)}px`,
          right: 'auto', bottom: 'auto', transform: 'none', transition: 'none',
        });
        const animation = sheet.animate([
          { transform: 'translateY(0px)' },
          { transform: `translateY(${Math.max(0, Math.round(document.documentElement.clientHeight - rect.top - 69))}px)` },
        ], { duration: 180, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'forwards' });
        animation.onfinish = () => clone.remove();
        return;
      }
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const from = new DOMMatrixReadOnly(
        getComputedStyle(el).transform === 'none' ? undefined : getComputedStyle(el).transform,
      ).m41;
      const clone = cloneForExit(root, 240);
      const sheet = clone?.querySelector<HTMLElement>('.dt-sheet');
      if (!clone || !sheet) return;
      sheet.style.setProperty('animation', 'none', 'important');
      Object.assign(sheet.style, {
        top: `${Math.round(rect.top)}px`, left: `${Math.round(rect.left - from)}px`,
        width: `${Math.round(rect.width)}px`, height: `${Math.round(rect.height)}px`,
        right: 'auto', bottom: 'auto', transition: 'none',
      });
      const animation = sheet.animate([
        { transform: `translateX(${Math.round(from)}px)` },
        { transform: `translateX(${Math.round(rect.width)}px)` },
      ], { duration: 240, easing: getComputedStyle(el).getPropertyValue('--ease-drawer').trim(), fill: 'forwards' });
      animation.onfinish = () => clone.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- content cross-fade when the open card changes (§11.4) --------------
  const [shownId, setShownId] = useState(card.id);
  const [fade, setFade] = useState<'in' | 'out' | ''>('in');
  useEffect(() => {
    if (card.id === shownId) return;
    if (instantMotion()) { setShownId(card.id); setFade(''); return; }
    setFade('out');
    const t = setTimeout(() => {
      setShownId(card.id);
      setFade('in');
    }, 100);
    return () => clearTimeout(t);
  }, [card.id, shownId]);

  // ---- focus: return on close; auto-focus add-items only for empty cards ----
  const cardIdRef = useRef(card.id);
  cardIdRef.current = card.id;
  useEffect(() => {
    const opener = returnFocusTo ?? (document.activeElement as HTMLElement | null);
    return () => {
      if (!restoreFocus.current) return;
      // §12: back to the originating card (re-queried: it may have re-mounted in another
      // column), else whatever opened us, else the board.
      const target =
        (opener?.closest('.phone-search-layer') && document.contains(opener) ? opener : null) ??
        // the card in the view that is showing (both views stay mounted; the hidden one is inert)
        Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="card-${cardIdRef.current}"], [data-testid="note-${cardIdRef.current}"]`)).find(
          (el) => !el.closest('[inert], [data-away]'),
        ) ??
        (opener && document.contains(opener) && opener !== document.body ? opener : null) ??
        document.querySelector<HTMLElement>('main.board');
      target?.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // D12: focus enters the dialog on open: the title of a blank card, else the panel itself.
  useEffect(() => {
    restoreFocus.current = true;
    const root = rootRef.current;
    if (!root || root.contains(document.activeElement)) return;
    const blank = !ro && !card.title.trim() && !card.notes.trim() && !card.items.length;
    (blank && !startAtEnd ? root.querySelector<HTMLElement>('[data-testid="detail-title"]') : null)?.focus({ preventScroll: true });
    if (!root.contains(document.activeElement)) root.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id]);

  // ---- keyboard: Esc closes, Cmd/Ctrl+Enter toggles done, Tab is trapped ----
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      if (menuOpen) return; // the menu handles its own Esc
      if (pickerOpen || reminderOpen) {
        e.preventDefault();
        e.stopPropagation();
        setPickerOpen(false);
        setReminderOpen(false);
      }
      return; // blur, breadcrumb back and close are App's one Esc handler (§11.24.1)
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !ro) {
      e.preventDefault();
      store.setCardDone(card.id, !isCardDone(card));
      return;
    }
    if (e.key === 'Tab' && rootRef.current && (phone || newId.current === card.id)) {
      const nodes = Array.from(rootRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (n) => n.offsetParent !== null,
      );
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  // ---- title ------------------------------------------------------------------
  const [title, setTitle] = useState(card.title);
  // A remote rename never overwrites what is being typed: the field follows the card only while it is not focused.
  const titleFocused = useRef(false);
  const titleTyped = useRef(false); // only a title the user typed is saved on blur
  useEffect(() => {
    if (!titleFocused.current) setTitle(card.title);
  }, [card.id, card.title]);
  const saveTitle = () => {
    const typed = titleTyped.current;
    titleTyped.current = false;
    if (!typed) setTitle(card.title); // untouched: show the card's (maybe remote) title
    else store.setTitle(card.id, title); // typed (empty = derive from the body again)
  };

  // ---- body (markdown, 300ms debounce) ----------------------------------------
  const [notes, setNotes] = useState(card.notes);
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ id: string; notes: string } | null>(null);
  const editedBody = useRef<{ id: string; notes: string } | null>(null);
  // A remote edit shows unless this device has a write waiting.
  useEffect(() => {
    if (!pending.current) {
      setNotes(card.notes);
      if (editedBody.current?.id === card.id && editedBody.current.notes !== card.notes) editedBody.current = null;
    }
  }, [card.id, card.notes]);
  const flushNotes = useCallback(() => {
    if (notesTimer.current) clearTimeout(notesTimer.current);
    notesTimer.current = null;
    if (pending.current) {
      actions.updateCardNotes(pending.current.id, pending.current.notes);
      pending.current = null;
    }
  }, []); // stable: a re-render (a sync) never flushes the debounce early
  const onNotesChange = (v: string) => {
    setNotes(v);
    pending.current = { id: card.id, notes: v.slice(0, 5000) };
    editedBody.current = pending.current;
    if (notesTimer.current) clearTimeout(notesTimer.current);
    if (card.draft && v.trim()) flushNotes();
    else notesTimer.current = setTimeout(flushNotes, NOTES_DEBOUNCE);
  };
  const finishNotes = useCallback((value?: string, id?: string) => {
    const edited = editedBody.current;
    if (id && edited?.id !== id) return;
    editedBody.current = null;
    if (!edited) { flushNotes(); return; }
    if (notesTimer.current) clearTimeout(notesTimer.current);
    notesTimer.current = null;
    pending.current = null;
    const next = actions.finishBodyEditing(edited.id, value ?? edited.notes);
    if (next !== undefined && cardIdRef.current === edited.id) setNotes(next);
  }, [flushNotes]);
  useEffect(() => () => finishNotes(), [finishNotes, card.id]);

  /** Files into the body: each uploads and its markdown line lands at `at` (images show inline). */
  const insertFiles = async (files: File[], at?: number) => {
    const lines: string[] = [];
    for (const f of files) {
      const name = f.name || (f.type.startsWith('image/') ? `Pasted image.${f.type.split('/')[1] || 'png'}` : 'file');
      const v = await uploads.add(card.id, f, name);
      lines.push(`${f.type.startsWith('image/') ? '!' : ''}[${name.replace(/[[\]]/g, '')}](/kanban/files/${v.id})`);
    }
    const cur = (pending.current?.notes ?? card.notes).split('\n');
    const pos = at === undefined ? cur.length : Math.min(at + 1, cur.length);
    if (cur.length === 1 && cur[0] === '') cur.splice(0, 1, ...lines);
    else cur.splice(pos, 0, ...lines);
    onNotesChange(cur.join('\n'));
    flushNotes();
  };
  /** A pasted link's page title, fetched by the server (it refuses private addresses). */
  const pageTitleFor = async (url: string): Promise<string | null> => {
    try {
      const r = await fetch(scopedUrl(`${apiBase()}/kanban/page-title?url=${encodeURIComponent(url)}`), { credentials: 'include' });
      if (!r.ok) return null;
      return ((await r.json()) as { title?: string }).title || null;
    } catch {
      return null;
    }
  };

  // ---- v5 / v6: kind, parents, suggestions ---------------------------------------------
  const done = isCardDone(card);
  const parents = parentsOf(store.cards, card.id);
  const visibleCrumbs = crumbs?.length ? crumbs : parents.slice(0, 1).map((p) => p.id);
  const suggested = card.suggestedLabel && !card.labels.length ? store.labels.find((l) => l.id === card.suggestedLabel) : undefined;
  // ---- checklist order: as stored; ticking an item never moves it ------
  const order = card.items.map((i) => i.id);
  const seen = useRef<Set<string>>(new Set(card.items.map((i) => i.id)));
  const [entering, setEntering] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    const ids = new Set(card.items.map((i) => i.id));
    // Newcomers get the enter animation; five items stagger, fifty enter as one group (staggerIndex → -1).
    const fresh = isQuiet() ? [] : card.items.filter((i) => !seen.current.has(i.id));
    seen.current = ids;
    if (!fresh.length) return;
    const m = new Map<string, number>();
    fresh.forEach((i, idx) => m.set(i.id, staggerIndex(fresh.length, idx)));
    setEntering(m);
    const t = setTimeout(() => setEntering(new Map()), 600);
    return () => clearTimeout(t);
  }, [card.items, card.id]);
  const rows = order
    .map((id) => card.items.find((i) => i.id === id))
    .filter((i): i is Card['items'][number] => !!i);
  // Drag to reorder (any input), rows gliding aside on the heavy spring.
  const rowsRef = useRef<HTMLDivElement>(null);
  const { drag: itemDrag, begin: beginItemDrag } = useItemDrag(card.id, rowsRef);
  useListFlip(
    rowsRef,
    '.dt-row-wrap[data-flip-id]',
    `${order.join()}|${itemDrag?.id ?? ''}:${itemDrag?.beforeId ?? ''}`,
  );
  const slot = itemDrag ? <div key="__slot" className="dt-row-slot" aria-hidden /> : null;
  // Where the slot goes: before its target row, or after the last row.
  const slotAfter =
    itemDrag && !itemDrag.beforeId ? ([...rows].reverse().find((i) => i.id !== itemDrag.id)?.id ?? null) : null;
  // §11.3 item exit: keep removed rows 120 ms; "Clear checked" staggers bottom-up.
  const presentRows = usePresence(rows, (i) => i.id, 240, card.id);
  const leavingCount = presentRows.filter((r) => r.leaving).length;

  const checked = card.items.filter((i) => i.done).length;
  const [listMenuOpen, setListMenuOpen] = useState(false);
  const listMenuPresence = useDropdownPresence(listMenuOpen);
  const closeListMenu = useCallback(() => setListMenuOpen(false), []);

  // "Clear checked": the checked rows collapse (bottom-up, 30 ms apart) and then go in one write.
  const clearing = useRef(false);
  const clearCheckedSmoothly = () => {
    if (clearing.current) return;
    const ids = card.items.filter((i) => i.done).map((i) => i.id);
    const wraps = ids
      .map(
        (id) =>
          rootRef.current
            ?.querySelector<HTMLElement>(`[data-testid="item-${id}"]`)
            ?.closest<HTMLElement>('.dt-row-wrap') ?? null,
      )
      .filter((w): w is HTMLElement => !!w);
    if (!wraps.length) {
      store.clearChecked(card.id);
      return;
    }
    clearing.current = true;
    let left = wraps.length;
    wraps.forEach((w, i) =>
      collapseThen(
        w,
        () => {
          if (--left > 0) return;
          clearing.current = false;
          ids.forEach(markSlidOut);
          store.clearChecked(card.id);
        },
        Math.min(wraps.length - 1 - i, 8) * 30,
      ),
    );
  };
  const total = card.items.length;
  // ---- menu -------------------------------------------------------------------------
  const [menuOpen, setMenuOpen] = useState(false);
  const menuPresence = useDropdownPresence(menuOpen);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    menuBtn.current?.focus();
  }, []);
  const copyAsText = async () => {
    try {
      await navigator.clipboard.writeText(composeCard(card));
      store.showToast(copy.copied());
    } catch {
      /* clipboard blocked: nothing to say (§15.1 has no copy for it) */
    }
  };
  const del = () => {
    onClose();
    store.deleteCardById(card.id);
  };

  const [crumbsOpen, setCrumbsOpen] = useState(false);
  useEffect(() => setCrumbsOpen(false), [card.id]);

  // ---- labels + links ------------------------------------------------------------------
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerPresence = useDropdownPresence(pickerOpen);
  const [reminderOpen, setReminderOpen] = useState(false);
  useEffect(() => {
    setPickerOpen(false);
    setReminderOpen(false);
  }, [card.id]);
  const addLabelBtn = useRef<HTMLButtonElement>(null);
  const closePicker = useCallback(() => setPickerOpen(false), []);
  const pills = cardLabels(card, store.labels);
  /** A link dropped or pasted on the panel: a markdown line at the end of the body, titled when the page answers. */
  const appendLink = (url: string) => {
    const host = (() => {
      try {
        return new URL(url).hostname.replace(/^www\./, '');
      } catch {
        return url;
      }
    })();
    const base = pending.current?.notes ?? card.notes;
    const line = `[${host.replace(/[[\]]/g, '')}](${mdUrl(url)})`;
    onNotesChange(base.trim() ? `${base.replace(/\s+$/, '')}\n${line}` : line);
    flushNotes();
    void pageTitleFor(url).then((t) => {
      if (!t) return;
      const now = state.board.cards.find((c) => c.id === card.id)?.notes ?? '';
      if (now.includes(line)) actions.updateCardNotes(card.id, now.replace(line, `[${t.replace(/[[\]\n]/g, '')}](${mdUrl(url)})`));
    });
  };

  // ---- phone sheet: drag to close, keyboard-aware height (§8, §9.1, §11.5) ----------
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ y0: number; y: number; t: number; v: number } | null>(null);
  const onHandleDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { y0: e.clientY, y: e.clientY, t: performance.now(), v: 0 };
    setDragging(true);
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or released pointer */
    }
  };
  const onHandleMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const now = performance.now();
    const dt = Math.max(1, now - d.t);
    d.v = ((e.clientY - d.y) / dt) * 1000;
    d.y = e.clientY;
    d.t = now;
    const dy = e.clientY - d.y0;
    setDragY(dy >= 0 ? dy : dy * 0.3); // rubber-band above max height
  };
  const onHandleUp = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d) return;
    const h = sheetRef.current?.getBoundingClientRect().height ?? 1;
    const dy = d.y - d.y0;
    if (d.v > 600 || dy > h * 0.6)
      onClose(); // below 40 % remaining, or fast flick
    else setDragY(0);
  };
  const [kbFocus, setKbFocus] = useState(false);
  const onFocusIn = (e: React.FocusEvent) => {
    const t = e.target as HTMLElement;
    if (!phone) return;
    if (t.matches('input, textarea')) {
      setKbFocus(true);
      requestAnimationFrame(() => t.scrollIntoView({ block: 'nearest' }));
    }
  };
  const onFocusOut = (e: React.FocusEvent) => {
    if (!phone) return;
    const next = e.relatedTarget as HTMLElement | null;
    if (!next || !next.matches('input, textarea')) setKbFocus(false);
  };

  const ariaName = `${displayTitle(card)}, ${card.kind === 'note' ? 'note' : 'to do'}${total ? `, ${checked} of ${total} items` : ''}`;

  // Files dropped on the panel, or pasted (⌘V an image or a file), attach to this card.
  const [dropping, setDropping] = useState(false);
  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const editableTarget = (target: EventTarget) =>
    (target as HTMLElement).closest('input,textarea,[contenteditable="true"]');
  const acceptedUrl = (raw: string) => {
    const url = raw.trim();
    return !/\s/.test(url) && isHttpUrl(url) ? url : null;
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (ro) return;
    const files = Array.from(e.clipboardData.files);
    if (files.length) {
      e.preventDefault();
      void insertFiles(files);
      return;
    }
    if (editableTarget(e.target)) return;
    const url = acceptedUrl(e.clipboardData.getData('text/plain'));
    if (url) {
      e.preventDefault();
      appendLink(url);
    }
  };

  const shownRows = presentRows.filter(
    ({ item: it, leaving }) => !(leaving && slidOutRecently(it.id)),
  );
  const addItems = !ro && (
    <AddItemsField cardId={card.id} hasItems={total > 0} phone={phone} autoFocus={false} />
  );
  const [editItemId, setEditItemId] = useState<string | null>(null); // the item an Enter just split off
  // A ref row shows the linked card as it is now; the stored text only if it is gone.
  const linkedOf = (id: string, fallback: string) => {
    const c = store.cards.find((x) => x.id === id);
    const kind = c?.kind === 'note' ? 'note' : 'to do';
    return {
      title: c ? displayTitle(c) : fallback,
      tag: c && c.items.length ? `${c.items.filter((x) => x.done).length}/${c.items.length} · ${kind}` : kind,
      onOpen: () => (onOpenChild ?? onOpenCard)(id),
    };
  };
  const renderChecklistRow = ({ item: it, leaving, leaveIndex }: (typeof shownRows)[number]) =>
    leaving ? (
      <div
        key={it.id}
        className={`dt-row-exit${it.done ? ' done' : ''}`}
        style={{ animationDelay: `${Math.min(leavingCount - 1 - leaveIndex, 8) * 30}ms` }}
        aria-hidden
      >
        <span className="dt-row-exit-text">{plainText(it.text)}</span>
      </div>
    ) : ro ? (
      <ChecklistRowView key={it.id} item={it} />
    ) : (
      <Fragment key={it.id}>
        {(itemDrag?.beforeId === it.id ||
          (itemDrag?.id === it.id && !itemDrag.beforeId && !slotAfter)) &&
          slot}
        <ChecklistRow
          item={it}
          phone={phone}
          enterIndex={entering.get(it.id) ?? -1}
          hidden={itemDrag?.id === it.id}
          onToggle={() => store.toggleItem(card.id, it.id)}
          onEdit={(text) => store.editItem(card.id, it.id, text)}
          onSplit={(before, after) => {
            const id = store.splitItem(card.id, it.id, before, after);
            if (id) setEditItemId(id);
          }}
          editOnMount={editItemId === it.id}
          onEditStarted={() => setEditItemId(null)}
          onDelete={() => store.deleteItem(card.id, it.id)}
          onPromote={() => {
            actions.promoteItem(card.id, it.id);
          }}
          onDragStart={beginItemDrag}
          onNudge={(dir) => store.nudgeItem(card.id, it.id, dir)}
          linked={it.ref ? linkedOf(it.ref, it.text) : undefined}
        />
        {slotAfter === it.id && slot}
      </Fragment>
    );
  const footer = (
    <footer className="dt-foot">
      <span className="mono dt-dates">
        added {relativeDate(card.createdAt)}
        {done && card.completedAt && <> · done {relativeDate(card.completedAt)}</>}
        {card.via === 'siri' ? ' · via Siri' : card.via === 'share' ? ' · via share sheet' : ''}
      </span>
      {!ro && (
        <button type="button" className="dt-link danger" onClick={del}>
          Delete
        </button>
      )}
    </footer>
  );
  const content = (
    <div
      className={`dt-content ${fade}${dropping ? ' dropping' : ''}`}
      key={shownId}
      data-drop-hint={ro ? undefined : attachCopy.drop}
      onDragOver={(e) => {
        if (
          ro ||
          (!hasFiles(e) &&
            (editableTarget(e.target) ||
              !Array.from(e.dataTransfer.types).some(
                (t) => t === 'text/uri-list' || t === 'text/plain',
              )))
        )
          return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        if (ro) return;
        setDropping(false);
        if (hasFiles(e)) {
          e.preventDefault();
          if (e.dataTransfer.files.length) void insertFiles(Array.from(e.dataTransfer.files));
          return;
        }
        if (editableTarget(e.target)) return;
        const url = acceptedUrl(
          e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'),
        );
        if (url) {
          e.preventDefault();
          appendLink(url);
        }
      }}
    >
      <div className="dt-top">
        <Ring card={card} showChecklistProgress readOnly={ro} onClick={() => store.cycleRing(card.id)} />
        {newId.current === card.id && <span className="dt-new mono">{card.kind === 'todo' ? 'New to do' : 'New note'}</span>}
        <div className="dt-top-actions">
          {onAskAssistant && !phone && (
            <button type="button" className="dt-ask" data-testid="detail-assistant" onClick={onAskAssistant} aria-label="Ask the assistant about this card" title="Ask the assistant">
              <AssistantSparkle size={18} />
            </button>
          )}
          {!ro && (
            <div className="dt-menu-anchor">
              <button
                ref={menuBtn}
                type="button"
                className="dt-more"
                aria-label="Card menu"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <MoreIcon />
              </button>
              {menuPresence.mounted && (
                <CardMenu
                  card={card}
                  closing={menuPresence.closing}
                  onClose={closeMenu}
                  onSomeday={() => store.placeCard(card.id, 'note')}
                  onRepeat={() => store.toggleRepeat(card.id)}
                  onDuplicate={() => {
                    const id = store.duplicate(card.id);
                    if (id) onOpenCard(id);
                  }}
                  onMoveToTop={() => store.moveToTop(card.id)}
                  onCopy={() => void copyAsText()}
                  onArchive={() => {
                    onClose();
                    store.archiveCard(card.id);
                  }}
                  onDelete={del}
                  onAsk={phone ? onAskAssistant : undefined}
                />
              )}
            </div>
          )}
          {phone && (
            <button type="button" className="dt-sheet-close" data-testid="detail-close" onClick={onClose} aria-label="Close">
              <CloseIcon size={20} />
            </button>
          )}
          {!phone && (
            <button
              type="button"
              className="dt-esc dt-float-close"
              data-testid="detail-close"
              onClick={onClose}
              aria-label="Close"
              title="Close · Esc"
            >
              <CloseIcon size={18} />
            </button>
          )}
        </div>
      </div>

      {visibleCrumbs.length > 0 && (
        <nav className="dt-crumbs" aria-label="Breadcrumb">
          {visibleCrumbs.map((id, i) => {
            // §11.24.6: past three levels the middle crumbs fold into one `…`.
            const fold = visibleCrumbs.length > 2 && !crumbsOpen && i > 0 && i < visibleCrumbs.length - 1;
            if (fold && i > 1) return null;
            if (fold)
              return (
                <button key="fold" type="button" className="dt-crumb" aria-label="Show the hidden levels" onClick={() => setCrumbsOpen(true)}>
                  …<span aria-hidden>›</span>
                </button>
              );
            const c = store.cards.find((x) => x.id === id);
            return (
              <button key={id} type="button" className="dt-crumb" onClick={() => crumbs?.length ? onCrumb?.(i) : onOpenCard(id)}>
                {c ? displayTitle(c) : 'Gone'}
                <span aria-hidden>›</span>
              </button>
            );
          })}
          <span className="dt-crumb-here" aria-current="page" title={displayTitle(card)}>
            {displayTitle(card)}
          </span>
        </nav>
      )}

      <div className="dt-head">
        <div className="dt-title-row">
          {ro ? (
            <h2 className={`dt-title ro-title${done ? ' done' : ''}`} data-testid="detail-title">
              {linkify(displayTitle(card))}
            </h2>
          ) : (
            <input
              className={`dt-title${done ? ' done' : ''}`}
              data-testid="detail-title"
              value={title}
              placeholder="Add a title" // the body shows in full below; its first line is the title elsewhere
              enterKeyHint="done"
              autoCapitalize="sentences"
              maxLength={200}
              aria-label="Title"
              onChange={(e) => {
                titleTyped.current = true;
                const value = e.target.value.replace(/\n/g, ' ');
                setTitle(value);
                store.setTitle(card.id, value);
              }}
              onFocus={() => {
                titleFocused.current = true;
              }}
              onBlur={() => {
                titleFocused.current = false;
                saveTitle();
              }}
              onKeyDown={(e) => {
                if (isActionEnter(e)) {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                  bodyRef.current?.focus();
                }
              }}
            />
          )}
        </div>
        {card.titleBy === 'ai' && card.title && !ro && (
          <span className="dt-ai-chip mono">
            <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden>
              <path d="M12 3c.6 4.6 3.4 7.4 8 8-4.6.6-7.4 3.4-8 8-.6-4.6-3.4-7.4-8-8 4.6-.6 7.4-3.4 8-8z" />
            </svg>
            suggested title · edit to keep your own
          </span>
        )}
        <div className="dt-chips">
          {pills.map((l) => (
            <LabelPill key={l.id} label={l} onRemove={ro ? undefined : () => store.toggleCardLabel(card.id, l.id)} />
          ))}
          {suggested && !ro && (
            <SuggestedPill label={suggested} className="dt-suggest" onAccept={() => store.acceptSuggestedLabel(card.id)} />
          )}
          {!ro && (
            <div className="dt-labels-anchor">
              <button
                ref={addLabelBtn}
                type="button"
                className="dt-chip-btn"
                aria-haspopup="dialog"
                aria-expanded={pickerOpen}
                data-testid="detail-add-label"
                onClick={() => {
                  setReminderOpen(false);
                  setPickerOpen((v) => !v);
                }}
              >
                + Label
              </button>
              {pickerPresence.mounted && (
                <LabelPicker
                  closing={pickerPresence.closing}
                  labels={store.labels}
                  selected={card.labels}
                  trigger={addLabelBtn}
                  onClose={closePicker}
                  onToggle={(id) => store.toggleCardLabel(card.id, id)}
                  onCreate={(name, color) => store.createLabel(name, color, card.id)}
                />
              )}
            </div>
          )}
          {ro ? (
            <ReminderText card={card} />
          ) : (
            <ReminderRow
              openOverride={reminderOpen}
              onOpenChange={(v) => {
                setPickerOpen(false);
                setReminderOpen(v);
              }}
              card={card}
              onSet={(iso) => store.setReminder(card.id, iso)}
              onEvery={(every) => store.setRemindEvery(card.id, every)}
              onNotify={(notify) => store.setReminderNotify(card.id, notify)}
            />
          )}
        </div>
      </div>

      <MarkdownBody
        ref={bodyRef}
        card={card}
        value={notes}
        readOnly={ro}
        onChange={onNotesChange}
        onCommit={flushNotes}
        onFinish={finishNotes}
        onFiles={(files, at) => void insertFiles(files, at)}
        titleFor={pageTitleFor}
        startAtEnd={startAtEnd}
      />

      {(!ro || total > 0) && (
        <section className="dt-checklist" aria-label="Checklist">
          <div className="dt-checklist-head">
            <span className="dt-section-title">Checklist</span>
            <span className="dt-progress mono" aria-live="polite">
              <Roll value={checked} />/<Roll value={total} />
            </span>
            {checked > 0 && !ro && (
              <div className="dt-menu-anchor">
                <button
                  type="button"
                  className="dt-list-more"
                  aria-label="Checklist actions"
                  aria-haspopup="menu"
                  aria-expanded={listMenuOpen}
                  onClick={() => setListMenuOpen((v) => !v)}
                >
                  <MoreIcon size={18} />
                </button>
                {listMenuPresence.mounted && (
                  <ChecklistMenu
                    closing={listMenuPresence.closing}
                    checked={checked}
                    onClose={closeListMenu}
                    onUncheckAll={() => store.uncheckAllAction(card.id)}
                    onClear={clearCheckedSmoothly}
                  />
                )}
              </div>
            )}
          </div>
          <div className="dt-rows" ref={rowsRef}>
            {shownRows.map((p) => (
              <Fragment key={p.item.id}>{renderChecklistRow(p)}</Fragment>
            ))}
            {addItems}
          </div>
        </section>
      )}

      {!ro && (currentRoom()?.id === currentAccount()?.personalRoom || currentRoom()?.bot === 'sherlock') && <SherlockHandoff key={card.id} card={card} beforeSend={flushNotes} />}
      {!ro && <BotDelegation key={`bots:${card.id}`} card={card} beforeSend={flushNotes} />}

      {parents.length > 0 && (
        <section className="dt-item-of" aria-label="Item of">
          <div className="dt-checklist-head">
            <span className="dt-section-title">Item of</span>
          </div>
          {parents.map((p) => (
            <button key={p.id} type="button" className="dt-parent" onClick={() => onOpenCard(p.id)}>
              <span className="ref-tag mono">{p.kind === 'note' ? 'note' : p.status === 'todo' ? 'to do' : p.status}</span>
              <span className="dt-parent-title">{displayTitle(p)}</span>
              <span aria-hidden>›</span>
            </button>
          ))}
        </section>
      )}
    </div>
  );

  if (phone) {
    return (
      <div className="dt-sheet-root" onKeyDown={onKeyDown} onFocus={onFocusIn} onBlur={onFocusOut}>
        <div
          ref={(el) => {
            (rootRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
            (sheetRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
          }}
          data-theme="tint-dark" data-panel="ink"
          className={`dt-sheet${newId.current === card.id ? ' creating' : ''}${dragging ? ' dragging' : ''}${kbFocus ? ' kb' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label={ariaName}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          style={{ transform: dragY ? `translateY(${dragY}px)` : undefined }}
        >
          <div
            className="dt-handle"
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={() => {
              drag.current = null;
              setDragging(false);
              setDragY(0);
            }}
            aria-hidden
          >
            <span />
          </div>
          <div className="dt-scroll">{content}</div>
          {footer}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-theme="tint-dark" data-panel="ink"
      className={`dt-panel${newId.current === card.id ? " creating" : ""}`}
      onPaste={onPaste}
      role="dialog"
      aria-modal={newId.current === card.id || undefined}
      aria-label={ariaName}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="dt-scroll">{content}</div>
      {footer}
    </div>
  );
}
