// Attachments in the card detail: add (button, drop, paste), pending uploads with progress
// and retry, an image grid that opens a lightbox, a file list, and remove with Undo.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { Attachment, Card } from '../lib/types';
import { attachCopy } from '../lib/copy';
import { uploads, type UploadView } from '../lib/uploads';
import { fileBadge, fileUrl, formatSize, isImage, thumbUrl } from '../lib/files';
import { useStore } from '../hooks/useStore';
import { instantMotion } from '../lib/presence';

/** The pending uploads of one card, live. */
export function useUploads(cardId: string): UploadView[] {
  const key = useSyncExternalStore(uploads.subscribe, () => JSON.stringify(uploads.list(cardId)));
  return JSON.parse(key) as UploadView[];
}

/** Queue every file for the card (the button, a drop or a paste). */
export function attachFiles(cardId: string, files: FileList | File[]): void {
  for (const f of Array.from(files))
    void uploads.add(
      cardId,
      f,
      f.name ||
        (f.type.startsWith('image/') ? `Pasted image.${f.type.split('/')[1] || 'png'}` : 'file'),
    );
}

export function FileIcon({ a }: { a: { type: string; name: string } }) {
  return (
    <span className="att-icon" aria-hidden>
      <svg
        viewBox="0 0 24 24"
        width="28"
        height="28"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      >
        <path d="M6 2.8h8l4.2 4.2v14.2H6z" />
        <path d="M14 2.8V7h4.2" />
      </svg>
      <span className="att-badge mono">{fileBadge(a)}</span>
    </span>
  );
}

export function PaperclipIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20.5 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.9-8.9a3.4 3.4 0 0 1 4.8 4.8l-8.9 8.9a1.7 1.7 0 0 1-2.4-2.4l8.1-8.1" />
    </svg>
  );
}

