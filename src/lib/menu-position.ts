export function menuPosition(anchor: Pick<DOMRect, 'top' | 'bottom' | 'right'>, menu: Pick<DOMRect, 'width' | 'height'>) {
  const viewport = window.visualViewport;
  const leftEdge = Math.ceil((viewport?.offsetLeft ?? 0) + 12);
  const topEdge = Math.ceil((viewport?.offsetTop ?? 0) + 12);
  const rightEdge = Math.floor((viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - 12);
  const bottomEdge = Math.floor((viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 12);
  const maxWidth = Math.max(0, rightEdge - leftEdge);
  const maxHeight = Math.max(0, bottomEdge - topEdge);
  const width = Math.min(menu.width, maxWidth);
  const height = Math.min(menu.height, maxHeight);
  const below = anchor.bottom + 4;
  const top = below + height <= bottomEdge ? below : anchor.top - height - 4;
  return {
    top: Math.round(Math.max(topEdge, Math.min(top, bottomEdge - height))),
    left: Math.round(Math.max(leftEdge, Math.min(anchor.right - width, rightEdge - width))),
    maxWidth,
    maxHeight,
    overflowY: 'auto' as const,
  };
}
