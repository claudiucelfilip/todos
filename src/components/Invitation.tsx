import { useEffect, useState } from 'react';
import { accountRequest, currentAccount, refreshAccount, switchRoom } from '../lib/account';
import { EmailAccess, useEmailAvailable } from './EmailAccess';
import { sync } from '../lib/sync-boot';

export default function Invitation({ token }: { token: string }) {
  const emailAvailable = useEmailAvailable();
  const [legacy, setLegacy] = useState(false);
  const [room, setRoom] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [register, setRegister] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const account = currentAccount();
  useEffect(() => {
    void fetch(`/kanban/invitation?token=${encodeURIComponent(token)}`).then(async (res) => { const body = await res.json(); if (!res.ok) throw new Error(body.error); setRoom(body.room); }).catch((error) => setError(error.message));
  }, [token]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {
      let roomId: string;
      if (account) roomId = (await accountRequest('/kanban/join', { token })).room.id;
      else if (register) roomId = (await accountRequest('/kanban/register', { username: username.trim(), password, token })).room;
      else {
        await accountRequest('/kanban/login', { username: username.trim(), password });
        roomId = (await accountRequest('/kanban/join', { token })).room.id;
      }
      await refreshAccount();
      if (account) await sync.sync();
      await switchRoom(roomId);
    } catch (error) { setError((error as Error).message); setBusy(false); }
  };
  if (emailAvailable && !account && !legacy) return <div className="login-screen"><div className="login-card">
    <p className="mono invitation-eyebrow">You’re invited</p><h1 className="login-title">{room ? `Join ${room}` : 'Room invitation'}</h1>
    {room ? <EmailAccess invite={token} /> : <p className="email-help">{error || 'Checking invitation…'}</p>}
    <button type="button" className="btn btn-quiet email-legacy" onClick={() => { setLegacy(true); setRegister(false); }}>Existing account with a password</button><a className="btn btn-quiet" href="/">Back to Todos</a>
  </div></div>;
  return <div className="login-screen"><form className="login-card" onSubmit={submit}>
    <p className="mono invitation-eyebrow">You’re invited</p><h1 className="login-title">{room ? `Join ${room}` : 'Room invitation'}</h1>
    <p className="settings-hint">{account ? `Join as ${account.user}. Your personal room stays private.` : 'Share tasks here, with a private room and your own preferences too.'}</p>
    {!account && <>
      <label className="login-field"><span>Username</span><input className="login-input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required minLength={register ? 3 : undefined} maxLength={40} autoCapitalize="none" /></label>
      <label className="login-field"><span>Password</span><input className="login-input" type="password" autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} minLength={register ? 10 : undefined} required /></label>
      {register && <p className="settings-hint">At least 10 characters.</p>}
    </>}
    {error && <p className="login-error" role="alert">{error}</p>}
    <button className="btn btn-accent login-submit" disabled={busy || !room}>{busy ? 'Joining…' : account ? 'Join room' : register ? 'Create account and join' : 'Sign in and join'}</button>
    {!account && !emailAvailable && <button type="button" className="btn btn-quiet" onClick={() => { setRegister(!register); setError(''); }}>{register ? 'Already have an account? Sign in' : 'Create a new account'}</button>}
    {emailAvailable && !account && <button type="button" className="btn btn-quiet" onClick={() => setLegacy(false)}>Sign in with email</button>}
    <a className="btn btn-quiet" href="/">Back to Todos</a>
  </form></div>;
}
