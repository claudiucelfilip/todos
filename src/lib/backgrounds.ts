import type { BoardSettings } from './types';

export const BACKGROUNDS = [
  { name: 'White', mode: 'light', gradient: 'linear-gradient(180deg,#fafbfc 0%,#e5e8ec 100%)',
    palette: { shade: '#25313e', light: '#ffffff', spark: '#c3cbd5' } },
  { name: 'Leaf', mode: 'light', gradient: 'linear-gradient(165deg,#7cb965 0%,#60983c 58%,#5d913b 100%)',
    palette: { shade: '#2e5535', light: '#b7dd91', spark: '#b1dd45' } },
  { name: 'Sky', mode: 'light', gradient: 'linear-gradient(165deg,#56bbed 0%,#2f9ad2 58%,#298ec6 100%)',
    palette: { shade: '#1d3e56', light: '#a9daed', spark: '#7ce2fe' } },
  { name: 'Peach', mode: 'light', gradient: 'linear-gradient(160deg,#f3ad79 0%,#e58e66 58%,#d97d60 100%)',
    palette: { shade: '#582d1d', light: '#ffd19a', spark: '#ffc15c' } },
  { name: 'Lilac', mode: 'light', gradient: 'linear-gradient(160deg,#c496e4 0%,#b182d6 58%,#a174ca 100%)',
    palette: { shade: '#47235f', light: '#deade3', spark: '#c2b5f5' } },
  { name: 'Sand', mode: 'light', gradient: 'linear-gradient(165deg,#e4c077 0%,#cda85f 58%,#bd9954 100%)',
    palette: { shade: '#3b352b', light: '#f4dfaa', spark: '#f1cb55' } },
  { name: 'Ocean', mode: 'dark', gradient: 'linear-gradient(180deg,#234b6a 0%,#0c2437 100%)',
    palette: { shade: '#071825', light: '#8ec8f6', spark: '#3db9df' } },
  { name: 'Plum', mode: 'dark', gradient: 'linear-gradient(160deg,#642d59 0%,#260e27 100%)',
    palette: { shade: '#210b22', light: '#deade3', spark: '#cf91d8' } },
  { name: 'Night', mode: 'dark', gradient: 'linear-gradient(180deg,#262f39 0%,#0c1118 100%)',
    palette: { shade: '#080e16', light: '#b9bbc6', spark: '#82a9cc' } },
] as const;
export type BackgroundName = typeof BACKGROUNDS[number]['name'];
export function resolveBackground(theme: string, background?: BoardSettings['background'], systemDark = false) {
  const name = background || (theme === 'sky' ? 'Sky' : theme === 'dark' || (theme === 'system' && systemDark) ? 'Night' : 'Leaf');
  return BACKGROUNDS.find((b) => b.name === name) ?? BACKGROUNDS.find((b) => b.name === 'Leaf')!;
}
