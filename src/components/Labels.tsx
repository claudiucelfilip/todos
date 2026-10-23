import LabelSettings from './LabelSettings';
import { CloseIcon } from './Icons';
import { rulesOf } from '../../shared/automations.mjs';
import { isWorkflowLabel, isFlowStage, flowGroup, stagesOf, finishedStage } from '../../shared/workflow.mjs';
// Labels UI: pills (card face + detail), the color choice (palette + custom),
// the detail's label picker popover and the top bar label filter.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../hooks/useStore';
import { useDropdownPresence } from '../hooks/useDropdownPresence';
import type { Label } from '../lib/types';
import {
  INBOX_FILTER,
  NOTES_NONE_FILTER,
  LABEL_PALETTE,
  pillVars,
  rovingIndex,
  swatchTabIndex,
} from '../lib/labels';
import { labelCopy } from '../lib/copy';
import { NO_AUTOFILL } from '../lib/keys';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

const pillStyle = (color: string) => pillVars(color) as React.CSSProperties;

/** A label as a pill filled with its own colour (owner ruling, 7 Oct). */
export function LabelPill({ label, onRemove }: { label: Label; onRemove?: () => void }) {
  return (
    <span className={`label-pill${isWorkflowLabel(label.id) ? ' workflow-pill' : ''}`} style={pillStyle(label.color)} title={label.name}>
      <span className="label-pill-name">{label.name}</span>
      {onRemove && (
        <button
          type="button"
          className="label-pill-x"
          aria-label={labelCopy.remove(label.name)}
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </span>
  );
}

/** A suggested label: a dashed outline in the label's colour with `Name?`; tapping adds it. */
export function SuggestedPill({ label, className, onAccept }: { label: Label; className?: string; onAccept(): void }) {
  return (
    <button
      type="button"
      className={cx('label-pill', 'suggested', className)}
      style={pillStyle(label.color)}
      aria-label={`Add label ${label.name}, suggested`}
      onClick={(e) => {
        e.stopPropagation();
        onAccept();
      }}
    >
      <span className="label-pill-name">{label.name}?</span>
    </button>
  );
}

/** Ten presets plus a native custom color input; a roving-tabindex radio group. */
export function ColorChoice({
  value,
  onChange,
  name,
}: {
  value: string;
  onChange(c: string): void;
  name: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const active = swatchTabIndex(value);
  const custom = active === LABEL_PALETTE.length;
  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-swatch]') ?? []);
    const cur = items.indexOf(document.activeElement as HTMLElement);
    const next = rovingIndex(cur < 0 ? active : cur, e.key, items.length);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    items[next]?.focus();
    if (next < LABEL_PALETTE.length) onChange(LABEL_PALETTE[next]);
  };
  return (
    <div
      ref={ref}
      className="color-choice"
      role="radiogroup"
      aria-label={labelCopy.color(name)}
      onKeyDown={onKeyDown}
    >
      {LABEL_PALETTE.map((c, i) => (
        <button
          key={c}
          type="button"
          role="radio"
          data-swatch
          aria-checked={i === active}
          aria-label={c}
          tabIndex={i === active ? 0 : -1}
          className={cx('swatch', i === active && 'on')}
          style={{ ['--label' as string]: c }}
          onClick={() => onChange(c)}
        />
      ))}
      <label
        className={cx('swatch', 'swatch-custom', custom && 'on')}
        style={{ ['--label' as string]: value }}
        title={labelCopy.custom}
      >
        <CustomColor value={value} onChange={onChange} tabbable={custom} />
      </label>
    </div>
  );
}

/** Commits on the native `change` (picker closed), not on every drag step (React's onChange). */
function CustomColor({
  value,
  onChange,
  tabbable,
}: {
  value: string;
  onChange(c: string): void;
  tabbable: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    const el = ref.current;
    const fn = () => el && cb.current(el.value.toUpperCase());
    el?.addEventListener('change', fn);
    return () => el?.removeEventListener('change', fn);
  }, []);
  useEffect(() => {
    if (ref.current && ref.current.value.toLowerCase() !== value.toLowerCase())
      ref.current.value = value;
  }, [value]);
  return (
    <input
      ref={ref}
      type="color"
      data-swatch
      defaultValue={value}
      tabIndex={tabbable ? 0 : -1}
      aria-label={labelCopy.custom}
    />
  );
}

