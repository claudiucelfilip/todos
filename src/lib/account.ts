import { revokeFiles } from './file-cache';
import type { BoardSettings } from './types';

export interface Room { id: string; name: string; owner: string; private: boolean; bot?: 'sherlock' | 'claw' | 'lurch'; members: string[] }
export interface Account { user: string; email?: string | null; personalRoom: string; rooms: Room[]; preferences: Partial<BoardSettings>; botDispatchEnabled?: Record<string, boolean> }
let account: Account | null = null;
let selectedRoom = '';
let originalFetch: typeof fetch;
let preferenceQueue = Promise.resolve();
function read(key: string): string { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
function write(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } }
export function currentAccount(): Account | null { return account; }
export function currentRoom(): Room | undefined { return account?.rooms.find((room) => room.id === selectedRoom); }
export function storageScope(): string { return account && selectedRoom !== 'personal' ? `${account.user}:${selectedRoom}` : ''; }
export function scopedKey(key: string): string { return storageScope() ? `${key}:${storageScope()}` : key; }
export function scopedUrl(input: string): string {
  if (!account || !selectedRoom) return input;
  const url = new URL(input, location.origin);
  if (url.origin === location.origin && url.pathname.startsWith('/kanban/')) {
    url.searchParams.set('room', selectedRoom);
    url.searchParams.set('account', account.user);
  }
  return url.href;
}
function remember(info: Account): void {
  account = info;
  try { const pending = JSON.parse(read(`todos.preferences.pending:${info.user}`)); if (pending) info.preferences = { ...info.preferences, ...pending }; } catch { /* no pending preferences */ }
  const requested = new URL(location.href).searchParams.get('room');
  const last = sessionStorage.getItem(`todos.room:${info.user}`) || read(`todos.room:${info.user}`);
  selectedRoom = info.rooms.find((room) => room.id === (requested || last))?.id || info.personalRoom;
  sessionStorage.setItem(`todos.room:${info.user}`, selectedRoom);
  write(`todos.room:${info.user}`, selectedRoom);
  write('todos.account', JSON.stringify(info));
}
export async function prepareAccount(): Promise<void> {
  originalFetch = window.fetch.bind(window);
  window.addEventListener('online', retryPersonalSettings);
  try {
    const res = await originalFetch('/kanban/session', { credentials: 'same-origin', signal: AbortSignal.timeout(8000) });
    const info = res.ok && /json/.test(res.headers.get('content-type') || '') ? await res.json() : null;
    if (info?.user && Array.isArray(info.rooms)) {
      let previous = '';
      try { previous = JSON.parse(read('todos.account'))?.user || ''; } catch { /* first launch */ }
      if (previous !== info.user) await revokeFiles();
      remember(info);
    }
    else if (res.status === 401 || info?.viewer) { await revokeFiles(); write('todos.account', ''); }
  } catch {
    try { const saved = JSON.parse(read('todos.account')); if (saved?.user && saved.rooms) remember(saved); } catch { /* first launch */ }
  }
  window.fetch = async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, location.origin);
    const scoped = url.origin === location.origin && url.pathname.startsWith('/kanban/') && account;
    if (!scoped) return originalFetch(input, init);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set('X-Todos-Room', selectedRoom);
    headers.set('X-Todos-Account', account!.user);
    const res = await originalFetch(input, { ...init, headers });
    if (res.status === 409 && (await res.clone().json().catch(() => ({}))).error === 'account_changed') location.reload();
    if (url.pathname === '/kanban/session' && res.ok) {
      const body = await res.clone().json().catch(() => ({}));
      if (body.user && body.user !== account!.user) { await revokeFiles(); location.reload(); }
    }
    return res;
  };
  if (account && read(`todos.preferences.pending:${account.user}`)) savePersonalSettings(account.preferences);
}
export async function refreshAccount(): Promise<void> {
  const res = await fetch('/kanban/account', { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Could not load your account.');
  remember(await res.json());
}
export async function accountRequest(path: string, body: unknown): Promise<any> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || 'Could not save changes.');
  return result;
}
export function personalSettings(settings: BoardSettings): BoardSettings {
  return { ...settings, ...account?.preferences };
}
export function savePersonalSettings(partial: Partial<BoardSettings>): void {
  if (!account) return;
  const preferences: Partial<BoardSettings> = {};
  if (partial.theme) preferences.theme = partial.theme;
  if (partial.studioTheme) preferences.studioTheme = partial.studioTheme;
  if (partial.studioPattern) preferences.studioPattern = partial.studioPattern;
  if (partial.reduceMotion) preferences.reduceMotion = partial.reduceMotion;
  if (typeof partial.suggest === 'boolean') preferences.suggest = partial.suggest;
  if (!Object.keys(preferences).length) return;
  account.preferences = { ...account.preferences, ...preferences };
  write('todos.account', JSON.stringify(account));
  write(`todos.preferences.pending:${account.user}`, JSON.stringify(account.preferences));
  const username = account.user;
  const queued = JSON.stringify(account.preferences);
  preferenceQueue = preferenceQueue.catch(() => {}).then(async () => {
    if (account?.user !== username) return;
    await accountRequest('/kanban/account', preferences);
    if (read(`todos.preferences.pending:${username}`) === queued) write(`todos.preferences.pending:${username}`, '');
  });
  void preferenceQueue.catch(() => {});
}
export async function switchRoom(id: string): Promise<void> {
  if (!account?.rooms.some((room) => room.id === id)) throw new Error('Room not found.');
  sessionStorage.setItem(`todos.room:${account.user}`, id);
  write(`todos.room:${account.user}`, id);
  const url = new URL(location.href);
  url.searchParams.delete('invite');
  url.searchParams.delete('room');
  url.hash = '';
  location.assign(url.href);
}
export function clearAccount(): void { write('todos.account', ''); account = null; }

export function retryPersonalSettings(): void {
  if (account && read(`todos.preferences.pending:${account.user}`)) savePersonalSettings(account.preferences);
}
