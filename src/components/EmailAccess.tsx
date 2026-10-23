import { useEffect, useState } from 'react';
import { accountRequest, clearAccount, currentAccount, refreshAccount, switchRoom } from '../lib/account';
import { sync } from '../lib/sync-boot';

export function useEmailAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => { void fetch('/kanban/auth-options').then((r) => r.ok ? r.json() : null).then((body) => setAvailable(!!body?.email)).catch(() => {}); }, []);
  return available;
}

/** The sign-in this device is waiting for: the link may be opened anywhere and approved for this device. */
interface Waiting { email: string; request: string; code: string; at: number }
const WAIT_KEY = 'todos.emailWait';
const WAIT_MS = 15 * 60000;
function readWaiting(): Waiting | null {
  try {
    const saved = JSON.parse(localStorage.getItem(WAIT_KEY) || 'null') as Waiting | null;
    return saved?.request && Date.now() - saved.at < WAIT_MS ? saved : null;
  } catch { return null; }
}
function writeWaiting(value: Waiting | null): void {
  try { if (value) localStorage.setItem(WAIT_KEY, JSON.stringify(value)); else localStorage.removeItem(WAIT_KEY); } catch { /* storage unavailable */ }
}
// The server sends one email per address per minute, so asking again sooner keeps the request the email belongs to.
const LAST_KEY = 'todos.emailLast';
function recentRequest(email: string): Waiting | null {
  try {
    const last = JSON.parse(localStorage.getItem(LAST_KEY) || 'null') as Waiting | null;
    return last?.email === email && Date.now() - last.at < 60000 ? last : null;
  } catch { return null; }
}
function rememberRequest(value: Waiting): void {
  try { localStorage.setItem(LAST_KEY, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
const spaced = (code: string) => `${code.slice(0, 2)} ${code.slice(2)}`;
const inApp = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

async function openAccount(room: string): Promise<void> {
  if (currentAccount()) await sync.sync();
  writeWaiting(null);
  clearAccount(); await refreshAccount(); await switchRoom(room);
}

export function EmailAccess({ invite, linkAccount = false }: { invite?: string; linkAccount?: boolean }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [waiting, setWaiting] = useState<Waiting | null>(() => (linkAccount ? null : readWaiting()));
  const [outcome, setOutcome] = useState<'used' | 'expired' | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Ask every few seconds (and as soon as the app is back in front) whether the link was approved for this device.
  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    const poll = async () => {
      if (stopped || document.hidden) return;
      try {
        const result = await accountRequest('/kanban/email/wait', { request: waiting.request });
        if (stopped) return;
        if (result.status === 'approved') { stopped = true; await openAccount(result.room); return; }
        if (result.status === 'used') {
          // Opened in this browser: the cookie is already here. Opened elsewhere: this device stays signed out.
          try { await refreshAccount(); stopped = true; await switchRoom(currentAccount()!.personalRoom); return; } catch { /* not this browser */ }
          stopped = true; writeWaiting(null); setWaiting(null); setOutcome('used');
        } else if (result.status === 'expired') { stopped = true; writeWaiting(null); setWaiting(null); setOutcome('expired'); }
      } catch { /* offline for a moment; the next poll tries again */ }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    document.addEventListener('visibilitychange', poll);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [waiting]);

  const reset = () => { writeWaiting(null); setWaiting(null); setSent(false); setOutcome(''); setError(''); };

  if (waiting) return <div className="email-access email-sent" role="status">
    <h2>Check your inbox</h2>
    <p>A link was sent to <strong>{waiting.email}</strong>. Open it on any device and type this code there; this {inApp() ? 'app' : 'screen'} then signs in by itself.</p>
    <p className="email-code mono" aria-label={`Code ${waiting.code.split('').join(' ')}`} data-testid="email-wait-code">{spaced(waiting.code)}</p>
    <p className="email-waiting"><span className="email-waiting-dot" aria-hidden /> Waiting for approval…</p>
    <button type="button" className="btn btn-quiet" onClick={reset}>Use another email or try again</button>
  </div>;

  return <form className="email-access" onSubmit={(e) => {
    e.preventDefault(); if (busy) return;
    setBusy(true); setError(''); setOutcome('');
    void accountRequest('/kanban/email/request', { email: email.trim(), invite, linkAccount, app: inApp() }).then((result) => {
      if (result.request && !linkAccount) {
        const next = recentRequest(email.trim()) ?? { email: email.trim(), request: result.request, code: result.code, at: Date.now() };
        rememberRequest(next); writeWaiting(next); setWaiting(next);
      } else setSent(true);
    }).catch((error) => setError(error.message)).finally(() => setBusy(false));
  }}>
    {sent ? <div className="email-sent" role="status"><h2>Check your inbox</h2><p>A link was requested for <strong>{email}</strong>. If it can be used, you’ll receive an email shortly. Check your spam folder too.</p><p>The link works once and expires in 15 minutes.</p><button type="button" className="btn btn-quiet" onClick={reset}>Use another email or try again</button></div> : <>
      <label className="login-field"><span>Email address</span><input className="login-input" type="email" name="email" placeholder="you@example.com" autoComplete="email" autoCapitalize="none" autoCorrect="off" required maxLength={254} value={email} disabled={busy} onChange={(e) => setEmail(e.target.value)} /></label>
      <p className="email-help">{linkAccount ? 'Verify your email to sign in without your password.' : 'New here? Your first sign-in creates a private account. No password needed.'}</p>
      {outcome === 'used' && <p className="login-error" role="alert">That link signed in another browser. Request a new one to sign in here.</p>}
      {outcome === 'expired' && <p className="login-error" role="alert">That link expired. Request a new one.</p>}
      <button type="submit" className="btn btn-accent login-submit" disabled={busy}>{busy ? 'Sending…' : linkAccount ? 'Verify email' : 'Email me a sign-in link'}</button>
    </>}
    {error && <p className="login-error" role="alert">{error}</p>}
  </form>;
}

/** The page the emailed link opens: approve the sign-in for the device that asked, or continue here. */
export function EmailConfirmation({ token }: { token: string }) {
  const [info, setInfo] = useState<{ device: string; sent: number } | null | undefined>(undefined);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'approve' | 'here' | ''>('');
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  const mine = readWaiting(); // this browser asked: the waiting tab (if any) picks the session up by itself
  const forget = () => { try { sessionStorage.removeItem('todos.emailPending'); } catch { /* session storage unavailable */ } };

  useEffect(() => {
    void accountRequest('/kanban/email/link', { token }).then(setInfo).catch((error) => {
      setInfo(null);
      setError(error instanceof TypeError ? "Can't reach the server. Try again in a moment." : error.message);
    });
  }, [token]);

  // This browser asked (the waiting tab's code is in its storage): no other device to approve, just continue.
  const sameBrowser = !!(info && mine);
  const approve = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return; setBusy('approve'); setError('');
    void accountRequest('/kanban/email/approve', { token, code }).then((result) => { forget(); setDone(result.device); }).catch((error) => { setError(error.message); setBusy(''); setCode(''); });
  };
  const here = () => {
    if (busy) return; setBusy('here'); setError('');
    void (async () => {
      const result = await accountRequest('/kanban/email/consume', { token });
      forget(); await openAccount(result.room);
    })().catch((error) => { forget(); setError(error.message); setBusy(''); });
  };
  const minutes = info ? Math.max(0, Math.round((Date.now() - info.sent) / 60000)) : 0;
  const when = minutes === 0 ? 'just now' : minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;

  return <div className="login-screen"><div className="login-card">
    <p className="mono invitation-eyebrow">Email sign-in</p>
    {done ? <>
      <h1 className="login-title">Signed in</h1>
      <p className="email-help">Go back to {done}. It is signed in and ready. You can close this page.</p>
    </> : info === undefined && !error ? <p className="email-help">Checking the link…</p> : info ? <>
      <h1 className="login-title">{sameBrowser ? 'Welcome to Todos' : `Sign in on ${info.device}?`}</h1>
      {sameBrowser ? <>
        <p className="email-help">Continue to confirm your email and open your account.</p>
        <button type="button" className="btn btn-accent login-submit" disabled={!!busy} onClick={here} data-testid="email-continue">{busy ? 'Opening…' : 'Continue to Todos'}</button>
      </> : <form className="email-access" onSubmit={approve}>
        <p className="email-help">{info.device[0].toUpperCase() + info.device.slice(1)} asked for this link {when}. Type the four-digit code it is showing; that signs it in. If nothing of yours is waiting, ignore this email.</p>
        <label className="login-field"><span>Code shown on {info.device}</span><input className="login-input email-code-input" placeholder="0000" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={5} required value={code} disabled={!!busy} onChange={(e) => { setCode(e.target.value.replace(/[^\d ]/g, '')); setError(''); }} data-testid="email-code-input" /></label>
        <button type="submit" className="btn btn-accent login-submit" disabled={!!busy || code.replace(/\D/g, '').length !== 4} data-testid="email-approve">{busy === 'approve' ? 'Signing in…' : `Sign in on ${info.device}`}</button>
        <button type="button" className="btn btn-quiet email-here" disabled={!!busy} onClick={here} data-testid="email-continue">{busy === 'here' ? 'Opening…' : 'Continue in this browser instead'}</button>
      </form>}
    </> : null}
    {error && <><p className="login-error" role="alert">{error}</p><a className="btn btn-quiet" href="/">Request a new link</a></>}
  </div></div>;
}
