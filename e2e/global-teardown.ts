import fs from 'node:fs';
import { STATE_FILE } from './global-setup';

export default async function globalTeardown() {
  if (!fs.existsSync(STATE_FILE)) return;
  const { pid, dir } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(STATE_FILE, { force: true });
}
