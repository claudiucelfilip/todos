// One spoken sentence → one action on the board. "add groceries with milk and eggs",
// "update my checklist groceries and add carrots", "remind me about the dentist on Friday at 6",
// "rename water the plants to water the garden", "note on dentist: bring questions".
// The time is lifted out first (when.mjs); the local model then names the action, the card it
// targets (from the real titles it is shown) and the words. Everything the model returns is
// checked against the sentence, so it can pick and group words but never make them up.
import { extractWhen, REMIND_PREFIX } from './when.mjs';
import { cleanLine, splitItems } from './capture.mjs';

export const ACTIONS = ['create', 'add_items', 'remind', 'rename', 'notes'];
const words = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

export const INTENT_PROMPT = `You turn one spoken request about a personal to-do board into JSON. Cards are given as {"id","title"}.
Return ONLY {"action","card","title","items","notes","needsItems"}. "action" is one of create, add_items, rename, notes, remind:
- "create": a new card. "title" = the new card's name taken from the words; "items" = checklist items when the user lists things for it (after "with", "containing", a colon, or an enumeration); card = null.
- "add_items": add checklist items to an existing card; "card" = that card's id; "items" = the things to add.
- "rename": change an existing card's name; "card" = its id; "title" = the new name.
- "notes": add a note/description to an existing card; "card" = its id; "notes" = the note text.
- "remind": set a reminder on an existing card (the time was already removed from the sentence); "card" = its id.
- "needsItems" (boolean, alongside the action): true when the user wants items added (action add_items) or a checklist made (action create) but names none, e.g. "add some items to groceries", "add a few things to trip", "make a checklist called trip", "add a checklist to watch movie". Vague amounts like "a few items", "some things", "câteva lucruri" are never items; leave "items" empty and set needsItems.
Rules: use the user's own words for title, items and notes (keep their language, drop filler like "add", "a", "new", "todo", "checklist", "list", "called", "named", "my", "please"); never invent words; items are plain strings; when the user names an existing card, match it to the closest title; if nothing fits, {"action":"create"} with the whole request as the title.`;

/** Every word of `text` appears in the sentence (the model may pick and group, not invent). */
function fromSentence(sentence, text) {
  const pool = new Map();
  for (const w of words(sentence)) pool.set(w, (pool.get(w) || 0) + 1);
  for (const w of words(text)) {
    if (!pool.get(w)) return false;
    pool.set(w, pool.get(w) - 1);
  }
  return true;
}

/** Check and clean what the model said; returns null when it does not hold up. */
export function validateIntent(raw, sentence, cards) {
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) : raw; } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  // "a few items" is a request for items, not an item.
  const vague = /^(?:a few|some|a couple(?: of)?|several|more|a|câteva|niște|niste|ceva|mai multe)?\s*(?:items?|things?|stuff|entries|lucruri|chestii|elemente)$/i;
  const given = Array.isArray(data.items) ? splitItems(data.items) : [];
  const items = given.filter((i) => !vague.test(i));
  // A checklist asked for without items always gets the follow-up question, whatever the model said.
  const needsItems = (data.needsItems === true || given.length > items.length || (wantsList(sentence) && (data.action === 'create' || data.action === 'add_items'))) && !items.length;
  // The model sometimes writes the flag where the action goes.
  if (!ACTIONS.includes(data.action) && needsItems) data.action = data.card ? 'add_items' : 'create';
  if (!ACTIONS.includes(data.action)) return null;
  const title = cleanLine(typeof data.title === 'string' ? data.title : '', 200);
  const notes = typeof data.notes === 'string' ? data.notes.trim().slice(0, 5000) : '';
  const card = data.card ? cards.find((c) => c.id === data.card) : null;
  if (data.card && !card) return null;
  if (!fromSentence(sentence, title) || !fromSentence(sentence, notes) || !items.every((i) => fromSentence(sentence, i))) return null;
  const wants = needsItems ? { needsItems: true } : {};
  // "add a checklist to watch movie" while "Watch movie" exists: items go on that card, no twin.
  const twin = title && (items.length || needsItems) ? cards.find((c) => c.title.trim().toLowerCase() === title.toLowerCase()) : null;
  if (data.action === 'create' && twin) return { action: 'add_items', card: twin, items, ...wants };
  if (data.action === 'create') return title ? { action: 'create', title, items, ...wants } : null;
  if (!card) return null;
  if (data.action === 'add_items') return items.length || needsItems ? { action: 'add_items', card, items, ...wants } : null;
  if (data.action === 'rename') return title ? { action: 'rename', card, title } : null;
  if (data.action === 'notes') return notes ? { action: 'notes', card, notes } : null;
  return { action: 'remind', card };
}

/** The sentence speaks of a list or items. */
const wantsList = (sentence) => /\b(?:check ?list|list|listă|lista|items?|lucruri)\b/iu.test(sentence);

/** Without a model: "x with a, b and c" is a checklist, a checklist without items asks for them, anything else is a plain card. */
export function fallbackIntent(sentence) {
  const m = /^(.*?)\s+(?:with|containing|cu)\s+(.+)$/i.exec(sentence);
  const title = cleanLine(m ? m[1] : sentence, 200).replace(/^(?:add|create|new|make)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:todo|to-do|task|card|checklist|list)?\s*(?:called|named)?\s*/i, '').trim();
  if (!title) return null;
  const items = m ? splitItems(m[2]) : [];
  return { action: 'create', title, items, ...(!items.length && wantsList(sentence) ? { needsItems: true } : {}) };
}

/**
 * Understand `sentence` against `cards` ({ id, title }). `ask(system, user)` is the model (may be
 * null). Returns { intent, remindAt, sentence } or { error }.
 */
export async function understand(sentence, cards, ask, { now = Date.now(), offset = null, tz } = {}) {
  const spoken = cleanLine(sentence, 1000);
  if (!spoken) return { error: "I didn't catch that." };
  const { title: rest, remindAt } = extractWhen(spoken, { now, offset, tz, keepVerbs: true });
  const text = rest || spoken;
  // "remind me about <exact title> on Friday": the card is named outright, no model needed.
  const bare = text.replace(REMIND_PREFIX, '').trim().toLowerCase();
  const named = cards.find((c) => c.title.trim().toLowerCase() === bare);
  if (named && remindAt) return { intent: { action: 'remind', card: named }, remindAt };
  let intent = null;
  if (ask) {
    try {
      const list = cards.slice(0, 80).map((c) => ({ id: c.id, title: c.title }));
      intent = validateIntent(await ask(INTENT_PROMPT, `Cards: ${JSON.stringify(list)}\nRequest: ${text}`), text, cards);
    } catch { intent = null; }
  }
  if (!intent) intent = fallbackIntent(text.replace(REMIND_PREFIX, ''));
  if (!intent) return { error: "I didn't catch that." };
  if (intent.action === 'remind' && !remindAt) return { error: `I didn't catch a time for “${intent.card.title}”.` };
  return { intent, remindAt };
}
