import { workflowStatus, isWorkflowLabel } from '../../shared/workflow.mjs';
import { memo, useEffect, useRef, useState } from 'react';
import type { Card, CardItem } from '../lib/types';
import { actions, state, useLabels, useReadOnly } from '../hooks/useStore';
import { seenCards as seen, isQuiet } from '../lib/seen';
import { findMatch, searchMatches } from '../lib/search';
import { flipState } from '../lib/flip';
import { LabelPill } from './Labels';
import { relativeDate } from '../lib/dates';
import { ReminderBadge } from './Reminder';
import { cardLabels, faceLink } from '../lib/labels';
import { swipeCopy } from '../lib/copy';
import { isImage, thumbUrl } from '../lib/files';
import { useTouchUI } from '../hooks/useLayout';
import CardContextMenu from './CardContextMenu';
import { useDropdownPresence } from '../hooks/useDropdownPresence';
import { useSwipeRow } from '../hooks/useSwipeRow';
import { markSlidOut } from '../lib/slid';
import { linkify, plainText } from '../lib/linkify';
import Ring from './Ring';
import { MarkdownPreview } from './MarkdownBody';
import { bodyLinks, displayTitle, firstImage, stripMd } from '../../shared/notes.mjs';

// §5.1 card face (v6): title · excerpt | checklist · meta, with the ring in the top-right corner.
// Tapping anywhere except the ring opens the card; desktop double-click on
// the title edits it in place. §14.4 data attributes + §12 accessible name.

interface Props {
  card: Card;
  open: boolean;
  selected: boolean;
  onOpen(id: string, restore?: boolean): void;
  onSelect?(id: string): void;
  phone: boolean;
  searchQuery?: string;
  columnLabel?: string;
  hidden?: boolean;
  /** Exit animation (§11.2): the card is unmounting; phone adds a slide toward the destination. */
  leaving?: boolean;
  leaveDir?: 'left' | 'right' | null;
  /** Position among cards entering in the same batch (30 ms stagger); -1 = no stagger. */
  enterIndex?: number;
}

const STATUS_LABEL = { todo: 'To do', doing: 'Doing', done: 'Done' } as const;

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Wrap the first case- and diacritic-insensitive hit of `q` in <mark>. */
function highlight(text: string, q?: string) {
  if (!q) return text;
  const m = findMatch(text, q);
  if (!m) return text;
  return (
    <>
      {text.slice(0, m.start)}
      <mark className="hl">{text.slice(m.start, m.end)}</mark>
      {text.slice(m.end)}
    </>
  );
}

// Memoised: a card whose object did not change (replaceBoard keeps equal cards) does not re-render.
export default memo(CardFace);

