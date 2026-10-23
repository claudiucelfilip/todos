import { bodyLinks } from './notes.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const REPLY_LABEL = { id: 'sherlock:replied', name: 'Sherlock replied', color: '#66D2B0', removeOnView: true };
const tsValue = value => Number(value || 0);
const slackRef = card => {
  if (card.ext?.slackChannel && card.ext?.slackTs) return { channel: card.ext.slackChannel, ts: card.ext.slackTs };
  for (const link of [...(card.links ?? []), ...bodyLinks(card.notes)]) {
    try {
      const u = new URL(link.url);
      const match = /^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})$/.exec(u.pathname);
      if (u.protocol === 'https:' && /(^|\.)slack\.com$/.test(u.hostname) && match) return { channel: match[1], ts: /^\d+\.\d+$/.test(u.searchParams.get('thread_ts') || '') ? u.searchParams.get('thread_ts') : `${match[2]}.${match[3]}` };
    } catch { /* An unrelated link is not a conversation. */ }
  }
  return null;
};
const plain = text => String(text || '').replace(/<([^>|]+)\|([^>]+)>/g, '$2').replace(/<([^>]+)>/g, '$1').replace(/[*_`]/g, '').trim();
export function replySentence(text) {
  const value = plain(text).replace(/^#+\s*/gm, '').replace(/\s+/g, ' ');
  return (value.match(/^.{1,300}?[.!?](?=\s|$)/)?.[0] || value.slice(0, 240) || 'Open the Slack thread to read Sherlock’s response.');
}
export function substantive(message, botUser) {
  if (message.user !== botUser || ['todos_handoff', 'todos_ack'].includes(message.metadata?.event_type) || message.subtype === 'message_deleted') return false;
  const value = plain(message.text);
  if (/^(?:(?:got it|received|on it|sure|okay|ok)[,.!… ]*)$/i.test(value)) return false;
  if (/^(?:(?:sure|got it)[,.! ]*)?(?:i(?:[’']ll| will)|let me) (?:look into (?:it|this)|check(?: (?:it|this))?|take a look)[.!… ]*$/i.test(value)) return false;
  return value.length > 0 && !/^(?:[.!…\s]*|(?:got it[,.! ]*)?(?:i[’']?m )?(?:looking into (?:it|this)|on it|working on (?:it|this)|checking(?: (?:it|this))?)[.!…\s]*)$/i.test(value);
}
export class SherlockError extends Error {
  constructor(code, message, status = 502) { super(message); this.code = code; this.status = status; }
}

/** Delivery receipts stay server-side; clients can only acknowledge a reply they saw. */
export function createSherlock({ file, config, getCard, getLabels, commit, fetcher = fetch }) {
  let db = { notes: {} };
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* First use. */ }
  const locks = new Map();
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(db), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
  let migrated = false;
  for (const n of Object.values(db.notes)) {
    if (!n.boundAt || n.importVersion) continue;
    // Older imports acknowledged their initial answer without a view event.
    if (!n.viewedThrough && !Object.keys(n.requests || {}).length && n.reply?.ts === n.readThrough && tsValue(n.reply.ts) * 1000 <= Date.parse(n.boundAt)) n.readThrough = '0';
    n.importVersion = 1; migrated = true;
  }
  if (migrated) save();
  const locked = (id, task) => {
    const run = (locks.get(id) || Promise.resolve()).catch(() => {}).then(task);
    locks.set(id, run); run.finally(() => { if (locks.get(id) === run) locks.delete(id); }).catch(() => {}); return run;
  };
  const record = id => db.notes[id] ??= { requests: {}, readThrough: '0' };
  const enabled = () => !!(config?.token && config?.webhookUrl && config?.secret && config?.channel && config?.botUser);
  async function slack(method, body) {
    let res;
    const json = method === 'chat.postMessage';
    try { res = await fetcher(`${config.slackBase || 'https://slack.com/api'}/${method}`, { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' }, body: json ? JSON.stringify(body) : new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])), signal: AbortSignal.timeout(config.timeout || 15000) }); }
    catch { throw new SherlockError('SLACK_TIMEOUT', 'Slack connection timed out. Delivery will be checked before retrying.'); }
    let data;
    try { data = await res.json(); } catch { throw new SherlockError('SLACK_TIMEOUT', 'Slack returned an incomplete delivery confirmation. Retry checks the saved request.'); }
    if (!res.ok || !data.ok) {
      const code = String(data.error || `http_${res.status}`).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 80);
      const messages = { missing_scope: 'Sherlock’s Slack connection is missing a required permission.', channel_not_found: 'The original Slack conversation is unavailable.', thread_not_found: 'The original Slack thread was deleted.', message_not_found: 'The original Slack message was deleted.', not_in_channel: 'Sherlock cannot access the original Slack conversation.', invalid_auth: 'Sherlock’s Slack authorization has expired.', ratelimited: 'Slack is limiting requests. Try again shortly.' };
      throw new SherlockError(`SLACK_${code.toUpperCase()}`, messages[code] || `Slack rejected the request (${code}).`);
    }
    return data;
  }
  async function messages(channel, ts) {
    let cursor = '', out = [];
    do {
      const result = await slack(ts ? 'conversations.replies' : 'conversations.history', { channel, ...(ts ? { ts } : {}), limit: 100, include_all_metadata: true, ...(cursor ? { cursor } : {}) });
      out.push(...(result.messages || [])); cursor = result.response_metadata?.next_cursor || '';
      if (out.length >= 1000 && cursor) throw new SherlockError('HISTORY_LIMIT', 'This Slack thread is too long to reconcile safely.');
    } while (cursor);
    return out;
  }
  async function bind(id) {
    const n = record(id), card = getCard(id);
    if (!card) throw new SherlockError('NOTE_NOT_FOUND', 'This note no longer exists.', 404);
    if (!n.channel) {
      const ref = n.ignoreReference ? null : slackRef(card);
      if (ref) {
        let history;
        try { history = await messages(ref.channel, ref.ts); } catch (e) {
          if (!['SLACK_THREAD_NOT_FOUND', 'SLACK_MESSAGE_NOT_FOUND'].includes(e.code)) throw e;
          const found = await slack('conversations.history', { channel: ref.channel, oldest: ref.ts, latest: ref.ts, inclusive: true, limit: 1 });
          const original = found.messages?.find(m => m.ts === ref.ts);
          if (!original?.thread_ts) throw e;
          history = await messages(ref.channel, original.thread_ts);
        }
        const root = history.find(m => m.ts === ref.ts) || history[0];
        n.channel = ref.channel; n.ts = root?.thread_ts || ref.ts;
        n.boundAt = new Date().toISOString(); n.importVersion = 1;
        // A wiki brief may be the root message; discovery does not mean it was read.
        const replies = history.filter(m => substantive(m, config.botUser));
        const last = replies.sort((a, b) => tsValue(a.ts) - tsValue(b.ts)).at(-1);
        if (last) n.reply = { ts: last.ts, summary: replySentence(last.text) };
        save();
      }
    }
    if (n.channel && !n.url) { n.url = (await slack('chat.getPermalink', { channel: n.channel, message_ts: n.ts })).permalink; save(); }
    return n;
  }
  const publicState = n => ({ connected: !!n?.ts, url: n?.url || null, reply: n?.reply || null, unread: !!(n?.reply && tsValue(n.reply.ts) > tsValue(n.readThrough)), pending: n?.pending || false });
  async function refresh(id) {
    const n = await bind(id);
    if (!n.ts) return publicState(n);
    const all = await messages(n.channel, n.ts);
    const engaged = all.some(m => m.ts !== n.ts && m.user && m.user !== config.botUser && !m.bot_id && !m.app_id && !['todos_handoff', 'todos_ack'].includes(m.metadata?.event_type) && plain(m.text));
    const latest = all.filter(m => substantive(m, config.botUser) && m.ts !== n.ts).sort((a, b) => tsValue(a.ts) - tsValue(b.ts)).at(-1);
    if (latest && tsValue(latest.ts) > tsValue(n.reply?.ts)) {
      n.reply = { ts: latest.ts, summary: replySentence(latest.text) }; n.pending = false; save();
    }
    if (n.boundAt && !n.adopted) {
      await commit(id, { imported: true, engaged, channel: n.channel, ts: n.ts }); n.adopted = true; save();
    } else if (n.reply || engaged) await commit(id, { reply: true, engaged });
    return publicState(n);
  }
  async function send(id, request) {
    return locked(id, async () => {
      if (!enabled()) throw new SherlockError('NOT_CONFIGURED', 'Sherlock is not connected on this server.', 503);
      if (!/^[a-zA-Z0-9-]{8,100}$/.test(request.requestId || '') || typeof request.message !== 'string' || request.message.length > 4000) throw new SherlockError('INVALID_REQUEST', 'The message or request identifier is invalid.', 400);
      const n = await bind(id);
      for (const [pendingId, pending] of Object.entries(n.requests)) {
        if (!pending.uncertain || pending.sentTs) continue;
        const history = await messages(pending.channel, n.ts);
        const prior = history.find(m => m.client_msg_id === pendingId || m.metadata?.event_payload?.request_id === pendingId);
        if (!prior) throw new SherlockError('DELIVERY_UNCONFIRMED', 'An earlier message’s Slack delivery is unconfirmed. Retry checks it before starting another thread.');
        pending.sentTs = prior.ts; pending.uncertain = false;
        if (!n.ts) { n.channel = pending.channel; n.ts = prior.thread_ts || prior.ts; }
        save();
      }
      let r = n.requests[request.requestId];
      if (r && r.message !== request.message) throw new SherlockError('REQUEST_CHANGED', 'This retry has different text. Start a new request.', 409);
      if (!r) { r = n.requests[request.requestId] = { message: request.message, readThrough: n.reply?.ts || '0', channel: n.channel || config.channel, attempted: false }; save(); }
      if (!r.sentTs) {
        if (r.attempted) {
          const history = await messages(r.channel, n.ts);
          const prior = history.find(m => m.client_msg_id === request.requestId || m.metadata?.event_payload?.request_id === request.requestId);
          if (prior) r.sentTs = prior.ts;
          // An uncertain write is never repeated automatically if Slack cannot prove its outcome.
          else if (r.uncertain) throw new SherlockError('DELIVERY_UNCONFIRMED', 'Slack delivery is still unconfirmed. Retry checks again without sending a duplicate.');
        }
        if (!r.sentTs) {
          const card = structuredClone(getCard(id));
          const contextKey = c => JSON.stringify({ title: c.title || '', notes: c.notes || '', items: (c.items || []).map(i => [i.id, i.text, !!i.done, i.ref || null]) });
          if (request.context && contextKey(request.context) !== contextKey(card)) throw new SherlockError('NOTE_NOT_SYNCED', 'Your latest note changes haven’t synced yet. Retry once they finish.', 409);
          const prior = n.ts ? (await messages(n.channel, n.ts)).slice(-12).map(m => `${m.user === config.botUser ? 'Sherlock' : 'User'}: ${plain(m.text)}`).join('\n').slice(-6000) : '';
          const noteUrl = config.appUrl ? `${config.appUrl.replace(/\/$/, '')}/?room=${encodeURIComponent(config.room || 'personal')}#card/${encodeURIComponent(id)}` : '';
          const context = `${card.title || 'Untitled note'}\n\n${card.notes || ''}\n\n${(card.items || []).map(i => `- [${i.done ? 'x' : ' '}] ${i.text}`).join('\n')}`;
          r.prompt = `${request.message.trim() || 'Help me move this forward. Suggest the next step and ask if anything is unclear.'}\n\nNote context:\n${context}\n\nNote: ${noteUrl}\n\nPrevious conversation:\n${prior}`;
          r.attempted = true; r.uncertain = true; save();
          try {
            const result = await slack('chat.postMessage', { channel: r.channel, ...(n.ts ? { thread_ts: n.ts } : {}), text: `From Todos · ${r.prompt}`, client_msg_id: request.requestId, metadata: { event_type: 'todos_handoff', event_payload: { request_id: request.requestId } }, unfurl_links: false, unfurl_media: false });
            r.sentTs = result.ts; r.uncertain = false;
          } catch (e) { if (e.code !== 'SLACK_TIMEOUT') r.uncertain = false; save(); throw e; }
        }
        if (!n.ts) { n.channel = r.channel; n.ts = r.sentTs; }
        save();
      }
      if (!r.accepted && r.wakeUncertain) throw new SherlockError('DELIVERY_UNCONFIRMED', 'Sherlock delivery is still unconfirmed. Open the Slack thread to continue; retry will not start duplicate work.');
      if (!r.accepted) {
        const payload = JSON.stringify({ prompt: r.prompt || request.message, channel: n.channel, thread: n.ts, request_id: request.requestId });
        const timestamp = String(Math.floor(Date.now() / 1000));
        let result; r.wakeUncertain = true; save();
        try { result = await fetcher(config.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-ID': request.requestId, 'X-Webhook-Timestamp': timestamp, 'X-Webhook-Signature-V2': crypto.createHmac('sha256', config.secret).update(`${timestamp}.${payload}`).digest('hex') }, body: payload, signal: AbortSignal.timeout(config.timeout || 15000) }); }
        catch { throw new SherlockError('SHERLOCK_TIMEOUT', 'Sherlock connection timed out. Your Slack message is saved; open its thread to continue if delivery cannot be confirmed.'); }
        let response;
        try { response = await result.json(); } catch { throw new SherlockError('DELIVERY_UNCONFIRMED', 'Sherlock returned an incomplete confirmation. Your Slack message is saved; open its thread to continue.'); }
        if (!result.ok || !['accepted', 'duplicate'].includes(response.status)) { r.wakeUncertain = false; save(); throw new SherlockError('SHERLOCK_UNAVAILABLE', `Sherlock did not accept the request (HTTP ${result.status}). Your Slack message is saved.`); }
        r.wakeUncertain = false; r.accepted = true; n.pending = true; n.lastSentAt = Date.now();
        save();
      }
      if (!r.committed) {
        await commit(id, { sent: true, channel: n.channel, ts: n.ts }); r.committed = true; save();
      }
      if (!r.acknowledged) {
        r.acknowledged = true; save();
        try { await slack('chat.postMessage', { channel: n.channel, thread_ts: n.ts, text: 'Looking into it.', metadata: { event_type: 'todos_ack', event_payload: { request_id: request.requestId } } }); } catch { /* Delivery acceptance is already durable. */ }
      }
      if (!n.url) { try { n.url = (await slack('chat.getPermalink', { channel: n.channel, message_ts: n.ts })).permalink; save(); } catch { /* A saved receipt survives permalink failure. */ } }
      return publicState(n);
    });
  }
  function view(id, through) {
    const n = db.notes[id];
    if (!n || !n.reply || typeof through !== 'string' || !/^\d+\.\d+$/.test(through) || !Number.isFinite(tsValue(through)) || tsValue(through) > tsValue(n.reply.ts)) return;
    n.readThrough = String(Math.max(tsValue(n.readThrough), tsValue(through))); n.viewedThrough = n.readThrough; save();
  }
  function unread(id) { const n = db.notes[id]; return !!(n?.reply && tsValue(n.reply.ts) > tsValue(n.readThrough)); }
  return { enabled, send, reset: id => locked(id, async () => { db.notes[id] = { requests: {}, readThrough: '0', ignoreReference: true }; save(); return publicState(db.notes[id]); }), refresh: id => locked(id, () => refresh(id)), state: id => publicState(db.notes[id]), view, unread, tracked: () => Object.keys(db.notes), active: () => Object.entries(db.notes).filter(([, n]) => n.pending || n.lastSentAt > Date.now() - 86400000).map(([id]) => id), hasReference: card => !!slackRef(card) };
}
