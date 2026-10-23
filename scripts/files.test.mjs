// Attachments on the server: upload (raw + multipart), download headers, auth (session,
// Bearer, Basic, external token), 413, thumbs, idempotent retries, garbage collection, the
// agent routes (attach / find / update / move / delete by id, key or exact title) and the
// /agents guide, which must document every route in the router table. Run: `npm run test:files`.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import vm from 'node:vm';
import { freePort, startServer, stopServer } from './test-server.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log('  ok    ' + name);
  else { failures++; console.log('  FAIL ' + name + ' ' + extra); }
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-files-'));
const TOKEN = 'ft-' + Math.random().toString(36).slice(2, 8);
const USER = 'demo';
const PASS = 'pw-' + Math.random().toString(36).slice(2, 8);
const MAX = 256 * 1024;
const PORT = await freePort();
const boot = () => startServer(path.join(ROOT, 'server.js'), { port: PORT, env: { API_TOKEN: TOKEN, DATA_DIR: dataDir, TODOS_USER: USER, TODOS_PASS: PASS, FILE_MAX_BYTES: String(MAX) } });
let srv = await boot();
const BASE = srv.base;
const bearer = { Authorization: `Bearer ${TOKEN}` };
const basic = { Authorization: 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') };
const EXT = fs.readFileSync(path.join(dataDir, 'external-token'), 'utf8').trim();
const ext = { Authorization: `Bearer ${EXT}` };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5b2b8b10000000049454e44ae426082', 'hex');
const up = (body, headers = {}, auth = bearer) => fetch(`${BASE}/kanban/files`, { method: 'POST', headers: { ...auth, ...headers }, body });
const snap = async () => (await (await fetch(`${BASE}/kanban/snapshot`, { headers: bearer })).json()).cards;
let n = 0;
const push = (actions) => fetch(`${BASE}/kanban/push`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'D', actions: actions.map((a) => ({ id: 'f' + ++n, deviceId: 'D', ts: new Date().toISOString(), ...a })) }) });
const now = () => new Date().toISOString();
const card = (id, title, over = {}) => ({ id, title, notes: '', status: 'todo', order: 0, items: [], labels: [], createdAt: now(), updatedAt: now(), completedAt: null, archivedAt: null, someday: false, repeat: false, ...over });

