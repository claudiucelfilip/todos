import StudioThemePicker from './StudioThemePicker';
import { isStandalone, promptInstall, useInstall } from '../lib/install';
import { EmailAccess, useEmailAvailable } from './EmailAccess';
import { currentAccount, currentRoom } from '../lib/account';
// §7.13 settings: a small panel/sheet, not a page. Export, import (Replace /
// Merge preview), archive, retention, theme, motion, labels, sync, about.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../hooks/useStore';
import { copy } from '../lib/copy';
import { relativeDate } from '../lib/dates';
import { downloadBoard } from './Banners';
import SyncSection from './SyncSection';
import LabelsSection from './LabelsSection';
import NotificationsSection from './NotificationsSection';
import ShareSection from './ShareSection';
import SiriSection from './SiriSection';
import { CloseIcon } from './Icons';

declare const __APP_VERSION__: string;

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Trap Tab inside `ref`, Esc calls onClose, focus returns on unmount. */
export function useDialog(ref: React.RefObject<HTMLElement>, onClose: () => void, autoFocus = true): void {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const root = ref.current;
    if (autoFocus && root) {
      // The dialog container takes focus (§12); Tab then moves to its first control.
      root.focus({ preventScroll: true });
      if (document.activeElement !== root) root.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Close wherever focus is (D6/D7), unless a field inside is mid-edit.
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !root) return;
      if (!root.contains(document.activeElement)) {
        e.preventDefault();
        root.querySelector<HTMLElement>(FOCUSABLE)?.focus();
        return;
      }
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('disabled'));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // §12: back to what opened the dialog; never leave focus on <body>.
      const target = prev && prev !== document.body && document.contains(prev) ? prev : document.querySelector<HTMLElement>('main.board');
      target?.focus?.({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

interface Props {
  onClose(): void;
  onOpenArchive(): void;
  phone: boolean;
}

interface Pending {
  name: string;
  board: unknown;
  count: number;
}

export default function SettingsPanel({ onClose, onOpenArchive, phone }: Props) {
  const { cards, settings, updateSettings, exportJSON, exportFilename, importBoard, importText, showToast, readOnly } = useStore();
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, onClose);
  const emailAvailable = useEmailAvailable();

  const [pending, setPending] = useState<Pending | null>(null);
  const [storage, setStorage] = useState<string>('');
  const fileRef = useRef<HTMLInputElement>(null);

  const archived = cards.filter((c) => c.archivedAt).length;
  const install = useInstall();
  const live = cards.filter((c) => !c.archivedAt).length;
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

  useEffect(() => {
    void navigator.storage?.estimate?.().then((e) => {
      const kb = (e.usage ?? 0) / 1024;
      setStorage(kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`);
    });
  }, []);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    if (/\.(md|txt)$/i.test(file.name)) {
      importText(text);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      showToast(copy.badImport());
      return;
    }
    const b = parsed as { cards?: unknown[] } | null;
    if (!b || typeof b !== 'object' || !Array.isArray(b.cards)) {
      showToast(copy.badImport());
      return;
    }
    setPending({ name: file.name, board: parsed, count: b.cards.length });
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        ref={ref}
        className={`dialog settings${phone ? ' dialog-sheet' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="dialog-head">
          <h2>Settings</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close"><CloseIcon /></button>
        </header>

        <div className="dialog-body">
          <StudioThemePicker />
          {/* A view-only link: appearance only. */}
          {!readOnly && <section className="settings-group">
            <div className="settings-row">
              <span>Export board</span>
              <button type="button" className="btn" onClick={() => downloadBoard(exportJSON(), exportFilename())} data-testid="export">
                Download JSON
              </button>
            </div>
            <div className="settings-row">
              <span>Import board</span>
              <input
                ref={fileRef}
                type="file"
                accept=".json,.md,.txt,application/json,text/markdown,text/plain"
                className="sr-only"
                onChange={(e) => {
                  void onFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <button type="button" className="btn" onClick={() => fileRef.current?.click()} data-testid="import">
                Choose file
              </button>
            </div>
            {pending && (
              <div className="settings-import" data-testid="import-preview">
                <span className="mono">{copy.importPreview(live, pending.count)}</span>
                <div className="settings-import-actions">
                  <button
                    type="button"
                    className="btn btn-accent"
                    onClick={() => {
                      if (importBoard(pending.board, 'replace')) setPending(null);
                    }}
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      if (importBoard(pending.board, 'merge')) setPending(null);
                    }}
                  >
                    Merge
                  </button>
                  <button type="button" className="btn btn-quiet" onClick={() => setPending(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </section>}

          {!readOnly && <section className="settings-group">
            <div className="settings-row">
              <span>Archive</span>
              <button type="button" className="btn" onClick={onOpenArchive}>
                <span className="mono">{archived} archived</span>
              </button>
            </div>
            <div className="settings-row">
              <span>Install for offline use</span>
              {isStandalone() ? (
                <span className="mono settings-note">installed</span>
              ) : install.available ? (
                <button type="button" className="btn" onClick={() => void promptInstall()}>
                  Install
                </button>
              ) : (
                <span className="mono settings-note">browser menu → Add to Home Screen</span>
              )}
            </div>
            <label className="settings-row">
              <span>Archive after</span>
              <select
                value={settings.archiveAfterDays}
                onChange={(e) => updateSettings({ archiveAfterDays: Number(e.target.value) })}
              >
                <option value={7}>7 days</option>
                <option value={14}>14 days</option>
                <option value={30}>30 days</option>
                <option value={0}>never</option>
              </select>
            </label>
            {currentAccount() && (
              <label className="settings-row settings-row-help">
                <span>
                  Suggest titles and labels
                  <small>Uses the assistant on this server. Nothing you type is changed.</small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={settings.suggest !== false}
                  onChange={(e) => updateSettings({ suggest: e.target.checked })}
                />
              </label>
            )}
          </section>}

          <section className="settings-group">
            <label className="settings-row">
              <span>Motion</span>
              <select
                value={settings.reduceMotion}
                onChange={(e) => updateSettings({ reduceMotion: e.target.value as typeof settings.reduceMotion })}
              >
                <option value="system">System</option>
                <option value="on">Reduced</option>
                <option value="off">Full</option>
              </select>
            </label>
          </section>

          {!readOnly && (
            <>
              <LabelsSection />

              <NotificationsSection />

              {(!currentAccount() || currentRoom()?.owner === currentAccount()?.user) && <ShareSection />}

              {currentAccount() && <SiriSection />}

              {emailAvailable && currentAccount() && <section className="email-settings" aria-label="Email sign-in"><h3>Email sign-in</h3>{currentAccount()?.email ? <p className="email-help">Sign in with a link sent to {currentAccount()?.email}.</p> : <EmailAccess linkAccount />}</section>}
              <SyncSection />
            </>
          )}

          {!readOnly && <section className="settings-group settings-about mono">
            <div>version {version}</div>
            {storage && <div>storage used {storage}</div>}
            <div>last backup {settings.lastBackupAt ? relativeDate(settings.lastBackupAt) : 'never'}</div>
          </section>}
        </div>
      </div>
    </div>
  );
}
