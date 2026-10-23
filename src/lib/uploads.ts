import { scopedUrl } from './account';
// Attachment uploads: every file goes through a persistent queue (IndexedDB "uploads"), so
// one added offline or on a flaky connection shows as pending and uploads on reconnect.
// Each file carries a client id (X-File-Id), so a retry never makes a second copy on the
// server. Only once the file is stored does the card get the attachment (a synced att.put).
import type { Attachment } from './types';
import { actions, state } from '../hooks/useStore';
import { apiBase, getToken } from './sync';
import { deleteUpload, loadUploads, saveUpload, uid, type UploadRow } from './db';

export interface UploadView {
  id: string;
  cardId: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
  state: 'queued' | 'uploading' | 'failed';
  progress: number; // 0..1
  error?: string;
  previewUrl?: string; // an object URL for a pending image
}

export interface TransportRequest {
  url: string;
  body: Blob;
  headers: Record<string, string>;
  onProgress?(fraction: number): void;
}
export type Transport = (req: TransportRequest) => Promise<{ status: number; body: unknown }>;

/** XHR, for upload progress; status 0 = the network failed. */
const xhrTransport: Transport = (req) =>
  new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open('POST', req.url);
    x.withCredentials = true;
    for (const [k, v] of Object.entries(req.headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => {
      if (e.lengthComputable) req.onProgress?.(e.loaded / e.total);
    };
    x.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(x.responseText);
      } catch {
        /* not JSON */
      }
      resolve({ status: x.status, body });
    };
    x.onerror = () => resolve({ status: 0, body: null });
    x.ontimeout = () => resolve({ status: 0, body: null });
    x.send(req.body);
  });

let transport: Transport = xhrTransport;
/** Tests swap the network out. */
export function setUploadTransport(t: Transport): void {
  transport = t;
}

const views = new Map<string, UploadView>();
const rows = new Map<string, UploadRow>();
const listeners = new Set<() => void>();
let running: Promise<void> | null = null;
let again = false;
let started = false;
let lastStamp = 0;

function emit(): void {
  for (const fn of listeners) fn();
}

function viewOf(r: UploadRow, st: UploadView['state'] = r.error ? 'failed' : 'queued'): UploadView {
  const prior = views.get(r.id);
  let previewUrl = prior?.previewUrl;
  if (!previewUrl && r.type.startsWith('image/') && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try {
      previewUrl = URL.createObjectURL(new Blob([r.thumb ?? r.bytes], { type: r.thumb ? r.thumbType : r.type }));
    } catch {
      /* no preview */
    }
  }
  return { id: r.id, cardId: r.cardId, name: r.name, type: r.type, size: r.size, createdAt: r.createdAt, state: st, progress: prior?.progress ?? 0, error: r.error, previewUrl };
}

function setView(id: string, patch: Partial<UploadView>): void {
  const v = views.get(id);
  if (!v) return;
  views.set(id, { ...v, ...patch });
  emit();
}

async function drop(id: string): Promise<void> {
  const v = views.get(id);
  if (v?.previewUrl) URL.revokeObjectURL?.(v.previewUrl);
  views.delete(id);
  rows.delete(id);
  emit();
  await deleteUpload(id).catch(() => {});
}

/** A ≤ 400 px JPEG preview and the image size, when the browser can decode it (else nothing). */
async function makeThumb(blob: Blob): Promise<{ thumb?: Blob; width?: number; height?: number }> {
  if (!blob.type.startsWith('image/') || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return {};
  try {
    const bmp = await createImageBitmap(blob);
    const { width, height } = bmp;
    const k = Math.min(1, 400 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * k));
    canvas.height = Math.max(1, Math.round(height * k));
    canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const thumb = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
    return { thumb: thumb ?? undefined, width, height };
  } catch {
    return {};
  }
}

const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

