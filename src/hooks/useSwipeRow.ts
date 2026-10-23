// Phone swipe actions on a row (card or checklist item), driven by the pure reducer in
// lib/swipe.ts. Touch events with a non-passive touchmove (reliable in iOS standalone);
// the row's transform is written straight to the DOM in rAF, so a swipe never re-renders
// React. One open row at a time; reduced motion commits or closes without sliding.
import { useCallback, useEffect, useRef } from 'react';
import { SWIPE, restOffset, swipeEnd, swipeMove, swipeStart, type SwipeDir, type SwipeState } from '../lib/swipe';
import { SPRINGS, capOvershoot, progressVelocity, springKeyframes } from '../lib/spring';
import { swipeAllowed } from '../lib/input';

let closeOpenRow: (() => void) | null = null;

import { instantMotion } from '../lib/presence';

interface Options {
  enabled: boolean;
  left: boolean; // swipe left → the right-hand action (delete)
  right: boolean;
  confirmCommit?: boolean;
  onCommit(dir: SwipeDir): void;
}

export function useSwipeRow(opts: Options) {
  const wrap = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const latest = useRef(opts);
  latest.current = opts;
  const ctl = useRef<{ trigger(dir: SwipeDir): void; busy(): boolean }>({ trigger: () => {}, busy: () => false });

  useEffect(() => {
    const el = wrap.current;
    const inner = row.current;
    if (!el || !inner || !opts.enabled) return;
    let s: SwipeState | null = null;
    let rest = 0;
    let width = 0;
    let raf = 0;
    let quietUntil = 0; // swallow the click that ends a swipe or closes a row

    let cur = 0; // the offset on screen now (a settling spring included)
    let anim: Animation | null = null;
    const classes = (x: number) => {
      el.classList.toggle('swipe-left', x < 0);
      el.classList.toggle('swipe-right', x > 0);
    };
    /** Put the row at x at once (following the finger). */
    const setX = (x: number) => {
      anim?.cancel();
      anim = null;
      inner.style.transform = x ? `translateX(${x}px)` : '';
      cur = x;
      classes(x);
    };
    /** The offset on screen, read from a running spring when there is one. */
    const liveX = () => {
      if (!anim) return cur;
      const m = new DOMMatrixReadOnly(getComputedStyle(inner).transform === 'none' ? undefined : getComputedStyle(inner).transform);
      return m.m41;
    };
    /**
     * Settle on the "release" spring from where the row is to `x`. `vPxMs` is the finger's
     * velocity at release: a fast flick carries its momentum, a slow release eases in.
     */
    const springTo = (x: number, vPxMs = 0, onDone?: () => void) => {
      const from = liveX();
      anim?.cancel();
      anim = null;
      const dist = x - from;
      if (Math.abs(dist) < 0.5 || instantMotion()) {
        setX(x);
        onDone?.();
        return;
      }
      // Momentum may carry the row past rest, but never more than 3 px (no sliver of the action behind it).
      const v = capOvershoot(SPRINGS.release, Math.max(-30, Math.min(60, progressVelocity(vPxMs, dist) * Math.sign(dist))), dist, 3);
      const { keyframes, ms } = springKeyframes({ ...SPRINGS.release, velocity: v }, (p) => ({ transform: `translateX(${from + dist * p}px)` }));
      classes(from !== 0 ? from : x); // keep the action painted until the row is home
      inner.style.transform = x ? `translateX(${x}px)` : '';
      cur = x;
      const a = inner.animate(keyframes, { duration: ms, easing: 'linear' });
      anim = a;
      a.onfinish = () => {
        if (anim !== a) return;
        anim = null;
        classes(x);
        onDone?.();
      };
    };
    const armed = (d: SwipeDir | null) => el.classList.toggle('armed', !!d);

    const onDoc = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) close();
    };
    const close = (v = 0) => {
      rest = 0;
      armed(null);
      springTo(0, v);
      if (closeOpenRow === close) closeOpenRow = null;
      document.removeEventListener('pointerdown', onDoc, true);
    };
    const open = (dir: SwipeDir, v = 0) => {
      if (closeOpenRow && closeOpenRow !== close) closeOpenRow();
      closeOpenRow = close;
      rest = restOffset({ kind: 'open', dir }, width);
      armed(null);
      springTo(rest, v);
      document.addEventListener('pointerdown', onDoc, true);
    };
    const commit = (dir: SwipeDir, v = 0) => {
      if (closeOpenRow === close) closeOpenRow = null;
      document.removeEventListener('pointerdown', onDoc, true);
      rest = 0;
      if (instantMotion()) {
        armed(null);
        setX(0);
        latest.current.onCommit(dir);
        return;
      }
      // Slide until the row is fully off-screen (its far edge past the viewport), then commit.
      const r = el.getBoundingClientRect();
      const off = dir === 'left' ? -(r.right + 12) : window.innerWidth - r.left + 12;
      springTo(off, v, () => {
        latest.current.onCommit(dir);
        // If the node survives (a rejected move, or undo re-uses it), bring it home.
        setTimeout(() => {
          if (!inner.isConnected) return;
          armed(null);
          setX(0);
        }, 400);
      });
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || document.body.classList.contains('dragging')) return;
      // A link or an open action is never a swipe. The circle may start one (a thumb lands there);
      // a plain tap still toggles it, and the click after a swipe is swallowed below.
      if ((e.target as HTMLElement).closest('a, .swipe-action, .card-inline-items')) {
        s = null;
        return;
      }
      const t = e.touches[0];
      if (!swipeAllowed(t.clientX)) {
        s = null; // iOS back gesture territory
        return;
      }
      width = el.getBoundingClientRect().width;
      // Catch a row mid-spring where it is.
      const at = liveX();
      if (anim) setX(at);
      s = swipeStart(at, t.clientX, t.clientY, e.timeStamp);
    };
    const onMove = (e: TouchEvent) => {
      if (!s) return;
      if (document.body.classList.contains('dragging')) {
        // A long-press lifted the card: the drag owns this touch.
        s = null;
        springTo(rest);
        return;
      }
      const t = e.touches[0];
      if (s.phase === 'pending' && t.clientX - s.x0 >= SWIPE.lock && !latest.current.right) {
        s = null;
        return;
      }
      s = swipeMove(s, t.clientX, t.clientY, e.timeStamp, { width, left: latest.current.left, right: latest.current.right });
      if (s.phase !== 'swiping') return;
      if (e.cancelable) e.preventDefault(); // horizontal now: keep the column from scrolling
      const snap = s;
      armed(latest.current.confirmCommit ? null : snap.armed);
      if (instantMotion()) {
        classes(snap.raw);
        return;
      }
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = 0; setX(snap.offset); });
    };
    const onEnd = () => {
      if (!s) return;
      const st = s;
      s = null;
      cancelAnimationFrame(raf);
      if (raf && st.phase === 'swiping' && !instantMotion()) setX(st.offset);
      raf = 0;
      const out = swipeEnd(st);
      if (st.phase === 'swiping' || out.kind === 'close') quietUntil = Date.now() + 400;
      if (out.kind === 'commit') {
        if (latest.current.confirmCommit) open(out.dir, st.v);
        else commit(out.dir, st.v);
      }
      else if (out.kind === 'open') open(out.dir, st.v);
      else if (out.kind === 'close') close(st.v);
    };
    const onCancel = () => {
      if (!s) return;
      s = null;
      cancelAnimationFrame(raf);
      armed(null);
      springTo(rest);
    };
    const onClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.swipe-action')) return;
      if (Date.now() < quietUntil || rest !== 0) {
        e.preventDefault();
        e.stopPropagation();
        if (rest !== 0) close();
      }
    };

    ctl.current = {
      trigger: (dir) => commit(dir),
      busy: () => rest !== 0 || s?.phase === 'swiping' || Date.now() < quietUntil,
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onCancel);
    el.addEventListener('click', onClick, true);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
      el.removeEventListener('click', onClick, true);
      document.removeEventListener('pointerdown', onDoc, true);
      if (closeOpenRow === close) closeOpenRow = null;
      cancelAnimationFrame(raf);
      anim?.cancel();
    };
  }, [opts.enabled]);

  const trigger = useCallback((dir: SwipeDir) => ctl.current.trigger(dir), []);
  const busy = useCallback(() => ctl.current.busy(), []);
  return { wrap, row, trigger, busy, openWidth: SWIPE.open };
}
