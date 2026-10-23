// §7.8 / §11.9 toast: one message, an optional Undo (never the stack depth), a draining
// progress line. Hover / focus pauses the timer itself, so Undo cannot vanish under the pointer.
// Copy comes only from the store (§15.1). Cmd+Z lives in App.
import { useState } from 'react';
import { useStore, type Toast as ToastData } from '../hooks/useStore';
import { springAnimate } from '../lib/motion';
import { instantMotion } from '../lib/presence';
import { SPRINGS } from '../lib/spring';

export default function Toast({ phone }: { phone: boolean }) {
  const { toast, dismissToast, pauseToast, resumeToast } = useStore();
  // A toast that goes (or is replaced) stays for its exit on the snappy spring, rendered in
  // the same commit that removes it (no blank frame).
  const [prev, setPrev] = useState<ToastData | null>(toast);
  const [leaving, setLeaving] = useState<ToastData[]>([]);
  if ((prev?.id ?? null) !== (toast?.id ?? null)) {
    setPrev(toast);
    if (prev && !instantMotion()) setLeaving((l) => [...l.filter((t) => t.id !== prev.id), prev]);
  }
  const exits = leaving.map((t) => (
    <div
      key={`leaving-${t.id}`}
      className={`toast toast-leaving${phone ? ' toast-phone' : ''}`}
      aria-hidden
      ref={(el) => {
        if (!el || el.dataset.leaving) return;
        el.dataset.leaving = '1';
        const a = springAnimate(el, SPRINGS.snappy, (p) => ({ transform: `translate(-50%, ${16 * p}px)`, opacity: 1 - p }));
        a.onfinish = () => setLeaving((l) => l.filter((x) => x.id !== t.id));
      }}
    >
      <span className="toast-msg">{t.message}</span>
    </div>
  ));
  if (!toast) return <>{exits}</>;

  return (
    <>
    {exits}
    <div
      key={toast.id}
      className={`toast${phone ? ' toast-phone' : ''}`}
      role="status"
      aria-live="polite"
      data-testid="toast"
      onPointerEnter={pauseToast}
      onPointerLeave={resumeToast}
      onFocus={pauseToast}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resumeToast();
      }}
    >
      <span className="toast-msg">{toast.message}</span>
      {toast.undo && (
        <button
          type="button"
          className="toast-undo"
          onClick={() => toast.undo?.()}
          data-testid="toast-undo"
        >
          Undo
        </button>
      )}
      <button type="button" className="toast-dismiss" onClick={dismissToast} aria-label="Dismiss">
        ×
      </button>
      <span className="toast-drain" style={{ animationDuration: `${toast.ms}ms` }} aria-hidden />
    </div>
    </>
  );
}
