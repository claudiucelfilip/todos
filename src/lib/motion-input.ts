import { reducedMotion } from './presence';

function finishMotion(): void {
  for (const animation of document.getAnimations()) {
    const end = animation.effect?.getComputedTiming().endTime;
    if (typeof end === 'number' && Number.isFinite(end)) animation.finish();
    else animation.cancel();
  }
}

/** Keep keyboard commands immediate, including their async React commits. */
export function installMotionInput(): void {
  const root = document.documentElement;
  document.addEventListener('keydown', (event) => {
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    if (root.dataset.motionInput !== 'keyboard') finishMotion();
    root.dataset.motionInput = 'keyboard';
  }, true);
  document.addEventListener('pointerdown', () => {
    root.dataset.motionInput = 'pointer';
  }, true);
  const update = () => { if (reducedMotion()) finishMotion(); };
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', update);
  new MutationObserver(update).observe(root, { attributes: true, attributeFilter: ['data-reduce-motion'] });
}