function CardFace({
  card,
  open,
  selected,
  onOpen,
  onSelect,
  phone,
  searchQuery,
  columnLabel,
  hidden,
  leaving,
  leaveDir,
  enterIndex = -1,
}: Props) {
  const { cycleRing, deleteCardById } = actions;
  const labels = useLabels();
  const readOnly = useReadOnly(); // a view-only link: the face opens the card, nothing else
  const done = card.items.filter((i) => i.done).length;
  const total = card.items.length;
  const [inlineItems, setInlineItems] = useState<CardItem[]>(() =>
    [...card.items.filter((i) => !i.done), ...card.items.filter((i) => i.done)],
  );
  useEffect(() => {
    const ordered = [...card.items.filter((i) => !i.done), ...card.items.filter((i) => i.done)];
    if (state.lastChangeType === 'remote' || state.lastChangeType === 'reload') {
      setInlineItems(ordered);
      return;
    }
    // Let the check finish in place before moving the item below unfinished work.
    setInlineItems((previous) => {
      const ids = new Set(previous.map((i) => i.id));
      return [
        ...previous.flatMap((i) => card.items.find((next) => next.id === i.id) ?? []),
        ...card.items.filter((i) => !ids.has(i.id)),
      ];
    });
    const timer = setTimeout(() => setInlineItems(ordered), 240);
    return () => clearTimeout(timer);
  }, [card.items]);
  const faceStatus = columnLabel ? (columnLabel.startsWith('workflow:') ? columnLabel.slice(9) : 'todo') : card.status;
  const isDone = faceStatus === 'done';

  // Enter animation only for cards that appear after the first paint (§11.2).
  const [entering, setEntering] = useState(
    () => flipState.ready && !seen.has(card.id) && !isQuiet(),
  );
  useEffect(() => {
    seen.add(card.id);
  }, [card.id]);

  // Completion pulse when the card reaches Done while mounted (§11.1).
  const prevStatus = useRef(card.status);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    // Only a local completion pulses; background changes arrive without motion.
    const local = state.lastChangeType !== 'remote' && state.lastChangeType !== 'reload';
    if (card.status === 'done' && prevStatus.current !== 'done' && local) {
      setPulse(true);
      const t = setTimeout(() => setPulse(false), 500);
      prevStatus.current = card.status;
      return () => clearTimeout(t);
    }
    prevStatus.current = card.status;
  }, [card.status]);

  // Search: non-matching cards fade to .3 then collapse after 200 ms (§11.9).
  const matches = !searchQuery || searchMatches(card, searchQuery, labels);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (matches) {
      setCollapsed(false);
      return;
    }
    const t = setTimeout(() => setCollapsed(true), 200);
    return () => clearTimeout(t);
  }, [matches]);

  // Inline title edit (desktop double-click).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const startEdit = () => {
    if (phone || readOnly) return;
    setDraft(displayTitle(card));
    cancelled.current = false;
    setEditing(true);
  };
  const commit = () => {
    if (!cancelled.current && draft.trim() && draft.trim() !== displayTitle(card)) actions.setTitle(card.id, draft);
    setEditing(false);
  };
  // F1: a click on the title waits one double-click window before opening, so a
  // double-click edits in place without opening the detail; clicks elsewhere open at once.
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (openTimer.current) clearTimeout(openTimer.current);
    },
    [],
  );
  const cancelPendingOpen = () => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };

  // Touch outside the phone Board: swipe left reveals Delete.
  const touchUI = useTouchUI();
  const touchRow = touchUI && !phone && !readOnly;
  const swipe = useSwipeRow({
    enabled: touchRow && !leaving,
    left: true,
    right: false,
    confirmCommit: true,
    onCommit: () => {
      markSlidOut(card.id); // already off-screen: no presence exit after this
      deleteCardById(card.id); // presence keeps the node for the exit (§11.2)
    },
  });

  // Desktop pointer: right-click / ContextMenu key / the hover ··· open the card menu; the hover → takes the next step.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const lastMenuAt = useRef(menuAt);
  if (menuAt) lastMenuAt.current = menuAt;
  const menuPresence = useDropdownPresence(!!menuAt);
  const articleRef = useRef<HTMLElement>(null);
  const lastPointer = useRef('mouse');
  const closeMenu = (focusCard: boolean) => {
    setMenuAt(null);
    if (focusCard) articleRef.current?.focus({ preventScroll: true });
  };
  const menuAtCard = () => {
    const r = articleRef.current?.getBoundingClientRect();
    if (r) setMenuAt({ x: r.left + 24, y: r.top + Math.min(r.height, 40) });
  };

  // A ref row shows the linked card as it is now (its title, its progress), the stored text if it is gone.
  const refCard = (id: string) => state.board.cards.find((c) => c.id === id);
  const refTitle = (i: CardItem) => {
    const c = i.ref ? refCard(i.ref) : undefined;
    return c ? displayTitle(c) : i.text;
  };
  const refTag = (id: string) => {
    const c = refCard(id);
    if (!c) return 'note';
    const kind = c.kind === 'note' ? 'note' : 'to do';
    return c.items.length ? `${c.items.filter((x) => x.done).length}/${c.items.length} · ${kind}` : kind;
  };
  const pills = cardLabels(card, labels).filter((l) => !isWorkflowLabel(l.id) && l.id !== columnLabel);
  const link = faceLink(card) ?? bodyLinks(card.notes)[0] ?? null;
  const title = displayTitle(card);
  const refs = card.items.filter((i) => i.ref).length;
  const bodyLines = stripMd(card.notes).split('\n').map((l) => l.trim()).filter(Boolean);
  const previewLines = bodyLines[0] === title ? bodyLines.slice(1) : bodyLines;
  const excerpt = !isDone ? previewLines.join(' ') : '';
  const markdownLines = card.notes.trim().split('\n');
  const markdownExcerpt = stripMd(markdownLines[0]) === title ? markdownLines.slice(1).join('\n') : card.notes;
  const mdImage = firstImage(card.notes);
  const linkHost = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'link'; } };
  const atts = card.attachments ?? [];
  const faceImage = atts[0] && isImage(atts[0]) ? atts[0] : null;
  const mdThumb = mdImage && /^\/kanban\/files\/[\w-]+$/.test(mdImage.url) ? atts.find((a) => mdImage.url.endsWith(a.id)) : null;
  const workflow = card.workflowVersion === 1 ? workflowStatus(card) : card.kind === 'note' ? null : card.status;
  const name = `${plainText(title)}, ${workflow ? STATUS_LABEL[workflow] : 'note'}${total ? `, ${done} of ${total} items` : ''}${pills.length ? `, ${pills.map((l) => l.name).join(', ')}` : ''}`;

  const style: React.CSSProperties = {};
  if (hidden) style.display = 'none';
  if (entering && enterIndex > 0) style.animationDelay = `${Math.min(enterIndex, 8) * 30}ms`;

  const article = (
    <article
      ref={articleRef}
      className={cx(
        'card-face',
        isDone && 'done',
        faceStatus === 'doing' && 'doing',
        card.someday && 'someday',
        open && 'open',
        selected && 'selected',
        entering && !leaving && 'entering',
        pulse && 'pulse',
        !matches && 'dim',
        collapsed && 'collapsed',
        leaving && 'exiting',
        leaving && leaveDir === 'left' && 'exit-left',
        leaving && leaveDir === 'right' && 'exit-right',
      )}
      style={style}
      aria-hidden={leaving || undefined}
      data-testid={`card-${card.id}`}
      data-card-id={card.id}
      data-status={card.status}
      data-progress={total ? `${done}/${total}` : undefined}
      tabIndex={0}
      aria-label={name}
      onFocus={(e) => {
        if (e.target === e.currentTarget) onSelect?.(card.id);
      }}
      // The enter animation plays once: a later display:none → shown (drag, hidden column) must not replay it.
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && e.animationName === 'card-enter') setEntering(false);
      }}
      onClick={(e) => {
        const t = e.target as HTMLElement;
        if (
          (t.closest('.ring6-btn') && !readOnly) ||
          t.closest('.card-title-edit') ||
          t.closest('.card-link') ||
          t.closest('.card-quick') ||
          t.closest('.card-return')
        )
          return;
        if (
          document.activeElement instanceof HTMLElement &&
          document.activeElement !== e.currentTarget
        ) {
          document.activeElement.blur(); // §9.1: blur first, then act
        }
        if (!phone && !readOnly && t.closest('.card-title')) {
          if (e.detail > 1) return; // second click of a double-click: the title editor handles it
          cancelPendingOpen();
          openTimer.current = setTimeout(() => {
            openTimer.current = null;
            onOpen(card.id);
          }, 250);
          return;
        }
        onOpen(card.id);
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          onOpen(card.id, true);
        } else if (!readOnly && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
          e.preventDefault();
          menuAtCard();
        }
      }}
      onPointerDown={(e) => {
        lastPointer.current = e.pointerType;
      }}
      onContextMenu={(e) => {
        if (readOnly) return; // the browser's own menu, not the card menu
        // Touch long-press belongs to the drag; a real right-click opens the menu.
        if (leaving || lastPointer.current === 'touch' || lastPointer.current === 'pen') {
          e.preventDefault();
          return;
        }
        if (e.button === -1 || (e.target as HTMLElement).closest('a, input')) return;
        e.preventDefault();
        setMenuAt({ x: e.clientX, y: e.clientY });
      }}
    >
      <Ring card={card} readOnly={readOnly} onClick={leaving ? undefined : () => cycleRing(card.id)} className="card-ring" />
      <div className="card-body">
        {editing ? (
          <input
            ref={inputRef}
            className="card-title card-title-edit"
            value={draft}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            maxLength={200}
            aria-label="Card title"
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                cancelled.current = true;
                setEditing(false);
              }
            }}
            onBlur={commit}
          />
        ) : (
          <h3
            className="card-title"
            onDoubleClick={(e) => {
              e.stopPropagation();
              cancelPendingOpen();
              startEdit();
            }}
          >
            {searchQuery ? highlight(title, searchQuery) : linkify(title, false)}
          </h3>
        )}
        {excerpt && <div className="card-excerpt md-preview">{searchQuery ? highlight(excerpt, searchQuery) : <MarkdownPreview card={card} value={markdownExcerpt} compact />}</div>}

        {(faceStatus === 'todo' || faceStatus === 'doing') && total > 0 && (
          <div
            className="card-inline-items"
            role="group"
            aria-label="Checklist"
            tabIndex={inlineItems.length > 3 ? 0 : undefined}
            onPointerDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {inlineItems.map((i) => (
              <div className={`card-inline-item${i.done ? ' checked' : ''}${i.ref ? ' ref' : ''}`} key={i.id}>
                <button
                  type="button"
                  className="inline-box"
                  aria-label={i.text}
                  aria-pressed={i.done}
                  disabled={readOnly}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.toggleItem(card.id, i.id);
                  }}
                >
                  {i.done && (
                    <svg viewBox="0 0 16 16">
                      <path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" />
                    </svg>
                  )}
                </button>
                <span className="inline-text">
                  <span>{i.ref ? refTitle(i) : i.text}</span>
                  {i.ref && <span className="mono ref-tag">{refTag(i.ref)}</span>}
                </span>
                {i.ref && (
                  <button
                    type="button"
                    className="ref-open"
                    aria-label={`Open ${refTitle(i)}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(i.ref!);
                    }}
                  >
                    ›
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {(
          <div className="card-meta mono">
            <ReminderBadge card={card} />
            {card.repeat && <span className="repeat">↻</span>}
            {refs > 0 && (
              <span className="card-refs">
                <span className="note-glyph" aria-hidden />
                {refs} {refs === 1 ? 'note' : 'notes'}
              </span>
            )}
            {link && (
              <a
                className="card-link"
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={link.url}
              >
                {linkHost(link.url)}
              </a>
            )}
            {pills.slice(0, 2).map((l) => (
              <LabelPill key={l.id} label={l} />
            ))}
            {pills.length > 2 && <span className="label-more">+{pills.length - 2}</span>}
            {isDone && card.completedAt && <span className="card-done-date">{relativeDate(card.completedAt)}</span>}
          </div>
        )}
      </div>
      {(mdThumb || (!mdImage && faceImage)) && (
        <img
          className="card-thumb"
          src={thumbUrl((mdThumb ?? faceImage)!)}
          alt=""
          loading="lazy"
          draggable={false}
          data-testid={`card-${card.id}-thumb`}
        />
      )}
    </article>
  );

  // Rendered beside the article, not in it: portal events would otherwise bubble into the card's handlers.
  const menuPosition = menuAt ?? lastMenuAt.current;
  const menu = menuPresence.mounted && menuPosition && !readOnly && (
    <CardContextMenu
      card={card}
      x={menuPosition.x}
      y={menuPosition.y}
      closing={menuPresence.closing}
      onClose={closeMenu}
      onOpenCard={onOpen}
    />
  );
  if (!touchRow)
    return (
      <>
        {article}
        {menu}
      </>
    );
  return (
    <div ref={swipe.wrap} className={cx('card-swipe', hidden && 'hidden')} data-swipe-row>
      <div className="swipe-bg swipe-bg-delete">
        <button
          type="button"
          className="swipe-action swipe-delete"
          tabIndex={-1}
          aria-label={swipeCopy.deleteAria(title)}
          onClick={() => swipe.trigger('left')}
        >
          <svg
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
          </svg>
          <span>{swipeCopy.delete}</span>
        </button>
      </div>
      <div ref={swipe.row} className="card-swipe-inner">
        {article}
      </div>
      {menu}
    </div>
  );
}
