import { useCallback, useEffect, useRef, useState } from 'react';
import type { Card } from '../lib/types';
import { currentAccount, currentRoom, scopedKey } from '../lib/account';
import { apiFetch } from '../lib/sync';
import { sync } from '../lib/sync-boot';
import { useStore } from '../hooks/useStore';
import { AssistantSparkle } from './AssistantPanel';
import { useVisible } from './SherlockHandoff';
import './SherlockHandoff.css';
import './BotDelegation.css';

type Bot = 'claw' | 'lurch';
type Request = { requestId: string; message: string; status: 'queued' | 'doing' | 'done' | 'blocked'; reply?: string; seenAt?: string };
const label = (bot: Bot) => bot[0].toUpperCase() + bot.slice(1);

export default function BotDelegation({ card, beforeSend }: { card: Card; beforeSend(): void }) {
  const account = currentAccount();
  const ownBot = currentRoom()?.bot;
  const bot: Bot | null = ownBot === 'claw' || ownBot === 'lurch' ? ownBot : null;
  const [requests, setRequests] = useState<Request[]>([]);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [requestId, setRequestId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const replyRef = useRef<HTMLParagraphElement>(null);
  const { labels } = useStore();
  const unread = requests.filter(request => request.reply && !request.seenAt);
  const latestUnread = unread[unread.length - 1]?.requestId;
  const visible = useVisible(replyRef, !!latestUnread && !open);
  const removeOnView = labels.find(item => item.id === `${bot}:replied`)?.removeOnView === true;
  const key = bot ? scopedKey(`todos.bot.draft:${card.id}:${bot}`) : '';

  const refresh = useCallback(async () => {
    if (!bot || card.draft) return;
    try {
      const response = await apiFetch(`/kanban/bots/conversation?id=${encodeURIComponent(card.id)}`);
      if (response.ok) setRequests((await response.json()).requests);
    } catch { /* Keep the last conversation visible offline. */ }
  }, [bot, card.id, card.draft]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!bot || !visible || !removeOnView || !latestUnread) return;
    const timer = window.setTimeout(() => {
      void apiFetch('/kanban/bots/conversation/view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: card.id, through: latestUnread }) }).then(async response => {
        if (response.ok) { setRequests((await response.json()).requests); sync.hint(); }
      }).catch(() => {});
    }, 500);
    return () => window.clearTimeout(timer);
  }, [bot, card.id, visible, removeOnView, latestUnread]);

  if (!bot || card.draft) return null;
  function expand() {
    setOpen(true); setError('');
    setMessage(localStorage.getItem(key) || '');
  }
  async function send() {
    if (!bot || !message.trim() || busy) return;
    const id = requestId || crypto.randomUUID();
    setRequestId(id); setBusy(true); setError(''); beforeSend();
    try {
      await sync.sync();
      await sync.sync();
      if (sync.status.lastError || sync.status.pending > 0) throw new Error('Your latest changes haven’t synced yet. Check your connection and retry.');
      const response = await apiFetch('/kanban/bots/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bot, id: card.id, message, requestId: id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not send the request.');
      setRequests(result.requests); localStorage.removeItem(key);
      setMessage(''); setRequestId(''); setOpen(false);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="bot-delegation sh-handoff" aria-label={`${label(bot)} conversation`}>
    {!open && (requests.length ? <>
      <div className="sh-linked"><strong className="sh-identity"><AssistantSparkle size={18} />{label(bot)}</strong><button type="button" className="sh-follow" onClick={expand}>Ask again</button></div>
      <div className="bot-conversation">{requests.map(request => <div className="bot-exchange" key={request.requestId}>
        <p className="bot-message"><span>You</span>{request.message}</p>
        {request.reply ? <p ref={request.requestId === latestUnread ? replyRef : undefined} className="sh-summary"><span>{label(bot)}</span>{request.reply}</p> : <p className="sh-context" role="status">{request.status === 'doing' ? `${label(bot)} is working on this.` : account?.botDispatchEnabled?.[bot] ? `Queued for ${label(bot)}.` : `Queued for ${label(bot)} while task pickup is paused.`}</p>}
      </div>)}</div>
    </> : <div className="sh-ready"><div><strong><AssistantSparkle size={18} />{label(bot)}</strong><p>Get help moving this forward.</p></div><button type="button" className="sh-send" onClick={expand}>Ask {label(bot)}</button></div>)}
    {open && <>
      <div className="sh-heading"><strong>Ask {label(bot)}</strong><button type="button" className="sh-follow" disabled={busy} onClick={() => setOpen(false)}>Cancel</button></div>
      <p className="sh-context">Your message and {label(bot)}’s reply stay on this card.{!account?.botDispatchEnabled?.[bot] ? ' Task pickup is paused.' : ''}</p>
      <div className="sh-composer"><textarea aria-label={`Message to ${label(bot)}`} maxLength={4000} value={message} placeholder={`What would you like ${label(bot)} to do?`} onChange={event => { setMessage(event.target.value); setRequestId(''); localStorage.setItem(key, event.target.value); }} />
        <div className="sh-send-row"><button className="sh-send" type="button" disabled={busy || !message.trim()} onClick={() => void send()}>{busy ? 'Sending…' : `Send to ${label(bot)}`}</button></div>
      </div>
      {error && <p className="bot-delegation-error sh-context" role="alert">{error}</p>}
    </>}
  </section>;
}
