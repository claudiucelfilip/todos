// Settings → Sync status line, e.g. "Synced · 2 min ago" or "Offline · last synced 1 h ago".
import type { SyncStatus } from './sync';
import { copy, syncCopy } from './copy';

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function statusLine(s: SyncStatus, now = Date.now()): string {
  if (s.rejected) return copy.tokenRejected();
  if (!s.online) return s.syncedAt ? syncCopy.offlineSince(ago(s.syncedAt, now)) : syncCopy.offline;
  if (!s.signedIn) return s.needsLogin ? syncCopy.notSignedIn : syncCopy.localOnly;
  if (s.pending > 0) return syncCopy.waiting(s.pending);
  if (s.syncing) return syncCopy.syncing;
  // Can't reach the server: it reads as offline, the banner gives the reason.
  if (s.failingSince) return s.syncedAt ? syncCopy.offlineSince(ago(s.syncedAt, now)) : syncCopy.failing;
  return syncCopy.synced(ago(s.syncedAt, now));
}

export interface OfflineHint { kind: 'offline' | 'notSynced'; label: string; aria: string }

/**
 * Top-bar hint, signed in only: offline or the server unreachable → "Offline (· N waiting)";
 * an error the server answered with (an HTTP status) → "Not synced", the banner carries the detail.
 */
export function offlineHint(s: SyncStatus): OfflineHint | null {
  if (!s.signedIn || s.rejected) return null;
  const answered = !!s.lastError && /\(\d{3}\)/.test(s.lastError);
  if (s.online && s.failingSince && answered) return { kind: 'notSynced', label: syncCopy.hintNotSynced, aria: syncCopy.hintNotSyncedAria };
  if (!s.online || s.failingSince) {
    return { kind: 'offline', label: s.pending > 0 ? syncCopy.hintWaiting(s.pending) : syncCopy.hintOffline, aria: syncCopy.hintOfflineAria };
  }
  return null;
}
