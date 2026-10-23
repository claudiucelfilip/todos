// Mono lines under the header (§13.4 storage, §13.1 corrupt,
// §7.13 backup reminder, §13.1 updated). Copy from §15.1 only.
import { useEffect, useState } from 'react';
import { useStore } from '../hooks/useStore';
import { useSyncStatus } from '../lib/sync-boot';
import { currentAccount } from '../lib/account';
import { hasBackend } from '../lib/sync';
import { copy, syncCopy } from '../lib/copy';

const SNOOZE_KEY = 'kept.backupSnoozedUntil';
const DAY = 86400000;

function ls(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Download the board as kanban-YYYY-MM-DD.json (shared with Settings). */
export function downloadBoard(json: string, name: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Banners() {
  const { cards, settings, storageFailed, corrupt, retryWrites, exportJSON, exportFilename, readOnly } = useStore();
  const [corruptSeen, setCorruptSeen] = useState(false);
  const [snoozedUntil, setSnoozedUntil] = useState(() => Number(ls()?.getItem(SNOOZE_KEY) ?? 0));
  const [updated, setUpdated] = useState<string | null>(null);

  useEffect(() => {
    const onUpdated = (e: Event) => {
      const v = (e as CustomEvent<{ version?: string }>).detail?.version;
      if (v) setUpdated(v);
    };
    window.addEventListener('kanban:updated', onUpdated);
    return () => {
      window.removeEventListener('kanban:updated', onUpdated);
    };
  }, []);

  const doExport = () => downloadBoard(exportJSON(), exportFilename());

  const syncStatus = useSyncStatus();
  const liveCount = cards.filter((c) => !c.archivedAt).length;
  const backupStale =
    !settings.lastBackupAt || Date.now() - new Date(settings.lastBackupAt).getTime() > 30 * DAY;
  // Sync counts as a backup (§7.13: "sync is off").
  const showBackup = liveCount >= 50 && backupStale && !currentAccount() && !hasBackend() && !syncStatus.signedIn && Date.now() > snoozedUntil;
  // §13.3: one-line banner only when pushing has failed for > 24 h.
  const stalledSince = syncStatus.signedIn && syncStatus.failingSince && Date.now() - new Date(syncStatus.failingSince).getTime() > DAY
    ? syncStatus.failingSince
    : null;

  const lines: JSX.Element[] = [];

  if (storageFailed && !readOnly) {
    lines.push(
      <div className="banner banner-warn" key="storage" data-testid="banner-storage">
        <span className="mono">{copy.storageFailure()}</span>
        <button type="button" className="banner-btn" onClick={doExport}>
          Export
        </button>
        <button type="button" className="banner-btn" onClick={() => void retryWrites()}>
          Retry
        </button>
      </div>,
    );
  }

  if (corrupt > 0 && !corruptSeen) {
    lines.push(
      <div className="banner" key="corrupt" data-testid="banner-corrupt">
        <span className="mono">{copy.corruptRecord(corrupt)}</span>
        <button type="button" className="banner-x" aria-label="Dismiss" onClick={() => setCorruptSeen(true)}>
          ×
        </button>
      </div>,
    );
  }

  if (stalledSince) {
    lines.push(
      <div className="banner" key="sync" data-testid="banner-sync">
        <span className="mono">{copy.syncStalled(new Date(stalledSince).toLocaleDateString(undefined, { weekday: 'long' }))}</span>
      </div>,
    );
  }

  // Any failing sync run is visible at once (subtle), with the reason.
  if (!stalledSince && syncStatus.signedIn && syncStatus.online && syncStatus.failingSince && syncStatus.lastError) {
    lines.push(
      <div className="banner" key="sync-failing" data-testid="banner-sync-failing">
        <span className="mono">{syncCopy.failingWith(syncStatus.lastError)}</span>
      </div>,
    );
  }

  if (showBackup) {
    lines.push(
      <div className="banner" key="backup" data-testid="banner-backup">
        <span className="mono">{copy.backupReminder(liveCount)}</span>
        <button type="button" className="banner-btn" onClick={doExport}>
          Export
        </button>
        <button
          type="button"
          className="banner-x"
          aria-label="Dismiss"
          onClick={() => {
            const until = Date.now() + 30 * DAY;
            ls()?.setItem(SNOOZE_KEY, String(until));
            setSnoozedUntil(until);
          }}
        >
          ×
        </button>
      </div>,
    );
  }

  if (updated) {
    lines.push(
      <div className="banner" key="updated" data-testid="banner-updated">
        <span className="mono">{copy.updated(updated)}</span>
        <button type="button" className="banner-x" aria-label="Dismiss" onClick={() => setUpdated(null)}>
          ×
        </button>
      </div>,
    );
  }

  if (!lines.length) return null;
  return <div className="banners">{lines}</div>;
}
