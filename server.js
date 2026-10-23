import { createSherlock, REPLY_LABEL } from './shared/sherlock.mjs';
import { groupedLabels, settleAutomations } from './shared/automations.mjs';
import { WORKFLOW_LABELS, migrateLinkedNotes, migrateWorkflow, workflowStatus, workflowLabels } from './shared/workflow.mjs';
// Todos — self-contained backend.
//
// Serves the built PWA from dist/ and the room-scoped kanban sync API (§13.3)
// on the same origin. Data is data/kanban.json, a runtime store that is NOT
// versioned (git-ignored) so a deploy (git reset --hard) can never clobber it.
// The legacy list-model store (data/db.json) is no longer read or written.
//
// Auth for push / pull / snapshot / session: a session cookie from
// POST /kanban/login, `Bearer <API_TOKEN>` (scripts, older devices) or
// `Basic <TODOS_USER:TODOS_PASS>`. With neither API_TOKEN nor TODOS_USER set the
// routes are open (local dev only); without TODOS_USER login is disabled. The
// session cookie is HMAC-signed with <DATA_DIR>/session-secret (0600, made once).
// Failed logins and Basic attempts are limited to 10 per 10 min per client IP
// (cf-connecting-ip / x-forwarded-for are trusted only from a loopback peer, i.e.
// the tunnel). Sessions also expire server-side one year after issue.
// The /kanban/external/* routes always need a token: API_TOKEN or the external
// token in <DATA_DIR>/external-token (created 0600 on first start).
// DATA_DIR defaults to ./data. The original owner uses environment credentials; invited accounts use salted password hashes.
//
// Routes:
//   GET  /                 -> dist/index.html
//   GET  /healthz          -> { ok: true, service: 'todos', time }
//   POST /kanban/login     { username, password } -> { ok, user } + Set-Cookie todos_session
//                             (HttpOnly, SameSite=Lax, Path=/, 1 year, Secure behind https); 401 / 429
//   POST /kanban/logout    -> clears the cookie
//   GET  /kanban/session   -> { ok, user } or 401 (the client shows its login on 401)
//   POST /kanban/push      -> { deviceId, actions: Action[] } -> { cursor, applied }
//   GET  /kanban/pull?since=<cursor> -> { actions, cursor }
//                             (or { reset, cards, tombstones, labels, labelTombstones, cursor })
//   GET  /kanban/snapshot  -> { cards, tombstones, labels, labelTombstones, cursor }
//
// View-only link (see "view-only share link" below): owner-only GET|POST|DELETE /kanban/share,
// public GET /view/<token> -> 302 / + todos_view cookie (+ the readable todos_viewer=1 marker). A viewer
// reads session, a filtered snapshot and files on visible cards, nothing else.
// CSRF: a write (not GET/HEAD/OPTIONS) from another origin is never authenticated by a cookie.
// Failed logins and wrong view links are limited in separate buckets.
//
// External API (wiki capture, Slack hook). Writes go through the action log as
// device 'server', so every device receives them on its next pull.
//   POST /kanban/external/card   { key, title, notes?, links?: {title,url}[], labels?: {id,name,color}[],
//                                  status?: 'todo'|'doing'|'done', slackTs?, slackChannel? }
//        -> { ok, id, created }. Idempotent by key: an existing card only gains links never
//           delivered before (ext.seenLinks) and slackTs/slackChannel; missing labels are created.
//   POST /kanban/external/status { key? | slackTs?, status } -> { ok, id, changed } | 404
//   GET  /kanban/external/card?key=… -> { ok, card } | 404
//   (external card also takes remindAt (ISO or null) and remindEvery (hour, day, weekday, week,
//    month or null) on create and update, and on an
//    existing key `replace: ["title","notes"]` to overwrite just those fields)
//   (the external routes also target a card by ?id= or an exact ?title=; see ROUTES below and /agents)
//   GET  /kanban/notify-topic -> { topic, subscribeUrl }   (authed; for Settings)
//   POST /kanban/notify-test  -> sends a test push         (authed)
// Reminders: see the scheduler below; env NTFY_SERVER, NTFY_TOPIC, APP_URL, REMINDER_TICK_MS.
//
// Node >= 20.3; the local assistant uses fetch and AbortSignal.any.

import { createAssistant } from './shared/assistant.mjs';
import { createAssistantJobs } from './shared/assistant-jobs.mjs';
const askAssistant = createAssistant();
const assistantJobs = createAssistantJobs(askAssistant);

import { emailSender } from './shared/email-auth.mjs';
import { parseCapture, captureItems, sayCapture } from './shared/capture.mjs';
import { SHORTCUTS, shortcutXml, signShortcut, signingAvailable } from './shared/shortcut-file.mjs';
import { createDictationSplitter, createCompleter } from './shared/split.mjs';
import { understand } from './shared/intent.mjs';
import { pageTitle } from './shared/page-title.mjs';
import { offsetOf } from './shared/when.mjs';
import { bodyLinks, displayTitle, hostOf, migrateCard, stripMd } from './shared/notes.mjs';
import { TITLE_PROMPT, cleanTitle, labelPrompt, needsLabel, needsTitle, noteText, pickLabel } from './shared/note-ai.mjs';
const splitDictation = createDictationSplitter();
const askModel = createCompleter();
const askNote = createCompleter({ timeout: 20000 }); // v5: note titles and label suggestions (20 s)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { accountStore } from './shared/accounts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const API_TOKEN = process.env.API_TOKEN || '';
const PORT = Number(process.env.PORT || 8094);

// --------------------------- kanban action log ------------------------------
// data/kanban.json = { seq, logStart, log: Action[], state } — an append-only
// action log plus the merged snapshot (shared/merge.mjs applies both here and
// on every device, so replay is identical). Tombstones are kept 30 days; the log
// is compacted to the same window and a device behind `logStart` re-bootstraps
// from the snapshot.
import { emptyState, applyAction, snapshot, pruneTombstones, diffCards, diffLabels } from './shared/merge.mjs';
import { REMIND_EVERY, dueAt, lastSlot, onceAt, quiet, remindResting, repeats, restStamp } from './shared/repeat.mjs';

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const LEGACY_KANBAN_FILE = path.join(DATA_DIR, 'kanban.json');
const EXTERNAL_TOKEN_FILE = path.join(DATA_DIR, 'external-token');
const SESSION_SECRET_FILE = path.join(DATA_DIR, 'session-secret');
const TODOS_USER = process.env.TODOS_USER || '';
const TODOS_PASS = process.env.TODOS_PASS || '';
const KEEP_DAYS = 30;

