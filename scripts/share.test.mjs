// View-only link: the share token's lifecycle, /view/<token> (cookie, redirect, 404, rate limit),
// what a viewer can read (session, snapshot, attached files) and that every other route refuses
// it; revoking or rotating ends a viewer; the owner's session still works and wins.
// Run: `npm run test:share`.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer, stopServer } from './test-server.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('  ok    ' + name);
  else { failures++; console.log('  FAIL ' + name + ' ' + extra); }
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-share-'));
const TOKEN = 'st-' + Math.random().toString(36).slice(2, 10);
const USER = 'owner';
const PASS = 'pw-' + Math.random().toString(36).slice(2, 10);
const APP = 'https://board.example';
const srv = await startServer(path.join(ROOT, 'server.js'), { env: { API_TOKEN: TOKEN, DATA_DIR: dataDir, TODOS_USER: USER, TODOS_PASS: PASS, APP_URL: APP } });
const BASE = srv.base;
const bearer = { Authorization: `Bearer ${TOKEN}` };
const tokenFile = path.join(dataDir, 'share-token');
let n = 0;
let ipN = 0;
// Each logical client gets its own forwarded IP (trusted from loopback), so the failure limiter is per check.
const ip = () => `10.0.0.${++ipN}`;

const req = (p, { method = 'GET', headers = {}, body } = {}) => fetch(BASE + p, { method, headers, body, redirect: 'manual' });
const jsonOf = async (r) => { try { return await r.json(); } catch { return null; } };
const card = (id, title, over = {}) => ({ id, title, notes: '', status: 'todo', order: 0, items: [], labels: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null, archivedAt: null, someday: false, repeat: false, ...over });
const push = (actions) => req('/kanban/push', { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'T', actions: actions.map((a) => ({ id: 'a' + ++n, deviceId: 'T', ts: new Date().toISOString(), ...a })) }) });
const upload = async (name, bytes) => (await req('/kanban/files', { method: 'POST', headers: { ...bearer, 'Content-Type': 'image/png', 'X-Filename': name }, body: bytes })).json();
const cookieOf = (r, name) => (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') || '']).find((s) => s.startsWith(name + '='));

try {
  // ---- token lifecycle --------------------------------------------------------------------
  let r = await req('/kanban/share', { headers: bearer });
  let b = await jsonOf(r);
  check('GET /kanban/share before sharing: { shared: false, url: null }', r.status === 200 && b.shared === false && b.url === null, JSON.stringify(b));
  check('no share-token file before sharing', !fs.existsSync(tokenFile));

  r = await req('/kanban/share', { method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' }, body: '{}' });
  b = await jsonOf(r);
  const tok1 = fs.readFileSync(tokenFile, 'utf8').trim();
  check('POST creates the token: { shared: true, url: APP_URL/view/<token> }', b.shared === true && b.url === `${APP}/view/${tok1}`, JSON.stringify(b));
  check('token is 32 random bytes, base64url (43 chars)', /^[A-Za-z0-9_-]{43}$/.test(tok1), tok1);
  check('share-token file is mode 0600', (fs.statSync(tokenFile).mode & 0o777) === 0o600, (fs.statSync(tokenFile).mode & 0o777).toString(8));
  b = await jsonOf(await req('/kanban/share', { method: 'POST', headers: bearer }));
  check('POST again is idempotent (same token)', b.url === `${APP}/view/${tok1}` && fs.readFileSync(tokenFile, 'utf8').trim() === tok1);
  b = await jsonOf(await req('/kanban/share', { headers: bearer }));
  check('GET reports the link', b.shared === true && b.url === `${APP}/view/${tok1}`);
  check('no auth: GET /kanban/share is 401', (await req('/kanban/share')).status === 401);

  // ---- owner session (login) ----------------------------------------------------------------
  r = await req('/kanban/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip() }, body: JSON.stringify({ username: USER, password: PASS }) });
  const ownerCookie = cookieOf(r, 'todos_session')?.split(';')[0];
  check('owner can sign in', r.status === 200 && !!ownerCookie);
  b = await jsonOf(await req('/kanban/share', { headers: { Cookie: ownerCookie } }));
  check('owner session reads the share state', b?.shared === true);

  // ---- /view/<token> ------------------------------------------------------------------------
  r = await req(`/view/${tok1}`, { headers: { 'X-Forwarded-For': ip() } });
  const setCookie = cookieOf(r, 'todos_view') || '';
  check('/view/<token> → 302 to /', r.status === 302 && r.headers.get('location') === '/', `${r.status} ${r.headers.get('location')}`);
  const mark = cookieOf(r, 'todos_viewer') || '';
  check('…plus the readable marker todos_viewer=1 (no secret, not HttpOnly, same Path/SameSite/Max-Age)', mark.startsWith('todos_viewer=1;') && !/HttpOnly/i.test(mark) && /Path=\//.test(mark) && /SameSite=Lax/.test(mark) && /Max-Age=31536000/.test(mark) && !mark.includes(tok1), mark);
  check('cookie todos_view=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=1 year', setCookie.startsWith(`todos_view=${tok1};`) && /Path=\//.test(setCookie) && /HttpOnly/.test(setCookie) && /SameSite=Lax/.test(setCookie) && /Max-Age=31536000/.test(setCookie), setCookie);
  check('no Secure flag on plain http', !/Secure/.test(setCookie));
  check('view redirect: no-store, no-referrer, noindex', r.headers.get('cache-control') === 'no-store' && r.headers.get('referrer-policy') === 'no-referrer' && r.headers.get('x-robots-tag') === 'noindex, nofollow');
  r = await req(`/view/${tok1}`, { headers: { 'X-Forwarded-For': ip(), 'X-Forwarded-Proto': 'https' } });
  check('Secure flag behind https (both cookies)', /;\s*Secure/.test(cookieOf(r, 'todos_view') || '') && /;\s*Secure/.test(cookieOf(r, 'todos_viewer') || ''));
  const viewCookie = `todos_view=${tok1}`;
  const V = { Cookie: viewCookie };

  r = await req('/view/not-the-token', { headers: { 'X-Forwarded-For': ip() } });
  const page = await r.text();
  check('wrong token → 404 HTML "no longer shared", no cookie', r.status === 404 && /no longer shared/.test(page) && !cookieOf(r, 'todos_view') && /text\/html/.test(r.headers.get('content-type')));
  check('404 page is self-contained (no external assets) with light/dark', !/(src|href)=/.test(page) && /prefers-color-scheme: dark/.test(page));
  check('404 page: noindex + no-store', r.headers.get('x-robots-tag') === 'noindex, nofollow' && r.headers.get('cache-control') === 'no-store');

  // Rate limit: 10 misses per IP are answered 429 after that; the right link still opens (nobody can lock it by guessing).
  const bad = ip();
  for (let i = 0; i < 10; i++) await req(`/view/guess-${i}`, { headers: { 'X-Forwarded-For': bad } });
  r = await req(`/view/${tok1}`, { headers: { 'X-Forwarded-For': bad } });
  check('after 10 wrong tokens the right link still opens from that IP', r.status === 302 && !!cookieOf(r, 'todos_view'), String(r.status));
  r = await req('/view/guess-again', { headers: { 'X-Forwarded-For': bad } });
  check('...while further wrong ones are refused with 429 and no cookie', r.status === 429 && !cookieOf(r, 'todos_view'), String(r.status));
  r = await req('/kanban/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': bad }, body: JSON.stringify({ username: USER, password: PASS }) });
  check('wrong view links never lock the owner\'s login from that IP (own bucket)', r.status === 200, String(r.status));
  const badLogin = ip();
  for (let i = 0; i < 10; i++) await req('/kanban/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': badLogin }, body: JSON.stringify({ username: USER, password: 'wrong' }) });
  check('10 failed logins limit logins from that IP', (await req('/kanban/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': badLogin }, body: JSON.stringify({ username: USER, password: PASS }) })).status === 429);
  check('…and never block the view link from that IP', (await req(`/view/${tok1}`, { headers: { 'X-Forwarded-For': badLogin } })).status === 302);
  r = await req(`/view/${tok1}`, { headers: { 'X-Forwarded-For': ip() } });
  check('another IP still gets in', r.status === 302);

  // ---- board content ------------------------------------------------------------------------
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const fAtt = await upload('on-card.png', png);
  const fLoose = await upload('loose.png', png);
  const fGone = await upload('on-deleted.png', png);
  const fArch = await upload('on-archived.png', png);
  await req(`/kanban/files/${fAtt.id}/thumb`, { method: 'POST', headers: { ...bearer, 'Content-Type': 'image/png' }, body: png });
  const att = (f) => ({ id: f.id, name: f.name, type: f.type, size: f.size, createdAt: new Date().toISOString() });
  await push([
    { type: 'card.put', payload: { card: card('c1', 'Shared card', { notes: 'secret-ish notes', attachments: [att(fAtt)] }) } },
    { type: 'card.put', payload: { card: card('c2', 'Deleted card', { notes: 'deleted content', attachments: [att(fGone)] }) } },
    { type: 'card.put', payload: { card: card('c3', 'Archived card', { status: 'done', completedAt: new Date().toISOString(), archivedAt: new Date().toISOString(), attachments: [att(fArch)] }) } },
    { type: 'card.put', payload: { card: card('c4', 'From an agent', { ext: { key: 'wiki:secret-key', slackTs: '123.456', slackChannel: 'C999', seenLinks: ['https://removed.example/x'] } }) } },
  ]);
  await push([{ type: 'card.delete', payload: { id: 'c2' } }]);

  // ---- what a viewer may read -----------------------------------------------------------------
  r = await req('/kanban/session', { headers: V });
  b = await jsonOf(r);
  check('viewer session → { ok: true, user: null, viewer: true }', r.status === 200 && b.ok === true && b.user === null && b.viewer === true, JSON.stringify(b));
  check('viewer responses carry X-Robots-Tag noindex', r.headers.get('x-robots-tag') === 'noindex, nofollow');
  r = await req('/kanban/snapshot', { headers: V });
  b = await jsonOf(r);
  check('viewer reads the snapshot', r.status === 200 && b.cards.some((c) => c.id === 'c1' && c.notes === 'secret-ish notes') && !b.cards.some((c) => c.id === 'c2'));
  check('viewer snapshot: no archived cards', !b.cards.some((c) => c.id === 'c3' || c.archivedAt));
  check('viewer snapshot: no ext on any card (agent key, Slack ids, seenLinks)', b.cards.some((c) => c.id === 'c4') && b.cards.every((c) => !('ext' in c)) && !JSON.stringify(b).includes('secret-key') && !JSON.stringify(b).includes('removed.example'));
  check('viewer snapshot: no tombstone ids', Array.isArray(b.tombstones) && b.tombstones.length === 0 && Array.isArray(b.labelTombstones) && b.labelTombstones.length === 0);
  check('viewer session sets the marker cookie too', /^todos_viewer=1;/.test(cookieOf(await req('/kanban/session', { headers: V }), 'todos_viewer') || ''));
  const ownerSnap = await jsonOf(await req('/kanban/snapshot', { headers: bearer }));
  check('owner snapshot keeps archived cards, ext and tombstones', ownerSnap.cards.some((c) => c.id === 'c3') && ownerSnap.cards.find((c) => c.id === 'c4')?.ext?.key === 'wiki:secret-key' && ownerSnap.tombstones.includes('c2'));
  r = await req('/', { headers: V });
  check('the app shell served to a viewer is noindex', r.headers.get('x-robots-tag') === 'noindex, nofollow');
  r = await req(`/kanban/files/${fAtt.id}`, { headers: V });
  check('viewer downloads a file attached to a live card', r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(png));
  r = await req(`/kanban/files/${fAtt.id}`, { method: 'HEAD', headers: V });
  check('viewer HEAD on an attached file', r.status === 200);
  r = await req(`/kanban/files/${fAtt.id}/thumb`, { headers: V });
  check('viewer gets the attached file\'s thumb', r.status === 200);
  check('viewer does not get an unattached file', (await req(`/kanban/files/${fLoose.id}`, { headers: V })).status === 404);
  check('viewer does not get a deleted card\'s file', (await req(`/kanban/files/${fGone.id}`, { headers: V })).status === 404);
  check('viewer does not get an archived card\'s file (owner does)', (await req(`/kanban/files/${fArch.id}`, { headers: V })).status === 404 && (await req(`/kanban/files/${fArch.id}`, { headers: bearer })).status === 200);
  check('viewer does not get an unknown id', (await req('/kanban/files/zzzzzzzzzzzz', { headers: V })).status === 404);
  check('no cookie: attached file is 401', (await req(`/kanban/files/${fAtt.id}`)).status === 401);

  // ---- every other route refuses a viewer -------------------------------------------------------
  const J = { ...V, 'Content-Type': 'application/json' };
  const denied = [
    ['POST', '/kanban/push', JSON.stringify({ deviceId: 'V', actions: [{ id: 'evil1', deviceId: 'V', ts: new Date().toISOString(), type: 'card.delete', payload: { id: 'c1' } }] })],
    ['GET', '/kanban/pull?since=0'],
    ['GET', '/kanban/notify-topic'],
    ['POST', '/kanban/notify-test', '{}'],
    ['GET', '/kanban/share'],
    ['POST', '/kanban/share', '{}'],
    ['POST', '/kanban/share', JSON.stringify({ rotate: true })],
    ['DELETE', '/kanban/share'],
    ['POST', '/kanban/files', 'abc'],
    ['POST', `/kanban/files/${fAtt.id}/thumb`, 'abc'],
    ['DELETE', `/kanban/files/${fAtt.id}`],
    ['GET', '/kanban/external/cards'],
    ['GET', '/kanban/external/card?id=c1'],
    ['POST', '/kanban/external/card', JSON.stringify({ key: 'evil', title: 'Evil' })],
    ['POST', '/kanban/external/card?id=c1', JSON.stringify({ replace: ['title'], title: 'Evil' })],
    ['DELETE', '/kanban/external/card?id=c1'],
    ['POST', '/kanban/external/status?id=c1', JSON.stringify({ status: 'done' })],
    ['POST', '/kanban/external/card/attach?id=c1', 'abc'],
    ['DELETE', `/kanban/external/card/attach?id=c1&attachment=${fAtt.id}`],
  ];
  for (const [method, p, body] of denied) {
    r = await req(p, { method, headers: J, body });
    const j = await jsonOf(r);
    check(`viewer: ${method} ${p.split('?')[0]} → refused`, (r.status === 401 && j?.error === 'unauthorized') || (r.status === 403 && j?.error === 'read_only'), `${r.status} ${JSON.stringify(j)}`);
  }
  b = await jsonOf(await req('/kanban/snapshot', { headers: bearer }));
  const c1 = b.cards.find((c) => c.id === 'c1');
  check('nothing a viewer sent changed the board', !!c1 && c1.title === 'Shared card' && c1.status === 'todo' && c1.attachments.length === 1 && !b.cards.some((c) => c.title === 'Evil'));
  check('the share token survived the viewer\'s attempts', fs.readFileSync(tokenFile, 'utf8').trim() === tok1);
  r = await req('/kanban/logout', { method: 'POST', headers: V });
  check('logout is harmless for a viewer', r.status === 200);

  // ---- CSRF: a cookie never authenticates a write from another origin ------------------------------
  const before = await (await req('/kanban/snapshot', { headers: bearer })).text();
  const tokBefore = fs.readFileSync(tokenFile, 'utf8').trim();
  const evil = 'https://evil.example';
  const OC = { Cookie: ownerCookie };
  const formPush = JSON.stringify({ deviceId: 'X', actions: [{ id: 'csrf1', deviceId: 'X', ts: new Date().toISOString(), type: 'card.delete', payload: { id: 'c1' } }] });
  const csrfCases = [
    ['share rotate, cross-origin form', '/kanban/share', { ...OC, Origin: evil, 'Content-Type': 'text/plain' }, '{"rotate":true}'],
    ['share delete, Sec-Fetch-Site same-site', '/kanban/share', { ...OC, 'Sec-Fetch-Site': 'same-site' }, undefined, 'DELETE'],
    ['push, cross-origin form', '/kanban/push', { ...OC, Origin: evil, 'Content-Type': 'text/plain' }, formPush],
    ['push, Sec-Fetch-Site cross-site', '/kanban/push', { ...OC, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'text/plain' }, formPush],
    ['file upload, cross-origin', '/kanban/files', { ...OC, Origin: evil, 'Content-Type': 'image/png' }, 'abc'],
    ['notify-test, cross-origin', '/kanban/notify-test', { ...OC, Origin: evil }, '{}'],
  ];
  for (const [name, p, headers, body, method = 'POST'] of csrfCases) {
    r = await req(p, { method, headers, body });
    check(`CSRF refused: ${name} → 401`, r.status === 401, String(r.status));
  }
  check('CSRF: nothing changed (board, share token)', (await (await req('/kanban/snapshot', { headers: bearer })).text()) === before && fs.readFileSync(tokenFile, 'utf8').trim() === tokBefore);
  r = await req('/kanban/share', { method: 'POST', headers: { Origin: evil, Authorization: `Bearer ${TOKEN}` }, body: '{}' });
  check('a Bearer token is unaffected by Origin', r.status === 200);
  r = await req('/kanban/share', { method: 'POST', headers: { ...OC, Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: '{}' });
  check('same-origin app request with the cookie works (share)', r.status === 200);
  r = await req('/kanban/share', { method: 'POST', headers: { ...OC, Origin: APP, 'Content-Type': 'application/json' }, body: '{}' });
  check('the APP_URL origin counts as own', r.status === 200);
  r = await req('/kanban/files', { method: 'POST', headers: { ...OC, Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'image/png', 'X-Filename': 'same.png' }, body: png });
  const same = await jsonOf(r);
  check('same-origin upload works', r.status === 200 && !!same?.id);
  r = await req(`/kanban/files/${same.id}/thumb`, { method: 'POST', headers: { ...OC, Origin: BASE, 'Content-Type': 'image/png' }, body: png });
  check('same-origin thumbnail works', r.status === 200);
  r = await req('/kanban/push', { method: 'POST', headers: { ...OC, Origin: BASE, 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'O', actions: [] }) });
  check('same-origin push works', r.status === 200);
  r = await req('/kanban/notify-test', { method: 'POST', headers: { ...OC, Origin: BASE }, body: '{}' });
  check('same-origin notify-test passes auth (502 from the dead ntfy port)', r.status === 502 || r.status === 200, String(r.status));
  r = await req('/kanban/push', { method: 'POST', headers: { ...OC, 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: 'O', actions: [] }) });
  check('no Origin header (curl with the cookie) works', r.status === 200);
  r = await req('/kanban/login', { method: 'POST', headers: { Origin: BASE, 'Content-Type': 'application/json', 'X-Forwarded-For': ip() }, body: JSON.stringify({ username: USER, password: PASS }) });
  check('same-origin login works', r.status === 200);
  r = await req('/kanban/logout', { method: 'POST', headers: { ...OC, Origin: evil } });
  check('CSRF: another site cannot sign the owner out (401, no cookie cleared)', r.status === 401 && !cookieOf(r, 'todos_session'), String(r.status));
  r = await req('/kanban/logout', { method: 'POST', headers: { ...OC, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'text/plain' }, body: 'x' });
  check('CSRF: ...nor a cross-site form', r.status === 401 && !cookieOf(r, 'todos_session') && (await req('/kanban/session', { headers: OC })).status === 200);
  r = await req('/kanban/logout', { method: 'POST', headers: { Origin: BASE } });
  check('same-origin logout works', r.status === 200);
  r = await req('/kanban/logout', { method: 'POST', headers: { Cookie: viewCookie } });
  check('logout with a working view cookie re-sets the marker (next launch starts read-only)', /^todos_viewer=1;/.test(cookieOf(r, 'todos_viewer') || ''));
  r = await req('/kanban/session', { headers: { Cookie: `${ownerCookie}; todos_viewer=1` } });
  check('owner session clears a stale marker', /^todos_viewer=;.*Max-Age=0/.test(cookieOf(r, 'todos_viewer') || ''), cookieOf(r, 'todos_viewer'));
  r = await req(`/view/${tok1}`, { headers: OC });
  check('the right link opened with an owner session sets no viewer cookies (it cannot be planted there)', r.status === 302 && r.headers.get('location') === '/' && !cookieOf(r, 'todos_view') && !cookieOf(r, 'todos_viewer'), String(r.status));
  // Once a browser is the owner's it stops being a viewer.
  r = await req('/kanban/session', { headers: { Cookie: `${ownerCookie}; ${viewCookie}; todos_viewer=1` } });
  check('owner session on a browser holding a view link: the view cookie and the marker go', /^todos_view=;.*HttpOnly.*Max-Age=0/.test(cookieOf(r, 'todos_view') || '') && /^todos_viewer=;.*Max-Age=0/.test(cookieOf(r, 'todos_viewer') || '') && (await jsonOf(r))?.user === USER);
  r = await req('/kanban/session', { headers: OC });
  check('...and a plain owner session sets no cookie', r.status === 200 && !cookieOf(r, 'todos_view') && !cookieOf(r, 'todos_viewer'));
  r = await req('/kanban/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip(), Cookie: 'todos_view=dead-token' }, body: JSON.stringify({ username: USER, password: PASS }) });
  const freshBody = await jsonOf(r);
  check('signing in on a browser that held a view link (even a dead one): fresh start, view cookie cleared', r.status === 200 && freshBody?.fresh === true && /^todos_view=;.*Max-Age=0/.test(cookieOf(r, 'todos_view') || '') && !!cookieOf(r, 'todos_session'));
  r = await req('/kanban/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip() }, body: JSON.stringify({ username: USER, password: PASS }) });
  check('a normal sign-in is not marked fresh', r.status === 200 && (await jsonOf(r))?.fresh === undefined);
  // The viewer sees only labels its cards use.
  await push([
    { type: 'label.put', payload: { label: { id: 'lab-used', name: 'Shown', color: '#2E9E6B' } } },
    { type: 'label.put', payload: { label: { id: 'lab-arch', name: 'Only on archived', color: '#C23B3B' } } },
    { type: 'card.put', payload: { card: card('lab-c1', 'Has a label', { labels: ['lab-used'] }) } },
    { type: 'card.put', payload: { card: card('lab-c2', 'Archived with a label', { labels: ['lab-arch'], status: 'done', archivedAt: new Date().toISOString() }) } },
  ]);
  const vs = await jsonOf(await req('/kanban/snapshot', { headers: { Cookie: viewCookie } }));
  const os = await jsonOf(await req('/kanban/snapshot', { headers: bearer }));
  check('viewer snapshot: only labels used by visible cards', vs?.labels?.some((l) => l.id === 'lab-used') && !vs.labels.some((l) => l.id === 'lab-arch') && os.labels.some((l) => l.id === 'lab-arch'), JSON.stringify(vs?.labels?.map((l) => l.id)));

  // ---- owner wins when both cookies are present ---------------------------------------------------
  const both = { Cookie: `${viewCookie}; ${ownerCookie}` };
  b = await jsonOf(await req('/kanban/session', { headers: both }));
  check('owner session + view cookie → the owner', b.ok === true && b.user === USER && !b.viewer, JSON.stringify(b));
  check('owner + view cookie can pull', (await req('/kanban/pull?since=0', { headers: both })).status === 200);
  b = await jsonOf(await req('/kanban/session', { headers: { Cookie: viewCookie, ...bearer } }));
  check('Bearer + view cookie → not a viewer', b.ok === true && !b.viewer);

  // ---- rotation and revocation end viewers ---------------------------------------------------------
  b = await jsonOf(await req('/kanban/share', { method: 'POST', headers: { Cookie: ownerCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ rotate: true }) }));
  const tok2 = fs.readFileSync(tokenFile, 'utf8').trim();
  check('rotate replaces the token (still 0600)', tok2 !== tok1 && b.url === `${APP}/view/${tok2}` && (fs.statSync(tokenFile).mode & 0o777) === 0o600);
  r = await req('/kanban/session', { headers: V });
  check('rotation ends the old viewer cookie (session 401)', r.status === 401 && (await jsonOf(r))?.error === 'unauthorized');
  check('rotation: old cookie snapshot 401', (await req('/kanban/snapshot', { headers: V })).status === 401);
  check('rotation: old cookie file 401', (await req(`/kanban/files/${fAtt.id}`, { headers: V })).status === 401);
  check('the old link is a 404', (await req(`/view/${tok1}`, { headers: { 'X-Forwarded-For': ip() } })).status === 404);
  const V2 = { Cookie: `todos_view=${tok2}` };
  check('the new link works', (await req(`/view/${tok2}`, { headers: { 'X-Forwarded-For': ip() } })).status === 302 && (await jsonOf(await req('/kanban/session', { headers: V2 })))?.viewer === true);

  b = await jsonOf(await req('/kanban/share', { method: 'DELETE', headers: bearer }));
  check('DELETE stops sharing: { shared: false, url: null }, file gone', b.shared === false && b.url === null && !fs.existsSync(tokenFile));
  check('revocation ends the viewer (session 401)', (await req('/kanban/session', { headers: V2 })).status === 401);
  check('revocation: snapshot 401', (await req('/kanban/snapshot', { headers: V2 })).status === 401);
  check('not shared: /view/<old> is 404', (await req(`/view/${tok2}`, { headers: { 'X-Forwarded-For': ip() } })).status === 404);
  check('an empty view cookie is never a viewer', (await req('/kanban/session', { headers: { Cookie: 'todos_view=' } })).status === 401);
  b = await jsonOf(await req('/kanban/share', { method: 'DELETE', headers: bearer }));
  check('DELETE when not shared is fine', b.shared === false);
  check('owner session still works after all of it', (await jsonOf(await req('/kanban/session', { headers: { Cookie: ownerCookie } })))?.user === USER);
} catch (e) {
  failures++;
  console.log('  FAIL exception ' + (e?.stack ?? e));
} finally {
  await stopServer(srv.child);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'RESULT: ALL PASS' : `RESULT: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
