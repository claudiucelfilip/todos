import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { usePopover } from './Labels';

interface Props {
  anchor: RefObject<HTMLButtonElement>;
  closing?: boolean;
  phone: boolean;
  onClose(): void;
  onPromote(): void;
  onDelete(): void;
  onEdit(): void;
  linked?: boolean;
}

export default function ChecklistItemMenu({ anchor, phone, closing, onClose, onPromote, onDelete, onEdit, linked }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: -9999, left: 0 });
  const escape = usePopover(ref, anchor, onClose);
  useLayoutEffect(() => {
    const place = () => {
      const button = anchor.current?.getBoundingClientRect();
      const menu = ref.current?.getBoundingClientRect();
      const row = anchor.current?.closest('.dt-row')?.getBoundingClientRect();
      if (!button || !menu) return;
      const viewport = window.visualViewport;
      const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight);
      const below = (row?.bottom ?? button.bottom) + 4;
      const above = (row?.top ?? button.top) - menu.height - 4;
      const top = below + menu.height <= bottom - 12 ? below : above;
      setPos({ top: Math.round(Math.max(12, top)), left: Math.round(Math.max(12, Math.min(button.right - menu.width, window.innerWidth - menu.width - 12))) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [anchor, phone]);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true }); }, []);
  const run = (action: () => void) => { onClose(); action(); };
  return createPortal(
    <div ref={ref} data-theme="tint-dark" data-panel="ink" className={`dt-menu dt-menu-float dt-item-menu${phone ? ' phone' : ''}`} data-closing={closing || undefined} aria-hidden={closing || undefined} role="menu" aria-label="Checklist item options" style={pos} onKeyDown={event => {
      event.stopPropagation();
      escape(event);
      const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      } else if (event.key === 'Tab') onClose();
    }}>
      {!linked && <button type="button" role="menuitem" onClick={() => run(onPromote)}>Convert to todo</button>}
      <button type="button" role="menuitem" onClick={() => run(onEdit)}>{linked ? 'Edit to do' : 'Edit'}</button>
      <div className="dt-item-menu-divider" role="separator" />
      <button type="button" role="menuitem" onClick={() => run(onDelete)}>Delete item</button>
    </div>,
    document.querySelector('.app') ?? document.body,
  );
}