function headers(type: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': type || 'application/octet-stream' };
  const t = getToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

/** Upload one queued file; on success the card gets the attachment and the row leaves the queue. */
async function send(r: UploadRow): Promise<void> {
  if (!state.board.cards.some((c) => c.id === r.cardId)) return drop(r.id); // the card was deleted meanwhile
  setView(r.id, { state: 'uploading', progress: 0, error: undefined });
  const res = await transport({
    url: scopedUrl(`${apiBase()}/kanban/files`),
    body: new Blob([r.bytes], { type: r.type }),
    headers: { ...headers(r.type), 'X-Filename': encodeURIComponent(r.name), 'X-Filename-Encoding': 'percent', 'X-File-Id': r.id },
    onProgress: (f) => setView(r.id, { progress: Math.min(0.99, f) }),
  });
  if (res.status !== 200) {
    const err = res.status === 413 ? 'file_too_large' : res.status === 401 ? 'unauthorized' : res.status === 0 ? 'offline' : `server_${res.status}`;
    // Too large never succeeds on a retry: keep it until the user removes it.
    if (err === 'file_too_large') {
      r.error = err;
      await saveUpload(r).catch(() => {});
    }
    setView(r.id, { state: 'failed', error: err, progress: 0 });
    return;
  }
  const meta = res.body as { name?: string; type?: string; size?: number };
  let thumb = false;
  if (r.thumb) {
    const t = await transport({ url: scopedUrl(`${apiBase()}/kanban/files/${r.id}/thumb`), body: new Blob([r.thumb], { type: r.thumbType }), headers: headers(r.thumbType ?? 'image/jpeg') });
    thumb = t.status === 200;
  }
  const att: Attachment = { id: r.id, name: meta.name ?? r.name, type: meta.type ?? r.type, size: meta.size ?? r.size, createdAt: r.createdAt };
  if (r.width && r.height) Object.assign(att, { width: r.width, height: r.height });
  if (thumb) att.thumb = true;
  actions.addAttachment(r.cardId, att);
  await drop(r.id);
}

async function runQueue(manual: Set<string> | null): Promise<void> {
  for (const r of [...rows.values()]) {
    if (!online()) break;
    if (r.error && !manual?.has(r.id)) continue; // final failures wait for a manual retry
    if (views.get(r.id)?.state === 'failed' && !manual?.has(r.id) && manual !== null) continue;
    await send(r);
  }
}

function process(manual: Set<string> | null = null): Promise<void> {
  if (running) {
    again = true;
    return running.then(() => (again ? process(manual) : undefined));
  }
  again = false;
  running = runQueue(manual).finally(() => {
    running = null;
  });
  return running;
}

export const uploads = {
  /** Load the persisted queue and upload what waits; retries whenever the device comes back online. */
  async init(): Promise<void> {
    if (started) return;
    started = true;
    for (const r of await loadUploads().catch(() => [] as UploadRow[])) {
      rows.set(r.id, r);
      views.set(r.id, viewOf(r));
    }
    emit();
    if (typeof window !== 'undefined') window.addEventListener('online', () => void process());
    void process();
  },

  /** Queue a file for a card and try it at once; resolves with its state after that first try. */
  async add(cardId: string, blob: Blob, name?: string): Promise<UploadView> {
    const file = blob as Blob & { name?: string };
    // Stamped first and strictly increasing, so files dropped together keep the order they were added in.
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    const createdAt = new Date(lastStamp).toISOString();
    const extra = await makeThumb(blob);
    const r: UploadRow = {
      id: uid(),
      cardId,
      name: (name ?? file.name ?? 'file').trim() || 'file',
      type: blob.type || 'application/octet-stream',
      size: blob.size,
      createdAt,
      bytes: await blob.arrayBuffer(),
    };
    if (extra.width && extra.height) Object.assign(r, { width: extra.width, height: extra.height });
    if (extra.thumb) Object.assign(r, { thumb: await extra.thumb.arrayBuffer(), thumbType: extra.thumb.type });
    rows.set(r.id, r);
    views.set(r.id, viewOf(r));
    emit();
    await saveUpload(r).catch(() => {});
    if (online()) await process(new Set([r.id]));
    return views.get(r.id) ?? { ...viewOf(r), state: 'queued', progress: 1 };
  },

  retry(id: string): Promise<void> {
    const r = rows.get(id);
    if (!r) return Promise.resolve();
    delete r.error;
    setView(id, { state: 'queued', error: undefined });
    void saveUpload(r).catch(() => {});
    return process(new Set([id]));
  },

  cancel(id: string): void {
    void drop(id);
  },

  /** Forget every queued upload (a view link): none of them is ever sent. */
  async clear(): Promise<void> {
    await Promise.all([...rows.keys()].map((id) => drop(id)));
  },

  list(cardId?: string): UploadView[] {
    return [...views.values()].filter((v) => !cardId || v.cardId === cardId);
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** Resolves once nothing is uploading (tests, window.kanban). */
  async idle(): Promise<void> {
    while (running) await running;
  },
};
