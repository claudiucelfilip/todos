import { useEffect, useRef } from 'react';
import Roll from './Roll';
import { useStore } from '../hooks/useStore';
import { pillVars } from '../lib/labels';

export type PhoneColumn = string;
interface Props {
  column: PhoneColumn; onChange(s: PhoneColumn): void; counts: Record<string, number>;
  columns: { status: string; label: string; labelId: string }[]; archived: number | null;
}

export default function PhoneNav({ column, onChange, counts, archived, columns }: Props) {
  const { labels } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const button = ref.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (button && ref.current) {
      const left = button.offsetLeft, right = left + button.offsetWidth;
      if (left < ref.current.scrollLeft) ref.current.scrollLeft = left;
      else if (right > ref.current.scrollLeft + ref.current.clientWidth) ref.current.scrollLeft = right - ref.current.clientWidth;
    }
  }, [column]);
  if (column === 'notes') return null;
  const segments = [...columns];
  if (archived !== null) segments.push({ status: 'archived', label: 'Archived', labelId: 'archived' });
  return (
    <div className="phone-column-pills">
      <div ref={ref} className="phone-column-list" role="radiogroup" aria-label="Column">
        {segments.map((s, i) => (
        <button key={s.status} type="button" role="radio" aria-checked={column === s.status}
          data-testid={`nav-${s.status}`} className={`phone-column-pill${column === s.status ? ' active' : ''}`}
          style={pillVars(labels.find((l) => l.id === s.labelId)?.color || '#6B7480')}
          tabIndex={column === s.status ? 0 : -1}
          onClick={() => onChange(s.status)}
          onKeyDown={(e) => {
            const next = e.key === 'ArrowRight' ? (i + 1) % segments.length : e.key === 'ArrowLeft' ? (i + segments.length - 1) % segments.length : -1;
            if (next < 0) return;
            e.preventDefault(); onChange(segments[next].status);
            (ref.current?.children[next] as HTMLElement)?.focus();
          }}>
          {column !== s.status && <span className="phone-column-dot" />}
          <span>{s.label}</span><span className="mono"><Roll value={s.status === 'archived' ? archived || 0 : counts[s.status] || 0} /></span>
        </button>
        ))}
      </div>
      <button type="button" className="phone-column-add" aria-label="Choose columns" onClick={() => {
        document.querySelector<HTMLButtonElement>('.topbar-actions > .label-filter [data-testid="label-filter"]')?.click();
      }}>+</button>
    </div>
  );
}
