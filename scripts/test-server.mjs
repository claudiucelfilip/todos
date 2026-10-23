// Test helper: start server.js on a port the OS says is free, and count it as up only
// when THIS child logs "listening on" (a stray server on the same port can't answer for
// it). Children are killed when the test process exits, so a crashed run leaks nothing.
import net from 'node:net';
import { spawn } from 'node:child_process';

const children = new Set();
process.on('exit', () => {
  for (const c of children) try { c.kill('SIGKILL'); } catch { /* gone */ }
});

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Spawn `node script` with env; resolves { child, port, base, logs() } once it is listening. */
export async function startServer(script, { env = {}, cwd, port } = {}) {
  const p = port ?? (await freePort());
  return new Promise((resolve, reject) => {
    // Never reach the real ntfy.sh from a test: a dead local port unless the test brings a stub.
    const child = spawn('node', [script], { cwd, env: { ...process.env, NTFY_SERVER: 'http://127.0.0.1:9', ...env, PORT: String(p) }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let out = '';
    let up = false;
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('server never came up: ' + out)); }, 15000);
    child.stdout.on('data', (d) => {
      out += d;
      if (!up && /listening on/.test(out)) {
        up = true;
        clearTimeout(t);
        resolve({ child, port: p, base: `http://127.0.0.1:${p}`, logs: () => out });
      }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => {
      children.delete(child);
      clearTimeout(t);
      if (!up) reject(new Error(`server exited (${code}) before listening: ${out}`));
    });
  });
}

export function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}
