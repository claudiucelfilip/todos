// What a view-only link shows instead of the editing controls: the top bar's "View only" pill,
// a checklist row and a reminder as plain text, and the "no longer shared" page.
import { useCallback, useRef, useState } from 'react';
import type { Card, CardItem } from '../lib/types';
import { formatRemindRow, formatReminded, remindState } from '../lib/remind';
import { dueAt } from '../../shared/repeat.mjs';
import { remindCopy, shareCopy } from '../lib/copy';
import { linkify, plainText } from '../lib/linkify';
import { sync } from '../lib/sync-boot';
import { BellIcon } from './Reminder';
import { usePopover } from './Labels';
import { useDropdownPresence } from '../hooks/useDropdownPresence';

/** Quiet top-bar pill; it opens one line and the owner's way in. */
export function ViewOnlyPill() {
  const [open, setOpen] = useState(false);
  const presence = useDropdownPresence(open);
  const btn = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <span className="ro-pill-anchor">
      <button ref={btn} type="button" className="ro-pill mono" aria-haspopup="dialog" aria-expanded={open} data-testid="view-only" onClick={() => setOpen((v) => !v)}>
        {shareCopy.pill}
      </button>
      {presence.mounted && <PillPop trigger={btn} closing={presence.closing} onClose={close} />}
    </span>
  );
}

function PillPop({ trigger, closing, onClose }: { trigger: React.RefObject<HTMLElement>; closing?: boolean; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = usePopover(ref, trigger, onClose);
  return (
    <div ref={ref} className="label-pop ro-pop" role="dialog" aria-label={shareCopy.pill} onKeyDown={onKeyDown} data-closing={closing || undefined} aria-hidden={closing || undefined}>
      <p className="ro-pop-text">{shareCopy.pillHint}</p>
      <button type="button" className="btn ro-pop-signin" data-testid="view-only-signin" onClick={() => sync.showLogin()}>
        {shareCopy.signIn}
      </button>
    </div>
  );
}

/** A checklist row to read: the box shows its state, links open, nothing toggles, edits or moves. */
export function ChecklistRowView({ item }: { item: CardItem }) {
  return (
    <div className="dt-row-wrap" data-item-id={item.id} data-done={String(item.done)}>
      <div className={`dt-row ro-row${item.done ? ' checked' : ''}`} role="checkbox" aria-checked={item.done} aria-readonly="true" aria-label={plainText(item.text)} data-testid={`item-${item.id}`}>
        <span className="dt-box" aria-hidden>
          <svg viewBox="0 0 16 16" width="16" height="16">
            <path className="dt-box-check" d="M3.5 8.5l3 3 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="dt-row-text">{linkify(item.text)}</span>
      </div>
    </div>
  );
}

/** The card's reminder as text (nothing when it has none). */
export function ReminderText({ card }: { card: Card }) {
  const now = new Date();
  const st = remindState(card, now);
  const due = dueAt(card); // a repeating reminder shows its next slot
  if (st.kind === 'none' || !due) return null;
  const at = new Date(due);
  const when =
    st.kind === 'sent' ? remindCopy.reminded(formatReminded(at))
    : st.kind === 'missed' ? remindCopy.missed(formatReminded(at))
    : st.kind === 'paused' ? remindCopy.paused(formatRemindRow(at, now))
    : formatRemindRow(at, now);
  const text = card.remindEvery ? `${when} · ${remindCopy.every[card.remindEvery]}` : when;
  return (
    <p className={`ro-remind${st.kind === 'pending' ? ' set' : ''}`} data-testid="detail-remind-text">
      <BellIcon size={14} off={st.kind === 'paused'} />
      <span>{text}</span>
    </p>
  );
}

/** The view link stopped working: the board is gone from this device; the owner can sign in. */
export function UnsharedScreen() {
  return (
    <div className="login-screen" role="dialog" aria-modal="true" aria-labelledby="unshared-title" data-testid="unshared">
      <div className="login-card ro-gone">
        <h1 id="unshared-title" className="login-title">{shareCopy.goneTitle}</h1>
        <p className="ro-gone-body">{shareCopy.goneBody}</p>
        <button type="button" className="btn ro-gone-signin" data-testid="unshared-signin" onClick={() => sync.showLogin()}>
          {shareCopy.signIn}
        </button>
      </div>
    </div>
  );
}
