import { useEffect, useRef, type ReactNode } from 'react';
import { swipeAllowed } from '../lib/input';

interface Props { active: boolean; onDrag(dx: number): void; onPrevious(commit: boolean, velocity: number): void; children: ReactNode }

export default function PhoneNotesPane({ active, onDrag, onPrevious, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef(onDrag);
  drag.current = onDrag;
  const previous = useRef(onPrevious);
  previous.current = onPrevious;
  useEffect(() => {
    const el = ref.current!;
    let gesture: { id: number; x: number; y: number; row: boolean; axis: '' | 'x' | 'y'; samples: { x: number; t: number }[] } | null = null;
    const down = (e: PointerEvent) => {
      if (!e.isPrimary || e.button !== 0 || !swipeAllowed(e.clientX) ||
        (e.target as HTMLElement).closest('button,input,textarea,a,[contenteditable="true"]')) return;
      gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, row: !!(e.target as HTMLElement).closest('[data-swipe-row]'), axis: '', samples: [{ x: e.clientX, t: e.timeStamp }] };
    };
    const move = (e: PointerEvent) => {
      const g = gesture;
      if (!g || g.id !== e.pointerId || document.body.classList.contains('dragging')) { gesture = null; return; }
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      if (!g.axis) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 6) return;
        g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (g.axis === 'x' && g.row && dx < 0) { gesture = null; return; }
        if (g.axis === 'x') el.setPointerCapture(e.pointerId);
      }
      if (g.axis !== 'x') return;
      e.preventDefault();
      drag.current(Math.max(0, dx));
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
      const velocity = e.type === 'pointercancel' || e.timeStamp - b.t > 100 ? 0 : (b.x - a.x) / Math.max(1, b.t - a.t);
      const dx = e.clientX - g.x;
      previous.current(e.type !== 'pointercancel' && dx > 0 && (dx > el.clientWidth * 0.22 || (dx > 20 && velocity > 0.5)), velocity);
      const consume = (event: Event) => { event.preventDefault(); event.stopPropagation(); };
      el.addEventListener('click', consume, { once: true, capture: true });
      setTimeout(() => el.removeEventListener('click', consume, true), 0);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
    };
  }, []);
  return <div ref={ref} className="phone-notes-pane" hidden={!active} {...(active ? {} : { inert: '', 'aria-hidden': true })}>{children}</div>;
}
