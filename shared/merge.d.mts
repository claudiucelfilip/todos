import type { Card, Label } from '../src/lib/types';

export interface SyncAction {
  id: string;
  deviceId: string;
  ts: string;
  type: 'card.put' | 'card.set' | 'card.delete' | 'item.put' | 'item.set' | 'item.delete' | 'items.order' | 'att.put' | 'att.delete' | 'label.put' | 'label.delete';
  payload: Record<string, unknown>;
  seq?: number;
}
export interface MergeState { cards: Record<string, Card>; meta: Record<string, unknown>; labels: Record<string, Label>; lmeta: Record<string, unknown> }
export function emptyState(): MergeState;
export function applyAction(state: MergeState, action: SyncAction): boolean;
export function snapshot(state: MergeState): { cards: Card[]; tombstones: string[]; labels: Label[]; labelTombstones: string[] };
export function pruneTombstones(state: MergeState, nowIso: string, days?: number): void;
export function stateFromCards(cards: Card[], labels?: Label[]): MergeState;
export function diffCards(before: Card[], after: Card[], ts: string, deviceId: string): SyncAction[];
export function diffLabels(before: Label[], after: Label[], ts: string, deviceId: string): SyncAction[];
