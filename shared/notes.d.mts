import type { Card } from '../src/lib/types';

export function isNote(c: Pick<Card, 'kind'> | null | undefined): boolean;
export function isCardDone(c: Pick<Card, 'kind' | 'done' | 'status'> | null | undefined): boolean;
export function stripMd(s: string | null | undefined): string;
export function shortTitle(s: string | null | undefined): string;
export function displayTitle(c: Pick<Card, 'title' | 'notes'> | null | undefined): string;
export function firstImage(s: string | null | undefined): { alt: string; url: string } | null;
export function bodyLinks(s: string | null | undefined): { title: string; url: string }[];
export function migrateCard<T extends Card>(card: T): T | null;
export function hostOf(url: string): string;
export function parentsOf<T extends Card>(cards: ReadonlyArray<T>, id: string): T[];
export function wouldCycle(cards: ReadonlyArray<Card>, parentId: string, childId: string): boolean;
