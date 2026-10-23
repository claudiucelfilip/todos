// v6 §4b: the corner ring is the one control on every card. Faint = a note, solid = To do,
// conic fill = Doing (checklist progress, 50 % with none), filled check = Done.
import type { Card } from '../lib/types';
import { isCardDone, isNote } from '../../shared/notes.mjs';

export function ringState(card: Card, showChecklistProgress = false): { kind: 'note' | 'todo' | 'doing' | 'done'; pct: number; tip: string } {
  if (isCardDone(card)) return { kind: 'done', pct: 100, tip: 'Reopen' };
  if (showChecklistProgress && card.items.length) return { kind: 'doing', pct: Math.round(card.items.filter(i => i.done).length / card.items.length * 100), tip: 'Mark done' };
  if (isNote(card)) return { kind: 'note', pct: 0, tip: 'Add to To do' };
  if (card.status === 'todo') return { kind: 'todo', pct: 0, tip: 'Mark done' };
  const n = card.items.length;
  const pct = n ? Math.round((card.items.filter((i) => i.done).length / n) * 100) : 50;
  return { kind: 'doing', pct, tip: 'Mark done' };
}

interface Props {
  card: Card;
  onClick?(): void;
  readOnly?: boolean;
  showChecklistProgress?: boolean;
  className?: string;
}

export default function Ring({ card, onClick, readOnly, className, showChecklistProgress }: Props) {
  const { kind, pct, tip } = ringState(card, showChecklistProgress);
  const face = (
    <span className={`ring6 ring6-${kind}`} style={kind === 'doing' ? ({ ['--pct' as string]: `${pct}%` } as React.CSSProperties) : undefined} aria-hidden>
      <span className="ring6-hole">
        {kind === 'note' && (
          <svg viewBox="0 0 16 16" width="10" height="10">
            <path d="M8 3v10M3 8h10" />
          </svg>
        )}
        {kind === 'done' && (
          <svg viewBox="0 0 24 24" width="11" height="11">
            <path d="m5 12 5 5 9-10" />
          </svg>
        )}
      </span>
    </span>
  );
  if (readOnly || !onClick)
    return (
      <span className={`ring6-btn ${className ?? ''}`} data-ring={kind} title={tip.split(' · ')[0]}>
        {face}
      </span>
    );
  return (
    <button
      type="button"
      className={`ring6-btn ${className ?? ''}`}
      data-ring={kind}
      data-testid={`card-${card.id}-circle`}
      title={tip}
      aria-label={tip}
      aria-pressed={kind === 'done'}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {face}
    </button>
  );
}
