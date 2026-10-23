import { ITEM_MAX } from './parse';

/** Extract only a final flat list; structured Markdown stays in the body. */
export function trailingChecklist(notes: string): { notes: string; items: { text: string; done: boolean }[] } | null {
  const lines = notes.replace(/\r\n/g, '\n').split('\n');
  const fenced = new Set<number>();
  let fence: { mark: string; length: number } | null = null;
  lines.forEach((line, i) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      fenced.add(i);
      if (marker && marker[1][0] === fence.mark && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker) {
      fenced.add(i);
      fence = { mark: marker[1][0], length: marker[1].length };
    }
  });
  let end = lines.length;
  while (end && !lines[end - 1].trim()) end--;
  let start = end;
  const items: { text: string; done: boolean }[] = [];
  while (start) {
    const at = start - 1;
    if (fenced.has(at)) break;
    if (!lines[at].trim()) {
      let previous = at - 1;
      while (previous >= 0 && !lines[previous].trim()) previous--;
      if (previous >= 0 && !fenced.has(previous)) {
        if (/^\s+\S/.test(lines[previous])) return null;
        if (/^(?:[-*+•]|\d+[.)])\s+/.test(lines[previous])) { start--; continue; }
      }
      break;
    }
    const match = lines[at].match(/^(?:[-*+•]|\d+[.)])\s+(?:\[([ xX])\](?!\()\s*)?(.*)$/);
    if (!match) break;
    const text = match[2].trim();
    if (text.length > ITEM_MAX) return null;
    // Enter can leave one unfinished marker at the end; never drop an empty row inside a list.
    if (!text && at !== end - 1) return null;
    if (text) items.unshift({ text, done: match[1]?.toLowerCase() === 'x' });
    start--;
  }
  if (!items.length || (start && /^\s+\S/.test(lines[start - 1]) && !fenced.has(start - 1))) return null;
  return { notes: lines.slice(0, start).join('\n').trimEnd(), items };
}
