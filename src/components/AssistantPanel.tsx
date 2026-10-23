import { useOutsideDismiss } from '../hooks/useOutsideDismiss';
// The assistant shares the detail panel slot, filling the screen on phones.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CloseIcon } from './Icons';
import { currentAccount, currentRoom } from '../lib/account';
import { askAssistant, assistantHistory, type AssistantFocus, type AssistantMessage, type AssistantProgress, type AssistantProposal } from '../lib/assistant';
import { actions, useStore } from '../hooks/useStore';
import { displayTitle } from '../../shared/notes.mjs';
import type { Card } from '../lib/types';
import './AssistantPanel.css';

interface Applied { cardId: string; itemIds: string[]; kind: AssistantProposal['type'] }
interface Saved { messages: AssistantMessage[]; applied: Record<string, Applied> }

// Undo steps live in memory only (the store's undo stack does not survive a reload).
const undoSteps = new Map<string, number>();
const FLASH_MS = 1400;

const ROOM_PROMPTS = ['Plan my day from what is open', 'Break down a card on my board', 'Turn an idea into to dos'];
const CARD_PROMPTS = ['Break this into steps', 'Suggest a first step', 'Turn the notes into a checklist'];

function scopeKey(): string {
  return `kept.assistant:${currentAccount()?.user ?? ''}:${currentRoom()?.id ?? ''}`;
}
function load(key: string): Saved {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null') as Saved | null;
    if (saved && Array.isArray(saved.messages)) return { messages: saved.messages, applied: saved.applied || {} };
  } catch {
    /* storage blocked or corrupt */
  }
  return { messages: [], applied: {} };
}
function save(key: string, value: Saved): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked or full */
  }
}

const Sparkle = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
    <path d="M12 3c.6 4.6 3.4 7.4 8 8-4.6.6-7.4 3.4-8 8-.6-4.6-3.4-7.4-8-8 4.6-.6 7.4-3.4 8-8z" />
  </svg>
);
export { Sparkle as AssistantSparkle };

/** The nearest ancestor that scrolls vertically. */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** §12.5: the changed card gets the selected face and lift for 1.4 s; its column scrolls to show it. */
function flashCard(id: string, bottomLimit: () => number | null): void {
  let tries = 0;
  const run = () => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(`.card-face[data-card-id="${CSS.escape(id)}"], .note-card[data-card-id="${CSS.escape(id)}"]`)).filter(
      (el) => el.offsetParent !== null && !el.closest('[inert]'),
    );
    if (!els.length) {
      if (++tries < 20) setTimeout(run, 30);
      return;
    }
    for (const el of els) {
      el.setAttribute('data-flash', '');
      setTimeout(() => el.removeAttribute('data-flash'), FLASH_MS);
      const box = scroller(el);
      if (!box) continue;
      const r = el.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      // Glass bars float over the scroller's top; a phone sheet covers its bottom.
      const top = Math.max(b.top, 96) + 12;
      const limit = bottomLimit();
      const bottom = Math.min(b.bottom, limit ?? b.bottom) - 16;
      let delta = 0;
      if (r.top < top) delta = r.top - top;
      else if (r.bottom > bottom) delta = Math.min(r.bottom - bottom, r.top - top);
      if (delta) box.scrollTo({ top: box.scrollTop + delta, behavior: 'smooth' });
    }
  };
  setTimeout(run, 30); // after React commits the new card
}

interface Props {
  phone: boolean;
  /** §12.2: the card the conversation is about (selected or opened from a card), or null for the room. */
  focusId: string | null;
  onClearFocus(): void;
  onClose(): void;
  onOpenCard(id: string): void;
  /** The phone shows one column: bring the card's column into view. */
  onReveal?(card: Card): void;
}

