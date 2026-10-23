import { useEffect } from 'react';

// iOS moves the visual viewport when the keyboard opens. Publish its frame
// for editor scrolling and its keyboard inset for anchored controls.
export function useKeyboardInset(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let raf = 0;
    let observed: Element | null = null;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // iOS shrinks innerHeight while panning; the layout viewport stays stable.
        const kb = Math.max(0, Math.round(Math.max(window.innerHeight, document.documentElement.clientHeight) - vv.height));
        document.documentElement.style.setProperty('--kb', `${kb}px`);
        document.documentElement.style.setProperty('--visual-height', `${Math.round(vv.height)}px`);
        document.documentElement.style.setProperty('--visual-top', `${Math.round(vv.offsetTop)}px`);
        document.documentElement.classList.toggle('kb-open', kb > 80);
        // Focus can arrive before the keyboard finishes resizing the viewport.
        const focused = document.activeElement;
        const scroller = focused instanceof HTMLElement ? focused.closest<HTMLElement>('.dt-scroll') : null;
        const content = scroller?.querySelector('.dt-content') ?? null;
        if (content !== observed) {
          resize.disconnect();
          if (content) resize.observe(content);
          observed = content;
        }
        if (kb > 80 && focused instanceof HTMLElement && focused.matches('input, textarea')) {
          // Transformed entry bounds must not trigger a second scroll movement.
          const entering = scroller?.closest('.dt-sheet, .dt-panel')?.getAnimations().some(a => a.playState !== 'finished');
          if (scroller && !entering) {
            const field = focused.getBoundingClientRect();
            const frame = scroller.getBoundingClientRect();
            const gap = parseFloat(getComputedStyle(scroller).getPropertyValue('--keyboard-focus-gap')) || 24;
            const bottom = frame.top + Math.min(frame.height, vv.height) - gap;
            if (field.height <= bottom - frame.top && field.bottom > bottom) {
              scroller.scrollTop += Math.ceil(field.bottom - bottom);
            }
          }
        }
      });
    };
    const onEditorAnimationEnd = (event: AnimationEvent) => {
      if (event.target instanceof Element && event.target.matches('.dt-sheet, .dt-panel')) update();
    };
    const resize = new ResizeObserver(update);
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    document.addEventListener('focusin', update);
    document.addEventListener('animationend', onEditorAnimationEnd);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('animationend', onEditorAnimationEnd);
      resize.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);
}
