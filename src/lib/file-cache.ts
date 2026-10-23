import { currentAccount, currentRoom } from './account';
// The service worker's attachment cache (public/sw-files.js) and the "signed out" marker it
// honours. Both live in Cache Storage, which the page and the worker share, so the marker holds
// even after the worker restarts. Losing the session drops cached files and sets the marker.
export const FILES_CACHE = 'todos-files-v1';
export const FILES_STATE = 'todos-files-state';
export const SIGNED_OUT = '/__todos-files-signed-out';

const has = () => typeof caches !== 'undefined';

/** Signed out or the session ended: mark first (the worker stops serving and storing), then drop the files. */
export async function revokeFiles(): Promise<void> {
  if (!has()) return;
  try {
    await (await caches.open(FILES_STATE)).put(SIGNED_OUT, new Response('1'));
    await caches.delete(FILES_CACHE);
  } catch {
    /* storage blocked */
  }
}

/** A working session again: the worker may cache files. */
export async function allowFiles(): Promise<void> {
  if (!has()) return;
  try {
    const cache = await caches.open(FILES_STATE);
    await cache.delete(SIGNED_OUT);
    const account = currentAccount();
    await cache.put('/__todos-files-account', new Response(JSON.stringify({ account: account?.user || '', room: currentRoom()?.id || '' })));
  } catch {
    /* storage blocked */
  }
}
