// Settings → Notifications: the ntfy topic reminders are pushed to, with Copy,
// "Open in ntfy" and "Send test". Shown once this device can reach the server.
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/sync';
import { copy, remindCopy } from '../lib/copy';
import { useStore } from '../hooks/useStore';

export default function NotificationsSection() {
  const { showToast } = useStore();
  const [info, setInfo] = useState<{ topic: string; subscribeUrl: string } | null | 'unavailable'>(null);
  useEffect(() => {
    let live = true;
    apiFetch('/kanban/notify-topic', { headers: { Accept: 'application/json' } })
      .then(async (r) => {
        const body = r.ok && /json/.test(r.headers.get('content-type') ?? '') ? await r.json() : null;
        if (live) setInfo(body?.topic ? body : 'unavailable');
      })
      .catch(() => live && setInfo('unavailable'));
    return () => {
      live = false;
    };
  }, []);

  return (
    <section className="settings-group settings-notify" aria-label={remindCopy.notifications} data-testid="notify-section">
      <div className="settings-row">
        <span>{remindCopy.notifications}</span>
      </div>
      {info === 'unavailable' && <p className="mono settings-hint">{remindCopy.unavailable}</p>}
      {info && info !== 'unavailable' && (
        <>
          <p className="settings-hint notify-hint">{remindCopy.instructions}</p>
          <div className="notify-topic">
            <code className="mono" data-testid="notify-topic">{info.topic}</code>
            <button
              type="button"
              className="btn"
              onClick={() => void navigator.clipboard?.writeText(info.topic).then(() => showToast(copy.copied()), () => {})}
            >
              {remindCopy.copy}
            </button>
          </div>
          <div className="notify-actions">
            <a className="btn" href={info.subscribeUrl} target="_blank" rel="noopener noreferrer" data-testid="notify-open">
              {remindCopy.open}
            </a>
            <button
              type="button"
              className="btn"
              data-testid="notify-test"
              onClick={() =>
                void apiFetch('/kanban/notify-test', { method: 'POST' })
                  .then((r) => showToast(r.ok ? remindCopy.testSent : remindCopy.testFailed))
                  .catch(() => showToast(remindCopy.testFailed))
              }
            >
              {remindCopy.test}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
