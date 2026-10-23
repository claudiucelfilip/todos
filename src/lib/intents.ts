// §14.2 — URL intents, parsed from the hash. Pure so it is testable.
//   #/add?text=…&status=…            #/card/<id>/add-items?text=…
//   #/card/<id>/check?items=a,b       #/card/<id>/uncheck?items=…
//   #/card/<id>/status?set=done       #/find?q=…
// Every intent may carry &nonce=; `title=` may replace the id in the path.

import type { CardStatus } from './types';

export type Intent =
  | { kind: 'add'; text: string; status?: CardStatus; nonce?: string }
  | { kind: 'add-items'; card: string; text: string; nonce?: string }
  | { kind: 'check'; card: string; items: string[]; nonce?: string }
  | { kind: 'uncheck'; card: string; items: string[]; nonce?: string }
  | { kind: 'status'; card: string; status: CardStatus; nonce?: string }
  | { kind: 'find'; q: string }
  | { kind: 'pair'; token: string };

const STATUSES = ['todo', 'doing', 'done'];

export function parseIntent(hash: string): Intent | null {
  const raw = (hash ?? '').replace(/^#/, '');
  if (!raw.startsWith('/')) return null;
  const qi = raw.indexOf('?');
  const path = (qi < 0 ? raw : raw.slice(0, qi)).replace(/\/+$/, '');
  const params = new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1));
  const nonce = params.get('nonce') ?? undefined;
  const status = params.get('status') ?? params.get('set');
  const st = status && STATUSES.includes(status) ? (status as CardStatus) : undefined;

  if (path === '/add') {
    const text = params.get('text') ?? '';
    if (!text.trim()) return null;
    return { kind: 'add', text, status: st, nonce };
  }
  if (path === '/find') return { kind: 'find', q: params.get('q') ?? '' };
  if (path === '/pair') {
    const token = params.get('token') ?? '';
    return token ? { kind: 'pair', token } : null;
  }

  const m = path.match(/^\/card\/([^/]+)\/(add-items|check|uncheck|status)$/);
  if (!m) return null;
  const card = params.get('title') ?? decodeURIComponent(m[1]);
  const items = (params.get('items') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  switch (m[2]) {
    case 'add-items':
      return { kind: 'add-items', card, text: params.get('text') ?? '', nonce };
    case 'check':
      return { kind: 'check', card, items, nonce };
    case 'uncheck':
      return { kind: 'uncheck', card, items, nonce };
    case 'status':
      return st ? { kind: 'status', card, status: st, nonce } : null;
  }
  return null;
}

const NONCE_KEY = 'kept.nonces';
const DAY = 86400000;

/** True when this nonce was already applied in the last 24 h; records it otherwise. */
export function nonceSeen(nonce: string | undefined, now = Date.now()): boolean {
  if (!nonce) return false;
  let seen: Record<string, number> = {};
  try {
    seen = JSON.parse(localStorage.getItem(NONCE_KEY) ?? '{}') as Record<string, number>;
  } catch {
    seen = {};
  }
  for (const k of Object.keys(seen)) if (now - seen[k] > DAY) delete seen[k];
  if (seen[nonce]) return true;
  seen[nonce] = now;
  try {
    localStorage.setItem(NONCE_KEY, JSON.stringify(seen));
  } catch {
    /* storage blocked: intents may repeat */
  }
  return false;
}
