import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SMTPServer } from 'smtp-server';
import { accountStore } from '../shared/accounts.mjs';
import { startServer, stopServer, freePort } from './test-server.mjs';

let checks = 0;
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks++; console.log('ok', name); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-email-test-'));
const mail = [];
const smtp = new SMTPServer({ secure: false, authOptional: true, disabledCommands: ['STARTTLS'], onData(stream, session, callback) {
  let raw = ''; stream.on('data', (chunk) => raw += chunk); stream.on('end', () => { mail.push({ to: session.envelope.rcptTo[0].address, raw: raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, n) => String.fromCharCode(parseInt(n, 16))) }); callback(); });
} });
await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
const port = await freePort();
const env = { DATA_DIR: dir, TODOS_USER: 'owner', TODOS_PASS: 'test-owner-password', TODOS_SMTP_HOST: '127.0.0.1', TODOS_SMTP_PORT: String(smtp.server.address().port), TODOS_MAIL_FROM: 'Todos <todos@example.test>', APP_URL: `http://127.0.0.1:${port}` };
let server;
async function request(route, body, cookie, headers = {}) {
  const res = await fetch(server.base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '127.0.0.2', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { res, data: await res.json().catch(() => null) };
}
async function tokenFor(email) {
  for (let i=0;i<60;i++) { const message=mail.find((m) => m.to === email); if (message) return message.raw.match(/#signin\/([a-zA-Z0-9_-]{43})/)[1]; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error('Email was not delivered to isolated SMTP sink.');
}
try {
  server = await startServer('server.js', { env, port });
  check('email sign-in available only with a sender', (await request('/kanban/auth-options')).data.email, true);
  check('password signup disabled with email enabled', (await request('/kanban/register', {})).res.status, 403);
  check('malformed request body rejected', (await request('/kanban/email/request', null)).res.status, 400);
  check('malformed consume body rejected', (await request('/kanban/email/consume', null)).res.status, 400);
  check('malformed email rejected', (await request('/kanban/email/request', {email:'not-email'})).res.status, 400);
  const first = await request('/kanban/email/request', {email:' First@Example.Test '});
  check('signup request accepted without password', first.data.ok, true);
  const token = await tokenFor('first@example.test');
  check('no account created before verification', Object.keys(JSON.parse(fs.readFileSync(path.join(dir,'accounts.json'))).users), ['owner']);
  check('raw token never saved', fs.readFileSync(path.join(dir,'accounts.json'),'utf8').includes(token), false);
  await request('/kanban/email/consume');
  check('GET scanner does not create an account', Object.keys(JSON.parse(fs.readFileSync(path.join(dir,'accounts.json'))).users), ['owner']);
  const signed = await request('/kanban/email/consume', {token});
  check('link signs in new email account', signed.res.status, 200);
  const cookie = signed.res.headers.get('set-cookie').split(';')[0];
  const info = (await request('/kanban/account', undefined, cookie)).data;
  check('verified email stored', info.email, 'first@example.test');
  check('private room belongs to new user', info.rooms[0].owner, info.user);
  check('new user has no stored password', Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dir,'accounts.json'))).users[info.user], 'password'), false);
  check('single-use link rejects replay', (await request('/kanban/email/consume', {token})).res.status, 400);
  const resend = (await request('/kanban/email/request', {email:'first@example.test'})).data;
  check('resend within a minute answers exactly like a fresh request', [resend.ok, typeof resend.request, /^\d{4}$/.test(resend.code)], [true, 'string', true]);
  check('throttled wait id stays pending rather than revealing the throttle', (await request('/kanban/email/wait', {request: resend.request})).data, {status:'pending'});
  const repeat = await tokenFor('first@example.test');
  await stopServer(server.child); server = await startServer('server.js', { env, port });
  check('email-only session survives restart', (await request('/kanban/session', undefined, cookie)).data.user, info.user);
  check('new user cannot access owner private room', (await request('/kanban/snapshot?room=personal', undefined, cookie)).res.status, 403);
  const owner = (await request('/kanban/login', {username:'owner',password:'test-owner-password'})).res.headers.get('set-cookie').split(';')[0];
  check('anonymous cannot attach email to owner', (await request('/kanban/email/request', {email:'attack@example.test',linkAccount:true})).res.status, 401);
  await request('/kanban/email/request', {email:'owner@example.test',linkAccount:true}, owner);
  const ownerToken = await tokenFor('owner@example.test');
  const ownerSigned = await request('/kanban/email/consume', {token:ownerToken});
  check('verified email attaches to existing owner', ownerSigned.data.user, 'owner');
  check('existing owner room is preserved', ownerSigned.data.room, 'personal');
  const shared = (await request('/kanban/rooms', {name:'Household'}, owner)).data.room;
  const invitation = (await request('/kanban/invite', {room:shared.id}, owner)).data.url;
  const invite = new URL(invitation).searchParams.get('invite');
  await request('/kanban/email/request', {email:'partner@example.test',invite});
  const partner = await request('/kanban/email/consume', {token:await tokenFor('partner@example.test')});
  check('email signup joins invited room', partner.data.room, shared.id);
  const partnerCookie = partner.res.headers.get('set-cookie').split(';')[0];
  check('invited user also gets personal room', (await request('/kanban/account', undefined, partnerCookie)).data.rooms.length, 2);
  check('invitation consumed once', (await request(`/kanban/invitation?token=${invite}`)).res.status, 404);
  check('cross-site request denied', (await request('/kanban/email/request', {email:'cross@example.test'}, undefined, {Origin:'https://attacker.invalid'})).res.status, 403);
  check('cross-site consume denied', (await request('/kanban/email/consume', {token:repeat}, undefined, {Origin:'https://attacker.invalid'})).res.status, 403);
  const sentCount = mail.length;
  check('resend throttle uses same generic result', (await request('/kanban/email/request', {email:'partner@example.test'})).data.ok, true);
  // Already-used links may be resent; two immediate requests must send only once.
  await request('/kanban/email/request', {email:'partner@example.test'});
  await new Promise((resolve) => setTimeout(resolve, 200));
  check('immediate repeated request cannot flood email', mail.length <= sentCount + 1, true);
  for(let i=0;i<12;i++) await request('/kanban/email/request', {email:`limit${i}@example.test`});
  check('per-IP request limit enforced', (await request('/kanban/email/request', {email:'limit-final@example.test'})).res.status, 429);
  // Approve on the device that asked: the link opens anywhere, the session lands where the email was typed.
  const ip3 = {'X-Forwarded-For':'127.0.0.3'}, ip4 = {'X-Forwarded-For':'127.0.0.4'};
  const iphone = {...ip3, 'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'};
  const asked = await request('/kanban/email/request', {email:'phone@example.test', app:true}, undefined, iphone);
  check('request returns a wait id and a match code', [typeof asked.data.request, /^\d{4}$/.test(asked.data.code)], ['string', true]);
  const phoneToken = await tokenFor('phone@example.test');
  const linkInfo = await request('/kanban/email/link', {token: phoneToken}, undefined, ip3);
  check('link page learns which device asked but not its code', [linkInfo.data.device, 'code' in linkInfo.data], ['the Todos app on iPhone', false]);
  check('email names the device that asked', mail.find((m) => m.to === 'phone@example.test').raw.includes('Requested from the Todos app on iPhone'), true);
  const wrong = await request('/kanban/email/approve', {token: phoneToken, code: asked.data.code === '0000' ? '0001' : '0000'}, undefined, ip3);
  check('approving needs the code the waiting device shows', wrong.res.status, 400);
  check('unknown link has no info', (await request('/kanban/email/link', {token: 'x'.repeat(43)}, undefined, ip3)).res.status, 404);
  check('link info is not served by GET', (await request('/kanban/email/link?token=' + phoneToken, undefined, undefined, ip3)).data?.device ?? null, null);
  check('cross-site link lookup denied', (await request('/kanban/email/link', {token: phoneToken}, undefined, {...ip3, Origin:'https://attacker.invalid'})).res.status, 403);
  check('waiting device sees pending', (await request('/kanban/email/wait', {request: asked.data.request}, undefined, ip3)).data, {status:'pending'});
  check('wrong wait id reads as expired', (await request('/kanban/email/wait', {request: 'x'.repeat(43)}, undefined, ip3)).data.status, 'expired');
  const approved = await request('/kanban/email/approve', {token: phoneToken, code: asked.data.code.slice(0,2) + ' ' + asked.data.code.slice(2)}, undefined, ip3);
  check('approving signs in nothing in the approving browser', [approved.data, approved.res.headers.get('set-cookie')], [{ok:true, device:'the Todos app on iPhone'}, null]);
  check('approved link cannot be used again', (await request('/kanban/email/consume', {token: phoneToken}, undefined, ip3)).res.status, 400);
  const got = await request('/kanban/email/wait', {request: asked.data.request}, undefined, ip3);
  check('waiting device receives the session', [got.data.status, !!got.res.headers.get('set-cookie')], ['approved', true]);
  const phoneCookie = got.res.headers.get('set-cookie').split(';')[0];
  check('waiting device is signed in as the email account', (await request('/kanban/account', undefined, phoneCookie)).data.email, 'phone@example.test');
  check('session is handed over once', (await request('/kanban/email/wait', {request: asked.data.request}, undefined, ip3)).data.status, 'expired');
  const second = await request('/kanban/email/request', {email:'laptop@example.test'}, undefined, ip4);
  await request('/kanban/email/consume', {token: await tokenFor('laptop@example.test')}, undefined, ip4);
  check('link used in the opening browser is reported to the waiting device', (await request('/kanban/email/wait', {request: second.data.request}, undefined, ip4)).data.status, 'used');
  check('cross-site approve denied', (await request('/kanban/email/approve', {token: phoneToken, code: asked.data.code}, undefined, {...ip4, Origin:'https://attacker.invalid'})).res.status, 403);
  const guess = await request('/kanban/email/request', {email:'guess@example.test'}, undefined, ip4);
  const guessToken = await tokenFor('guess@example.test');
  for (let i = 0; i < 5; i++) await request('/kanban/email/approve', {token: guessToken, code: String((Number(guess.data.code) + 1 + i) % 10000).padStart(4, '0')}, undefined, ip4);
  check('five wrong codes void the link', (await request('/kanban/email/approve', {token: guessToken, code: guess.data.code}, undefined, ip4)).res.status, 400);
  check('cross-site wait denied', (await request('/kanban/email/wait', {request: second.data.request}, undefined, {...ip4, Origin:'https://attacker.invalid'})).res.status, 403);
  const unitDir = fs.mkdtempSync(path.join(dir,'unit-'));
  const store = accountStore(unitDir,'owner');
  const pending = store.requestEmail('expire@example.test');
  const originalNow = Date.now;
  try { Date.now = () => originalNow() + 16*60000; assert.throws(() => store.consumeEmail(pending.token)); checks++; console.log('ok expired link denied'); } finally { Date.now = originalNow; }
  const waited = store.requestEmail('waiting@example.test', { device: 'Chrome on Mac' });
  check('raw wait id never saved', fs.readFileSync(path.join(unitDir,'accounts.json'),'utf8').includes(waited.request), false);
  store.approveEmail(waited.token, waited.code);
  try { Date.now = () => originalNow() + 16*60000; check('uncollected approval expires', store.waitEmail(waited.request).status, 'expired'); } finally { Date.now = originalNow; }
  const link = store.requestEmail('persistent@example.test');
  check('pending link survives store restart', accountStore(unitDir,'owner').consumeEmail(link.token).user.email, 'persistent@example.test');
  check('token has 256 bits of entropy', Buffer.from(link.token,'base64url').length, 32);
  const originalUser = accountStore(unitDir,'owner').user('persistent@example.test');
  try { Date.now = () => originalNow() + 61000; const returning = accountStore(unitDir,'owner'); const again = returning.requestEmail('persistent@example.test'); check('returning link opens same account', returning.consumeEmail(again.token).user.personalRoom, originalUser.personalRoom); } finally { Date.now = originalNow; }
  const collision = accountStore(fs.mkdtempSync(path.join(dir, 'collision-')), 'original@example.test');
  const migrated = collision.requestEmail('changed@example.test', { username: 'original@example.test' });
  collision.consumeEmail(migrated.token);
  const signup = collision.consumeEmail(collision.requestEmail('original@example.test').token);
  check('signup never overwrites an existing account name', collision.user('original@example.test').email, 'changed@example.test');
  check('address reused after migration gets a separate private room', signup.user.personalRoom !== 'personal', true);
  console.log(`PASS: ${checks} email authentication checks`);
} finally { await stopServer(server?.child); await new Promise((resolve) => smtp.close(resolve)); fs.rmSync(dir,{recursive:true,force:true}); }