const accounts = accountStore(DATA_DIR, TODOS_USER);
const roomContext = new AsyncLocalStorage();
const roomId = () => roomContext.getStore() || 'personal';
const storageDir = () => roomId() === 'personal' ? DATA_DIR : path.join(DATA_DIR, 'rooms', roomId());
const botConversationsFile = () => path.join(storageDir(), 'bot-conversations.json');
const BOT_REPLY_LABELS = {
  claw: { id: 'claw:replied', name: 'Claw replied', color: '#66D2B0', removeOnView: true },
  lurch: { id: 'lurch:replied', name: 'Lurch replied', color: '#66D2B0', removeOnView: true },
};
const botReplyLabel = () => BOT_REPLY_LABELS[accounts.room(roomId())?.bot];
function botConversations() {
  try { return JSON.parse(fs.readFileSync(botConversationsFile(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function saveBotConversations(conversations) {
  const file = botConversationsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(conversations), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function reconcileBotReplyLabels() {
  const label = botReplyLabel();
  if (!label) return;
  const conversations = botConversations();
  const tracked = Object.entries(conversations).filter(([id]) => kb.state.cards[id]);
  if (tracked.some(([, requests]) => requests.some(request => request.reply && !request.seenAt)) && !kb.state.labels[label.id]) pushServer(diffLabels(Object.values(kb.state.labels), [...Object.values(kb.state.labels), label], serverTs(), 'server'));
  for (const [id, requests] of tracked) {
    const card = kb.state.cards[id];
    const unread = requests.some(request => request.reply && !request.seenAt);
    if (unread !== card.labels.includes(label.id)) pushServer(diffCards([card], [{ ...card, labels: unread ? [...card.labels, label.id] : card.labels.filter(id => id !== label.id) }], serverTs(card.updatedAt), 'server'));
  }
}
function migratePendingBotAsks() {
  const conversations = botConversations();
  for (const task of Object.values(kb.state.cards)) {
    const match = /^delegate:([a-zA-Z0-9-]{8,100})$/.exec(task.ext?.key || '');
    if (!match || task.status !== 'todo') continue;
    const link = task.links?.find(item => item.title === 'Source note')?.url || /\[Source note\]\((https?:\/\/[^)]+)\)/.exec(task.notes)?.[1];
    if (!link) continue;
    let sourceId, sourceRoom;
    try {
      const url = new URL(link);
      sourceId = decodeURIComponent(url.hash.slice('#card/'.length));
      sourceRoom = url.searchParams.get('room');
      if (!url.hash.startsWith('#card/')) continue;
    } catch { continue; }
    if (sourceRoom !== roomId()) continue;
    const source = kb.state.cards[sourceId];
    const marker = '\n\nSource note:';
    const message = task.notes.split(marker)[0]?.trim();
    if (!source || !message) continue;
    if (!(conversations[sourceId] || []).some(entry => entry.requestId === match[1])) {
      const at = task.createdAt || new Date().toISOString();
      conversations[sourceId] = [...(conversations[sourceId] || []), { requestId: match[1], cardId: sourceId, message, status: 'queued', createdAt: at, updatedAt: at }];
      saveBotConversations(conversations);
    }
    const linkedTask = new RegExp(`\\n\\n\\[(?:Claw|Lurch) follow-up\\]\\([^)]*#card/${task.id}\\)`, 'g');
    const notes = source.notes.replace(linkedTask, '');
    if (notes !== source.notes) pushServer(diffCards([source], [{ ...source, notes }], serverTs(source.updatedAt), 'server'));
    pushServer(diffCards([task], [], serverTs(task.updatedAt), 'server'));
  }
}
const kanbanFile = () => roomId() === 'personal' ? LEGACY_KANBAN_FILE : path.join(storageDir(), 'kanban.json');
const roomBoards = new Map();
const STARTER_LABELS = [
  { name: 'Home', color: '#2E9E6B' },
  { name: 'Work', color: '#2F80ED' },
  { name: 'Health', color: '#E2699A' },
  { name: 'Errands', color: '#F5A524' },
  { name: 'Ideas', color: '#12A6B8' },
];
let legacyKb = { seq: 0, logStart: 0, log: [], state: emptyState() };
function currentBoard() {
  if (roomId() === 'personal') return legacyKb;
  if (!roomBoards.has(roomId())) {
    let board;
    try { board = JSON.parse(fs.readFileSync(kanbanFile(), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      board = { seq: 0, logStart: 0, log: [], state: emptyState(), fresh: true };
    }
    roomBoards.set(roomId(), board);
    if (board.fresh) {
      // v5 §9: a new room starts with five area labels (deletable), and nothing to migrate.
      delete board.fresh;
      board.notesV6 = new Date().toISOString();
      pushServer(diffLabels([], STARTER_LABELS.map((l) => ({ ...l, id: crypto.randomUUID() })), serverTs(), 'server'));
    }
    migrateNotes();
    migrateWorkflowBoard();
    migrateLinkedNotesBoard();
  }
  return roomBoards.get(roomId());
}

/**
 * Once per room (v6 engineer notes §3): Someday cards become notes; links and attachments become
 * markdown lines in the body, and `links` goes. Written as server actions, so every device syncs it.
 */
function migrateNotes() {
  const board = roomId() === 'personal' ? legacyKb : roomBoards.get(roomId());
  if (!board || board.notesV6) return;
  const ts = serverTs();
  const before = [];
  const after = [];
  for (const c of Object.values(board.state.cards)) {
    const m = migrateCard(c);
    if (!m) continue;
    before.push(c);
    after.push(m);
  }
  board.notesV6 = ts;
  if (after.length) pushServer(diffCards(before, after, ts, 'server'));
  else saveKanban();
  if (after.length) console.log(`[notes] room ${roomId()}: migrated ${after.length} card(s)`);
}
function migrateWorkflowBoard() {
  const board = roomId() === 'personal' ? legacyKb : roomBoards.get(roomId());
  if (!board) return;
  const ts = serverTs();
  const labels = Object.values(board.state.labels ?? {});
  const colors = diffLabels(labels, labels.map((label) => ({ ...label, color: WORKFLOW_LABELS.find((w) => w.id === label.id)?.color ?? label.color })), ts, 'server');
  if (colors.length) pushServer(colors);
  if (board.workflowV1) return;
  const before = Object.values(board.state.cards);
  const after = before.map(migrateWorkflow);
  board.workflowV1 = ts;
  pushServer([...diffLabels(Object.values(board.state.labels ?? {}), [...Object.values(board.state.labels ?? {}), ...WORKFLOW_LABELS.filter((l) => !board.state.labels?.[l.id])], ts, 'server'), ...before.flatMap((card, i) => diffCards([card], [after[i]], new Date(Date.parse(card.updatedAt || ts) + 1).toISOString(), 'server'))]);
  saveKanban();
}
function migrateLinkedNotesBoard() {
  const board = roomId() === 'personal' ? legacyKb : roomBoards.get(roomId());
  if (!board) return;
  const before = Object.values(board.state.cards);
  const actions = diffCards(before, migrateLinkedNotes(before), serverTs(), 'server');
  if (actions.length) pushServer(actions);
}
// Keep existing board operations bound to the request’s room, including queued writes.
const kb = new Proxy({}, {
  get: (_target, key) => currentBoard()[key],
  set: (_target, key, value) => { currentBoard()[key] = value; return true; },
  ownKeys: () => Reflect.ownKeys(currentBoard()),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});

function loadKanban() {
  try {
    const raw = JSON.parse(fs.readFileSync(kanbanFile(), 'utf8'));
    legacyKb = {
      seq: Number(raw.seq) || 0,
      logStart: Number(raw.logStart) || 0,
      log: Array.isArray(raw.log) ? raw.log : [],
      state: raw.state && raw.state.cards ? { labels: {}, lmeta: {}, ...raw.state } : emptyState(),
      ...(raw.notesV6 ? { notesV6: raw.notesV6 } : {}),
      ...(raw.workflowV1 ? { workflowV1: raw.workflowV1 } : {}),
      ...(raw.ai ? { ai: raw.ai } : {}),
    };
  } catch {
    legacyKb = { seq: 0, logStart: 0, log: [], state: emptyState() };
  }
}

function saveKanban() {
  fs.mkdirSync(path.dirname(kanbanFile()), { recursive: true });
  const tmp = kanbanFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(kb));
  fs.renameSync(tmp, kanbanFile());
}

loadKanban();

// In-process write mutex so concurrent sync requests don't clobber the file.
let writeQ = Promise.resolve();
function serialize(task) {
  const next = writeQ.then(task, task);
  writeQ = next.catch(() => {});
  return next;
}

const roomSeen = new Map();
function seenIds() {
  if (!roomSeen.has(roomId())) roomSeen.set(roomId(), new Set(kb.log.map((a) => a.id)));
  return roomSeen.get(roomId());
}

function isAction(a) {
  return a && typeof a === 'object' && typeof a.id === 'string' && typeof a.type === 'string' && typeof a.ts === 'string' && !Number.isNaN(Date.parse(a.ts)) && a.payload && typeof a.payload === 'object'; // ts orders every write: it must be a real time
}

/** Append + apply a batch; duplicates (same action id) are ignored (idempotent retries). */
function pushActions(deviceId, actions) {
  const before = JSON.parse(JSON.stringify(Object.values(kb.state.cards)));
  let applied = 0;
  for (const a of actions) {
    if (!isAction(a) || seenIds().has(a.id)) continue;
    const entry = { ...a, deviceId: String(a.deviceId ?? deviceId ?? ''), seq: ++kb.seq, at: Date.now() };
    // ts orders every write as a string: keep it canonical, and never more than a day ahead (no clock owns the future).
    if (deviceId !== 'server') entry.ts = new Date(Math.min(Date.parse(a.ts), Date.now() + 86400000)).toISOString();
    kb.log.push(entry);
    seenIds().add(a.id);
    applyAction(kb.state, entry);
    if (entry.type === 'card.put') {
      const card = kb.state.cards[entry.payload.card?.id];
      if (card && card.workflowVersion !== 1) {
        for (const action of diffCards([card], [migrateWorkflow(card)], new Date(Date.parse(entry.ts) + 1).toISOString(), 'server')) {
          const migration = { ...action, seq: ++kb.seq, at: Date.now() };
          kb.log.push(migration);
          seenIds().add(migration.id);
          applyAction(kb.state, migration);
        }
      }
    }
    applied++;
  }
  if (applied) {
    const cards = Object.values(kb.state.cards);
    const labels = Object.values(kb.state.labels ?? {});
    const ts = new Date(Math.max(Date.now(), ...kb.log.slice(-applied).map(a => Date.parse(a.ts))) + 1).toISOString();
    const grouped = cards.map(c => ({ ...c, labels: groupedLabels(c.labels ?? [], labels) }));
    const settled = reconcileBotReplyCards(reconcileSherlock(settleAutomations(grouped, labels, before, ts)));
    for (const a of diffCards(cards, settled, ts, 'server')) {
      const entry = { ...a, seq: ++kb.seq, at: Date.now() };
      kb.log.push(entry); seenIds().add(entry.id); applyAction(kb.state, entry);
    }
  }
  compact();
  saveKanban();
  if (applied) armReminderTimers(); // a new or moved reminder due before the next tick
  if (applied) scheduleNoteAI();
  return { cursor: kb.seq, applied };
}

function pullSince(since) {
  if (since < kb.logStart) {
    const snap = snapshot(kb.state);
    return { reset: true, cards: snap.cards, tombstones: snap.tombstones, labels: snap.labels, labelTombstones: snap.labelTombstones, actions: [], cursor: kb.seq };
  }
  return { actions: kb.log.filter((a) => a.seq > since), cursor: kb.seq };
}

function compact() {
  const now = new Date().toISOString();
  pruneTombstones(kb.state, now, KEEP_DAYS);
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  let drop = 0;
  // Compact on server receive time, never on device clocks.
  while (drop < kb.log.length && (kb.log[drop].at || 0) < cutoff) drop++;
  if (drop > 0) {
    for (const a of kb.log.slice(0, drop)) seenIds().delete(a.id);
    kb.log = kb.log.slice(drop);
    kb.logStart = kb.log.length ? kb.log[0].seq - 1 : kb.seq;
  }
}

// The personal connection is configured outside the repository, never returned to clients.
let sherlockConfig = null;
try { sherlockConfig = JSON.parse(fs.readFileSync(process.env.SHERLOCK_CONFIG || path.join(DATA_DIR, 'sherlock-config.json'), 'utf8')); } catch { /* Optional integration. */ }
const sherlockRooms = new Map();
const sherlockRoomAllowed = () => (sherlockConfig?.rooms || ['personal']).includes(roomId());
const sherlockAllowed = user => !!(user && sherlockConfig?.users?.includes(user) && sherlockRoomAllowed());
function sherlockForRoom() {
  const room = roomId();
  if (!sherlockRooms.has(room)) sherlockRooms.set(room, createSherlock({
    file: path.join(storageDir(), 'sherlock.json'), config: sherlockConfig ? { ...sherlockConfig, room } : null,
    getCard: id => kb.state.cards[id], getLabels: () => Object.values(kb.state.labels),
    commit: (id, change) => serialize(() => {
      const card = kb.state.cards[id];
      if (!card) return;
      const ts = serverTs(), labels = Object.values(kb.state.labels);
      const needed = [REPLY_LABEL, { id: 'sherlock', name: 'Sherlock', color: '#AC8BFA' }].filter(l => !kb.state.labels[l.id]);
      if (needed.length) pushServer(diffLabels(labels, [...labels, ...needed], ts, 'server'));
      const after = structuredClone(card);
      const wikiCapture = /^(wiki|sherlock):/.test(card.ext?.key || '');
      const importedCapture = change.imported && (wikiCapture || card.labels.includes('sherlock'));
      if (change.sent || importedCapture) {
        after.labels = [...new Set([...after.labels, 'sherlock'])];
        if (change.sent || (!card.archivedAt && card.labels.includes('workflow:todo'))) {
          after.workflowVersion = 1; after.archivedAt = null; after.labels = workflowLabels(after.labels, change.sent && wikiCapture ? 'doing' : 'todo');
        }
        after.ext = { ...after.ext, key: after.ext?.key || `todos:${id}`, slackChannel: change.channel, slackTs: change.ts };
      }
      if (change.engaged && wikiCapture && !card.archivedAt && card.status === 'todo') {
        after.workflowVersion = 1; after.labels = workflowLabels(after.labels, 'doing');
      }
      after.labels = after.labels.filter(l => l !== REPLY_LABEL.id);
      if (sherlockForRoom().unread(id)) after.labels.push(REPLY_LABEL.id);
      pushServer(diffCards([card], [after], serverTs(card.updatedAt), 'server'));
    }),
  }));
  return sherlockRooms.get(room);
}
function reconcileSherlock(cards) {
  const bridge = sherlockRooms.get(roomId()) || (sherlockConfig && sherlockRoomAllowed() ? sherlockForRoom() : null);
  if (!bridge) return cards;
  const tracked = new Set(bridge.tracked());
  return cards.map(c => {
    if (!tracked.has(c.id)) return c;
    const unread = bridge.unread(c.id), present = c.labels.includes(REPLY_LABEL.id);
    if (unread === present) return c;
    return { ...c, labels: unread ? [...c.labels, REPLY_LABEL.id] : c.labels.filter(id => id !== REPLY_LABEL.id) };
  });
}
function reconcileBotReplyCards(cards) {
  const label = botReplyLabel();
  if (!label) return cards;
  const conversations = botConversations();
  return cards.map(card => {
    const requests = conversations[card.id];
    if (!requests) return card;
    const unread = requests.some(request => request.reply && !request.seenAt);
    if (unread === card.labels.includes(label.id)) return card;
    return { ...card, labels: unread ? [...card.labels, label.id] : card.labels.filter(id => id !== label.id) };
  });
}

// --------------------------- note assistant (v5 §5, §6) ----------------------------------
// A short while after a change, the local model titles long untitled notes and suggests one label
// for Inbox notes. It writes only `title` (titleBy 'ai') and `suggestedLabel`; a failure changes nothing.
// kb.ai remembers what it did: t = body length when titled, l = label asked.
const NOTE_AI_MS = 2500;
const noteAiTimers = new Map();
function scheduleNoteAI() {
  if (process.env.TODOS_NOTE_AI === '0') return;
  const room = roomId();
  if (noteAiTimers.has(room)) return;
  noteAiTimers.set(room, setTimeout(() => {
    noteAiTimers.delete(room);
    void roomContext.run(room, () => runNoteAI().catch(() => {}));
  }, NOTE_AI_MS).unref());
}

/** The room owner's "Suggest titles and labels" (on unless turned off). */
function suggestOn() {
  const owner = roomId() === 'personal' ? TODOS_USER : accounts.room(roomId())?.owner;
  return accounts.user(owner)?.preferences?.suggest !== false;
}

let noteAiRunning = false;
async function runNoteAI() {
  if (noteAiRunning || !suggestOn()) return;
  noteAiRunning = true;
  try {
    kb.ai ??= { t: {}, l: {} };
    const memo = kb.ai;
    const cards = Object.values(kb.state.cards);
    for (const c of cards.filter((x) => needsTitle(x, memo.t[x.id])).slice(0, 3)) {
      let t;
      try { t = cleanTitle(await askNote(TITLE_PROMPT, noteText(c))); }
      catch { continue; } // the model is away: try again on the next change
      const now = kb.state.cards[c.id];
      memo.t[c.id] = stripMd(c.notes).length;
      if (!t || !now || now.notes !== c.notes || !needsTitle(now, undefined)) continue;
      await serialize(() => pushServer(diffCards([now], [{ ...now, title: t, titleBy: 'ai' }], serverTs(), 'server')));
    }
    const labels = Object.values(kb.state.labels ?? {}).filter((l) => l.id !== 'sherlock' && !l.id.startsWith('workflow:'));
    if (labels.length) {
      for (const c of cards.filter((x) => needsLabel(x, memo.l[x.id])).slice(0, 3)) {
        let id;
        try { id = pickLabel(await askNote(labelPrompt(labels), noteText(c)), labels); }
        catch { continue; }
        memo.l[c.id] = 1;
        const now = kb.state.cards[c.id];
        if (!id || !now || !needsLabel(now, 0)) continue;
        await serialize(() => pushServer(diffCards([now], [{ ...now, suggestedLabel: id }], serverTs(), 'server')));
      }
    }
    for (const id of Object.keys(memo.t)) if (!kb.state.cards[id]) delete memo.t[id];
    for (const id of Object.keys(memo.l)) if (!kb.state.cards[id]) delete memo.l[id];
    saveKanban();
  } finally {
    noteAiRunning = false;
  }
}

// --------------------------- external API -----------------------------------
// The external token is generated once and never logged.
function loadSecret(file) {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch {
    /* first start */
  }
  const t = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}
const EXTERNAL_TOKEN = loadSecret(EXTERNAL_TOKEN_FILE);

// --------------------------- reminders (ntfy) --------------------------------
// Every REMINDER_TICK_MS (15 s) and once on start (plus a precise timer for anything
// due before the next tick, re-armed after every write): a live, non-archived card whose
// remindAt has passed and has no remindedAt at/after it gets one ntfy push, then
// remindedAt goes through the action log. More than 12 h late: marked missed without a push.
// Someday cards are skipped (paused); see leaveRest() and the app's reducer for the missed rule.
// A card with remindEvery repeats: remindAt stays as the anchor the user set and the time due
// is the first slot after the last push (dueAt in shared/repeat.mjs, in this machine's time
// zone), so the server only ever writes remindedAt. It repeats until the card is Done, where it rests.
// A failing push is retried each tick, 5 attempts at most. The topic is a secret
// (ntfy.sh topics are public): NTFY_TOPIC, else data/ntfy-topic; never logged.
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const NTFY_TOPIC_FILE = path.join(DATA_DIR, 'ntfy-topic');
const NTFY_TOPIC = process.env.NTFY_TOPIC || loadTopic();
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const sendEmail = emailSender(process.env, APP_URL);
const REMINDER_TICK_MS = Number(process.env.REMINDER_TICK_MS) || 15000;
const REMINDER_LATE_MAX = 12 * 3600000;
const REMINDER_ATTEMPTS = 5;

function loadTopic() {
  try {
    const t = fs.readFileSync(NTFY_TOPIC_FILE, 'utf8').trim();
    if (t) return t;
  } catch {
    /* first start */
  }
  const t = 'todos-' + crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(NTFY_TOPIC_FILE, t + '\n', { mode: 0o600 });
  return t;
}

const STATUSES = ['todo', 'doing', 'done'];
const REPLACEABLE = ['title', 'notes']; // fields an update may overwrite when asked to
const isoOrNull = (v) => (v === null ? null : new Date(v).toISOString());
const HEX = /^#[0-9a-fA-F]{6}$/;
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
const clone = (v) => JSON.parse(JSON.stringify(v));

function isHttpUrl(v) {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Validate an external card body; returns an error string or null. `update` = targeting an existing card. */
function externalCardError(b, update = false) {
  if (!b || typeof b !== 'object') return 'body must be an object';
  const how = 'to update an existing card, target it with ?id=, ?key= or ?title=';
  if (!update && !nonEmpty(b.key)) return `key is required to create a card (a stable id you choose; the same key later updates it); ${how}`;
  if (!update && !nonEmpty(b.title)) return `title is required to create a card; ${how}`;
  if (update && b.replace?.includes('title') && !nonEmpty(b.title)) return 'title is required to replace it';
  if (update && b.title !== undefined && !(Array.isArray(b.replace) && b.replace.includes('title'))) return 'to rename a card send "replace": ["title"] with the new title (and "notes" in replace to change notes)';
  if (update && b.notes !== undefined && !(Array.isArray(b.replace) && b.replace.includes('notes'))) return 'to change notes send "replace": ["notes"] with them';
  if (b.someday !== undefined && typeof b.someday !== 'boolean') return 'someday must be true or false';
  if (b.notify !== undefined && typeof b.notify !== 'boolean') return 'notify must be true or false';
  for (const f of ['addLabels', 'removeLabels']) if (b[f] !== undefined && !Array.isArray(b[f])) return `${f} must be an array`;
  if (b.notes !== undefined && typeof b.notes !== 'string') return 'notes must be a string';
  if (b.status !== undefined && !STATUSES.includes(b.status)) return 'status must be todo, doing or done';
  if (b.kind !== undefined && !['note', 'todo'].includes(b.kind)) return 'kind must be note or todo';
  for (const f of ['slackTs', 'slackChannel']) if (b[f] !== undefined && typeof b[f] !== 'string') return `${f} must be a string`;
  if (b.links !== undefined) {
    if (!Array.isArray(b.links)) return 'links must be an array';
    for (const l of b.links) {
      if (!l || !isHttpUrl(l.url)) return 'each link needs an http(s) url';
      if (l.title !== undefined && typeof l.title !== 'string') return 'link title must be a string';
    }
  }
  if (b.remindAt !== undefined && b.remindAt !== null && (typeof b.remindAt !== 'string' || Number.isNaN(Date.parse(b.remindAt)))) return 'remindAt must be an ISO date-time or null';
  if (b.remindEvery !== undefined && b.remindEvery !== null && !REMIND_EVERY.includes(b.remindEvery)) return `remindEvery must be ${REMIND_EVERY.join(', ')} or null`;
  if (b.replace !== undefined) {
    if (!Array.isArray(b.replace)) return 'replace must be an array';
    for (const f of b.replace) if (!REPLACEABLE.includes(f)) return `replace accepts ${REPLACEABLE.join(', ')}`;
  }
  if (b.labels !== undefined) {
    if (!Array.isArray(b.labels)) return 'labels must be an array';
    for (const l of b.labels) {
      if (!l || !nonEmpty(l.id) || !nonEmpty(l.name) || !HEX.test(String(l.color))) return 'each label needs id, name and a #RRGGBB color';
    }
  }
  return null;
}

/** Live (non-deleted) card by ext key or Slack ts; `live` also skips archived. */
function findExternal({ key, slackTs }, live = false) {
  return Object.values(kb.state.cards).find((c) =>
    (!live || !c.archivedAt) &&
    ((nonEmpty(key) && c.ext?.key === key) || (nonEmpty(slackTs) && c.ext?.slackTs === slackTs)));
}

/**
 * The card an external call targets: ?id=, ?key= / slackTs, or an exact ?title= (any case; exact=1
 * makes it case-sensitive). Returns { card } or { error, status, ids? }.
 */
function findTarget({ id, key, slackTs, title, exact }, live = true) {
  const ok = (c) => c && (!live || !c.archivedAt);
  if (nonEmpty(id)) return ok(kb.state.cards[id]) ? { card: kb.state.cards[id] } : { error: 'not_found', status: 404 };
  if (nonEmpty(key) || nonEmpty(slackTs)) {
    const c = findExternal({ key, slackTs }, live);
    return c ? { card: c } : { error: 'not_found', status: 404 };
  }
  if (nonEmpty(title)) {
    const norm = (t) => (exact ? String(t).trim() : String(t).trim().toLowerCase());
    const hits = Object.values(kb.state.cards).filter((c) => ok(c) && norm(c.title) === norm(title));
    if (hits.length === 1) return { card: hits[0] };
    return hits.length ? { error: 'ambiguous_title', status: 409, ids: hits.map((c) => c.id) } : { error: 'not_found', status: 404 };
  }
  return { error: 'id, key or title is required', status: 400 };
}

/** Target fields from the query string (and body.id / body.key where a body exists). */
function targetOf(url, body = {}) {
  const q = (k) => url.searchParams.get(k) ?? undefined;
  return { id: q('id') ?? body.id, key: q('key') ?? body.key, slackTs: q('slackTs') ?? body.slackTs, title: q('title'), exact: q('exact') === '1' };
}

const LABEL_COLORS = ['#7C5CFF', '#2E9E6B', '#E0662F', '#2F80ED', '#D6336C', '#B08900'];

/** addLabels / removeLabels entries: a label id, a name (any case) or { id, name, color }. Unknown names are created. */
function resolveLabelRefs(refs, create, actions, ts) {
  const out = [];
  // Labels made earlier in this same call count as known.
  const labels = () => [...Object.values(kb.state.labels ?? {}), ...actions.filter((a) => a.type === 'label.put').map((a) => a.payload.label)];
  for (const r of refs ?? []) {
    if (r && typeof r === 'object') {
      if (!labels().some((l) => l.id === r.id) && create) actions.push(...diffLabels([], [{ id: r.id, name: String(r.name).trim().slice(0, 40), color: r.color }], ts, 'server'));
      out.push(r.id);
      continue;
    }
    const s = String(r ?? '').trim();
    if (!s) continue;
    const hit = labels().find((l) => l.id === s) ?? labels().find((l) => l.name.toLowerCase() === s.toLowerCase());
    if (hit) out.push(hit.id);
    else if (create) {
      const l = { id: crypto.randomUUID(), name: s.slice(0, 40), color: LABEL_COLORS.find((color) => !labels().some((label) => label.color.toUpperCase() === color.toUpperCase())) ?? LABEL_COLORS[labels().length % LABEL_COLORS.length] };
      actions.push(...diffLabels([], [l], ts, 'server'));
      out.push(l.id);
    }
  }
  return out;
}

/** Back from resting (Someday; a repeating reminder also Done) after the time passed: never sent late. Mirrors the app's missedOnLeave. */
function leaveRest(card, ts) {
  const stamp = restStamp(card, ts); // one-off: missed; repeating: handled through now
  if (stamp !== undefined) card.remindedAt = stamp;
}

/** Park / un-park the way the app does: parking moves the card to To do; leaving after a reminder's time marks it missed. */
function applySomeday(after, on, ts) {
  if (on) {
    if (after.status !== 'todo') {
      after.items.forEach((i) => { i.done = false; });
      after.status = 'todo';
      const orders = columnOrders('todo');
      after.order = Math.max(orders.length ? Math.max(...orders) + 1 : -Infinity, Date.now() / 1000);
    }
    after.someday = true;
  } else if (after.someday) {
    after.someday = false;
    leaveRest(after, ts);
  }
}

/** Mirror of §6 derivation for a card the server edits before diffing it. */
function settle(card, ts) {
  if (card.workflowVersion === 1) {
    if (card.status !== 'todo') card.someday = false;
    return;
  }
  if (card.items.length) {
    const done = card.items.filter((i) => i.done).length;
    if (done === card.items.length) card.status = 'done';
    else if (done > 0) card.status = 'doing';
    else if (card.status === 'done') card.status = 'todo';
  }
  if (card.status === 'done') card.completedAt ||= ts;
  else card.completedAt = null;
  if (card.status !== 'todo' && card.someday) {
    card.someday = false;
    leaveRest(card, ts); // same rule as the app: never sent late
  }
  card.updatedAt = ts;
}

function columnOrders(status) {
  return Object.values(kb.state.cards).filter((c) => c.status === status && !c.archivedAt).map((c) => c.order);
}

// Server writes share one device id, so LWW needs strictly increasing timestamps:
// two writes in the same millisecond would otherwise tie and the second would be lost.
let lastServerMs = 0;
function serverTs(after = null) {
  lastServerMs = Math.max(Date.now(), lastServerMs + 1, (Date.parse(after) || 0) + 1);
  return new Date(lastServerMs).toISOString();
}

/** Stamp actions made by the server itself and push them through the log. */
function pushServer(actions) {
  if (actions.length) pushActions('server', actions);
}

function externalCard(b, target = null) {
  const ts = serverTs();
  const actions = [];
  // Labels: create only the missing ones; user renames/recolors stay.
  const missing = (b.labels ?? []).filter((l) => !kb.state.labels?.[l.id]).map((l) => ({ id: l.id, name: l.name.trim().slice(0, 40), color: l.color }));
  actions.push(...diffLabels([], missing, ts, 'server'));
  const links = [];
  for (const l of b.links ?? []) if (!links.some((x) => x.url === l.url)) links.push({ title: String(l.title ?? '').slice(0, 200), url: l.url });

  const existing = target ?? findExternal({ key: b.key });
  if (existing) {
    const after = clone(existing);
    // Only urls never delivered before: a link the user removed (its line deleted) stays removed.
    const have = cardLinks(existing);
    const seen = new Set(existing.ext?.seenLinks ?? have.map((l) => l.url));
    const fresh = links.filter((l) => !seen.has(l.url) && !have.some((x) => x.url === l.url));
    // A card without an ext key (made in the app) gets none: the app drops an ext without a key.
    if (nonEmpty(b.key) || existing.ext?.key) after.ext = { ...after.ext, key: existing.ext?.key ?? b.key, seenLinks: [...new Set([...seen, ...links.map((l) => l.url)])] };
    const add = resolveLabelRefs(b.addLabels, true, actions, ts);
    const drop = new Set(resolveLabelRefs(b.removeLabels, false, actions, ts));
    after.labels = [...new Set([...(after.labels ?? []), ...add])].filter((id) => !drop.has(id));
    if (b.someday !== undefined) applySomeday(after, b.someday, ts);
    if (b.notify !== undefined) after.notify = b.notify;
    if (b.replace?.includes('title')) after.title = b.title.trim().replace(/\s*\n\s*/g, ' ').slice(0, 200);
    if (b.replace?.includes('notes')) {
      // New notes keep the delivered link lines the old body still had.
      const kept = bodyLinks(existing.notes).filter((l) => seen.has(l.url) && !String(b.notes ?? '').includes(l.url));
      after.notes = withLinkLines(b.notes, kept);
    }
    after.notes = withLinkLines(after.notes, fresh).slice(0, 5000);
    if (b.remindAt !== undefined) {
      const r = isoOrNull(b.remindAt);
      if (r !== (existing.remindAt ?? null)) {
        after.remindAt = r;
        after.remindedAt = null; // a new time is a new reminder
        if (!existing.remindAt && after.remindEvery) after.remindEvery = null; // ...and starts as once
      }
    }
    if (b.remindEvery !== undefined && b.remindEvery !== (existing.remindEvery ?? null)) {
      if (b.remindEvery && !after.remindAt) return { error: 'remindEvery needs a reminder time: send remindAt too', status: 400 };
      // As in the app: back to once keeps the upcoming slot as a single reminder.
      if (!b.remindEvery && repeats(existing) && after.remindAt && after.remindAt === existing.remindAt) {
        after.remindAt = onceAt(existing, Date.parse(ts));
        after.remindedAt = null;
      }
      after.remindEvery = b.remindEvery;
    }
    if (!after.remindAt && after.remindEvery) after.remindEvery = null; // no time, nothing to repeat
    if (after.ext && b.slackTs !== undefined) after.ext.slackTs = b.slackTs;
    if (after.ext && b.slackChannel !== undefined) after.ext.slackChannel = b.slackChannel;
    actions.push(...diffCards([existing], [after], ts, 'server'));
    pushServer(actions);
    return { ok: true, id: existing.id, created: false };
  }

  if (b.remindEvery && !b.remindAt) return { error: 'remindEvery needs a reminder time: send remindAt too', status: 400 };
  const status = b.status ?? 'todo';
  const orders = columnOrders(status);
  const ext = { key: b.key, seenLinks: links.map((l) => l.url) };
  if (b.slackTs !== undefined) ext.slackTs = b.slackTs;
  if (b.slackChannel !== undefined) ext.slackChannel = b.slackChannel;
  const card = {
    id: crypto.randomUUID(),
    title: b.title.trim().replace(/\s*\n\s*/g, ' ').slice(0, 200),
    notes: withLinkLines(b.notes ?? '', links).slice(0, 5000),
    status,
    ...(b.kind ? { kind: b.kind } : {}),
    // Time-derived, so it tops cards the server has never seen (a device's Welcome at 0) everywhere.
    order: Math.min(orders.length ? Math.min(...orders) - 1 : Infinity, -Date.now() / 1000),
    items: [],
    createdAt: ts,
    updatedAt: ts,
    completedAt: status === 'done' ? ts : null,
    archivedAt: null,
    someday: false,
    repeat: false,
    labels: [...new Set([...(b.labels ?? []).map((l) => l.id), ...resolveLabelRefs(b.addLabels, true, actions, ts)])],
    ext,
    remindAt: b.remindAt === undefined ? null : isoOrNull(b.remindAt),
    remindedAt: null,
    ...(b.notify !== undefined ? { notify: b.notify } : {}),
  };
  if (b.remindEvery && card.remindAt) card.remindEvery = b.remindEvery;
  if (b.someday === true) applySomeday(card, true, ts);
  actions.push(...diffCards([], [card], ts, 'server'));
  pushServer(actions);
  return { ok: true, id: card.id, created: true };
}

/** Moving a note changes its workflow label and keeps checklist progress. */
function externalStatus(b, card) {
  if ((card.workflowVersion === 1 ? workflowStatus(card) : card.status) === b.status) return { ok: true, id: card.id, changed: false };
  const ts = serverTs();
  const after = clone(card);
  if (after.workflowVersion !== 1 && after.items.length && b.status === 'doing' && after.items.every((i) => i.done)) return { error: 'list_complete' };
  if (after.workflowVersion !== 1 && after.items.length && b.status === 'done') after.items.forEach((i) => { i.done = true; });
  if (after.workflowVersion !== 1 && after.items.length && b.status === 'todo') after.items.forEach((i) => { i.done = false; });
  after.status = b.status;
  if (after.workflowVersion === 1) after.labels = workflowLabels(after.labels, b.status);
  // Arriving in a column appends at the bottom, as in the app, below local-only cards too.
  const orders = columnOrders(b.status);
  after.order = Math.max(orders.length ? Math.max(...orders) + 1 : -Infinity, Date.now() / 1000);
  settle(after, ts);
  if (remindResting(card) && !remindResting(after)) leaveRest(after, ts); // a repeating reminder resumes on leaving Done
  pushServer(diffCards([card], [after], ts, 'server'));
  return { ok: true, id: card.id, changed: true };
}

/** ntfy JSON publishing (POST to the server root): any title, and URLs with "," or ";" survive. */
async function sendNtfy({ title, body, click, link }) {
  const msg = { topic: roomTopic(), title, message: body, tags: ['alarm_clock'], priority: 4 };
  if (click) msg.click = click;
  if (link) msg.actions = [{ action: 'view', label: 'Open link', url: link }];
  const res = await fetch(`${NTFY_SERVER}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
}

// Precise delivery: one timer per reminder due before the next tick.
const reminderTimers = new Map(); // `${id}|${due}` -> timeout
/** The time a live card's reminder is waiting for (ms), or null: none, archived, resting or already sent. */
function pendingDue(c) {
  if (!c.remindAt || c.notify === false || c.archivedAt || remindResting(c)) return null; // paused while in Someday (repeating: also Done)
  const due = dueAt(c);
  const at = due ? Date.parse(due) : NaN;
  if (Number.isNaN(at)) return null;
  if (!repeats(c) && c.remindedAt && Date.parse(c.remindedAt) >= at) return null; // a one-off already sent or missed
  return at;
}

function armReminderTimers() {
  const now = Date.now();
  for (const c of Object.values(kb.state.cards)) {
    let at = null;
    try {
      at = pendingDue(c);
    } catch {
      /* a card with an unusable time never blocks the others */
    }
    if (at === null || at <= now || at - now > REMINDER_TICK_MS) continue;
    const key = `${roomId()}|${c.id}|${at}`;
    if (reminderTimers.has(key)) continue;
    const t = setTimeout(() => {
      reminderTimers.delete(key);
      void checkReminders();
    }, at - now + 25);
    t.unref?.();
    reminderTimers.set(key, t);
  }
}

const reminderAttempts = new Map(); // `${id}|${due}` -> failed attempts
const remindersInFlight = new Set();
const remindersSettled = new Set(); // `${id}|${due}` sent (or given up) while its stamp has not landed: never pushed twice

// One-off: remindedAt === remindAt means "passed without a push" (missed); a sent one is stamped strictly after.
// Repeating: any stamp means "handled through then", and the next slot after it is due next.
function markReminded(id, at, missed = false) {
  const cur = kb.state.cards[id];
  if (!cur || pendingDue(cur) !== at) return; // changed meanwhile: the new time is armed
  lastServerMs = Math.max(lastServerMs, at);
  const ts = serverTs();
  const actions = diffCards([cur], [{ ...clone(cur), remindedAt: missed && !repeats(cur) ? cur.remindAt : ts }], ts, 'server');
  // A device with a fast clock may hold remindedAt with a later timestamp: the stamp must still win.
  const held = Date.parse(kb.state.meta?.[id]?.f?.remindedAt?.ts ?? '');
  if (held >= Date.parse(ts) && held < 8.64e15) for (const a of actions) a.ts = new Date(held + 1).toISOString();
  pushServer(actions);
  if (!kb.state.cards[id] || pendingDue(kb.state.cards[id]) !== at) remindersSettled.delete(`${roomId()}|${id}|${at}`); // stamped: the next slot is armed
}

const checkingReminders = new Set();
const recheckReminders = new Set();
async function checkReminders() {
  if (checkingReminders.has(roomId())) {
    recheckReminders.add(roomId()); // a timer fired mid-run: run once more when this one ends
    return;
  }
  checkingReminders.add(roomId());
  try {
    const now = Date.now();
    for (const c of Object.values(kb.state.cards)) {
      try {
        const due = pendingDue(c);
        if (due === null || due > now) continue;
        const key = `${roomId()}|${c.id}|${due}`;
        if (remindersInFlight.has(key) || remindersSettled.has(key)) continue;
        // After an outage a repeating reminder is judged by its latest slot, not the oldest one missed.
        const at = repeats(c) ? (lastSlot(c.remindAt, c.remindEvery, now) ?? due) : due;
        // Too late to be useful, or an hourly one that would now land in the quiet hours: handled without a push.
        const asleep = c.remindEvery === 'hour' && quiet(now) && now - at > 60000; // on time, only the chosen first time can fall in the night
        if (now - at > REMINDER_LATE_MAX || asleep) {
          remindersSettled.add(key);
          await serialize(() => markReminded(c.id, due, true));
          continue;
        }
        remindersInFlight.add(key);
        try {
          await sendNtfy({
            title: c.title || 'Reminder',
            body: String(c.notes || '').split('\n').map((l) => l.trim()).find(Boolean) || 'Reminder',
            click: `${APP_URL}/${roomId() === 'personal' ? '' : `?room=${encodeURIComponent(roomId())}`}#card/${encodeURIComponent(c.id)}`,
            link: c.links?.[0]?.url,
          });
          reminderAttempts.delete(key);
          remindersSettled.add(key); // sent: whatever happens to the stamp, never again for this slot
        } catch (e) {
          const n = (reminderAttempts.get(key) || 0) + 1;
          reminderAttempts.set(key, n);
          if (n >= REMINDER_ATTEMPTS) {
            console.error(`reminder for card ${c.id} failed ${n} times, giving up: ${e.message}`);
            reminderAttempts.delete(key);
            remindersSettled.add(key);
          }
        } finally {
          remindersInFlight.delete(key);
        }
        if (remindersSettled.has(key)) await serialize(() => markReminded(c.id, due));
      } catch (e) {
        console.error(`reminder check for card ${c.id} failed: ${e.message}`); // one bad card never stops the rest
      }
    }
  } catch (e) {
    console.error(`reminder check failed: ${e.message}`);
  } finally {
    checkingReminders.delete(roomId());
    armReminderTimers();
    if (recheckReminders.has(roomId())) {
      recheckReminders.delete(roomId());
      void checkReminders();
    }
  }
}

// --------------------------- attachments (files) -----------------------------
// Blobs live in DATA_DIR/files/<id> with a JSON sidecar <id>.json ({ id, name, type, size,
// createdAt }) and an optional client-made thumbnail <id>.thumb (+ thumbType in the sidecar).
// Ids are random (or the client's X-File-Id, so a retried upload is idempotent) and never
// reused, so an ETag never changes meaning. Behind the same auth as everything else.
const filesDir = () => path.join(storageDir(), 'files');
const FILE_MAX = Number(process.env.FILE_MAX_BYTES) || 25 * 1024 * 1024;
const THUMB_MAX = 2 * 1024 * 1024;
const FILES_QUOTA_WARN = Number(process.env.FILES_QUOTA_WARN_BYTES) || 5 * 1024 ** 3;
const FILE_GC_DAYS = 30;
const FILE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const EXT_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', zip: 'application/zip', mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

const fileBlob = (id) => path.join(filesDir(), id);
const fileSide = (id) => path.join(filesDir(), id + '.json');

function readSidecar(id) {
  if (!FILE_ID.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(fileSide(id), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * A header name as sent: Node reads header bytes as latin1, so raw UTF-8 (curl) is re-decoded when
 * it is valid UTF-8. Percent-escapes are decoded only when the client says so (X-Filename-Encoding:
 * percent, as the app does), so "100%20off.png" stays literal.
 */
function headerFileName(req) {
  const h = req.headers['x-filename'];
  if (h === undefined) return undefined;
  let v = String(h);
  if (/[\x80-\xff]/.test(v)) {
    try {
      v = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(v, 'latin1'));
    } catch {
      /* not UTF-8: keep latin1 */
    }
  }
  if (String(req.headers['x-filename-encoding'] || '').toLowerCase() === 'percent') {
    try {
      v = decodeURIComponent(v);
    } catch {
      /* malformed: keep as sent */
    }
  }
  return v;
}

function cleanFileName(n) {
  let v = String(n ?? '');
  // eslint-disable-next-line no-control-regex
  v = v.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop().trim().slice(0, 200);
  return v || 'file';
}

// Types that say nothing about the file: curl --data-binary sends a form type by default.
const NOT_A_FILE_TYPE = new Set(['', 'application/octet-stream', 'application/x-www-form-urlencoded', 'multipart/form-data', 'binary/octet-stream']);

/** The declared type unless it is generic; then the extension, then the first bytes. */
function fileType(declared, name, buf) {
  const t = String(declared ?? '').split(';')[0].trim().toLowerCase();
  if (!NOT_A_FILE_TYPE.has(t) && /^[\w.+-]+\/[\w.+-]+$/.test(t)) return t;
  const ext = name.includes('.') ? name.toLowerCase().split('.').pop() : '';
  if (EXT_TYPES[ext]) return EXT_TYPES[ext];
  const head = buf.subarray(0, 12);
  if (head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return 'application/octet-stream';
}

/** The whole body, or { tooLarge } past `max` (the rest is drained, never stored). */
function readRaw(req, max) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) over = true;
      if (!over) chunks.push(c);
    });
    req.on('end', () => resolve(over ? { tooLarge: true } : { buf: Buffer.concat(chunks) }));
    req.on('error', () => resolve({ buf: Buffer.alloc(0) }));
  });
}

