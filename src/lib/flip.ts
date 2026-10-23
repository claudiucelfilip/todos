// §11.2 / §11.10 — card motion on the board.
//
// Same-column reorders: a hand-rolled FLIP on the node itself (pure layout
// move; nothing is clipped). Cross-column moves: the columns clip their
// contents (overflow), so the card flies as a fixed-position clone in an
// unclipped layer from the old rect to the new one while the real node waits
// hidden in the destination; the clone lifts only subtly (scale 1.02,
// --shadow-hover) and settles to --shadow-rest on landing (user override of
// §11.2 "lifting to drag shadow", 2026-09-22). Reduced motion: no clone.
//
// Rects are measured during render (the DOM still shows the previous commit,
// including any in-flight transform, so retargeting stays continuous).

import { useLayoutEffect, useRef, type RefObject } from 'react';
import { isQuiet } from './seen';
import { instantMotion } from './presence';
import { SPRINGS, springCurve, springKeyframes } from './spring';

// The card articles only: `card-<id>-circle` also starts with "card-" and must not move on its own.
const SEL = 'article.card-face[data-card-id]:not(.drag-ghost):not(.move-clone)';
// Cards move on the "heavy" spring (mass 2, ~3 % overshoot): they feel like they have weight.
const MOVE_MS = springCurve(SPRINGS.heavy).ms;

/** Flip is enabled only after the board's first paint, so the initial load does not animate. */
export const flipState = { ready: false };

interface Prev {
  rect: DOMRect;
  col: string;
}

function colOf(el: HTMLElement): string {
  return el.closest<HTMLElement>('.column')?.dataset.status ?? '';
}

const flying = new Map<string, HTMLElement>(); // card testid -> clone in flight

/** Fly a clone of `node` from `from` to its current rect; the node stays hidden meanwhile. */
function flyClone(node: HTMLElement, from: DOMRect): void {
  const id = `${colOf(node)}:${node.dataset.testid ?? ''}`;
  // Land on-screen: scroll the destination column so the slot is visible (§11.2).
  const body = node.closest<HTMLElement>('.column-body');
  if (body) {
    const nr = node.getBoundingClientRect();
    const br = body.getBoundingClientRect();
    if (nr.top < br.top || nr.bottom > br.bottom)
      node.scrollIntoView({ block: 'nearest', behavior: 'instant' as ScrollBehavior });
  }
  const to = node.getBoundingClientRect();
  if (to.width === 0) return;

  // Retargeted mid-flight: start from where the flying clone is now, not the old destination slot.
  const prev = flying.get(id);
  if (prev) {
    from = prev.getBoundingClientRect();
    prev.remove();
  }
  const clone = node.cloneNode(true) as HTMLElement;
  clone.classList.remove(
    'open',
    'selected',
    'entering',
    'pulse',
    'flip-flying',
    'move-hidden',
    'exiting',
  );
  clone.classList.add('move-clone');
  clone.removeAttribute('data-testid');
  clone.removeAttribute('data-card-id');
  clone.removeAttribute('tabindex');
  clone.setAttribute('aria-hidden', 'true');
  clone.style.margin = '0';
  clone.style.width = '100%';
  clone.style.height = '100%';
  // A fixed wrapper carries the path (one continuous curve); the clone inside
  // carries the soft lift. Two properties on two nodes, so neither easing is
  // split into segments and the flight reads as a single motion.
  const wrap = document.createElement('div');
  wrap.className = 'move-wrap';
  wrap.style.position = 'fixed';
  wrap.style.left = `${from.left}px`;
  wrap.style.top = `${from.top}px`;
  // Use the destination layout throughout the flight so text never stretches.
  wrap.style.width = `${to.width}px`;
  wrap.style.height = `${to.height}px`;
  wrap.style.transformOrigin = 'top left';
  wrap.appendChild(clone);
  document.body.appendChild(wrap);
  flying.set(id, wrap);

  node.classList.add('move-hidden');
  let ended = false;
  const done = () => {
    if (ended) return;
    ended = true;
    wrap.remove();
    if (flying.get(id) === wrap) flying.delete(id);
    node.classList.remove('move-hidden');
  };
  const dx = to.left - from.left;
  const dy = to.top - from.top;
  // The path follows the spring (keyframes, so it works without CSS linear()).
  const { keyframes } = springKeyframes(SPRINGS.heavy, (p) => ({
    transform: `translate(${dx * p}px, ${dy * p}px)`,
  }));
  const path = wrap.animate(keyframes, { duration: MOVE_MS, easing: 'linear', fill: 'forwards' });
  clone.animate(
    [
      { transform: 'scale(1)' },
      { transform: 'scale(1.02)', offset: 0.35 },
      { transform: 'scale(1)' },
    ],
    { duration: MOVE_MS, easing: 'ease-in-out', fill: 'forwards' },
  );
  path.addEventListener('finish', done);
  setTimeout(done, MOVE_MS + 80);
}

/**
 * `key` changes whenever what the board shows changes (cards, column, query, drag slot). A re-render
 * without a new key (a font swap, a status line) only re-measures: nothing glides on its own.
 */
