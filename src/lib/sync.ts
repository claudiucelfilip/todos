// §13.3 — the server board is the board. Signed in, the device shows exactly the
// server state: a snapshot on boot, then the pulled actions, plus its own edits that
// have not landed yet (the outbox). Nothing else local is ever uploaded; IndexedDB is
// only a read cache for offline display.
//
// Thin sync over the local store. Every committed local write is turned
// into reducer actions (shared/merge.mjs diffCards), appended to the IndexedDB
// outbox and pushed; remote actions are pulled on launch, on return (visibility, pageshow,
// online), after a local edit and every 30 s while visible (SYNC_TIMING), replayed through
// the same merge, then handed to the store, which applies only what actually changed.
//
// Identity: served from the backend, sync is on by default. The server's session
// cookie (POST /kanban/login, username + password) is the account; a 401 on boot
// shows the login, an unreachable server never does. Older devices may still hold
// a bearer token (from /#/pair?token=…), which keeps working. Sign-out clears the
// cookie and the token, never local data.

import { currentAccount, refreshAccount, clearAccount } from './account';
import type { Card, Label } from './types';
import { applyAction, diffCards, diffLabels, emptyState, snapshot, stateFromCards, type MergeState, type SyncAction } from '../../shared/merge.mjs';
import { clearOutbox, discardUnsent, enqueueActions, outboxCount, readOutbox } from './db';
import { allowFiles, revokeFiles } from './file-cache';

const TOKEN_KEY = 'kept.apiToken';
const BASE_KEY = 'kept.apiBase';
const SYNCED_KEY = 'kept.syncedAt';
const FAIL_KEY = 'kept.syncFailSince';
const USER_KEY = 'kept.syncUser';
// Cookie todos_viewer=1 (no secret; the server sets it with the view link, the page keeps it in step with
// the session): "start read-only" before the server answers. A cookie, not localStorage, so clearing
// site storage or Safari's script-storage cap can never make a viewer's board editable.
const VIEWER_MARK = 'todos_viewer';
const EPOCH = new Date(0).toISOString(); // last signed-in user, shown in Settings even offline
// One person, several devices: changes need to follow you to the next device, not be real-time.
// Sync on launch, on returning to the app (visibility, pageshow, online), right after a local
// edit and on another window's hint; otherwise every 30 s while visible, never while hidden
// (hidden: 0). Tests shrink these. Failed runs / probes back off (doubling) up to `max`.
export const SYNC_TIMING = { visible: 30000, hidden: 0, max: 60000 };

class TokenRejected extends Error {
  constructor() {
    super('Token rejected');
  }
}

export type LoginResult = 'ok' | 'invalid' | 'limited' | 'offline';

export interface SyncStatus {
  /** Syncing is possible: a session the server accepted, or a token not rejected. */
  signedIn: boolean;
  /** The server answered 401 with no token: show the login. */
  needsLogin: boolean;
  /** The signed-in user (session login), else null. */
  user: string | null;
  /** The server answered 401 to the current token (§7.13 "Token rejected"). */
  rejected: boolean;
  online: boolean;
  syncedAt: string | null;
  pending: number;
  failingSince: string | null;
  lastError: string | null;
  syncing: boolean;
  /** A view-only link: the board comes from the snapshot only; nothing is ever sent. */
  viewer: boolean;
  /** The view-only link was revoked or replaced: the cached board is gone, "no longer shared" shows. */
  unshared: boolean;
}

