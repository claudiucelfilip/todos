import crypto from 'node:crypto';
import { validateAssistantRequest } from './assistant.mjs';

export function createAssistantJobs(ask, { lifetime = 300000, retention = 600000, limit = 30 } = {}) {
  const jobs = new Map(); const rates = new Map(); let running = false;
  const terminal = job => ['complete', 'failed', 'cancelled'].includes(job.status);
  const view = job => ({ id: job.id, status: job.status, ...(job.result || {}), ...(job.error ? { error: job.error } : {}) });
  const clean = () => { for (const [id, job] of jobs) if (terminal(job) && Date.now() - job.finished > retention) jobs.delete(id); };
  async function drain() {
    if (running) return;
    const job = [...jobs.values()].find(job => job.status === 'queued');
    if (!job) return;
    running = true; job.status = 'waiting';
    try {
      const result = await ask(job.body, job.cards, job.controller.signal, { timeout: lifetime, onProgress: () => { if (!terminal(job)) job.status = 'working'; } });
      if (!terminal(job)) { job.result = result; job.status = 'complete'; }
    } catch (error) {
      if (!terminal(job)) { job.status = 'failed'; job.error = error.message; }
    } finally {
      clearTimeout(job.timer); job.finished = Date.now();
      job.body = null; job.cards = null;
      running = false; void drain();
    }
  }
  function owned(id, user, room) {
    clean(); const job = jobs.get(id);
    if (!job || job.user !== user || job.room !== room) throw Object.assign(new Error('This assistant request is no longer available. Please ask again.'), { status: 404 });
    return job;
  }
  return {
    start(body, cards, user, room) {
      validateAssistantRequest(body);
      if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(body.requestId)) throw Object.assign(new Error('Invalid assistant request. Please try again.'), { status: 400 });
      clean();
      const prior = [...jobs.values()].find(job => job.user === user && job.room === room && job.requestId === body.requestId);
      if (prior) return view(prior);
      // One question in flight per user, so nobody can fill the queue for everyone else.
      if ([...jobs.values()].some(job => job.user === user && !terminal(job))) throw Object.assign(new Error('Your previous question is still running. Wait for it or stop it first.'), { status: 429 });
      if ([...jobs.values()].filter(job => !terminal(job)).length >= 4) throw Object.assign(new Error('The assistant queue is full. Try again shortly.'), { status: 429 });
      const recent = (rates.get(user) || []).filter(at => Date.now() - at < 600000);
      if (recent.length >= limit) throw Object.assign(new Error('You’ve made many requests. Please try again in a few minutes.'), { status: 429 });
      recent.push(Date.now()); rates.set(user, recent);
      for (const [key, times] of rates) if (Date.now() - times.at(-1) > 600000) rates.delete(key);
      const job = { id: crypto.randomUUID(), requestId: body.requestId, user, room, body, cards, status: 'queued', controller: new AbortController(), finished: 0 };
      job.timer = setTimeout(() => {
        if (terminal(job)) return;
        job.status = 'failed'; job.error = 'The assistant did not finish this request. Please try again shortly.';
        job.finished = Date.now(); job.controller.abort(); job.body = null; job.cards = null;
      }, lifetime);
      job.timer.unref(); jobs.set(job.id, job); void drain();
      return view(job);
    },
    get(id, user, room) { return view(owned(id, user, room)); },
    cancel(id, user, room) {
      const job = owned(id, user, room);
      if (!terminal(job)) {
        job.status = 'cancelled'; job.error = 'Request stopped. You can ask again.';
        job.finished = Date.now(); clearTimeout(job.timer); job.controller.abort();
        job.body = null; job.cards = null;
      }
      return view(job);
    },
  };
}