export function useFlip(root: RefObject<HTMLElement | null>, key?: unknown, enabled = true): void {
  const first = useRef<Map<string, Prev>>(new Map());
  const lastKey = useRef<unknown>(key);

  // Measure before commit (render phase): where every card is right now.
  if (enabled && root.current) {
    const m = new Map<string, Prev>();
    root.current.querySelectorAll<HTMLElement>(SEL).forEach((el) => {
      m.set(`${colOf(el)}:${el.dataset.testid!}`, { rect: el.getBoundingClientRect(), col: colOf(el) });
    });
    first.current = m;
  }

  useLayoutEffect(() => {
    if (!enabled) return;
    const el = root.current;
    if (!el) return;
    const ready = flipState.ready;
    flipState.ready = true;
    if (!ready) return;
    const same = key !== undefined && lastKey.current === key;
    lastKey.current = key;
    if (isQuiet() || instantMotion() || el.closest('[hidden], [inert]')) {
      for (const clone of flying.values()) clone.remove();
      flying.clear();
      el.querySelectorAll<HTMLElement>(SEL).forEach((node) => {
        node.getAnimations().forEach((a) => a.cancel());
        node.classList.remove('move-hidden', 'flip-flying');
        node.style.transform = '';
        node.style.transition = '';
      });
      return;
    }
    if (same) return;
    const old = first.current;
    const reduced = instantMotion();
    const moved: { node: HTMLElement; dx: number; dy: number }[] = [];
    const crossed: { node: HTMLElement; from: DOMRect }[] = [];
    el.querySelectorAll<HTMLElement>(SEL).forEach((node) => {
      const id = node.dataset.testid!;
      const prev = old.get(`${colOf(node)}:${id}`) ?? [...old.entries()].find(([key, value]) => key.endsWith(`:${id}`) && !el.querySelector(`.column[data-status="${value.col}"] article[data-testid="${id}"]`))?.[1];
      if (!prev || prev.rect.width === 0 || prev.rect.height === 0) return;
      if (colOf(node) !== prev.col) {
        // Cross-column: fly a clone (unless reduced motion); the node itself does not FLIP.
        if (!reduced) crossed.push({ node, from: prev.rect });
        return;
      }
      node.style.transition = 'none';
      node.style.transform = '';
      const now = node.getBoundingClientRect();
      if (now.width === 0) return;
      const dx = prev.rect.left - now.left;
      const dy = prev.rect.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        node.style.transition = '';
        return;
      }
      moved.push({ node, dx, dy });
    });

    for (const c of crossed) flyClone(c.node, c.from);

    if (moved.length === 0) return;
    // Beyond ~40 nodes skip the animation entirely (§11.10).
    if (moved.length > 40) {
      for (const m of moved) m.node.style.transition = '';
      return;
    }
    for (const m of moved) m.node.style.transform = `translate(${m.dx}px, ${m.dy}px)`;
    void el.offsetHeight; // reflow so the inverted position is the start value
    for (const m of moved) {
      const { node } = m;
      node.classList.add('flip-flying');
      node.style.transition = `transform ${MOVE_MS}ms var(--spring-heavy)`;
      node.style.transform = '';
      const done = (ev?: TransitionEvent) => {
        if (ev && ev.propertyName !== 'transform') return;
        node.style.transition = '';
        node.classList.remove('flip-flying');
        node.removeEventListener('transitionend', done);
      };
      node.addEventListener('transitionend', done);
      setTimeout(done, MOVE_MS + 50);
    }
  });
}

/**
 * FLIP for a plain list (checklist rows): elements matching `sel`, keyed by `data-flip-id`, glide to
 * their new place on the heavy spring when the list reorders. Reduced motion: they just move.
 */
export function useListFlip(
  root: RefObject<HTMLElement | null>,
  sel = '[data-flip-id]',
  key?: unknown,
  idAttribute = 'data-flip-id',
): void {
  const first = useRef<Map<string, { top: number; left: number }>>(new Map());
  const lastKey = useRef<unknown>(key);
  if (root.current) {
    const m = new Map<string, { top: number; left: number }>();
    root.current.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.height) m.set(el.getAttribute(idAttribute)!, { top: r.top, left: r.left });
    });
    first.current = m;
  }
  useLayoutEffect(() => {
    const el = root.current;
    // Rows glide only when the list itself changed (order, a drag slot), not when something above it grew.
    const same = key !== undefined && lastKey.current === key;
    lastKey.current = key;
    if (!el || instantMotion() || isQuiet() || same || el.closest('[hidden], [inert]')) return;
    const moved: { node: HTMLElement; dx: number; dy: number }[] = [];
    el.querySelectorAll<HTMLElement>(sel).forEach((node) => {
      const from = first.current.get(node.getAttribute(idAttribute)!);
      if (!from) return;
      node.style.transition = 'none';
      node.style.transform = '';
      const now = node.getBoundingClientRect();
      if (!now.height) return;
      const dx = from.left - now.left, dy = from.top - now.top;
      if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) moved.push({ node, dx, dy });
      else node.style.transition = '';
    });
    if (!moved.length || moved.length > 60) {
      for (const m of moved) m.node.style.transition = '';
      return;
    }
    for (const m of moved) m.node.style.transform = `translate(${m.dx}px, ${m.dy}px)`;
    void el.offsetHeight;
    for (const { node } of moved) {
      node.style.transition = `transform ${MOVE_MS}ms var(--spring-heavy)`;
      node.style.transform = '';
      const done = () => {
        node.style.transition = '';
        node.removeEventListener('transitionend', done);
      };
      node.addEventListener('transitionend', done);
      setTimeout(done, MOVE_MS + 50);
    }
  });
}
