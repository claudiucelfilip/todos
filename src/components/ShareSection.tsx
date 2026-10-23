// Settings → Share (owner only): one view-only link to the whole board. Create it, copy it,
// replace it (the old one stops working) or stop sharing; both ask first, in place.
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/sync';
import { copy, shareCopy } from '../lib/copy';
import { useStore } from '../hooks/useStore';

type Info = { shared: boolean; url: string | null };
type Confirm = 'stop' | 'rotate' | null;

async function call(method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<Info | 'unreachable' | 'failed'> {
  let r: Response;
  try {
    r = await apiFetch('/kanban/share', {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    return 'unreachable';
  }
  // A gateway error or a non-JSON page (the tunnel with the server down) means the server is not there.
  if (r.status >= 500 || !/json/.test(r.headers.get('content-type') ?? '')) return 'unreachable';
  const json = (await r.json().catch(() => null)) as Info | null;
  return r.ok && json && typeof json.shared === 'boolean' ? json : 'failed';
}

export default function ShareSection() {
  const { showToast } = useStore();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<'unreachable' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const run = async (method: 'GET' | 'POST' | 'DELETE', body?: unknown) => {
    setBusy(true);
    const r = await call(method, body);
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

  const copyUrl = () => {
    if (!info?.url) return;
    void navigator.clipboard?.writeText(info.url).then(() => showToast(copy.copied()), () => {});
  };

  return (
    <section className="settings-group settings-share" aria-label={shareCopy.title} data-testid="share-section">
      <div className="settings-row">
        <span>{shareCopy.title}</span>
        {!info && !error && <span className="mono settings-hint">{shareCopy.loading}</span>}
      </div>
      <p className="settings-hint notify-hint">{shareCopy.explain}</p>
      {error && (
        <p className="mono settings-hint share-error" role="status" data-testid="share-error">
          {error === 'unreachable' ? shareCopy.unreachable : shareCopy.failed}
        </p>
      )}
      {info && !info.shared && (
        <div className="notify-actions">
          <button type="button" className="btn" disabled={busy} data-testid="share-create" onClick={() => void run('POST', {})}>
            {shareCopy.create}
          </button>
        </div>
      )}
      {info?.shared && info.url && (
        <>
          <div className="notify-topic">
            <code className="mono share-url" aria-label={shareCopy.urlAria} title={info.url} data-testid="share-url">{info.url}</code>
            <button type="button" className="btn" data-testid="share-copy" onClick={copyUrl}>
              {shareCopy.copy}
            </button>
          </div>
          {confirm ? (
            <div className="settings-import share-confirm" role="group" aria-label={confirm === 'stop' ? shareCopy.stop : shareCopy.rotate} data-testid="share-confirm">
              <span>{confirm === 'stop' ? shareCopy.stopConfirm : shareCopy.rotateConfirm}</span>
              <div className="settings-import-actions">
                <button
                  type="button"
                  className={`btn ${confirm === 'stop' ? 'btn-danger' : 'btn-accent'}`}
                  disabled={busy}
                  data-testid="share-confirm-yes"
                  onClick={async () => {
                    if (await run(confirm === 'stop' ? 'DELETE' : 'POST', confirm === 'stop' ? undefined : { rotate: true })) setConfirm(null);
                  }}
                >
                  {confirm === 'stop' ? shareCopy.confirmStop : shareCopy.confirmRotate}
                </button>
                <button type="button" className="btn btn-quiet" onClick={() => setConfirm(null)}>
                  {shareCopy.cancel}
                </button>
              </div>
            </div>
          ) : (
            <div className="notify-actions">
              <button type="button" className="btn" data-testid="share-rotate" onClick={() => setConfirm('rotate')}>
                {shareCopy.rotate}
              </button>
              <button type="button" className="btn btn-danger" data-testid="share-stop" onClick={() => setConfirm('stop')}>
                {shareCopy.stop}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
