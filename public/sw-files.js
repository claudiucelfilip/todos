// Imported by the service worker: attachment files (/kanban/files/<id> and …/thumb) are
// cache-first, since ids never change content. Only complete 200 responses are stored, and
// the cache is trimmed oldest-first to about 100 MB. Registered before Workbox's own routes.
// Signing out (or a session that ended) deletes the cache from the page.
const FILES_CACHE = 'todos-files-v1';
// Set by the page (src/lib/file-cache.ts) when the session ends: no cache hits, nothing stored.
const FILES_STATE = 'todos-files-state';
const SIGNED_OUT = '/__todos-files-signed-out';

async function signedOut() {
  try {
    return !!(await (await caches.open(FILES_STATE)).match(SIGNED_OUT));
  } catch {
    return false;
  }
}
const FILES_MAX_BYTES = 100 * 1024 * 1024;
const FILES_PATH = /^\/kanban\/files\/[A-Za-z0-9_-]{8,64}(\/thumb)?$/;

async function trimFiles(cache) {
  const keys = await cache.keys();
  const sizes = await Promise.all(keys.map(async (k) => Number((await cache.match(k))?.headers.get('content-length')) || 0));
  let total = sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; i < keys.length && total > FILES_MAX_BYTES; i++) {
    await cache.delete(keys[i]);
    total -= sizes[i];
  }
}

async function cachedFile(request) {
  if (await signedOut()) return fetch(request, { cache: 'no-store' }); // the server decides (401 without a session)
  const cache = await caches.open(FILES_CACHE);
  const url = new URL(request.url);
  const active = await (await caches.open(FILES_STATE)).match('/__todos-files-account');
  const scope = active ? await active.json() : null;
  const matches = !scope?.account || (url.searchParams.get('account') === scope.account && url.searchParams.get('room') === scope.room);
  if (!matches) return fetch(request, { cache: 'no-store' });
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(request);
  // Checked again: the session may have ended while the file was on its way.
  if (res.status === 200 && res.type === 'basic' && !(await signedOut())) {
    await cache.put(request, res.clone());
    trimFiles(cache).catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !FILES_PATH.test(url.pathname)) return;
  event.respondWith(cachedFile(req));
});