/** The first file part of a multipart/form-data body (+ an optional "name" field). */
function parseMultipart(buf, ctype) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
  if (!m) return null;
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  let file = null;
  let name = null;
  let pos = buf.indexOf(boundary);
  while (pos >= 0) {
    const start = pos + boundary.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const headEnd = buf.indexOf('\r\n\r\n', start);
    if (headEnd < 0) break;
    const head = buf.slice(start, headEnd).toString('utf8');
    const next = buf.indexOf(boundary, headEnd + 4);
    if (next < 0) break;
    const body = buf.slice(headEnd + 4, next - 2); // strip the CRLF before the boundary
    const field = /name="([^"]*)"/i.exec(head)?.[1];
    const fname = /filename\*?=(?:UTF-8'')?"?([^";\r\n]*)"?/i.exec(head)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1];
    if (fname !== undefined && !file) file = { buf: body, name: fname, type };
    else if (field === 'name') name = body.toString('utf8');
    pos = next;
  }
  return file ? { ...file, name: name ?? file.name } : null;
}

/**
 * Receive one upload (raw body + Content-Type + X-Filename, or multipart/form-data) and store it.
 * Returns { meta } or { status, error }.
 */
async function receiveFile(req, url) {
  const len = Number(req.headers['content-length']);
  const ctype = String(req.headers['content-type'] || '');
  const multipart = /^multipart\/form-data/i.test(ctype);
  const limit = FILE_MAX + (multipart ? 64 * 1024 : 0);
  if (len > limit) {
    req.resume();
    return { status: 413, error: 'file_too_large' };
  }
  const got = await readRaw(req, limit);
  if (got.tooLarge) return { status: 413, error: 'file_too_large' };
  let buf = got.buf;
  let name = headerFileName(req) ?? url.searchParams.get('name');
  let type = ctype;
  if (multipart) {
    const part = parseMultipart(buf, ctype);
    if (!part) return { status: 400, error: 'multipart body needs a file part' };
    buf = part.buf;
    name = url.searchParams.get('name') ?? part.name;
    type = part.type;
  }
  if (buf.length > FILE_MAX) return { status: 413, error: 'file_too_large' };
  const clean = cleanFileName(name);
  const want = String(req.headers['x-file-id'] || '');
  const id = FILE_ID.test(want) ? want : crypto.randomUUID();
  const prior = readSidecar(id);
  if (prior) return prior.size === buf.length ? { meta: prior } : { status: 409, error: 'file_id_taken' };
  const meta = { id, name: clean, type: fileType(type, clean, buf), size: buf.length, createdAt: new Date().toISOString() };
  fs.mkdirSync(filesDir(), { recursive: true });
  fs.writeFileSync(fileBlob(id) + '.tmp', buf);
  fs.renameSync(fileBlob(id) + '.tmp', fileBlob(id));
  fs.writeFileSync(fileSide(id), JSON.stringify(meta));
  return { meta };
}

