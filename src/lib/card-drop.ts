import type { Card } from './types';
import { wouldCycle } from '../../shared/notes.mjs';
import { ITEMS_MAX } from './parse';
import '../styles/card-drop.css';

export function isChecklistDropCenter(element: HTMLElement | null, x: number, y: number): boolean {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return x >= rect.left + rect.width * .2 && x <= rect.right - rect.width * .2 &&
    y >= rect.top + rect.height * .2 && y <= rect.bottom - rect.height * .2;
}

/** The center links cards; the outer edges keep their existing reorder gesture. */
export function checklistDropTarget(
  element: HTMLElement | null, x: number, y: number, childId: string, cards: Card[],
): HTMLElement | null {
  if (!element || !isChecklistDropCenter(element, x, y)) return null;
  const parentId = element.dataset.cardId ?? element.dataset.gridId;
  const parent = cards.find(card => card.id === parentId);
  const child = cards.find(card => card.id === childId);
  if (!parent || !child || parent.archivedAt || child.archivedAt || parent.draft || child.draft) return null;
  if (parent.items.length >= ITEMS_MAX || parent.items.some(item => item.ref === childId) || wouldCycle(cards, parent.id, childId)) return null;
  return element;
}

export function markChecklistDrop(previous: HTMLElement | null, next: HTMLElement | null): HTMLElement | null {
  if (previous === next) return next;
  previous?.removeAttribute('data-checklist-drop');
  next?.setAttribute('data-checklist-drop', 'true');
  return next;
}
