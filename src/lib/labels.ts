import { isCardDone } from '../../shared/notes.mjs';
import { cleanBehavior } from '../../shared/automations.mjs';
import { WORKFLOW_LABELS, migrateWorkflow, isWorkflowLabel, finishedStage } from '../../shared/workflow.mjs';
// Board labels: the built-in Sherlock label, the preset palette and the pure
// helpers the store, the API and the UI share.
import { REMIND_EVERY } from '../../shared/repeat.mjs';
import type { Card, CardLink, Label } from './types';

export const LABEL_NAME_MAX = 40;
export const SHERLOCK: Label = { id: 'sherlock', name: 'Sherlock', color: '#7C5CFF' };
export const LABEL_PALETTE = [
  '#7C5CFF',
  '#2E9E6B',
  '#2F80ED',
  '#E5484D',
  '#F5A524',
  '#E2699A',
  '#12A6B8',
  '#8B6B4A',
  '#6B7480',
  '#C2410C',
  '#B5E35B',
];
export const MAX_FACE_LABELS = 3;

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v);
}

export function cleanLabelName(name: string): string {
  return String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LABEL_NAME_MAX);
}

/** Drop malformed rows and make sure the built-in label exists (seeded unstamped). */
export function withBuiltins(labels: ReadonlyArray<Label> | undefined): Label[] {
  const out = (labels ?? []).filter(
    (l) =>
      l && typeof l.id === 'string' && l.id && typeof l.name === 'string' && isHexColor(l.color),
  ).map((l) => {
    const workflow = WORKFLOW_LABELS.find((w) => w.id === l.id);
    return { ...l, ...cleanBehavior(l), ...(workflow ? { color: workflow.color } : {}) };
  });
  if (!out.some((l) => l.id === SHERLOCK.id)) out.unshift({ ...SHERLOCK });
  for (const label of WORKFLOW_LABELS) if (!out.some((l) => l.id === label.id)) out.push({ ...label });
  return out;
}

/** Old rows have no labels array; links must be well-formed. */
export function normalizeCard(c: Card, registry?: Label[]): Card {
  const labels = Array.isArray(c.labels) ? c.labels.filter((x) => typeof x === 'string') : [];
  const next: Card = {
    ...c,
    labels,
    remindAt: c.remindAt ?? null,
    remindedAt: c.remindedAt ?? null,
  };
  if (next.remindEvery && !REMIND_EVERY.includes(next.remindEvery)) next.remindEvery = null; // an unknown repeat is a one-off
  if (Array.isArray(c.links))
    next.links = c.links
      .filter((l) => l && isHttpUrl(l.url))
      .map((l) => ({ title: String(l.title ?? ''), url: l.url }));
  else delete next.links;
  if (!c.ext || typeof c.ext.key !== 'string') delete next.ext;
  if (!Array.isArray(c.attachments) || !c.attachments.length) delete next.attachments;
  return next.workflowVersion === 1 ? migrateWorkflow(next, registry) : next;
}

/** An id or a case-insensitive name. */
export function findLabel(labels: ReadonlyArray<Label>, idOrName: string): Label | undefined {
  const q = cleanLabelName(idOrName).toLowerCase();
  return labels.find((l) => l.id === idOrName) ?? labels.find((l) => l.name.toLowerCase() === q);
}

/** Label ids on a card that still exist, in the card's order. */
export function cardLabels(card: Card, labels: ReadonlyArray<Label>): Label[] {
  const byId = new Map(labels.map((l) => [l.id, l]));
  return (card.labels ?? []).map((id) => byId.get(id)).filter((l): l is Label => !!l).sort((a, b) => Number(isWorkflowLabel(b.id)) - Number(isWorkflowLabel(a.id)));
}

/** Label filter (§ labels): a card passes when it has at least one selected label. */
/** The Labels menu's "Inbox" row (§11.11): cards with no label. */
export const INBOX_FILTER = 'inbox';
export const NOTES_NONE_FILTER = 'notes:none';

export function passesNotesFilter(card: Card, filter: ReadonlyArray<string>, labels: ReadonlyArray<Label>): boolean {
  const showFinished = labels.some(label => finishedStage(label) && filter.includes(label.id));
  return (!isCardDone(card) || showFinished) && passesLabelFilter(card, filter);
}

export function passesLabelFilter(card: Card, filter: ReadonlyArray<string>): boolean {
  if (!filter.length) return true;
  const own = card.labels ?? [];
  if (!own.length) return filter.includes(INBOX_FILTER);
  return own.some((id) => filter.includes(id));
}

export function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** A link's display text: its title, else the hostname. */
export function linkText(link: CardLink): string {
  if (link.title.trim()) return link.title.trim();
  try {
    return new URL(link.url).hostname.replace(/^www\./, '');
  } catch {
    return link.url;
  }
}

