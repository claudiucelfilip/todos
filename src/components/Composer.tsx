import { useRef } from 'react';
import { flushSync } from 'react-dom';
import { useStore } from '../hooks/useStore';
import type { Card } from '../lib/types';

interface Props {
  phone: boolean;
  view: 'board' | 'notes';
  column?: string;
  onExpand?(card: Card): void;
}

// Creation opens the same editor used for existing notes.
export default function Composer({ phone, view, column = 'todo', onExpand }: Props) {
  const store = useStore();
  const opening = useRef(false);
  const expand = () => {
    if (opening.current) return;
    opening.current = true;
    // iOS opens its keyboard only when the editor gains focus during the tap.
    flushSync(() => {
      const ordinary = view === 'board' && !['todo', 'doing', 'done', 'inbox', 'board-empty'].includes(column);
      const card = store.createBlank(view === 'board' && !ordinary ? 'todo' : null, ordinary ? [column] : []);
      onExpand?.(card);
    });
    document.querySelector<HTMLTextAreaElement>('.md-raw')?.focus({ preventScroll: true });
  };
  const label = store.labels.find((l) => l.id === column)?.name || column.charAt(0).toUpperCase() + column.slice(1);
  const placeholder = view === 'notes' ? 'Take a note…' : phone && !['todo', 'doing', 'done'].includes(column) ? `Add to ${label}…` : 'Add a to do…';
  return (
    <div className={phone ? 'composer-layer phone' : 'composer-layer desktop'} data-testid="composer">
      <button type="button" className="composer-bar" data-theme="tint-dark" data-panel="ink" data-view={view} aria-label={placeholder} data-testid="composer-bar" onClick={expand}>
        <span>{placeholder}</span>
        {!phone && <kbd className="mono composer-kbd" aria-hidden>N</kbd>}
      </button>
    </div>
  );
}
