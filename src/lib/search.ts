// §4.4 — live search: case- and diacritic-insensitive substring match on
// title, notes and item text. An optional status prefix (todo: / doing: /
// done:) scopes the query to one column; "#name" also matches a card's labels.
import type { Card, CardStatus, Label } from './types';

const PREFIX = /^(todo|doing|done):\s*(.*)$/i;

interface ParsedQuery {
  status?: CardStatus;
  q: string;
}

/** Lowercase + strip combining marks (NFD). */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function parseQuery(query: string): ParsedQuery {
  const raw = query.trim();
  if (!raw) return { q: '' };
  const m = raw.match(PREFIX);
  if (m) return { status: m[1].toLowerCase() as CardStatus, q: foldText(m[2].trim()) };
  return { q: foldText(raw) };
}

export function searchMatches(card: Card, query: string, labels: ReadonlyArray<Label> = []): boolean {
  const { status, q } = parseQuery(query);
  if (status && card.status !== status) return false;
  if (!q) return true;
  if (foldText([card.title, card.notes, ...card.items.map((i) => i.text)].join('\n')).includes(q)) return true;
  // "#name" also matches cards carrying a label whose name starts with it.
  if (q.startsWith('#') && q.length > 1) {
    const want = q.slice(1);
    return labels.some((l) => card.labels?.includes(l.id) && foldText(l.name).startsWith(want));
  }
  return false;
}

/**
 * Locate the folded query inside `text` and map the hit back to original
 * indices (marks removed by folding shift positions).
 */
export function findMatch(text: string, query: string): { start: number; end: number } | null {
  const q = parseQuery(query).q;
  if (!q) return null;
  // Fold char by char so each folded char knows its source index.
  const map: number[] = [];
  let folded = '';
  for (let i = 0; i < text.length; i++) {
    const f = foldText(text[i]);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
  }
  const at = folded.indexOf(q);
  if (at < 0) return null;
  const start = map[at];
  const end = map[at + q.length - 1] + 1;
  return { start, end };
}
