// View-only link: window.kanban keeps its read methods; every other method throws while the
// store is read-only (the store's own guard makes the actions no-ops as well).
import type { KanbanAPI } from './types';
import { isReadOnly } from '../hooks/useStore';
import { shareCopy } from './copy';

/** The window.kanban members that never change anything. Anything else (also methods added later) throws when read-only. */
export const API_READS: ReadonlySet<string> = new Set(['version', 'list', 'get', 'attachments', 'labels', 'exportText', 'subscribe', 'on']);

export function guardKanbanAPI(api: KanbanAPI | undefined = typeof window !== 'undefined' ? window.kanban : undefined): void {
  if (!api) return;
  const table = api as unknown as Record<string, unknown>;
  for (const key of Object.keys(table)) {
    const fn = table[key];
    if (API_READS.has(key) || typeof fn !== 'function') continue;
    table[key] = (...args: unknown[]) => {
      if (isReadOnly()) throw new Error(shareCopy.readOnlyError);
      return (fn as (...a: unknown[]) => unknown).apply(api, args);
    };
  }
}
