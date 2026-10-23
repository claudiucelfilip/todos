// Phone swipe actions (iOS Mail style), as a pure gesture reducer the row component
// drives from touch events: direction lock, 1:1 follow, rubber band past the commit
// threshold, armed state, velocity commit, and the open / close / commit outcome.

export type SwipeDir = 'left' | 'right';

export const SWIPE = {
  lock: 10, // px before deciding scroll vs swipe
  open: 88, // resting offset of an open row
  openAt: 72, // release past this (short of commit) leaves the row open
  commitRatio: 0.4, // of the row width
  flick: 0.5, // px/ms
  rubber: 0.55, // initial give past the commit threshold; stiffer the further you pull
  rubberLimit: 0.3, // of the row width: the most the card can move past the threshold
};

export interface SwipeConfig {
  width: number;
  left: boolean; // swipe left allowed (reveals the right-hand action)
  right: boolean;
}

export interface SwipeState {
  phase: 'pending' | 'swiping' | 'scroll';
  x0: number;
  y0: number;
  base: number; // offset when the touch began (0, or ±open)
  raw: number; // base + finger movement, direction-clamped
  offset: number; // what the row shows (rubber-banded)
  armed: SwipeDir | null;
  v: number; // px/ms, last move
  lastX: number;
  lastT: number;
}

export type SwipeOutcome = { kind: 'none' } | { kind: 'close' } | { kind: 'open'; dir: SwipeDir } | { kind: 'commit'; dir: SwipeDir };

export function swipeStart(base: number, x: number, y: number, t: number): SwipeState {
  return { phase: 'pending', x0: x, y0: y, base, raw: base, offset: base, armed: null, v: 0, lastX: x, lastT: t };
}

const commitDist = (cfg: SwipeConfig) => cfg.width * SWIPE.commitRatio;

export function swipeMove(s: SwipeState, x: number, y: number, t: number, cfg: SwipeConfig): SwipeState {
  if (s.phase === 'scroll') return s;
  const dx = x - s.x0;
  const dy = y - s.y0;
  let phase: SwipeState['phase'] = s.phase;
  if (phase === 'pending') {
    if (Math.abs(dx) < SWIPE.lock && Math.abs(dy) < SWIPE.lock) return s;
    phase = Math.abs(dy) > Math.abs(dx) ? 'scroll' : 'swiping';
    if (phase === 'scroll') return { ...s, phase };
  }
  let raw = s.base + dx;
  if (!cfg.left) raw = Math.max(0, raw);
  if (!cfg.right) raw = Math.min(0, raw);
  const c = commitDist(cfg);
  const mag = Math.abs(raw);
  // iOS-style rubber band: (1 - 1/(x·k/L + 1))·L gets progressively stiffer and never passes L.
  const L = cfg.width * SWIPE.rubberLimit;
  const offset = mag <= c ? raw : Math.sign(raw) * (c + L * (1 - 1 / (((mag - c) * SWIPE.rubber) / L + 1)));
  const dt = t - s.lastT;
  const v = dt > 0 ? (x - s.lastX) / dt : s.v;
  const armed: SwipeDir | null = mag >= c ? (raw < 0 ? 'left' : 'right') : null;
  return { ...s, phase, raw, offset, armed, v, lastX: x, lastT: t };
}

export function swipeEnd(s: SwipeState): SwipeOutcome {
  if (s.phase !== 'swiping') return s.base !== 0 && s.phase === 'pending' ? { kind: 'close' } : { kind: 'none' };
  if (s.raw === 0) return { kind: 'close' };
  const dir: SwipeDir = s.raw < 0 ? 'left' : 'right';
  const mag = Math.abs(s.raw);
  const flick = Math.abs(s.v) > SWIPE.flick && Math.sign(s.v) === Math.sign(s.raw) && mag >= SWIPE.openAt / 2;
  if (s.armed || flick) return { kind: 'commit', dir };
  if (mag >= SWIPE.openAt) return { kind: 'open', dir };
  return { kind: 'close' };
}

/** Where the row settles for an outcome: 0, ±open, or off-screen for a commit. */
export function restOffset(o: SwipeOutcome, width: number): number {
  if (o.kind === 'open') return o.dir === 'left' ? -SWIPE.open : SWIPE.open;
  if (o.kind === 'commit') return o.dir === 'left' ? -width : width;
  return 0;
}
