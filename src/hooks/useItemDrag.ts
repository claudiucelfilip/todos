// Checklist drag (any input): a row lifted by a long press (touch / pen) or a small mouse drag
// follows the pointer as a ghost; a slot opens where it will land, only inside its own group
// (unchecked or checked); the detail scrolls near its edges; the drop is one items-order write.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { actions } from './useStore';
import { edgeScroll } from '../lib/input';
import { SPRINGS, springCurve } from '../lib/spring';
import { springAnimate } from '../lib/motion';
import { instantMotion } from '../lib/presence';

export interface ItemDrag {
  id: string;
  done: boolean;
  beforeId: string | null; // null = the end
}

// While a finger is committed to a row (armed or dragging) the page must not scroll.
let touchLocks = 0;
const stopScroll = (e: TouchEvent) => {
  if (touchLocks > 0 && e.cancelable) e.preventDefault();
};
/** Hold the page still for a touch gesture; returns an idempotent release. */
export function lockTouchScroll(): () => void {
  if (touchLocks++ === 0) window.addEventListener('touchmove', stopScroll, { passive: false });
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--touchLocks === 0) window.removeEventListener('touchmove', stopScroll);
  };
}

/** The element's rect without a FLIP transform in flight. */
function layoutRect(el: HTMLElement): DOMRect {
  const r = el.getBoundingClientRect();
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return r;
  try {
    const m = new DOMMatrixReadOnly(t);
    return new DOMRect(r.left - m.m41, r.top - m.m42, r.width, r.height);
  } catch {
    return r;
  }
}

export function useItemDrag(cardId: string, rows: RefObject<HTMLElement>) {
  const [drag, setDrag] = useState<ItemDrag | null>(null);
  const live = useRef<{
    d: ItemDrag;
    ghost: HTMLElement;
    offY: number;
    y: number;
    x: number;
    raf: number;
    release: () => void;
    stop: () => void;
  } | null>(null);

  /** The row the dragged one would land before, or null for the end. */
  const target = (y: number, d: ItemDrag): string | null => {
    const els = Array.from(
      rows.current?.querySelectorAll<HTMLElement>('.dt-row-wrap[data-item-id]') ?? [],
    ).filter(
      (el) => el.dataset.itemId !== d.id && el.offsetParent !== null,
    );
    for (const el of els) {
      const r = layoutRect(el);
      if (y < r.top + r.height / 2) return el.dataset.itemId!;
    }
    return null;
  };

  const finish = useCallback(
    (drop: boolean) => {
      const s = live.current;
      if (!s) return;
      live.current = null;
      s.stop();
      cancelAnimationFrame(s.raf);
      const scroller = rows.current?.closest<HTMLElement>('.dt-scroll');
      if (scroller) delete scroller.dataset.dragScroll;
      document.body.classList.remove('dragging');
      const clear = () => {
        flushSync(() => setDrag(null)); // the real row shows in the same frame the ghost goes
        s.ghost.remove();
        s.release();
      };
      if (!drop) {
        clear();
        return;
      }
      const slot = rows.current?.querySelector<HTMLElement>('.dt-row-slot');
      actions.moveItem(cardId, s.d.id, s.d.beforeId);
      if (!slot || instantMotion()) {
        clear();
        return;
      }
      const r = slot.getBoundingClientRect();
      s.ghost.classList.add('dropping');
      const base = parseFloat(s.ghost.style.top);
      const from = s.y - s.offY - base;
      springAnimate(s.ghost, SPRINGS.release, (p) => ({
        transform: `translateY(${from + (r.top - base - from) * p}px)`,
      }));
      setTimeout(clear, springCurve(SPRINGS.release).ms);
    },
    [cardId, rows],
  );

  /** Lift `wrap` at the pointer. `release` unlocks the page's scroll when the drag ends. */
  const begin = useCallback(
    (wrap: HTMLElement, x: number, y: number, release: () => void) => {
      if (live.current) return;
      const id = wrap.dataset.itemId!;
      const done = wrap.dataset.done === 'true';
      const r = wrap.getBoundingClientRect();
      const ghost = wrap.cloneNode(true) as HTMLElement;
      ghost.classList.add('dt-row-ghost');
      ghost.classList.remove('pressing');
      ghost.removeAttribute('data-item-id');
      ghost.querySelectorAll('[data-testid]').forEach((n) => n.removeAttribute('data-testid'));
      ghost.setAttribute('aria-hidden', 'true');
      Object.assign(ghost.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
      document.body.appendChild(ghost);
      requestAnimationFrame(() => ghost.classList.add('lifted'));
      document.body.classList.add('dragging');
      if (navigator.vibrate) navigator.vibrate(10);
      const next = Array.from(
        rows.current?.querySelectorAll<HTMLElement>('.dt-row-wrap[data-item-id]') ?? [],
      );
      const after = next[next.indexOf(wrap) + 1];
      const d: ItemDrag = { id, done, beforeId: after?.dataset.itemId ?? null };
      const onMove = (e: PointerEvent) => {
        const s = live.current;
        if (!s) return;
        s.x = e.clientX;
        s.y = e.clientY;
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey, true);
      const stop = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey, true);
      };
      live.current = { d, ghost, offY: y - r.top, x, y, raf: 0, release, stop };
      setDrag(d);
      const loop = () => {
        const s = live.current;
        if (!s) return;
        s.ghost.style.transform = `translateY(${s.y - s.offY - parseFloat(s.ghost.style.top)}px) scale(1.02)`;
        const scroller = rows.current?.closest<HTMLElement>('.dt-scroll');
        if (scroller) {
          const sr = scroller.getBoundingClientRect();
          const inside = s.x >= sr.left && s.x <= sr.right && s.y >= sr.top && s.y <= sr.bottom;
          const v = inside ? edgeScroll(s.y, Math.max(sr.top, 0), Math.min(sr.bottom, window.innerHeight), 96, 10) : 0;
          const before = scroller.scrollTop;
          if (v) scroller.scrollTop += v;
          scroller.dataset.dragScroll = scroller.scrollTop !== before ? v < 0 ? 'top' : 'bottom' : '';
        }
        const before = target(s.y, s.d);
        if (before !== s.d.beforeId) {
          s.d = { ...s.d, beforeId: before };
          setDrag(s.d);
        }
        s.raf = requestAnimationFrame(loop);
      };
      live.current.raf = requestAnimationFrame(loop);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [finish, rows],
  );

  useEffect(
    () => () => {
      const s = live.current;
      if (!s) return;
      live.current = null;
      s.stop();
      cancelAnimationFrame(s.raf);
      const scroller = rows.current?.closest<HTMLElement>('.dt-scroll');
      if (scroller) delete scroller.dataset.dragScroll;
      s.ghost.remove();
      s.release();
      document.body.classList.remove('dragging');
    },
    [],
  );

  return { drag, begin };
}
