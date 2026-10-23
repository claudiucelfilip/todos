import { cleanBehavior, groupedLabels } from './automations.mjs';
import { wouldCycle } from './notes.mjs';
import { applyWorkflow, workflowLabels } from './workflow.mjs';
// §13.3 — the one merge used by server.js and the client. Plain ESM so both can
// import it. Every reducer action is { id, deviceId, ts, type, payload }:
//   card.put    { card }                       create / restore (fields + items merge)
//   card.set    { id, fields }                 per-field last-write-wins by ts
//   card.delete { id }                         tombstone; a newer card.put resurrects
//   item.put    { cardId, item, at? }          add wins over nothing; text(+ref)/done LWW
//   item.set    { cardId, itemId, done }       check / uncheck LWW
//   item.delete { cardId, itemId }             delete wins over an older edit
//   items.order { cardId, ids }                item order LWW
//   att.put     { cardId, att }                attachment add / edit / restore, per attachment LWW
//   att.delete  { cardId, attId }              attachment tombstone; a newer att.put restores it
//   label.put   { label }                      board label create / edit, whole-label LWW
//   label.delete { id }                        label tombstone; a newer label.put resurrects
// Derivation (§6) runs after every items change, so status is never synced as
// truth for checklist cards; for plain cards `status` is an ordinary field.
// Notes (kind 'note') skip derivation: their `done` and `completedAt` are plain fields.
// An item with `ref` IS another card; its `done` mirrors that card (written by the app).

const FIELDS = ['reopenStage', 'workflowVersion', 'title', 'notes', 'status', 'order', 'someday', 'repeat', 'archivedAt', 'completedAt', 'createdAt', 'labels', 'links', 'ext', 'remindAt', 'remindedAt', 'remindEvery', 'notify', 'kind', 'titleBy', 'done', 'layout', 'suggestedLabel', 'via'];
const OPTIONAL = new Set(['reopenStage', 'links', 'ext', 'kind', 'titleBy', 'done', 'layout', 'suggestedLabel', 'via']); // null = absent
const HEX = /^#[0-9a-fA-F]{6}$/;
const EPOCH = new Date(0).toISOString();
const ITEM_MAX = 1000; // item text: room for a Markdown link's URL

export function emptyState() {
  return { cards: {}, meta: {}, labels: {}, lmeta: {} };
}

/** Arrays/objects (labels, links, ext) compare by value. */
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** ts + deviceId ordering so two devices in the same millisecond resolve deterministically. */
function later(ts, dev, curTs, curDev) {
  if (!curTs) return true;
  if (ts !== curTs) return ts > curTs;
  return String(dev) > String(curDev);
}

function meta(state, id) {
  const m = (state.meta[id] ??= { f: {}, items: {}, deleted: null, deletedDev: '', order: null, orderDev: '' });
  m.att ??= {};
  return m;
}

/** Only the known attachment fields, bounded; ids are the file ids on the server. */
function cleanAtt(a) {
  const out = {
    id: String(a.id),
    name: String(a.name ?? 'file').slice(0, 200) || 'file',
    type: typeof a.type === 'string' && a.type ? a.type.slice(0, 100) : 'application/octet-stream',
    size: Number.isFinite(Number(a.size)) && typeof a.size !== 'string' ? Math.max(0, Number(a.size)) : 0,
    createdAt: typeof a.createdAt === 'string' ? a.createdAt : '',
  };
  if (Number.isFinite(a.width) && Number.isFinite(a.height)) {
    out.width = a.width;
    out.height = a.height;
  }
  if (a.thumb === true) out.thumb = true;
  return out;
}

/** att.put: LWW against the attachment's last put and last delete. */
function putAtt(card, m, a, ts, dev) {
  const am = (m.att[a.id] ??= { p: null, x: null });
  if (am.x && !later(ts, dev, am.x.ts, am.x.dev)) return false;
  if (am.p && !later(ts, dev, am.p.ts, am.p.dev)) return false;
  am.p = { ts, dev };
  const next = cleanAtt(a);
  const list = card.attachments ? [...card.attachments] : [];
  const i = list.findIndex((x) => x.id === next.id);
  if (i >= 0 && same(list[i], next)) return false;
  if (i >= 0) list[i] = next;
  else list.push(next);
  list.sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
  card.attachments = list;
  return true;
}

