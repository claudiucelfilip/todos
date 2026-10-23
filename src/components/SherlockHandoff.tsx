import { flushSync } from 'react-dom';
import { useCallback, useEffect, useRef, useState, type RefObject, type ReactNode } from 'react';
import type { Card } from '../lib/types';
import { scopedKey } from '../lib/account';
import { apiFetch } from '../lib/sync';
import { sync } from '../lib/sync-boot';
import { state, useStore } from '../hooks/useStore';
import { AssistantSparkle } from './AssistantPanel';
import './SherlockHandoff.css';

interface Connection { recovery?: boolean; available: boolean; connected: boolean; url?: string | null; reply?: { ts: string; summary: string } | null; unread?: boolean; pending?: boolean }
interface Failure { error: string; code: string; requestId: string; time: string }
const REPLIED = 'sherlock:replied';
function readDraft(key: string): { message: string; requestId: string; failure?: Failure } {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return { message: '', requestId: '' }; }
}

/** A background tab or an offscreen section is not a view. */
export function useVisible(ref: RefObject<HTMLElement>, active = true) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) { setVisible(false); return; }
    let intersecting = false;
    const update = () => setVisible(intersecting && document.visibilityState === 'visible' && document.hasFocus());
    const observer = new IntersectionObserver(entries => { intersecting = entries[0].isIntersecting && entries[0].intersectionRatio >= .25; update(); }, { threshold: [0, .25] });
    if (ref.current) observer.observe(ref.current);
    document.addEventListener('visibilitychange', update); window.addEventListener('focus', update); window.addEventListener('blur', update);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); window.removeEventListener('focus', update); window.removeEventListener('blur', update); };
  }, [ref, active]);
  return visible;
}
export function useNoteView(card: Card, ref: RefObject<HTMLElement>, readOnly: boolean) {
  const { labels } = useStore();
  const visible = useVisible(ref);
  const targets = card.labels.filter(id => !['sherlock:replied', 'claw:replied', 'lurch:replied'].includes(id) && labels.find(l => l.id === id)?.removeOnView);
  const key = `${card.id}:${card.updatedAt}:${targets.join()}`;
  useEffect(() => {
    if (!visible || readOnly || !targets.length || card.draft) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) void apiFetch('/kanban/note-view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: card.id, labels: targets, updatedAt: card.updatedAt }) }).then(res => { if (res.ok) sync.hint(); }).catch(() => {});
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [visible, readOnly, key]);
}

function OpenButton({ onOpen, children, className, disabled = false }: { onOpen(): void; children: ReactNode; className: string; disabled?: boolean }) {
  const touch = useRef<{ x: number; y: number } | null>(null);
  return <button type="button" className={className} disabled={disabled} onClick={onOpen}
    onTouchStart={e => { const p = e.touches[0]; touch.current = p ? { x: p.clientX, y: p.clientY } : null; }}
    onTouchMove={e => { const p = e.touches[0], start = touch.current; if (!p || (start && Math.hypot(p.clientX - start.x, p.clientY - start.y) > 8)) touch.current = null; }}
    onTouchCancel={() => { touch.current = null; }}
    onTouchEnd={e => {
      if (!touch.current || disabled) return;
      touch.current = null;
      // Open before Safari can retarget its delayed click after the sheet moves.
      e.preventDefault(); onOpen();
    }}>{children}</button>;
}

export default function SherlockHandoff({ card, beforeSend }: { card: Card; beforeSend(): void }) {
  const wikiCapture = /^(wiki|sherlock):/.test(card.ext?.key || '');
  const key = scopedKey(`todos.sherlock.draft:${card.id}`);
  const initial = readDraft(key);
  const [draft, setDraft] = useState(initial.message || '');
  const [requestId, setRequestId] = useState(initial.requestId || '');
  const [failure, setFailure] = useState<Failure | null>(initial.failure || null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [open, setOpen] = useState(!!initial.message || !!initial.failure);
  const [sending, setSending] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [notice, setNotice] = useState('');
  const section = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const replyRef = useRef<HTMLParagraphElement>(null);
  const visible = useVisible(replyRef, !!connection?.reply);
  const { labels } = useStore();
  const removeOnView = labels.find(l => l.id === REPLIED)?.removeOnView === true;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    try { if (draft || requestId || failure) localStorage.setItem(key, JSON.stringify({ message: draft, requestId, failure })); else localStorage.removeItem(key); } catch { /* The visible draft still survives panel edits. */ }
  }, [key, draft, requestId, failure]);
  const refresh = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const response = await apiFetch(`/kanban/sherlock?id=${encodeURIComponent(card.id)}`, { signal: AbortSignal.timeout(20000) });
      const data = await response.json();
      if (!mounted.current) return;
      if (response.ok) { setConnection(data); sync.hint(); }
      else if (data.connected !== undefined) { setConnection(c => ({ ...c, ...data, available: true })); setNotice(data.error || 'Could not check the conversation.'); }
    } catch { /* Keep the last successful conversation visible offline. */ }
  }, [card.id]);
  useEffect(() => {
    void refresh(); const timer = setInterval(() => void refresh(), 15000);
    const resume = () => void refresh(); document.addEventListener('visibilitychange', resume); window.addEventListener('online', resume);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', resume); };
  }, [refresh]);
  const through = connection?.reply?.ts;
  useEffect(() => {
    if (!visible || !removeOnView || !connection?.unread || !through) return;
    const timer = setTimeout(() => {
      void apiFetch('/kanban/note-view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: card.id, labels: [REPLIED], replyThrough: through, updatedAt: card.updatedAt }) }).then(res => {
        if (res.ok && mounted.current) { setConnection(c => c?.reply?.ts === through ? { ...c, unread: false } : c); sync.hint(); }
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [visible, removeOnView, through, connection?.unread, card.id, card.updatedAt]);
  function expand() {
    // iOS opens its keyboard only while focus remains inside the tap handler.
    flushSync(() => setOpen(true)); input.current?.focus({ preventScroll: true });
  }
  async function send() {
    if (sending) return;
    const id = requestId || crypto.randomUUID();
    setRequestId(id); setSending(true); setNotice(''); beforeSend();
    try {
      await sync.sync();
      // A run already in flight may have captured its outbox before this edit.
      await sync.sync();
      if (sync.status.lastError || sync.status.pending > 0) throw { error: 'Your latest changes haven’t synced yet. Check your connection and retry.', code: 'NOTE_NOT_SYNCED' };
      const latest = state.board.cards.find(c => c.id === card.id) || card;
      const context = { title: latest.title, notes: latest.notes, items: latest.items };
      const response = await apiFetch('/kanban/sherlock/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: card.id, message: draft, requestId: id, context }), signal: AbortSignal.timeout(40000) });
      const data = await response.json();
      if (!response.ok) throw { error: data.error || 'Sherlock could not accept the request.', code: data.code || `HTTP_${response.status}`, requestId: id, time: data.time || new Date().toISOString() };
      try { localStorage.removeItem(key); } catch { /* Delivery succeeded even if local storage is unavailable. */ }
      sync.hint();
      if (!mounted.current) return;
      setConnection(data); setDraft(''); setRequestId(''); setFailure(null); setOpen(false); setNotice('Sent to Sherlock.');
    } catch (e) {
      const detail = e as Partial<Failure>;
      const fail = { error: detail.error || 'The connection was interrupted. Retry checks the saved request before sending again.', code: detail.code || 'CONNECTION_INTERRUPTED', requestId: id, time: detail.time || new Date().toISOString() };
      try { localStorage.setItem(key, JSON.stringify({ message: draft, requestId: id, failure: fail })); } catch { /* Retain the in-memory draft. */ }
      if (mounted.current) setFailure(fail);
    } finally { if (mounted.current) setSending(false); }
  }
  const diagnostics = failure ? `Time: ${failure.time}\nCode: ${failure.code}\nRequest ID: ${failure.requestId}\nDiagnostic: ${failure.error}` : '';
  async function copyError() {
    try { await navigator.clipboard.writeText(diagnostics); setNotice('Error details copied.'); }
    catch { setNotice('Select and copy the technical details below.'); section.current?.querySelector('details')?.setAttribute('open', ''); }
  }
  if (!connection?.available || card.draft) return null;
  const uncertain = !!failure && ['SLACK_TIMEOUT', 'DELIVERY_UNCONFIRMED', 'SHERLOCK_TIMEOUT', 'CONNECTION_INTERRUPTED', 'SHERLOCK_UNAVAILABLE'].includes(failure.code);
  return <section ref={section} className="sh-handoff" aria-label="Sherlock">
    {connection.connected && <>
      <div className="sh-linked">
        <strong className="sh-identity"><AssistantSparkle size={18} />{connection.unread ? 'Sherlock replied' : 'Sherlock'}</strong>
        {!open && <OpenButton className="sh-follow" onOpen={expand}>Send follow-up</OpenButton>}
      </div>
      {connection.reply && <p ref={replyRef} className="sh-summary">{connection.reply.summary}</p>}
      {!connection.reply && connection.pending && <p className="sh-context">Sherlock accepted your request. Replies will appear here.</p>}
      {connection.url ? <a className="sh-thread" href={connection.url} target="_blank" rel="noopener noreferrer">Open Slack thread</a> : <p className="sh-context">Slack conversation linked.</p>}
    </>}
    {connection.recovery && <div className="sh-recovery"><p className="sh-context">The original conversation is unavailable. You can start a new thread with this note.</p><OpenButton className="sh-follow" disabled={recovering} onOpen={async () => { expand(); setRecovering(true); try { const res = await apiFetch('/kanban/sherlock/new-thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: card.id }) }); if (!res.ok) throw new Error(); setConnection(await res.json()); setNotice(''); } catch { setNotice('Could not start a new thread. Your draft is saved. Try again.'); } finally { setRecovering(false); } }}>Start a new thread</OpenButton></div>}
    {!connection.recovery && !connection.connected && !open && <div className="sh-ready"><div><strong><AssistantSparkle size={18} />Sherlock</strong><p>Get help moving this forward.</p></div><OpenButton className="sh-send" onOpen={expand}>Ask Sherlock</OpenButton></div>}
    {open && <>
      <div className="sh-heading"><strong>{connection.connected ? 'Follow up with Sherlock' : 'Ask Sherlock'}</strong><button type="button" className="sh-follow" disabled={sending} onClick={() => setOpen(false)}>Cancel</button></div>
      <p className="sh-context">{connection.connected ? 'Sends to the same Slack thread.' : 'Includes this note and its checklist.'}</p>
      <div className="sh-composer"><textarea ref={input} aria-label="Message to Sherlock" placeholder={connection.connected ? 'What would you like to add?' : 'What would you like Sherlock to do?'} value={draft} readOnly={sending || uncertain} maxLength={4000} onChange={e => { setDraft(e.target.value); if (failure) { setFailure(null); setRequestId(''); } e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = `${Math.max(66, e.currentTarget.scrollHeight)}px`; }} />
        <div className="sh-send-row"><small>{wikiCapture ? 'Your reply marks this item in progress.' : connection.connected ? 'Moves this note to To do.' : 'Adds Sherlock · moves to To do'}</small><button type="button" className="sh-send" disabled={sending || recovering || connection.recovery} onClick={() => void send()}>{sending ? 'Sending…' : failure ? 'Retry' : 'Send to Sherlock'}</button></div>
      </div>
      {failure && <><p className="sh-error" role="alert"><strong>Couldn’t send: {failure.error}</strong><span>Your message is saved. Try again.</span></p><button type="button" className="sh-copy" onClick={() => void copyError()}>Copy error details</button><details className="sh-diagnostics"><summary>Technical details</summary><pre>{diagnostics}</pre></details></>}
    </>}
    {notice && <p className="sh-context" role="status">{notice}</p>}
  </section>;
}
