// Small, credential-safe CLI for Hermes bots to track their own work in Todos.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const [name, command, target, detail = ''] = process.argv.slice(2);
if (!['sherlock', 'claw', 'lurch'].includes(name) || !['add', 'start', 'doing', 'done', 'blocked'].includes(command)) throw new Error('Usage: bot-task.mjs <sherlock|claw|lurch> <add|start|doing|done|blocked> <title|card-id> [details|result]');
if (!target) throw new Error('A title or card ID is required.');
const tokenFile = process.env.BOT_TOKEN_FILE || (name === 'lurch' ? path.join(os.homedir(), '.hermes/profiles/lurch/todos-token') : path.join(os.homedir(), 'services/todos/data/bot-credentials', name));
const base = (process.env.TODOS_BASE || 'http://127.0.0.1:8094').replace(/\/$/, '');
const token = fs.readFileSync(tokenFile, 'utf8').trim();
const api = async (route, body) => {
  const response = await fetch(`${base}${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`Todos returned ${response.status}: ${result.error || 'unknown error'}`);
  return result;
};
if (command === 'add' || command === 'start') {
  const created = await api('/kanban/external/card', { key: `work:${crypto.randomUUID()}`, title: target, notes: detail, kind: 'todo' });
  if (command === 'start') await api(`/kanban/external/status?id=${encodeURIComponent(created.id)}`, { status: 'doing' });
  console.log(created.id);
} else {
  const query = target.startsWith('cron:') ? `key=${encodeURIComponent(target)}` : `id=${encodeURIComponent(target)}`;
  const card = (await api(`/kanban/external/card?${query}`)).card;
  const id = encodeURIComponent(card.id);
  if (command === 'done' || command === 'blocked') {
    if (!detail.trim()) throw new Error('A result or blocker is required.');
    const summary = `${command === 'done' ? 'Last result' : 'Blocked'}: ${detail}`;
    const notes = card.ext?.key?.startsWith('cron:') ? `${String(card.notes || '').split('\n\n')[0]}\n\n${summary}`.slice(0, 5000) : `${card.notes || ''}${card.notes ? '\n\n' : ''}${summary}`.slice(0, 5000);
    await api(`/kanban/external/card?id=${id}`, { notes, replace: ['notes'] });
  }
  if (command !== 'blocked') await api(`/kanban/external/status?id=${id}`, { status: command });
  console.log(card.id);
}
