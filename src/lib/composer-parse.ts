import type { Label, RemindEvery } from './types';

export interface DraftToken {
  key: string;
  kind: 'label' | 'time' | 'repeat';
  text: string;
  start: number;
  end: number;
  labelId?: string;
}
export interface ComposerDraft {
  title: string;
  body: string[];
  labels: string[];
  remindAt: string | null;
  remindEvery: RemindEvery | null;
  tokens: DraftToken[];
}

/** Only accepted first-line tokens are removed; the editable draft stays untouched. */
export function parseComposerDraft(
  raw: string,
  labels: readonly Label[],
  dismissed: readonly string[] = [],
  now = new Date(),
): ComposerDraft {
  const [first = '', ...body] = raw.replace(/\r\n/g, '\n').split('\n');
  const tokens: DraftToken[] = [];
  const add = (t: DraftToken) => {
    if (!dismissed.includes(t.key)) tokens.push(t);
  };
  for (const m of first.matchAll(/(^|\s)#([\p{L}\p{N}_-]+)(?=$|\s|[.,!?])/gu)) {
    const label = labels.find((l) => l.name.toLocaleLowerCase() === m[2].toLocaleLowerCase());
    if (label) {
      const start = m.index! + m[1].length;
      add({
        key: `label:${m[2].toLocaleLowerCase()}`,
        kind: 'label',
        text: label.name,
        start,
        end: start + m[2].length + 1,
        labelId: label.id,
      });
    }
  }
  let remindAt: string | null = null;
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const timeRE =
    /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)(?:\s+(?:at\s+)?(?:([01]?\d|2[0-3]):([0-5]\d)(?!\s?[ap]m)|(1[0-2]|0?[1-9])(?::([0-5]\d))?\s?([ap]m)))?\b/gi;
  for (const m of first.matchAll(timeRE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (first[end] === "'" || first[end] === '’') continue;
    const timed = !!(m[2] || m[4]);
    if (!timed && /^\s+(?:at\s+)?\d{1,2}(?::\d{2}|\s?[ap]m)/i.test(first.slice(end))) continue;
    // Bare time words are meaningful only at the edge of the title (ignoring labels).
    const remaining = first
      .slice(end)
      .replace(/#[\p{L}\p{N}_-]+/gu, '')
      .replace(/[.,!?]/g, '')
      .trim();
    if (!timed && first.slice(0, start).trim() && remaining) continue;
    // A bare 'Sun' or 'Wed' leading the title is more likely a word ('Sun lotion') than a day.
    if (!timed && m[1].length === 3 && remaining) continue;
    const key = `time:${m[0].toLocaleLowerCase()}`;
    if (dismissed.includes(key)) continue;
    const word = m[1].toLowerCase();
    const date = new Date(now);
    if (word === 'tomorrow') date.setDate(date.getDate() + 1);
    else if (!['today', 'tonight'].includes(word)) {
      const day = days.findIndex((d) => d.startsWith(word.slice(0, 3)));
      const delta = (day - date.getDay() + 7) % 7;
      date.setDate(date.getDate() + (delta || 7));
    }
    // 24 h "9:30", or 12 h "9am" / "3:15 pm".
    let hour = m[2] ? Number(m[2]) : m[4] ? (Number(m[4]) % 12) + (m[6].toLowerCase() === 'pm' ? 12 : 0) : word === 'tonight' ? 20 : 9;
    if (word === 'tonight' && m[2] && hour < 12) hour += 12; // 'tonight 9:00' is 21:00
    date.setHours(hour, m[3] ? Number(m[3]) : m[5] ? Number(m[5]) : 0, 0, 0);
    // A bare 'today' or 'tonight' never lands in the past: it moves to the next full hour.
    if (!timed && date <= now) date.setTime(new Date(now).setMinutes(60, 0, 0));
    remindAt = date.toISOString();
    const label = ['today', 'tomorrow', 'tonight'].includes(word)
      ? word[0].toUpperCase() + word.slice(1)
      : word.slice(0, 3)[0].toUpperCase() + word.slice(1, 3);
    add({
      key,
      kind: 'time',
      text: `${label} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`,
      start,
      end,
    });
    break;
  }
  let remindEvery: RemindEvery | null = null;
  if (remindAt) {
    const m = first.match(
      /\bevery (day|week|month|hour|weekday)\b|\b(daily|weekly|monthly|hourly)\b/i,
    );
    if (m) {
      const start = m.index!;
      const key = `repeat:${m[0].toLocaleLowerCase()}`;
      if (!dismissed.includes(key)) {
        remindEvery = (m[1]?.toLowerCase() ??
          (
            { daily: 'day', weekly: 'week', monthly: 'month', hourly: 'hour' } as Record<
              string,
              RemindEvery
            >
          )[m[2].toLowerCase()]) as RemindEvery;
        add({ key, kind: 'repeat', text: m[0], start, end: start + m[0].length });
      }
    }
  }
  let title = first;
  for (const t of [...tokens].sort((a, b) => b.start - a.start))
    title = title.slice(0, t.start) + title.slice(t.end);
  title = title.replace(/\s+/g, ' ').trim();
  return {
    title,
    body: body.filter((l) => l.trim()),
    labels: [...new Set(tokens.flatMap((t) => (t.labelId ? [t.labelId] : [])))],
    remindAt,
    remindEvery,
    tokens,
  };
}
