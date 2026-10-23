// Spring-driven WAAPI helpers: animate a node along a spring, and let a node that React
// is about to unmount leave with an exit spring (a detached, inert clone takes its place).
import { SPRINGS, springKeyframes, type SpringSpec } from './spring';
import { isQuiet } from './seen';
import { instantMotion } from './presence';

/** Run `frame(progress)` along the spring on `el`; resolves when it settles. */
export function springAnimate(
  el: Element,
  spec: SpringSpec,
  frame: (p: number) => Keyframe,
): Animation {
  const { keyframes, ms } = springKeyframes(spec, frame);
  const instant = instantMotion() || isQuiet();
  return el.animate(instant ? [frame(1)] : keyframes, { duration: instant ? 0 : ms, easing: 'linear', fill: 'forwards' });
}

/**
 * An inert copy of `el` left in place (same parent, after it) for an exit animation.
 * No test ids, ids or focusable controls; the caller animates it and it removes itself.
 */
export function cloneForExit(el: HTMLElement | null, ttlMs: number): HTMLElement | null {
  if (!el || !el.isConnected || !el.parentNode || instantMotion() || isQuiet()) return null;
  const clone = el.cloneNode(true) as HTMLElement;
  for (const n of [clone, ...Array.from(clone.querySelectorAll<HTMLElement>('*'))]) {
    n.removeAttribute('data-testid');
    n.removeAttribute('id');
    if (n.hasAttribute('tabindex') || /^(A|BUTTON|INPUT|TEXTAREA|SELECT)$/.test(n.tagName))
      n.setAttribute('tabindex', '-1');
  }
  clone.setAttribute('aria-hidden', 'true');
  clone.setAttribute('inert', '');
  clone.style.pointerEvents = 'none';
  clone.style.animation = 'none';
  clone.classList.add('exit-clone');
  el.parentNode.insertBefore(clone, el.nextSibling);
  setTimeout(() => clone.remove(), ttlMs + 120);
  return clone;
}

/** Close the layout gap immediately; an inert copy and neighbours move with transforms. */
export function collapseThen(
  el: HTMLElement | null,
  done: () => void,
  delayMs = 0,
  spec: SpringSpec = SPRINGS.release,
): void {
  if (!el || !el.isConnected || instantMotion() || isQuiet()) {
    done();
    return;
  }
  const start = () => {
    if (!el.isConnected || instantMotion() || isQuiet()) {
      done();
      return;
    }
    const rect = el.getBoundingClientRect();
    const siblings = siblingPositions(el);
    const { ms } = springKeyframes(spec, () => ({}));
    const clone = cloneForExit(el, ms);
    if (clone) {
      Object.assign(clone.style, {
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        margin: '0',
        transformOrigin: 'top',
        zIndex: '260',
      });
      springAnimate(clone, spec, (p) => ({
        transform: `translateY(${-8 * p}px)`,
        opacity: String(Math.max(0, 1 - p)),
      }));
    }
    const display = el.style.display;
    el.style.display = 'none';
    moveSiblings(siblings, spec);
    // A cancellation from an interrupted disclosure must restore its live node.
    const marker = springAnimate(el, spec, (p) => ({ opacity: String(1 - p) }));
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      clone?.remove();
      done();
    };
    marker.onfinish = finish;
    marker.oncancel = () => {
      ended = true;
      clone?.remove();
      el.style.display = display;
    };
    setTimeout(finish, ms + 150);
  };
  if (delayMs) setTimeout(start, delayMs);
  else start();
}

function siblingPositions(el: HTMLElement): Map<HTMLElement, DOMRect> {
  const siblings = new Map<HTMLElement, DOMRect>();
  for (const node of Array.from(el.parentElement?.children ?? [])) {
    if (node instanceof HTMLElement && node !== el && !node.classList.contains('exit-clone'))
      siblings.set(node, node.getBoundingClientRect());
  }
  return siblings;
}

function moveSiblings(before: Map<HTMLElement, DOMRect>, spec: SpringSpec): void {
  if (instantMotion() || isQuiet()) return;
  for (const [node, rect] of before) {
    const after = node.getBoundingClientRect();
    const dx = rect.left - after.left,
      dy = rect.top - after.top;
    if (!dx && !dy) continue;
    node.getAnimations().forEach((a) => a.cancel());
    const { keyframes, ms } = springKeyframes(spec, (p) => ({
      transform: `translate(${dx * (1 - p)}px, ${dy * (1 - p)}px)`,
    }));
    node.animate(keyframes, { duration: ms, easing: 'linear' });
  }
}

/** Reveal in its final layout, then animate the rows and following siblings. */
export function expandFrom(el: HTMLElement | null, spec: SpringSpec = SPRINGS.gentle): void {
  if (!el || !el.isConnected || instantMotion() || isQuiet()) return;
  const display = el.style.display;
  el.style.display = 'none';
  const before = siblingPositions(el);
  el.style.display = display;
  moveSiblings(before, spec);
  const { keyframes, ms } = springKeyframes(spec, (p) => ({
    transform: `translateY(${-8 * (1 - p)}px)`,
    opacity: String(Math.min(1, p)),
  }));
  el.animate(keyframes, { duration: ms, easing: 'linear' });
}
