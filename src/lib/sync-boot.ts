// Wires the SyncEngine to the store: one engine per tab, on by default when the
// server knows this browser (session cookie) or a token exists. React reads its
// status through useSyncStatus().
import { useEffect, useState } from 'react';
import { actions, broadcast, setCommitHook, setCrossTabHook, setReadOnly, state } from '../hooks/useStore';
import { SyncEngine, hasBackend, rememberedViewer, type SyncStatus } from './sync';
import { uploads } from './uploads';

// The view link's marker cookie decides the first frame: read-only before the server answers, offline too.
setReadOnly(rememberedViewer());

export const sync = new SyncEngine(
  () => state.board.cards,
  (cards, labels, silent) => actions.replaceBoard(cards, labels, silent),
  () => state.board.labels,
);

// A viewer (or a revoked one) is read-only; signing in as the owner lifts it.
sync.subscribe((s) => setReadOnly(s.viewer || s.unshared));
sync.onDiscard = () => uploads.clear();

let booted = false;
/** Call once the board is ready. A token syncs at once; otherwise ask the server for a session. */
export function bootSync(): void {
  if (booted) return;
  booted = true;
  setCommitHook((type) => sync.onLocalChange(type));
  // Signed in (or a remembered account): the server is the truth, so another window's change means "pull now".
  setCrossTabHook(() => {
    if (!sync.status.signedIn && !sync.status.user && !hasBackend()) return false;
    sync.hint();
    return true;
  });
  sync.onPushed = broadcast;
  // The marker alone discards nothing: read-only until the server answers, then a viewer's unsent
  // edits go (setViewer) while an owner who opened their own link keeps theirs.
  sync.rebase();
  if (hasBackend()) {
    sync.start();
    return;
  }
  void sync.probe();
  // Booted offline or the server was unreachable: ask again when it may be back.
  const retry = () => {
    if (!sync.status.signedIn && !sync.status.needsLogin && !hasBackend()) void sync.probe();
  };
  if (typeof window !== 'undefined') window.addEventListener('online', retry);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') retry(); });
}

export function useSyncStatus(): SyncStatus {
  const [s, setS] = useState<SyncStatus>(sync.status);
  useEffect(() => sync.subscribe(setS), []);
  return s;
}
