import type { Card } from './types';

/** New cards first, then arranged cards in their saved order. */
export function gridOrder(cards: ReadonlyArray<Card>): Card[] {
  return [...cards].sort((a, b) => {
    // New cards (never arranged) come first, newest on top; then the arranged ones in their order.
    const pa = a.layout ? 1 : 0;
    const pb = b.layout ? 1 : 0;
    if (pa !== pb) return pa - pb;
    if (a.layout && b.layout) return a.layout.order - b.layout.order;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export interface MasonryItem { id: string; width: number; height: number }
export interface MasonryRect { left: number; top: number; width: number; height: number }

export function snappedWidth(width: number, gridWidth: number, columns: number, gap = 20): { width: number; span: number } {
  const track = (gridWidth + gap) / columns;
  const span = Math.max(1, Math.min(columns, Math.round((width + gap) / track)));
  return { width: Math.floor(span * track - gap), span };
}

/** Grow into nearby space without moving neighbours or changing preferred sizes. */
export function fillMasonryGaps(placed: Map<string, MasonryRect>, width: number, gap: number, pinnedId?: string): Map<string, MasonryRect> {
  const filled = new Map([...placed].map(([id, rect]) => [id, { ...rect }]));
  for (const [id, rect] of filled) {
    if (id === pinnedId) continue;
    let left = 0, right = width;
    for (const [otherId, other] of filled) {
      if (otherId === id || rect.top + rect.height + gap <= other.top || other.top + other.height + gap <= rect.top) continue;
      if (other.left + other.width <= rect.left) left = Math.max(left, other.left + other.width + gap);
      if (other.left >= rect.left + rect.width) right = Math.min(right, other.left - gap);
    }
    rect.left = left;
    rect.width = right - left;
  }
  const bottom = Math.max(0, ...[...filled.values()].map(rect => rect.top + rect.height));
  for (const [id, rect] of filled) {
    if (id === pinnedId) continue;
    const below = [...filled].filter(([otherId, other]) => otherId !== id && other.top >= rect.top + rect.height && other.left < rect.left + rect.width + gap && other.left + other.width + gap > rect.left);
    rect.height = (below.length ? Math.min(...below.map(([, other]) => other.top)) - gap : bottom) - rect.top;
  }
  return filled;
}

/** Reserve the resized note first, then fit the other notes around it. */
export function masonryLayout(items: MasonryItem[], width: number, gap: number, anchor?: { id: string; left: number; top: number }): Map<string, MasonryRect> {
  const placed = new Map<string, MasonryRect>();
  const fits = (r: MasonryRect) => [...placed.values()].every(p => r.left + r.width + gap <= p.left || p.left + p.width + gap <= r.left || r.top + r.height + gap <= p.top || p.top + p.height + gap <= r.top);
  const rect = (item: MasonryItem, left: number, top: number): MasonryRect => ({ left: Math.round(left), top: Math.round(top), width: Math.min(width, Math.max(1, Math.round(item.width))), height: Math.max(1, Math.ceil(item.height)) });
  const pinned = items.find(item => item.id === anchor?.id);
  if (pinned && anchor) placed.set(pinned.id, rect(pinned, Math.max(0, Math.min(anchor.left, width - pinned.width)), Math.max(0, anchor.top)));
  for (const item of items) {
    if (placed.has(item.id)) continue;
    const ys = [...new Set([0, ...[...placed.values()].map(r => r.top + r.height + gap)])].sort((a, b) => a - b);
    const xs = [...new Set([0, ...[...placed.values()].map(r => r.left + r.width + gap)])].sort((a, b) => a - b);
    let found: MasonryRect | undefined;
    for (const top of ys) {
      for (const left of xs) {
        const candidate = rect(item, left, top);
        if (candidate.left + candidate.width <= width && fits(candidate)) { found = candidate; break; }
      }
      if (found) break;
    }
    placed.set(item.id, found!);
  }
  return placed;
}