function delAtt(card, m, id, ts, dev) {
  const am = (m.att[id] ??= { p: null, x: null });
  if (am.x && !later(ts, dev, am.x.ts, am.x.dev)) return false;
  am.x = { ts, dev };
  if (am.p && later(am.p.ts, am.p.dev, ts, dev)) return false; // restored after this delete
  const list = (card.attachments ?? []).filter((x) => x.id !== id);
  if (list.length === (card.attachments ?? []).length) return false;
  if (list.length) card.attachments = list;
  else delete card.attachments; // none = absent
  return true;
}

function deriveStatus(items, prev) {
  if (items.length === 0) return prev;
  const done = items.filter((i) => i.done).length;
  if (done === items.length) return 'done';
  if (done > 0) return 'doing';
  return prev === 'done' ? 'todo' : prev;
}

/**
 * §6 after every change. A status the same batch set explicitly (same ts) wins once the
 * items agree with it: To do with nothing checked stays To do in whatever order the
 * card.set and the item unchecks arrive (Reopen / To do on a fully checked list).
 */
function rederive(card, ts, m, labels = []) {
  if (card.workflowVersion === 1) card.labels = groupedLabels(card.labels ?? [], labels);
  if (card.workflowVersion === 1) {
    // Older clients send status/kind; explicit labels in the same batch win.
    const candidates = ['status', 'kind', 'done'].filter((f) => m?.f[f] && (!m.f.labels || later(m.f[f].ts, m.f[f].dev, m.f.labels.ts, m.f.labels.dev)));
    candidates.sort((a, b) => later(m.f[a].ts, m.f[a].dev, m.f[b].ts, m.f[b].dev) ? -1 : 1);
    const field = candidates[0];
    if (field) {
      const status = field === 'status' ? card.status : field === 'done' ? (card.done ? 'done' : null) : card.kind === 'note' ? null : card.status;
      card.labels = workflowLabels(card.labels, status);
      m.f.labels = { ...m.f[field] };
    }
    applyWorkflow(card, ts, labels);
    return;
  }
  if (card.kind === 'note') return;
  let next = deriveStatus(card.items, card.status);
  const intent = m?.intent;
  if (next !== 'todo' && intent?.status === 'todo' && intent.ts === ts && card.items.length && !card.items.some((i) => i.done)) next = 'todo';
  if (next !== card.status) card.status = next;
  if (card.status === 'done') {
    if (!card.completedAt) card.completedAt = ts;
  } else if (card.completedAt) card.completedAt = null;
}

function setField(state, card, m, field, value, ts, dev) {
  if (!FIELDS.includes(field)) return false;
  const cur = m.f[field];
  if (cur && !later(ts, dev, cur.ts, cur.dev)) return false;
  m.f[field] = { ts, dev };
  if (field === 'status') m.intent = { status: value, ts };
  if (field === 'labels') card.labels = Array.isArray(value) ? value.filter((x) => typeof x === 'string') : [];
  else if ((field === 'links' || field === 'ext' || field === 'layout') && (value === null || typeof value !== 'object')) delete card[field];
  else if (OPTIONAL.has(field) && (value === null || value === undefined || (field === 'done' && !value))) delete card[field];
  else card[field] = value;
  return true;
}

function putItem(state, card, m, item, at, ts, dev) {
  if (item.ref && wouldCycle(Object.values(state.cards), card.id, item.ref)) return false;
  const im = (m.items[item.id] ??= { t: null, d: null, x: null });
  if (im.x && !later(ts, dev, im.x.ts, im.x.dev)) return false; // deleted later than this put
  let cur = card.items.find((i) => i.id === item.id);
  let changed = false;
  if (!cur) {
    cur = { id: item.id, text: String(item.text ?? '').slice(0, ITEM_MAX), done: !!item.done };
    if (typeof item.ref === 'string' && item.ref) cur.ref = item.ref;
    const idx = typeof at === 'number' ? Math.max(0, Math.min(at, card.items.length)) : 0;
    card.items.splice(idx, 0, cur);
    im.t = { ts, dev };
    im.d = { ts, dev };
    im.x = null;
    return true;
  }
  if (!im.t || later(ts, dev, im.t.ts, im.t.dev)) {
    if (cur.text !== item.text) { cur.text = String(item.text ?? '').slice(0, ITEM_MAX); changed = true; }
    // `ref` travels with the text: absent from the payload = unchanged, null = cleared.
    if (item.ref !== undefined && (cur.ref ?? null) !== (item.ref || null)) {
      if (typeof item.ref === 'string' && item.ref) cur.ref = item.ref;
      else delete cur.ref;
      changed = true;
    }
    im.t = { ts, dev };
  }
  if (item.done !== undefined && (!im.d || later(ts, dev, im.d.ts, im.d.dev))) {
    if (cur.done !== !!item.done) { cur.done = !!item.done; changed = true; }
    im.d = { ts, dev };
  }
  return changed;
}

