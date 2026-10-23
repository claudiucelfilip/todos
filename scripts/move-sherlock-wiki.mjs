// Move legacy wiki captures to Sherlock's room through the sync API, preserving card IDs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = path.resolve(process.env.DATA_DIR || 'data');
const base = (process.env.TODOS_BASE || 'http://127.0.0.1:8094').replace(/\/$/, '');
const token = process.env.MIGRATION_API_TOKEN;
if (!token) throw new Error('MIGRATION_API_TOKEN is required.');
const accounts = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
const room = accounts.bots?.sherlock?.room;
if (!room) throw new Error('Sherlock workspace is missing.');
const api = async (route, body, method = body ? 'POST' : 'GET') => {
  const response = await fetch(`${base}${route}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status} ${result.error || ''}`);
  return result;
};
const personal = await api('/kanban/snapshot');
const wiki = personal.cards.filter(card => /^(wiki|sherlock):/.test(card.ext?.key || ''));
console.log(`${wiki.length} legacy wiki captures to move into Sherlock's workspace.`);
if (!process.argv.includes('--apply')) process.exit(0);
const target = await api(`/kanban/snapshot?room=${encodeURIComponent(room)}`);
const there = new Set(target.cards.map(card => card.id));
const labels = new Map(personal.labels.map(label => [label.id, label]));
const needed = [...new Set(wiki.flatMap(card => (card.labels || []).filter(id => !id.startsWith('workflow:'))))].map(id => labels.get(id)).filter(Boolean);
if (needed.length) await api(`/kanban/push?room=${encodeURIComponent(room)}`, { deviceId: 'server', actions: needed.map(label => ({ id: crypto.randomUUID(), type: 'label.put', ts: new Date().toISOString(), payload: { label } })) });
for (const card of wiki) {
  if (!there.has(card.id)) {
    const copy = { ...card, workflowVersion: undefined, labels: card.labels.filter(id => !id.startsWith('workflow:')), kind: 'note', done: false, status: 'todo', completedAt: null, archivedAt: null };
    await api(`/kanban/push?room=${encodeURIComponent(room)}`, { deviceId: 'server', actions: [{ id: crypto.randomUUID(), type: 'card.put', ts: new Date().toISOString(), payload: { card: copy } }] });
  }
  const check = await api(`/kanban/external/card?id=${encodeURIComponent(card.id)}&room=${encodeURIComponent(room)}`);
  if (check.card.title !== card.title || check.card.kind !== 'note' || check.card.ext?.key !== card.ext.key) throw new Error(`Copy verification failed for ${card.id}: ${JSON.stringify({ title: check.card.title, kind: check.card.kind, key: check.card.ext?.key })}`);
  await api(`/kanban/external/card?id=${encodeURIComponent(card.id)}`, null, 'DELETE');
  console.log(`moved ${card.id}`);
}
const sourceStateFile = path.join(dir, 'sherlock.json');
const targetStateFile = path.join(dir, 'rooms', room, 'sherlock.json');
if (fs.existsSync(sourceStateFile)) {
  const source = JSON.parse(fs.readFileSync(sourceStateFile, 'utf8'));
  const destination = fs.existsSync(targetStateFile) ? JSON.parse(fs.readFileSync(targetStateFile, 'utf8')) : { notes: {} };
  for (const card of wiki) if (source.notes?.[card.id]) { destination.notes[card.id] = source.notes[card.id]; delete source.notes[card.id]; }
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
  write(targetStateFile, destination); write(sourceStateFile, source);
}
console.log('Sherlock wiki migration complete. Restart Todos to reload conversation state.');
