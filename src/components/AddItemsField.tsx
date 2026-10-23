// §7.4 — the add-items field at the top of a card's checklist. Enter commits
// (one item per non-empty line); Shift+Enter inserts a line break on desktop.
// Typing [[ links an existing card as a to do, or creates a new one.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { actions, state, useStore } from '../hooks/useStore';
import { useLinkShortcuts } from './LinkPrompt';
import { useDropdownPresence } from '../hooks/useDropdownPresence';
import { displayTitle, isCardDone, parentsOf, stripMd, wouldCycle } from '../../shared/notes.mjs';
import { foldText } from '../lib/search';
import { shortDate } from './NotesView';
import type { Card } from '../lib/types';

/** Link candidates for `[[query`: fuzzy on title and body, newest first, never a loop or a repeat. */
export function linkMatches(cardId: string, query: string, cards: ReadonlyArray<Card>, max = 4): Card[] {
  const self = cards.find((c) => c.id === cardId);
  const q = foldText(query.trim());
  const parents = new Set(parentsOf(cards, cardId).map((c) => c.id));
  const linked = new Set((self?.items ?? []).map((i) => i.ref).filter(Boolean));
  // Rank: the query in the title, then in the body, then its letters in order in the title.
  const rank = (c: Card): number => {
    if (!q) return 0;
    const t = foldText(displayTitle(c));
    if (t.includes(q)) return 0;
    if (foldText(stripMd(c.notes)).includes(q)) return 1;
    let k = 0;
    for (const ch of t) if (ch === q[k] && ++k === q.length) return 2;
    return -1;
  };
  return cards
    .filter((c) => !c.archivedAt && c.id !== cardId && !parents.has(c.id) && !linked.has(c.id) && !wouldCycle(cards as Card[], cardId, c.id))
    .map((c) => ({ c, r: rank(c) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || (b.c.updatedAt ?? '').localeCompare(a.c.updatedAt ?? ''))
    .map((x) => x.c)
    .slice(0, max);
}

interface Props {
  cardId: string;
  hasItems: boolean;
  phone: boolean;
  autoFocus?: boolean;
}

const MAX_ROWS = 8;
const MIN_ROWS = 1;

function isComposing(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return e.nativeEvent.isComposing; // keyCode 229 alone is a plain Enter on Safari/iOS
}

export default function AddItemsField({ cardId, phone, autoFocus }: Props) {
  const { addItem } = useStore();
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  // Paste a URL over selected words (or ⌘K) to make them a link.
  const links = useLinkShortcuts(ref, draft, setDraft);

  const lines = draft.split('\n').filter((l) => l.trim() !== '').length;

  // [[ token: from the last "[[" with no "]]" after it, unless Esc kept it literal.
  const [keptAt, setKeptAt] = useState<number | null>(null);
  const tokenAt = draft.lastIndexOf('[[');
  const linking = tokenAt >= 0 && !draft.slice(tokenAt).includes(']]') && keptAt !== tokenAt && !draft.slice(tokenAt).includes('\n');
  const query = linking ? draft.slice(tokenAt + 2) : '';
  const { cards, labels } = useStore();
  const matches = useMemo(() => (linking ? linkMatches(cardId, query, cards) : []), [linking, cardId, query, cards]);
  const linkPresence = useDropdownPresence(linking);
  const lastLink = useRef({ query, matches });
  if (linking) lastLink.current = { query, matches };
  const [pick, setPick] = useState(0);
  useEffect(() => setPick(0), [query, linking]);
  useEffect(() => {
    if (!linking) return;
    const outside = (event: PointerEvent) => {
      if (!ref.current?.parentElement?.contains(event.target as Node)) setKeptAt(tokenAt);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [linking, tokenAt]);
  const before = linking ? draft.slice(0, tokenAt).trim() : '';
  const finishLink = (target: Card | 'new') => {
    if (before) addItem(cardId, before);
    if (target === 'new') {
      if (query.trim()) actions.linkNewTodo(cardId, query.trim());
    } else actions.linkCard(cardId, target.id);
    setDraft('');
    setKeptAt(null);
    ref.current?.focus();
  };
  const kindTag = (c: Card) => (c.kind === 'note' ? 'make to do' : c.status === 'todo' ? 'to do' : c.status);
  const metaOf = (c: Card) => {
    const names = (c.labels ?? []).map((id) => labels.find((l) => l.id === id)?.name).filter(Boolean);
    const parts = [names.length ? names.join(', ') : c.kind === 'note' ? 'Inbox' : ''];
    if (c.items.length) parts.push(`${c.items.filter((i) => i.done).length}/${c.items.length}`);
    parts.push(shortDate(c.createdAt));
    return parts.filter(Boolean).join(' · ');
  };

  // Reflow the placeholder and draft when the panel width changes too.
  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 20;
    // border-box: the height includes padding and borders; scrollHeight has no borders.
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + border;
    const max = lh * MAX_ROWS + pad;
    el.style.height = Math.min(Math.max(el.scrollHeight + border, lh * MIN_ROWS + pad), max) + 'px';
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  };
  useEffect(grow, [draft]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      grow();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus, cardId]);

  const commit = () => {
    if (!draft.trim()) return;
    addItem(cardId, draft);
    setDraft('');
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (linking) {
      const n = matches.length + 1; // the matches and "New to do"
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setKeptAt(tokenAt); // the brackets stay as typed
        return;
      }
      if (e.key === 'Enter' && !isComposing(e)) {
        e.preventDefault();
        if (pick < matches.length) finishLink(matches[pick]);
        else if (query.trim()) finishLink('new');
        return;
      }
    }
    if (links.onKeyDown(e)) return;
    if (e.key !== 'Enter' || isComposing(e)) return;
    if (e.shiftKey && !phone) return; // line break
    e.preventDefault();
    commit();
  };

  return (
    <div className={`dt-add${linking ? ' linking' : ''}`}>
      <svg className="dt-add-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <path d="M12 5v14M5 12h14" />
      </svg>
      <textarea
        ref={ref}
        className="dt-add-input"
        data-testid="detail-add-items"
        placeholder="Add an item, or type [[ to link a to do"
        value={draft}
        rows={1}
        enterKeyHint="done"
        autoCapitalize="sentences"
        autoCorrect="on"
        spellCheck
        onChange={(e) => {
          const v = e.target.value;
          // "]]" closes the token: the first match, else a new to do.
          const t = v.lastIndexOf('[[');
          if (t >= 0 && v.endsWith(']]') && v.slice(t).indexOf(']]') === v.length - t - 2 && keptAt !== t) {
            const q = v.slice(t + 2, -2).trim();
            const hit = linkMatches(cardId, q, state.board.cards).find((c) => foldText(displayTitle(c)) === foldText(q));
            const head = v.slice(0, t).trim();
            if (head) addItem(cardId, head);
            if (hit) actions.linkCard(cardId, hit.id);
            else if (q) actions.linkNewTodo(cardId, q);
            setDraft('');
            return;
          }
          if (keptAt !== null && t !== keptAt) setKeptAt(null);
          setDraft(v);
        }}
        onKeyDown={onKeyDown}
        onPaste={links.onPaste}
        aria-label="Add items"
      />
      {links.prompt}
      {linkPresence.mounted && (
        <div className="link-pop" role="listbox" aria-label="Link a to do" data-closing={linkPresence.closing || undefined} aria-hidden={linkPresence.closing || undefined}>
          <div className="link-pop-hint mono">Link a to do · ↑↓ · ↵ to link · esc to keep typing</div>
          {(linking ? matches : lastLink.current.matches).map((c, i) => (
            <div
              key={c.id}
              role="option"
              aria-selected={pick === i}
              className={`link-pop-row${pick === i ? ' on' : ''}`}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => finishLink(c)}
            >
              <span className={`link-pop-box${isCardDone(c) ? ' done' : ''}`} aria-hidden />
              <span className="link-pop-text">
                <span className="link-pop-title">{displayTitle(c)}</span>
                <span className="link-pop-meta mono">{metaOf(c)}</span>
              </span>
              <span className="ref-tag mono">{kindTag(c)}</span>
            </div>
          ))}
          <div className="link-pop-rule" />
          <div
            role="option"
            aria-selected={pick === (linking ? matches.length : lastLink.current.matches.length)}
            className={`link-pop-row new${pick === (linking ? matches.length : lastLink.current.matches.length) ? ' on' : ''}`}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => query.trim() && finishLink('new')}
          >
            <span className="link-pop-box dashed" aria-hidden />
            <span className="link-pop-text">
              <span className="link-pop-title">New to do "{linking ? query : lastLink.current.query}"</span>
              <span className="link-pop-meta mono">linked here · starts in To do</span>
            </span>
          </div>
        </div>
      )}
      {lines >= 2 && (
        <button
          type="button"
          className="dt-add-many"
          onPointerDown={(e) => e.preventDefault()}
          onClick={commit}
        >
          Add {lines} items
        </button>
      )}
    </div>
  );
}
