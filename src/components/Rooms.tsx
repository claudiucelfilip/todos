import { LABEL_PALETTE, pillVars } from '../lib/labels';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { accountRequest, currentAccount, currentRoom, refreshAccount, switchRoom, type Room as AccountRoom } from '../lib/account';
import { sync } from '../lib/sync-boot';
import { menuPosition } from '../lib/menu-position';
import { useDropdownPresence } from '../hooks/useDropdownPresence';
import BotOverview from './BotOverview';

type IconName = 'home' | 'people' | 'chevron' | 'check' | 'plus' | 'back' | 'close' | 'link' | 'more';
function RoomIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    home: <><path d="m3 10 9-7 9 7v10H3Z" /><path d="M9 20v-7h6v7" /></>,
    people: <><circle cx="9" cy="7" r="3" /><path d="M3 20v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v3" /></>,
    chevron: <path d="m6 9 6 6 6-6" />, check: <path d="m5 12 4 4L19 6" />,
    plus: <path d="M12 4v16M4 12h16" />, back: <path d="m12 5-7 7 7 7M5 12h15" />,
    close: <path d="m6 6 12 12M6 18 18 6" />, link: <><path d="m10 13 4-4m-5 6-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" /></>,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  };
  return <svg className="rooms-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function RoomIdentity({ room }: { room: AccountRoom }) {
  if (room.private) return <RoomIcon name="home" />;
  const hash = Array.from(room.id).reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
  const initials = room.name.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('').toLocaleUpperCase();
  return <span className="room-avatar" style={pillVars(LABEL_PALETTE[hash % LABEL_PALETTE.length]) as React.CSSProperties} aria-hidden="true">{initials}</span>;
}

type View = 'list' | 'create' | 'invite' | 'rename' | 'leave' | 'delete';
const TITLES: Record<View, string> = { list: 'Your rooms', create: 'New shared room', invite: 'Invite someone', rename: 'Rename room', leave: 'Leave room', delete: 'Delete room' };
const expiryText = (ms: number) => `Expires ${new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · not yet used`;

export default function Rooms({ onOpenSettings }: { onOpenSettings(): void }) {
  const [open, setOpen] = useState(false);
  const [botsOpen, setBotsOpen] = useState(false);
  const presence = useDropdownPresence(open);
  const [, rerender] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  const trigger = useRef<HTMLButtonElement>(null);
  const account = currentAccount();
  const room = currentRoom();
  if (!account || !room) return null;
  return <>
    <button ref={trigger} type="button" className="room-switch" onClick={() => setOpen(!open)} aria-haspopup="dialog" aria-expanded={open} title={room.name} aria-label={`Switch room, current room ${room.name}`}>
      <RoomIdentity room={room} /><span>{room.name}</span><RoomIcon name="chevron" />
    </button>
    {presence.mounted && <RoomPanel trigger={trigger} closing={presence.closing} onClose={close} onOpenBots={() => { close(); setBotsOpen(true); }} onOpenSettings={onOpenSettings} onChanged={() => rerender((v) => v + 1)} />}
    {botsOpen && <BotOverview onClose={() => setBotsOpen(false)} />}
  </>;
}

