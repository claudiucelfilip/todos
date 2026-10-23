// §5.3 — text stays plain; bare URLs and Markdown [words](url) become links (src/lib/links.ts).
import type { ReactNode } from 'react';
import { linkTokens } from './links';

/**
 * Plain strings and links. `clickable` links open a new tab and never reach the row / card
 * underneath (no toggle, edit, drag or swipe); otherwise they only look like links (card face).
 */
export function linkify(text: string, clickable = true): ReactNode[] {
  return linkTokens(text).map((t, i) => {
    if (t.type === 'text') return t.text;
    if (!clickable) return <span key={i} className="text-link static">{t.text}</span>;
    return (
      <a
        key={i}
        className="text-link"
        href={t.href}
        target="_blank"
        rel="noopener noreferrer"
        title={t.href}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {t.text}
      </a>
    );
  });
}

/** What a reader sees: link words without the Markdown (accessible names, the exit row). */
export function plainText(text: string): string {
  return linkTokens(text).map((t) => t.text).join('');
}