export default function AssistantPanel({ phone, focusId, onClearFocus, onClose, onOpenCard, onReveal }: Props) {
  const store = useStore();
  const { readOnly } = store;
  const key = scopeKey();
  const [saved, setSaved] = useState<Saved>(() => load(key));
  const { messages, applied } = saved;
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<AssistantProgress>('working');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const root = useRef<HTMLElement>(null);
  useOutsideDismiss(root, onClose);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<AbortController | null>(null);
  const scope = useRef(key);

  // A room switch brings that room's conversation.
  useEffect(() => {
    if (scope.current === key) return;
    pending.current?.abort();
    scope.current = key;
    setSaved(load(key));
    setError('');
  }, [key]);
  // Saved synchronously, so a 'New' or an answer just before closing is never lost.
  const current = useRef(saved);
  current.current = saved;
  const update = (fn: (s: Saved) => Saved) => {
    const next = fn(current.current);
    current.current = next;
    save(scope.current, next);
    setSaved(next);
  };

  useEffect(() => () => pending.current?.abort(), []);
  // Opening takes focus (§11.20, journey 24); again next frame, since closing the card panel restores its own focus.
  useEffect(() => {
    const take = () => {
      if (!root.current?.contains(document.activeElement)) input.current?.focus({ preventScroll: true });
    };
    take();
    const frame = requestAnimationFrame(take);
    return () => cancelAnimationFrame(frame);
  }, [phone]);
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setSeconds(0);
    const t = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);
  useLayoutEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy, error]);

  // Start on one line and grow with the message.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 36), 140)}px`;
  }, [draft]);

  const focusCard = focusId ? (store.cards.find((c) => c.id === focusId) ?? null) : null;
  const focus: AssistantFocus | null = useMemo(
    () => (focusCard ? { id: focusCard.id, title: displayTitle(focusCard), notes: focusCard.notes || '', items: focusCard.items.map((i) => ({ text: i.text, done: i.done })) } : null),
    [focusCard],
  );

  async function send(text = draft) {
    const message = text.trim();
    if (!message || pending.current || readOnly) return;
    const history = assistantHistory(messages);
    update((s) => {
      const last = s.messages[s.messages.length - 1];
      const keep = last?.failed && last.content === message ? s.messages.slice(0, -1) : s.messages;
      return { ...s, messages: [...keep, { role: 'user', content: message }] };
    });
    setDraft('');
    setError('');
    setBusy(true);
    setProgress('working');
    const controller = new AbortController();
    pending.current = controller;
    try {
      const result = await askAssistant(message, history, controller.signal, setProgress, { focus });
      if (pending.current !== controller) return;
      update((s) => ({ ...s, messages: [...s.messages, { role: 'assistant', content: result.reply, proposals: result.proposals }] }));
    } catch (e) {
      if (pending.current !== controller) return;
      update((s) => ({ ...s, messages: s.messages.map((m, i) => (i === s.messages.length - 1 && m.role === 'user' ? { ...m, failed: true } : m)) }));
      setError(controller.signal.aborted ? 'Request stopped. You can ask again.' : e instanceof Error ? e.message : 'Could not reach the assistant.');
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  const stop = () => pending.current?.abort();
  const retry = () => {
    const last = messages[messages.length - 1];
    if (last?.role === 'user' && last.failed) void send(last.content);
  };
  const reset = () => {
    pending.current?.abort();
    pending.current = null;
    setBusy(false);
    setError('');
    setDraft('');
    update(() => ({ messages: [], applied: {} }));
    input.current?.focus({ preventScroll: true });
  };

  // An applied suggestion stays applied while its card (or one of its new steps) is on the board.
  const live = (a: Applied | undefined): a is Applied => {
    if (!a) return false;
    const card = store.cards.find((c) => c.id === a.cardId);
    if (!card) return false;
    return a.kind === 'create' || card.items.some((i) => a.itemIds.includes(i.id));
  };

  function apply(proposal: AssistantProposal, pkey: string) {
    if (live(applied[pkey])) return;
    if (scope.current !== scopeKey() || readOnly) {
      setError('Return to the original room to apply this suggestion.');
      return;
    }
    try {
      const done = actions.applyAssistantProposal(proposal);
      undoSteps.set(`${scope.current}#${pkey}`, done.snap);
      update((s) => ({ ...s, applied: { ...s.applied, [pkey]: { cardId: done.cardId, itemIds: done.itemIds, kind: proposal.type } } }));
      setError('');
      const card = actions.column('todo').concat(actions.column('doing')).find((c) => c.id === done.cardId);
      if (card) onReveal?.(card);
      flashCard(done.cardId, () => null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not apply this suggestion.');
    }
  }
  function undo(pkey: string) {
    const snap = undoSteps.get(`${scope.current}#${pkey}`);
    if (snap != null) actions.undoSnap(snap);
    undoSteps.delete(`${scope.current}#${pkey}`);
    update((s) => {
      const next = { ...s.applied };
      delete next[pkey];
      return { ...s, applied: next };
    });
  }

  const hello = focus ? 'What should we do with this card?' : 'What would help right now?';
  const prompts = focus ? CARD_PROMPTS : ROOM_PROMPTS;
  const status =
    progress === 'reconnecting'
      ? 'Reconnecting…'
      : progress === 'waiting' || progress === 'queued'
        ? 'Waiting for the assistant service…'
        : 'Working on your request';
  const lastFailed = messages[messages.length - 1]?.failed;

  return (
    <section
      ref={root}
      className={`assistant-panel${phone ? ' assistant-sheet' : ''}`}
      role="complementary"
      aria-label="Assistant"
      data-testid="assistant"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="assistant-viewport">
        <header className="assistant-head">
          <span className="assistant-tile" aria-hidden>
            <Sparkle />
          </span>
          <div className="assistant-titles">
            <h2>Assistant</h2>
            <span className="mono">{currentRoom()?.name || 'Personal'} · Assistant on this server</span>
          </div>
          <button type="button" className="assistant-new" onClick={reset} title="New conversation" data-testid="assistant-new">
            New
          </button>
          <button type="button" className="assistant-close" onClick={onClose} aria-label="Close assistant" data-testid="assistant-close">
            <CloseIcon size={20} />
          </button>
        </header>
        {focus && (
          <div className="assistant-context">
            <span className="assistant-chip" data-testid="assistant-context">
              <span className="assistant-chip-box" aria-hidden />
              <span className="assistant-chip-text">About: {focus.title}</span>
              <button type="button" onClick={onClearFocus} aria-label="Ask about the whole room instead">
                ×
              </button>
            </span>
          </div>
        )}
        <div className="assistant-list" ref={list}>
          {!messages.length && (
            <div className="assistant-empty">
              <h3>{hello}</h3>
              <p>I read the cards in this room and suggest. Nothing changes until you add it.</p>
              <div className="assistant-prompts">
                {prompts.map((p) => (
                  <button key={p} type="button" onClick={() => void send(p)} disabled={busy || readOnly}>
                    <span>{p}</span>
                    <span className="assistant-enter" aria-hidden>
                      ↵
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, mi) =>
            m.role === 'user' ? (
              <div key={mi} className="assistant-you">
                {m.content}
              </div>
            ) : (
              <div key={mi} className="assistant-reply">
                <p>{m.content}</p>
                {m.proposals?.map((p, pi) => {
                  const pkey = `${mi}:${pi}`;
                  const a = applied[pkey];
                  const isLive = live(a);
                  const target = p.type === 'checklist' ? store.cards.find((c) => c.id === p.cardId) : null;
                  const targetTitle = target ? displayTitle(target) : p.title;
                  const steps = p.type === 'create' ? p.items.slice(0, 8) : p.items;
                  const canUndo = isLive && undoSteps.has(`${scope.current}#${pkey}`);
                  return (
                    <div key={pkey} className="assistant-proposal" data-testid="assistant-proposal">
                      <div className="assistant-kind mono">
                        {p.type === 'create' ? 'New task' : 'Add checklist steps'}
                        {p.type === 'checklist' && <span>→ {targetTitle}</span>}
                      </div>
                      <div className={`assistant-preview${isLive ? ' applied' : ''}`}>
                        {p.type === 'create' && (
                          <div className="assistant-preview-title">
                            <span>{p.title}</span>
                            <span className="assistant-ring" aria-hidden>
                              <span />
                            </span>
                          </div>
                        )}
                        {p.type === 'create' && p.notes && <div className="assistant-preview-notes">{p.notes}</div>}
                        {steps.length > 0 && (
                          <ul>
                            {steps.map((s, si) => (
                              <li key={si}>
                                <span className="assistant-step-ring" aria-hidden />
                                <span className="assistant-step-text">{s}</span>
                                {p.type === 'checklist' && (
                                  <span className="assistant-plus" aria-hidden>
                                    +
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div className="assistant-actions">
                        {isLive ? (
                          <>
                            <span className="assistant-done">✓ {p.type === 'create' ? 'Added to To do' : `Added to ${targetTitle}`}</span>
                            <button type="button" className="assistant-link" onClick={() => onOpenCard(a.cardId)}>
                              Open
                            </button>
                            {canUndo && (
                              <button type="button" className="assistant-link muted" onClick={() => undo(pkey)}>
                                Undo
                              </button>
                            )}
                          </>
                        ) : (
                          <>
                            <button type="button" className="assistant-apply" onClick={() => apply(p, pkey)} disabled={readOnly}>
                              {p.type === 'create' ? 'Add to To do' : `Add ${p.items.length} ${p.items.length === 1 ? 'step' : 'steps'}`}
                            </button>
                            <span className="assistant-where mono">{p.type === 'create' ? 'top of To do' : `to ${targetTitle}`}</span>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ),
          )}
          {busy && (
            <div className="assistant-progress" role="status">
              <span className="assistant-dot" aria-hidden />
              <span className="assistant-progress-text">
                {status} · {seconds} s
              </span>
              <button type="button" onClick={stop}>
                Stop
              </button>
            </div>
          )}
          {(error || (lastFailed && !busy)) && (
            <p className="assistant-error" role="alert">
              {error || 'This message was not answered.'}
              {lastFailed && !busy && (
                <>
                  {' '}
                  <button type="button" onClick={retry}>
                    Try again
                  </button>
                </>
              )}
            </p>
          )}
        </div>
        <form
          className="assistant-compose"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="assistant-field">
            <label className="sr-only" htmlFor="assistant-input">
              Ask the assistant
            </label>
            <textarea
              ref={input}
              id="assistant-input"
              rows={1}
              maxLength={2000}
              placeholder={focus ? 'Ask about this card…' : 'What would you like help with?'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // §12.6: Enter sends, Shift+Enter is a new line (a chat message is a turn, not a note).
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {busy ? (
              <button key="stop" type="button" className="assistant-send" onClick={stop} aria-label="Stop" title="Stop">
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
                  <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
                </svg>
              </button>
            ) : (
              <button key="send" type="submit" className="assistant-send" disabled={!draft.trim() || readOnly} aria-label="Send" title="Send">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
          <div className="assistant-foot mono">Nothing changes until you add it · ↵ send · ⇧↵ new line</div>
        </form>
      </div>
    </section>
  );
}
