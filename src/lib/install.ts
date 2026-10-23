// "Install for offline use" (§11.10 E): the browser's install prompt, caught once for the whole app,
// a visit count for the one-time card, and whether it was dismissed for good.
import { useEffect, useState } from 'react';

interface InstallEvent extends Event {
  prompt(): Promise<void>;
}

const DISMISSED_KEY = 'kept.installDismissed';
const VISITS_KEY = 'kept.visits';

function ls(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

export const isStandalone = (): boolean =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true);

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    if (isStandalone()) return;
    deferred = e as InstallEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    ls()?.setItem(DISMISSED_KEY, '1');
    notify();
  });
  // One visit per page load; the card waits for the second.
  const n = Number(ls()?.getItem(VISITS_KEY) ?? 0) + 1;
  ls()?.setItem(VISITS_KEY, String(n));
}

export const visits = (): number => Number(ls()?.getItem(VISITS_KEY) ?? 0);
export const installDismissed = (): boolean => ls()?.getItem(DISMISSED_KEY) === '1';
export function dismissInstall(): void {
  ls()?.setItem(DISMISSED_KEY, '1');
  notify();
}
export async function promptInstall(): Promise<void> {
  const e = deferred;
  if (!e) return;
  deferred = null;
  dismissInstall();
  await e.prompt();
}

/** Re-renders when the prompt arrives, is used, or the card is dismissed. */
export function useInstall(): { available: boolean; dismissed: boolean } {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return { available: !!deferred, dismissed: installDismissed() };
}
