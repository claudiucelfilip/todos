import { useEffect, useRef, type RefObject } from 'react';

export function useOutsideDismiss(ref: RefObject<HTMLElement>, onClose: () => void, ownedPortal?: string): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!ref.current || ref.current.contains(target) || (ownedPortal && target.closest(ownedPortal))) return;
      close.current();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [ref, ownedPortal]);
}
