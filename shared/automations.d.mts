import type { Card, Label, AutomationRule } from '../src/lib/types';
export const CONDITIONS: AutomationRule['condition'][];
export const ACTIONS: AutomationRule['action'][];
export const DEFAULT_RULES: Record<string, AutomationRule[]>;
export function groupOf(label: Label): string | null;
export function rulesOf(label: Label): AutomationRule[];
export function cleanBehavior(src: Partial<Label>, prev?: Partial<Label>): Pick<Label, 'group' | 'automations' | 'removeOnView' | 'flowStage'>;
export function groupedLabels(ids: string[], labels: Label[]): string[];
export function settleAutomations(cards: Card[], labels: Label[], before: Card[], now: string): Card[];
