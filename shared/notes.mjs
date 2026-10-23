// Notes (v5/v6): one card object seen as a note (kind 'note') or a to do (kind absent / 'todo').
// Shared by the app and server.js: titles, markdown previews, done-ness, linked rows, migration.

export const isNote = (c) => c?.kind === 'note';

/** Finished: a note's own `done`, a to do's status. */
export const isCardDone = (c) => (isNote(c) ? !!c.done : c?.status === 'done');

/** Markdown down to its words: headings, list marks, images, link targets, emphasis. */
export function stripMd(s) {
  return String(s ?? '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+(\[[ xX]\]\s*)?/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const firstLine = (s) => stripMd(s).split('\n').map((l) => l.trim()).find(Boolean) ?? '';

/** The first line as a title: whole when it is short (≤ 60), else cut at a word with an ellipsis. */
export function shortTitle(s) {
  const l = firstLine(s);
  return l.length <= 60 ? l : l.slice(0, 57).replace(/\s+\S*$/, '') + '…';
}

/** Title rule (v5 §5): the stored title, else the content's first line, else Untitled. */
export function displayTitle(c) {
  return (c?.title ?? '').trim() || shortTitle(c?.notes) || 'Untitled';
}

/** The first image in the markdown body: the card's thumbnail. */
export function firstImage(s) {
  const m = String(s ?? '').match(/!\[([^\]]*)\]\(([^)\s]+)\)/);
  return m ? { alt: m[1], url: m[2] } : null;
}

/** Plain http(s) links in the body, in order (the face shows the first one's host). */
export function bodyLinks(s) {
  const out = [];
  const re = /(!?)\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]+)/g;
  let m;
  while ((m = re.exec(String(s ?? '')))) {
    if (m[1]) continue; // an image, not a link
    out.push({ title: m[2] ?? '', url: m[3] ?? m[4] });
  }
  return out;
}

const mdText = (t) => String(t ?? '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
const mdUrl = (u) => String(u).replace(/[()\s<>]/g, (c) => encodeURIComponent(c));

/**
 * One-time migration of a pre-notes card (engineer notes §3): Someday becomes a note; links and
 * attachments become markdown lines appended to the body, in stored order; `links` goes. Returns
 * the migrated copy, or null when there is nothing to do.
 */
export function migrateCard(card) {
  const links = Array.isArray(card.links) ? card.links : [];
  const atts = Array.isArray(card.attachments) ? card.attachments : [];
  const body = String(card.notes ?? '');
  const lines = [];
  for (const l of links) if (!body.includes(l.url)) lines.push(`[${mdText(l.title) || hostOf(l.url)}](${mdUrl(l.url)})`);
  for (const a of atts) {
    const url = `/kanban/files/${a.id}`;
    if (body.includes(url)) continue;
    lines.push(`${String(a.type ?? '').startsWith('image/') ? '!' : ''}[${mdText(a.name) || 'file'}](${url})`);
  }
  const someday = !!card.someday && !card.archivedAt && card.status === 'todo';
  if (!lines.length && !links.length && !someday) return null;
  const next = { ...card };
  if (lines.length) next.notes = (body.trim() ? body.replace(/\s+$/, '') + '\n\n' : '') + lines.join('\n');
  delete next.links;
  if (someday) {
    next.kind = 'note';
    next.someday = false;
  }
  return next;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'link';
  }
}

/** The cards whose checklist links `id` (a row with ref = id). */
export function parentsOf(cards, id) {
  return cards.filter((c) => c.items?.some((i) => i.ref === id));
}

/** True when `childId` already sits (at any depth) inside `parentId`'s rows, or is it: linking would loop. */
export function wouldCycle(cards, parentId, childId) {
  if (parentId === childId) return true;
  const byId = new Map(cards.map((c) => [c.id, c]));
  const seen = new Set();
  const stack = [childId];
  while (stack.length) {
    const id = stack.pop();
    if (id === parentId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const i of byId.get(id)?.items ?? []) if (i.ref) stack.push(i.ref);
  }
  return false;
}