/** Roving focus in a radio group: the next index for an arrow/Home/End key, else null. */
export function rovingIndex(current: number, key: string, count: number): number | null {
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/** The one tabbable swatch: the checked preset, else the custom swatch (index = palette length). */
export function swatchTabIndex(value: string): number {
  const i = LABEL_PALETTE.findIndex((c) => c.toLowerCase() === value.toLowerCase());
  return i < 0 ? LABEL_PALETTE.length : i;
}

// Pill colors per theme, derived from the label color so text stays >= 4.5:1 for any custom hex.
// Surfaces and inks mirror --surface / --ink in index.css.
const THEME = {
  light: { surface: '#F4FAEC', ink: '#0E1A08' },
  dark: { surface: '#1A2027', ink: '#F2F4F6' },
} as const;

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(c: number[]): string {
  return (
    '#' +
    c
      .map((v) => Math.round(v).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

function mix(a: string, b: string, t: number): string {
  const x = rgb(a),
    y = rgb(b);
  return toHex(x.map((v, i) => v * t + y[i] * (1 - t)));
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const pillCache = new Map<string, Record<'light' | 'dark', { bg: string; fg: string }>>();

/** Tinted background + text for both themes; the text moves toward the theme ink until it reads. */
export function pillColors(hex: string): Record<'light' | 'dark', { bg: string; fg: string }> {
  const hit = pillCache.get(hex);
  if (hit) return hit;
  const color = isHexColor(hex) ? hex : SHERLOCK.color;
  const out = {} as Record<'light' | 'dark', { bg: string; fg: string }>;
  for (const t of ['light', 'dark'] as const) {
    const { surface, ink } = THEME[t];
    const bg = mix(color, surface, 0.16);
    let k = 0.62;
    let fg = mix(color, ink, k);
    while (contrastRatio(fg, bg) < 4.6 && k > 0) {
      k = Math.max(0, k - 0.08);
      fg = mix(color, ink, k);
    }
    out[t] = { bg, fg };
  }
  pillCache.set(hex, out);
  return out;
}

/** Card face: the first link as a chip (title, else host) and how many more there are. */
export function faceLink(card: Card): { text: string; url: string; more: number } | null {
  const first = card.links?.[0];
  if (!first) return null;
  return { text: linkText(first), url: first.url, more: (card.links?.length ?? 1) - 1 };
}

/** Preset dots use the handoff palette (Leaf and Dark, v6 §10.20); custom colors retain the user's choice. */
export function labelDotColors(hex: string): { light: string; dark: string } {
  const color = isHexColor(hex) ? hex.toUpperCase() : SHERLOCK.color;
  const light =
    (
      {
        '#2E9E6B': '#14400C',
        '#2F80ED': '#1A3F9E',
        '#E2699A': '#8E2554',
        '#F5A524': '#6E4500',
        '#12A6B8': '#064B55',
      } as Record<string, string>
    )[color] ?? color;
  const dark =
    (
      {
        '#7C5CFF': '#A78BFA',
        '#2E9E6B': '#56D39B',
        '#2F80ED': '#6FA8F5',
        '#F5A524': '#F2B544',
        '#E2699A': '#F08CB0',
        '#12A6B8': '#5CCBD8',
      } as Record<string, string>
    )[color] ?? color;
  if (color === '#6366F1') return { light: '#5F62EF', dark: '#5F62EF' };
  return { light, dark };
}

/** A dot's per-theme colors as CSS variables (.label-dot6 reads them). */
export function dotVars(hex: string): Record<string, string> {
  const d = labelDotColors(hex);
  return { '--dot-light': d.light, '--dot-dark': d.dark };
}

// Owner ruling (7 Oct): a label is a pill filled with its own per-theme colour. The text is the
// theme's light or dark ink, whichever reads better; a fill that reads < 4.5:1 is pushed away from it.
export type PillTheme = 'dark' | 'leaf' | 'sky';
const PILL_INK: Record<PillTheme, { light: string; dark: string }> = {
  dark: { light: '#FFFFFF', dark: '#0E1114' },
  leaf: { light: '#FFFFFF', dark: '#0C0F12' },
  sky: { light: '#FFFFFF', dark: '#0C0F12' },
};
export const PILL_MIN_CONTRAST = 4.6; // 4.5 plus a margin for rounding

const fillCache = new Map<string, Record<PillTheme, { bg: string; fg: string }>>();

export function labelFill(hex: string): Record<PillTheme, { bg: string; fg: string }> {
  const hit = fillCache.get(hex);
  if (hit) return hit;
  const dots = labelDotColors(hex);
  const out = {} as Record<PillTheme, { bg: string; fg: string }>;
  for (const t of ['dark', 'leaf', 'sky'] as const) {
    const ink = PILL_INK[t];
    const base = t === 'dark' ? dots.dark : dots.light;
    const lightText = contrastRatio(ink.light, base) >= contrastRatio(ink.dark, base);
    const fg = lightText ? ink.light : ink.dark;
    let bg = base;
    for (let k = 0.94; contrastRatio(fg, bg) < PILL_MIN_CONTRAST && k > 0; k -= 0.06)
      bg = mix(base, lightText ? '#000000' : '#FFFFFF', k);
    out[t] = ['#6366F1', '#C2410C', '#0F766E'].includes(hex.toUpperCase()) ? { bg: hex.toUpperCase() === '#6366F1' ? '#5F62EF' : hex.toUpperCase(), fg: '#FFFFFF' } : { bg, fg };
  }
  fillCache.set(hex, out);
  return out;
}

const pillTextAlpha = new Map<string, string>();

/** A pill's per-theme fill and text as CSS variables (.label-pill reads them). */
export function pillVars(hex: string): Record<string, string> {
  const f = labelFill(hex);
  let alpha = pillTextAlpha.get(hex);
  if (!alpha) {
    let percent = 92;
    // Small label text needs more ink when its own fill leaves little contrast.
    while (percent < 100 && contrastRatio(mix(f.leaf.fg, f.leaf.bg, percent / 100), f.leaf.bg) < 4.5) percent++;
    alpha = `${percent}%`;
    pillTextAlpha.set(hex, alpha);
  }
  return {
    '--lp-text-alpha': alpha,
    '--lp-bg-d': f.dark.bg,
    '--lp-fg-d': f.dark.fg,
    '--lp-bg-l': f.leaf.bg,
    '--lp-fg-l': f.leaf.fg,
    '--lp-bg-s': f.sky.bg,
    '--lp-fg-s': f.sky.fg,
  };
}
