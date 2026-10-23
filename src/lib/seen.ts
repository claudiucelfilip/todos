// Cards the board has already shown: only a card missing from here plays the entrance animation.
// A silent replace (the first snapshot after launch or login) marks every card as seen.
export const seenCards = new Set<string>();

export function markSeen(ids: Iterable<string>): void {
  for (const id of ids) seenCards.add(id);
}

// A silent replace also quiets number rolls for a moment: the counters just show the new totals.
let quietUntil = 0;
let quietTimer: ReturnType<typeof setTimeout> | undefined;
export function quietFor(ms: number): void {
  quietUntil = Date.now() + ms;
  if (quietTimer) clearTimeout(quietTimer);
  if (typeof document === 'undefined') return;
  if (ms <= 0) {
    document.documentElement.setAttribute('data-sync-quiet', 'false');
    return;
  }
  document.documentElement.setAttribute('data-sync-quiet', 'true');
  quietTimer = setTimeout(
    () => document.documentElement.setAttribute('data-sync-quiet', 'false'),
    ms,
  );
}
export const isQuiet = (): boolean => Date.now() < quietUntil;
