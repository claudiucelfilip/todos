import { contrastRatio } from './labels';
import { studioPatterns, resolveStudioTheme } from '../../shared/appearance.mjs';
import { currentAccount } from './account';
import type { BoardSettings } from './types';

const cacheKey = () => `todos:appearance:v1:${currentAccount()?.user || 'local'}`;
export const tone = (hex: string) => {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > .179 ? 'light' : 'dark';
};

export function surfaceInk(hex: string): string {
  const base = tone(hex) === 'dark' ? 255 : 0;
  return [1, 3, 5].map(i => Math.round(base * .88 + parseInt(hex.slice(i, i + 2), 16) * .12)).join(' ');
}

function mixColor(a: string, b: string, weight: number): string {
  return '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * weight + parseInt(b.slice(i, i + 2), 16) * (1 - weight)).toString(16).padStart(2, '0')).join('');
}

export function completionAccent(accent: string, surface: string, minimum = 3.2): string {
  const ink = tone(surface) === 'dark' ? '#ffffff' : '#000000';
  for (let percent = 100; percent >= 0; percent -= 5) {
    const color = mixColor(accent, ink, percent / 100);
    if (contrastRatio(color, surface) >= minimum) return color;
  }
  return ink;
}

export function themeCompletionAccents(theme: { accent: string; editor: string; card: string; canvas: string }) {
  return {
    board: completionAccent(theme.accent, mixColor(theme.card, theme.canvas, .448)),
    editor: completionAccent(theme.accent, theme.editor, 4.5),
  };
}

export function applyStudioAppearance(settings: Pick<BoardSettings, 'studioTheme' | 'studioPattern'> = {}) {
  let cached: { theme?: string; pattern?: string } = {};
  try {
    const value = JSON.parse(localStorage.getItem(cacheKey()) || localStorage.getItem('todos:studio-appearance:v1') || '{}');
    if (value && typeof value === 'object') cached = value;
  } catch { /* First launch or unavailable storage. */ }
  const preferences = currentAccount()?.preferences;
  const theme = resolveStudioTheme(settings.studioTheme || preferences?.studioTheme || cached.theme);
  const pattern = studioPatterns.find(p => p.id === (settings.studioPattern || preferences?.studioPattern || cached.pattern)) || studioPatterns[0];
  const root = document.documentElement;
  const attributes = { studio: 'ruled', editor: 'side', capture: 'full', 'board-scroll': 'columns', 'studio-picker': 'true', material: theme.id, pattern: pattern.id, 'studio-tone': tone(theme.canvas), 'editor-tone': tone(theme.editor), 'header-tone': tone(theme.header), theme: `tint-${tone(theme.canvas)}` };
  for (const [name, value] of Object.entries(attributes)) root.setAttribute(`data-${name}`, value);
  const neutral = surfaceInk(theme.canvas);
  const editorNeutral = surfaceInk(theme.editor);
  const headerNeutral = surfaceInk(theme.header);
  const completion = themeCompletionAccents(theme);
  const tokens = {
    '--studio-accent': theme.accent, '--studio-blue': theme.header,
    '--editor-material': theme.editor,
    '--completion-accent': completion.board,
    '--editor-completion-accent': completion.editor,
    '--variant-canvas': theme.canvas, '--preview-card': theme.card,
    '--variant-ink': `rgb(${neutral} / 80%)`, '--variant-muted': `rgb(${neutral} / 70%)`,
    '--variant-link': tone(theme.canvas) === 'dark' ? `color-mix(in srgb,${theme.header} 35%,white)` : `color-mix(in srgb,${theme.header} 60%,black)`,
    '--studio-neutral': neutral, '--editor-neutral': editorNeutral, '--header-neutral': headerNeutral,
    '--editor-ink': `rgb(${editorNeutral} / 80%)`, '--editor-muted': `rgb(${editorNeutral} / 70%)`,
    '--studio-pattern-mask': pattern.mask, '--studio-pattern-size': pattern.size,
    '--page': theme.canvas, '--theme-color': theme.header,
    '--theme-shade': theme.canvas, '--theme-light': theme.card, '--theme-spark': theme.accent,
  };
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
  root.style.colorScheme = tone(theme.canvas);
  root.style.background = root.dataset.iosStandalone !== undefined ? theme.header : theme.canvas;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme.header);
  try {
    localStorage.setItem(cacheKey(), JSON.stringify({ theme: theme.id, pattern: pattern.id }));
    localStorage.setItem('todos.studio.paint', JSON.stringify({ canvas: theme.canvas, header: theme.header }));
  } catch { /* Appearance remains usable without a local cache. */ }
}
