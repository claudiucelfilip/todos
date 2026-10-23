// Repeating reminders. remindAt is the anchor the user set and is never rewritten by the
// schedule; the next time due is the first slot after the last push (remindedAt), so pushes,
// skips and offline edits never compete for the same field. Wall-clock steps in the local
// time zone (the server shares the devices' zone): "daily 9:00" stays 9:00 across DST, and
// a monthly 31st comes back to the 31st. Hourly repeats skip the quiet hours.

export const REMIND_EVERY = ['hour', 'day', 'weekday', 'week', 'month'];
export const QUIET_FROM = 22; // hourly repeats stay silent 22:00–8:00
export const QUIET_TO = 8;

const HOUR = 3600000;
const PERIOD = { hour: HOUR, day: 24 * HOUR, weekday: 24 * HOUR, week: 7 * 24 * HOUR, month: 30 * 24 * HOUR };
/** Inside the quiet hours (local time). */
export const quiet = (ms) => {
  const h = new Date(ms).getHours();
  return h >= QUIET_FROM || h < QUIET_TO;
};
const ms = (iso) => (iso ? Date.parse(iso) : NaN);
/** Never throws: a time outside the Date range (a garbage stamp from sync) is no time at all. */
const isoOf = (d) => (Number.isNaN(d.getTime()) ? null : d.toISOString());

export const repeats = (c) => !!c && REMIND_EVERY.includes(c.remindEvery);

/** The first slot of the schedule anchored at `atIso` that lies strictly after `afterMs` (the anchor itself while it is still ahead); null when not repeating. */
export function nextRemind(atIso, every, afterMs) {
  const at = new Date(atIso);
  const t0 = at.getTime();
  if (Number.isNaN(t0) || !REMIND_EVERY.includes(every)) return null;
  if (Number.isNaN(afterMs)) return null;
  if (t0 > afterMs) return isoOf(at);
  if (every === 'hour') {
    let t = t0 + (Math.floor((afterMs - t0) / HOUR) + 1) * HOUR;
    for (let i = 0; i < 24 && quiet(t); i++) t += HOUR;
    return isoOf(new Date(t));
  }
  // Rebuilt from the anchor's wall time each step, so a DST gap or a short month never shifts later slots.
  const slot = (k) => {
    const [y, m, d, hh, mm, ss, mss] = [at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes(), at.getSeconds(), at.getMilliseconds()];
    if (every === 'month') return new Date(y, m + k, Math.min(d, new Date(y, m + k + 1, 0).getDate()), hh, mm, ss, mss);
    return new Date(y, m, d + k * (every === 'week' ? 7 : 1), hh, mm, ss, mss);
  };
  const days = every === 'month' ? 31 : every === 'week' ? 7 : 1;
  let k = Math.max(1, Math.floor((afterMs - t0) / (days * 24 * HOUR)) - 1);
  for (let i = 0; i < 1000; i++, k++) {
    const d = slot(k);
    if (d.getTime() <= afterMs) continue;
    if (every === 'weekday' && (d.getDay() === 0 || d.getDay() === 6)) continue;
    return isoOf(d);
  }
  return null;
}

/** When the reminder is next due (ISO), or null without one. One-off: remindAt. Repeating: the first slot after the last push. */
export function dueAt(c) {
  if (!c || !c.remindAt) return null;
  if (!repeats(c)) return c.remindAt;
  const last = ms(c.remindedAt);
  return nextRemind(c.remindAt, c.remindEvery, Number.isNaN(last) ? -Infinity : last);
}

// Longest gap between two slots (+ slack): looking back this far from any moment finds one.
const REACH = { hour: 12 * HOUR, day: 26 * HOUR, weekday: 4 * 24 * HOUR, week: 8 * 24 * HOUR, month: 33 * 24 * HOUR };

/** The latest slot at or before `nowMs` (ms), or null when the schedule has not started. After an outage only this one matters. */
export function lastSlot(atIso, every, nowMs) {
  let s = nextRemind(atIso, every, Math.max(nowMs - REACH[every], -8.64e15));
  if (!s || Date.parse(s) > nowMs) return null;
  for (let i = 0; i < 100; i++) {
    const n = nextRemind(atIso, every, Date.parse(s));
    if (!n || Date.parse(n) > nowMs) break;
    s = n;
  }
  return Date.parse(s);
}

/** A reminder rests while its card is parked in Someday; a repeating one also in Done. */
export const remindResting = (c) => !!c.someday || (repeats(c) && c.status === 'done');

/**
 * Back from resting after the time passed: never sent late. The remindedAt to stamp, or
 * undefined when nothing is overdue. A one-off is marked missed (= remindAt); a repeating
 * one is handled through now, so its next slot is the first one ahead.
 */
export function restStamp(c, nowIso) {
  const due = dueAt(c);
  if (!due || Date.parse(due) > Date.parse(nowIso)) return undefined;
  if (repeats(c)) return nowIso;
  return ms(c.remindedAt) >= Date.parse(c.remindAt) ? undefined : c.remindAt;
}

/** Repeat switched off: the upcoming slot stays as a single reminder. */
export function onceAt(c, nowMs) {
  const last = ms(c.remindedAt);
  return nextRemind(c.remindAt, c.remindEvery, Math.max(nowMs, Number.isNaN(last) ? -Infinity : last));
}

/**
 * The remindedAt a Repeat card's fresh copy starts with (it keeps the anchor): handled
 * through now, so the next slot reminds. Only a card finished ahead of its own reminder
 * (no slot came while it was open) and close to it (less than half an interval) skips
 * that slot, so finishing early is not nagged a moment later.
 */
export function copyStamp(c, nowIso) {
  const now = Date.parse(nowIso);
  const up = nextRemind(c.remindAt, c.remindEvery, now);
  if (!up) return null;
  const born = ms(c.createdAt);
  const first = Number.isNaN(born) ? null : nextRemind(c.remindAt, c.remindEvery, born);
  const lived = !!first && Date.parse(first) <= now; // a slot came while it was open: it was that slot's
  return !lived && Date.parse(up) - now < PERIOD[c.remindEvery] / 2 ? up : nowIso;
}