/** `readOnly` (a view-only link): view and download only, no add, remove or upload queue. */
export default function AttachmentsSection({
  card,
  readOnly = false,
}: {
  card: Card;
  readOnly?: boolean;
}) {
  const store = useStore();
  const queued = useUploads(card.id);
  const pending = readOnly ? [] : queued;
  const input = useRef<HTMLInputElement>(null);
  const [light, setLight] = useState<number | null>(null);
  const atts = card.attachments ?? [];
  const images = atts.filter(isImage);
  const files = atts.filter((a) => !isImage(a));
  if (!atts.length && !pending.length) {
    if (readOnly) return null;
    return (
      <section className="dt-atts empty" aria-label={attachCopy.title}>
        <div className="dt-atts-head">
          <h3 className="dt-section-title">Files and links</h3>
          <AddButton input={input} cardId={card.id} compact />
        </div>
        <p className="attachment-empty">Paste or drop files and links here</p>
      </section>
    );
  }
  return (
    <section className="dt-atts" aria-label={attachCopy.title} data-testid="detail-attachments">
      <div className="dt-atts-head">
        <h3 className="dt-section-title">Files and links</h3>
        {!readOnly && <AddButton input={input} cardId={card.id} compact />}
      </div>
      <div className="attachment-tiles">
        {(images.length > 0 || pending.some((p) => p.previewUrl)) && (
          <ul className="att-grid">
            {images.map((a, i) => (
              <li key={a.id} className="att-tile" data-testid={`att-${a.id}`}>
                <button
                  type="button"
                  className="att-thumb"
                  aria-label={attachCopy.image(a.name)}
                  onClick={() => setLight(i)}
                >
                  <img src={thumbUrl(a)} alt="" loading="lazy" draggable={false} />
                </button>
                {!readOnly && (
                  <RemoveButton a={a} onRemove={() => store.removeAttachment(card.id, a.id)} />
                )}
              </li>
            ))}
            {pending
              .filter((p) => p.previewUrl)
              .map((p) => (
                <li key={p.id} className="att-tile pending" data-testid={`upload-${p.id}`}>
                  <span className="att-thumb">
                    <img src={p.previewUrl} alt="" draggable={false} />
                  </span>
                  <UploadState p={p} />
                </li>
              ))}
          </ul>
        )}
        {(files.length > 0 || pending.some((p) => !p.previewUrl)) && (
          <ul className="att-files">
            {files.map((a) => (
              <li key={a.id} className="att-file" data-testid={`att-${a.id}`}>
                <a
                  className="att-file-link"
                  href={fileUrl(a.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={a.name}
                >
                  <FileIcon a={a} />
                  <span className="att-file-name">{a.name}</span>
                  <span className="att-file-size mono">{formatSize(a.size)}</span>
                </a>
                {!readOnly && (
                  <RemoveButton a={a} onRemove={() => store.removeAttachment(card.id, a.id)} />
                )}
              </li>
            ))}
            {pending
              .filter((p) => !p.previewUrl)
              .map((p) => (
                <li key={p.id} className="att-file pending" data-testid={`upload-${p.id}`}>
                  <span className="att-file-link">
                    <FileIcon a={p} />
                    <span className="att-file-name">{p.name}</span>
                    <span className="att-file-size mono">{formatSize(p.size)}</span>
                  </span>
                  <UploadState p={p} />
                </li>
              ))}
          </ul>
        )}
      </div>
      {light !== null && images[light] && (
        <Lightbox images={images} index={light} onIndex={setLight} onClose={() => setLight(null)} />
      )}
    </section>
  );
}

function AddButton({
  input,
  cardId,
  compact,
}: {
  input: React.RefObject<HTMLInputElement>;
  cardId: string;
  compact?: boolean;
}) {
  return (
    <>
      <button
        type="button"
        className={`dt-link att-add${compact ? ' compact' : ''}`}
        data-testid="attach-add"
        onClick={() => input.current?.click()}
      >
        <PaperclipIcon size={compact ? 18 : 16} />
        Add
      </button>
      {/* iOS offers camera, photos and files for this input. */}
      <input
        ref={input}
        type="file"
        multiple
        accept="image/*,*/*"
        hidden
        data-testid="attach-input"
        onChange={(e) => {
          if (e.target.files?.length) attachFiles(cardId, e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}

function RemoveButton({ a, onRemove }: { a: Attachment; onRemove(): void }) {
  return (
    <button
      type="button"
      className="att-x"
      aria-label={attachCopy.remove(a.name)}
      data-testid={`att-remove-${a.id}`}
      onClick={onRemove}
    >
      ×
    </button>
  );
}

function UploadState({ p }: { p: UploadView }) {
  const text =
    p.state === 'uploading'
      ? attachCopy.uploading(Math.round(p.progress * 100))
      : p.state === 'failed'
        ? p.error === 'file_too_large'
          ? attachCopy.tooLarge
          : p.error === 'offline'
            ? attachCopy.waiting
            : attachCopy.failed
        : attachCopy.waiting;
  return (
    <span className={`att-state mono ${p.state}`} data-state={p.state} role="status">
      {p.state === 'uploading' && (
        <span className="att-bar" aria-hidden>
          <span style={{ transform: `scaleX(${Math.max(0.04, p.progress)})` }} />
        </span>
      )}
      <span className="att-state-text">{text}</span>
      {p.state === 'failed' && p.error !== 'file_too_large' && (
        <button
          type="button"
          className="linkbtn mono"
          data-testid={`upload-retry-${p.id}`}
          onClick={() => void uploads.retry(p.id)}
        >
          {attachCopy.retry}
        </button>
      )}
      <button
        type="button"
        className="att-x"
        aria-label={attachCopy.cancel}
        onClick={() => uploads.cancel(p.id)}
      >
        ×
      </button>
    </span>
  );
}

/** Full-size images: ←/→ or a swipe between them, Esc or the backdrop closes. */
export function Lightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: Attachment[];
  index: number;
  onIndex(i: number): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(
    typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null,
  );
  const touch = useRef<{ x: number; y: number } | null>(null);
  const a = images[index];
  const step = (d: number) => onIndex((index + d + images.length) % images.length);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('.lb-close')?.focus();
    const prev = back.current;
    return () => prev?.focus?.({ preventScroll: true });
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    // Handled here only: never the panel's Esc (close the card) or the board's keys.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowRight' && images.length > 1) step(1);
    else if (e.key === 'ArrowLeft' && images.length > 1) step(-1);
    else if (e.key === 'Tab') {
      const els = Array.from(ref.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? []);
      const i = els.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      els[(i + (e.shiftKey ? -1 : 1) + els.length) % els.length]?.focus();
    }
  };
  return createPortal(
    <div
      ref={ref}
      className={`lightbox${instantMotion() ? ' still' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={attachCopy.image(a.name)}
      data-testid="lightbox"
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onTouchStart={(e) => {
        touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }}
      onTouchEnd={(e) => {
        const t = touch.current;
        touch.current = null;
        if (!t || images.length < 2) return;
        const dx = e.changedTouches[0].clientX - t.x;
        const dy = e.changedTouches[0].clientY - t.y;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
      }}
    >
      <img key={a.id} className="lb-img" src={fileUrl(a.id)} alt={a.name} draggable={false} />
      <div className="lb-bar">
        <span className="lb-name">{a.name}</span>
        {images.length > 1 && (
          <span className="lb-count mono">
            {index + 1} / {images.length}
          </span>
        )}
        <a className="lb-btn" href={fileUrl(a.id)} target="_blank" rel="noopener noreferrer">
          {attachCopy.open}
        </a>
        <a className="lb-btn" href={fileUrl(a.id)} download={a.name}>
          {attachCopy.download}
        </a>
        <button
          type="button"
          className="lb-btn lb-close"
          aria-label={attachCopy.close}
          data-testid="lightbox-close"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {images.length > 1 && (
        <>
          <button
            type="button"
            className="lb-nav prev"
            aria-label={attachCopy.prev}
            onClick={() => step(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            className="lb-nav next"
            aria-label={attachCopy.next}
            data-testid="lightbox-next"
            onClick={() => step(1)}
          >
            ›
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
