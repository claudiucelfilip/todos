import { LabelPill } from './Labels';
import { boardColumns, belongsToColumn, workflowColumn } from '../lib/board-columns';
import { dotVars, INBOX_FILTER } from '../lib/labels';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Card, CardStatus } from '../lib/types';
import { actions, state, useStore } from '../hooks/useStore';
import { checklistDropTarget, isChecklistDropCenter, markChecklistDrop } from '../lib/card-drop';
import { canMoveTo } from '../lib/reducer';
import { searchMatches } from '../lib/search';
import { passesLabelFilter } from '../lib/labels';
import { useFlip } from '../lib/flip';
import { SPRINGS, springCurve, springKeyframes } from '../lib/spring';
import { isQuiet } from '../lib/seen';
import { slidOutRecently } from '../lib/slid';
import { copy, shareCopy } from '../lib/copy';
import { collapseThen, expandFrom, springAnimate } from '../lib/motion';
import { dragMode, edgeScroll, hoverSwitch, type HoverState } from '../lib/input';
import { staggerIndex, usePresence, instantMotion, type Present } from '../lib/presence';
import CardFace from './CardFace';
import PhoneNav, { type PhoneColumn } from './PhoneNav';
import Roll from './Roll';

// Each column filters notes by a workflow label. Dragging replaces that label.

interface Props {
  query: string;
  openCardId: string | null;
  detailVisible?: boolean;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onOpenCard(id: string, restore?: boolean): void;
  phone: boolean;
  column: string;
  onColumnChange(s: string): void;
  onOpenArchive(): void;
  /** The phone's Notes tab. */
  onShowNotes?(): void;
  /** Phone: the selected tab, and switching tabs within the Board view. */
  phoneTab?: PhoneColumn;
  onPhoneTab?(t: PhoneColumn): void;
}

const DRAG_THRESHOLD = 6;
const LONG_PRESS_MS = 350;
const EDGE_PX = 24;
const EDGE_SWAP_MS = 500;
const EXIT_MS = 200;
const TAB_HOLD_MS = 500;

interface DragOver {
  parentId?: string;
  blocked?: boolean;
  status: string;
  beforeId: string | null;
  someday: boolean;
}
interface DragState {
  id: string;
  from: string;
  over: DragOver | null;
  settling: boolean;
}

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** The element's rect with any current CSS transform (FLIP mid-flight) removed. */
function untransformedRect(el: HTMLElement): { top: number; height: number } {
  const r = el.getBoundingClientRect();
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return { top: r.top, height: r.height };
  try {
    const m = new DOMMatrixReadOnly(t);
    return { top: r.top - m.m42, height: r.height };
  } catch {
    return { top: r.top, height: r.height };
  }
}