/** A shared room's ··· menu (C1[42]): Invite, Rename, Delete for the owner; Leave for a member. */
function RowMenu({ at, owner, closing, menuRef, onPick, onClose }: { at: DOMRect; owner: boolean; closing?: boolean; menuRef: React.RefObject<HTMLDivElement>; onPick(v: View): void; onClose(): void }) {
  const [position, setPosition] = useState<React.CSSProperties>({ top: -9999, left: 0 });
  useLayoutEffect(() => {
    const place = () => {
      const element = menuRef.current;
      const bounds = element && { width: element.offsetWidth, height: element.offsetHeight };
      if (bounds) setPosition(menuPosition(at, bounds));
    };
    place();
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    const observer = new ResizeObserver(place);
    if (menuRef.current) observer.observe(menuRef.current);
    return () => {
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      observer.disconnect();
    };
  }, [at, menuRef]);
  useEffect(() => { menuRef.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus(); }, [menuRef]);
  const items: [View, string][] = owner ? [['invite', 'Invite someone'], ['rename', 'Rename'], ['delete', 'Delete room']] : [['leave', 'Leave room']];
  const keyDown = (e: React.KeyboardEvent) => {
    const all = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? []);
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus(); }
  };
  return createPortal(<div ref={menuRef} className="rooms-menu" role="menu" aria-label="Room options" data-closing={closing || undefined} aria-hidden={closing || undefined} onKeyDown={keyDown} style={position}>
    {items.map(([view, label]) => <button key={view} type="button" role="menuitem" className={view === 'delete' || view === 'leave' ? 'danger' : undefined} onClick={() => onPick(view)}>{label}</button>)}
  </div>, document.body);
}

