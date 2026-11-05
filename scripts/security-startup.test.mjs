import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer, stopServer } from './test-server.mjs';

const defaults = {
  API_TOKEN: '', TODOS_USER: '', TODOS_PASS: '', NODE_ENV: '',
  HOST: '127.0.0.1', TODOS_ALLOW_UNAUTHENTICATED_LOCAL: '',
};

test('missing or incomplete credentials never silently expose a board', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'todos-security-'));
  try {
    for (const extra of [
      {},
      { TODOS_USER: 'owner' },
      { TODOS_ALLOW_UNAUTHENTICATED_LOCAL: '1', NODE_ENV: 'production' },
      { TODOS_ALLOW_UNAUTHENTICATED_LOCAL: '1', HOST: '0.0.0.0' },
      { TODOS_ALLOW_UNAUTHENTICATED_LOCAL: '1', HOST: '::' },
    ]) {
      await assert.rejects(startServer('server.js', { env: { ...defaults, ...extra, DATA_DIR: dir } }), /Configure API_TOKEN|TODOS_PASS is required/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the default listener serves health but authenticates board access', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'todos-security-'));
  let server;
  try {
    server = await startServer('server.js', { env: { ...defaults, HOST: '', API_TOKEN: 'fixture-token-123', DATA_DIR: dir } });
    assert.match(server.logs(), /listening on 127\.0\.0\.1:/);
    const health = await fetch(`${server.base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(`${server.base}/kanban/snapshot`)).status, 401);
    assert.equal((await fetch(`${server.base}/kanban/snapshot`, { headers: { Authorization: 'Bearer fixture-token-123' } })).status, 200);
  } finally { await stopServer(server?.child); await rm(dir, { recursive: true, force: true }); }
});

test('development access needs an explicit loopback-only opt-in', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'todos-security-'));
  let server;
  try {
    server = await startServer('server.js', { env: { ...defaults, TODOS_ALLOW_UNAUTHENTICATED_LOCAL: '1', DATA_DIR: dir } });
    assert.equal((await fetch(`${server.base}/kanban/snapshot`)).status, 200);
  } finally { await stopServer(server?.child); await rm(dir, { recursive: true, force: true }); }
});