export default function Board({
  query,
  openCardId,
  detailVisible = !!openCardId,
  selectedId,
  onSelect,
  onOpenCard,
  phone,
  column,
  onColumnChange,
  onOpenArchive,
  onShowNotes,
  phoneTab = column,
  onPhoneTab,
}: Props) {
  const store = useStore();
  const rootRef = useRef<HTMLElement>(null);
  const resizeAnimations = useRef<Animation[]>([]);
  const beforeColumns = phone ? [] : Array.from(
    rootRef.current?.querySelectorAll<HTMLElement>('.column') ?? [],
  ).map((el) => ({ el, rect: el.getBoundingClientRect() }));
  useLayoutEffect(() => {
    resizeAnimations.current.forEach((a) => a.cancel());
    resizeAnimations.current = [];
    if (phone || instantMotion() || isQuiet()) return;
    beforeColumns.forEach(({ el, rect: from }) => {
      const to = el.getBoundingClientRect();
      if (!to.width || Math.abs(from.width - to.width) < 1) return;
      const dx = from.left - to.left;
      const { keyframes, ms } = springKeyframes(SPRINGS.gentle, (p) => ({
        transform: `translateX(${dx * (1 - p)}px)`,
        opacity: Math.min(1, 0.72 + 0.28 * p),
      }));
      const animation = el.animate(keyframes, { duration: ms, easing: 'linear' });
      resizeAnimations.current.push(animation);
    });
  }, [detailVisible, phone]);

  const counts = store.counts();
  const archivedCount = store.cards.filter((c) => c.archivedAt).length;
  const cardOf = (id: string) => store.cards.find((c) => c.id === id);
  const filter = store.labelFilter;
  const columnOf = store.visibleColumn;
  const visible = boardColumns(store.labels, filter);
  const ORDER = visible.map((c) => c.status);
  const shownCounts = Object.fromEntries(visible.map((c) => [c.status, columnOf(c.status).length]));
  // §4.4: archived matches appear in a temporary fourth group only while a query is active.
  const q = query.trim();
  const archivedMatches = q
    ? store.cards.filter(
        (c) =>
          c.archivedAt && passesLabelFilter(c, filter) && searchMatches(c, query, store.labels),
      )
    : [];
  const phoneArchived = phoneTab === 'archived';
  useEffect(() => {
    if (phoneArchived && !archivedMatches.length) onPhoneTab?.(column);
  }, [archivedMatches.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [edge, setEdge] = useState<'left' | 'right' | null>(null);

  // ---- rejected-drop feedback (§11.8) ----------------------------------------
  const [shake, setShake] = useState<CardStatus | null>(null);
  const [hint, setHint] = useState<CardStatus | null>(null);
  // Rejected drop: header shake + hint, and the same toast as the status control.
  const reject = (status: CardStatus) => {
    store.showToast(copy.checkAllRejected());
    setShake(status);
    setHint(status);
    setTimeout(() => setShake(null), 300);
    setTimeout(() => setHint(null), 2000);
  };

  // ---- desktop drag and drop --------------------------------------------------
  const [drag, setDrag] = useState<DragState | null>(null);
  // Cards glide only when what the board shows changes, never on an incidental re-render (a font swap).
  const flipKey = useMemo(
    () => ({}),
    [store.cards, column, phone, query, store.labelFilter, store.somedayOpen, drag],
  );
  useFlip(rootRef, flipKey, !phone);
  const dragRef = useRef<{
    id: string;
    from: string;
    startX: number;
    startY: number;
    offX: number;
    offY: number;
    rect: DOMRect;
    active: boolean;
    ghost: HTMLElement | null;
    x: number;
    y: number;
    gx: number;
    gy: number;
    raf: number;
    over: DragOver | null;
    lastMoveX: number;
    touch: boolean;
    pressTimer: ReturnType<typeof setTimeout> | null;
    edgeTimer: ReturnType<typeof setTimeout> | null;
    edge: 'left' | 'right' | null;
    edgeArmed: boolean; // D4: one swap per visit to the edge zone
    art: HTMLElement;
    tabHover: HoverState | null;
    tabEl: HTMLElement | null;
  } | null>(null);
  const checklistTarget = useRef<HTMLElement | null>(null);
  const scrollCue = useRef<HTMLElement | null>(null);
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  const columnRef = useRef(column);
  columnRef.current = column;
  const preventTouchScroll = useRef((e: TouchEvent) => {
    if (dragRef.current?.active) e.preventDefault();
  }).current;

  const stopLoop = () => {
    if (dragRef.current?.raf) cancelAnimationFrame(dragRef.current.raf);
  };
  // Stable window listeners that always call the latest handlers.
  const handlers = useRef<{ move(e: PointerEvent): void; up(): void; cancel(): void }>({ move() {}, up() {}, cancel() {} });
  const moveProxy = useRef((e: PointerEvent) => handlers.current.move(e)).current;
  const upProxy = useRef(() => handlers.current.up()).current;
  const cancelProxy = useRef(() => handlers.current.cancel()).current;
  const keyProxy = useRef((e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !dragRef.current?.active) return;
    e.preventDefault();
    e.stopPropagation();
    handlers.current.cancel();
  }).current;

  const computeOver = useCallback(
    (x: number, y: number, d: NonNullable<typeof dragRef.current>): DragOver | null => {
      const under = document.elementFromPoint(x, y);
      const candidate = under?.closest<HTMLElement>('article[data-card-id]') ?? null;
      const target = checklistDropTarget(candidate, x, y, d.id, state.board.cards);
      checklistTarget.current = markChecklistDrop(checklistTarget.current, target);
      const hit = under?.closest<HTMLElement>('.column');
      if (!hit) return null;
      const status = hit.dataset.status!;
      if (target) return { status, beforeId: null, someday: false, parentId: target.dataset.cardId };
      if (isChecklistDropCenter(candidate, x, y)) return { status, beforeId: null, someday: false, blocked: true };
      if (status === INBOX_FILTER || status === 'archived') return null;
      // To do: below the divider's midline is the Someday region.
      const divider = status === 'todo' ? hit.querySelector<HTMLElement>('.someday-divider') : null;
      const dr = divider?.getBoundingClientRect();
      const someday = !!dr && y >= dr.top + dr.height / 2;
      const cards = Array.from(hit.querySelectorAll<HTMLElement>('article[data-card-id]')).filter(
        (el) =>
          el.dataset.cardId !== d.id &&
          el.style.display !== 'none' &&
          el.classList.contains('someday') === someday,
      );
      let beforeId: string | null = null;
      for (const el of cards) {
        // O1: measure the layout position, not a FLIP transform in flight.
        const r = untransformedRect(el);
        if (y < r.top + r.height / 2) {
          beforeId = el.dataset.cardId!;
          break;
        }
      }
      return { status, beforeId, someday };
    },
    [],
  );

  const endDrag = useCallback((commit = true) => {
    const d = dragRef.current;
    if (!d) return;
    window.removeEventListener('pointermove', moveProxy);
    window.removeEventListener('pointerup', upProxy);
    window.removeEventListener('pointercancel', cancelProxy);
    window.removeEventListener('keydown', keyProxy, true);
    window.removeEventListener('touchmove', preventTouchScroll);
    if (d.pressTimer) clearTimeout(d.pressTimer);
    if (d.edgeTimer) clearTimeout(d.edgeTimer);
    setEdge(null);
    stopLoop();
    if (scrollCue.current) delete scrollCue.current.dataset.dragScroll;
    scrollCue.current = null;
    document.body.classList.remove('dragging');
    d.art.classList.remove('pressing');
    d.tabEl?.classList.remove('drag-hover');
    checklistTarget.current = markChecklistDrop(checklistTarget.current, null);
    dragRef.current = null;
    if (!d.active) return;
    const ghost = d.ghost;
    const finish = () => {
      // Show the real card in this same frame, then drop the ghost: never a frame with neither.
      flushSync(() => setDrag(null));
      ghost?.remove();
    };
    const card = cardOf(d.id);
    const over = commit && !d.over?.blocked ? d.over : null;
    if (card && over?.parentId) {
      actions.linkCard(over.parentId, d.id);
      finish();
      return;
    }
    const rejected = !!card && !!over && !canMoveTo(card, workflowColumn(over.status) ?? card.status);
    if (!card || !over || rejected) {
      if (rejected && over) reject(workflowColumn(over.status) ?? card!.status);
      // Spring back to the origin slot.
      if (ghost) {
        ghost.classList.add('drag-return');
        const dx = d.gx - d.rect.left,
          dy = d.gy - d.rect.top;
        springAnimate(ghost, SPRINGS.release, (p) => ({
          transform: `translate(${dx * (1 - p)}px,${dy * (1 - p)}px) scale(${1.04 - 0.04 * p})`,
        }));
        setTimeout(finish, springCurve(SPRINGS.release).ms);
      } else finish();
      return;
    }
    // A collapsed Someday has no slot: the card lands on the divider.
    const slot = rootRef.current?.querySelector<HTMLElement>(
      '.drop-placeholder, .someday-divider.drop-into',
    );
    const target = slot?.getBoundingClientRect() ?? d.rect;
    store.dropInColumn(d.id, over.beforeId, over.status, over.someday);
    setDrag((s) => (s ? { ...s, settling: true } : s));
    if (ghost) {
      ghost.classList.add('drag-drop');
      const dx = d.gx - d.rect.left,
        dy = d.gy - d.rect.top;
      springAnimate(ghost, SPRINGS.release, (p) => ({
        transform: `translate(${dx + (target.left - d.rect.left - dx) * p}px,${dy + (target.top - d.rect.top - dy) * p}px) scale(${1.04 - 0.04 * p})`,
      }));
      setTimeout(finish, springCurve(SPRINGS.release).ms); // the drop settles on the release spring
    } else finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  const lift = useCallback(() => {
    const d = dragRef.current;
    if (!d || d.active) return;
    {
      const art = document.contains(d.art) ? d.art : null;
      if (!art) return;
      d.active = true;
      d.art.classList.remove('pressing');
      // O1: settle any FLIP transform still in flight so visual == layout while dragging.
      // A running transition survives clearing `transition`, so snap it via an explicit value.
      rootRef.current?.querySelectorAll<HTMLElement>('article[data-card-id]').forEach((n) => {
        n.style.transition = 'none';
        n.style.transform = 'none';
        void n.offsetHeight;
        n.style.transform = '';
        n.style.transition = '';
        n.classList.remove('flip-flying');
      });
      d.rect = art.getBoundingClientRect();
      d.offX = Math.min(Math.max(d.startX - d.rect.left, 0), d.rect.width);
      d.offY = Math.min(Math.max(d.startY - d.rect.top, 0), d.rect.height);
      document.body.classList.add('dragging');
      if (d.touch) {
        window.addEventListener('touchmove', preventTouchScroll, { passive: false });
        if (navigator.vibrate) navigator.vibrate(10);
      }
      const ghost = art.cloneNode(true) as HTMLElement;
      ghost.classList.add('drag-ghost');
      ghost.classList.remove('open', 'selected', 'entering', 'pulse');
      ghost.removeAttribute('data-testid');
      ghost.removeAttribute('data-card-id');
      ghost.style.width = `${d.rect.width}px`;
      ghost.style.height = `${d.rect.height}px`;
      ghost.style.left = `${d.rect.left}px`;
      ghost.style.top = `${d.rect.top}px`;
      (document.querySelector('.app') ?? document.body).appendChild(ghost);
      d.ghost = ghost;
      d.gx = d.rect.left;
      d.gy = d.rect.top;
      requestAnimationFrame(() => ghost.classList.add('lifted'));
      const someday = art.classList.contains('someday');
      const region = Array.from(
        (
          art.closest('.someday-list') ?? art.closest('.column-body')
        )?.querySelectorAll<HTMLElement>('article[data-card-id]') ?? [],
      ).filter((n) => n.classList.contains('someday') === someday);
      const next = region[region.indexOf(art) + 1];
      d.over = { status: d.from, beforeId: next?.dataset.cardId ?? null, someday };
      setDrag({ id: d.id, from: d.from, over: d.over, settling: false });
      const loop = () => {
        const dd = dragRef.current;
        if (!dd || !dd.ghost) return;
        // 1-frame lag: interpolate .35 per frame toward the pointer.
        const tx = dd.x - dd.offX;
        const ty = dd.y - dd.offY;
        dd.gx += (tx - dd.gx) * 0.35;
        dd.gy += (ty - dd.gy) * 0.35;
        dd.ghost.style.transform = `translate(${dd.gx - dd.rect.left}px,${dd.gy - dd.rect.top}px) scale(1.04) rotate(var(--rot))`;
        const vx = Math.max(-1, Math.min(1, (dd.x - dd.lastMoveX) / 20));
        dd.ghost.style.setProperty('--rot', `${(vx * 0.6).toFixed(2)}deg`);
        const over = computeOver(dd.x, dd.y, dd);
        if (
          !!over?.blocked !== !!dd.over?.blocked ||
          (over?.parentId ?? null) !== (dd.over?.parentId ?? null) ||
          (over?.status ?? null) !== (dd.over?.status ?? null) ||
          (over?.beforeId ?? null) !== (dd.over?.beforeId ?? null) ||
          !!over?.someday !== !!dd.over?.someday
        ) {
          dd.over = over;
          setDrag((s) => (s ? { ...s, over } : s));
        }
        // Auto-scroll near the scroller's visible edges (§11.8): the phone list, or the column under the pointer.
        const scroller = phoneRef.current
          ? rootRef.current?.querySelector<HTMLElement>('.column:not([data-away]) .column-body')
          : document.elementFromPoint(dd.x, dd.y)
              ?.closest('.column')
              ?.querySelector<HTMLElement>('.column-body');
        if (scroller) {
          if (scrollCue.current && scrollCue.current !== scroller) delete scrollCue.current.dataset.dragScroll;
          scrollCue.current = scroller;
          const r = scroller.getBoundingClientRect();
          // On phone the composer floats over the list's bottom: the usable edge is its top.
          const floor = phoneRef.current
            ? (document.querySelector('.composer-layer')?.getBoundingClientRect().top ?? Infinity)
            : Infinity;
          const inside = dd.x >= r.left && dd.x <= r.right && dd.y >= r.top && dd.y <= r.bottom;
          const v = inside ? edgeScroll(dd.y, Math.max(r.top, 0), Math.min(r.bottom, window.innerHeight, floor), 96, 10) : 0;
          const before = scroller.scrollTop;
          if (v) scroller.scrollTop += v;
          scroller.dataset.dragScroll = scroller.scrollTop !== before ? v < 0 ? 'top' : 'bottom' : '';
        } else if (scrollCue.current) {
          delete scrollCue.current.dataset.dragScroll;
          scrollCue.current = null;
        }
        // Phone: holding over a column tab for 500 ms switches to it, so the card can drop there.
        if (dd.touch && phoneRef.current) {
          const tab =
            document
              .elementFromPoint(dd.x, dd.y)
              ?.closest<HTMLElement>('.phone-column-pills [data-testid^="nav-"]') ?? null;
          const st = tab?.dataset.testid?.slice(4) as string | undefined;
          const target = st && ORDER.includes(st) && st !== columnRef.current ? st : null;
          if (dd.tabEl !== (target ? tab : null)) {
            dd.tabEl?.classList.remove('drag-hover');
            dd.tabEl = target ? tab : null;
            dd.tabEl?.classList.add('drag-hover');
          }
          const hs = hoverSwitch(dd.tabHover, target, performance.now(), TAB_HOLD_MS);
          dd.tabHover = hs.state;
          if (hs.fire) {
            onColumnChange(hs.fire);
            dd.over = { status: hs.fire, beforeId: null, someday: false };
            setDrag((s) => (s ? { ...s, over: dd.over } : s));
          }
        }
        // Phone: holding at a screen edge swaps the visible column after 400 ms (§7.7).
        if (dd.touch && phoneRef.current) {
          const w = window.innerWidth;
          const at: 'left' | 'right' | null =
            dd.x < EDGE_PX ? 'left' : dd.x > w - EDGE_PX ? 'right' : null;
          if (at === null) dd.edgeArmed = true;
          if (at !== dd.edge) {
            dd.edge = at;
            setEdge(at && dd.edgeArmed ? at : null);
            if (dd.edgeTimer) clearTimeout(dd.edgeTimer);
            dd.edgeTimer = null;
            if (at && dd.edgeArmed) {
              dd.edgeArmed = false; // re-arms only after the finger leaves the edge zone
              dd.edgeTimer = setTimeout(() => {
                const i = ORDER.indexOf(columnRef.current);
                const next = ORDER[i + (at === 'right' ? 1 : -1)];
                if (next) {
                  onColumnChange(next);
                  dd.over = { status: next, beforeId: null, someday: false };
                  setDrag((s) => (s ? { ...s, over: dd.over } : s));
                }
                dd.edge = null;
                setEdge(null);
              }, EDGE_SWAP_MS);
            }
          }
        }
        dd.raf = requestAnimationFrame(loop);
      };
      d.raf = requestAnimationFrame(loop);
    }
  }, [computeOver, onColumnChange, preventTouchScroll]);

  const onMove = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      d.lastMoveX = d.x;
      d.x = e.clientX;
      d.y = e.clientY;
      if (!d.active) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
        if (d.touch) {
          // Moved before the long press: it is a scroll or a swipe, not a drag.
          if (d.pressTimer) clearTimeout(d.pressTimer);
          d.art.classList.remove('pressing');
          dragRef.current = null;
          window.removeEventListener('pointermove', moveProxy);
          window.removeEventListener('pointerup', upProxy);
          window.removeEventListener('pointercancel', cancelProxy);
          window.removeEventListener('keydown', keyProxy, true);
          return;
        }
        lift();
      }
    },
    [lift, moveProxy, upProxy],
  );

  const onUp = useCallback(() => endDrag(), [endDrag]);
  handlers.current = { move: onMove, up: onUp, cancel: () => endDrag(false) };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (dragRef.current || store.readOnly) return; // a view-only link never drags
    // By input, not layout: touch / pen lift after a long press (iPad too), a mouse past a small threshold.
    const mode = dragMode(e.pointerType, e.button);
    if (!mode) return;
    const touch = phone || mode === 'long-press';
    const t = e.target as HTMLElement;
    if (t.closest('button, input, textarea, a, .composer, .card-face.exiting')) return;
    const art = t.closest<HTMLElement>('article[data-card-id]');
    if (!art) return;
    const id = art.dataset.cardId!;
    const card = cardOf(id);
    if (!card) return;
    const rect = art.getBoundingClientRect();
    if (touch) art.classList.add('pressing'); // the card swells while the press builds up to a lift
    dragRef.current = {
      art,
      tabHover: null,
      tabEl: null,
      touch,
      // §7.7: a 350 ms long-press lifts the card on touch.
      pressTimer: touch ? setTimeout(() => lift(), LONG_PRESS_MS) : null,
      edgeTimer: null,
      edge: null,
      edgeArmed: true,
      id,
      from: art.closest<HTMLElement>('.column')?.dataset.status ?? card.status,
      startX: e.clientX,
      startY: e.clientY,
      offX: e.clientX - rect.left,
      offY: e.clientY - rect.top,
      rect,
      active: false,
      ghost: null,
      x: e.clientX,
      y: e.clientY,
      gx: rect.left,
      gy: rect.top,
      raf: 0,
      over: null,
      lastMoveX: e.clientX,
    };
    window.addEventListener('pointermove', moveProxy);
    window.addEventListener('pointerup', upProxy);
    window.addEventListener('pointercancel', cancelProxy);
    window.addEventListener('keydown', keyProxy, true);
  };

  useEffect(
    () => () => {
      window.removeEventListener('pointermove', moveProxy);
      window.removeEventListener('pointerup', upProxy);
      window.removeEventListener('pointercancel', cancelProxy);
      window.removeEventListener('keydown', keyProxy, true);
      if (dragRef.current?.raf) cancelAnimationFrame(dragRef.current.raf);
      if (scrollCue.current) delete scrollCue.current.dataset.dragScroll;
      dragRef.current?.ghost?.remove();
      markChecklistDrop(checklistTarget.current, null);
      document.body.classList.remove('dragging');
    },
    [moveProxy, upProxy, cancelProxy, keyProxy],
  );

  // Scrolling the list dismisses the keyboard (§9.1), except our own scroll after Add.
  const ignoreScrollUntil = useRef(0);
  const onPhoneScroll = () => {
    if (Date.now() < ignoreScrollUntil.current) return;
    const a = document.activeElement;
    if (a instanceof HTMLTextAreaElement && a.closest('.composer-layer')) a.blur();
  };

  // The composer's own scroll to a new card must not dismiss the keyboard.
  useEffect(() => {
    const onAdded = () => (ignoreScrollUntil.current = Date.now() + 800);
    window.addEventListener('composer:added', onAdded);
    return () => window.removeEventListener('composer:added', onAdded);
  }, []);

  const dataCounts = `todo:${counts.todo},doing:${counts.doing},done:${counts.done}`;
  const showArchivedGroup = archivedMatches.length > 0;
  const away = (status: string) => phone && (phoneTab !== status || (status === 'archived' && !showArchivedGroup));
  const awayProps = (status: string) => (away(status) ? { inert: '', 'aria-hidden': true, 'data-away': '' } : {});
  const statusOf = (id: string): CardStatus | null => {
    const c = cardOf(id);
    return c && !c.archivedAt ? c.status : null;
  };

  return (
    <main
      ref={rootRef}
      className={cx('board', phone && 'phone', edge && `edge-${edge}`)}
      data-counts={dataCounts}
      data-phone-tab={phone ? phoneTab : undefined}
      tabIndex={-1}
      onPointerDown={onPointerDown}
    >
      {phone && <PhoneNav
        column={phoneArchived && showArchivedGroup ? 'archived' : phoneTab}
        onChange={(s) => {
          if (onPhoneTab) onPhoneTab(s);
          else if (s === 'notes') onShowNotes?.();
          else if (s !== 'archived') onColumnChange(s);
        }}
        columns={visible}
        counts={shownCounts}
        archived={showArchivedGroup ? archivedMatches.length : null}
      />}
      <div
        className="columns"
        style={!phone ? { gridTemplateColumns: `repeat(${Math.max(1, visible.length + (showArchivedGroup ? 1 : 0))}, minmax(280px, 1fr))`, overflowX: 'auto' } : undefined}
        onScrollCapture={phone ? onPhoneScroll : undefined}
      >
        {!visible.length && <section className="column board-empty" data-status="board-empty" {...awayProps('board-empty')}><p className="empty mono">Select labels to add Board columns.</p></section>}
        {visible.map((col) => (
          <Column
            key={col.status}
            status={col.status}
            label={col.label}
            empty={col.empty}
            cards={columnOf(col.status)}
            statusOf={statusOf}
            belongs={(id) => { const c = cardOf(id); return !!c && belongsToColumn(c, col.status); }}
            columnOrder={ORDER}
            query={query}
            openCardId={openCardId}
            selectedId={selectedId}
            onSelect={onSelect}
            onOpenCard={onOpenCard}
            phone={phone}
            slide={null}
            paneProps={awayProps(col.status)}
            drag={drag}
            shake={shake === col.status}
            hint={hint === col.status ? copy.checkAllRejected() : null}
            archivedCount={archivedCount}
            onOpenArchive={onOpenArchive}
          />
        ))}
        {showArchivedGroup && (
          <section className="column archived" data-status="archived" aria-label="Archived" {...awayProps('archived')}>
            <header className="column-header">
              <h2 className="column-label">Archived</h2>
              <span className="mono column-count">{archivedMatches.length}</span>
            </header>
            <div className="column-body">
              {archivedMatches.map((c) => (
                <CardFace
                  key={c.id}
                  card={c}
                  open={c.id === openCardId}
                  selected={false}
                  onOpen={onOpenCard}
                  phone={phone}
                  searchQuery={q}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

interface ColumnProps {
  status: string;
  label: string;
  empty: string;
  cards: Card[];
  statusOf(id: string): CardStatus | null;
  belongs(id: string): boolean;
  columnOrder: string[];
  query: string;
  openCardId: string | null;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onOpenCard(id: string, restore?: boolean): void;
  phone: boolean;
  slide: 'from-left' | 'from-right' | null;
  /** Phone: inert and hidden while another tab is showing. */
  paneProps?: Record<string, unknown>;
  drag: DragState | null;
  shake: boolean;
  hint: string | null;
  archivedCount: number;
  onOpenArchive(): void;
}

function Column({
  status,
  label,
  empty,
  cards,
  statusOf,
  belongs,
  columnOrder,
  query,
  openCardId,
  selectedId,
  onSelect,
  onOpenCard,
  phone,
  slide,
  paneProps,
  drag,
  shake,
  hint,
  archivedCount,
  onOpenArchive,
}: ColumnProps) {
  const store = useStore();
  const { labels, readOnly } = store;
  const isTodo = status === 'todo';
  // Someday open/closed is per device and shared with keyboard nav; `mounted` lags a collapse until its spring ends.
  const { somedayOpen, setSomedayOpen } = store;
  const [mounted, setMounted] = useState(somedayOpen);
  const openRef = useRef(somedayOpen);
  const listRef = useRef<HTMLDivElement>(null);
  const expanding = useRef(false);
  const setSomedayShown = (next: boolean) => {
    openRef.current = next;
    setSomedayOpen(next);
    if (next) {
      listRef.current?.getAnimations().forEach((a) => a.cancel()); // reopened mid-collapse
      expanding.current = true;
      setMounted(true);
    } else {
      // A selection hidden by the collapse would take keys unseen.
      if (selectedId && cards.some((c) => c.id === selectedId && c.someday)) onSelect(null);
      collapseThen(
        listRef.current,
        () => {
          if (!openRef.current) setMounted(false);
        },
        0,
        SPRINGS.gentle,
      );
    }
  };
  const focusAfterOpen = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!expanding.current || !mounted) return;
    expanding.current = false;
    expandFrom(listRef.current, SPRINGS.gentle);
    const id = focusAfterOpen.current;
    focusAfterOpen.current = null;
    const el = id
      ? listRef.current?.querySelector<HTMLElement>(`[data-testid="card-${id}"]`)
      : null;
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  }, [mounted, somedayOpen]);

  const q = query.trim();
  // v5: Someday is retired (its cards became notes); a straggler still shows in To do.
  const active = cards;
  const parked: Card[] = [];

  // The selected or open card just parked (⌘↓, S, the menu) into a collapsed Someday: open it so the card stays in view.
  const parkedBefore = useRef(new Set(parked.map((c) => c.id)));
  useEffect(() => {
    const before = parkedBefore.current;
    parkedBefore.current = new Set(parked.map((c) => c.id));
    if (!isTodo || somedayOpen) return;
    const arrived = [selectedId, openCardId].find(
      (id) => id && parkedBefore.current.has(id) && !before.has(id),
    );
    if (!arrived) return;
    if (arrived === selectedId) focusAfterOpen.current = arrived; // keyboard focus follows it
    setSomedayShown(true);
  });

  // §11.2 exit: keep leaving cards for the exit duration. Desktop only animates
  // cards that left the board (moves are FLIPped in the target column); phone
  // slides them toward the destination column.
  const present = usePresence(active, (c) => c.id, EXIT_MS);
  const leaveDirOf = (c: Card): 'left' | 'right' | null => {
    const now = statusOf(c.id);
    if (!now || now === status) return null;
    return columnOrder.indexOf(now) > columnOrder.indexOf(status) ? 'right' : 'left';
  };
  // §11.2 stagger: cards that appear together enter 30 ms apart (none beyond 50).
  const prevIds = useRef<Set<string>>(new Set(active.map((c) => c.id)));
  const fresh = active.filter((c) => !prevIds.current.has(c.id));
  useEffect(() => {
    prevIds.current = new Set(active.map((c) => c.id));
  });
  const enterIndex = (id: string) =>
    staggerIndex(
      fresh.length,
      fresh.findIndex((c) => c.id === id),
    );
  const matchCount = q ? cards.filter((c) => searchMatches(c, query, labels)).length : cards.length;
  const showEmpty = !drag && (q ? matchCount === 0 : active.length === 0);
  const over = drag?.over && !drag.over.parentId && !drag.over.blocked && drag.over.status === status ? drag.over : null;

  const placeholder = (
    <div key="__slot" className="drop-placeholder" aria-hidden />
  );
  const face = (c: Card, leaving = false) => (
    <CardFace
      key={c.id}
      card={c}
      columnLabel={workflowColumn(status) ? `workflow:${status}` : status}
      open={c.id === openCardId}
      selected={c.id === selectedId}
      onOpen={onOpenCard}
      onSelect={onSelect}
      phone={phone}
      searchQuery={q || undefined}
      hidden={drag?.id === c.id}
      leaving={leaving}
      leaveDir={leaving ? leaveDirOf(c) : null}
      enterIndex={leaving ? -1 : enterIndex(c.id)}
    />
  );
  const region = (items: Present<Card>[], someday: boolean): React.ReactNode[] => {
    const here = over && over.someday === someday ? over : null;
    const out: React.ReactNode[] = [];
    for (const p of items) {
      const c = p.item;
      if (p.leaving) {
        // Crossed the divider, or (desktop) moved columns: the new node FLIPs; only phone slides it out.
        if (belongs(c.id) || (!phone && statusOf(c.id))) continue;
        if (slidOutRecently(c.id)) continue; // a swipe already slid it off-screen
        out.push(face(c, true));
        continue;
      }
      if (here && here.beforeId === c.id) out.push(placeholder);
      out.push(face(c));
    }
    if (
      here &&
      (here.beforeId === null || !items.some((p) => !p.leaving && p.item.id === here.beforeId))
    )
      out.push(placeholder);
    return out;
  };

  return (
    <section
      className={cx('column', status, slide, over && 'drop-target')}
      data-status={status}
      aria-label={label}
      {...paneProps}
    >
      <header className={cx('column-header', shake && 'shake')}>
        <h2 className="column-label">{phone ? <LabelPill label={labels.find((l) => l.id === (workflowColumn(status) ? `workflow:${status}` : status)) ?? { id: status, name: label, color: '#6B7480' }} /> : <><span className="column-dot" style={dotVars(labels.find((l) => l.id === (workflowColumn(status) ? `workflow:${status}` : status))?.color || '#6B7480')} />{label}</>}</h2>
        <span className="mono column-count" data-testid={`count-${status}`}>
          <Roll value={active.length} />
        </span>
        {status === 'done' && !readOnly && (
          <button type="button" className="linkbtn mono" onClick={onOpenArchive}>
            Archive
          </button>
        )}
        {hint && (
          <span className="mono column-hint" role="status">
            {hint}
          </span>
        )}
      </header>

      <div className="column-body">
        {region(present, false)}
        {showEmpty && (
          <p className="column-empty">
            {q ? 'No matches' : phone ? 'Nothing here' : readOnly && isTodo ? shareCopy.emptyTodo : empty}
          </p>
        )}
        {status === 'done' && (
          <button type="button" className="linkbtn mono archived-link" onClick={onOpenArchive}>
            {archivedCount} archived · auto after {store.settings.archiveAfterDays || '∞'} days
          </button>
        )}
      </div>
    </section>
  );
}
