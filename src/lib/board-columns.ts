import { WORKFLOW_LABELS } from '../../shared/workflow.mjs';
import { INBOX_FILTER } from './labels';
import type { Card, CardStatus, Label } from './types';

export const DEFAULT_BOARD_LABELS = WORKFLOW_LABELS.map((l) => l.id);
export function workflowColumn(key: string): CardStatus | null {
  return ['todo', 'doing', 'done'].includes(key) ? key as CardStatus : null;
}
export function boardColumns(labels: Label[], selected: string[]) {
  const ordered = [...WORKFLOW_LABELS.map((w) => labels.find((l) => l.id === w.id) ?? w),
    ...selected.flatMap((id) => {
      const label = labels.find((l) => l.id === id);
      return label && !DEFAULT_BOARD_LABELS.includes(id) ? [label] : [];
    })];
  const columns = ordered.filter((l) => selected.includes(l.id)).map((l) => ({
    status: l.id.startsWith('workflow:') ? l.id.slice(9) : l.id,
    label: l.name, labelId: l.id, empty: `No notes labelled ${l.name}.`,
  }));
  if (selected.includes(INBOX_FILTER)) columns.push({ status: INBOX_FILTER, label: 'Inbox', labelId: INBOX_FILTER, empty: 'No unlabelled notes.' });
  return columns;
}
export function belongsToColumn(card: Card, key: string): boolean {
  if (card.archivedAt || card.draft) return false;
  return key === INBOX_FILTER ? !card.labels.length : card.labels.includes(workflowColumn(key) ? `workflow:${key}` : key);
}
