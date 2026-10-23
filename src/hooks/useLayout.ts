import { useEffect, useState } from 'react';

// §9 — responsive breakpoint at 900px between phone and desktop layouts.
const QUERY = '(max-width: 899px)';

export function usePhone(): boolean {
  const [phone, setPhone] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(QUERY).matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const fn = (e: MediaQueryListEvent) => setPhone(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return phone;
}

// Touch UI follows the input, not the layout: a coarse pointer (iPad, phone) or any touch seen so far.
const COARSE = '(any-pointer: coarse)';
let touchSeen = false;
const touchListeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (touchSeen || e.pointerType !== 'touch') return;
      touchSeen = true;
      touchListeners.forEach((fn) => fn());
    },
    { capture: true, passive: true },
  );
}

export function useTouchUI(): boolean {
  const coarse = () =>
    typeof window !== 'undefined' && (touchSeen || window.matchMedia(COARSE).matches);
  const [on, setOn] = useState(coarse);
  useEffect(() => {
    const mq = window.matchMedia(COARSE);
    const fn = () => setOn(coarse());
    mq.addEventListener('change', fn);
    touchListeners.add(fn);
    fn();
    return () => {
      mq.removeEventListener('change', fn);
      touchListeners.delete(fn);
    };
  }, []);
  return on;
}

/** Below this width the fourth track would squeeze the three board columns. */
export function useFloatingDetail(): boolean {
  const query = '(min-width: 900px) and (max-width: 1319px)';
  const [floating, setFloating] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const changed = (e: MediaQueryListEvent) => setFloating(e.matches);
    mq.addEventListener('change', changed);
    return () => mq.removeEventListener('change', changed);
  }, []);
  return floating;
}
