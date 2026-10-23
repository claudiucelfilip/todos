// §7.13 Sync: "Synced · 2 min ago" (or offline / waiting / failing), who is signed
// in, and Sign out. Sign-in itself is the full-screen LoginScreen; no token UI here.
import { useEffect, useState } from 'react';
import { sync, useSyncStatus } from '../lib/sync-boot';
import { syncCopy } from '../lib/copy';
import { statusLine } from '../lib/sync-line';

export default function SyncSection() {
  const status = useSyncStatus();
  const [, tick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => tick((v) => v + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const line = statusLine(status);

  return (
    <section className="settings-group" data-testid="sync-section">
      <div className="settings-row">
        <span>{syncCopy.sync}</span>
        <span className="mono" data-testid="sync-status">{line}</span>
      </div>
      {/* The account row stays while offline: the remembered user is still signed in here. */}
      {(status.signedIn || status.rejected || (!!status.user && !status.needsLogin)) && (
        <div className="settings-row">
          <span className="mono">{status.user ? syncCopy.signedInAs(status.user) : syncCopy.signedInWithToken}</span>
          <button type="button" className="btn" onClick={() => void sync.signOut()} data-testid="sync-signout">
            {syncCopy.signOut}
          </button>
        </div>
      )}
      {status.lastError && status.signedIn && <div className="mono settings-hint">{status.lastError}</div>}
    </section>
  );
}
