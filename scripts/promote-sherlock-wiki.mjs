// Put legacy Sherlock wiki notes on the workspace board without dispatching them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { workflowLabels } from '../shared/workflow.mjs';

const dir = path.resolve(process.env.DATA_DIR || 'data');
const base = (process.env.TODOS_BASE || 'http://127.0.0.1:8094').replace(/\/$/, '');
const token = process.env.MIGRATION_API_TOKEN;
if (!token) throw new Error('MIGRATION_API_TOKEN is required.');
const accounts = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
const room = accounts.bots?.sherlock?.room;
if (!room) throw new Error('Sherlock workspace is missing.');
const route = `/kanban/snapshot?room=${encodeURIComponent(room)}`;
const request = async (url, body) => {
  const response = await fetch(`${base}${url}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${result.error || ''}`);
  return result;
};
const cards = (await request(route)).cards.filter(c => c.kind === 'note' && /^(wiki|sherlock):/.test(c.ext?.key || '') && !c.archivedAt);
console.log(`${cards.length} Sherlock wiki notes to put in To Do.`);
if (!process.argv.includes('--apply')) process.exit(0);
for (const card of cards) {
  await request(`/kanban/push?room=${encodeURIComponent(room)}`, { deviceId: 'server', actions: [{ id: crypto.randomUUID(), type: 'card.set', ts: new Date().toISOString(), payload: { id: card.id, fields: { workflowVersion: 1, labels: workflowLabels(card.labels, 'todo') } } }] });
  const check = (await request(`/kanban/external/card?id=${encodeURIComponent(card.id)}&room=${encodeURIComponent(room)}`)).card;
  if (check.kind === 'note' || check.status !== 'todo' || check.ext?.key !== card.ext.key) throw new Error(`Promotion failed for ${card.id}`);
}
console.log('Sherlock wiki board promotion complete.');