/** Close on outside pointerdown; Esc closes and returns focus to the trigger. */
export function usePopover(
  ref: React.RefObject<HTMLElement>,
  trigger: React.RefObject<HTMLElement>,
  onClose: () => void,
): (e: React.KeyboardEvent) => void {
  useEffect(() => {
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || trigger.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onDoc, true);
    return () => document.removeEventListener('pointerdown', onDoc, true);
  }, [ref, trigger, onClose]);
  return (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
    trigger.current?.focus();
  };
}

interface PickerProps {
  closing?: boolean;
  labels: Label[];
  selected: string[];
  onToggle(id: string): void;
  onCreate(name: string, color: string): void;
  onClose(): void;
  trigger: React.RefObject<HTMLElement>;
}

/** Detail panel popover: toggle existing labels; type a name + Enter to create and apply. */
export function LabelPicker({
  closing,
  labels,
  selected,
  onToggle,
  onCreate,
  onClose,
  trigger,
}: PickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = usePopover(ref, trigger, onClose);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [color, setColor] = useState(() => {
    const used = new Set(labels.map((l) => l.color.toUpperCase()));
    return LABEL_PALETTE.find((c) => !used.has(c)) ?? LABEL_PALETTE[0];
  });
  const hintId = useId();
  const workflowName = useId();
  const [pos, setPos] = useState<React.CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const menu = ref.current;
      if (!anchor || !menu) return;
      const viewport = window.visualViewport;
      const leftEdge = Math.ceil(viewport?.offsetLeft ?? 0) + 12;
      const topEdge = Math.ceil(viewport?.offsetTop ?? 0) + 12;
      const rightEdge = leftEdge + Math.floor(viewport?.width ?? window.innerWidth) - 24;
      const bottomEdge = topEdge + Math.floor(viewport?.height ?? window.innerHeight) - 24;
      if (window.matchMedia('(max-width: 899px)').matches) {
        setPos({ left: leftEdge, top: topEdge, width: rightEdge - leftEdge, height: Math.min(560, bottomEdge - topEdge), maxHeight: bottomEdge - topEdge });
        return;
      }
      const width = Math.min(280, rightEdge - leftEdge);
      const height = Math.min(menu.scrollHeight, bottomEdge - topEdge, 420);
      const top = Math.max(topEdge, Math.min(Math.round(anchor.bottom + 8), bottomEdge - height));
      setPos({ left: Math.max(leftEdge, Math.min(Math.round(anchor.left), rightEdge - width)), top, width, maxHeight: bottomEdge - top });
    };
    place();
    const resize = new ResizeObserver(place);
    if (ref.current) resize.observe(ref.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      resize.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [trigger, creating, labels.length]);
  const placed = pos.visibility !== 'hidden';
  useEffect(() => {
    if (!placed) return;
    const root = ref.current;
    (root?.querySelector<HTMLElement>('input:checked') ?? root?.querySelector<HTMLElement>('input, button'))?.focus({ preventScroll: true });
  }, [placed]);

  return createPortal(
    <div
      ref={ref}
      className={cx('label-pop label-picker', creating && 'creating')}
      data-closing={closing || undefined} aria-hidden={closing || undefined}
      data-theme="tint-dark" data-panel="ink"
      style={pos}
      role="dialog"
      aria-label={labelCopy.addLabel}
      onKeyDown={(e) => {
        onKeyDown(e);
        if (e.key !== 'Tab') return;
        e.stopPropagation();
        const radio = ref.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked') ?? ref.current?.querySelector<HTMLInputElement>('input[type="radio"]');
        const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('input:not([type="radio"]):not([tabindex="-1"]), input[type="radio"], button:not(:disabled):not([tabindex="-1"])') ?? []).filter(node => node.getClientRects().length > 0 && (!(node instanceof HTMLInputElement) || node.type !== 'radio' || node === radio));
        const last = nodes[nodes.length - 1];
        const next = e.shiftKey ? last : nodes[0];
        if (document.activeElement === (e.shiftKey ? nodes[0] : last)) {
          e.preventDefault();
          next?.focus();
        }
      }}
    >
      <div className="label-picker-head">
        {creating && <button type="button" className="label-picker-back" onClick={() => setCreating(false)}>Back</button>}
        <strong>{creating ? 'New label' : 'Labels'}</strong>
        <button type="button" className="label-picker-close" aria-label="Close labels" onClick={() => { onClose(); trigger.current?.focus(); }}><CloseIcon /></button>
      </div>
      <div className="label-picker-body">
      <p className="mono label-pop-heading">Workflow</p>
      <ul className="label-pop-list">
        <li><label className="label-check"><input type="radio" name={workflowName} checked={!labels.some(l => selected.includes(l.id) && isFlowStage(l))} onChange={() => selected.filter(id => labels.some(l => l.id === id && isFlowStage(l))).forEach(onToggle)} /><span>None</span></label></li>
        {[...new Set(labels.filter(isFlowStage).map(flowGroup))].map(group => <li key={group}><p className="mono label-pop-heading">{group === 'Workflow' ? 'Todos' : group}</p><ul className="label-pop-list">{stagesOf(group, labels).map(l => <li key={l.id}><label className="label-check"><input type="radio" name={workflowName} checked={selected.includes(l.id)} onChange={() => !selected.includes(l.id) && onToggle(l.id)} /><LabelPill label={l} /></label></li>)}</ul></li>)}
      </ul>
      <p className="mono label-pop-heading">Labels</p>
      {labels.some((l) => !isFlowStage(l)) ? (
        <ul className="label-pop-list">
          {labels.filter((l) => !isFlowStage(l)).map((l) => (
            <li key={l.id}>
              <label className="label-check">
                <input
                  type="checkbox"
                  checked={selected.includes(l.id)}
                  onChange={() => onToggle(l.id)}
                />
                <span className="label-check-name">
                  <span className="label-pill" style={pillStyle(l.color)}>
                    <span className="label-pill-name">{l.name}</span>
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="label-pop-empty mono">{labelCopy.noLabels}</p>
      )}
      </div>
      <button
        type="button"
        className="new-label-row"
        onClick={() => setCreating((v) => !v)}
        aria-expanded={creating}
      >
        New label…
      </button>
      {creating && (
        <form
          className="label-new"
          onSubmit={(e) => {
            // A form, so Enter, the phone's Done key and the Add button all create the label.
            e.preventDefault();
            if (name.trim()) {
              onCreate(name, color);
              setName('');
              setCreating(false);
            }
          }}
        >
          <div className="label-new-options">
          <input
            autoFocus
            className="label-new-name"
            {...NO_AUTOFILL}
            value={name}
            maxLength={40}
            placeholder={labelCopy.newLabel}
            aria-label={labelCopy.newLabel}
            aria-describedby={hintId}
            enterKeyHint="done"
            onChange={(e) => setName(e.target.value)}
          />
          <span id={hintId} className="sr-only">
            {labelCopy.newLabelHint}
          </span>
          <ColorChoice value={color} onChange={setColor} name={name.trim() || labelCopy.newLabel} />
          </div>
          <button
            type="submit"
            className="btn btn-accent label-new-add"
            disabled={!name.trim()}
            data-testid="label-new-add"
          >
            {labelCopy.add}
          </button>
        </form>
      )}
    </div>,
    document.querySelector('.app') ?? document.body,
  );
}

interface FilterProps {
  columnMode?: boolean;
  labels: Label[];
  active: string[];
  onChange(ids: string[]): void;
  phone: boolean;
  onOpenSettings?(): void;
}

/** Top bar: "Labels" (· n when filtering) opening the Labels menu (§11.11). */
export function LabelFilter({ labels, active, onChange, phone, onOpenSettings, columnMode }: FilterProps) {
  const [open, setOpen] = useState(false);
  const presence = useDropdownPresence(open);
  const btn = useRef<HTMLButtonElement>(null);
  const close = useRef(() => setOpen(false)).current;
  return (
    <div className="label-filter">
      <button
        ref={btn}
        type="button"
        className={cx(phone ? 'iconbtn' : 'label-filter-btn', active.length > 0 && 'active')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={labelCopy.filterAria(active.length)}
        data-testid="label-filter"
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
          <path d="M3 5h18l-7 8v6l-4 2v-8z" />
        </svg>
        {!phone && <span>{active.length ? `${labelCopy.filter} · ${active.length}` : labelCopy.filter}</span>}
        {phone && active.length > 0 && <span className="mono label-filter-count">{active.length}</span>}
      </button>
      {presence.mounted &&
        createPortal(
          <LabelsMenu phone={phone} closing={presence.closing} columnMode={columnMode} trigger={btn} labels={labels} active={!columnMode && !active.length ? [...labels.filter(l => !finishedStage(l)).map(l => l.id), INBOX_FILTER] : active} onChange={ids => onChange(!columnMode && !ids.length ? [NOTES_NONE_FILTER] : ids)} onClose={close} onOpenSettings={onOpenSettings} />,
          document.querySelector('.app') ?? document.body,
        )}
    </div>
  );
}

/** Find, filter, create and manage labels. Portalled out of the glass bar so its own blur works (§11.12). */
function LabelsMenu({
  phone,
  closing,
  trigger,
  labels,
  active,
  onChange,
  onClose,
  onOpenSettings,
}: FilterProps & { trigger: React.RefObject<HTMLButtonElement>; onClose(): void; closing?: boolean }) {
  const { cards, createLabel, showToast, readOnly } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = usePopover(ref, trigger, onClose);
  const [q, setQ] = useState('');
  const [color, setColor] = useState(() => {
    const used = new Set(labels.map((l) => l.color.toUpperCase()));
    return LABEL_PALETTE.find((c) => !used.has(c)) ?? LABEL_PALETTE[0];
  });
  const [editing, setEditing] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [fresh, setFresh] = useState<string | null>(null); // the label just created, highlighted
  useLayoutEffect(() => {
    const r = trigger.current?.getBoundingClientRect();
    const w = Math.min(410, window.innerWidth - 24);
    // Under the trigger, its right edge on the assistant button's (as drawn); kept on screen.
    // A hidden trigger (phone menu) falls back to under the bar.
    if (r && r.width) setPos({ top: r.bottom + 14, right: Math.min(Math.max(12, window.innerWidth - r.right - 56), window.innerWidth - w - 12) });
    else setPos({ top: 72, right: 12 });
  }, [trigger]);
  useEffect(() => {
    if (pos) ref.current?.querySelector<HTMLElement>('.labels-find input')?.focus(); // hidden until placed
  }, [pos]);

  const live = cards.filter((c) => !c.archivedAt && !c.draft);
  const countOf = (id: string) => live.filter((c) => c.labels?.includes(id)).length;
  const inboxCount = live.filter((c) => c.kind === 'note' && !(c.labels ?? []).length).length;
  const fold = (t: string) => t.toLocaleLowerCase().trim();
  const shown = labels.filter((l) => fold(l.name).includes(fold(q)));
  const exact = labels.some((l) => fold(l.name) === fold(q));
  const toggle = (id: string) => onChange(active.includes(id) ? active.filter((x) => x !== id && x !== NOTES_NONE_FILTER) : [...active.filter(x => x !== NOTES_NONE_FILTER), id]);
  // §11.24.2: creating never turns the filter on; the new row is highlighted and the menu stays.
  const create = () => {
    const l = createLabel(q, color);
    setQ('');
    if (!l) return;
    setFresh(l.id);
    setEditing(l.id);
    showToast(labelCopy.created(l.name));
    const next = LABEL_PALETTE.find((c) => c !== l.color.toUpperCase() && !labels.some((x) => x.color.toUpperCase() === c));
    if (next) setColor(next);
    requestAnimationFrame(() => ref.current?.querySelector(`[data-testid="labels-row-${l.id}"]`)?.scrollIntoView({ block: 'nearest' }));
  };

  const row = (id: string, name: string, dot: string | null, count: number, on: boolean, editable: boolean, onToggle: () => void, label?: Label) => (
    <li key={id} className={cx('labels-row', on && 'on', fresh === id && 'fresh')}>
      <button type="button" role="menuitemcheckbox" aria-checked={on} className="labels-row-main" onClick={onToggle} data-testid={`labels-row-${id}`}>
        <span className="labels-box" aria-hidden>
          {on && (
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12 5 5 9-10" />
            </svg>
          )}
        </span>
        <span className="labels-name">
          {dot ? (
            <span className="label-pill" style={pillStyle(dot)}>
              <span className="label-pill-name">{name}</span>
            </span>
          ) : (
            name
          )}
          {label && rulesOf(label).length > 0 && <span className="labels-rule-count">{rulesOf(label).length} {rulesOf(label).length === 1 ? 'rule' : 'rules'}</span>}
        </span>
        <span className="labels-count mono">{count}</span>
      </button>
      {editable && label && (
        <button
          type="button"
          className="labels-more"
          aria-label={`Edit ${name}`}
          aria-expanded={editing === id}
          onClick={() => setEditing(id)}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
            <circle cx="5" cy="12" r="1.6" fill="currentColor" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" />
            <circle cx="19" cy="12" r="1.6" fill="currentColor" />
          </svg>
        </button>
      )}
    </li>
  );

  return (
    <>
    {phone && <div className="labels-scrim" onPointerDown={onClose} data-closing={closing || undefined} />}
    <div
      ref={ref}
      className={cx("label-pop label-filter-pop labels-menu float", editing !== null && "labels-managing")}
      data-closing={closing || undefined} aria-hidden={closing || undefined}
      data-theme="tint-dark" data-panel="ink"
      role="dialog"
      aria-label={editing ? 'Edit label' : labelCopy.filter}
      onKeyDown={onKeyDown}
      style={pos ? { top: pos.top, right: pos.right, maxHeight: phone ? undefined : `calc(100dvh - ${Math.round(pos.top + 16)}px)` } : { visibility: 'hidden' }}
    >
      <div className="automation-panel-head">{editing && <button type="button" className="automation-back" aria-label="Back to labels" onClick={() => { setEditing(null); requestAnimationFrame(() => ref.current?.querySelector<HTMLInputElement>('.labels-find input')?.focus()); }}>‹</button>}<h2>{editing ? 'Edit label' : 'Labels'}</h2><button type="button" aria-label="Close labels" onClick={onClose}>×</button></div>
      {editing && labels.some(l => l.id === editing) ? <LabelSettings key={editing} label={labels.find(l => l.id === editing)!} onBack={() => setEditing(null)} /> : <>
      <div className="labels-find">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          value={q}
          placeholder="Find or add a label"
          aria-label="Find or add a label"
          {...NO_AUTOFILL}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation(); // never reaches the board or the panel
              if (q.trim() && !exact) create();
            }
            if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && q.trim() && !exact && !shown.length) {
              e.preventDefault();
              const i = Math.max(0, LABEL_PALETTE.indexOf(color));
              setColor(LABEL_PALETTE[(i + (e.key === 'ArrowRight' ? 1 : LABEL_PALETTE.length - 1)) % LABEL_PALETTE.length]);
            }
          }}
        />
      </div>
      <ul className="labels-list" role="menu">
        {!q && row('all', 'All', null, live.length, labels.every((l) => active.includes(l.id)) && active.includes(INBOX_FILTER), false, () => onChange(!(labels.every((l) => active.includes(l.id)) && active.includes(INBOX_FILTER)) ? [...labels.map((l) => l.id), INBOX_FILTER] : []))}
        {!q && row(INBOX_FILTER, 'Inbox', null, inboxCount, active.includes(INBOX_FILTER), false, () => toggle(INBOX_FILTER))}
        {shown.map((l) => row(l.id, l.name, l.color, countOf(l.id), active.includes(l.id), true, () => toggle(l.id), l))}
      </ul>
      {!readOnly && q.trim() && !exact && (
        <div className="labels-create">
          <button type="button" className="labels-row-main" onClick={create} data-testid="labels-create">
            <span className="labels-plus" aria-hidden>+</span>
            <span className="labels-name">
              Create{' '}
              <span className="label-pill" style={pillStyle(color)}>
                <span className="label-pill-name">{q.trim()}</span>
              </span>
            </span>
            <kbd className="labels-enter mono" aria-hidden>↵</kbd>
          </button>
          <ColorChoice value={color} onChange={setColor} name={q.trim()} />
        </div>
      )}
      {onOpenSettings && (
        <button
          type="button"
          className="labels-foot"
          onClick={() => {
            onClose();
            onOpenSettings();
          }}
        >
          Manage labels in Settings
        </button>
      )}
      </>}
    </div>
    </>
  );
}

/** §11.24.2: a filter that hides every card says so, with a way out. */
export function FilterEmpty({ filter, labels, onClear }: { filter: string[]; labels: Label[]; onClear(): void }) {
  const name = labels.find((l) => l.id === filter[0])?.name;
  const text =
    filter[0] === NOTES_NONE_FILTER ? 'No labels selected' : filter.length > 1 ? 'No cards match these labels' : filter[0] === INBOX_FILTER ? 'Inbox is empty' : `No cards labelled ${name ?? 'this label'}`;
  return (
    <div className="filter-empty" data-testid="filter-empty">
      <p className="filter-empty-title">{text}</p>
      <button type="button" className="filter-empty-clear" onClick={onClear}>
        Clear filter
      </button>
    </div>
  );
}
