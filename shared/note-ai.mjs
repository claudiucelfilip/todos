// v5 §5 / §6: the assistant's two small jobs on notes. It writes only its own fields (`title` with
// titleBy 'ai', `suggestedLabel`), never the body, and never a title the user typed.
import { stripMd } from './notes.mjs';

/** The title rule's second step covers it: a short first line with more lines under it. */
function firstLineCovers(body) {
  const lines = stripMd(body).split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 1 && lines[0].length <= 60;
}

/**
 * A title from the assistant: only for a note nobody titled (or the assistant did), whose body is long
 * enough to need one, once per meaningful change (the body grew or shrank by more than half since).
 * `memo` is the body length when the assistant last titled this card.
 */
export function needsTitle(card, memo) {
  if (card.kind !== 'note' || card.archivedAt || card.titleBy === 'user' || card.titleBy === 'auto') return false;
  if (card.title && card.titleBy !== 'ai') return false;
  const text = stripMd(card.notes);
  if (text.length <= 60 || firstLineCovers(card.notes)) return false;
  if (memo === undefined) return true;
  return text.length > memo * 1.5 || text.length < memo * 0.5;
}

export const TITLE_PROMPT = 'You title short personal notes. Reply with a title of at most 6 words that says what the note is about, in the language of the note, using its own words where possible. No quotes, no trailing period, no emoji. Reply with the title only.';

/** The model's answer as a title, or null when it is not usable. */
export function cleanTitle(answer) {
  const t = String(answer ?? '').split('\n').map((l) => l.trim()).find(Boolean)?.replace(/^["'“”‘’]+|["'“”‘’.]+$/g, '').replace(/^title:\s*/i, '').trim() ?? '';
  if (!t || t.length > 60 || t.split(/\s+/).length > 10) return null;
  return t;
}

/** A label suggestion: an Inbox note (no labels) with something in it, asked once. */
export function needsLabel(card, asked) {
  return card.kind === 'note' && !card.archivedAt && !(card.labels ?? []).length && !card.suggestedLabel && !asked && (stripMd(card.notes).length > 10 || card.items?.length > 0 || !!card.title);
}

export function labelPrompt(labels) {
  return `You file personal notes under one label. The labels are: ${labels.map((l) => l.name).join(', ')}. Reply with exactly one of those names, or "none" when no label clearly fits. Reply with the name only.`;
}

/** The label id the model chose, or null ("none", or a name that is not a label). */
export function pickLabel(answer, labels) {
  const a = String(answer ?? '').trim().replace(/^["'“”]+|["'“”.]+$/g, '').toLowerCase();
  if (!a || a === 'none') return null;
  return labels.find((l) => l.name.toLowerCase() === a)?.id ?? null;
}

/** What the model reads: the title, the body, the checklist. */
export function noteText(card) {
  return [card.title, stripMd(card.notes), ...(card.items ?? []).map((i) => `- ${i.text}`)].filter(Boolean).join('\n').slice(0, 3000);
}
