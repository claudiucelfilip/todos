// Mirror a Hermes profile's scheduled jobs into its Todos workspace.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const executionsQuery = `import json, sqlite3, sys
query = '''SELECT e.job_id, e.id, e.status, e.claimed_at, e.started_at, e.finished_at, e.error, e.delivery_outcome
FROM executions e WHERE e.id = (SELECT x.id FROM executions x WHERE x.job_id = e.job_id ORDER BY x.claimed_at DESC, x.id DESC LIMIT 1)'''
base = 'file:' + sys.argv[1]
try:
    db = sqlite3.connect(base + '?mode=ro', uri=True, timeout=2)
    db.row_factory = sqlite3.Row
    rows = db.execute(query).fetchall()
except sqlite3.OperationalError:
    db = sqlite3.connect(base + '?mode=ro&immutable=1', uri=True, timeout=2)
    db.row_factory = sqlite3.Row
    rows = db.execute(query).fetchall()
print(json.dumps([dict(row) for row in rows]))`;

function latestExecutions(jobsFile) {
  const file = path.join(path.dirname(jobsFile), 'executions.db');
  if (!fs.existsSync(file)) return { rows: new Map(), mtime: 0 };
  const mtime = Math.max(...[file, `${file}-wal`].filter(fs.existsSync).map(name => fs.statSync(name).mtimeMs));
  const rows = JSON.parse(execFileSync('python3', ['-c', executionsQuery, file], { encoding: 'utf8', timeout: 5000, maxBuffer: 100000 }));
  return { rows: new Map(rows.map(row => [row.job_id, row])), mtime };
}

function runSummary(run) {
  if (!run) return '';
  const at = run.started_at || run.claimed_at;
  const state = run.status === 'completed' ? 'Completed' : run.status === 'failed' ? 'Failed' : run.status === 'unknown' ? 'Unknown' : 'Running';
  const delivery = run.delivery_outcome && run.delivery_outcome !== 'suppressed' ? ` · ${run.delivery_outcome}` : '';
  const error = run.status === 'failed' && run.error ? ` · ${String(run.error).replace(/\s+/g, ' ').slice(0, 200)}` : '';
  return `\nLast run: ${at}\nOutcome: ${state}${delivery}${error}`;
}

export async function syncBotCron({ name, base, token, jobsFile = path.join(os.homedir(), '.hermes', 'profiles', name, 'cron', 'jobs.json') }) {
  if (!fs.existsSync(jobsFile)) return;
  const stampFile = `${jobsFile}.todos-sync`;
  const mtime = fs.statSync(jobsFile).mtimeMs;
  const executions = latestExecutions(jobsFile);
  let stamp = {};
  try { stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8')); } catch { /* First sync. */ }
  if (stamp.mtime === mtime && stamp.executionMtime === executions.mtime && Date.now() - stamp.at < 300000) return;
  const data = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
  const jobs = Array.isArray(data.jobs) ? data.jobs.filter(j => typeof j.id === 'string' && typeof j.name === 'string') : [];
  const api = async (route, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`${base}${route}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000) });
    const result = await response.json();
    if (!response.ok) throw new Error(`${route}: HTTP ${response.status} ${result.error || ''}`);
    return result;
  };
  const existing = (await api('/kanban/external/cards')).cards.filter(c => /^cron:/.test(c.key || ''));
  const byKey = new Map(existing.map(c => [c.key, c]));
  const wanted = new Set();
  for (const job of jobs) {
    const key = `cron:${job.id}`;
    wanted.add(key);
    const schedule = job.schedule?.display || job.schedule_display || job.schedule?.expr || 'Schedule unavailable';
    const run = executions.rows.get(job.id);
    const notes = `Hermes recurring job\nSchedule: ${schedule}\nJob ID: ${job.id}${runSummary(run)}`;
    const remindAt = job.enabled && job.next_run_at && !Number.isNaN(Date.parse(job.next_run_at)) ? new Date(job.next_run_at).toISOString() : null;
    const card = byKey.get(key);
    if (!card) {
      await api('/kanban/external/card', { key, title: job.name, notes, remindAt, notify: false, labels: [{ id: 'bot:scheduled', name: 'Scheduled job', color: '#64748B' }] });
    } else {
      const detail = (await api(`/kanban/external/card?id=${encodeURIComponent(card.id)}`)).card;
      const separator = detail.notes?.indexOf('\n\n') ?? -1;
      const suffix = separator >= 0 ? detail.notes.slice(separator) : detail.notes && !detail.notes.startsWith('Hermes recurring job\n') ? `\n\n${detail.notes}` : '';
      const nextNotes = notes + suffix;
      const update = { notify: false, remindAt };
      const replace = [];
      if (detail.title !== job.name) { update.title = job.name; replace.push('title'); }
      if (detail.notes !== nextNotes) { update.notes = nextNotes; replace.push('notes'); }
      if (detail.remindAt !== remindAt || detail.notify !== false || replace.length) await api(`/kanban/external/card?id=${encodeURIComponent(card.id)}`, { ...update, ...(replace.length ? { replace } : {}) });
      if (job.enabled && card.status === 'done' && detail.remindAt !== remindAt) await api(`/kanban/external/status?id=${encodeURIComponent(card.id)}`, { status: 'todo' });
      if (job.enabled && run && ['running', 'claimed'].includes(run.status) && card.status === 'todo') await api(`/kanban/external/status?id=${encodeURIComponent(card.id)}`, { status: 'doing' });
      if (job.enabled && run && !['running', 'claimed'].includes(run.status) && card.status === 'doing') await api(`/kanban/external/status?id=${encodeURIComponent(card.id)}`, { status: 'todo' });
    }
    if (!job.enabled) {
      const row = card || (await api(`/kanban/external/card?key=${encodeURIComponent(key)}`)).card;
      if (row.status !== 'done') await api(`/kanban/external/status?id=${encodeURIComponent(row.id)}`, { status: 'done' });
    }
  }
  for (const card of existing) if (!wanted.has(card.key)) await api(`/kanban/external/card?id=${encodeURIComponent(card.id)}`, null, 'DELETE');
  fs.writeFileSync(stampFile, JSON.stringify({ mtime, executionMtime: executions.mtime, at: Date.now() }), { mode: 0o600 });
  console.log(`${name}: synced ${jobs.length} scheduled jobs, removed ${existing.filter(c => !wanted.has(c.key)).length}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const name = process.env.BOT_NAME;
  const base = (process.env.TODOS_BASE || 'http://127.0.0.1:8094').replace(/\/$/, '');
  const tokenFile = process.env.BOT_TOKEN_FILE;
  if (!name || !tokenFile) throw new Error('BOT_NAME and BOT_TOKEN_FILE are required.');
  await syncBotCron({ name, base, token: fs.readFileSync(tokenFile, 'utf8').trim(), jobsFile: process.env.BOT_JOBS_FILE });
}
