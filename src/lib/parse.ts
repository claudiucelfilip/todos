// §14.1 — one text grammar, shared by the composer, copy-as-text, share,
// the URL add intent, and the window.kanban JS API.
//
// Parsing:
//    - Line 1                -> title (a leading "# " prefix is stripped; trimmed).
//    - Plain lines until the first marker -> notes.
//    - From the first marker, every non-empty line -> an item.
//    - Markers: "- [ ]", "- [x]"/"- [X]", and also "-", "*", "• ",
//      "1. ", "1) ", "[ ] " (all unchecked).
//    - Bare lines after the first item are also (unchecked) items.
//    - "---" separates cards (used in bulk paste).
//    - Blank lines are ignored; trailing whitespace is trimmed.
//    - Limits: truncate the title to 200 chars, cap items at 500, report drops.

import type { CardItem } from './types';

export const TITLE_MAX = 200;
/** Item text: room for a Markdown link's URL ([words](https://…)). */
export const ITEM_MAX = 1000;
export const NOTES_MAX = 5000;
export const ITEMS_MAX = 500;

export interface ParsedCard {
  title: string;
  notes: string;
  items: CardItem[];
  dropped: number; // items beyond ITEMS_MAX that were not kept
}

// Ordered so the bracket forms win over the bare-bullet forms.
const RE_BULLET_CHECK = /^[-*•]\s+\[([ xX])\](?!\()\s*(.*)$/;
const RE_BRACKET_CHECK = /^\[([ xX])\](?!\()\s*(.*)$/; // "[x](url)" is a link, not a checkbox
const RE_BULLET = /^[-*•]\s+(.*)$/;
const RE_NUM = /^\d+[.)]\s+(.*)$/;

/**
 * Classify a single line as an item-marker line, or null if it is a plain
 * (note / bare) line with no recognised marker prefix.
 */
export function analyzeLine(
  line: string,
): { checked: boolean; body: string } | null {
  const t = line.replace(/\s+$/, ''); // trailing whitespace trimmed
  const s = t.trim();
  if (s === '' || s === '---') return null;

  let m: RegExpMatchArray | null;
  m = t.match(RE_BULLET_CHECK);
  if (m) return { checked: m[1].toLowerCase() === 'x', body: m[2].trim() };
  m = t.match(RE_BRACKET_CHECK);
  if (m) return { checked: m[1].toLowerCase() === 'x', body: m[2].trim() };
  m = t.match(RE_BULLET);
  if (m) return { checked: false, body: m[1].trim() };
  m = t.match(RE_NUM);
  if (m) return { checked: false, body: m[1].trim() };
  return null;
}

/**
 * Parse one card's section of text.
 *   line 1                -> title (a "# " prefix is stripped, then trimmed)
 *   plain lines, until the first marker -> notes
 *   from the first marker  -> items (bare lines become unchecked items too)
 * `uid` gives each item a stable id; items are capped at ITEMS_MAX and the
 * overflow count is reported as `dropped`.
 */
export function parseCard(
  source: string,
  uid: () => string = () => 'i' + Math.random().toString(36).slice(2, 10),
): ParsedCard {
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  let title = (lines[0] ?? '').trim();
  if (title.startsWith('# ')) title = title.slice(2).trim();
  else if (title === '#') title = '';

  const notes: string[] = [];
  const allItems: CardItem[] = [];
  let inItems = false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue; // blank: ignored
    if (line.trim() === '---') continue; // card separator

    const a = analyzeLine(line);
    if (a === null) {
      // A bare line only becomes an item once we are already in item mode;
      // before the first marker it is a note line.
      if (inItems) allItems.push({ id: uid(), text: line.trim().slice(0, ITEM_MAX), done: false });
      else notes.push(line.trim());
      } else {
      allItems.push({ id: uid(), text: a.body.slice(0, ITEM_MAX), done: a.checked });
      inItems = true;
      }
    }

  const dropped = Math.max(0, allItems.length - ITEMS_MAX);
  return {
    title: title.slice(0, TITLE_MAX),
    notes: notes.join('\n').slice(0, NOTES_MAX),
    items: allItems.slice(0, ITEMS_MAX),
    dropped,
    };
}

/** Split pasted bulk text on "---" into per-card sections. */
export function splitCards(input: string): string[] {
  return input
    .replace(/\r\n/g, '\n')
    .split(/\n\s*---\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Serialize a card back to the grammar for copy-as-text / share / export.
 * Checked items are marked "- [x]", unchecked "- [ ]".
 */
export function composeCard(
  card: {
    title: string;
    notes: string;
    items: ReadonlyArray<Pick<CardItem, 'text' | 'done'>>;
    },
): string {
  // §7.9 shape: title, blank line, notes, blank line, items. A "# " prefix is
  // only added when the bare title would itself read as a list marker.
  const t = card.title.trim();
  const lines: string[] = [analyzeLine(t) || t === '---' ? `# ${t}` : t];
  if (card.notes.trim()) lines.push('', card.notes.trim());
  if (card.items.length) lines.push('');
  for (const it of card.items) lines.push(`${it.done ? '- [x]' : '- [ ]'} ${it.text}`);
  return lines.join('\n');
}
