// §7.3 — the ··· card menu: Make it a note, Repeat, Duplicate, Move to top,
// Copy as text, Archive (done only), Delete. Anchored to its button's corner.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../lib/types';
import { menuPosition } from '../lib/menu-position';

interface Props {
  card: Card;
  closing?: boolean;
  onClose(): void;
  onSomeday(): void;
  onRepeat(): void;
  onDuplicate(): void;
  onMoveToTop(): void;
  onCopy(): void;
  onArchive(): void;
  onDelete(): void;
  /** §12.7: the phone's way to ask the assistant about this card. */
  onAsk?(): void;
}

/** A ··· menu's behaviour: focus the first item, close on an outside press, Esc or Tab, arrows move. */
function useMenu(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('[role^="menuitem"]');
    first?.focus();
    const onDoc = (e: PointerEvent) => {
      if ((e.target as Element).closest?.('.dt-menu-anchor')) return;
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onDoc, true);
    return () => document.removeEventListener('pointerdown', onDoc, true);
  }, [onClose]);

  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') {
      onClose();
    }
  };

  return { ref, run, onKeyDown };
}

/** Portals the menu to the app root under its anchor: inside the glass panel a nested backdrop can't blur (§11.12). */
function FloatingMenu({ menu, children, closing }: { menu: ReturnType<typeof useMenu>; children: React.ReactNode; closing?: boolean }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<React.CSSProperties>({ top: -9999, left: 0 });
  useEffect(() => {
    if (closing && menu.ref.current?.contains(document.activeElement)) {
      anchor.current?.parentElement?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    }
  }, [closing, menu.ref]);
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.parentElement?.getBoundingClientRect();
      const element = menu.ref.current;
      const bounds = element && { width: element.offsetWidth, height: element.offsetHeight };
      if (r && bounds) setPos(menuPosition(r, bounds));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    const observer = new ResizeObserver(place);
    if (menu.ref.current) observer.observe(menu.ref.current);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      observer.disconnect();
    };
  }, []);
  return (
    <>
      <span ref={anchor} hidden />
      {createPortal(
        <div className="dt-menu dt-menu-float" role="menu" ref={menu.ref} onKeyDown={menu.onKeyDown} style={pos} data-closing={closing || undefined} aria-hidden={closing || undefined}>
          {children}
        </div>,
        document.querySelector('.app') ?? document.body,
      )}
    </>
  );
}

export default function CardMenu({ card, closing, onClose, onSomeday, onRepeat, onDuplicate, onMoveToTop, onCopy, onArchive, onDelete, onAsk }: Props) {
  const menu = useMenu(onClose);
  const { run } = menu;

  return (
    <FloatingMenu menu={menu} closing={closing}>
      {onAsk && (
        <button type="button" role="menuitem" data-testid="menu-assistant" onClick={run(onAsk)}>
          Ask the assistant
        </button>
      )}
      {!card.archivedAt && card.kind !== 'note' && (
        <button type="button" role="menuitem" data-testid="menu-someday" onClick={run(onSomeday)}>
          Make it a note
        </button>
      )}
      <button type="button" role="menuitemcheckbox" aria-checked={card.repeat} onClick={run(onRepeat)}>
        Repeat
      </button>
      <button type="button" role="menuitem" onClick={run(onDuplicate)}>
        Duplicate
      </button>
      {card.status !== 'done' && (
        <button type="button" role="menuitem" onClick={run(onMoveToTop)}>
          Move to top
        </button>
      )}
      <button type="button" role="menuitem" onClick={run(onCopy)}>
        Copy as text
      </button>
      {card.status === 'done' && (
        <button type="button" role="menuitem" onClick={run(onArchive)}>
          Archive
        </button>
      )}
      <button type="button" role="menuitem" className="danger" onClick={run(onDelete)}>
        Delete
      </button>
    </FloatingMenu>
  );
}

/** The Checklist header's ··· menu (§11.10 D): shown once something is checked. */
export function ChecklistMenu({ checked, onClose, onUncheckAll, onClear, closing }: { checked: number; onClose(): void; onUncheckAll(): void; onClear(): void; closing?: boolean }) {
  const menu = useMenu(onClose);
  const { run } = menu;
  return (
    <FloatingMenu menu={menu} closing={closing}>
      <button type="button" role="menuitem" onClick={run(onUncheckAll)}>
        Uncheck all
      </button>
      <button type="button" role="menuitem" onClick={run(onClear)}>
        Clear {checked} checked
      </button>
    </FloatingMenu>
  );
}
