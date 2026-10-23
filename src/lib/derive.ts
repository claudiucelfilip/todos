import { applyWorkflow } from '../../shared/workflow.mjs';
// §6 — checklist core rules. The heart of the app.
//
// A card's status is DERIVED from its checklist, not chosen by hand (except a
// manual status on a card that has no items). This function is the single
// source of truth for the derivation; the reducer calls it on every
// items-changing write so `status` + `completedAt` are always consistent.
//
// Rules:
//   - No items             -> status unchanged (a plain card; its status sticks).
//   - All items checked    -> "done" (stamp completedAt if not already done).
//   - Some items checked   -> "doing" (clear completedAt).
//   - None checked, was "done" -> "todo" (uncheck all reuses the card).
//   - None checked, was "todo"/"doing" -> unchanged.
//
// Examples:
//   - First check on a To-Do card moves it to Doing.
//   - Last check moves any card to Done.
//   - Unchecking an item on Done moves it to Doing; unchecking ALL moves to To Do.
//   - Adding an unchecked item to a Done card moves it to Doing.
//   - Deleting the only unchecked item from a Doing card moves it to Done.
//   - A plain card hand-moved to Done stamps completedAt (even with zero items).
//   - Removing ALL items turns the card back into a plain card and keeps its last status.

import type { Card, CardStatus } from './types';

/** Recompute `status` for a card from its checklist, given its previous status. */
export function deriveStatus(
  items: boolean[],
  prev: CardStatus,
): CardStatus {
  const len = items.length;
  if (len === 0) return prev; // plain card: keep last status
  const done = items.filter(Boolean).length;
  if (done === len) return 'done';
  if (done > 0) return 'doing';
  // nothing checked:
  return prev === 'done' ? 'todo' : prev;
}

/**
 * Apply §6 in place on the `card`'s `status` and `completedAt`.
 *
 * `completedAt` is handled INDEPENDENTLY of the status change, so a plain card
 * hand-moved to Done gets its `completedAt` stamped even though its derived
 * status equals its previous status (both "done", zero items). A non-done
 * status always clears `completedAt`.
 *
 * `nowIso` is injected so the derivation is testable without wall-clock.
 * Returns true if `status` or `completedAt` changed.
 */
export function applyStatus(
  card: Card,
  nowIso: string,
): boolean {
  if (card.workflowVersion === 1) {
    const before = `${card.status}|${card.completedAt}|${card.kind}`;
    applyWorkflow(card, nowIso);
    return before !== `${card.status}|${card.completedAt}|${card.kind}`;
  }
  // A note is finished by hand (`done`); its checklist never moves it. completedAt dates the finish.
  if (card.kind === 'note') {
    const at = card.done ? card.completedAt || nowIso : null;
    if (at === card.completedAt) return false;
    card.completedAt = at;
    return true;
  }
  const next = deriveStatus(card.items.map((i) => i.done), card.status);
  let changed = false;

  if (next !== card.status) {
    card.status = next;
    changed = true;
  }
  if (next === 'done') {
    // preserve an existing completedAt; otherwise stamp now
    if (!card.completedAt) {
      card.completedAt = nowIso;
      changed = true;
    }
  } else if (card.completedAt) {
    card.completedAt = null;
    changed = true;
  }
  return changed;
}

/** How many items are checked / total — for the "3 / 5" progress display. */
export function progress(items: ReadonlyArray<{ done: boolean }>): {
  done: number;
  total: number;
} {
  let done = 0;
  for (const i of items) if (i.done) done++;
  return { done, total: items.length };
}
