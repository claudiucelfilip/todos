import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSherlock, substantive, replySentence } from '../shared/sherlock.mjs';
import { sherlockFixture } from './sherlock-fixture.mjs';
import { cleanBehavior } from '../shared/automations.mjs';

async function setup(t) {
  const fixture = await sherlockFixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlock-test-'));
  const cards = { a: { id: 'a', title: 'Appointment', notes: 'Bring documents', items: [{ text: 'Call', done: false }], labels: ['workflow:todo'] } }, commits = [];
  const opts = { file: path.join(dir, 'sherlock.json'), config: fixture.config, getCard: id => cards[id], getLabels: () => [], commit: async (id, change) => { commits.push(change); } };
  const bridge = createSherlock(opts);
  t.after(async () => { await fixture.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { fixture, bridge, cards, commits, opts };
}
const request = (id = 'request-00000001', message = '') => ({ requestId: id, message });
test('send, concurrent duplicate retry, receipt after restart, one thread and context', async t => {
  const { bridge, fixture, commits, opts } = await setup(t);
  const [a, b] = await Promise.all([bridge.send('a', request()), bridge.send('a', request())]);
  assert.equal(a.url, b.url); assert.equal(fixture.messages.filter(m => m.metadata?.event_type === 'todos_handoff').length, 1); assert.equal(fixture.deliveries.length, 1); assert.equal(commits.length, 1);
  assert.match(fixture.deliveries[0].prompt, /Bring documents/); assert.match(fixture.deliveries[0].prompt, /\[ \] Call/);
  await createSherlock(opts).send('a', request()); assert.equal(fixture.messages.filter(m => m.metadata?.event_type === 'todos_handoff').length, 1);
  await bridge.send('a', request('request-00000002', 'What next?'));
  assert.equal(fixture.messages.filter(m => m.metadata?.event_type === 'todos_handoff')[1].thread_ts, fixture.messages[0].ts); assert.equal(fixture.deliveries[1].thread, fixture.messages[0].ts);
});
test('ambiguous Slack success is reconciled before retry without posting twice', async t => {
  const { bridge, fixture } = await setup(t); fixture.fail = 'ambiguous';
  await assert.rejects(bridge.send('a', request()), { code: 'SLACK_TIMEOUT' });
  const result = await bridge.send('a', request()); assert(result.connected); assert.equal(fixture.messages.filter(m => m.metadata?.event_type === 'todos_handoff').length, 1); assert.equal(fixture.deliveries.length, 1);
});
test('gateway failure retries the saved Slack message', async t => {
  const { bridge, fixture } = await setup(t); fixture.fail = 'gateway';
  await assert.rejects(bridge.send('a', request()), { code: 'SHERLOCK_UNAVAILABLE' }); fixture.fail = '';
  await bridge.send('a', request()); assert.equal(fixture.messages.filter(m => m.metadata?.event_type === 'todos_handoff').length, 1); assert.equal(fixture.deliveries.length, 2);
});
test('imported answers stay unread until viewed and follow up in the original thread', async t => {
  const { bridge, fixture, cards } = await setup(t);
  cards.a.ext = { key: 'wiki:1', slackTs: '1700000000.000001', slackChannel: 'DM' };
  fixture.messages.push({ channel: 'DM', ts: '1700000000.000001', user: 'USER', text: 'Source' }, { channel: 'DM', ts: '1700000001.000001', thread_ts: '1700000000.000001', user: 'BOT', text: 'Your initial answer.' });
  const result = await bridge.refresh('a'); assert(result.connected); assert.equal(result.unread, true);
  bridge.view('a', result.reply.ts); assert(!bridge.unread('a'));
  await bridge.send('a', request()); assert.equal(fixture.messages.at(-1).thread_ts, '1700000000.000001');
});
test('acknowledgments and other senders do not notify; new replies survive stale views', async t => {
  const { bridge, fixture } = await setup(t); await bridge.send('a', request()); const root = fixture.messages[0].ts;
  const reply = (ts, text, user = 'BOT') => fixture.messages.push({ channel: 'DM', thread_ts: root, ts, text, user });
  reply('1800000010.000001', 'Looking into it.'); reply('1800000011.000001', 'External text.', 'OTHER');
  assert.equal((await bridge.refresh('a')).unread, false);
  reply('1800000012.000001', 'Bring your referral and ID. Then call.'); const first = await bridge.refresh('a'); assert(first.unread); assert.equal(first.reply.summary, 'Bring your referral and ID.');
  reply('1800000013.000001', 'Which clinic should I check?'); const second = await bridge.refresh('a');
  bridge.view('a', first.reply.ts); assert(bridge.unread('a')); bridge.view('a', second.reply.ts); assert(!bridge.unread('a'));
  reply('1800000014.000001', 'New answer.'); assert((await bridge.refresh('a')).unread);
});
test('a response arriving during send is not cleared by late delivery confirmation', async t => {
  const { bridge, fixture, opts } = await setup(t); await bridge.send('a', request()); const root = fixture.messages[0].ts;
  fixture.messages.push({ channel: 'DM', thread_ts: root, ts: '1800000010.000001', text: 'First answer.', user: 'BOT' }); await bridge.refresh('a');
  const original = fixture.config.webhookUrl;
  // The HTTP request is blocked while a newer reply is recorded, as with two devices.
  const originalFetch = globalThis.fetch;
  let release, started;
  const gate = new Promise(r => release = r), waiting = new Promise(r => started = r);
  const other = createSherlock({ file: path.join(path.dirname(opts.file), 'race.json'), config: fixture.config, getCard: () => ({ title: 'Task', notes: '', items: [], labels: [], ext: { slackChannel: 'DM', slackTs: root } }), getLabels: () => [], commit: async () => {}, fetcher: async (...args) => { if (args[0] === original) { started(); await gate; } return originalFetch(...args); } });
  await other.refresh('a'); const sending = other.send('a', request('request-race-0001')); await waiting;
  // Refresh serializes on the note; its unread cursor is evaluated after the send finishes.
  fixture.messages.push({ channel: 'DM', thread_ts: root, ts: '1800000011.000001', text: 'New answer during send.', user: 'BOT' }); release(); await sending;
  assert((await other.refresh('a')).unread);
});
test('label remove-on-view survives older-client edits and can be disabled', () => {
  assert.deepEqual(cleanBehavior({}, { removeOnView: true }), { removeOnView: true });
  assert.deepEqual(cleanBehavior({ removeOnView: false }, { removeOnView: true }), { removeOnView: false });
  assert(!substantive({ user: 'BOT', text: 'Got it, looking into it.' }, 'BOT'));
  assert.equal(replySentence('Which clinic? More details.'), 'Which clinic?');
});

test('two different first requests share one authoritative conversation', async t => {
  const { bridge, fixture } = await setup(t);
  await Promise.all([bridge.send('a', request('concurrent-00001')), bridge.send('a', request('concurrent-00002', 'More context'))]);
  const posts = fixture.messages.filter(m => m.metadata?.event_type === 'todos_handoff');
  assert.equal(posts.length, 2); assert.equal(posts[1].thread_ts, posts[0].ts);
});
test('definitive Slack failure changes no labels and can retry', async t => {
  const { bridge, fixture, commits } = await setup(t); fixture.fail = 'slack';
  await assert.rejects(bridge.send('a', request()), { code: 'SLACK_RATELIMITED' }); assert.equal(commits.length, 0);
  fixture.fail = ''; await bridge.send('a', request()); assert.equal(commits.length, 1);
});
test('unavailable imported thread can explicitly start a new conversation', async t => {
  const { bridge, fixture, cards } = await setup(t); cards.a.ext = { key: 'wiki:gone', slackChannel: 'DM', slackTs: '1700000000.000001' };
  await assert.rejects(bridge.refresh('a'), { code: 'SLACK_THREAD_NOT_FOUND' }); await bridge.reset('a');
  await bridge.send('a', request()); assert.equal(fixture.messages.filter(m => m.metadata?.event_type === 'todos_handoff').length, 1);
});
test('a Slack link in Markdown recovers the original conversation', async t => {
  const { bridge, fixture, cards } = await setup(t);
  cards.a.notes = '[Original Slack thread](https://fixture.slack.com/archives/DM/p1700000000000001)';
  fixture.messages.push({ channel: 'DM', ts: '1700000000.000001', user: 'USER', text: 'Original' });
  assert((await bridge.refresh('a')).connected); await bridge.send('a', request());
  assert.equal(fixture.messages.find(m => m.metadata?.event_type === 'todos_handoff').thread_ts, '1700000000.000001');
});
test('invalid and future view cursors cannot hide an unread response', async t => {
  const { bridge, fixture } = await setup(t); await bridge.send('a', request());
  fixture.messages.push({ channel: 'DM', thread_ts: fixture.messages[0].ts, ts: '1800000010.000001', user: 'BOT', text: 'A useful response.' }); await bridge.refresh('a');
  for (const cursor of ['NaN', 'Infinity', {}, '9999999999.999999']) { bridge.view('a', cursor); assert(bridge.unread('a')); }
});

test('an uncertain first send is reconciled before a different request can create a thread', async t => {
  const { bridge, fixture } = await setup(t); fixture.fail = 'ambiguous';
  await assert.rejects(bridge.send('a', request('uncertain-first01')), { code: 'SLACK_TIMEOUT' });
  await bridge.send('a', request('different-next01', 'Follow up'));
  const posts = fixture.messages.filter(m => m.metadata?.event_type === 'todos_handoff');
  assert.equal(posts.length, 2); assert.equal(posts[1].thread_ts, posts[0].ts);
  await bridge.send('a', request('uncertain-first01')); assert.equal(fixture.messages.filter(m => m.metadata?.event_type === 'todos_handoff').length, 2);
});
test('an unrelated response cannot prove an uncertain webhook was accepted', async t => {
  const { fixture, cards, opts } = await setup(t); let drop = false;
  const bridge = createSherlock({ ...opts, fetcher: async (...args) => { if (drop && args[0] === fixture.config.webhookUrl) { drop = false; throw new TypeError('connection reset'); } return fetch(...args); } });
  await bridge.send('a', request('accepted-old001')); drop = true;
  await assert.rejects(bridge.send('a', request('unaccepted-new01', 'A new request')), { code: 'SHERLOCK_TIMEOUT' });
  fixture.messages.push({ channel: 'DM', thread_ts: fixture.messages[0].ts, ts: '1900000000.000001', user: 'BOT', text: 'Answer to the old request.' });
  await assert.rejects(bridge.send('a', request('unaccepted-new01', 'A new request')), { code: 'DELIVERY_UNCONFIRMED' }); assert.equal(fixture.deliveries.length, 1);
  assert(cards.a);
});
test('stale note context stops delivery until the matching update is synced', async t => {
  const { bridge, fixture, cards } = await setup(t);
  const context = { ...cards.a, notes: 'The newly typed content' };
  await assert.rejects(bridge.send('a', { ...request(), context }), { code: 'NOTE_NOT_SYNCED' }); assert.equal(fixture.messages.length, 0);
  cards.a.notes = context.notes; await bridge.send('a', { ...request(), context }); assert.match(fixture.deliveries[0].prompt, /newly typed content/);
  for (const text of ['Got it.', 'Sure, I’ll look into it.', 'Looking into it.']) assert(!substantive({ user: 'BOT', text }, 'BOT'));
});

test('wiki briefs posted as root messages notify; acknowledgments do not', async t => {
  const { bridge, fixture, cards } = await setup(t);
  cards.a.ext = { key: 'wiki:brief', slackChannel: 'DM', slackTs: '1700000000.000001' };
  fixture.messages.push({ channel: 'DM', ts: '1700000000.000001', user: 'BOT', text: 'A useful source summary. More details.' });
  const result = await bridge.refresh('a');
  assert(result.unread); assert.equal(result.reply.summary, 'A useful source summary.');
  assert.equal(fixture.deliveries.length, 0); assert(!fixture.calls.some(c => c.method === 'chat.postMessage'));
  cards.b = { id: 'b', ext: { key: 'sherlock:ack', slackChannel: 'DM', slackTs: '1700000002.000001' } };
  fixture.messages.push({ channel: 'DM', ts: '1700000002.000001', user: 'BOT', text: 'Looking into it.' });
  assert.equal((await bridge.refresh('b')).unread, false);
});
test('legacy import baseline migrates once without resetting later views or sent conversations', async t => {
  const { opts } = await setup(t);
  const receipt = { requests: {}, boundAt: '2026-10-15T12:00:00.000Z', channel: 'DM', ts: '1700000000.000001', reply: { ts: '1700000001.000001', summary: 'Initial brief.' }, readThrough: '1700000001.000001' };
  fs.writeFileSync(opts.file, JSON.stringify({ notes: {
    a: receipt,
    viewed: { ...receipt, viewedThrough: receipt.readThrough },
    sent: { ...receipt, requests: { 'request-old': { accepted: true } } },
    later: { ...receipt, reply: { ts: '1900000000.000001' }, readThrough: '1900000000.000001' },
    native: { ...receipt, boundAt: undefined },
  } }));
  let bridge = createSherlock(opts); assert(bridge.unread('a'));
  for (const id of ['viewed', 'sent', 'later', 'native']) assert(!bridge.unread(id), id);
  bridge.view('a', receipt.reply.ts); bridge = createSherlock(opts); assert(!bridge.unread('a'));
});
