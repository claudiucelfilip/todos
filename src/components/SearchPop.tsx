// §11.21 / §11.24.7 search results: a glass float right-aligned under the field (desktop) and the
// same rows in the phone's search layer. ↑/↓ move, Enter opens the highlighted one (the first by default).
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { displayTitle, isCardDone, stripMd } from '../../shared/notes.mjs';
import { useStore } from '../hooks/useStore';
import { findMatch } from '../lib/search';
import { cardLabels } from '../lib/labels';
import { LabelPill } from './Labels';
import type { Card } from '../lib/types';
import Ring from './Ring';
import { shortDate } from './NotesView';

export const SEARCH_WIDTH = 400;

/** The kind tag: a finished card is `done`, note or to do. */
export const placeOf = (c: Card): string =>
  isCardDone(c) ? 'done' : c.kind === 'note' ? 'note' : c.status === 'doing' ? 'doing' : c.status === 'done' ? 'done' : 'to do';

export const countLine = (n: number, q: string) => `${n} ${n === 1 ? 'result' : 'results'} for "${q.trim()}"`;
export const emptyLine = (q: string) => `No cards match "${q.trim()}"`;

/** One line of the body around the match; `{label} · {date}` when only the title matched. */
function snippetOf(c: Card, query: string, labelName?: string): string {
  if (!findMatch(displayTitle(c), query)) {
    const lines = [...stripMd(c.notes).split('\n'), ...c.items.map((i) => i.text)];
    for (const line of lines) {
      const m = findMatch(line, query);
      if (!m) continue;
      const from = Math.max(0, m.start - 24);
      return (from > 0 ? '…' : '') + line.slice(from).trim();
    }
  }
  return [labelName, shortDate(c.createdAt)].filter(Boolean).join(' · ');
}

export function SearchRow({ card, query, on, onPick }: { card: Card; query: string; on: boolean; onPick(id: string): void }) {
  const { labels } = useStore();
  const first = cardLabels(card, labels)[0];
  const done = isCardDone(card);
  return (
    <button
      type="button"
      role="option"
      aria-selected={on}
      className={`search-row${on ? ' on' : ''}${done ? ' done' : ''}`}
      data-testid={`search-result-${card.id}`}
      onPointerDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.currentTarget.focus({ preventScroll: true });
        onPick(card.id);
      }}
    >
      <Ring card={card} readOnly className="search-row-ring" />
      <span className="search-row-text">
        <span className="search-row-title">{displayTitle(card)}</span>
        <span className="search-row-snippet">{snippetOf(card, query, first?.name)}</span>
      </span>
      {first && <LabelPill label={first} />}
      <span className="mono search-row-tag">{placeOf(card)}</span>
    </button>
  );
}

export default function SearchPop({
  anchor,
  matches,
  query,
  active,
  closing,
  onPick,
  onClose,
}: {
  anchor: HTMLElement | null;
  matches: Card[];
  query: string;
  active: number;
  closing?: boolean;
  onPick(id: string): void;
  onClose(): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !anchor?.contains(target)) onClose();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [anchor, onClose]);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor?.getBoundingClientRect();
    // Right-aligned to the field, wider than it, extending left (prototype: 14 px under the field).
    if (r) setPos({ top: r.bottom + 14, left: Math.max(12, r.right - SEARCH_WIDTH), width: SEARCH_WIDTH });
  }, [anchor, query]);
  if (!pos || !query.trim()) return null;
  return createPortal(
    <div ref={root} className="search-pop" role="listbox" aria-label="Search results" data-testid="search-results" data-closing={closing || undefined} aria-hidden={closing || undefined} style={pos}>
      {matches.length ? (
        <>
          <div className="mono search-pop-count" aria-live="polite">{countLine(matches.length, query)}</div>
          {matches.slice(0, 6).map((c, i) => (
            <SearchRow key={c.id} card={c} query={query} on={i === active} onPick={onPick} />
          ))}
          <div className="search-pop-rule" aria-hidden />
          <div className="mono search-pop-keys" aria-hidden>↑↓ move · ↵ open · esc close</div>
        </>
      ) : (
        <div className="search-pop-empty" aria-live="polite">{emptyLine(query)}</div>
      )}
    </div>,
    document.querySelector('.app') ?? document.body,
  );
}
