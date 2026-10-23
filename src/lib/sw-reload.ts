// Stale app after a deploy: the service worker serves the previous bundle for one load.
// When a new worker takes control (skipWaiting + clientsClaim), reload once, but never in
// front of the user: only while the app is in the background (or in the first seconds after
// launch, before anything is open), and never over unsent input. A reload closes the open
// card, popovers and scroll position, which reads as the board flashing.

const FLAG = 'kept.swReloadAt';
const LOOP_GUARD_MS = 60000;
const DRAFTS = '.composer-input, #assistant-input, .dt-add-input, .label-new-name, .login-input, .remind-input';

export interface ReloadEnv {
  hadController: boolean; // false = first install, nothing stale to replace
  lastReloadAgoMs: number | null;
  fieldFocused: boolean;
  unsentInput: boolean;
  hidden: boolean;
  busy: boolean; // a card, popover, menu or dialog open, or a drag
  sinceLoadMs: number;
}

const LAUNCH_MS = 4000;

export function reloadDecision(e: ReloadEnv): 'ignore' | 'wait' | 'reload' {
  if (!e.hadController) return 'ignore';
  if (e.lastReloadAgoMs !== null && e.lastReloadAgoMs < LOOP_GUARD_MS) return 'ignore';
  if (e.unsentInput || e.busy) return 'wait';
  if (e.hidden) return 'reload';
  if (e.sinceLoadMs < LAUNCH_MS && !e.busy && !e.fieldFocused) return 'reload';
  return 'wait';
}

function env(hadController: boolean): ReloadEnv {
  let last: number | null = null;
  try {
    const v = Number(sessionStorage.getItem(FLAG));
    if (v) last = Date.now() - v;
  } catch {
    /* storage blocked */
  }
  const a = document.activeElement as HTMLElement | null;
  const fieldFocused = !!a && (a.matches('input:not([type=checkbox]):not([type=radio]), textarea, select') || a.isContentEditable);
  const unsentInput = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(DRAFTS)).some((el) => el.value.trim() !== '');
  const busy = !!document.querySelector('.dt-panel, .dt-sheet, .assistant-panel, .label-pop, .dt-menu, .dialog-backdrop, .lightbox, .shortcut-backdrop') || document.body.classList.contains('dragging');
  return { hadController, lastReloadAgoMs: last, fieldFocused, unsentInput, hidden: document.visibilityState === 'hidden', busy, sinceLoadMs: performance.now() };
}

export function installSwReload(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  let hadController = !!sw.controller;
  let waiting = false;

  const attempt = () => {
    const d = reloadDecision(env(hadController));
    if (d === 'reload') {
      try {
        sessionStorage.setItem(FLAG, String(Date.now()));
      } catch {
        /* storage blocked: the 60 s guard is skipped, still one reload per takeover */
      }
      location.reload();
      return;
    }
    if (d === 'wait' && !waiting) {
      waiting = true;
      // Try again when the app goes to the background (or a field blurs, for unsent input);
      // a slow poll covers a missed event.
      let poll: ReturnType<typeof setInterval> | null = null;
      const retry = () => {
        setTimeout(() => {
          waiting = false;
          document.removeEventListener('focusout', retry, true);
          document.removeEventListener('visibilitychange', retry);
          if (poll) clearInterval(poll);
          attempt();
        }, 0);
      };
      document.addEventListener('focusout', retry, true);
      document.addEventListener('visibilitychange', retry);
      poll = setInterval(() => {
        if (reloadDecision(env(hadController)) !== 'wait') retry();
      }, 2000);
    }
  };

  sw.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true; // first install took control: this page is already current
      return;
    }
    attempt();
  });

  // A phone that was backgrounded asks for a new worker when it comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    void sw.getRegistration().then((r) => r?.update()).catch(() => {});
  });
}
