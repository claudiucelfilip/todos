import http from 'node:http';
export async function sherlockFixture() {
  const messages = [], deliveries = [], calls = [];
  let seq = 1800000000, fail = '', autoReply = false;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = req.headers['content-type']?.includes('application/json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw)), method = req.url.split('/').at(-1);
    calls.push({ method, body });
    const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (method === 'hook') {
      deliveries.push(body);
      if (fail === 'gateway') { res.statusCode = 503; return json({ error: 'offline' }); }
      if (autoReply) messages.push({ user: 'BOT', channel: body.channel, thread_ts: body.thread, ts: `${++seq}.000001`, text: 'Bring your referral and ID. The clinic accepts appointments by phone.' });
      return json({ status: 'accepted' });
    }
    if (method === 'chat.postMessage') {
      if (fail === 'slack') return json({ ok: false, error: 'ratelimited' });
      const message = { ...body, user: 'BOT', ts: `${++seq}.000001` }; messages.push(message);
      if (fail === 'ambiguous') { fail = ''; req.socket.destroy(); return; }
      return json({ ok: true, ts: message.ts, channel: body.channel });
    }
    if (method === 'conversations.replies') {
      const root = messages.find(m => m.channel === body.channel && m.ts === body.ts);
      if (!root) return json({ ok: false, error: 'thread_not_found' });
      return json({ ok: true, messages: messages.filter(m => m.channel === body.channel && (m.ts === body.ts || m.thread_ts === body.ts)) });
    }
    if (method === 'conversations.history') return json({ ok: true, messages: messages.filter(m => m.channel === body.channel && (!body.latest || m.ts === body.latest)) });
    if (method === 'chat.getPermalink') return json({ ok: true, permalink: `http://127.0.0.1:${server.address().port}/thread/${body.message_ts}` });
    return json({ ok: false, error: 'unknown_method' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { messages, deliveries, calls, config: { token: 'fixture-token', botUser: 'BOT', channel: 'DM', secret: 'fixture-secret', webhookUrl: `${base}/hook`, slackBase: base, users: ['owner'], rooms: ['personal'], timeout: 1500 }, set fail(value) { fail = value; }, set autoReply(value) { autoReply = value; }, stop: () => new Promise(resolve => server.close(resolve)) };
}
