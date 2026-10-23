// Email is the primary sign-in; older accounts retain password access during migration.
import { useEffect, useRef, useState } from 'react';
import { EmailAccess, useEmailAvailable } from './EmailAccess';
import { sync, useSyncStatus } from '../lib/sync-boot';
import { shareCopy, syncCopy } from '../lib/copy';

export default function LoginScreen() {
  const emailAvailable = useEmailAvailable();
  const [legacy, setLegacy] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const userRef = useRef<HTMLInputElement>(null);
  useEffect(() => userRef.current?.focus(), []);
  const fromView = useSyncStatus().viewer; // opened from a view link that still works

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const r = await sync.login(username.trim(), password);
    setBusy(false);
    if (r === 'ok') return;
    setError(r === 'limited' ? syncCopy.tooManyAttempts : r === 'offline' ? syncCopy.unreachable : syncCopy.wrongCredentials);
    if (r === 'invalid') setPassword('');
  };

  return (
    <div className="login-screen" role="dialog" aria-modal="true" aria-labelledby="login-title">
      {emailAvailable && !legacy ? <div className="login-card">
        <h1 id="login-title" className="login-title">Todos</h1><p className="email-help">Your tasks, one email away.</p>
        <EmailAccess /><button type="button" className="btn btn-quiet email-legacy" onClick={() => setLegacy(true)}>Existing account with a password</button>
        {fromView && <button type="button" className="btn btn-quiet" onClick={() => sync.backToView()}>{shareCopy.back}</button>}
      </div> : <form className="login-card" method="post" action="/kanban/login" onSubmit={submit} data-testid="login-form">
        <h1 id="login-title" className="login-title">Todos</h1>
        <label className="login-field">
          <span>{syncCopy.username}</span>
          <input
            ref={userRef}
            className="login-input"
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            data-testid="login-username"
          />
        </label>
        <label className="login-field">
          <span>{syncCopy.password}</span>
          <input
            className="login-input"
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="login-password"
          />
        </label>
        {error && <p className="login-error" role="alert" data-testid="login-error">{error}</p>}
        <button type="submit" className="btn btn-accent login-submit" disabled={busy} data-testid="login-submit">
          {busy ? syncCopy.signingIn : syncCopy.signIn}
        </button>
        {fromView && (
          <button type="button" className="btn btn-quiet" data-testid="login-back" onClick={() => sync.backToView()}>
            {shareCopy.back}
          </button>
        )}
        {emailAvailable && <button type="button" className="btn btn-quiet" onClick={() => setLegacy(false)}>Sign in with email</button>}
      </form>}
    </div>
  );
}
