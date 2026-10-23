// Spoken reminder times inside a dictated todo: "water the plants tomorrow at 9am" →
// title "water the plants" plus the moment. English with the usual Romanian words.
// Pure: `now` and the zone come in, so it is testable at any time of day.
const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, duminică: 0, duminica: 0, luni: 1, marți: 2, marti: 2, miercuri: 3, joi: 4, vineri: 5, sâmbătă: 6, sambata: 6 };
const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11, jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11, ianuarie: 0, februarie: 1, martie: 2, aprilie: 3, mai: 4, iunie: 5, iulie: 6, septembrie: 8, octombrie: 9, noiembrie: 10, decembrie: 11 };
const SMALL = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, o: 1, un: 1, două: 2, doua: 2, trei: 3, patru: 4, cinci: 5, șase: 6, sase: 6, șapte: 7, sapte: 7, opt: 8, nouă: 9, noua: 9, zece: 10 };
const UNITS = { minute: 'minute', minutes: 'minute', min: 'minute', mins: 'minute', minut: 'minute', hour: 'hour', hours: 'hour', hr: 'hour', hrs: 'hour', oră: 'hour', ora: 'hour', ore: 'hour', day: 'day', days: 'day', zi: 'day', zile: 'day', week: 'week', weeks: 'week', săptămână: 'week', saptamana: 'week', săptămâni: 'week', saptamani: 'week', month: 'month', months: 'month', lună: 'month', luna: 'month', luni: 'month' };
const PERIODS = { morning: 9, dimineața: 9, dimineata: 9, dimineață: 9, noon: 12, midday: 12, prânz: 12, pranz: 12, afternoon: 15, 'după-amiaza': 15, 'dupa-amiaza': 15, 'după-amiază': 15, 'dupa-amiaza': 15, evening: 19, seara: 19, seară: 19, night: 21, noaptea: 21, midnight: 24, miezul: 24 };
const DEFAULT_HOUR = 9;
// \b in a JS regex ignores letters like "ă"; this boundary works for any letter.
const B = '(?:(?<![\\p{L}\\d])(?=[\\p{L}\\d])|(?<=[\\p{L}\\d])(?![\\p{L}\\d]))';
const re = (src, flags = 'i') => new RegExp(String(src.source ?? src).replace(/\\b/g, B), flags + 'u');
const word = (list) => Object.keys(list).sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

/** Minutes east of UTC that `tz` is at the instant `ms`. */
export function zoneOffset(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return Math.round((Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - Math.floor(ms / 1000) * 1000) / 60000);
}

/** The offset in "2026-10-05T10:40:00+03:00" (minutes), or null. */
export function offsetOf(iso) {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(String(iso ?? '').trim());
  if (/Z$/i.test(String(iso ?? '').trim())) return 0;
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null;
}

/**
 * Find the time in a dictated todo. Returns { title, remindAt } where remindAt is ISO UTC or null.
 * `offset` is the device's minutes east of UTC (wins); otherwise `tz` (default: the server's zone).
 */
/** "remind me to", "reminder:" at the start of a dictated todo. */
export const REMIND_PREFIX = /^\s*(?:remind me (?:to|about|of)?|reminder(?: to| for)?|remember to)\s+/i;

