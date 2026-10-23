import { displayTitle } from '../../shared/notes.mjs';
// §4.3 / §7.11 archive: newest first, grouped by month; Restore / Delete per
// card; "Delete all archived" (store toasts with 30 s Undo).
import { useRef } from 'react';
import type { Card } from '../lib/types';
import { useStore } from '../hooks/useStore';
import { monthLabel, relativeDate } from '../lib/dates';
import { useDialog } from './SettingsPanel';

interface Props {
  onClose(): void;
  onOpenCard(id: string): void;
  phone: boolean;
}

export default function ArchiveView({ onClose, onOpenCard, phone }: Props) {
  const { cards, restoreCard, deleteArchived, deleteAllArchived } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, onClose);

  const archived = cards
    .filter((c) => c.archivedAt)
    .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));

  const groups: { label: string; cards: Card[] }[] = [];
  for (const c of archived) {
    const label = monthLabel(c.archivedAt!);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.cards.push(c);
    else groups.push({ label, cards: [c] });
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        ref={ref}
        className={`dialog archive${phone ? ' dialog-full' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Archive"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="dialog-head">
          <button type="button" className="btn btn-quiet" onClick={onClose} aria-label="Back to board">
            ← Board
          </button>
          <h2>
            Archive <span className="mono">{archived.length}</span>
          </h2>
        </header>

        <div className="dialog-body">
          {archived.length === 0 ? (
            <p className="mono archive-empty">No archived cards</p>
          ) : (
            groups.map((g) => (
              <section className="archive-group" key={g.label}>
                <h3 className="mono">{g.label}</h3>
                {g.cards.map((c) => (
                  <div className="archive-row" key={c.id} data-testid={`archived-${c.id}`}>
                    <button type="button" className="archive-title" onClick={() => onOpenCard(c.id)}>
                      <span className="archive-title-text">{displayTitle(c)}</span>
                      <span className="mono">{c.completedAt ? `done ${relativeDate(c.completedAt)}` : ''}</span>
                    </button>
                    <button type="button" className="btn" onClick={() => restoreCard(c.id)}>
                      Restore
                    </button>
                    <button type="button" className="btn btn-danger" onClick={() => deleteArchived(c.id)}>
                      Delete
                    </button>
                  </div>
                ))}
              </section>
            ))
          )}
        </div>

        {archived.length > 0 && (
          <footer className="dialog-foot">
            <button type="button" className="btn btn-danger" onClick={deleteAllArchived}>
              Delete all archived
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
