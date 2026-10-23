// Siri / Shortcuts capture: a dictated title (with the reminder time spoken inside it, see
// when.mjs), an optional dictated checklist. Pure, so the parsing is testable without a server.
import { extractWhen, offsetOf } from './when.mjs';
const TITLE_MAX = 200;
const ITEM_MAX = 200;
const ITEMS_MAX = 50;
const NOTES_MAX = 5000;
const SKIP = new Set(['no', 'none', 'nothing', 'nope', 'skip', 'no thanks', 'nu', 'nimic']);

/** One clean line: whitespace collapsed and the full stop dictation adds at the end dropped. */
export function cleanLine(text, max = TITLE_MAX) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[.。]+$/, '').trim().slice(0, max);
}

/** "milk, eggs and bread" → ["milk", "eggs", "bread"]: commas, semicolons, new lines and a spoken "and" split. */
export function splitItems(input) {
  const parts = Array.isArray(input) ? input.map((x) => String(x ?? '')) : String(input ?? '').split(/[\n;,]+|\s+(?:and|și|si)\s+/i);
  const items = parts.map((p) => cleanLine(p, ITEM_MAX)).filter(Boolean);
  if (items.length === 1 && SKIP.has(items[0].toLowerCase())) return [];
  return [...new Set(items)].slice(0, ITEMS_MAX);
}

/**
 * Validate a capture body → { title, items, notes, remindAt, offset } or { error }. `body.now` is the
 * device's current time as ISO with its zone ("…T10:40:00+03:00"): "tomorrow at 9" means the device's
 * tomorrow. An explicit `remindAt` (ISO) wins over a time spoken in the title.
 */
export function parseCapture(body, { now = Date.now(), tz } = {}) {
  if (!body || typeof body !== 'object') return { error: 'body must be an object' };
  const raw = body.title ?? body.text;
  if (typeof raw !== 'string') return { error: 'title is required' };
  const offset = offsetOf(body.now);
  const deviceNow = Date.parse(String(body.now ?? ''));
  // The device's clock is trusted only within a day of the server's; relative times then follow it.
  const at = Number.isNaN(deviceNow) || Math.abs(deviceNow - now) > 86400000 ? now : deviceNow;
  const spoken = body.remindAt === undefined ? extractWhen(cleanLine(raw, TITLE_MAX * 2), { now: at, offset, tz }) : { title: raw, remindAt: null };
  const title = cleanLine(spoken.title, TITLE_MAX);
  if (!title) return { error: 'title is required' };
  if (body.items !== undefined && typeof body.items !== 'string' && !Array.isArray(body.items)) return { error: 'items must be a string or an array of strings' };
  if (body.notes !== undefined && typeof body.notes !== 'string') return { error: 'notes must be a string' };
  let remindAt = spoken.remindAt;
  if (body.remindAt !== undefined && body.remindAt !== null && String(body.remindAt).trim() !== '') {
    const t = Date.parse(String(body.remindAt));
    if (Number.isNaN(t)) return { error: "couldn't understand the reminder time" };
    if (t < now - 60000) return { error: 'the reminder time has already passed' };
    remindAt = new Date(t).toISOString();
  }
  return { title, items: splitItems(body.items ?? ''), notes: String(body.notes ?? '').slice(0, NOTES_MAX), remindAt, offset };
}

/**
 * The checklist items of a capture. Separators split (splitItems); when there are none and the
 * dictation has several words, `splitter` (the local model) groups the words into items. Any
 * failure there keeps the dictation as one item.
 */
export async function captureItems(input, splitter) {
  const items = splitItems(input);
  if (items.length !== 1 || !splitter || items[0].split(' ').length < 2) return items;
  try {
    const split = await splitter(items[0]);
    return split.map((i) => cleanLine(i, ITEM_MAX)).filter(Boolean).slice(0, ITEMS_MAX);
  } catch {
    return items;
  }
}

/** What Siri says back. The reminder reads in the device's zone (`offset`, minutes) or `tz`. */
export function sayCapture({ title, items = [], remindAt = null, offset = null }, tz) {
  let out = `Added “${title}”`;
  if (items.length) out += ` with ${items.length} item${items.length === 1 ? '' : 's'}: ${items.join(', ')}`;
  if (remindAt) {
    const style = { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' };
    const when = offset !== null ? new Date(Date.parse(remindAt) + offset * 60000).toLocaleString('en-GB', { ...style, timeZone: 'UTC' }) : new Date(remindAt).toLocaleString('en-GB', { ...style, ...(tz ? { timeZone: tz } : {}) });
    out += `. Reminder ${when}`;
  }
  return out + '.';
}
