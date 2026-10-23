// Input-aware interaction rules (pure): what a pointer type may do, edge auto-scroll speed,
// the phone tab hold-to-switch timer, the hover quick step and the card context menu items.
import type { Card, CardStatus } from './types';
import { canMoveTo, swipeRightAction } from './reducer';
import {menuCopy} from './copy';

export type DragMode = 'long-press' | 'threshold' | null;

/** Touch and pen lift after a long press (a quick move is a scroll or swipe); a mouse drags past a small threshold. */
export function dragMode(pointerType: string, button: number): DragMode {
  if (pointerType === 'touch' || pointerType === 'pen') return 'long-press';
  if (pointerType === 'mouse' && button === 0) return 'threshold';
  return null;
}

/** Browser tabs keep their back gesture; the installed app owns its edge. */
export const EDGE_GUARD_PX = 20;
export function standaloneView(): boolean {
  return typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
}
export function swipeAllowed(startX: number): boolean {
  return standaloneView() || startX >= EDGE_GUARD_PX;
}

/** Scroll step (px per frame) for a pointer at `pos` in a scroller spanning start…end; faster nearer the edge. */
export function edgeScroll(pos: number, start: number, end: number, zone = 48, max = 12): number {
  if (pos < start + zone) return -Math.min(max, (start + zone - pos) / 4);
  if (pos > end - zone) return Math.min(max, (pos - (end - zone)) / 4);
  return 0;
}

export interface HoverState { target: string | null; since: number; fired: boolean }

/** Dragging over a phone column tab: switch to it once the card has hovered there for `delay` ms. */
export function hoverSwitch(state: HoverState | null, target: string | null, now: number, delay = 500): { state: HoverState; fire: string | null } {
  if (!state || state.target !== target) return { state: { target, since: now, fired: false }, fire: null };
  if (target && !state.fired && now - state.since >= delay) return { state: { ...state, fired: true }, fire: target };
  return { state, fire: null };
}

/** The hover "→" on a card face: the column's next step; none on Done. */
export function quickStep(card: Card): { to: CardStatus; label: 'Start' | 'Done' } | null {
  if (card.status === 'done') return null;
  const go = swipeRightAction(card);
  return go.label === 'Reopen' ? null : { to: go.to, label: go.label };
}

export interface ContextItem { key: 'todo' | 'doing' | 'done' | 'someday' | 'remind' | 'delete'; label: string; disabled?: boolean; danger?: boolean }

const COLUMN: Record<CardStatus, string> = { todo: 'To do', doing: 'Doing', done: 'Done' };

/** Right-click menu: the ··· menu's moves, Someday, Remind me and Delete. */
export function contextItems(card: Card): ContextItem[] {
  const move = (s: CardStatus): ContextItem => ({
    key: s,
    label: menuCopy.moveTo(COLUMN[s]),
    // A parked card is in To do, but "Move to To do" un-parks it.
    disabled: card.kind !== 'note' && ((card.status === s && !(s === 'todo' && card.someday)) || !canMoveTo(card, s)),
  });
  return [
    move('todo'),
    move('doing'),
    move('done'),
    // v5 §2.4: a to do can go back to being a note (Someday is retired).
    ...(card.kind === 'note' ? [] : [{ key: 'someday' as const, label: 'Make it a note' }]),
    { key: 'remind', label: menuCopy.remind },
    { key: 'delete', label: menuCopy.delete, danger: true },
  ];
}
