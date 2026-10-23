// Reminders: quick-chip times, display formats and state. All in the device's local
// time zone; stored as UTC ISO strings on the card (remindAt / remindedAt).

import { dueAt, remindResting, repeats, restStamp, type RemindEvery } from '../../shared/repeat.mjs';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type ChipKey = 'later' | 'evening' | 'tomorrow' | 'monday';

const atHour = (d: Date, h: number, dayOffset = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, h, 0, 0, 0);

/** Quick chips for "now": Later today (+3 h, to the hour; not from 21:00), This evening (18:00; not from 17:00), Tomorrow 9:00, Next Monday 9:00. */
export function reminderChips(now: Date): { key: ChipKey; at: Date }[] {
  const out: { key: ChipKey; at: Date }[] = [];
  if (now.getHours() < 21) {
    const t = new Date(now.getTime() + 3 * 3600000);
    const later = new Date(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours() + (t.getMinutes() >= 30 ? 1 : 0));
    out.push({ key: 'later', at: later });
  }
  if (now.getHours() < 17) out.push({ key: 'evening', at: atHour(now, 18) });
  out.push({ key: 'tomorrow', at: atHour(now, 9, 1) });
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  out.push({ key: 'monday', at: atHour(now, 9, toMonday) });
  return out;
}

const hm = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
const dayDiff = (d: Date, now: Date) => Math.round((atHour(d, 0).getTime() - atHour(now, 0).getTime()) / 86400000);

/** Card face: "9:00" today, "Thu 9:00" within the week, else "24 Sep" (plus the year when it differs). */
export function formatRemindFace(d: Date, now: Date): string {
  const days = dayDiff(d, now);
  if (days === 0) return hm(d);
  if (days > 0 && days < 7) return `${DAYS[d.getDay()]} ${hm(d)}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
}

/** Detail row: "Today, 19:00", "Tomorrow, 9:00", else "Mon 28 Sep, 9:00". */
export function formatRemindRow(d: Date, now: Date): string {
  const days = dayDiff(d, now);
  if (days === 0) return `Today, ${hm(d)}`;
  if (days === 1) return `Tomorrow, ${hm(d)}`;
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''}, ${hm(d)}`;
}

/** "Reminded Tue 9:00". */
export function formatReminded(d: Date): string {
  return `${DAYS[d.getDay()]} ${hm(d)}`;
}

export type RemindState = { kind: 'none' } | { kind: 'pending'; soon: boolean } | { kind: 'paused' } | { kind: 'sent' } | { kind: 'missed' };

/**
 * One-off: sent once the server stamps remindedAt after remindAt; remindedAt === remindAt marks one
 * that passed without a push (missed). A repeating one is never spent: it is pending at its next
 * slot (dueAt). Unsent while resting (Someday; a repeating one also in Done): paused.
 * "soon" = within 24 h (or overdue).
 */
export function remindState(c: { remindAt?: string | null; remindedAt?: string | null; someday?: boolean; remindEvery?: RemindEvery | null; status?: string }, now: Date): RemindState {
  const due = dueAt(c);
  if (!c.remindAt || !due) return { kind: 'none' };
  if (!repeats(c)) {
    const at = new Date(c.remindAt).getTime();
    const stamped = c.remindedAt ? new Date(c.remindedAt).getTime() : -Infinity;
    if (stamped === at) return { kind: 'missed' };
    if (stamped > at) return { kind: 'sent' };
  }
  if (remindResting(c)) return { kind: 'paused' };
  return { kind: 'pending', soon: new Date(due).getTime() - now.getTime() <= 86400000 };
}

/** Back from resting after the time passed: never sent late. A one-off is stamped missed (remindedAt = remindAt); a repeating one waits for its next slot. */
export function missedOnLeave<T extends { remindAt?: string | null; remindedAt?: string | null; remindEvery?: RemindEvery | null }>(card: T, nowIso: string): T {
  const stamp = restStamp(card, nowIso);
  return stamp === undefined ? card : { ...card, remindedAt: stamp };
}

/** Card face suffix for a repeating reminder. */
export const EVERY_SHORT: Record<RemindEvery, string> = { hour: 'hourly', day: 'daily', weekday: 'weekdays', week: 'weekly', month: 'monthly' };

/** <input type=datetime-local> value (local) ⇄ Date. */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
