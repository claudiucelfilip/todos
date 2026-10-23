// §11.2 / §11.3 exit animations need the node to stay for the exit duration.
// usePresence returns the current items plus the ones that just left, flagged
// `leaving`, for `ms` milliseconds; reduced motion removes them immediately.
import { isQuiet } from './seen';
import { useEffect, useRef, useState } from 'react';

export interface Present<T> {
  item: T;
  leaving: boolean;
  /** 0-based position among the items leaving in the same batch (for staggers). */
  leaveIndex: number;
}

/**
 * §11.2 / §16: items entering together stagger 30 ms apart (delay step capped at
 * 8) while fewer than 50 arrive; 50+ enter as one group; a lone item has no stagger.
 * Returns the delay step, or -1 for none.
 */
export function staggerIndex(count: number, index: number): number {
  if (count <= 1 || count >= 50 || index < 0) return -1;
  return Math.min(index, 8);
}

export function reducedMotion(): boolean {
  if (typeof document === 'undefined') return false;
  const setting = document.documentElement.getAttribute('data-reduce-motion');
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return (
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

/** Keyboard commands use the same immediate path as reduced motion. */
export function instantMotion(): boolean {
  return reducedMotion() || (typeof document !== 'undefined' && document.documentElement.dataset.motionInput === 'keyboard');
}

export function usePresence<T>(items: T[], key: (t: T) => string, ms: number, scope?: string): Present<T>[] {
  const prev = useRef<Map<string, T>>(new Map());
  const [leaving, setLeaving] = useState<Map<string, { item: T; index: number }>>(new Map());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const previousScope = useRef(scope);
  const changedScope = previousScope.current !== scope;
  if (changedScope) {
    previousScope.current = scope;
    prev.current.clear();
    timers.current.forEach(timer => clearTimeout(timer));
    timers.current.clear();
    if (leaving.size) setLeaving(new Map());
  }

  const currentIds = new Set(items.map(key));
  const gone: T[] = [];
  for (const [k, v] of prev.current) if (!currentIds.has(k)) gone.push(v);

  useEffect(() => {
    prev.current = new Map(items.map((i) => [key(i), i]));
    if (isQuiet() || instantMotion()) {
      timers.current.forEach((t) => clearTimeout(t));
      timers.current.clear();
      if (leaving.size) setLeaving(new Map());
      return;
    }
    if (!gone.length) return;
    setLeaving((m) => {
      const next = new Map(m);
      gone.forEach((g, index) => {
        const k = key(g);
        if (currentIds.has(k)) return;
        next.set(k, { item: g, index });
        const old = timers.current.get(k);
        if (old) clearTimeout(old);
        timers.current.set(
          k,
          setTimeout(() => {
            timers.current.delete(k);
            setLeaving((mm) => {
              if (!mm.has(k)) return mm;
              const n2 = new Map(mm);
              n2.delete(k);
              return n2;
            });
          }, ms),
        );
      });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);

  const out: Present<T>[] = items.map((item) => ({ item, leaving: false, leaveIndex: 0 }));
  for (const [k, v] of isQuiet() || changedScope ? new Map<string, { item: T; index: number }>() : leaving) {
    if (currentIds.has(k)) continue; // came back: render it live
    out.push({ item: v.item, leaving: true, leaveIndex: v.index });
  }
  return out;
}