function RoomPanel({ trigger, closing, onClose, onOpenBots, onOpenSettings, onChanged }: { trigger: React.RefObject<HTMLButtonElement>; closing?: boolean; onClose(): void; onOpenBots(): void; onOpenSettings(): void; onChanged(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 20, top: 64 });
  const [phone, setPhone] = useState(window.innerWidth < 900);
  const [, rerender] = useState(0);
  const [view, setView] = useState<View>('list');
  const [target, setTarget] = useState<AccountRoom | null>(null);
  const [menu, setMenu] = useState<{ room: AccountRoom; at: DOMRect } | null>(null);
  const lastMenu = useRef(menu);
  if (menu) lastMenu.current = menu;
  const menuPresence = useDropdownPresence(!!menu);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [invite, setInvite] = useState<{ url: string; expires: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const account = currentAccount()!;
  const active = currentRoom()!;
  const rooms = [...account.rooms].sort((a, b) => Number(b.private) - Number(a.private) || a.name.localeCompare(b.name));
  useLayoutEffect(() => {
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      setPhone(window.innerWidth < 900);
      if (rect) setPosition({ left: Math.round(Math.max(16, Math.min(rect.left, window.innerWidth - 376))), top: Math.round(rect.bottom + 8) });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [trigger]);
  useEffect(() => { void refreshAccount().then(() => rerender((v) => v + 1)).catch((error) => setError(error.message)); }, []);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
  }, [view]);
  useEffect(() => { if (invite) ref.current?.querySelector<HTMLInputElement>('#room-invite-link')?.focus(); }, [invite]);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || (t as Element).closest?.('.rooms-more')) return;
      setMenu(null);
      if (!ref.current?.contains(t) && !trigger.current?.contains(t)) onClose();
    };
    document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('pointerdown', outside); trigger.current?.focus({ preventScroll: true }); };
  }, [onClose, trigger]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (menu) setMenu(null);
      else if (view === 'list') onClose(); else { setError(''); setView('list'); }
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [view, onClose, menu]);
  const changeView = (next: View) => { setError(''); setMenu(null); setView(next); };
  const run = async (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await task(); } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const pick = (room: AccountRoom, next: View) => {
    setTarget(room); setInvite(null); setCopied(false); setName(next === 'rename' ? room.name : '');
    changeView(next);
  };
  const generate = (replace?: string) => run(async () => {
    const result = await accountRequest('/kanban/invite', { room: target!.id, ...(replace ? { replace } : {}) });
    setCopied(false);
    setInvite({ url: result.url, expires: result.expires ?? Date.now() + 7 * 86400000 });
  });
  // Leaving or deleting the room you're in moves you to your personal room.
  const removed = async (roomId: string) => {
    await refreshAccount();
    if (roomId === active.id) { await sync.sync(); await switchRoom(currentAccount()!.personalRoom); return; }
    onChanged(); changeView('list');
  };
  const keyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); view === 'list' ? onClose() : changeView('list'); }
    if (view === 'list' && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && !menu) {
      const choices = Array.from(ref.current!.querySelectorAll<HTMLButtonElement>('.rooms-select'));
      if (!choices.length) return;
      const index = choices.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? choices.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      e.preventDefault(); choices[next].focus();
    }
    if (phone && e.key === 'Tab') {
      const controls = Array.from(ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [href]'));
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  };
  const back = <button type="button" className="rooms-button" disabled={busy} onClick={() => changeView('list')}>Cancel</button>;
  return createPortal(<div className={`rooms-layer${phone ? ' rooms-layer-phone' : ''}`}>
    <div ref={ref} className="rooms" role="dialog" aria-modal={phone || undefined} aria-labelledby="rooms-title" onKeyDown={keyDown} style={phone ? undefined : position} data-closing={closing || undefined} aria-hidden={closing || undefined}>
      <div className="rooms-handle" aria-hidden="true" />
      <header className="rooms-header rooms-grid">
        {view !== 'list' ? <button className="rooms-icon-button" type="button" aria-label="Back to rooms" onClick={() => changeView('list')}><RoomIcon name="back" /></button> : <span />}
        <h2 id="rooms-title">{TITLES[view]}</h2>
        <button className="rooms-icon-button" type="button" aria-label="Close rooms" onClick={onClose}><RoomIcon name="close" /></button>
      </header>
      {view === 'list' ? <>
        <div className="rooms-list" aria-label="Your rooms">
          {rooms.map((room, index) => <div key={room.id} className={`rooms-row rooms-grid${room.id === active.id ? ' is-current' : ''}${!room.private && rooms[index - 1]?.private ? ' rooms-group-start' : ''}`}>
            <span className="rooms-leading"><RoomIdentity room={room} /></span>
            <button type="button" className="rooms-select" title={room.name} aria-current={room.id === active.id ? 'true' : undefined} data-initial-focus={room.id === active.id || undefined} disabled={busy} onClick={() => room.id === active.id ? onClose() : void run(async () => { await sync.sync(); await switchRoom(room.id); })}>
              <strong>{room.name}</strong><small>{room.private ? 'Only you' : room.bot ? `Bot workspace${account.botDispatchEnabled?.[room.bot] ? '' : ' · pickup paused'}` : `${room.owner === account.user ? 'Owner · ' : ''}${room.members.length} ${room.members.length === 1 ? 'person' : 'people'}`}</small>
            </button>
            <div className="rooms-trailing">
              {room.id === active.id && <span className="rooms-current" aria-label="Current room"><RoomIcon name="check" /></span>}
              {!room.private && !room.bot && <button className="rooms-icon-button rooms-more" type="button" aria-label="Room options" aria-haspopup="menu" aria-expanded={menu?.room.id === room.id} disabled={busy} data-testid={`room-options-${room.id}`} onClick={(e) => { const at = e.currentTarget.getBoundingClientRect(); setMenu((m) => (m?.room.id === room.id ? null : { room, at })); }}><RoomIcon name="more" /></button>}
            </div>
          </div>)}
        </div>
        <footer className="rooms-footer">
          {rooms.some(room => room.bot) && <button type="button" className="rooms-new rooms-grid" onClick={onOpenBots}><span className="rooms-leading"><RoomIcon name="people" /></span><span>All bots</span></button>}
          <button className="rooms-new rooms-grid" type="button" onClick={() => changeView('create')}><span className="rooms-leading"><RoomIcon name="plus" /></span><span>New shared room</span></button>
          <p className="rooms-account">Signed in as <strong>{account.user}</strong></p>
          <button className="rooms-preferences" type="button" onClick={() => { onClose(); onOpenSettings(); }}>Your theme and motion settings <RoomIcon name="chevron" /></button>
        </footer>
        {menuPresence.mounted && lastMenu.current && <RowMenu at={lastMenu.current.at} owner={lastMenu.current.room.owner === account.user} closing={menuPresence.closing} menuRef={menuRef} onClose={() => setMenu(null)} onPick={(v) => pick(lastMenu.current!.room, v)} />}
      </> : view === 'create' || view === 'rename' ? <form className="rooms-form" onSubmit={(e) => { e.preventDefault(); void run(async () => {
        if (view === 'rename') { await accountRequest('/kanban/rooms/rename', { room: target!.id, name: name.trim() }); await refreshAccount(); onChanged(); changeView('list'); return; }
        const result = await accountRequest('/kanban/rooms', { name: name.trim() }); await refreshAccount(); await sync.sync(); await switchRoom(result.room.id);
      }); }}>
        <label className="rooms-label" htmlFor="room-name">Room name</label>
        <input id="room-name" className="rooms-input" data-initial-focus value={name} maxLength={60} disabled={busy} onChange={(e) => setName(e.target.value)} placeholder="Household, Trips…" required aria-describedby="room-name-hint" aria-invalid={!!error} />
        <p id="room-name-hint" className="rooms-help">{view === 'rename' ? 'Everyone in the room sees the new name.' : 'Anyone you invite can see and edit the tasks here. Your personal room stays private.'}</p>
        {error && <p className="rooms-error" role="alert">{error}</p>}
        <div className="rooms-actions">{back}<button className="rooms-button rooms-primary" disabled={busy || !name.trim() || (view === 'rename' && name.trim() === target?.name)}>{view === 'rename' ? (busy ? 'Saving…' : 'Save') : busy ? 'Creating…' : 'Create room'}</button></div>
      </form> : view === 'leave' || view === 'delete' ? <section className="rooms-form">
        <p className="rooms-label rooms-invite-name" title={target?.name}>{target?.name}</p>
        <p className="rooms-help">{view === 'delete' ? 'Deletes the room for everyone in it. Its cards can no longer be opened.' : 'You lose access to its cards. You need a new invitation to come back.'}</p>
        {error && <p className="rooms-error" role="alert">{error}</p>}
        <div className="rooms-actions">{back}<button className="rooms-button rooms-danger" data-initial-focus type="button" disabled={busy} onClick={() => void run(async () => { await accountRequest(`/kanban/rooms/${view}`, { room: target!.id }); await removed(target!.id); })}>{view === 'delete' ? (busy ? 'Deleting…' : 'Delete room') : busy ? 'Leaving…' : 'Leave room'}</button></div>
      </section> : <section className="rooms-form">
        <p className="rooms-label rooms-invite-name" title={target?.name}>{target?.name}</p>
        <p className="rooms-help">One link, one person, expires in 7 days. They can create an account or sign in.</p>
        {invite && <>
          <div className="rooms-link">
            <span className="rooms-leading"><RoomIcon name="link" /></span>
            <input id="room-invite-link" className="rooms-input" aria-label="Invitation link" readOnly value={invite.url} onFocus={(e) => e.target.select()} />
            <button className={`rooms-button${copied ? ' rooms-copied' : ''}`} type="button" onClick={() => void run(async () => { await navigator.clipboard.writeText(invite.url); setCopied(true); })}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <p className="rooms-expiry" role="status">{copied ? 'Invitation link copied.' : expiryText(invite.expires)}</p>
          <button type="button" className="rooms-text-button" disabled={busy} onClick={() => void generate(invite.url)}>New link</button>
          <p className="rooms-warning">A new link stops this one from working.</p>
        </>}
        {error && <p className="rooms-error" role="alert">{error}</p>}
        <div className="rooms-actions">{invite ? <button className="rooms-button" type="button" onClick={() => changeView('list')}>Done</button> : <button className="rooms-button rooms-primary" data-initial-focus disabled={busy} type="button" onClick={() => void generate()}>{busy ? 'Creating…' : 'Generate link'}</button>}</div>
      </section>}
      {view === 'list' && error && <p className="rooms-error" role="alert">{error}</p>}
    </div>
  </div>, document.body);
}