const fileUrl = (id) => `/kanban/files/${id}`;
/** RFC 5987 attr-chars: encodeURIComponent leaves ' ( ) * which filename* must escape. */
const rfc5987 = (s) => encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const fileJson = (m) => ({ id: m.id, name: m.name, type: m.type, size: m.size, url: fileUrl(m.id) });
/** The attachment record a card carries for an uploaded file. */
const attachmentOf = (m) => ({ id: m.id, name: m.name, type: m.type, size: m.size, createdAt: m.createdAt, ...(m.thumbType ? { thumb: true } : {}) });

/** Stream a stored file (or its thumb) with safe headers; 304 on a matching ETag. */
function sendStored(req, res, meta, thumb) {
  const file = thumb ? fileBlob(meta.id) + '.thumb' : fileBlob(meta.id);
  if (!fs.existsSync(file)) return false;
  const type = thumb ? meta.thumbType : meta.type;
  const etag = `"${meta.id}${thumb ? '-t' : ''}"`;
  const inline = type.startsWith('image/') || type === 'application/pdf';
  const headers = {
    etag,
    // Revalidated every time (a cheap 304) so the browser's HTTP cache never outlives the session;
    // offline viewing is the service worker's job (public/sw-files.js).
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${meta.name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${rfc5987(meta.name)}`,
  };
  // Nothing uploaded may run script in the app's origin (an SVG or HTML opened directly); PDFs need the viewer.
  if (type !== 'application/pdf') headers['content-security-policy'] = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, { ...headers, 'content-type': type, 'content-length': fs.statSync(file).size });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(file).pipe(res);
  return true;
}

/**
 * Collect files no card has referenced for FILE_GC_DAYS: never attached (by their upload time),
 * or detached / their card deleted (by that tombstone). Logs a warning past the quota.
 */
function collectFiles() {
  let names;
  try {
    names = fs.readdirSync(filesDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  const live = new Set();
  const ended = new Map(); // file id -> when its last reference ended
  for (const c of Object.values(kb.state.cards)) for (const a of c.attachments ?? []) live.add(a.id);
  for (const [cid, m] of Object.entries(kb.state.meta)) {
    for (const [aid, am] of Object.entries(m.att ?? {})) {
      const end = [am.x?.ts, kb.state.cards[cid] ? null : m.deleted].filter(Boolean).sort().pop();
      if (end && (!ended.has(aid) || end > ended.get(aid))) ended.set(aid, end);
    }
  }
  const cutoff = Date.now() - FILE_GC_DAYS * 86400000;
  let total = 0;
  for (const f of names) {
    const id = f.slice(0, -5);
    const meta = readSidecar(id);
    if (!meta) continue;
    const since = ended.get(id) ?? meta.createdAt;
    if (!live.has(id) && Date.parse(since) < cutoff) {
      for (const x of [fileBlob(id), fileBlob(id) + '.thumb', fileSide(id)]) fs.rmSync(x, { force: true });
      continue;
    }
    total += meta.size || 0;
  }
  if (total > FILES_QUOTA_WARN) console.warn(`attachments use ${(total / 1024 ** 3).toFixed(2)} GB (warning above ${(FILES_QUOTA_WARN / 1024 ** 3).toFixed(2)} GB)`);
}

/** Attach a stored file to a card through the action log (device "server"). */
function attachToCard(card, meta) {
  const ts = serverTs();
  const after = clone(card);
  after.attachments = [...(after.attachments ?? []).filter((a) => a.id !== meta.id), attachmentOf(meta)];
  pushServer(diffCards([card], [after], ts, 'server'));
}

const labelNames = (ids) => (ids ?? []).map((id) => kb.state.labels?.[id]?.name).filter(Boolean);
const withUrls = (atts) => (atts ?? []).map((a) => ({ ...a, url: fileUrl(a.id) }));

/** Links live in the markdown body now (v6); the API still lists them as { title, url }. */
const cardLinks = (c) => [...(c.links ?? []), ...bodyLinks(c.notes)].filter((l, i, all) => all.findIndex((x) => x.url === l.url) === i);
/** Brackets, parentheses and spaces escaped, so a title or URL cannot break out of the link. */
const mdUrl = (u) => String(u).replace(/[()\s<>]/g, (c) => encodeURIComponent(c));
const mdTitle = (t) => String(t).replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
const linkLine = (l) => `[${mdTitle(l.title || hostOf(l.url))}](${mdUrl(l.url)})`;
/** Append markdown link lines to a body (a blank line before the first). */
function withLinkLines(notes, links) {
  const body = String(notes ?? '').replace(/\s+$/, '');
  if (!links.length) return String(notes ?? '');
  // Under a block of link lines, the next one joins it; under prose, a blank line first.
  const sep = !body ? '' : /^\[[^\]]*\]\(https?:[^)]*\)$/.test(body.split('\n').pop()) ? '\n' : '\n\n';
  return body + sep + links.map(linkLine).join('\n');
}

/** A card as agents see it (GET card): labels are ids (the capture contract) plus labelNames; attachments carry urls. */
function agentCard(c) {
  return { ...c, title: displayTitle(c), links: cardLinks(c), labelNames: labelNames(c.labels), attachments: withUrls(c.attachments), ...(repeats(c) && !remindResting(c) ? { remindNext: dueAt(c) } : {}) };
}

/** Compact rows for agents, in the same shapes as GET card: enough to find a card and act on it. */
function compactCard(c) {
  const row = { id: c.id, title: displayTitle(c), status: c.status, someday: !!c.someday, labels: [...(c.labels ?? [])], labelNames: labelNames(c.labels), remindAt: c.remindAt ?? null, remindEvery: c.remindEvery ?? null, links: cardLinks(c), attachments: withUrls(c.attachments) };
  if (c.kind === 'note') { row.kind = 'note'; row.done = !!c.done; }
  if (c.ext?.key) row.key = c.ext.key;
  if (c.archivedAt) row.archivedAt = c.archivedAt;
  if (repeats(c) && !remindResting(c)) row.remindNext = dueAt(c);
  return row;
}

function listCards(url) {
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const status = url.searchParams.get('status');
  const label = (url.searchParams.get('label') || '').trim().toLowerCase();
  const archived = url.searchParams.get('archived') === '1';
  const labelId = label ? Object.values(kb.state.labels ?? {}).find((l) => l.id === label || l.name.toLowerCase() === label)?.id ?? '\0' : null;
  return Object.values(kb.state.cards)
    .filter((c) => (archived || !c.archivedAt) && (!status || c.status === status) && (!labelId || c.labels?.includes(labelId)))
    .filter((c) => !q || [c.title, c.notes, ...c.items.map((i) => i.text)].join('\n').toLowerCase().includes(q))
    .sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || Number(!!a.someday) - Number(!!b.someday) || a.order - b.order)
    .map(compactCard);
}

// --------------------------- Siri capture -----------------------------------
// POST /kanban/capture with a per-user token (Settings → Siri) adds a card to that user's personal
// room: the dictated title (a spoken time inside it becomes the reminder), optional checklist items.
const CAPTURE_WINDOW = 10 * 60 * 1000;
const CAPTURE_MAX = 60; // cards per user per window: a lost phone cannot flood the board
const captures = new Map();

/** Siri and the share sheet file a note in Inbox; a spoken time makes it a to do (v5 §8). */
function captureCard({ title, items, notes, remindAt, via, titleBy = 'ai' }) {
  const ts = serverTs();
  const orders = columnOrders('todo');
  const card = {
    id: crypto.randomUUID(),
    title,
    notes,
    status: 'todo',
    order: Math.min(orders.length ? Math.min(...orders) - 1 : Infinity, -Date.now() / 1000),
    items: items.map((text) => ({ id: crypto.randomUUID(), text, done: false })),
    labels: [],
    createdAt: ts,
    updatedAt: ts,
    completedAt: null,
    archivedAt: null,
    someday: false,
    repeat: false,
    remindAt,
    remindedAt: null,
    titleBy,
    via,
  };
  if (!remindAt) card.kind = 'note';
  pushServer(diffCards([], [card], ts, 'server'));
  return card;
}

async function captureRoute(req, url, json, text) {
  if (req.method !== 'POST') return json({ error: 'not_found', path: url.pathname }, 404);
  if (limited(req, 'capture')) return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  const bearer = String(req.headers['authorization'] || '');
  const user = bearer.startsWith('Bearer ') ? accounts.shortcutUser(bearer.slice(7)) : null;
  if (!user) {
    recordFailure(req, 'capture');
    return json({ error: 'This shortcut is no longer connected. Open Todos → Settings → Siri and install it again.' }, 401);
  }
  const { body, error } = await readJson(req);
  if (error) return json({ error }, 400);
  if (!body || typeof body !== 'object') return json({ error: 'body must be an object' }, 400);
  const now = Date.now();
  const recent = (captures.get(user) || []).filter((t) => now - t < CAPTURE_WINDOW);
  if (recent.length >= CAPTURE_MAX) return json({ error: 'Too many todos in a short time. Try again later.' }, 429);
  captures.set(user, [...recent, now]);
  // Siri reads the reply aloud, so a problem is a sentence with 200 too; API callers get the status.
  const spoken = /text\/plain/.test(String(req.headers['accept'] || ''));
  const fail = (message, status) => (spoken ? text(message) : json({ error: message }, status));
  roomContext.enterWith(accounts.user(user)?.personalRoom || 'personal');

  let result;
  if (typeof body.say === 'string') result = await captureSpoken(body);
  else if (typeof body.url === 'string' || (typeof body.text === 'string' && body.title === undefined)) result = await captureShared(body);
  else {
    const parsed = parseCapture(body);
    if (parsed.error) return fail(parsed.error, 400);
    parsed.items = await captureItems(body.items ?? '', splitDictation);
    const card = await serialize(() => captureCard({ ...parsed, via: 'siri', titleBy: 'user' }));
    result = { ok: true, id: card.id, title: card.title, items: parsed.items, remindAt: parsed.remindAt, said: sayCapture(parsed) };
  }
  if (result.error) return fail(result.error, result.status || 400);
  return spoken ? text(result.said) : json(result);
}

/** One sentence from Siri: understood against the user's cards, then applied. */
async function captureSpoken(body) {
  const offset = offsetOf(body.now);
  const deviceNow = Date.parse(String(body.now ?? ''));
  const at = Number.isNaN(deviceNow) || Math.abs(deviceNow - Date.now()) > 86400000 ? Date.now() : deviceNow;
  // Untitled notes are known by their first line, as everywhere else.
  const cards = Object.values(kb.state.cards).filter((c) => !c.archivedAt).sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.order - b.order).map((c) => (c.title ? c : { ...c, title: displayTitle(c) }));
  const { intent, remindAt, error } = await understand(body.say, cards, askModel, { now: at, offset });
  if (error) return { error, status: 400 };
  // Items dictated after Siri asked "Which items for …?" arrive with the same sentence.
  if (typeof body.items === 'string' && body.items.trim() && (intent.action === 'create' || intent.action === 'add_items')) intent.items = await captureItems(body.items, splitDictation);
  if (intent.needsItems && !intent.items.length) {
    const name = intent.action === 'create' ? intent.title : intent.card.title;
    return { ok: true, ask: 'items', title: name, said: `Which items for “${name}”?` };
  }
  const when = (iso) => sayCapture({ title: '', remindAt: iso, offset }).replace(/^Added “”\. Reminder /, '').replace(/\.$/, '');
  return serialize(() => {
    if (intent.action === 'create') {
      const card = captureCard({ title: intent.title, items: intent.items, notes: '', remindAt, via: 'siri' });
      return { ok: true, id: card.id, action: 'create', title: card.title, items: intent.items, remindAt, said: sayCapture({ title: card.title, items: intent.items, remindAt, offset }) };
    }
    const existing = kb.state.cards[intent.card.id];
    if (!existing) return { error: 'That card is gone.', status: 404 };
    const after = clone(existing);
    let said;
    if (intent.action === 'add_items') {
      const fresh = intent.items.filter((i) => !after.items.some((x) => x.text.toLowerCase() === i.toLowerCase()));
      after.items.push(...fresh.map((text) => ({ id: crypto.randomUUID(), text, done: false })));
      if (after.status === 'done' && fresh.length) after.status = 'todo';
      if (after.kind === 'note' && after.done && fresh.length) { after.done = false; after.completedAt = null; }
      said = fresh.length ? `Added ${fresh.length} item${fresh.length === 1 ? '' : 's'} to “${existing.title}”: ${fresh.join(', ')}.` : `“${existing.title}” already has ${intent.items.join(', ')}.`;
    } else if (intent.action === 'rename') {
      after.title = intent.title;
      said = `Renamed “${existing.title}” to “${intent.title}”.`;
    } else if (intent.action === 'notes') {
      after.notes = existing.notes ? `${existing.notes}\n${intent.notes}` : intent.notes;
      said = `Added a note to “${existing.title}”: ${intent.notes}.`;
    } else said = `Reminder for “${existing.title}” set for ${when(remindAt)}.`;
    if (remindAt) {
      after.remindAt = remindAt;
      after.remindedAt = null;
      if (intent.action !== 'remind') said = said.replace(/\.$/, `. Reminder ${when(remindAt)}.`);
    }
    pushServer(diffCards([existing], [after], serverTs(), 'server'));
    return { ok: true, id: existing.id, action: intent.action, title: after.title, items: intent.items ?? [], remindAt: after.remindAt ?? null, said };
  });
}

/** The share sheet: a link (its page title becomes the card), or some text. */
async function captureShared(body) {
  const lines = String(body.text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const url = [...String(body.url ?? '').split(/\s+/), ...lines].find(isHttpUrl) || null;
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
  if (!url && !lines.length) return { error: 'Nothing to save.', status: 400 };
  let title = name;
  if (url && !title) title = await pageTitle(url, { allowLocal: process.env.TODOS_FETCH_LOCAL === '1' });
  const text = lines.filter((l) => l !== url);
  if (!title) title = text[0] ? text[0].slice(0, 200) : new URL(url).hostname.replace(/^www\./, '') + new URL(url).pathname.replace(/\/$/, '');
  // The link lives in the markdown body (v6: no separate links list).
  const rest = text.filter((l) => l !== title);
  const notes = [...(url ? [linkLine({ title, url })] : []), ...rest].join('\n').slice(0, 5000);
  const card = await serialize(() => captureCard({ title, items: [], notes, remindAt: null, via: 'share', titleBy: name ? 'user' : 'auto' }));
  return { ok: true, id: card.id, action: 'share', title, url, said: `Saved “${title}”.` };
}

// The install links carry a 10-minute key instead of relying on the session cookie: a phone
// browser downloads the file in a separate request that does not send it.
const DOWNLOAD_KEY_MS = 10 * 60 * 1000;
const downloadKeys = new Map();
function downloadKey(user) {
  const now = Date.now();
  for (const [k, v] of downloadKeys) if (v.expires <= now) downloadKeys.delete(k);
  for (const [k, v] of downloadKeys) if (v.user === user && v.expires - now > DOWNLOAD_KEY_MS / 2) return k;
  const key = crypto.randomBytes(32).toString('base64url');
  downloadKeys.set(key, { user, expires: now + DOWNLOAD_KEY_MS });
  return key;
}
function forgetDownloadKeys(user) {
  for (const [k, v] of downloadKeys) if (v.user === user) downloadKeys.delete(k);
}
function downloadUser(key) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(key)) return null;
  for (const [k, v] of downloadKeys) if (v.expires > Date.now() && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(key))) return v.user;
  return null;
}

/** Settings → Siri: the token's state, a new token, revoke it, and the signed shortcut files to install. */
async function shortcutsRoute(req, url, user, json) {
  const p = url.pathname;
  const base = APP_URL || `${secureRequest(req) ? 'https' : 'http'}://${req.headers['host'] || ''}`;
  const state = () => {
    const s = accounts.shortcutState(user);
    const key = s.enabled ? `?key=${downloadKey(user)}` : '';
    return { ...s, signing: signingAvailable(), shortcuts: Object.entries(SHORTCUTS).map(([kind, d]) => ({ kind, name: d.name, say: d.say, example: d.example, url: `${base}/kanban/shortcuts/${kind}.shortcut${key}` })) };
  };
  if (p === '/kanban/shortcuts') {
    if (req.method === 'GET') return json(state());
    // A new or revoked token also ends the user's download keys: nothing issued before survives.
    if (req.method === 'POST') { forgetDownloadKeys(user); accounts.createShortcutToken(user); return json(state()); }
    if (req.method === 'DELETE') { forgetDownloadKeys(user); accounts.revokeShortcutToken(user); return json(state()); }
    return json({ error: 'not_found', path: p }, 404);
  }
  const m = /^\/kanban\/shortcuts\/([a-z-]+)\.shortcut$/.exec(p);
  if (!m || !SHORTCUTS[m[1]] || req.method !== 'GET') return json({ error: 'not_found', path: p }, 404);
  const token = accounts.shortcutToken(user);
  if (!token) return json({ error: 'Set up Siri first.' }, 404);
  const signed = await signShortcut(shortcutXml(m[1], { base, token }));
  if (!signed) return json({ error: 'This server cannot sign shortcuts (it needs macOS).' }, 503);
  return { signed, name: SHORTCUTS[m[1]].name };
}

// --------------------------- routes (the table /agents documents) -------------
// [method, path, auth, what]. files.test.mjs checks every handled external/files path is
// listed here and every row appears in the /agents guide.
const ROUTES = [
  ['POST', '/kanban/files', 'app or external token', 'upload a file (raw body or multipart)'],
  ['GET', '/kanban/files/:id', 'app or external token', 'download a file'],
  ['GET', '/kanban/files/:id/thumb', 'app or external token', 'its thumbnail, or 404'],
  ['POST', '/kanban/files/:id/thumb', 'app or external token', 'store a thumbnail (the app makes one per image)'],
  ['POST', '/kanban/external/card', 'external token', 'create by key, or update a card by ?id= / ?title= / key'],
  ['GET', '/kanban/external/card', 'external token', 'one card by ?id=, ?key= or ?title='],
  ['DELETE', '/kanban/external/card', 'external token', 'delete a card by ?id=, ?key= or ?title='],
  ['GET', '/kanban/external/cards', 'external token', 'find cards: ?q=, ?status=, ?label=, ?archived=1'],
  ['POST', '/kanban/external/status', 'external token', 'move a card to todo, doing or done'],
  ['POST', '/kanban/external/card/attach', 'external token', 'upload a file and attach it to a card'],
  ['DELETE', '/kanban/external/card/attach', 'external token', 'remove an attachment (?attachment=<id>)'],
  ['GET', '/kanban/external/asks', 'Claw or Lurch bot token', 'list pending questions in the bot workspace'],
  ['POST', '/kanban/external/ask/claim', 'Claw or Lurch bot token', 'claim a question by requestId'],
  ['POST', '/kanban/external/ask/reply', 'Claw or Lurch bot token', 'answer or block a question on its card'],
  ['POST', '/kanban/capture', 'Siri capture token', 'one spoken request (add, add items, remind, rename, note), a checklist, or a shared link'],
  ['GET', '/agents', 'none', 'this guide (markdown, or HTML for a browser)'],
];

const AGENTS_MD = path.join(__dirname, 'shared', 'agents.md');

/** The agent guide with the live base URL; a tiny markdown → HTML for browsers. */
function agentsDoc(html) {
  const md = fs.readFileSync(AGENTS_MD, 'utf8').replaceAll('{{BASE}}', APP_URL);
  if (!html) return md;
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const out = [];
  let code = null;
  let list = false;
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) {
      if (code) {
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
        code = null;
      } else code = [];
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const li = /^\s*[-*] (.*)/.exec(line);
    if (list && !li) {
      out.push('</ul>');
      list = false;
    }
    const h = /^(#{1,3}) (.*)/.exec(line);
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (li) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(li[1])}</li>`);
    } else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Todos for agents</title><style>body{font:15px/1.55 system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#1b1f24;background:#fff}pre{background:#f3f4f6;padding:12px;border-radius:8px;overflow:auto}code{font:13px ui-monospace,monospace}@media (prefers-color-scheme:dark){body{color:#e6e8eb;background:#111418}pre{background:#1c2127}}</style></head><body>${out.join('\n')}</body></html>`;
}

// --------------------------- static serving ---------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Hashed bundles under /assets/ are immutable; everything else (app shell,
// service worker, manifest) must never be cached by the browser or the
// Cloudflare edge, or a deploy stays invisible until the edge TTL expires.
function cacheControl(file) {
  const rel = path.relative(DIST, file).replace(/\\/g, '/');
  return rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-store';
}

function send(req, res, file) {
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': cacheControl(file),
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', (e) => {
    if (!res.headersSent) res.writeHead(500);
    res.end('error');
    // eslint-disable-next-line no-console
    console.error('static stream error:', e.message);
  }).pipe(res);
}

