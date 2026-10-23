// Links inside plain text (notes, checklist items, titles): bare http(s)/mailto URLs, and
// Markdown [words](url) that show only the words. Anything else, javascript: included, stays text.

export type LinkToken = { type: 'text'; text: string } | { type: 'link'; text: string; href: string };

const SAFE = /^(https?:\/\/|mailto:)/i;
export const isSafeHref = (href: string): boolean => SAFE.test(href) && !/\s/.test(href);

const BARE = /^(https?:\/\/|mailto:)[^\s<>]+/i;

/** A bare URL's end: no trailing punctuation, and a closing ")" only when it closes one inside. */
function trimUrl(url: string): string {
  let u = url;
  for (;;) {
    const before = u;
    u = u.replace(/[.,;:!?'"’]+$/, '');
    if (u.endsWith(')') && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1);
    if (u === before) return u;
  }
}

/** [words](url) at `i`: the words (brackets may nest), the url (parentheses may nest), and where it ends. */
function markdownAt(text: string, i: number): { words: string; href: string; end: number } | null {
  let depth = 0;
  let j = i;
  for (; j < text.length; j++) {
    if (text[j] === '[') depth++;
    else if (text[j] === ']' && --depth === 0) break;
  }
  if (depth !== 0 || text[j + 1] !== '(') return null;
  const words = text.slice(i + 1, j);
  let k = j + 2;
  let paren = 1;
  for (; k < text.length; k++) {
    if (/\s/.test(text[k])) return null;
    if (text[k] === '(') paren++;
    else if (text[k] === ')' && --paren === 0) break;
  }
  if (paren !== 0) return null;
  const href = text.slice(j + 2, k);
  if (!words.trim() || !isSafeHref(href)) return null;
  return { words, href, end: k + 1 };
}

export function linkTokens(text: string): LinkToken[] {
  const out: LinkToken[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ type: 'text', text: buf });
    buf = '';
  };
  for (let i = 0; i < text.length; ) {
    if (text[i] === '[') {
      const md = markdownAt(text, i);
      if (md) {
        flush();
        out.push({ type: 'link', text: md.words, href: md.href });
        i = md.end;
        continue;
      }
    }
    // A bare URL starts a word (not glued to letters before it).
    if ((text[i] === 'h' || text[i] === 'H' || text[i] === 'm' || text[i] === 'M') && (i === 0 || !/[\p{L}\p{N}_]/u.test(text[i - 1]))) {
      const m = BARE.exec(text.slice(i));
      if (m) {
        const url = trimUrl(m[0]);
        if (url.length > url.indexOf(':') + 1 && isSafeHref(url)) {
          flush();
          out.push({ type: 'link', text: url, href: url });
          i += url.length;
          continue;
        }
      }
    }
    buf += text[i++];
  }
  flush();
  return out;
}

/**
 * Paste or ⌘K a URL over a selection: `[selected](url)`; with no selection the URL itself.
 * Null when `url` is not a safe link (the paste then goes in as text).
 */
export function wrapLink(value: string, start: number, end: number, url: string): { value: string; caret: number } | null {
  const u = url.trim();
  if (!isSafeHref(u)) return null;
  const sel = value.slice(start, end);
  const ins = sel.trim() ? `[${sel}](${u})` : u;
  return { value: value.slice(0, start) + ins + value.slice(end), caret: start + ins.length };
}
