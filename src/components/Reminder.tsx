// Reminders UI: the detail's "Remind me" row + quick-chip popover, and the card-face badge.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { menuPosition } from '../lib/menu-position';
import type { Card, RemindEvery } from '../lib/types';
import {
  EVERY_SHORT,
  formatRemindFace,
  formatReminded,
  reminderChips,
  remindState,
  toLocalInput,
  type ChipKey,
} from '../lib/remind';
import { dueAt } from '../../shared/repeat.mjs';
import { remindCopy } from '../lib/copy';
import { usePopover } from './Labels';
import { useDropdownPresence } from '../hooks/useDropdownPresence';

/** `off` adds a slash: a reminder paused while its card is in Someday. */
export function BellIcon({ size = 16, off = false }: { size?: number; off?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}

export const CHIP_LABEL: Record<ChipKey, string> = {
  later: remindCopy.later,
  evening: remindCopy.evening,
  tomorrow: remindCopy.tomorrow,
  monday: remindCopy.monday,
};
const hm = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

/** Card face: a bell and a compact time while a reminder is pending; muted with a slash while paused. */
export function ReminderBadge({ card }: { card: Card }) {
  const now = new Date();
  const st = remindState(card, now);
  const due = dueAt(card);
  if ((st.kind !== 'pending' && st.kind !== 'paused') || !due) return null;
  if (card.status === 'done' && card.remindEvery) return null; // stopped: nothing to announce on a done card
  const when =
    formatRemindFace(new Date(due), now) +
    (card.remindEvery ? ` · ${EVERY_SHORT[card.remindEvery]}` : '') +
    (st.kind === 'paused' ? ' · paused' : card.notify === false ? ' · silent' : '');
  const aria = st.kind === 'paused' ? remindCopy.pausedAria(when) : remindCopy.faceAria(when);
  return (
    <span
      className={`card-remind mono${st.kind === 'pending' && st.soon ? ' soon' : ''}${st.kind === 'paused' ? ' paused' : ''}`}
      aria-label={aria}
      title={aria}
      data-remind={st.kind}
    >
      <BellIcon size={12} off={st.kind === 'paused' || card.notify === false} />
      {when}
    </span>
  );
}

/** Detail row: "Remind me", or the time with a repeat picker and × to clear; sent reminders read muted. */
export function ReminderRow({
  card,
  onSet,
  onEvery,
  onNotify,
  openOverride,
  onOpenChange,
}: {
  openOverride?: boolean;
  onOpenChange?(v: boolean): void;
  card: Card;
  onSet(iso: string | null): void;
  onEvery(every: RemindEvery | null): void;
  onNotify(notify: boolean): void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = openOverride ?? localOpen;
  const presence = useDropdownPresence(open);
  const setOpen = (v: boolean | ((old: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(open) : v;
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  const btn = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  const now = new Date();
  const st = remindState(card, now);
  const due = dueAt(card); // a repeating reminder shows its next slot
  const at = due ? new Date(due) : null;
  const text =
    st.kind === 'none' || !at
      ? 'Remind'
      : st.kind === 'sent'
        ? remindCopy.reminded(formatReminded(at))
        : st.kind === 'missed'
          ? remindCopy.missed(formatReminded(at))
          : st.kind === 'paused'
            ? remindCopy.paused(`${at.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm(at)}`)
            : `${at.toLocaleDateString('en-GB', { weekday: 'short' })} ${hm(at)}`;
  const muted = st.kind === 'sent' || st.kind === 'missed' || st.kind === 'paused';
  return (
    <section className="dt-remind" aria-label={remindCopy.remindMe}>
      <div className="dt-remind-anchor">
        <button
          ref={btn}
          type="button"
          className={`dt-remind-btn${muted ? ' sent' : ''}${st.kind === 'pending' ? ' set' : ''}`}
          data-remind={st.kind}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid="detail-remind"
          onClick={() => setOpen((v) => !v)}
        >
          {!card.remindAt && <BellIcon />}
          <span>
            {text}
            {st.kind !== 'none' &&
              ` · ${card.remindEvery ? EVERY_SHORT[card.remindEvery] : 'once'}`}
          </span>
        </button>
        {st.kind !== 'none' && (
          <span className="dt-remind-tail">
            <button
              type="button"
              className={`dt-remind-notify${card.notify === false ? ' off' : ' on'}`}
              aria-label={card.notify === false ? 'Turn on notifications for this reminder' : 'Turn off notifications for this reminder'}
              aria-pressed={card.notify !== false}
              title={card.notify === false ? 'Notifications off · turn on' : 'Notifications on · turn off'}
              onClick={() => onNotify(card.notify === false)}
            ><BellIcon size={17} off={card.notify === false} /></button>
            <button
              type="button"
              className="dt-remind-x"
              aria-label={remindCopy.clear}
              data-testid="detail-remind-clear"
              onClick={() => onSet(null)}
            >
              ×
            </button>
          </span>
        )}
        {presence.mounted && (
          <RemindPicker
            closing={presence.closing}
            every={card.remindEvery ?? null}
            onEvery={onEvery}
            trigger={btn}
            onClose={close}
            current={at}
            onPick={(d) => {
              onSet(d.toISOString());
              setOpen(false);
            }}
          />
        )}
      </div>
      {card.remindEvery && st.kind !== 'none' && (
        <p className="mono dt-remind-hint" data-testid="detail-remind-hint">
          {card.remindEvery === 'hour' ? remindCopy.quiet : remindCopy.untilDone}
        </p>
      )}
    </section>
  );
}

function RemindPicker({
  closing,
  trigger,
  onClose,
  onPick,
  current,
  every,
  onEvery,
}: {
  closing?: boolean;
  every: RemindEvery | null;
  onEvery(v: RemindEvery | null): void;
  trigger: React.RefObject<HTMLElement>;
  onClose(): void;
  onPick(d: Date): void;
  current: Date | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = usePopover(ref, trigger, onClose);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    const update = () => {
      if (!ref.current || !trigger.current) return;
      setPosition({ ...menuPosition(trigger.current.getBoundingClientRect(), { width: ref.current.offsetWidth, height: ref.current.offsetHeight }), position: 'fixed', zIndex: 180 });
    };
    update();
    const observer = new ResizeObserver(update);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, [trigger]);
  const [custom, setCustom] = useState(false);
  const [value, setValue] = useState(() =>
    toLocalInput(
      current && current > new Date()
        ? current
        : reminderChips(new Date()).find((c) => c.key === 'tomorrow')!.at,
    ),
  );
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button, input')?.focus();
  }, []);
  const chips = reminderChips(new Date());
  const pickCustom = () => {
    const d = new Date(value); // datetime-local is read as local time
    if (!Number.isNaN(d.getTime())) onPick(d);
  };
  return createPortal(
    <div
      ref={ref}
      style={position}
      className="label-pop remind-pop"
      data-closing={closing || undefined} aria-hidden={closing || undefined}
      role="menu"
      aria-label={remindCopy.remindMe}
      onKeyDown={onKeyDown}
    >
      <ul className="remind-chips">
        {chips.map((c) => (
          <li key={c.key}>
            <button
              type="button"
              className="remind-chip"
              data-testid={`remind-${c.key}`}
              onClick={() => onPick(c.at)}
            >
              <span>{CHIP_LABEL[c.key]}</span>
              {true && <span className="mono remind-chip-time">{hm(c.at)}</span>}
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            className="remind-chip"
            aria-expanded={custom}
            data-testid="remind-pick"
            onClick={() => setCustom((v) => !v)}
          >
            <span>{remindCopy.pick}</span>
          </button>
        </li>
      </ul>
      <div className="remind-repeat">
        <span className="mono">Repeat</span>
        <div
          className="remind-repeat-options"
          data-testid="detail-remind-every"
          role="radiogroup"
          aria-label="Repeat reminder"
        >
          {(
            [
              { key: null, name: 'Once' },
              { key: 'day', name: 'Daily' },
              { key: 'weekday', name: 'Weekdays' },
              { key: 'week', name: 'Weekly' },
              { key: 'month', name: 'Monthly' },
              { key: 'hour', name: 'Hourly' },
            ] as { key: RemindEvery | null; name: string }[]
          ).map((o) => (
            <button
              type="button"
              key={o.name}
              role="radio"
              aria-checked={every === o.key}
              tabIndex={every === o.key ? 0 : -1}
              onKeyDown={(e) => {
                const buttons = Array.from(
                  e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button') ??
                    [],
                );
                const i = buttons.indexOf(e.currentTarget);
                const next =
                  e.key === 'ArrowRight'
                    ? (i + 1) % buttons.length
                    : e.key === 'ArrowLeft'
                      ? (i + buttons.length - 1) % buttons.length
                      : -1;
                if (next >= 0) {
                  e.preventDefault();
                  buttons[next].focus();
                  buttons[next].click();
                }
              }}
              className={every === o.key ? 'active' : ''}
              onClick={() => onEvery(o.key)}
            >
              {o.name}
            </button>
          ))}
        </div>
      </div>
      {custom && (
        <div className="remind-custom">
          <input
            className="remind-input"
            type="datetime-local"
            value={value}
            aria-label={remindCopy.pick}
            data-testid="remind-input"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                pickCustom();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-accent remind-set"
            onClick={pickCustom}
            data-testid="remind-set"
          >
            {remindCopy.set}
          </button>
        </div>
      )}
    </div>,
    document.querySelector('.app') ?? document.body,
  );
}
