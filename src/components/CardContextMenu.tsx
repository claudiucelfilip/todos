// Desktop right-click (or the hover ···, or the ContextMenu key / Shift+F10) on a card: the ···
// menu's moves, Someday, Remind me and Delete at the pointer. Esc, Tab or a click outside closes it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../lib/types';
import { contextItems, type ContextItem } from '../lib/input';
import { reminderChips } from '../lib/remind';
import { menuCopy, remindCopy } from '../lib/copy';
import { actions } from '../hooks/useStore';
import { CHIP_LABEL } from './Reminder';

interface Props {
  card: Card;
  closing?: boolean;
  x: number;
  y: number;
  onClose(focusCard: boolean): void;
  onOpenCard(id: string): void;
}

export default function CardContextMenu({ card, closing, x, y, onClose, onOpenCard }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [remind, setRemind] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Keep the whole menu on screen; offset sizes, since the open animation scales the rect.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos({ left: Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8)), top: Math.max(8, Math.min(y, innerHeight - el.offsetHeight - 8)) });
  }, [x, y, remind]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    const onDoc = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current(false);
    };
    const onBlur = () => closeRef.current(false);
    document.addEventListener('pointerdown', onDoc, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onDoc, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, []);

  const run = (item: ContextItem) => {
    if (item.disabled) return;
    if (item.key === 'remind') {
      setRemind((v) => !v);
      return;
    }
    onClose(item.key !== 'delete');
    if (item.key === 'someday') actions.placeCard(card.id, 'note');
    else if (item.key === 'delete') actions.deleteCardById(card.id);
    else if (card.kind === 'note') actions.placeCard(card.id, item.key);
    else if (item.key === 'todo' && card.someday) actions.setSomeday(card.id, false);
    else actions.moveCardAction(card.id, item.key);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onClose(true);
    }
  };

  const chips = remind ? reminderChips(new Date()) : [];
  return createPortal(
    <div
      ref={ref}
      className="dt-menu ctx-menu"
      data-closing={closing || undefined} aria-hidden={closing || undefined}
      role="menu"
      aria-label={menuCopy.menuAria(card.title)}
      data-testid="card-context-menu"
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {contextItems(card).map((item) => (
        <div key={item.key} className="ctx-group">
          <button
            type="button"
            role="menuitem"
            className={item.danger ? 'danger' : undefined}
            aria-disabled={item.disabled || undefined}
            aria-expanded={item.key === 'remind' ? remind : undefined}
            data-testid={`ctx-${item.key}`}
            onClick={() => run(item)}
          >
            {item.label}
          </button>
          {item.key === 'remind' && remind && (
            <div className="ctx-sub" role="group" aria-label={remindCopy.remindMe}>
              {chips.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  role="menuitem"
                  data-testid={`ctx-remind-${c.key}`}
                  onClick={() => {
                    onClose(true);
                    actions.setReminder(card.id, c.at.toISOString());
                  }}
                >
                  {CHIP_LABEL[c.key]}
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onClose(false);
                  onOpenCard(card.id); // the full picker lives in the detail
                }}
              >
                {remindCopy.pick}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}