/** Apply one action. Returns true when the state changed. */
export function applyAction(state, a) {
  if (!a || typeof a !== 'object' || !a.type || !a.ts) return false;
  const p = a.payload || {};
  const ts = String(a.ts);
  const dev = String(a.deviceId ?? '');

  switch (a.type) {
    case 'card.put': {
      const src = p.card;
      if (!src || typeof src.id !== 'string') return false;
      const m = meta(state, src.id);
      if (m.deleted && !later(ts, dev, m.deleted, m.deletedDev)) return false;
      let card = state.cards[src.id];
      let changed = false;
      if (!card) {
        card = { id: src.id, title: '', notes: '', status: 'todo', order: 0, items: [], labels: [], remindAt: null, remindedAt: null, createdAt: ts, updatedAt: ts, completedAt: null, archivedAt: null, someday: false, repeat: false };
        state.cards[src.id] = card;
        m.deleted = null;
        changed = true;
      }
      for (const f of FIELDS) if (src[f] !== undefined) changed = setField(state, card, m, f, src[f], ts, dev) || changed;
      for (let i = 0; i < (src.items || []).length; i++) changed = putItem(state, card, m, src.items[i], i, ts, dev) || changed;
      for (const a of Array.isArray(src.attachments) ? src.attachments : []) if (a && typeof a.id === 'string' && a.id) changed = putAtt(card, m, a, ts, dev) || changed;
      if (Array.isArray(src.items) && (!m.order || later(ts, dev, m.order, m.orderDev))) {
        const ids = src.items.map((i) => i.id);
        card.items.sort((x, y) => idx(ids, x.id) - idx(ids, y.id));
        m.order = ts; m.orderDev = dev;
      }
      rederive(card, ts, m, Object.values(state.labels ?? {}));
      if (changed) card.updatedAt = maxTs(card.updatedAt, ts);
      return changed;
    }
    case 'card.set': {
      const card = state.cards[p.id];
      if (!card || !p.fields) return false;
      const m = meta(state, p.id);
      let changed = false;
      for (const f of Object.keys(p.fields)) changed = setField(state, card, m, f, p.fields[f], ts, dev) || changed;
      rederive(card, ts, m, Object.values(state.labels ?? {}));
      if (changed) card.updatedAt = maxTs(card.updatedAt, ts);
      return changed;
    }
    case 'card.delete': {
      const m = meta(state, p.id);
      if (m.deleted && !later(ts, dev, m.deleted, m.deletedDev)) return false;
      m.deleted = ts; m.deletedDev = dev;
      const existed = !!state.cards[p.id];
      delete state.cards[p.id];
      return existed;
    }
    case 'item.put': {
      const card = state.cards[p.cardId];
      if (!card || !p.item || typeof p.item.id !== 'string') return false;
      const m = meta(state, p.cardId);
      const changed = putItem(state, card, m, p.item, p.at, ts, dev);
      rederive(card, ts, m, Object.values(state.labels ?? {}));
      if (changed) card.updatedAt = maxTs(card.updatedAt, ts);
      return changed;
    }
    case 'item.set': {
      const card = state.cards[p.cardId];
      if (!card) return false;
      const m = meta(state, p.cardId);
      const im = (m.items[p.itemId] ??= { t: null, d: null, x: null });
      const cur = card.items.find((i) => i.id === p.itemId);
      if (!cur) return false;
      if (im.d && !later(ts, dev, im.d.ts, im.d.dev)) return false;
      im.d = { ts, dev };
      if (cur.done === !!p.done) return false;
      cur.done = !!p.done;
      rederive(card, ts, m, Object.values(state.labels ?? {}));
      card.updatedAt = maxTs(card.updatedAt, ts);
      return true;
    }
    case 'item.delete': {
      const card = state.cards[p.cardId];
      if (!card) return false;
      const m = meta(state, p.cardId);
      const im = (m.items[p.itemId] ??= { t: null, d: null, x: null });
      if (im.x && !later(ts, dev, im.x.ts, im.x.dev)) return false;
      im.x = { ts, dev };
      const before = card.items.length;
      card.items = card.items.filter((i) => i.id !== p.itemId);
      if (card.items.length === before) return false;
      rederive(card, ts, m, Object.values(state.labels ?? {}));
      card.updatedAt = maxTs(card.updatedAt, ts);
      return true;
    }
    case 'items.order': {
      const card = state.cards[p.cardId];
      if (!card || !Array.isArray(p.ids)) return false;
      const m = meta(state, p.cardId);
      if (m.order && !later(ts, dev, m.order, m.orderDev)) return false;
      m.order = ts; m.orderDev = dev;
      const before = card.items.map((i) => i.id).join();
      card.items.sort((x, y) => idx(p.ids, x.id) - idx(p.ids, y.id));
      return card.items.map((i) => i.id).join() !== before;
    }
    case 'att.put': {
      const card = state.cards[p.cardId];
      if (!card || !p.att || typeof p.att.id !== 'string' || !p.att.id) return false;
      const changed = putAtt(card, meta(state, p.cardId), p.att, ts, dev);
      if (changed) card.updatedAt = maxTs(card.updatedAt, ts);
      return changed;
    }
    case 'att.delete': {
      const card = state.cards[p.cardId];
      if (!card || typeof p.attId !== 'string') return false;
      const changed = delAtt(card, meta(state, p.cardId), p.attId, ts, dev);
      if (changed) card.updatedAt = maxTs(card.updatedAt, ts);
      return changed;
    }
    case 'label.put': {
      const src = p.label;
      if (!src || typeof src.id !== 'string' || !src.id) return false;
      state.labels ??= {};
      const lm = lmeta(state, src.id);
      if (lm.deleted && !later(ts, dev, lm.deleted, lm.deletedDev)) return false;
      if (lm.ts && !later(ts, dev, lm.ts, lm.dev)) return false;
      lm.ts = ts; lm.dev = dev; lm.deleted = null;
      const prev = state.labels[src.id];
      const name = String(src.name ?? '').trim().slice(0, 40) || prev?.name || 'Label';
      const color = HEX.test(String(src.color)) ? String(src.color) : prev?.color || '#7C5CFF';
      state.labels[src.id] = { id: src.id, name, color, ...cleanBehavior(src, prev), updatedAt: ts };
      return !prev || !same({ ...prev, updatedAt: ts }, state.labels[src.id]);
    }
    case 'label.delete': {
      if (typeof p.id !== 'string') return false;
      state.labels ??= {};
      const lm = lmeta(state, p.id);
      if (lm.deleted && !later(ts, dev, lm.deleted, lm.deletedDev)) return false;
      if (lm.ts && !later(ts, dev, lm.ts, lm.dev)) return false;
      lm.deleted = ts; lm.deletedDev = dev;
      const existed = !!state.labels[p.id];
      delete state.labels[p.id];
      return existed;
    }
    default:
      return false;
  }
}

