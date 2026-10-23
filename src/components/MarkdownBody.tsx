// The whole body stays in one textarea while editing; Markdown renders on blur.
import { Fragment, forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ForwardedRef, type ReactNode } from 'react';
import type { Card } from '../lib/types';
import { thumbUrl, isImage } from '../lib/files';
import { uploads } from '../lib/uploads';

interface Props {
  card: Card;
  value: string;
  readOnly?: boolean;
  onChange(next: string): void;
  /** Write now (blur, leaving the card): the debounce must not lose the last keystrokes. */
  onCommit(): void;
  onFinish(value: string, cardId: string): void;
  /** Files pasted into a line: the panel uploads them and inserts their markdown. */
  onFiles?(files: File[], at: number): void;
  /** A pasted URL: resolve a title for `[title](url)`. */
  titleFor?(url: string): Promise<string | null>;
  /** Focus the body immediately, with the caret at its end. */
  startAtEnd?: boolean;
}

export interface MarkdownBodyHandle {
  focus(): void;
}

const URL_RE = /^https?:\/\/\S+$/;
/** Only web links and this server's files open: never javascript:, data: or other schemes. */
export const safeHref = (u: string): string | null => (/^https?:\/\//i.test(u) || /^\/kanban\/files\/[\w-]+$/.test(u) ? u : null);
/** A URL inside markdown parentheses: brackets and spaces escaped so it cannot end the link early. */
export const mdUrl = (u: string): string => u.replace(/[()\s]/g, (c) => encodeURIComponent(c));
const TASK = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;

/** Inline markdown: **bold**, *italic*, `code`, [text](url) and bare links. */
export function inline(s: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s<>()]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${m.index}`;
    if (t.startsWith('**')) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('*')) out.push(<em key={k}>{t.slice(1, -1)}</em>);
    else {
      const mm = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      const href = safeHref(mm ? mm[2] : t);
      if (!href) {
        out.push(mm ? mm[1] : t);
        last = m.index + t.length;
        continue;
      }
      out.push(
        <a key={k} className="md-link" href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          {mm ? mm[1] : t.replace(/^https?:\/\/(www\.)?/, '')}
        </a>,
      );
    }
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function MarkdownBody({ card, value, readOnly, onChange, onCommit, onFinish, onFiles, titleFor, startAtEnd }: Props, ref: ForwardedRef<MarkdownBodyHandle>) {
  const [editing, setEditing] = useState(!!startAtEnd && !readOnly);
  const lines = value ? value.split('\n') : [];
  const [caret, setCaret] = useState<number | 'end'>('end');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({
    focus() {
      if (readOnly) return;
      setCaret('end');
      setEditing(true);
      const input = inputRef.current;
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(input.value.length, input.value.length);
    },
  }), [readOnly]);
  useEffect(() => { setEditing(false); }, [card.id]);
  useEffect(() => {
    if (startAtEnd && !readOnly) { setCaret('end'); setEditing(true); }
  }, [card.id, startAtEnd, readOnly]);

  const grow = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!editing || !el) return;
    if (document.activeElement !== el) {
      el.focus({ preventScroll: true });
      const at = caret === 'end' ? el.value.length : Math.min(caret, el.value.length);
      el.setSelectionRange(at, at);
    }
  }, [editing, caret]);
  useLayoutEffect(grow, [editing, value]);

  const setLines = (next: string[]) => onChange(next.join('\n'));
  const edit = (i: number) => {
    if (readOnly) return;
    const offset = lines.slice(0, i).reduce((n, line) => n + line.length + 1, 0);
    if (i >= lines.length && value && !value.endsWith('\n')) onChange(value + '\n');
    setCaret(Math.min(offset + (lines[i]?.length ?? 0), value.length + 1));
    setEditing(true);
  };
  const stop = (event: React.FocusEvent<HTMLTextAreaElement>) => {
    onCommit();
    // Backgrounding the phone saves text without changing the editing session.
    if (document.hidden || !document.hasFocus()) return;
    setEditing(false);
    onFinish(event.currentTarget.value, card.id);
  };

  // Restore selection after applying a formatting shortcut.
  const pendingSel = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    if (!pendingSel.current) return;
    inputRef.current?.setSelectionRange(...pendingSel.current);
    pendingSel.current = null;
  });
  const wrapSel = (el: HTMLTextAreaElement, before: string, after = before) => {
    const { selectionStart: a, selectionEnd: b, value: v } = el;
    const put = (next: string, from: number, to: number) => {
      pendingSel.current = [from, to];
      onChange(next);
    };
    // ⌘B / ⌘I toggle: a selection or caret inside a bold (italic) span unwraps it instead of adding marks.
    const span = before === '**' ? /\*\*(.+?)\*\*/g : before === '*' ? /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g : null;
    for (const m of span ? v.matchAll(span) : []) {
      const start = m.index!;
      const end = start + m[0].length;
      if (a < start || b > end) continue;
      const at = (p: number) => Math.min(start + m[1].length, Math.max(start, p - before.length));
      return put(v.slice(0, start) + m[1] + v.slice(end), at(a), at(b));
    }
    // No selection: the word under the caret, else empty marks with the caret between them.
    let [x, y] = [a, b];
    if (x === y && span) {
      while (x > 0 && /[\p{L}\p{N}_'-]/u.test(v[x - 1])) x--;
      while (y < v.length && /[\p{L}\p{N}_'-]/u.test(v[y])) y++;
    }
    put(v.slice(0, x) + before + v.slice(x, y) + after + v.slice(y), a + before.length, b + before.length);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'b' || e.key === 'i' || e.key === 'k')) {
      e.preventDefault();
      if (e.key === 'b') wrapSel(el, '**');
      else if (e.key === 'i') wrapSel(el, '*');
      else wrapSel(el, '[', '](https://)');
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      el.blur();
      return;
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length && onFiles) {
      e.preventDefault();
      e.stopPropagation();
      onFiles(files, e.currentTarget.value.slice(0, e.currentTarget.selectionStart).split('\n').length - 1);
      return;
    }
    const text = e.clipboardData.getData('text/plain');
    const el = e.currentTarget;
    const url = text.trim();
    if (URL_RE.test(url) && titleFor) {
      // A link becomes [title](url) once the page answers; until then (or without a title) the host.
      e.preventDefault();
      e.stopPropagation();
      const v = el.value;
      const a = el.selectionStart;
      const b = el.selectionEnd;
      let host = url;
      try {
        host = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        /* keep the url */
      }
      const md = `[${host.replace(/[[\]]/g, '')}](${mdUrl(url)})`;
      onChange(v.slice(0, a) + md + v.slice(b));
      pendingSel.current = [a + md.length, a + md.length];
      const pastedCardId = card.id;
      void titleFor(url).then((title) => {
        if (!title || latest.current.cardId !== pastedCardId) return;
        const clean = title.replace(/[[\]]/g, '').trim();
        latest.current.onChange(latest.current.value.replace(md, `[${clean}](${mdUrl(url)})`));
      });
    }
  };
  const latest = useRef({ value, onChange, cardId: card.id });
  latest.current = { value, onChange, cardId: card.id };

  const toggleTask = (i: number) => {
    const m = lines[i].match(TASK);
    if (!m || readOnly) return;
    const copy = [...lines];
    copy[i] = lines[i].replace(/\[([ xX])\]/, m[2] === ' ' ? '[x]' : '[ ]');
    setLines(copy);
    onCommit();
  };

  return (
    <div
      className="md-body"
      data-testid="detail-notes"
      role="group"
      aria-label="Note body"
      tabIndex={!readOnly && !editing && value ? 0 : undefined}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || event.key !== 'Enter' || readOnly) return;
        event.preventDefault();
        setCaret('end');
        setEditing(true);
      }}
    >
      {!readOnly && (editing || !value) ? (
        <textarea
          ref={inputRef}
          className="md-raw"
          rows={2}
          placeholder="Write anything. # heading, - list, **bold**, [link](url), ![image](url)"
          value={value}
          aria-label="Note body"
          spellCheck
          onFocus={() => setEditing(true)}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          onBlur={stop}
        />
      ) : (
        <MarkdownPreview card={card} value={value} onEdit={readOnly ? undefined : edit} onToggleTask={readOnly ? undefined : toggleTask} />
      )}
    </div>
  );
}

export default forwardRef(MarkdownBody);

/** One rendered preview for the detail panel, Board and Notes cards. */
export function MarkdownPreview({ card, value, onEdit, onToggleTask, compact = false }: {
  card: Card;
  value: string;
  onEdit?(line: number): void;
  onToggleTask?(line: number): void;
  compact?: boolean;
}) {
  const lines = value ? value.split('\n') : [];
  const pendingPreview = (url: string): string | null => {
    const id = url.match(/^\/kanban\/files\/([\w-]+)$/)?.[1];
    if (!id) return /^https?:/.test(url) ? url : null;
    const att = card.attachments?.find((a) => a.id === id);
    if (att) return isImage(att) ? thumbUrl(att) : null;
    return uploads.list(card.id).find((u) => u.id === id)?.previewUrl ?? null;
  };

  const blocks = lines.map((raw, i) => {
    const open = (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('a, button')) return;
      onEdit?.(i);
    };
    let m: RegExpMatchArray | null;
    if ((m = raw.match(/^(#{1,3})\s+(.*)$/)))
      return (
        <div key={i} className={`md-h md-h${m[1].length}`} role="heading" aria-level={m[1].length} onClick={open}>
          <span>{inline(m[2], i)}</span>
        </div>
      );
    if ((m = raw.match(TASK)))
      return (
        <div key={i} className={`md-task${m[2] !== ' ' ? ' done' : ''}`} onClick={open}>
          {compact ? <span className="md-box" aria-hidden>{m[2] !== ' ' ? '✓' : ''}</span> : <button type="button" className="md-box" role="checkbox" aria-checked={m[2] !== ' '} aria-label={m[3]} disabled={!onToggleTask} onClick={(e) => { e.stopPropagation(); onToggleTask?.(i); }}>
            {m[2] !== ' ' && (
              <svg viewBox="0 0 24 24" width="12" height="12">
                <path d="m5 12 5 5 9-10" />
              </svg>
            )}
          </button>}
          <span>{inline(m[3], i)}</span>
        </div>
      );
    if ((m = raw.match(/^\s*[-*+]\s+(.*)$/)))
      return (
        <div key={i} className="md-li" onClick={open}>
          <span className="md-mark mono">–</span>
          <span>{inline(m[1], i)}</span>
        </div>
      );
    if (compact && /^!\[/.test(raw)) return null;
    if ((m = raw.match(/^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/))) {
      const src = pendingPreview(m[2]);
      return (
        <div key={i} className="md-img" onClick={open}>
          {src ? <img src={src} alt={m[1]} loading="lazy" draggable={false} /> : <div className="md-img-missing" />}
        </div>
      );
    }
    if (!raw.trim()) return <div key={i} className="md-blank" onClick={open} />;
    return (
      <p key={i} className="md-p" onClick={open}>
        {inline(raw, i)}
      </p>
    );
  });

  return <>{blocks.map((block, i) => <Fragment key={i}>{block}</Fragment>)}</>;
}
