export const PAGE_SPRING = { stiffness: 260, damping: 26, mass: 1 };
export function rubberBand(distance: number, step: number): number {
  return step * 0.5 * (1 - 1 / (distance / step * 1.2 + 1));
}
export function pageTarget(start: number, x: number, velocity: number, step: number, count: number): number {
  const projected = Math.round(-(x + velocity * 180) / step);
  const target = Math.abs(velocity) > 0.5 && velocity * (x + start * step) > 0 ? start + (velocity < 0 ? 1 : -1) : projected;
  return Math.max(0, Math.min(count - 1, start + 1, Math.max(start - 1, target)));
}