function safeJoin(p) {
  const clean = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(DIST, clean);
  if (!file.startsWith(DIST)) file = null;
  return file;
}

function serveFile(req, res, p) {
  const file = safeJoin(p);
  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
    return send(req, res, file);
  }
  // SPA fallback: unknown extension-less routes load the app shell.
  if (file === null || !path.extname(p)) {
    const idx = path.join(DIST, 'index.html');
    if (fs.existsSync(idx)) return send(req, res, idx);
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

// --------------------------- http server ------------------------------------
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
    req.on('error', () => resolve(''));
  });
}

function tokenIs(req, token) {
  if (!token) return false;
  const a = Buffer.from(String(req.headers['authorization'] || ''));
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --------------------------- login sessions ---------------------------------
// The cookie is `<base64url payload>.<HMAC>`, signed with a key derived from
// data/session-secret plus the credentials, so a restart keeps sessions and a
// password change ends them.
const SESSION_COOKIE = 'todos_session';
const SESSION_MAX_AGE = 365 * 86400;
const SESSION_KEY = TODOS_USER
  ? crypto.createHmac('sha256', loadSecret(SESSION_SECRET_FILE)).update(`v1\0${TODOS_USER}\0${TODOS_PASS}`).digest()
  : null;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => b64url(crypto.createHmac('sha256', SESSION_KEY).update(payload).digest());

/** Compare secrets in constant time (digests, so lengths never leak). */
function sameSecret(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function credentialsOk(user, pass) {
  if (!TODOS_USER) return false;
  const u = sameSecret(user, TODOS_USER);
  const p = sameSecret(pass, TODOS_PASS);
  return (u && p) || accounts.verify(user, pass);
}

function sessionVersion(user) {
  const password = accounts.user(user)?.password || accounts.user(user)?.sessionKey;
  return password ? crypto.createHmac('sha256', SESSION_KEY).update(password).digest('base64url') : null;
}
function makeSession(user = TODOS_USER) {
  const payload = b64url(JSON.stringify({ u: user, v: sessionVersion(user), iat: Date.now() }));
  return `${payload}.${sign(payload)}`;
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers['cookie'] || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** The signed-in user from a valid session cookie, else null. */
function sessionUser(req) {
  if (!SESSION_KEY || req.crossSite) return null;
  const v = cookies(req)[SESSION_COOKIE];
  if (!v || !v.includes('.')) return null;
  const [payload, sig] = v.split('.');
  if (!sig || !sameSecret(sig, sign(payload))) return null;
  try {
    const { u, v, iat } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const age = Date.now() - Number(iat);
    // Expire on the server too; a small allowance for clock skew on the future side.
    if (!(age <= SESSION_MAX_AGE * 1000 && age >= -60000)) return null;
    return u === TODOS_USER || ((accounts.user(u)?.password || accounts.user(u)?.sessionKey) && v === sessionVersion(u)) ? u : null;
  } catch {
    return null;
  }
}

function secureRequest(req) {
  if (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true;
  return /"scheme"\s*:\s*"https"/.test(String(req.headers['cf-visitor'] || ''));
}

function sessionCookie(req, value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureRequest(req) ? '; Secure' : ''}`;
}

// Failed logins (and failed Basic auth) per client IP: 10 per 10 minutes.
const FAIL_WINDOW = 10 * 60 * 1000;
const FAIL_MAX = 10;
const failures = new Map();

/** "the Todos app on iPhone", "Chrome on Mac": shown on the link page so the right device gets approved. */
function deviceLabel(req, app) {
  const ua = String(req.headers['user-agent'] || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'another device';
  if (app) return `the Todos app on ${os}`;
  const browser = /Edg/.test(ua) ? 'Edge' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '';
  return browser ? `${browser} on ${os}` : os;
}

/** Forwarded headers count only from a loopback peer (the cloudflared tunnel); anyone else is their socket address. */
function clientIp(req) {
  const peer = String(req.socket.remoteAddress || '');
  const loopback = peer === '::1' || peer.startsWith('127.') || peer.startsWith('::ffff:127.');
  if (!loopback) return peer;
  const fwd = String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0]).trim();
  return fwd || peer;
}

function recentFailures(key) {
  const now = Date.now();
  const list = (failures.get(key) || []).filter((t) => now - t < FAIL_WINDOW);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list;
}

/** `bucket` keeps unrelated failures apart: wrong view links ('view') never lock the login and vice versa. */
function limited(req, bucket = 'login') {
  return recentFailures(`${bucket}\0${clientIp(req)}`).length >= FAIL_MAX;
}

function recordFailure(req, bucket = 'login') {
  const key = `${bucket}\0${clientIp(req)}`;
  failures.set(key, [...recentFailures(key), Date.now()]);
}

function basicOk(req) {
  const a = String(req.headers['authorization'] || '');
  if (!a.startsWith('Basic ') || !TODOS_USER || req.crossSite) return false; // a browser's remembered Basic is ambient too
  if (limited(req)) return false;
  const raw = Buffer.from(a.slice(6), 'base64').toString('utf8');
  const i = raw.indexOf(':');
  const ok = i >= 0 && credentialsOk(raw.slice(0, i), raw.slice(i + 1));
  if (!ok) recordFailure(req);
  return ok;
}

/** Sync routes: a session cookie, Bearer API_TOKEN or Basic user:pass. Open only when no auth is configured. */
function authorized(req) {
  if (!API_TOKEN && !TODOS_USER) return true;
  return tokenIs(req, API_TOKEN) || !!sessionUser(req) || basicOk(req);
}

function authorizedExternal(req) {
  return tokenIs(req, API_TOKEN) || tokenIs(req, EXTERNAL_TOKEN) || !!botForRequest(req);
}

function botForRequest(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? accounts.botForToken(value.slice(7)) : null;
}

// --------------------------- view-only share link ------------------------------
// <DATA_DIR>/share-token (32 random bytes base64url, 0600); no file = not shared. GET /view/<token>
// sets the todos_view cookie; viewer(req) is true while that cookie equals the current token, so
// revoking or rotating the token ends every viewer at once. A viewer may read the session, the
// snapshot and files attached to live cards; every other route treats it as signed out.
const shareTokenFile = () => path.join(storageDir(), 'share-token');
const VIEW_COOKIE = 'todos_view';
const NOINDEX = 'noindex, nofollow';

function shareToken() {
  try {
    return fs.readFileSync(shareTokenFile(), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Create the token if there is none (or always with `rotate`); returns it. */
function makeShareToken(rotate) {
  const cur = shareToken();
  if (cur && !rotate) return cur;
  const t = crypto.randomBytes(32).toString('base64url');
  const tmp = shareTokenFile() + '.tmp';
  fs.mkdirSync(storageDir(), { recursive: true });
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, t + '\n', { mode: 0o600 });
  fs.renameSync(tmp, shareTokenFile());
  return t;
}

function shareState() {
  const t = shareToken();
  return { shared: !!t, url: t ? `${APP_URL}/view/${t}` : null };
}

function viewer(req) {
  if (req.crossSite) return false;
  const v = cookies(req)[VIEW_COOKIE];
  if (!v) return false;
  const t = shareToken();
  return !!t && sameSecret(v, t);
}

/** Only files on a card the viewer can see (live, not archived) reach a viewer; a guessed or stale id does not. */
function attachedToLiveCard(id) {
  return Object.values(kb.state.cards).some((c) => !c.archivedAt && (c.attachments ?? []).some((a) => a.id === id));
}

/** What a viewer sees: the board as the app shows it. No archived cards, no ext (agent keys, Slack ids,
 * every link ever delivered), no tombstone ids, only the labels those cards use. */
function viewerSnapshot() {
  const snap = snapshot(kb.state);
  const cards = snap.cards.filter((c) => !c.archivedAt).map(({ ext, ...c }) => c); // eslint-disable-line no-unused-vars
  const used = new Set(cards.flatMap((c) => c.labels ?? []));
  return { cards, tombstones: [], labels: snap.labels.filter((l) => used.has(l.id)), labelTombstones: [], cursor: kb.seq };
}

/** Readable by the page (no secret in it): "start read-only" before the server answers. */
const VIEWER_MARK = 'todos_viewer';
function viewerMark(req, on) {
  return `${VIEWER_MARK}=${on ? '1' : ''}; Path=/; SameSite=Lax; Max-Age=${on ? SESSION_MAX_AGE : 0}${secureRequest(req) ? '; Secure' : ''}`;
}

/** Once a browser is the owner's it stops being a viewer: the view cookie and the marker go. */
function dropView(req) {
  const c = cookies(req);
  const out = [];
  if (c[VIEW_COOKIE] !== undefined) out.push(`${VIEW_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureRequest(req) ? '; Secure' : ''}`);
  if (c[VIEWER_MARK] !== undefined) out.push(viewerMark(req, false));
  return out;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/**
 * A state-changing request from another origin (a form on another subdomain may be same-site, so
 * SameSite=Lax does not stop it): cookies (and a remembered Basic login) must not authenticate it.
 * Bearer and external tokens are unaffected; scripts send neither Origin nor Sec-Fetch-Site.
 */
function crossSiteWrite(req, includeReads = false) {
  if (!includeReads && SAFE_METHODS.has(req.method)) return false;
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site === 'same-site' || site === 'cross-site') return true;
  const origin = req.headers['origin'];
  if (origin === undefined) return false;
  const own = new Set([`${secureRequest(req) ? 'https' : 'http'}://${req.headers['host'] || ''}`]);
  try {
    own.add(new URL(APP_URL).origin);
  } catch {
    /* APP_URL unset or odd */
  }
  return !own.has(String(origin));
}

/** The page a stale view link (or too many guesses) lands on: self-contained, light and dark. */
function notSharedPage(limitedNow) {
  const text = limitedNow ? 'Too many attempts. Try again in a few minutes.' : 'This board is no longer shared.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Todos</title><style>
:root{color-scheme:light dark;--bg:#F4F6F8;--fg:#14181D;--muted:#6B7480}
@media (prefers-color-scheme: dark){:root{--bg:#0F1216;--fg:#ECEFF3;--muted:#8B94A0}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;text-align:center}
h1{font-size:20px;font-weight:600;margin:0 0 6px}p{margin:0;color:var(--muted);font-size:15px}
</style></head><body><main><h1>${text}</h1><p>Ask the owner for a new link.</p></main></body></html>`;
}

async function readJson(req) {
  const raw = await readBody(req);
  if (raw.length > 1_000_000) return { error: 'body too large' };
  try {
    return { body: JSON.parse(raw || '{}') };
  } catch {
    return { error: 'bad_json' };
  }
}

const server = http.createServer((req, res) => roomContext.run('personal', () => handleRequest(req, res)));
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  res.setHeader('access-control-allow-origin', req.headers['origin'] || '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', 'Content-Type, Authorization, X-Filename, X-Filename-Encoding, X-File-Id, X-Todos-Room, X-Todos-Account');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  req.crossSite = crossSiteWrite(req);
  if (viewer(req)) res.setHeader('x-robots-tag', NOINDEX);

  const json = (body, status = 200, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  try {
    if (p === '/kanban/capture') {
      const text = (body) => { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
      return captureRoute(req, url, json, text);
    }
    const user = sessionUser(req);
    const requestedRoom = url.searchParams.get('room') || req.headers['x-todos-room'];
    const bot = botForRequest(req);
    const accountHint = req.headers['x-todos-account'] || url.searchParams.get('account');
    const accountRoutes = ['/kanban/login', '/kanban/logout', '/kanban/session', '/kanban/register', '/kanban/invitation', '/kanban/email/request', '/kanban/email/consume', '/kanban/email/link', '/kanban/email/approve', '/kanban/email/wait', '/kanban/auth-options'];
    if (accountHint && user && accountHint !== user && !accountRoutes.includes(p)) return json({ error: 'account_changed' }, 409);
    if (bot) {
      if (!p.startsWith('/kanban/external/') || (requestedRoom && requestedRoom !== bot.room)) return json({ error: 'room_forbidden' }, 403);
      roomContext.enterWith(bot.room);
    } else if (requestedRoom && !accountRoutes.includes(p)) {
      const room = accounts.room(requestedRoom);
      if (!room || !(user && room.members.includes(user)) && !tokenIs(req, API_TOKEN)) return json({ error: 'room_forbidden' }, 403);
      roomContext.enterWith(room.id);
    } else if (user) roomContext.enterWith(accounts.user(user)?.personalRoom || 'personal');
    else {
      const token = p.startsWith('/view/') ? p.slice(6).replace(/\/+$/, '') : cookies(req)[VIEW_COOKIE];
      if (token) for (const room of accounts.allRooms()) {
        const found = roomContext.run(room.id, shareToken);
        if (found && sameSecret(token, found)) { roomContext.enterWith(room.id); break; }
      }
    }
    if (p === '/kanban/shortcuts' || p.startsWith('/kanban/shortcuts/')) {
      const who = (p !== '/kanban/shortcuts' && downloadUser(url.searchParams.get('key'))) || (user && !viewer(req) ? user : null);
      if (!who) return json({ error: 'unauthorized' }, 401);
      const out = await shortcutsRoute(req, url, who, json);
      if (!out?.signed) return out;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${out.name}.shortcut"`, 'cache-control': 'no-store' });
      return res.end(out.signed);
    }
    if (p === '/kanban/note-view' && req.method === 'POST') {
      if (!user || viewer(req) || req.crossSite) return json({ error: 'unauthorized' }, 403);
      const { body, error } = await readJson(req);
      if (error || !body || typeof body.id !== 'string') return json({ error: 'Invalid note.' }, 400);
      return json(await serialize(() => {
        const card = kb.state.cards[body.id];
        if (!card) return { ok: true };
        const bridge = sherlockRooms.get(roomId()) || (sherlockConfig && sherlockRoomAllowed() ? sherlockForRoom() : null);
        if (kb.state.labels[REPLY_LABEL.id]?.removeOnView && body.replyThrough) bridge?.view(card.id, body.replyThrough);
        const viewed = new Set(Array.isArray(body.labels) ? body.labels : []);
        const after = { ...card, labels: card.labels.filter(id => {
          if (!kb.state.labels[id]?.removeOnView || !viewed.has(id)) return true;
          if (id === REPLY_LABEL.id) return bridge?.unread(card.id) ?? true;
          const assigned = kb.state.meta[card.id]?.f?.labels?.ts || card.updatedAt;
          return typeof body.updatedAt !== 'string' || body.updatedAt < assigned;
        }) };
        pushServer(diffCards([card], [after], serverTs(card.updatedAt), 'server'));
        return { ok: true };
      }));
    }
    if (p === '/kanban/bots/delegate') return json({ error: 'Use the in-card conversation.' }, 410);
    if (p === '/kanban/bots/conversation' && req.method === 'GET') {
      if (!user || viewer(req)) return json({ error: 'unauthorized' }, 403);
      const id = url.searchParams.get('id');
      if (!id || !kb.state.cards[id]) return json({ error: 'Card unavailable.' }, 404);
      return json({ requests: botConversations()[id] || [] });
    }
    if (p === '/kanban/bots/conversation/view' && req.method === 'POST') {
      if (!user || viewer(req) || crossSiteWrite(req, true)) return json({ error: 'unauthorized' }, 403);
      const { body, error } = await readJson(req);
      if (error || !body || typeof body.id !== 'string' || typeof body.through !== 'string') return json({ error: 'Invalid view.' }, 400);
      return json(await serialize(() => {
        const card = kb.state.cards[body.id], label = botReplyLabel();
        if (!card || !label) return { error: 'Card unavailable.' };
        const conversations = botConversations(), requests = conversations[card.id] || [];
        const index = requests.findIndex(request => request.requestId === body.through && request.reply);
        if (index < 0) return { error: 'Reply unavailable.' };
        if (kb.state.labels[label.id]?.removeOnView) {
          const now = new Date().toISOString();
          for (const request of requests.slice(0, index + 1)) if (request.reply && !request.seenAt) request.seenAt = now;
          saveBotConversations(conversations);
          if (!requests.some(request => request.reply && !request.seenAt) && card.labels.includes(label.id)) pushServer(diffCards([card], [{ ...card, labels: card.labels.filter(id => id !== label.id) }], serverTs(card.updatedAt), 'server'));
        }
        return { requests };
      }));
    }
    if (p === '/kanban/bots/ask' && req.method === 'POST') {
      if (!user || viewer(req) || crossSiteWrite(req, true)) return json({ error: 'unauthorized' }, 403);
      const { body, error } = await readJson(req);
      if (error || !body || !['claw', 'lurch'].includes(body.bot) || typeof body.id !== 'string' || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 4000 || !/^[a-zA-Z0-9-]{8,100}$/.test(body.requestId || '')) return json({ error: 'Invalid request.' }, 400);
      if (accounts.room(roomId())?.bot !== body.bot) return json({ error: 'Ask this bot from its workspace.' }, 403);
      if (!kb.state.cards[body.id]) return json({ error: 'Card unavailable.' }, 404);
      const result = await serialize(() => {
        const conversations = botConversations();
        const existing = Object.values(conversations).flat().find(entry => entry.requestId === body.requestId);
        if (existing) return existing.cardId === body.id ? { requests: conversations[body.id] } : { error: 'Request ID already used.' };
        const now = new Date().toISOString();
        const entry = { requestId: body.requestId, cardId: body.id, message: body.message.trim(), status: 'queued', createdAt: now, updatedAt: now };
        conversations[body.id] = [...(conversations[body.id] || []), entry];
        saveBotConversations(conversations);
        return { requests: conversations[body.id] };
      });
      return json(result, result.error ? 409 : 200);
    }
    if (p === '/kanban/sherlock' || p === '/kanban/sherlock/send' || p === '/kanban/sherlock/new-thread') {
      if (!user || viewer(req) || crossSiteWrite(req, true)) return json({ error: 'unauthorized' }, 403);
      if (!sherlockAllowed(user)) return json({ available: false }, req.method === 'GET' ? 200 : 403);
      const bridge = sherlockForRoom();
      let body = null;
      if (req.method === 'POST') { const read = await readJson(req); if (read.error) return json({ error: read.error }, 400); body = read.body; }
      const id = req.method === 'GET' ? url.searchParams.get('id') : body?.id;
      if (!id || !kb.state.cards[id]) return json({ error: 'This note no longer exists.' }, 404);
      try {
        if (p.endsWith('/new-thread') && req.method === 'POST') return json({ available: true, ...await bridge.reset(id) });
        if (p.endsWith('/send') && req.method === 'POST') {
          if (!body.context || typeof body.context.title !== 'string' || typeof body.context.notes !== 'string' || !Array.isArray(body.context.items)) return json({ error: 'Your note needs to finish syncing before sending.', code: 'NOTE_NOT_SYNCED' }, 409);
          return json({ available: true, ...await bridge.send(id, body) });
        }
        if (p === '/kanban/sherlock' && req.method === 'GET') return json({ available: bridge.enabled(), ...await bridge.refresh(id) });
        return json({ error: 'not_found' }, 404);
      } catch (e) {
        return json({ recovery: ['SLACK_THREAD_NOT_FOUND', 'SLACK_MESSAGE_NOT_FOUND', 'SLACK_CHANNEL_NOT_FOUND', 'SLACK_NOT_IN_CHANNEL'].includes(e.code), error: e.message, code: e.code || 'SHERLOCK_ERROR', requestId: body?.requestId || null, time: new Date().toISOString(), ...bridge.state(id) }, e.status || 502);
      }
    }
    if (p === '/kanban/assistant/jobs' || p.startsWith('/kanban/assistant/jobs/')) {
      if (!user || viewer(req)) return json({ error: 'Sign in to use the assistant.' }, 401);
      if (req.crossSite) return json({ error: 'unauthorized' }, 403);
      try {
        if (p === '/kanban/assistant/jobs' && req.method === 'POST') {
          const { body, error } = await readJson(req);
          if (error) return json({ error }, 400);
          return json(assistantJobs.start(body, snapshot(kb.state).cards, user, roomId()), 202);
        }
        const id = p.slice('/kanban/assistant/jobs/'.length);
        if (req.method === 'GET') return json(assistantJobs.get(id, user, roomId()));
        if (req.method === 'DELETE') return json(assistantJobs.cancel(id, user, roomId()));
        return json({ error: 'method_not_allowed' }, 405);
      } catch (error) { return json({ error: error.message }, error.status || 503); }
    }
    if (p === '/kanban/assistant' && req.method === 'POST') {
      if (!user || viewer(req)) return json({ error: 'Sign in to use the assistant.' }, 401);
      if (limited(req, 'assistant')) return json({ error: 'Too many requests. Try again in a few minutes.' }, 429);
      const { body, error } = await readJson(req);
      if (error) return json({ error }, 400);
      const controller = new AbortController();
      const cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', cancel);
      try {
        recordFailure(req, 'assistant');
        const result = await askAssistant(body, snapshot(kb.state).cards, controller.signal);
        if (!res.destroyed) return json(result);
      } catch (error) {
        if (!res.destroyed) return json({ error: error.message }, error.status || 503);
      } finally { res.off('close', cancel); }
      return;
    }
    if (p === '/kanban/auth-options' && req.method === 'GET') return json({ email: !!sendEmail });
    if (p === '/kanban/email/request' && req.method === 'POST') {
      if (!TODOS_USER || !sendEmail) return json({ error: 'Email sign-in is not available yet.' }, 503);
      if (req.crossSite) return json({ error: 'unauthorized' }, 403);
      if (limited(req, 'email')) return json({ error: 'Too many requests. Try again later.' }, 429);
      recordFailure(req, 'email');
      const { body, error } = await readJson(req);
      if (error) return json({ error }, 400);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Expected an object.' }, 400);
      if (body.linkAccount && !user) return json({ error: 'Sign in before linking your email.' }, 401);
      let pending;
      try { pending = accounts.requestEmail(body.email, { username: body.linkAccount ? user : undefined, invite: body.invite, device: deviceLabel(req, body.app === true) }); if (pending) pending.device = deviceLabel(req, body.app === true); }
      catch (error) { return json({ error: error.message }, 400); }
      // Delivery runs after the same response for new, existing and unavailable addresses; the wait id and
      // match code let this device be signed in from wherever the link is opened.
      json(pending ? { ok: true, request: pending.request, code: pending.code } : { ok: true });
      if (pending?.token) void sendEmail(pending.email, pending.token, pending.device).catch(() => { accounts.cancelEmail(pending.token); console.error('Todos sign-in email delivery failed.'); });
      return;
    }
    if (p === '/kanban/email/link' && req.method === 'POST') {
      // POST so the token travels in the body, never in a URL that a log could keep.
      if (!TODOS_USER || !sendEmail || req.crossSite) return json({ error: 'Email sign-in unavailable.' }, 403);
      if (limited(req, 'email-consume')) return json({ error: 'Too many attempts. Try again later.' }, 429);
      const { body, error } = await readJson(req);
      if (error) return json({ error }, 400);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Expected an object.' }, 400);
      const info = accounts.linkInfo(body.token);
      if (!info) { recordFailure(req, 'email-consume'); return json({ error: 'This link has expired or has already been used. Request a new one.' }, 404); }
      return json(info);
    }
    if (p === '/kanban/email/approve' && req.method === 'POST') {
      if (!TODOS_USER || !sendEmail || req.crossSite) return json({ error: 'Email sign-in unavailable.' }, 403);
      if (limited(req, 'email-consume')) return json({ error: 'Too many attempts. Try again later.' }, 429);
      const { body, error } = await readJson(req);
      if (error) return json({ error }, 400);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Expected an object.' }, 400);
      try { return json({ ok: true, device: accounts.approveEmail(body.token, body.code).device }); }
      catch (error) { recordFailure(req, 'email-consume'); return json({ error: error.message }, 400); }
    }
    if (p === '/kanban/email/wait' && req.method === 'POST') {
      if (!TODOS_USER || !sendEmail || req.crossSite) return json({ error: 'Email sign-in unavailable.' }, 403);
      const { body, error } = await readJson(req);
      if (error) return json({ error }, 400);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Expected an object.' }, 400);
      const result = accounts.waitEmail(body.request);
      if (result.status !== 'approved') return json(result);
      return json(result, 200, { 'set-cookie': [sessionCookie(req, makeSession(result.user), SESSION_MAX_AGE), ...dropView(req)] });
    }
    if (p === '/kanban/email/consume' && req.method === 'POST') {
      if (!TODOS_USER || !sendEmail || req.crossSite) return json({ error: 'Email sign-in unavailable.' }, 403);
      if (limited(req, 'email-consume')) return json({ error: 'Too many attempts. Try again later.' }, 429);
      const { body, error } = await readJson(req);
      if (error) return json({ error }, 400);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Expected an object.' }, 400);
      try {
        const result = accounts.consumeEmail(body.token);
        return json({ ok: true, user: result.user.username, room: result.room.id }, 200, { 'set-cookie': [sessionCookie(req, makeSession(result.user.username), SESSION_MAX_AGE), ...dropView(req)] });
      } catch (error) { recordFailure(req, 'email-consume'); return json({ error: error.message }, 400); }
    }
    if (p === '/kanban/invitation' && req.method === 'GET') {
      const info = accounts.inviteInfo(url.searchParams.get('token'));
      return info ? json(info) : json({ error: 'Invitation expired or already used.' }, 404);
    }
    if (p === '/kanban/register' && req.method === 'POST') {
      if (!TODOS_USER || req.crossSite || sendEmail) return json({ error: 'Use email sign-in to create your account.' }, 403);
      if (limited(req)) return json({ error: 'too_many_attempts' }, 429);
      const { body, error } = await readJson(req);
      if (error) return json({ error }, 400);
      try {
        const created = accounts.register(body.username, body.password, body.token);
        return json({ ok: true, user: created.user.username, room: created.room.id }, 200, { 'set-cookie': [sessionCookie(req, makeSession(created.user.username), SESSION_MAX_AGE), ...dropView(req)] });
      } catch (error) { recordFailure(req); return json({ error: error.message }, 400); }
    }
    if (p === '/kanban/account' || p === '/kanban/rooms' || p === '/kanban/invite' || p === '/kanban/join' || p === '/kanban/rooms/rename' || p === '/kanban/rooms/leave' || p === '/kanban/rooms/delete') {
      if (!user) return json({ error: 'unauthorized' }, 401);
      if (p === '/kanban/account' && req.method === 'GET') return json(accountInfo(user));
      if (req.method !== 'POST') return json({ error: 'not_found' }, 404);
      const { body, error } = await readJson(req);
      if (error) return json({ error }, 400);
      try {
        if (p === '/kanban/account') return json({ preferences: accounts.preferences(user, body) });
        if (p === '/kanban/rooms') return json({ room: accounts.createRoom(user, body.name) });
        if (p === '/kanban/rooms/rename') return json({ room: accounts.renameRoom(user, body.room, body.name) });
        if (p === '/kanban/rooms/leave') { accounts.leaveRoom(user, body.room); return json({ ok: true }); }
        if (p === '/kanban/rooms/delete') { accounts.deleteRoom(user, body.room); return json({ ok: true }); }
        if (p === '/kanban/invite') {
          const replace = typeof body.replace === 'string' ? new URL(body.replace, APP_URL).searchParams.get('invite') : null;
          const token = accounts.invite(user, body.room, replace);
          return json({ url: `${APP_URL}/?invite=${token}`, expires: accounts.inviteExpires(token) });
        }
        return json({ room: accounts.join(user, body.token) });
      } catch (error) { return json({ error: error.message }, 400); }
    }
    if (p === '/kanban/share' && user && accounts.room(roomId())?.owner !== user) return json({ error: 'owner_required' }, 403);

    // The public view link: the right token sets the viewer cookie; a wrong one counts as a failed attempt.
    if (p.startsWith('/view/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const head = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': NOINDEX };
      // The right link always opens (256 random bits need no limiter, and wrong guesses by others must not lock it).
      const t = shareToken();
      if (t && sameSecret(p.slice(6).replace(/\/+$/, ''), t)) {
        // The owner's browser never becomes a viewer (nobody can plant the cookie there through a hidden request).
        if (sessionUser(req)) {
          res.writeHead(302, { ...head, location: '/' });
          return res.end();
        }
        const cookie = `${VIEW_COOKIE}=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${secureRequest(req) ? '; Secure' : ''}`;
        res.writeHead(302, { ...head, location: '/', 'set-cookie': [cookie, viewerMark(req, true)] });
        return res.end();
      }
      if (limited(req, 'view')) {
        res.writeHead(429, { ...head, 'content-type': 'text/html; charset=utf-8' });
        return res.end(req.method === 'HEAD' ? undefined : notSharedPage(true));
      }
      recordFailure(req, 'view');
      res.writeHead(404, { ...head, 'content-type': 'text/html; charset=utf-8' });
      return res.end(req.method === 'HEAD' ? undefined : notSharedPage(false));
    }

    // The validator's fixture (§16), read-only, from the repo's fixtures/ folder.
    if (p === '/fixtures/board.json' && req.method === 'GET') {
      const f = path.join(__dirname, 'fixtures', 'board.json');
      if (!fs.existsSync(f)) return json({ error: 'not_found' }, 404);
      return send(req, res, f);
    }

    if (p === '/healthz' && req.method === 'GET') {
      return json({ ok: true, service: 'todos', time: new Date().toISOString() });
    }

    if (p === '/kanban/login' && req.method === 'POST') {
      if (req.crossSite) return json({ error: 'unauthorized' }, 401);
      if (!TODOS_USER) return json({ error: 'login_disabled' }, 401);
      if (limited(req)) return json({ error: 'too_many_attempts' }, 429);
      const { body, error } = await readJson(req);
      if (error) return json({ error }, 400);
      if (!credentialsOk(body?.username ?? '', body?.password ?? '')) {
        recordFailure(req);
        await new Promise((r) => setTimeout(r, 400));
        return json({ error: 'invalid_credentials' }, 401);
      }
      // `fresh`: this browser held a view link, so the app starts from the server board and drops anything unsent.
      const held = dropView(req);
      return json({ ok: true, user: body.username, ...(held.length ? { fresh: true } : {}) }, 200, { 'set-cookie': [sessionCookie(req, makeSession(body.username), SESSION_MAX_AGE), ...held] });
    }

    if (p === '/kanban/logout' && req.method === 'POST') {
      if (req.crossSite) return json({ error: 'unauthorized' }, 401); // another site can never sign the owner out
      // Still holding a working view link: the next launch starts read-only, never editable.
      return json({ ok: true }, 200, { 'set-cookie': [sessionCookie(req, '', 0), ...(viewer(req) ? [viewerMark(req, true)] : [])] });
    }

    if (p === '/kanban/session' && req.method === 'GET') {
      const user = sessionUser(req);
      // The owner: never start read-only here again (the page clears the marker too).
      const held = user ? dropView(req) : [];
      if (user) return json({ ok: true, user, ...accountInfo(user) }, 200, held.length ? { 'set-cookie': held } : {});
      if (!authorized(req)) return viewer(req) ? json({ ok: true, user: null, viewer: true }, 200, { 'set-cookie': viewerMark(req, true) }) : json({ error: 'unauthorized' }, 401);
      return json({ ok: true, user: null });
    }

    // A pasted link's page title (v6 §6): signed-in devices only; private addresses are refused.
    if (p === '/kanban/page-title' && req.method === 'GET') {
      if (!authorized(req) || viewer(req)) return json({ error: 'unauthorized' }, 401);
      const target = url.searchParams.get('url') || '';
      if (!isHttpUrl(target)) return json({ error: 'url must be http(s)' }, 400);
      const title = await pageTitle(target, { allowLocal: process.env.TODOS_FETCH_LOCAL === '1' });
      return json({ title: title || null });
    }

    if (p === '/kanban/push' && req.method === 'POST') {
      if (!authorized(req)) return json({ error: 'unauthorized' }, 401);
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return json({ error: 'bad_json' }, 400);
      }
      if (!body || !Array.isArray(body.actions)) return json({ error: 'actions must be an array' }, 400);
      return json(await serialize(() => pushActions(body.deviceId, body.actions)));
    }

    if (p === '/kanban/pull' && req.method === 'GET') {
      if (!authorized(req)) return json({ error: 'unauthorized' }, 401);
      const since = Number(url.searchParams.get('since')) || 0;
      return json(await serialize(() => pullSince(since)));
    }

    if (p === '/kanban/snapshot' && req.method === 'GET') {
      if (authorized(req)) return json(await serialize(() => ({ ...snapshot(kb.state), cursor: kb.seq })));
      if (!viewer(req)) return json({ error: 'unauthorized' }, 401);
      return json(await serialize(viewerSnapshot));
    }

    if (p === '/kanban/notify-topic' && req.method === 'GET') {
      if (!authorized(req)) return json({ error: 'unauthorized' }, 401);
      return json({ topic: roomTopic(), subscribeUrl: `${NTFY_SERVER}/${roomTopic()}` });
    }

    if (p === '/kanban/notify-test' && req.method === 'POST') {
      if (!authorized(req)) return json({ error: 'unauthorized' }, 401);
      try {
        await sendNtfy({ title: 'Todos test', body: 'Notifications work.', click: `${APP_URL}/` });
        return json({ ok: true });
      } catch (e) {
        return json({ error: e.message || 'send failed' }, 502);
      }
    }

    // Owner only: the view-only link (a viewer is not authorized here).
    if (p === '/kanban/share') {
      if (!authorized(req)) return json({ error: 'unauthorized' }, 401);
      if (req.method === 'GET') return json(shareState());
      if (req.method === 'POST') {
        const { body, error } = await readJson(req);
        if (error) return json({ error }, 400);
        makeShareToken(body?.rotate === true);
        return json(shareState());
      }
      if (req.method === 'DELETE') {
        fs.rmSync(shareTokenFile(), { force: true });
        return json(shareState());
      }
      return json({ error: 'not_found', path: p }, 404);
    }

    if (p === '/agents' && req.method === 'GET') {
      const html = /text\/html/.test(String(req.headers['accept'] || '')) && url.searchParams.get('format') !== 'md';
      res.writeHead(200, { 'content-type': html ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(agentsDoc(html));
    }

    // Files: the app (session, Bearer, Basic) and agents (the external token) alike; never public.
    if (p === '/kanban/files' || p.startsWith('/kanban/files/')) {
      if (!authorized(req) && !authorizedExternal(req)) {
        if (!viewer(req)) return json({ error: 'unauthorized' }, 401);
        // View only: download a file (or its thumb) attached to a live card; nothing else.
        const v = /^\/kanban\/files\/([^/]+)(\/thumb)?$/.exec(p);
        if (!v || (req.method !== 'GET' && req.method !== 'HEAD')) {
          req.resume();
          return json({ error: 'read_only' }, 403);
        }
        const vm = attachedToLiveCard(v[1]) ? readSidecar(v[1]) : null;
        if (vm && sendStored(req, res, vm, !!v[2])) return;
        return json({ error: 'not_found' }, 404);
      }
      if (p === '/kanban/files' && req.method === 'POST') {
        const got = await receiveFile(req, url);
        if (got.error) return json({ error: got.error, ...(got.status === 413 ? { maxBytes: FILE_MAX } : {}) }, got.status);
        return json(fileJson(got.meta));
      }
      const m = /^\/kanban\/files\/([^/]+)(\/thumb)?$/.exec(p);
      const meta = m ? readSidecar(m[1]) : null;
      if (!meta) return json({ error: 'not_found' }, 404);
      if (m[2] && req.method === 'POST') {
        const type = String(req.headers['content-type'] || '').split(';')[0].trim();
        if (!['image/jpeg', 'image/webp', 'image/png'].includes(type)) return json({ error: 'thumb must be image/jpeg, image/webp or image/png' }, 400);
        const got = await readRaw(req, THUMB_MAX);
        if (got.tooLarge) return json({ error: 'file_too_large', maxBytes: THUMB_MAX }, 413);
        fs.writeFileSync(fileBlob(meta.id) + '.thumb', got.buf);
        fs.writeFileSync(fileSide(meta.id), JSON.stringify({ ...meta, thumbType: type }));
        return json({ ok: true });
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (sendStored(req, res, meta, !!m[2])) return;
        return json({ error: 'not_found' }, 404);
      }
      return json({ error: 'not_found', path: p }, 404);
    }

    if (p === '/kanban/external/asks' || p === '/kanban/external/ask/claim' || p === '/kanban/external/ask/reply') {
      const bot = botForRequest(req);
      if (!bot || !['claw', 'lurch'].includes(bot.name) || roomId() !== bot.room) return json({ error: 'unauthorized' }, 403);
      if (req.method === 'GET' && p === '/kanban/external/asks') {
        const now = Date.now();
        const pending = Object.values(botConversations()).flat().filter(entry => {
          const stale = entry.status === 'doing' && now - Date.parse(entry.updatedAt) > 10 * 60000;
          return (entry.status === 'queued' || stale) && kb.state.cards[entry.cardId];
        }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return json({ asks: pending.slice(0, 10) });
      }
      if (req.method !== 'POST') return json({ error: 'not_found' }, 404);
      const { body, error } = await readJson(req);
      if (error || !body || typeof body.requestId !== 'string') return json({ error: 'Invalid request.' }, 400);
      const out = await serialize(() => {
        const conversations = botConversations();
        const entry = Object.values(conversations).flat().find(item => item.requestId === body.requestId);
        if (!entry || !kb.state.cards[entry.cardId]) return { error: 'Request unavailable.', status: 404 };
        if (p.endsWith('/claim')) {
          if (entry.status !== 'queued' && !(entry.status === 'doing' && Date.now() - Date.parse(entry.updatedAt) > 10 * 60000)) return { changed: false };
          entry.status = 'doing';
        } else {
          if (!['done', 'blocked'].includes(body.status) || typeof body.reply !== 'string' || !body.reply.trim() || body.reply.length > 4000) return { error: 'Invalid reply.', status: 400 };
          if (entry.status === 'done' || entry.status === 'blocked') return { changed: false };
          entry.status = body.status;
          entry.reply = body.reply.trim();
          entry.updatedAt = new Date().toISOString();
          saveBotConversations(conversations);
          const label = botReplyLabel();
          if (label && !kb.state.labels[label.id]) pushServer(diffLabels(Object.values(kb.state.labels), [...Object.values(kb.state.labels), label], serverTs(), 'server'));
          const card = kb.state.cards[entry.cardId];
          if (label && !card.labels.includes(label.id)) pushServer(diffCards([card], [{ ...card, labels: [...card.labels, label.id] }], serverTs(card.updatedAt), 'server'));
        }
        if (p.endsWith('/claim')) {
          entry.updatedAt = new Date().toISOString();
          saveBotConversations(conversations);
        }
        return { changed: true, request: entry };
      });
      return out.error ? json({ error: out.error }, out.status) : json(out);
    }
    if (p.startsWith('/kanban/external/')) {
      if (!authorizedExternal(req)) return json({ error: 'unauthorized' }, 401);
      const miss = (t) => json({ error: t.error, ...(t.ids ? { ids: t.ids } : {}) }, t.status);
      if (p === '/kanban/external/cards' && req.method === 'GET') {
        return json({ ok: true, cards: await serialize(() => listCards(url)) });
      }
      if (p === '/kanban/external/card' && req.method === 'GET') {
        const t = await serialize(() => findTarget(targetOf(url), false));
        return t.card ? json({ ok: true, card: agentCard(t.card) }) : miss(t);
      }
      if (p === '/kanban/external/card' && req.method === 'DELETE') {
        const out = await serialize(() => {
          const t = findTarget(targetOf(url), false);
          if (!t.card) return t;
          pushServer(diffCards([t.card], [], serverTs(), 'server'));
          return { ok: true, id: t.card.id };
        });
        return out.ok ? json(out) : miss(out);
      }
      if (p === '/kanban/external/card/attach' && req.method === 'POST') {
        const t0 = await serialize(() => findTarget(targetOf(url)));
        if (!t0.card) {
          req.resume();
          return miss(t0);
        }
        const got = await receiveFile(req, url);
        if (got.error) return json({ error: got.error, ...(got.status === 413 ? { maxBytes: FILE_MAX } : {}) }, got.status);
        const out = await serialize(() => {
          const t = findTarget({ id: t0.card.id }); // it may have changed while the body arrived
          if (!t.card) return t;
          attachToCard(t.card, got.meta);
          return { ok: true, cardId: t.card.id, attachment: { ...attachmentOf(got.meta), url: fileUrl(got.meta.id) } };
        });
        return out.ok ? json(out) : miss(out);
      }
      if (p === '/kanban/external/card/attach' && req.method === 'DELETE') {
        const out = await serialize(() => {
          const t = findTarget(targetOf(url));
          if (!t.card) return t;
          const aid = url.searchParams.get('attachment') || '';
          if (!t.card.attachments?.some((a) => a.id === aid)) return { error: 'attachment_not_found', status: 404 };
          const after = clone(t.card);
          after.attachments = after.attachments.filter((a) => a.id !== aid);
          pushServer(diffCards([t.card], [after], serverTs(), 'server'));
          return { ok: true, id: t.card.id, attachment: aid };
        });
        return out.ok ? json(out) : miss(out);
      }
      if (req.method !== 'POST') return json({ error: 'not_found', path: p }, 404);
      const { body, error } = await readJson(req);
      if (error) return json({ error }, 400);
      if (p === '/kanban/external/card') {
        const tgt = targetOf(url, {});
        // A target in the query (or body.id) means update only; body.key alone is the idempotent create-or-update.
        const byTarget = nonEmpty(tgt.id) || nonEmpty(tgt.title) || nonEmpty(tgt.key) || nonEmpty(body?.id);
        if (!body || typeof body !== 'object') return json({ error: 'body must be an object' }, 400);
        const out = await serialize(() => {
          // A missing card answers 404 before any field problem.
          const t = byTarget ? findTarget({ ...tgt, id: tgt.id ?? body.id }) : null;
          if (t && !t.card) return t;
          const bad = externalCardError(body, byTarget);
          if (bad) return { error: bad, status: 400 };
          return t ? externalCard(body, t.card) : externalCard(body);
        });
        return out.ok ? json(out) : miss(out);
      }
      if (p === '/kanban/external/status') {
        if (!body || !STATUSES.includes(body.status)) return json({ error: 'status must be todo, doing or done' }, 400);
        const out = await serialize(() => {
          const t = findTarget(targetOf(url, body));
          return t.card ? externalStatus(body, t.card) : t;
        });
        if (out.ok) return json(out);
        return out.error === 'list_complete' ? json(out, 409) : miss(out);
      }
      return json({ error: 'not_found', path: p }, 404);
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveFile(req, res, p);
    }

    return json({ error: 'not_found', path: p }, 404);
  } catch (e) {
    return json({ error: (e && e.message) || 'error' }, 500);
  }
}

setInterval(() => void checkAllReminders(), REMINDER_TICK_MS).unref();

function collectAllFiles() {
  roomContext.run('personal', collectFiles);
  for (const room of accounts.allRooms()) if (room.id !== 'personal') roomContext.run(room.id, collectFiles);
}
collectAllFiles();
setInterval(() => collectAllFiles(), 12 * 3600000).unref();

// Every room's one-time notes migration, before the first request (rooms load lazily otherwise).
roomContext.run('personal', () => { migrateNotes(); migrateWorkflowBoard(); migrateLinkedNotesBoard(); });
for (const room of accounts.allRooms()) if (room.id !== 'personal') roomContext.run(room.id, () => currentBoard());
for (const name of ['claw', 'lurch']) {
  const room = accounts.bot(name)?.room;
  if (room) roomContext.run(room, () => { migratePendingBotAsks(); reconcileBotReplyLabels(); });
}

server.listen(PORT, '0.0.0.0', () => {
  void checkAllReminders(); // once on start: sends what was missed while down (< 12 h late)
  // eslint-disable-next-line no-console
  console.log(`todos backend listening on 0.0.0.0:${PORT} (token: ${API_TOKEN ? 'on' : 'off'}, login: ${TODOS_USER ? 'on' : 'off'})`);
});

function accountInfo(user) {
  const account = accounts.user(user);
  const enabled = new Set(process.env.BOT_DISPATCH_ENABLED === '1' ? ['sherlock', 'claw', 'lurch'] : String(process.env.BOT_DISPATCH_ENABLED || '').split(','));
  return { user, email: account?.email || null, personalRoom: account?.personalRoom || 'personal', preferences: account?.preferences || {}, botDispatchEnabled: Object.fromEntries(['sherlock', 'claw', 'lurch'].map(name => [name, enabled.has(name)])), rooms: accounts.rooms(user).map(({ id, name, owner, private: personal, bot, members }) => ({ id, name, owner, private: personal, bot, members })) };
}
function roomTopic() {
  if (roomId() === 'personal') return NTFY_TOPIC;
  const file = path.join(storageDir(), 'ntfy-topic');
  try { return fs.readFileSync(file, 'utf8').trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(storageDir(), { recursive: true });
    const topic = 'todos-' + crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(file, topic, { mode: 0o600 });
    return topic;
  }
}
async function checkAllReminders() {
  await roomContext.run('personal', checkReminders);
  for (const room of accounts.allRooms()) if (room.id !== 'personal') await roomContext.run(room.id, checkReminders);
}

let sherlockPolling = false;
const sherlockOffsets = new Map();
const sherlockPoll = setInterval(async () => {
  if (!sherlockConfig || sherlockPolling) return;
  sherlockPolling = true;
  try {
    for (const room of sherlockConfig.rooms || ['personal']) await roomContext.run(room, async () => {
      const bridge = sherlockForRoom();
      const cards = Object.values(kb.state.cards).filter(c => !c.archivedAt && (bridge.hasReference(c) || bridge.tracked().includes(c.id)));
      if (!cards.length) return;
      const offset = sherlockOffsets.get(room) || 0, active = new Set(bridge.active());
      const recent = cards.filter(c => active.has(c.id));
      const selected = recent.length ? Array.from({ length: Math.min(2, recent.length) }, (_, i) => recent[(offset + i) % recent.length]) : [];
      for (let i = 0; i < cards.length && selected.length < 4; i++) { const card = cards[(offset + i) % cards.length]; if (!selected.includes(card)) selected.push(card); }
      for (const card of selected) { try { await bridge.refresh(card.id); } catch (e) { console.error(`[sherlock] ${e.code || 'poll_failed'}`); } }
      sherlockOffsets.set(room, offset + 2);
    });
  } finally { sherlockPolling = false; }
}, Number(process.env.SHERLOCK_POLL_MS) || 30000);
sherlockPoll.unref();
