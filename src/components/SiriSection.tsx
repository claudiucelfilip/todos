// Settings → Siri: one capture token per account and two signed shortcut files to install
// ("Add todo", "Add list"). Set up, install, make new ones (the old stop working) or turn off.
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/sync';
import { siriCopy } from '../lib/copy';

type Shortcut = { kind: string; name: string; say: string; example: string; url: string };
type Info = { enabled: boolean; created: number | null; signing: boolean; shortcuts: Shortcut[] };
type Confirm = 'stop' | 'renew' | null;

async function call(method: 'GET' | 'POST' | 'DELETE'): Promise<Info | 'unreachable' | 'failed'> {
  let r: Response;
  try {
    r = await apiFetch('/kanban/shortcuts', { method, headers: { Accept: 'application/json' } });
  } catch {
    return 'unreachable';
  }
  if (r.status >= 500 || !/json/.test(r.headers.get('content-type') ?? '')) return 'unreachable';
  const json = (await r.json().catch(() => null)) as Info | null;
  return r.ok && json && typeof json.enabled === 'boolean' ? json : 'failed';
}

export default function SiriSection() {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<'unreachable' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const run = async (method: 'GET' | 'POST' | 'DELETE') => {
    setBusy(true);
    const r = await call(method);
    setBusy(false);
    if (typeof r === 'string') {
      setError(r);
      return false;
    }
    setError(null);
    setInfo(r);
    return true;
  };

  useEffect(() => {
    void run('GET');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="settings-group settings-siri" aria-label={siriCopy.title} data-testid="siri-section">
      <div className="settings-row">
        <span>{siriCopy.title}</span>
        {!info && !error && <span className="mono settings-hint">{siriCopy.loading}</span>}
      </div>
      <p className="settings-hint notify-hint">{siriCopy.explain}</p>
      {error && (
        <p className="mono settings-hint share-error" role="status" data-testid="siri-error">
          {error === 'unreachable' ? siriCopy.unreachable : siriCopy.failed}
        </p>
      )}
      {info && !info.enabled && (
        <div className="notify-actions">
          <button type="button" className="btn" disabled={busy} data-testid="siri-setup" onClick={() => void run('POST')}>
            {siriCopy.setup}
          </button>
        </div>
      )}
      {info?.enabled && (
        <>
          {info.signing ? (
            <>
              <ul className="siri-list">
                {info.shortcuts.map((s) => (
                  <li key={s.kind} className="siri-item">
                    <div className="siri-text">
                      <span className="siri-name">{s.name}</span>
                      <span className="mono settings-hint siri-say">{s.say}</span>
                      <span className="settings-hint siri-example">{s.example}</span>
                    </div>
                    <a className="btn" href={s.url} download={`${s.name}.shortcut`} target="_blank" rel="noopener" data-testid={`siri-install-${s.kind}`}>
                      {siriCopy.install}
                    </a>
                  </li>
                ))}
              </ul>
              <p className="settings-hint notify-hint">{siriCopy.installHint}</p>
            </>
          ) : (
            <p className="mono settings-hint share-error" role="status">{siriCopy.noSigning}</p>
          )}
          {confirm ? (
            <div className="settings-import share-confirm" role="group" aria-label={confirm === 'stop' ? siriCopy.stop : siriCopy.renew} data-testid="siri-confirm">
              <span>{confirm === 'stop' ? siriCopy.stopConfirm : siriCopy.renewConfirm}</span>
              <div className="settings-import-actions">
                <button
                  type="button"
                  className={`btn ${confirm === 'stop' ? 'btn-danger' : 'btn-accent'}`}
                  disabled={busy}
                  data-testid="siri-confirm-yes"
                  onClick={async () => {
                    if (await run(confirm === 'stop' ? 'DELETE' : 'POST')) setConfirm(null);
                  }}
                >
                  {confirm === 'stop' ? siriCopy.confirmStop : siriCopy.confirmRenew}
                </button>
                <button type="button" className="btn btn-quiet" onClick={() => setConfirm(null)}>
                  {siriCopy.cancel}
                </button>
              </div>
            </div>
          ) : (
            <div className="notify-actions">
              <button type="button" className="btn" data-testid="siri-renew" onClick={() => setConfirm('renew')}>
                {siriCopy.renew}
              </button>
              <button type="button" className="btn btn-danger" data-testid="siri-stop" onClick={() => setConfirm('stop')}>
                {siriCopy.stop}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