function ls(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
function get(k: string): string {
  return ls()?.getItem(k) ?? '';
}
function set(k: string, v: string | null): void {
  if (v === null || v === '') ls()?.removeItem(k);
  else ls()?.setItem(k, v);
}

export function getToken(): string {
  return get(TOKEN_KEY);
}
export function setToken(v: string): void {
  set(TOKEN_KEY, v.trim());
}
export function apiBase(): string {
  return get(BASE_KEY).replace(/\/$/, '');
}
export function setApiBase(v: string): void {
  set(BASE_KEY, v.trim().replace(/\/$/, ''));
}
export function hasBackend(): boolean {
  return getToken().length > 0;
}
export function viewerMarker(): boolean {
  try {
    return typeof document !== 'undefined' && new RegExp(`(?:^|;\\s*)${VIEWER_MARK}=1(?:;|$)`).test(document.cookie ?? '');
  } catch {
    return false;
  }
}
export function setViewerMarker(on: boolean): void {
  if (typeof document === 'undefined' || viewerMarker() === on) return;
  try {
    const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${VIEWER_MARK}=${on ? '1' : ''}; Path=/; SameSite=Lax; Max-Age=${on ? 31536000 : 0}${secure}`;
  } catch {
    /* cookies blocked */
  }
}
export function rememberedViewer(): boolean {
  return viewerMarker() && !hasBackend();
}
// Per page load, never stored: two windows of one browser (or a duplicated tab) must not share it.
const LOAD_ID = 'd' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export function deviceId(): string {
  return LOAD_ID;
}
/** A same-origin request to the backend with this device's credentials (cookie, or a token). */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const t = getToken();
  const headers = { ...(init.headers as Record<string, string> | undefined), ...(t ? { Authorization: `Bearer ${t}` } : {}) };
  return fetch(`${apiBase()}${path}`, { ...init, headers, credentials: 'same-origin' });
}

/** Replace the device's board with this (the server state plus pending local edits). */
type ReplaceHandler = (cards: Card[], labels: Label[], silent?: boolean) => void;

let lastStamp = 0;
/** Strictly increasing: the merge drops an equal timestamp from the same device, so two commits in one millisecond must not tie. */
function stamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

export class SyncEngine {
  private state: MergeState = emptyState();
  private baseline: Card[] = [];
  private baselineLabels: Label[] = [];
  private onReplace: ReplaceHandler;
  private bootstrapped = false; // this.state came from the server, not the local cache
  private readCards: () => Card[];
  private readLabels: () => Label[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(s: SyncStatus) => void>();
  private running = false;
  private inFlight: Promise<void> | null = null;
  private rejected = false;
  private failures = 0; // consecutive failed runs / probes, for backoff
  private nextAt = 0; // polling skips ticks until then
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private session = false;
  private filesOpen = false; // allowFiles() once per working session
  private needsLogin = false;
  private viewer = rememberedViewer();
  private unshared = false;
  // In memory, per window: a cursor shared through localStorage let one window skip what another pulled.
  private cursor = 0;
  private again = false; // a hint arrived while a run was in flight
  /** Drops the in-memory upload queue too (set by sync-boot; uploads.clear()). */
  onDiscard: (() => Promise<void>) | null = null;
  /** Called after a push landed, so other windows can pull it at once. */
  onPushed: (() => void) | null = null;
  status: SyncStatus = {
    signedIn: hasBackend(),
    needsLogin: false,
    user: get(USER_KEY) || null,
    rejected: false,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    syncedAt: get(SYNCED_KEY) || null,
    pending: 0,
    failingSince: get(FAIL_KEY) || null,
    lastError: null,
    syncing: false,
    viewer: rememberedViewer(),
    unshared: false,
  };

  constructor(readCards: () => Card[], onReplace: ReplaceHandler, readLabels: () => Label[] = () => []) {
    this.readCards = () => readCards().filter((card) => !card.draft);
    this.onReplace = onReplace;
    this.readLabels = readLabels;
  }

  subscribe(fn: (s: SyncStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setUser(user: string | null): void {
    set(USER_KEY, user);
    this.status = { ...this.status, user };
  }

  private canSync(): boolean {
    return hasBackend() ? !this.rejected : this.session;
  }

  private emit(patch: Partial<SyncStatus> = {}): void {
    this.status = { ...this.status, ...patch, rejected: this.rejected, signedIn: this.canSync(), needsLogin: this.needsLogin, viewer: this.viewer, unshared: this.unshared };
    for (const fn of this.listeners) fn(this.status);
  }

  /**
   * No token: ask the server whether this browser has a session. 200 → sync;
   * 401 → login required; unreachable or not our backend → stay local, no login.
   */
  async probe(): Promise<void> {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
    if (hasBackend()) {
      this.start();
      return;
    }
    if (!this.status.online) {
      // Offline with a remembered account (or view link): signed in, just offline; sync resumes on 'online'.
      if (get(USER_KEY) || rememberedViewer()) this.resumeRemembered(null);
      return;
    }
    let res: Response | null = null;
    let reason = '';
    try {
      res = await fetch(`${apiBase()}/kanban/session`, { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: this.signal() });
    } catch (err) {
      reason = (err as Error).message || 'network error';
    }
    const body = res ? await jsonBody<{ ok?: boolean; user?: string | null }>(res) : null;
    if (res && res.status === 401 && body && (this.viewer || rememberedViewer())) {
      this.endViewer(); // the view link was revoked or replaced
      return;
    }
    if (res && res.status === 401 && body) {
      // The only way into the login: a JSON 401 from the server itself.
      this.filesOpen = false;
      void revokeFiles();
      this.session = false;
      this.needsLogin = true;
      this.stop();
      this.setUser(null);
      this.emit();
      return;
    }
    if (res && res.ok && body?.ok) {
      this.session = true;
      this.needsLogin = false;
      this.failures = 0;
      this.setViewer((body as { viewer?: boolean }).viewer === true);
      this.setUser(body.user ?? null);
      this.emit();
      this.start();
      return;
    }
    // Unreachable, 5xx, a non-JSON reply (proxy page, dev server): never the login; try again later.
    reason ||= res ? `session check failed (${res.status})` : 'network error';
    console.error('[sync] session check failed:', reason);
    this.needsLogin = false;
    if (get(USER_KEY) || rememberedViewer()) this.resumeRemembered(reason);
    else {
      this.failures++;
      this.emit();
      this.probeTimer = setTimeout(() => void this.probe(), this.backoff());
    }
  }

  /** A remembered account whose server can't be reached right now: count as signed in and keep trying. */
  private resumeRemembered(reason: string | null): void {
    this.session = true;
    this.needsLogin = false;
    this.viewer = !get(USER_KEY) && rememberedViewer();
    if (reason) {
      const since = get(FAIL_KEY) || new Date().toISOString();
      set(FAIL_KEY, since);
      this.failures++;
      this.nextAt = Date.now() + this.backoff();
      this.emit({ failingSince: since, lastError: reason });
    } else this.emit();
    this.start(true);
  }

  private backoff(): number {
    return Math.min(SYNC_TIMING.max, SYNC_TIMING.visible * 2 ** Math.max(0, this.failures - 1));
  }

  /** Username + password → session cookie, then sync at once. */
  async login(username: string, password: string): Promise<LoginResult> {
    let res: Response;
    try {
      res = await fetch(`${apiBase()}/kanban/login`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: this.signal(),
      });
    } catch {
      return 'offline';
    }
    if (res.status === 429) return 'limited';
    if (!res.ok) return 'invalid';
    const body = (await res.json().catch(() => ({}))) as { user?: string; fresh?: boolean };
    if (typeof window !== 'undefined' && typeof location !== 'undefined') {
      const previous = currentAccount()?.user;
      try { await refreshAccount(); } catch { /* legacy or test server */ }
      if (currentAccount()?.user && previous !== currentAccount()?.user) { location.reload(); return 'ok'; }
    }
    // From a view link (now, or ever on this browser: `fresh`): start from the server board; nothing left here is ever pushed.
    if (this.viewer || this.unshared || body.fresh) this.discardUnsent();
    this.session = true;
    this.needsLogin = false;
    this.rejected = false;
    this.bootstrapped = false;
    this.setViewer(false); // signed in: the owner's board, editable
    this.unshared = false;
    this.setUser(body.user ?? username);
    this.emit({ lastError: null });
    await this.discarding; // from a view link: nothing it left behind may be pushed
    this.start();
    await this.sync();
    return 'ok';
  }

  /** Reset the merge state and baseline from the current local cards. */
  rebase(): void {
    const cards = this.readCards();
    const labels = this.readLabels();
    this.state = stateFromCards(cards, labels);
    this.baseline = clone(cards);
    this.baselineLabels = clone(labels);
  }

  /** Called by the store after every committed change. */
  onLocalChange(type: string): void {
    const cards = this.readCards();
    if (this.viewer) {
      // View only: nothing local is ever turned into an action, queued or pushed.
      this.baseline = clone(cards);
      this.baselineLabels = clone(this.readLabels());
      return;
    }
    if (type === 'remote' || type === 'reload' || type === 'ready') {
      // Signed in, the state is the server's: only move the baseline. Before that, the cache.
      if (this.bootstrapped) {
        this.baseline = clone(cards);
        this.baselineLabels = clone(this.readLabels());
      } else this.rebase();
      return;
    }
    const labels = this.readLabels();
    const ts = stamp();
    // Labels first so a card never references a label the server has not seen yet.
    const actions = [...diffLabels(this.baselineLabels, labels, ts, deviceId()), ...diffCards(this.baseline, cards, ts, deviceId())];
    this.baseline = clone(cards);
    this.baselineLabels = clone(labels);
    if (!actions.length) return;
    for (const a of actions) applyAction(this.state, a);
    void enqueueActions(actions).then(() => this.refreshPending());
    this.schedulePush();
  }

  start(deferFirst = false): void {
    if (this.running) return;
    this.running = true;
    this.rebase();
    void this.refreshPending();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', this.onOffline);
      document.addEventListener('visibilitychange', this.onVisible);
      window.addEventListener('pageshow', this.onPageShow);
    }
    this.armPolling();
    if (!deferFirst) void this.sync();
  }

  private armPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const every = hidden ? SYNC_TIMING.hidden : SYNC_TIMING.visible;
    if (every <= 0) return; // hidden: no polling; returning to the app syncs
    // Each tick syncs unless a failure backoff is still running.
    this.timer = setInterval(() => {
      if (Date.now() >= this.nextAt) void this.sync();
    }, every);
  }

  stop(): void {
    this.running = false;
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('offline', this.onOffline);
      document.removeEventListener('visibilitychange', this.onVisible);
      window.removeEventListener('pageshow', this.onPageShow);
    }
  }

  private onOnline = () => {
    this.emit({ online: true });
    void this.refreshPending();
    void this.sync();
  };
  private onOffline = () => this.emit({ online: false });
  // Back from the bfcache (Safari, a restored tab): the page kept stale data, so sync now.
  private onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted && this.running) void this.sync();
  };
  private onVisible = () => {
    if (!this.running) return;
    this.armPolling();
    if (document.visibilityState === 'visible') void this.sync();
  };

  private schedulePush(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    // A run already in flight may have read the outbox before this edit landed: run again after it.
    this.pushTimer = setTimeout(() => this.hint(), 400);
  }

  private async refreshPending(): Promise<void> {
    if (this.viewer) return this.emit({ pending: 0 });
    try {
      this.emit({ pending: await outboxCount() });
    } catch {
      /* storage blocked */
    }
  }

  /** Sign in with a token: bootstrap from the server snapshot, then run. */
  async signIn(token: string): Promise<void> {
    setToken(token);
    set(SYNCED_KEY, null);
    this.rejected = false;
    this.needsLogin = false;
    this.bootstrapped = false;
    this.emit({ syncedAt: null, lastError: null });
    this.start();
    await this.sync();
  }

  /** Sign out: cookie, token, cursor and synced-at go, local data stays (§13.3); the login shows. */
  async signOut(): Promise<void> {
    clearAccount();
    setToken('');
    this.filesOpen = false;
    void revokeFiles(); // attachment files cached for offline viewing go with the session
    set(FAIL_KEY, null);
    set(SYNCED_KEY, null);
    this.rejected = false;
    this.session = false;
    this.needsLogin = true;
    this.bootstrapped = false;
    this.setViewer(false);
    this.unshared = false;
    this.stop();
    this.setUser(null);
    this.emit({ pending: 0, failingSince: null, lastError: null, syncedAt: null });
    try {
      await fetch(`${apiBase()}/kanban/logout`, { method: 'POST', credentials: 'same-origin', signal: this.signal() });
    } catch {
      /* offline: the cookie is replaced on the next sign-in */
    }
  }

  get hasSnapshot(): boolean { return this.bootstrapped; }

  /** Push the outbox, then pull and replay what the other devices did. */
  sync(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Another window changed something: sync now, or once more right after the current run. */
  hint(): void {
    if (!this.inFlight) {
      void this.sync();
      return;
    }
    this.again = true;
    void this.inFlight.then(() => {
      if (!this.again) return;
      this.again = false;
      void this.sync();
    });
  }

  private async run(): Promise<void> {
    if (!this.canSync() || !this.status.online) return;
    this.emit({ syncing: true });
    try {
      if (!this.viewer) await this.push();
      const first = !this.bootstrapped; // the first snapshot (launch, login) lands silently
      // A viewer never reads the action log (it holds history, deleted cards too): the snapshot every time.
      if (this.bootstrapped && !this.viewer) await this.pull();
      else await this.bootstrap();
      this.show(first);
      set(SYNCED_KEY, new Date().toISOString());
      set(FAIL_KEY, null);
      // F3: "N changes waiting" always reflects the real outbox after a successful run.
      let pending = this.status.pending;
      try {
        pending = this.viewer ? 0 : await outboxCount();
      } catch {
        /* storage blocked */
      }
      this.failures = 0;
      this.nextAt = 0;
      // Not after a sign-out that landed while this run was in flight.
      if (!this.filesOpen && this.canSync()) {
        this.filesOpen = true;
        await allowFiles(); // the server accepted us: the worker may cache attachment files again
      }
      this.emit({ syncedAt: get(SYNCED_KEY), failingSince: null, lastError: null, syncing: false, pending });
    } catch (err) {
      if (err instanceof TokenRejected && this.viewer) {
        this.endViewer();
        return;
      }
      if (err instanceof TokenRejected && !hasBackend()) {
        // The session expired or was revoked: back to the login, and cached files go too.
        this.filesOpen = false;
        void revokeFiles();
        this.session = false;
        this.needsLogin = true;
        this.bootstrapped = false;
        this.stop();
        set(SYNCED_KEY, null);
        this.setUser(null);
        this.emit({ syncedAt: null, failingSince: null, lastError: null, syncing: false });
        return;
      }
      if (err instanceof TokenRejected) {
        // D1: a 401 is a clear unpaired state, not a stall.
        this.filesOpen = false;
        void revokeFiles();
        this.rejected = true;
        set(SYNCED_KEY, null);
        set(FAIL_KEY, null);
        this.emit({ syncedAt: null, failingSince: null, lastError: err.message, syncing: false });
        return;
      }
      console.error('[sync] failed:', err);
      this.failures++;
      this.nextAt = Date.now() + this.backoff();
      const since = get(FAIL_KEY) || new Date().toISOString();
      set(FAIL_KEY, since);
      this.emit({ failingSince: since, lastError: (err as Error).message, syncing: false });
    }
  }

  /** A token (older devices) goes as Bearer; otherwise the session cookie does the work. */
  private headers(): Record<string, string> {
    const t = getToken();
    return t ? { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` } : { 'Content-Type': 'application/json' };
  }

  /** A hung request must not block later runs (inFlight is shared). */
  private signal(): AbortSignal | undefined {
    return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(10000) : undefined;
  }

  private async push(): Promise<void> {
    const rows = await readOutbox();
    if (!rows.length) return;
    const res = await fetch(`${apiBase()}/kanban/push`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: this.headers(),
      body: JSON.stringify({ deviceId: deviceId(), actions: rows.map((r) => r.action) }),
      signal: this.signal(),
    });
    if (res.status === 401) await rejectIf401(res);
    if (!res.ok) throw new Error(`push failed (${res.status})`);
    await clearOutbox(rows.map((r) => r.oid));
    await this.refreshPending();
    this.onPushed?.();
  }

  private async pull(): Promise<void> {
    const res = await fetch(`${apiBase()}/kanban/pull?since=${this.cursor}`, { credentials: 'same-origin', headers: this.headers(), signal: this.signal() });
    if (res.status === 401) await rejectIf401(res);
    if (!res.ok) throw new Error(`pull failed (${res.status})`);
    const body = (await res.json()) as PullBody;
    if (body.reset) return this.adopt(body);
    // Own actions too: the merge is idempotent, and another window may share any id.
    for (const a of body.actions) applyAction(this.state, a);
    this.cursor = body.cursor;
  }

  /** Boot (or re-bootstrap): the server snapshot becomes the state; the local cache is ignored. */
  private async bootstrap(): Promise<void> {
    const res = await fetch(`${apiBase()}/kanban/snapshot`, { credentials: 'same-origin', headers: this.headers(), signal: this.signal() });
    if (res.status === 401) await rejectIf401(res);
    if (!res.ok) throw new Error(`snapshot failed (${res.status})`);
    await this.adopt((await res.json()) as PullBody);
  }

  private async adopt(body: PullBody): Promise<void> {
    const s = emptyState();
    for (const c of body.cards ?? []) applyAction(s, { id: `boot-${c.id}`, deviceId: 'server', ts: c.updatedAt || c.createdAt || EPOCH, type: 'card.put', payload: { card: c } });
    for (const id of body.tombstones ?? []) applyAction(s, { id: `tomb-${id}`, deviceId: 'server', ts: EPOCH, type: 'card.delete', payload: { id } });
    for (const l of body.labels ?? []) applyAction(s, { id: `bootl-${l.id}`, deviceId: 'server', ts: l.updatedAt || EPOCH, type: 'label.put', payload: { label: l } });
    for (const id of body.labelTombstones ?? []) applyAction(s, { id: `tombl-${id}`, deviceId: 'server', ts: EPOCH, type: 'label.delete', payload: { id } });
    // Edits made here that have not landed yet stay visible on top of the server board (never for a viewer).
    if (!this.viewer) for (const { action } of await readOutbox()) applyAction(s, action);
    this.state = s;
    this.bootstrapped = true;
    this.cursor = body.cursor;
  }

  private discarding: Promise<void> = Promise.resolve();

  private setViewer(on: boolean): void {
    const was = this.viewer;
    this.viewer = on;
    setViewerMarker(on);
    if (!on) return;
    this.setUser(null);
    if (!was) this.bootstrapped = false; // the board comes from the server, not from local edits
    this.discardUnsent();
  }

  /** A view link on this device: nothing unsent (any window's edits, queued uploads) may ever be pushed. */
  discardUnsent(): Promise<void> {
    this.discarding = Promise.all([discardUnsent().catch(() => {}), this.onDiscard?.().catch(() => {})]).then(() => {
      this.emit({ pending: 0 });
    });
    return this.discarding;
  }

  /**
   * The server no longer accepts this view link (revoked or replaced): the cached board and the
   * cached attachment files go, and "no longer shared" shows until the owner signs in.
   */
  private endViewer(): void {
    this.filesOpen = false;
    void revokeFiles();
    this.onReplace([], [], true);
    void this.discardUnsent(); // nothing left on a viewer's device may be pushed by a later sign-in
    this.viewer = false;
    setViewerMarker(false);
    this.unshared = true;
    this.session = false;
    this.needsLogin = false;
    this.bootstrapped = false;
    this.stop();
    set(SYNCED_KEY, null);
    set(FAIL_KEY, null);
    this.setUser(null);
    this.emit({ syncedAt: null, failingSince: null, lastError: null, syncing: false, pending: 0 });
  }

  /** "Sign in" from a view link (or the "no longer shared" page): the login; a live view link can come back. */
  showLogin(): void {
    this.unshared = false;
    this.needsLogin = true;
    this.emit();
  }

  /** Back from that login to the shared board (only while the view link still works). */
  backToView(): void {
    if (!this.viewer) return;
    this.needsLogin = false;
    this.emit();
  }

  /** The device board becomes the state: server board plus pending local edits, nothing else. */
  private show(silent = false): void {
    this.onLocalChange('flush'); // an edit made while the request was in flight joins the state first
    const snap = snapshot(this.state);
    this.onReplace(snap.cards, snap.labels, silent);
    this.baseline = clone(this.readCards());
    this.baselineLabels = clone(this.readLabels());
  }
}

/** The parsed JSON body, or null when the reply is not JSON. */
async function jsonBody<T>(res: Response): Promise<T | null> {
  if (!/json/i.test(res.headers.get('content-type') ?? '')) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Only the server's own JSON 401 means "signed out"; a proxy's 401 page is just a failure. */
async function rejectIf401(res: Response): Promise<never> {
  if (await jsonBody(res.clone())) throw new TokenRejected();
  throw new Error(`unauthorized reply without JSON (${res.status})`);
}

interface PullBody {
  reset?: boolean;
  cards?: Card[];
  tombstones?: string[];
  labels?: Label[];
  labelTombstones?: string[];
  actions: SyncAction[];
  cursor: number;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
