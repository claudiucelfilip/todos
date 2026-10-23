// Servers for the visual harness: the app (built, on a temp DATA_DIR, as e2e/global-setup does) and a
// static server for the prototype. Also makes a fresh seeded account the way e2e/fixtures.ts does.
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const root = path.resolve(import.meta.dirname, '../..');
const OWNER = { username: 'visualowner', password: 'visual-owner-password' };
const json = { 'content-type': 'application/json' };

function newestMtime(dir) {
  let newest = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return newest;
}

export const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

export function buildIfStale() {
  const dist = path.join(root, 'dist/index.html');
  const stale = !fs.existsSync(dist) || fs.statSync(dist).mtimeMs < Math.max(newestMtime(path.join(root, 'src')), fs.statSync(path.join(root, 'index.html')).mtimeMs);
  if (stale || process.env.VISUAL_BUILD === '1') {
    console.log('building the app (dist is stale)…');
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  }
}

export async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-visual-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, DATA_DIR: dir, PORT: String(port), NTFY_SERVER: 'http://127.0.0.1:9', TODOS_USER: OWNER.username, TODOS_PASS: OWNER.password },
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/kanban/session`)).status < 500) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('app server did not start');
    await new Promise((r) => setTimeout(r, 150));
  }
  return { base, stop: () => { try { child.kill('SIGTERM'); } catch {} fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** Serves one directory (the prototype: v6.html + support.js). */
export async function startStatic(dir) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(p).pipe(res);
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${port}`, stop: () => server.close() };
}

const cookieOf = (res) => res.headers.getSetCookie()[0].split(';')[0];

/** A brand-new account (owner-issued invitation), seeded with the prototype's board at the fixed clock. */
export async function createSeededAccount(base, tag, nowIso) {
  const login = await fetch(`${base}/kanban/login`, { method: 'POST', headers: json, body: JSON.stringify(OWNER) });
  if (!login.ok) throw new Error(`owner login failed: ${login.status}`);
  const owner = cookieOf(login);
  const post = (route, cookie, body) => fetch(base + route, { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify(body) });
  const room = (await (await post('/kanban/rooms', owner, { name: `Invites ${process.pid}` })).json()).room.id;
  const { url } = await (await post('/kanban/invite', owner, { room })).json();
  const token = new URL(url).searchParams.get('invite');
  const username = `v${tag}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const password = `pw-${tag}-visual-password`;
  const reg = await post('/kanban/register', '', { username, password, token });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  const cookie = cookieOf(reg);
  const { stdout } = await run(process.execPath, ['scripts/visual/seed-design.mjs'], {
    cwd: root,
    env: { ...process.env, TODOS_BASE: base, TODOS_USER: username, TODOS_PASS: password, VISUAL_NOW: nowIso },
  });
  return { username, password, cookie, base, seedLog: stdout.trim() };
}
