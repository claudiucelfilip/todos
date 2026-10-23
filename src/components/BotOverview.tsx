import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../lib/types';
import { currentAccount, type Room } from '../lib/account';
import { useDialog } from './SettingsPanel';
import './BotOverview.css';

type BotRoom = Room & { bot: 'sherlock' | 'claw' | 'lurch' };
type RoomBoard = { room: BotRoom; cards: Card[]; error?: string };

const wiki = (card: Card) => /^(wiki|sherlock):/.test(card.ext?.key || '');
const scheduled = (card: Card) => /^cron:/.test(card.ext?.key || '');
const blocked = (card: Card) => /^Blocked:/im.test(card.notes || '') || /^Outcome: (Failed|Unknown)/im.test(card.notes || '');
const stale = (card: Card) => card.status === 'doing' && Date.now() - Date.parse(card.updatedAt) > (wiki(card) ? 7 : 2) * 24 * 60 * 60 * 1000;
const age = (iso: string) => {
  const hours = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 3600000));
  return hours < 1 ? 'just now' : hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};
const cardHref = (room: Room, card: Card) => `/?room=${encodeURIComponent(room.id)}#card/${encodeURIComponent(card.id)}`;

export default function BotOverview({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const account = currentAccount();
  const rooms = (account?.rooms.filter((room): room is BotRoom => !!room.bot) || []).sort((a, b) => a.name.localeCompare(b.name));
  const [boards, setBoards] = useState<RoomBoard[]>([]);
  const [loading, setLoading] = useState(true);
  useDialog(ref, onClose);

  useEffect(() => {
    let live = true;
    const refresh = async () => {
      const result = await Promise.all(rooms.map(async room => {
        try {
          const response = await fetch(`/kanban/snapshot?room=${encodeURIComponent(room.id)}`, { credentials: 'same-origin' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          return { room, cards: data.cards as Card[] };
        } catch (error) { return { room, cards: [], error: (error as Error).message }; }
      }));
      if (live) { setBoards(result); setLoading(false); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => { live = false; window.clearInterval(timer); };
  }, []);

  const all = boards.flatMap(board => board.cards.filter(card => !card.archivedAt && card.kind !== 'note').map(card => ({ room: board.room, card })));
  const active = all.filter(({ card }) => card.status === 'doing' && !wiki(card));
  const wikiActive = all.filter(({ card }) => card.status === 'doing' && wiki(card));
  const attention = all.filter(({ card }) => !wiki(card) && (blocked(card) || stale(card)));
  return createPortal(<div className="dialog-backdrop" onClick={onClose}>
    <div ref={ref} className="dialog bot-overview" role="dialog" aria-modal="true" aria-label="All bots" tabIndex={-1} onClick={event => event.stopPropagation()}>
      <header className="dialog-head bot-overview-head">
        <div><span className="bot-overview-kicker">WORKSPACES</span><h2>All bots</h2></div>
        <button type="button" className="bot-overview-close" aria-label="Close All bots" onClick={onClose}>×</button>
      </header>
      <div className="dialog-body bot-overview-body">
        {loading ? <p className="bot-overview-empty">Loading bot workspaces…</p> : <>
          <div className="bot-overview-stats" aria-label="Bot work summary">
            <span><strong>{active.length}</strong> doing</span>
            <span><strong>{attention.length}</strong> need attention</span>
            <span><strong>{all.filter(({ card }) => card.status === 'todo' && !scheduled(card) && !wiki(card)).length}</strong> queued</span>
            <span><strong>{wikiActive.length}</strong> engaged wiki</span>
          </div>
          {boards.map(({ room, cards, error }) => {
            const work = cards.filter(card => !card.archivedAt && card.kind !== 'note');
            const doing = work.filter(card => card.status === 'doing' && !wiki(card)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            const engaged = work.filter(card => card.status === 'doing' && wiki(card)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            const queue = work.filter(card => card.status === 'todo' && !scheduled(card) && !wiki(card));
            const jobs = work.filter(scheduled);
            return <section key={room.id} className="bot-overview-room" aria-label={`${room.name} workspace`}>
              <div className="bot-overview-room-head">
                <div><h3>{room.name}</h3><p>{account?.botDispatchEnabled?.[room.bot] ? 'Task pickup on' : 'Task pickup paused'} · {queue.length} queued · {jobs.length} scheduled{room.bot === 'sherlock' ? ` · ${work.filter(wiki).length} wiki items` : ''}</p></div>
                <a href={`/?room=${encodeURIComponent(room.id)}`}>Open board ↗</a>
              </div>
              {error ? <p className="bot-overview-error">Could not load this workspace: {error}</p> : <>
                <div className="bot-overview-list-label">In progress <span>{doing.length}</span></div>
                {doing.length ? <div className="bot-overview-list">{doing.map(card => <a key={card.id} className="bot-overview-item" href={cardHref(room, card)}>
                  <span className="bot-overview-title">{card.title || 'Untitled'}</span>
                  <span className="bot-overview-meta">{blocked(card) ? <b className="bot-overview-flag">Blocked</b> : stale(card) ? <b className="bot-overview-flag">Stale</b> : null}{age(card.updatedAt)}</span>
                </a>)}</div> : <p className="bot-overview-empty">Nothing in progress.</p>}
                {engaged.length > 0 && <details className="bot-overview-jobs"><summary>Engaged wiki items <span>{engaged.length}</span></summary><div className="bot-overview-list">{engaged.map(card => <a key={card.id} className="bot-overview-item" href={cardHref(room, card)}><span className="bot-overview-title">{card.title || 'Untitled'}</span><span className="bot-overview-meta">{age(card.updatedAt)}</span></a>)}</div></details>}
                {jobs.length > 0 && <details className="bot-overview-jobs"><summary>Scheduled runs <span>{jobs.length}</span></summary><div className="bot-overview-list">{jobs.map(card => {
                  const outcome = card.notes.match(/^Outcome: (.+)$/m)?.[1] || 'No run recorded';
                  return <a key={card.id} className="bot-overview-item" href={cardHref(room, card)}><span className="bot-overview-title">{card.title}</span><span className="bot-overview-meta">{blocked(card) ? <b className="bot-overview-flag">Needs attention</b> : null}{outcome}</span></a>;
                })}</div></details>}
              </>}
            </section>;
          })}
        </>}
      </div>
    </div>
  </div>, document.body);
}
