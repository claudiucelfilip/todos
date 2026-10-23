// Provision separate bot identities and owner-visible workspaces without printing credentials.
import fs from 'node:fs';
import path from 'node:path';
import { accountStore } from '../shared/accounts.mjs';

const dir = path.resolve(process.env.DATA_DIR || 'data');
const owner = process.env.TODOS_USER;
if (!owner) throw new Error('TODOS_USER is required.');
const accounts = accountStore(dir, owner);
const credentials = path.join(dir, 'bot-credentials');
fs.mkdirSync(credentials, { recursive: true, mode: 0o700 });
for (const name of ['sherlock', 'claw', 'lurch']) {
  const bot = accounts.ensureBot(owner, name);
  const file = path.join(credentials, name);
  if (bot.token) fs.writeFileSync(file, bot.token + '\n', { mode: 0o600 });
  else if (!fs.existsSync(file)) throw new Error(`${name} already exists but its credential is missing.`);
  console.log(`${name}: workspace ${bot.room} ready`);
}
