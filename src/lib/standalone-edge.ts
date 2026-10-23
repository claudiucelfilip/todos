import { standaloneView } from './input';

/** Keep horizontal edge gestures inside the installed app while leaving vertical scroll alone. */
export function guardStandaloneEdges(): void {
  if (!standaloneView()) return;
  let start: { x: number; y: number } | null = null;
  document.addEventListener('touchstart', (event) => {
    const touch = event.touches[0];
    start = event.touches.length === 1 && touch &&
      (touch.clientX < 28 || touch.clientX > innerWidth - 28) &&
      event.target instanceof Element && event.target.closest('.app.phone')
      ? { x: touch.clientX, y: touch.clientY } : null;
  }, { capture: true, passive: true });
  document.addEventListener('touchmove', (event) => {
    const touch = event.touches[0];
    if (!start || event.touches.length !== 1 || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) && event.cancelable) event.preventDefault();
  }, { capture: true, passive: false });
  const clear = () => { start = null; };
  document.addEventListener('touchend', clear, { capture: true, passive: true });
  document.addEventListener('touchcancel', clear, { capture: true, passive: true });
}
