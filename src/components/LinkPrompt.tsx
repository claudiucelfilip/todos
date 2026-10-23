// ⌘K over a selection in the item editor / add-items field: a small inline popover asking for
// the URL; Enter wraps the selection as [selection](url), Esc goes back to the text.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { isSafeHref, wrapLink } from '../lib/links';
import { useOutsideDismiss } from '../hooks/useOutsideDismiss';
import { linkCopy } from '../lib/copy';
import { useDropdownPresence } from '../hooks/useDropdownPresence';

type Field = HTMLInputElement | HTMLTextAreaElement;

function LinkPrompt({ onApply, onClose, closing }: { onApply(url: string): boolean; onClose(): void; closing?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useOutsideDismiss(root, onClose);
  const ref = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('https://');
  const [bad, setBad] = useState(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const apply = () => {
    if (!onApply(url)) setBad(true);
  };
  return (
    <div ref={root} className="link-prompt" role="dialog" aria-label={linkCopy.prompt} data-testid="link-prompt" data-closing={closing || undefined} aria-hidden={closing || undefined}>
      <input
        ref={ref}
        className={`link-prompt-input${bad ? ' bad' : ''}`}
        type="url"
        inputMode="url"
        value={url}
        aria-label={linkCopy.prompt}
        aria-invalid={bad || undefined}
        onChange={(e) => {
          setUrl(e.target.value);
          setBad(false);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            apply();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <button type="button" className="btn btn-accent link-prompt-go" onPointerDown={(e) => e.preventDefault()} onClick={apply}>
        {linkCopy.apply}
      </button>
      {bad && <span className="link-prompt-hint mono">{linkCopy.onlyWeb}</span>}
    </div>
  );
}

/** Paste a URL over selected words, or ⌘K, to make them a link; returns the handlers and the popover. */
export function useLinkShortcuts<T extends Field>(ref: RefObject<T>, value: string, setValue: (v: string) => void) {
  const [sel, setSel] = useState<{ start: number; end: number } | null>(null);
  const lastSel = useRef(sel);
  if (sel) lastSel.current = sel;
  const presence = useDropdownPresence(!!sel);
  const apply = (start: number, end: number, url: string): boolean => {
    const r = wrapLink(value, start, end, url);
    if (!r) return false;
    setValue(r.value);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(r.caret, r.caret);
    });
    return true;
  };
  const onPaste = (e: React.ClipboardEvent<T>) => {
    const el = e.currentTarget;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const text = e.clipboardData.getData('text/plain').trim();
    if (start === end || !isSafeHref(text)) return; // plain paste
    e.preventDefault();
    apply(start, end, text);
  };
  /** True when it handled ⌘K. */
  const onKeyDown = (e: React.KeyboardEvent<T>): boolean => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k') return false;
    const el = e.currentTarget;
    e.preventDefault();
    e.stopPropagation();
    if (el.selectionStart !== el.selectionEnd) setSel({ start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 });
    return true;
  };
  const prompt = presence.mounted && lastSel.current && (
    <LinkPrompt
      closing={presence.closing}
      onApply={(url) => {
        const range = lastSel.current!;
        const ok = apply(range.start, range.end, url);
        if (ok) setSel(null);
        return ok;
      }}
      onClose={() => {
        setSel(null);
        requestAnimationFrame(() => ref.current?.focus());
      }}
    />
  );
  return { onPaste, onKeyDown, prompt, prompting: !!sel };
}
