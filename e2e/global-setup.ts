import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
export const STATE_FILE = path.join(root, 'e2e/.auth/server.json');
export const OWNER = { username: 'e2eowner', password: 'e2e-owner-password' };

function newestMtime(dir: string): number {
  let newest = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return newest;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

export default async function globalSetup() {
  const dist = path.join(root, 'dist/index.html');
  const stale =
    !fs.existsSync(dist) ||
    fs.statSync(dist).mtimeMs < Math.max(newestMtime(path.join(root, 'src')), fs.statSync(path.join(root, 'index.html')).mtimeMs);
  if (stale) execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-e2e-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      DATA_DIR: dir,
      PORT: String(port),
      NTFY_SERVER: 'http://127.0.0.1:9',
      TODOS_USER: OWNER.username,
      TODOS_PASS: OWNER.password,
    },
  });
  child.unref();

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/kanban/session`)).status < 500) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('e2e server did not start');
    await new Promise((r) => setTimeout(r, 150));
  }

  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: child.pid, dir, base }));
  process.env.E2E_BASE = base;

  // Owner session, saved as e2e/.auth/state.json (tests use their own per-test accounts, see fixtures.ts).
  const res = await fetch(`${base}/kanban/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(OWNER),
  });
  if (!res.ok) throw new Error(`owner login failed: ${res.status}`);
  const [name, ...rest] = res.headers.getSetCookie()[0].split(';')[0].split('=');
  fs.writeFileSync(
    path.join(root, 'e2e/.auth/state.json'),
    JSON.stringify({ cookies: [{ name, value: rest.join('='), domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax', expires: -1 }], origins: [] }),
  );
}
