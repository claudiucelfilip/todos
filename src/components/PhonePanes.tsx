import { PAGE_SPRING, pageTarget, rubberBand } from '../lib/phone-paging';
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { instantMotion } from '../lib/presence';
import { springKeyframes, progressVelocity } from '../lib/spring';

interface Props { index: number; onIndex(i: number): void; onAfterLastDrag(dx: number): void; onAfterLastEnd(commit: boolean, velocity: number): void; children: ReactNode; active: boolean }
interface Metrics { track: HTMLElement | null; step: number; center: number; last: number }

// Column swipes move the track; Board's tab row stays with the outer view pane.
export default function PhonePanes({ index, onIndex, onAfterLastDrag, onAfterLastEnd, children, active }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const indexRef = useRef(index);
  const callback = useRef(onIndex);
  callback.current = onIndex;
  const afterLastDrag = useRef(onAfterLastDrag);
  afterLastDrag.current = onAfterLastDrag;
  const afterLastEnd = useRef(onAfterLastEnd);
  afterLastEnd.current = onAfterLastEnd;
  const position = useRef(0);
  const animation = useRef<Animation | null>(null);
  const first = useRef(true);
  const released = useRef<number | null>(null);
  const track = () => ref.current?.querySelector<HTMLElement>('.columns');
  const stepWidth = () => {
    const el = track(), column = el?.firstElementChild as HTMLElement | null;
    return column ? column.offsetWidth + parseFloat(getComputedStyle(el!).columnGap || '0') : window.innerWidth;
  };
  const centerOffset = () => {
    const el = ref.current, column = track()?.firstElementChild as HTMLElement | null;
    if (!el || !column) return 0;
    const style = getComputedStyle(el);
    return Math.round((el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - column.offsetWidth) / 2);
  };
  const last = () => Math.max(0, (track()?.children.length || 1) - 1);
  const measure = (): Metrics => ({ track: track() ?? null, step: stepWidth(), center: centerOffset(), last: last() });
  const paint = (x: number, el = track()) => {
    position.current = x;
    if (el) el.style.transform = `translate3d(${x}px,0,0)`;
  };
  const stop = () => {
    const el = track();
    if (animation.current && el) position.current = new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
    animation.current?.cancel();
    animation.current = null;
  };
  const settle = (i: number, velocity = 0, instant = false, metrics = measure()) => {
    stop();
    const target = metrics.center - i * metrics.step;
    if (instant || instantMotion()) { paint(target, metrics.track); return; }
    const el = metrics.track;
    if (!el) return;
    const from = position.current, distance = target - from;
    if (Math.abs(distance) < 1) { paint(target, el); return; }
    const { keyframes, ms } = springKeyframes({ ...PAGE_SPRING, velocity: Math.max(-6, Math.min(6, progressVelocity(velocity, distance) * Math.sign(distance))) }, (p) => ({
      transform: `translate3d(${Math.round(from + distance * p)}px,0,0)`,
    }));
    paint(target, el);
    const a = el.animate(keyframes, { duration: ms, easing: 'linear' });
    animation.current = a;
    a.onfinish = () => { if (animation.current === a) animation.current = null; };
  };
  useLayoutEffect(() => {
    indexRef.current = index;
    if (released.current === index) released.current = null;
    else settle(index, 0, first.current || !active);
    first.current = false;
  }, [index, active]);
  useEffect(() => {
    const el = ref.current!;
    let gesture: { id: number; x: number; y: number; start: number; column: number; crossing: boolean; axis: '' | 'x' | 'y'; metrics: Metrics | null; samples: { x: number; t: number }[] } | null = null;
    const down = (e: PointerEvent) => {
      if (gesture || !e.isPrimary || e.button !== 0 || (e.target as HTMLElement).closest('button,input,textarea,a,[contenteditable="true"]')) return;
      gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, start: position.current, column: indexRef.current, crossing: false, axis: '', metrics: null, samples: [{ x: e.clientX, t: e.timeStamp }] };
    };
    const move = (e: PointerEvent) => {
      const g = gesture;
      if (!g || g.id !== e.pointerId || document.body.classList.contains('dragging')) { gesture = null; return; }
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      if (!g.axis) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 6) return;
        g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (g.axis === 'x') { stop(); g.start = position.current; g.metrics = measure(); el.setPointerCapture(e.pointerId); }
      }
      if (g.axis !== 'x' || !g.metrics) return;
      e.preventDefault();
      if (g.column === g.metrics.last && dx < 0) {
        g.crossing = true;
        afterLastDrag.current(dx);
        g.samples.push({ x: e.clientX, t: e.timeStamp });
        if (g.samples.length > 6) g.samples.shift();
        return;
      }
      if (g.crossing) afterLastDrag.current(0);
      const w = g.metrics.step, maximum = g.metrics.center, minimum = maximum - g.metrics.last * w;
      let x = g.start + dx;
      if (x > maximum) x = maximum + rubberBand(x - maximum, w);
      else if (x < minimum) x = minimum - rubberBand(minimum - x, w);
      if (!instantMotion()) paint(x, g.metrics.track);
      g.samples.push({ x: e.clientX, t: e.timeStamp });
      if (g.samples.length > 6) g.samples.shift();
    };
    const end = (e: PointerEvent) => {
      const g = gesture;
      if (!g || g.id !== e.pointerId) return;
      gesture = null;
      if (g.axis !== 'x') return;
      if (el.hasPointerCapture(g.id)) el.releasePointerCapture(g.id);
      const a = g.samples[0], b = g.samples[g.samples.length - 1];
      const v = e.type === 'pointercancel' || e.timeStamp - b.t > 100 ? 0 : (b.x - a.x) / Math.max(1, b.t - a.t);
      const dx = e.clientX - g.x;
      if (g.crossing) {
        const commit = e.type !== 'pointercancel' && dx < 0 && (-dx > g.metrics!.step * 0.22 || (dx < -20 && v < -0.5));
        afterLastEnd.current(commit, v);
        if (!commit) settle(g.column, v, false, g.metrics!);
        return;
      }
      const target = e.type === 'pointercancel' ? g.column : pageTarget(g.column, (instantMotion() ? g.start + e.clientX - g.x : position.current) - g.metrics!.center, v, g.metrics!.step, g.metrics!.last + 1);
      indexRef.current = target;
      released.current = target !== g.column ? target : null;
      callback.current(target);
      settle(target, v, false, g.metrics!);
      // Consume the click produced by a paging drag.
      const consume = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
      el.addEventListener('click', consume, { once: true, capture: true });
      setTimeout(() => el.removeEventListener('click', consume, true), 0);
    };
    const resize = () => settle(indexRef.current, 0, true);
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => {
      stop(); observer.disconnect();
      el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end);
    };
  }, []);
  return <div className="phone-panes" ref={ref} data-testid="phone-panes" hidden={!active} {...(active ? {} : { inert: '', 'aria-hidden': true })}>{children}</div>;
}
