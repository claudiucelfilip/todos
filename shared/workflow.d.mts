import type { Card, CardStatus, Label } from '../src/lib/types';
export const WORKFLOW_LABELS: Label[];
export function workflowId(status: CardStatus): string;
export function isWorkflowLabel(id: string): boolean;
export function workflowStatus(card: Pick<Card, 'labels'>): CardStatus | null;
export function workflowLabels(labels: string[], status: CardStatus | null): string[];
export function applyWorkflow<T extends Card>(card: T, now: string, labels?: Label[], previous?: Card): T;
export function migrateWorkflow<T extends Card>(card: T, labels?: Label[]): T;
export function linkedTodo<T extends Card>(card: T): T;
export function migrateLinkedNotes<T extends Card>(cards: T[]): T[];

export function isFlowStage(label: Label): boolean;
export function flowGroup(label: Label): string | undefined;
export function flowOrder(label: Label): number;
export function finishedStage(label: Label): boolean;
export function stageOf(card: Pick<Card, 'labels'>, labels: Label[]): Label | undefined;
export function stagesOf(group: string | undefined, labels: Label[]): Label[];
export function completionLabels(card: Card, done: boolean, labels: Label[]): string[];