function lmeta(state, id) {
  state.lmeta ??= {};
  return (state.lmeta[id] ??= { ts: null, dev: '', deleted: null, deletedDev: '' });
}

function idx(ids, id) {
  const i = ids.indexOf(id);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

function maxTs(a, b) {
  return !a || b > a ? b : a;
}

/** The live board + the ids that are tombstoned (so a slow device does not resurrect them). */
export function snapshot(state) {
  const cards = Object.values(state.cards).map((c) => {
    const out = { ...c, items: c.items.map((i) => ({ ...i })) };
    if (c.layout) out.layout = { ...c.layout };
    if (c.attachments) out.attachments = c.attachments.map((a) => ({ ...a }));
    return out;
  });
  const tombstones = Object.keys(state.meta).filter((id) => state.meta[id].deleted && !state.cards[id]);
  const labels = Object.values(state.labels ?? {}).map((l) => ({ ...l }));
  const lm = state.lmeta ?? {};
  const labelTombstones = Object.keys(lm).filter((id) => lm[id].deleted && !state.labels?.[id]);
  return { cards, tombstones, labels, labelTombstones };
}

/** Drop tombstones (and their meta) older than `days`. */
export function pruneTombstones(state, nowIso, days = 30) {
  const cutoff = new Date(nowIso).getTime() - days * 86400000;
  for (const id of Object.keys(state.meta)) {
    const m = state.meta[id];
    if (m.deleted && !state.cards[id] && new Date(m.deleted).getTime() < cutoff) {
      delete state.meta[id];
      continue;
    }
    for (const [aid, am] of Object.entries(m.att ?? {})) {
      if (am.x && new Date(am.x.ts).getTime() < cutoff && !state.cards[id]?.attachments?.some((a) => a.id === aid)) delete m.att[aid];
    }
  }
  for (const id of Object.keys(state.lmeta ?? {})) {
    const m = state.lmeta[id];
    if (m.deleted && !state.labels?.[id] && new Date(m.deleted).getTime() < cutoff) delete state.lmeta[id];
  }
}

/** Rebuild a state from plain cards + labels (fresh device / client bootstrap): stamped with updatedAt. */
export function stateFromCards(cards, labels = []) {
  const s = emptyState();
  // An unstamped label (a locally seeded built-in) loses to any real edit.
  for (const l of labels) applyAction(s, { id: 'boot-l-' + l.id, deviceId: '', ts: l.updatedAt || EPOCH, type: 'label.put', payload: { label: l } });
  for (const c of cards) applyAction(s, { id: 'boot-' + c.id, deviceId: '', ts: c.updatedAt || c.createdAt || EPOCH, type: 'card.put', payload: { card: c } });
  return s;
}

let seq = 0;
function actionId(dev, ts) {
  return `${dev}-${ts}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Emit the actions that turn `before` into `after` (both card arrays). Used by
 * the client after every committed write; replaying them elsewhere reproduces
 * the same board.
 */
export function diffCards(before, after, ts, deviceId) {
  const out = [];
  const mk = (type, payload) => out.push({ id: actionId(deviceId, ts), deviceId, ts, type, payload });
  const prev = new Map(before.map((c) => [c.id, c]));
  const nextIds = new Set(after.map((c) => c.id));
  for (const c of before) if (!nextIds.has(c.id)) mk('card.delete', { id: c.id });
  for (const c of after) {
    const p = prev.get(c.id);
    if (!p) { mk('card.put', { card: c }); continue; }
    const fields = {};
    for (const f of FIELDS) if (!same(c[f], p[f])) fields[f] = c[f] === undefined ? null : c[f];
    const pItems = new Map(p.items.map((i) => [i.id, i]));
    const nIds = new Set(c.items.map((i) => i.id));
    for (const i of p.items) if (!nIds.has(i.id)) mk('item.delete', { cardId: c.id, itemId: i.id });
    c.items.forEach((i, at) => {
      const q = pItems.get(i.id);
      if (!q) mk('item.put', { cardId: c.id, item: i.ref ? { id: i.id, text: i.text, done: i.done, ref: i.ref } : { id: i.id, text: i.text, done: i.done }, at });
      else {
        if (q.text !== i.text || (q.ref ?? null) !== (i.ref ?? null)) mk('item.put', { cardId: c.id, item: { id: i.id, text: i.text, ref: i.ref ?? null }, at });
        if (q.done !== i.done) mk('item.set', { cardId: c.id, itemId: i.id, done: i.done });
      }
    });
    const pAtt = new Map((p.attachments ?? []).map((a) => [a.id, a]));
    const nAtt = new Set((c.attachments ?? []).map((a) => a.id));
    for (const a of p.attachments ?? []) if (!nAtt.has(a.id)) mk('att.delete', { cardId: c.id, attId: a.id });
    for (const a of c.attachments ?? []) if (!same(a, pAtt.get(a.id))) mk('att.put', { cardId: c.id, att: a });
    const pOrder = p.items.filter((i) => nIds.has(i.id)).map((i) => i.id).join();
    const nOrder = c.items.filter((i) => pItems.has(i.id)).map((i) => i.id).join();
    if (pOrder !== nOrder) mk('items.order', { cardId: c.id, ids: c.items.map((i) => i.id) });
    // Fields last: the items settle first, then the explicit status lands on them.
    if (Object.keys(fields).length) mk('card.set', { id: c.id, fields });
  }
  return out;
}

/** Emit label.put / label.delete for the label list change `before` → `after`. */
export function diffLabels(before, after, ts, deviceId) {
  const out = [];
  const mk = (type, payload) => out.push({ id: actionId(deviceId, ts), deviceId, ts, type, payload });
  const prev = new Map(before.map((l) => [l.id, l]));
  const nextIds = new Set(after.map((l) => l.id));
  for (const l of before) if (!nextIds.has(l.id)) mk('label.delete', { id: l.id });
  for (const l of after) {
    const p = prev.get(l.id);
    if (!p || !same({ ...p, updatedAt: null }, { ...l, updatedAt: null })) mk('label.put', { label: { ...l, ...(p?.group !== undefined && l.group === undefined ? { group: null } : {}), ...(p?.automations !== undefined && l.automations === undefined ? { automations: null } : {}), ...(p?.flowStage !== undefined && l.flowStage === undefined ? { flowStage: null } : {}) } });
  }
  return out;
}
