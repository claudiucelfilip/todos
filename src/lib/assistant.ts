export interface AssistantProposal {
  type: 'create' | 'checklist';
  title: string;
  notes: string;
  items: string[];
  cardId?: string;
}
export interface AssistantMessage {
  role: 'user' | 'assistant';
  failed?: boolean;
  content: string;
  proposals?: AssistantProposal[];
}

export type AssistantProgress = 'queued' | 'waiting' | 'working' | 'reconnecting';
export interface AssistantJob {
  id: string;
  status: 'queued' | 'waiting' | 'working' | 'complete' | 'failed' | 'cancelled';
  reply?: string;
  proposals?: AssistantProposal[];
  error?: string;
}
class AssistantConnectionError extends Error {}

export async function assistantJson(path: string, init: RequestInit, signal: AbortSignal, timeout = 12000, fetcher: typeof fetch = fetch): Promise<AssistantJob> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const timer = setTimeout(cancel, timeout);
  try {
    const response = await fetcher(path, { ...init, credentials: 'same-origin', signal: controller.signal });
    if (response.status === 401) throw new Error('Please sign in again to use the assistant.');
    if (response.status === 403) throw new Error('You do not have access to the assistant in this room.');
    if (!response.headers.get('Content-Type')?.includes('application/json')) throw new AssistantConnectionError('The assistant connection was interrupted. Please try again.');
    const result = await response.json().catch(() => { throw new AssistantConnectionError('The assistant connection was interrupted. Please try again.'); });
    if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'The assistant is unavailable. Please try again.');
    if (!result || typeof result.id !== 'string' || !['queued', 'waiting', 'working', 'complete', 'failed', 'cancelled'].includes(result.status)) throw new AssistantConnectionError('The assistant returned an incomplete response. Please try again.');
    if (result.status === 'complete' && (typeof result.reply !== 'string' || !Array.isArray(result.proposals) || result.proposals.some((p: AssistantProposal) => !p || !['create', 'checklist'].includes(p.type) || typeof p.title !== 'string' || typeof p.notes !== 'string' || !Array.isArray(p.items) || p.items.some(i => typeof i !== 'string') || (p.type === 'checklist' && typeof p.cardId !== 'string')))) throw new AssistantConnectionError('The assistant returned an incomplete response. Please try again.');
    return result;
  } catch (error) {
    if (signal.aborted) throw new Error('Request stopped. You can ask again.');
    if (controller.signal.aborted || error instanceof TypeError) throw new AssistantConnectionError('Could not reach the assistant. Check your connection and try again.');
    throw error;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new Error('Request stopped. You can ask again.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

/** §12.2: the card the user is asking about (id, title, body, items). */
export interface AssistantFocus {
  id: string;
  title: string;
  notes: string;
  items: { text: string; done: boolean }[];
}

type AssistantReply = { reply: string; proposals: AssistantProposal[] };
type AssistantMock = (message: string, focus: AssistantFocus | null) => (AssistantReply & { delayMs?: number; error?: string }) | Promise<AssistantReply & { delayMs?: number; error?: string }>;
declare global {
  interface Window { __assistantMock?: AssistantMock }
}

/** Local testing only: on localhost a `window.__assistantMock` answers instead of the model. */
function localMock(): AssistantMock | null {
  if (typeof window === 'undefined' || !window.__assistantMock) return null;
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? window.__assistantMock : null;
}

async function runMock(mock: AssistantMock, message: string, focus: AssistantFocus | null, signal: AbortSignal, onProgress: (stage: AssistantProgress) => void): Promise<AssistantReply> {
  const answer = await mock(message, focus);
  onProgress('working');
  await pause(answer.delayMs ?? 1500, signal);
  if (answer.error) throw new Error(answer.error);
  return { reply: answer.reply, proposals: (answer.proposals || []).slice(0, 3) };
}

export async function askAssistant(message: string, history: { role: string; content: string }[], signal: AbortSignal, onProgress: (stage: AssistantProgress) => void, settings: { pollMs?: number; requestMs?: number; deadlineMs?: number; fetcher?: typeof fetch; focus?: AssistantFocus | null } = {}): Promise<AssistantReply> {
  const mock = localMock();
  if (mock) return runMock(mock, message, settings.focus ?? null, signal, onProgress);
  const lifetime = new AbortController();
  let expired = false;
  const cancel = () => lifetime.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const deadline = setTimeout(() => { expired = true; lifetime.abort(); }, settings.deadlineMs ?? 315000);
  const request = (path: string, init: RequestInit = {}) => assistantJson(path, init, lifetime.signal, settings.requestMs ?? 12000, settings.fetcher);
  let job: AssistantJob | undefined;
  const body = JSON.stringify({ message, history, requestId: crypto.randomUUID(), ...(settings.focus ? { focus: settings.focus } : {}) });
  try {
    for (let attempt = 0; !job; attempt++) {
      try { job = await request('/kanban/assistant/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); }
      catch (error) { if (!(error instanceof AssistantConnectionError) || attempt >= 1 || lifetime.signal.aborted) throw error; onProgress('reconnecting'); }
    }
    let failures = 0;
    for (;;) {
      if (job.status === 'complete') return { reply: job.reply!, proposals: job.proposals! };
      if (job.status === 'failed' || job.status === 'cancelled') throw new Error(job.error || 'The assistant could not finish. Please try again.');
      onProgress(job.status);
      await pause(settings.pollMs ?? 1000, lifetime.signal);
      try { job = await request(`/kanban/assistant/jobs/${encodeURIComponent(job.id)}`); failures = 0; }
      catch (error) { if (!(error instanceof AssistantConnectionError) || ++failures > 2 || lifetime.signal.aborted) throw error; onProgress('reconnecting'); }
    }
  } catch (error) {
    if (job) {
      void assistantJson(`/kanban/assistant/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE', keepalive: true }, new AbortController().signal, 5000, settings.fetcher).catch(() => {});
    }
    if (expired) throw new Error('The assistant did not finish this request. Please try again shortly.');
    throw error;
  } finally { clearTimeout(deadline); signal.removeEventListener('abort', cancel); }
}

export function assistantHistory(messages: AssistantMessage[]): { role: string; content: string }[] {
  return messages.filter(m => !m.failed).slice(-6).map(({ role, content, proposals }) => ({ role, content: content + (proposals?.length ? `\nPrevious suggestions (check board for applied status): ${JSON.stringify(proposals.map(p => ({ type: p.type, title: p.title, cardId: p.cardId, items: p.items.slice(0, 8) })))}` : '') }));
}