try {
  // --- upload + download ---------------------------------------------------------------
  check('upload needs auth', (await up(PNG, { 'content-type': 'image/png' }, {})).status === 401);
  const r1 = await up(PNG, { 'content-type': 'image/png', 'x-filename': encodeURIComponent('shot one.png'), 'x-filename-encoding': 'percent' });
  const f1 = await r1.json();
  check('raw upload returns { id, name, type, size, url }', r1.status === 200 && /^[\w-]{8,64}$/.test(f1.id) && f1.name === 'shot one.png' && f1.type === 'image/png' && f1.size === PNG.length && f1.url === `/kanban/files/${f1.id}`, JSON.stringify(f1));
  check('the blob and a JSON sidecar are in DATA_DIR/files', fs.existsSync(path.join(dataDir, 'files', f1.id)) && JSON.parse(fs.readFileSync(path.join(dataDir, 'files', f1.id + '.json'), 'utf8')).name === 'shot one.png');
  const g1 = await fetch(`${BASE}${f1.url}`, { headers: basic });
  const b1 = Buffer.from(await g1.arrayBuffer());
  check('download streams the bytes with the right type', g1.status === 200 && b1.equals(PNG) && g1.headers.get('content-type') === 'image/png');
  check('images are inline; private, revalidated (no-cache) with an ETag; nosniff', /^inline/.test(g1.headers.get('content-disposition')) && g1.headers.get('cache-control') === 'private, no-cache' && !!g1.headers.get('etag') && g1.headers.get('x-content-type-options') === 'nosniff', JSON.stringify(Object.fromEntries(g1.headers)));
  check('a revalidation without a session is 401, not 304 (the HTTP cache never outlives the session)', (await fetch(`${BASE}${f1.url}`, { headers: { 'if-none-match': g1.headers.get('etag') } })).status === 401);
  check('If-None-Match → 304', (await fetch(`${BASE}${f1.url}`, { headers: { ...basic, 'if-none-match': g1.headers.get('etag') } })).status === 304);
  check('download needs auth (never public)', (await fetch(`${BASE}${f1.url}`)).status === 401);
  check('the external token can download (agents)', (await fetch(`${BASE}${f1.url}`, { headers: ext })).status === 200);
  check('the external token can upload', (await up(PNG, { 'content-type': 'image/png' }, ext)).status === 200);
  const login = await fetch(`${BASE}/kanban/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  check('a session cookie can download (img tags in the app)', (await fetch(`${BASE}${f1.url}`, { headers: { cookie } })).status === 200);
  const pdf = await (await up(Buffer.from('%PDF-1.4\n%%EOF\n'), { 'content-type': 'application/pdf', 'x-filename': 'doc.pdf' })).json();
  check('PDF is served inline', /^inline/.test((await fetch(`${BASE}${pdf.url}`, { headers: bearer })).headers.get('content-disposition')));
  const zip = await (await up(Buffer.from('PK...'), { 'x-filename': 'bundle.zip' })).json();
  const gz = await fetch(`${BASE}${zip.url}`, { headers: bearer });
  check('other files download as attachment with their name; the type is guessed from the name', /^attachment/.test(gz.headers.get('content-disposition')) && /bundle\.zip/.test(gz.headers.get('content-disposition')) && zip.type === 'application/zip', `${gz.headers.get('content-disposition')} ${zip.type}`);
  const html = await (await up(Buffer.from('<script>alert(1)</script>'), { 'content-type': 'text/html', 'x-filename': 'x.html' })).json();
  const gh = await fetch(`${BASE}${html.url}`, { headers: bearer });
  check('HTML is never rendered in the app origin (attachment + CSP sandbox)', /^attachment/.test(gh.headers.get('content-disposition')) && /sandbox/.test(gh.headers.get('content-security-policy') || ''));
  // Names: a raw UTF-8 header (what curl sends), percent only when declared, RFC 5987 filename*
  const rawName = await new Promise((resolve) => {
    const req = http.request(`${BASE}/kanban/files`, { method: 'POST', headers: { ...bearer, 'content-type': 'image/png', 'x-filename': Buffer.from('café résumé — ü.png', 'utf8').toString('latin1') } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d))); });
    req.end(PNG);
  });
  check('a raw UTF-8 X-Filename arrives intact', rawName.name === 'café résumé — ü.png', rawName.name);
  const literal = await (await up(PNG, { 'content-type': 'image/png', 'x-filename': '100%20off.png' })).json();
  check('percent sequences stay literal unless X-Filename-Encoding: percent', literal.name === '100%20off.png', literal.name);
  const q = await (await fetch(`${BASE}/kanban/files?name=${encodeURIComponent('über plan.pdf')}`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/pdf' }, body: Buffer.from('%PDF-1.4') })).json();
  check('?name= carries any name', q.name === 'über plan.pdf', q.name);
  const quote = await (await up(Buffer.from('%PDF-1.4'), { 'content-type': 'application/pdf', 'x-filename': "it's (final).pdf" })).json();
  const cd = (await fetch(`${BASE}${quote.url}`, { headers: bearer })).headers.get('content-disposition');
  check("filename* is RFC 5987 (' ( ) encoded)", /filename\*=UTF-8''it%27s%20%28final%29\.pdf/.test(cd), cd);
  // curl --data-binary without -H sends x-www-form-urlencoded: that is not the file's type
  const form = await (await up(PNG, { 'content-type': 'application/x-www-form-urlencoded', 'x-filename': 'photo.png' })).json();
  check('curl\'s default form type is ignored; the extension decides', form.type === 'image/png', form.type);
  const sniff = await (await up(PNG, { 'content-type': 'application/x-www-form-urlencoded', 'x-filename': 'noext' })).json();
  check('...and without an extension the bytes do (PNG signature)', sniff.type === 'image/png', sniff.type);
  const pdfSniff = await (await up(Buffer.from('%PDF-1.7 xx'), { 'x-filename': 'scan' })).json();
  check('...PDF signature too', pdfSniff.type === 'application/pdf', pdfSniff.type);

  // multipart (curl -F)
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'from-curl.png');
  const mp = await (await fetch(`${BASE}/kanban/files`, { method: 'POST', headers: bearer, body: fd })).json();
  check('multipart/form-data upload takes the part\'s name and type', mp.name === 'from-curl.png' && mp.type === 'image/png' && mp.size === PNG.length, JSON.stringify(mp));
  const fd2 = new FormData();
  fd2.append('name', 'renamed.png');
  fd2.append('file', new Blob([PNG], { type: 'image/png' }), 'orig.png');
  check('...and an optional name field wins', (await (await fetch(`${BASE}/kanban/files`, { method: 'POST', headers: bearer, body: fd2 })).json()).name === 'renamed.png');
  // limits
  const big = await up(Buffer.alloc(MAX + 1), { 'content-type': 'application/octet-stream' });
  const bigBody = await big.json();
  check('over the size limit → 413 with a clear JSON error', big.status === 413 && bigBody.error === 'file_too_large' && bigBody.maxBytes === MAX, JSON.stringify(bigBody));
  // idempotent retry by client id
  const cid = 'u-' + Math.random().toString(36).slice(2, 12);
  const a1 = await (await up(PNG, { 'content-type': 'image/png', 'x-file-id': cid, 'x-filename': 'retry.png' })).json();
  const a2 = await (await up(PNG, { 'content-type': 'image/png', 'x-file-id': cid, 'x-filename': 'retry.png' })).json();
  check('X-File-Id makes a retried upload idempotent', a1.id === cid && a2.id === cid && fs.readdirSync(path.join(dataDir, 'files')).filter((f) => f.startsWith(cid)).length === 2);
  check('unknown or malformed ids are 404', (await fetch(`${BASE}/kanban/files/nope-nope-nope`, { headers: bearer })).status === 404 && (await fetch(`${BASE}/kanban/files/..%2Fkanban.json`, { headers: bearer })).status === 404);
  // thumbs
  check('no thumb yet → 404 (the UI falls back)', (await fetch(`${BASE}${f1.url}/thumb`, { headers: bearer })).status === 404);
  const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
  check('a thumb can be posted', (await fetch(`${BASE}${f1.url}/thumb`, { method: 'POST', headers: { ...bearer, 'content-type': 'image/jpeg' }, body: JPG })).status === 200);
  const th = await fetch(`${BASE}${f1.url}/thumb`, { headers: bearer });
  check('...and is served as image/jpeg', th.status === 200 && th.headers.get('content-type') === 'image/jpeg' && Buffer.from(await th.arrayBuffer()).equals(JPG));

  // --- agent routes ------------------------------------------------------------------------
  await push([{ type: 'card.put', payload: { card: card('user-1', 'Plan the trip') } }, { type: 'card.put', payload: { card: card('user-2', 'Twin') } }, { type: 'card.put', payload: { card: card('user-3', 'twin') } }]);
  const at = await fetch(`${BASE}/kanban/external/card/attach?title=${encodeURIComponent('plan the trip')}`, { method: 'POST', headers: { ...ext, 'content-type': 'image/png', 'x-filename': 'screenshot.png' }, body: PNG });
  const atj = await at.json();
  check('attach by exact title (any case): uploads and attaches in one call', at.status === 200 && atj.ok && atj.cardId === 'user-1' && atj.attachment?.name === 'screenshot.png' && atj.attachment?.url === `/kanban/files/${atj.attachment.id}`, JSON.stringify(atj));
  const c1 = (await snap()).find((c) => c.id === 'user-1');
  check('the card now carries the attachment (through the action log)', c1.attachments?.length === 1 && c1.attachments[0].id === atj.attachment.id && c1.attachments[0].type === 'image/png');
  const pl = (await (await fetch(`${BASE}/kanban/pull?since=0`, { headers: bearer })).json()).actions;
  check('...as an att.put from device "server"', pl.some((a) => a.type === 'att.put' && a.deviceId === 'server' && a.payload.cardId === 'user-1'));
  const fdA = new FormData();
  fdA.append('file', new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
  const byId = await (await fetch(`${BASE}/kanban/external/card/attach?id=user-1`, { method: 'POST', headers: ext, body: fdA })).json();
  check('attach by id with multipart', byId.ok && byId.attachment.name === 'note.txt' && (await snap()).find((c) => c.id === 'user-1').attachments.length === 2, JSON.stringify(byId));
  const created = await (await fetch(`${BASE}/kanban/external/card`, { method: 'POST', headers: { ...ext, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'agent:1', title: 'From an agent' }) })).json();
  const byKey = await (await fetch(`${BASE}/kanban/external/card/attach?key=agent:1&name=raw.bin`, { method: 'POST', headers: ext, body: Buffer.from('xyz') })).json();
  check('attach by key; ?name= names a raw upload', byKey.ok && byKey.cardId === created.id && byKey.attachment.name === 'raw.bin');
  const amb = await fetch(`${BASE}/kanban/external/card/attach?title=twin`, { method: 'POST', headers: ext, body: PNG });
  const ambj = await amb.json();
  check('an ambiguous title is 409 with the candidate ids', amb.status === 409 && ambj.error === 'ambiguous_title' && ambj.ids.length === 2, JSON.stringify(ambj));
  check('no such card → 404', (await fetch(`${BASE}/kanban/external/card/attach?title=nothing%20here`, { method: 'POST', headers: ext, body: PNG })).status === 404);
  check('attach needs the token', (await fetch(`${BASE}/kanban/external/card/attach?id=user-1`, { method: 'POST', body: PNG })).status === 401);
  check('attach over the limit → 413', (await fetch(`${BASE}/kanban/external/card/attach?id=user-1`, { method: 'POST', headers: ext, body: Buffer.alloc(MAX + 5) })).status === 413);

  // update / move / park a user-made card by title or id
  const upd = await fetch(`${BASE}/kanban/external/card?title=${encodeURIComponent('Plan the trip')}`, { method: 'POST', headers: { ...ext, 'content-type': 'application/json' }, body: JSON.stringify({ notes: 'Book the train', replace: ['notes'], addLabels: ['Travel'], links: [{ title: 'Map', url: 'https://maps.test/x' }], remindAt: '2030-01-02T09:00:00Z' }) });
  const updj = await upd.json();
  const c2 = (await snap()).find((c) => c.id === 'user-1');
  const labs = (await (await fetch(`${BASE}/kanban/snapshot`, { headers: bearer })).json()).labels;
  check('update by title: notes (replace), a new label by name, a link, a reminder', upd.status === 200 && updj.id === 'user-1' && updj.created === false && c2.notes === 'Book the train\n\n[Map](https://maps.test/x)' && c2.labels.length === 2 && c2.labels.includes('workflow:todo') && c2.labels.some((id) => labs.find((l) => l.id === id)?.name === 'Travel') && c2.remindAt === '2030-01-02T09:00:00.000Z', JSON.stringify(updj) + JSON.stringify(c2));
  check('a user card updated by an agent gets no ext key (the app would drop it)', !c2.ext);
  await fetch(`${BASE}/kanban/external/card?id=user-1`, { method: 'POST', headers: { ...ext, 'content-type': 'application/json' }, body: JSON.stringify({ removeLabels: ['travel'], someday: true }) });
  const c3 = (await snap()).find((c) => c.id === 'user-1');
  check('update by id: remove a label, park in Someday', c3.labels.join() === 'workflow:todo' && c3.someday === true && c3.status === 'todo');
  const mv = await (await fetch(`${BASE}/kanban/external/status?title=${encodeURIComponent('Plan the trip')}`, { method: 'POST', headers: { ...ext, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'doing' }) })).json();
  const c4 = (await snap()).find((c) => c.id === 'user-1');
  check('status by title moves it (and un-parks it)', mv.ok && mv.changed && c4.status === 'doing' && c4.someday === false);
  const byKeyUpd = await fetch(`${BASE}/kanban/external/card?key=agent:1`, { method: 'POST', headers: { ...ext, 'content-type': 'application/json' }, body: JSON.stringify({ notes: 'via key', replace: ['notes'] }) });
  check('update by ?key= (no key in the body)', byKeyUpd.status === 200 && (await snap()).find((c) => c.id === created.id).notes === 'via key', String(byKeyUpd.status));
  check('an unknown ?key= is 404, never a create', (await fetch(`${BASE}/kanban/external/card?key=agent:none`, { method: 'POST', headers: { ...ext, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Should not exist' }) })).status === 404 && !(await snap()).some((c) => c.title === 'Should not exist'));
  const noKey = await fetch(`${BASE}/kanban/external/card`, { method: 'POST', headers: { ...ext, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'No key' }) });
  const noKeyErr = (await noKey.json()).error;
  check('create without a key: 400 that says how to update instead', noKey.status === 400 && /key/.test(noKeyErr) && /\?id=/.test(noKeyErr), noKeyErr);
  const silent = await fetch(`${BASE}/kanban/external/card?id=user-1`, { method: 'POST', headers: { ...ext, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Renamed?' }) });
  const silentErr = (await silent.json()).error;
  check('a title on an update without replace is a 400 with a hint (not a silent no-op)', silent.status === 400 && /replace/.test(silentErr), silentErr);
  check('update by an unknown id is 404, not a create', (await fetch(`${BASE}/kanban/external/card?id=missing`, { method: 'POST', headers: { ...ext, 'content-type': 'application/json' }, body: JSON.stringify({ notes: 'x', replace: ['notes'] }) })).status === 404);
  const one = await (await fetch(`${BASE}/kanban/external/card?title=${encodeURIComponent('Plan the trip')}`, { headers: ext })).json();
  check('GET one card by title', one.ok && one.card.id === 'user-1' && one.card.attachments.length === 2);
  check('GET card: attachments carry their url, labels come as ids plus labelNames', one.card.attachments.every((a) => a.url === `/kanban/files/${a.id}`) && Array.isArray(one.card.labels) && Array.isArray(one.card.labelNames), JSON.stringify(one.card));

  // find
  const list = await (await fetch(`${BASE}/kanban/external/cards?q=trip`, { headers: ext })).json();
  const li = list.cards?.[0];
  check('GET /kanban/external/cards?q= finds by text; compact rows', list.ok && list.cards.length === 1 && li.id === 'user-1' && li.status === 'doing' && li.someday === false && Array.isArray(li.labels) && li.attachments[0].url.startsWith('/kanban/files/') && !('items' in li) && li.remindAt, JSON.stringify(li));
  const byStatus = await (await fetch(`${BASE}/kanban/external/cards?status=todo`, { headers: ext })).json();
  check('...filters by status', byStatus.cards.every((c) => c.status === 'todo') && byStatus.cards.some((c) => c.id === 'user-2'));
  await fetch(`${BASE}/kanban/external/card?id=user-2`, { method: 'POST', headers: { ...ext, 'content-type': 'application/json' }, body: JSON.stringify({ addLabels: ['Travel'] }) });
  const byLabel = await (await fetch(`${BASE}/kanban/external/cards?label=travel`, { headers: ext })).json();
  const travelId = (await (await fetch(`${BASE}/kanban/snapshot`, { headers: bearer })).json()).labels.find((l) => l.name === 'Travel').id;
  check('...and by label name; rows use the same label shape as GET card', byLabel.cards.length === 1 && byLabel.cards[0].id === 'user-2' && byLabel.cards[0].labels.includes(travelId) && byLabel.cards[0].labelNames.includes('Travel'), JSON.stringify(byLabel));
  check('the list needs the token', (await fetch(`${BASE}/kanban/external/cards`)).status === 401);

  // delete an attachment, delete a card
  const da = await fetch(`${BASE}/kanban/external/card/attach?id=user-1&attachment=${byId.attachment.id}`, { method: 'DELETE', headers: ext });
  check('DELETE an attachment', da.status === 200 && (await snap()).find((c) => c.id === 'user-1').attachments.length === 1);
  const dc = await fetch(`${BASE}/kanban/external/card?title=Twin&exact=1`, { method: 'DELETE', headers: ext });
  check('DELETE a card by id / title (a case-sensitive exact=1 disambiguates)', dc.status === 200 && !(await snap()).some((c) => c.id === 'user-2'), String(dc.status));

  // --- garbage collection (on start) ---------------------------------------------------------
  await stopServer(srv.child);
  const filesDir = path.join(dataDir, 'files');
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const age = (id) => { const sc = path.join(filesDir, id + '.json'); const j = JSON.parse(fs.readFileSync(sc, 'utf8')); j.createdAt = old; fs.writeFileSync(sc, JSON.stringify(j)); };
  age(zip.id); // never attached, 40 days old → collected
  age(atj.attachment.id); // attached to a live card → kept
  age(byId.attachment.id); // detached just now → kept for 30 days after the tombstone
  const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'kanban.json'), 'utf8'));
  age(byKey.attachment.id);
  disk.state.meta[created.id].att[byKey.attachment.id].x = { ts: old, dev: 'D' }; // detached 40 days ago
  disk.state.cards[created.id].attachments = [];
  fs.writeFileSync(path.join(dataDir, 'kanban.json'), JSON.stringify(disk));
  srv = await startServer(path.join(ROOT, 'server.js'), { port: PORT, env: { API_TOKEN: TOKEN, DATA_DIR: dataDir, TODOS_USER: USER, TODOS_PASS: PASS, FILE_MAX_BYTES: String(MAX) } });
  await new Promise((r) => setTimeout(r, 300));
  const exists = (id) => fs.existsSync(path.join(filesDir, id)) && fs.existsSync(path.join(filesDir, id + '.json'));
  check('GC: an old upload never attached is removed', !exists(zip.id));
  check('GC: a file attached to a live card stays, however old', exists(atj.attachment.id));
  check('GC: a file detached recently stays (30 days after its tombstone)', exists(byId.attachment.id));
  check('GC: a file detached 40 days ago is removed', !exists(byKey.attachment.id));
  check('GC: recent uploads stay', exists(f1.id) && fs.existsSync(path.join(filesDir, f1.id + '.thumb')));

  // --- the service worker's file cache (public/sw-files.js) ------------------------------------
  {
    const cacheStore = new Map();
    const caches = {
      async open(n) {
        if (!cacheStore.has(n)) cacheStore.set(n, new Map());
        const m = cacheStore.get(n);
        return { put: async (k, v) => void m.set(typeof k === 'string' ? k : k.url, v), match: async (k) => m.get(typeof k === 'string' ? k : new URL(k.url).pathname) ?? m.get(typeof k === 'string' ? k : k.url), delete: async (k) => m.delete(typeof k === 'string' ? k : k.url), keys: async () => [...m.keys()].map((url) => ({ url })) };
      },
      async delete(n) { return cacheStore.delete(n); },
    };
    const handlers = {};
    let network = 0;
    const self = { location: { origin: 'https://todos.test' }, addEventListener: (t, fn) => (handlers[t] = fn) };
    const fetch = async (req) => {
      network++;
      const r = new Response('img', { status: req.url.includes('missing') ? 404 : 200, headers: { 'content-length': '3' } });
      Object.defineProperty(r, 'type', { value: 'basic' }); // same-origin, as in the browser
      return r;
    };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public', 'sw-files.js'), 'utf8'), { self, caches, fetch, URL, Response, Number, Promise, console });
    const get = async (p) => {
      let out;
      handlers.fetch({ request: new Request('https://todos.test' + p), respondWith: (x) => (out = x) });
      const r = await out;
      await new Promise((res) => setTimeout(res, 10));
      return r;
    };
    await get('/kanban/files/abcdefgh1');
    const n1 = network;
    await get('/kanban/files/abcdefgh1');
    check('SW: a viewed file is cache-first', network === n1, `${n1} → ${network}`);
    await get('/kanban/files/missing123');
    await get('/kanban/files/missing123');
    check('SW: errors are never cached', network === n1 + 2);
    (await caches.open('todos-files-state')).put('/__todos-files-signed-out', new Response('1'));
    await get('/kanban/files/abcdefgh1');
    check('SW: signed out (the marker), a cached file is not served from the cache', network === n1 + 3);
    await get('/kanban/files/zzzzzzzz9');
    check('SW: ...nor stored', !cacheStore.get('todos-files-v1')?.has('https://todos.test/kanban/files/zzzzzzzz9'));
  }

  // --- /agents: public guide that documents every route ---------------------------------------
  const md = await fetch(`${BASE}/agents`);
  const doc = await md.text();
  check('/agents is public markdown by default', md.status === 200 && /text\/markdown/.test(md.headers.get('content-type')) && doc.startsWith('# '));
  const htmlDoc = await fetch(`${BASE}/agents`, { headers: { accept: 'text/html' } });
  const htmlText = await htmlDoc.text();
  check('...and HTML for a browser', /text\/html/.test(htmlDoc.headers.get('content-type')) && /<h1>/.test(htmlText) && /<pre><code>/.test(htmlText));
  check('it says where the token lives and never contains it', /external-token/.test(doc) && !doc.includes(EXT) && !doc.includes(TOKEN));
  check('one H1', (doc.match(/^# /gm) ?? []).length === 1 && (htmlText.match(/<h1>/g) ?? []).length === 1);
  check('it covers getting the token, ?key= updates, Someday moving to To do, detached files until GC, and name encodings', /## Getting the token/.test(doc) && /\?key=/.test(doc) && /moves .*to To do/i.test(doc) && /30 days/.test(doc) && /X-Filename-Encoding/.test(doc));
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const table = [...src.matchAll(/^\s*\['(GET|POST|DELETE)', '([^']+)'/gm)].map((m) => `${m[1]} ${m[2]}`);
  check('the router table lists the agent routes', table.length >= 10 && table.includes('POST /kanban/external/card/attach') && table.includes('GET /kanban/external/cards'), table.join(' | '));
  const missing = table.filter((r) => !doc.includes(r));
  check('every route in the router table is documented in /agents', missing.length === 0, missing.join(', '));
  const literals = [...new Set([...src.matchAll(/p === '(\/kanban\/(?:external|files)[^']*)'/g)].map((m) => m[1]))];
  const untabled = literals.filter((l) => !table.some((r) => r.endsWith(' ' + l)));
  check('every handled external/files path is in the router table', untabled.length === 0, untabled.join(', '));
  check('every documented route has a curl example', table.every((r) => doc.includes('curl') && doc.includes(r.split(' ')[1])));
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
