// §5.2 — relative date labels: Today / Yesterday / weekday within 7 days /
// "Sep 3" / "Sep 3, 2025". Device locale governs the month/day order.

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function relativeDate(iso: string, now: Date = new Date(), locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return d.toLocaleDateString(locale, { weekday: 'short' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(locale, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Header date: "Mon Sep 14". */
export function headerDate(now: Date = new Date(), locale?: string): string {
  return now.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
}

/** Archive grouping: "September 2026". */
export function monthLabel(iso: string, locale?: string): string {
  return new Date(iso).toLocaleDateString(locale, { month: 'long', year: 'numeric' });
}
