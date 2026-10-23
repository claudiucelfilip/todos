import { useEffect, useState } from 'react';

const EXIT_MS = 150;

export function useDropdownPresence(open: boolean) {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    const root = document.documentElement;
    const instant = root.dataset.motionInput === 'keyboard' || root.dataset.reduceMotion === 'on' ||
      (root.dataset.reduceMotion !== 'off' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (instant) {
      setMounted(false);
      return;
    }
    const timeout = window.setTimeout(() => setMounted(false), EXIT_MS);
    return () => window.clearTimeout(timeout);
  }, [open, mounted]);

  return { mounted, closing: mounted && !open };
}