/** `keepVerbs` leaves "remind me to …" in place (the intent parser needs it). */
export function extractWhen(text, { now = Date.now(), offset = null, tz = Intl.DateTimeFormat().resolvedOptions().timeZone, keepVerbs = false } = {}) {
  let s = ` ${String(text ?? '').replace(/\s+/g, ' ').trim()} `;
  const off = (ms) => (offset ?? zoneOffset(ms, tz)) * 60000;
  const local = new Date(now + off(now)); // wall clock as UTC fields
  const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  let day = null; // local midnight (UTC-field ms) of the chosen day
  let hour = null;
  let minute = 0;
  let exact = null; // "in 2 hours": an instant, no clock time
  let period = null;
  let found = false;
  const take = (pattern, fn) => {
    const m = re(pattern).exec(s);
    if (!m) return false;
    fn(m);
    s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ');
    found = true;
    return true;
  };

  // Clock time: "at 9", "at 9:30 pm", "9am", "at 18:00", "la 9".
  take(/(?:\b(?:at|la|@)\s+)?\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=[\s,.!?])/i, (m) => {
    hour = Number(m[1]) % 12 + (/p/i.test(m[3]) ? 12 : 0);
    minute = Number(m[2] ?? 0);
  }) || take(/\b(?:at|la|@)\s+(\d{1,2})(?::(\d{2}))?(?=[\s,.!?])/i, (m) => {
    hour = Number(m[1]);
    minute = Number(m[2] ?? 0);
    if (!m[2] && hour >= 1 && hour <= 6) hour += 12; // "at 6" is the evening
  }) || take(/\b(\d{1,2}):(\d{2})(?=[\s,.!?])/, (m) => {
    hour = Number(m[1]);
    minute = Number(m[2]);
  });
  take(`(?:(?<=\\b(?:in the|in|at|this|la|în|pe|tomorrow|today|tonight|mâine|maine|azi|astăzi|astazi|${word(WEEKDAYS)})\\s+(?:the\\s+)?)(${word(PERIODS)})(?:\\s+nopții|\\s+noptii)?\\b|\\b(?:in the|at|this|la|în|pe)\\s+(?:the\\s+)?(${word(PERIODS)})(?:\\s+nopții|\\s+noptii)?\\b|\\b(${word(PERIODS)})(?:\\s+nopții|\\s+noptii)?\\s*[.!?]?\\s*$)`, (m) => {
    m[1] = m[1] ?? m[2] ?? m[3];
    period = PERIODS[m[1].toLowerCase()];
    if (period === 24 && !/miezul/i.test(m[1]) && hour === null) hour = 24;
  });
  if (period !== null && hour !== null && hour < 12 && period >= 12 && period < 24) hour += 12;

  // Days.
  take(/\b(tonight|diseară|diseara|deseară|deseara)\b/, () => { day = today; if (hour === null) hour = 20; else if (hour < 12) hour += 12; })
    || take(/\b(today|azi|astăzi|astazi)\b/i, () => { day = today; })
    || take(/\b(day after tomorrow|poimâine|poimaine)\b/i, () => { day = today + 2 * 86400000; })
    || take(/\b(tomorrow|mâine|maine)\b/i, () => { day = today + 86400000; })
    || take(`\\b(?:in|în|peste)\\s+(\\d+|${word(SMALL)})\\s+(${word(UNITS)})\\b`, (m) => {
      const n = Number(m[1]) || SMALL[m[1].toLowerCase()] || 1;
      const unit = UNITS[m[2].toLowerCase()];
      if (unit === 'minute') exact = now + n * 60000;
      else if (unit === 'hour') exact = now + n * 3600000;
      else if (unit === 'day') day = today + n * 86400000;
      else if (unit === 'week') day = today + n * 7 * 86400000;
      else {
        const d = new Date(today);
        day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate());
      }
    })
    || take(/\b(next week|săptămâna viitoare|saptamana viitoare)\b/i, () => { day = today + ((8 - local.getUTCDay()) % 7 || 7) * 86400000; })
    || take(`\\b(?:(next|this|on|coming|pe|săptămâna viitoare|saptamana viitoare)\\s+)?(${word(WEEKDAYS)})(\\s+(?:viitoare|viitor|next))?\\b`, (m) => {
      const target = WEEKDAYS[m[2].toLowerCase()];
      const next = /next|viitoare|coming|săptămâna|saptamana/i.test(m[1] ?? '') || !!m[3];
      let ahead = (target - local.getUTCDay() + 7) % 7;
      if (ahead === 0 && (next || hour === null || hour * 60 + minute <= local.getUTCHours() * 60 + local.getUTCMinutes())) ahead = 7;
      day = today + ahead * 86400000;
    })
    || take(`\\b(?:(?:on|pe)\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${word(MONTHS)})\\b(?:,?\\s+(\\d{4}))?`, (m) => { day = monthDay(m[2], m[1], m[3]); })
    || take(`\\b(?:(?:on|pe)\\s+)?(${word(MONTHS)})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, (m) => { day = monthDay(m[1], m[2], m[3]); })
    || take(/\bon the (\d{1,2})(?:st|nd|rd|th)\b/i, (m) => {
      const d = new Date(today);
      day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (Number(m[1]) <= d.getUTCDate() ? 1 : 0), Number(m[1]));
    });

  function monthDay(month, dayNo, year) {
    const d = new Date(today);
    let y = year ? Number(year) : d.getUTCFullYear();
    let ms = Date.UTC(y, MONTHS[month.toLowerCase()], Number(dayNo));
    if (!year && ms < today) ms = Date.UTC(y + 1, MONTHS[month.toLowerCase()], Number(dayNo));
    return ms;
  }

  let remindAt = null;
  if (exact !== null) remindAt = exact;
  else if (day !== null || hour !== null || period !== null) {
    if (hour === null) hour = period ?? DEFAULT_HOUR;
    if (day === null) {
      day = today;
      if (hour * 60 + minute <= local.getUTCHours() * 60 + local.getUTCMinutes()) day += 86400000; // that time is gone today
    }
    const wall = day + hour * 3600000 + minute * 60000;
    remindAt = wall - off(wall - off(now)); // the zone's offset on that day
  }
  if (remindAt !== null && !found) remindAt = null;

  // Dangling "remind me to", "at", "on" left behind.
  let title = (keepVerbs ? s : s.replace(REMIND_PREFIX, ' '))
    .replace(/\s+(?:at|on|in|la|pe|în)\s*$/i, ' ')
    .replace(/\s+(?:at|on|la|pe)\s+(?=[,.]|$)/gi, ' ')
    .replace(/\s*,\s*,/g, ',').replace(/\s+([,.!?])/g, '$1').replace(/\s+/g, ' ').trim().replace(/^[,.\s]+|[,.\s]+$/g, '');
  return { title, remindAt: remindAt === null ? null : new Date(remindAt).toISOString() };
}
