import { useEffect } from 'react';
import { applyStudioAppearance } from '../lib/appearance';
import type { BoardSettings } from '../lib/types';
import type { BackgroundName } from '../lib/backgrounds';

// Legacy callers retain their arguments while Studio preferences supply the material.

export function applyTheme(_theme: string, _background?: BackgroundName, settings: Pick<BoardSettings, 'studioTheme' | 'studioPattern'> = {}): void {
  applyStudioAppearance(settings);
}

export function applyReduceMotion(mode: string): void {
  document.documentElement.setAttribute('data-reduce-motion', mode);
}

export function useSystemThemeObserver(cb: (dark: boolean) => void): void {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme:dark)');
    const fn = (e: MediaQueryListEvent) => cb(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [cb]);
}
