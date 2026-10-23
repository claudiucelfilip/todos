// Spring motion: a damped harmonic oscillator (mass, stiffness, damping, initial
// velocity) solved in closed form, sampled into a CSS `linear()` easing (+ its settle
// duration) or WAAPI keyframes. Progress runs 0 → 1; velocity is in progress units per
// second (finger px/s ÷ distance px), positive toward the target.

export interface SpringSpec {
  mass: number;
  stiffness: number;
  damping: number;
  velocity?: number;
}

export interface SpringCurve {
  /** Progress at each millisecond from 0 to `ms` (inclusive). */
  points: number[];
  /** Time until |x − 1| < 0.001 and |v| < 0.01/s for good. */
  ms: number;
  /** Largest excursion past the target, as a fraction of the distance (0 = none). */
  overshoot: number;
}

const EPS_X = 0.001;
const EPS_V = 0.01;
const MAX_MS = 4000;

/** Displacement from the target (x − 1) and its velocity at time t (s). */
function solve(s: SpringSpec, t: number): [number, number] {
  const m = s.mass;
  const w0 = Math.sqrt(s.stiffness / m);
  const zeta = s.damping / (2 * Math.sqrt(s.stiffness * m));
  const d0 = -1;
  const v0 = s.velocity ?? 0;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const a = d0;
    const b = (v0 + zeta * w0 * d0) / wd;
    const e = Math.exp(-zeta * w0 * t);
    const c = Math.cos(wd * t);
    const sn = Math.sin(wd * t);
    const d = e * (a * c + b * sn);
    const v = e * (-zeta * w0 * (a * c + b * sn) + (-a * wd * sn + b * wd * c));
    return [d, v];
  }
  if (zeta === 1) {
    const b = v0 + w0 * d0;
    const e = Math.exp(-w0 * t);
    return [e * (d0 + b * t), e * (b - w0 * (d0 + b * t))];
  }
  const r = w0 * Math.sqrt(zeta * zeta - 1);
  const r1 = -zeta * w0 + r;
  const r2 = -zeta * w0 - r;
  const A = (v0 - r2 * d0) / (r1 - r2);
  const B = d0 - A;
  return [A * Math.exp(r1 * t) + B * Math.exp(r2 * t), A * r1 * Math.exp(r1 * t) + B * r2 * Math.exp(r2 * t)];
}

/** Progress and velocity (per second) at `ms`, straight from the closed form. */
export function springState(spec: SpringSpec, ms: number): { x: number; v: number } {
  const [d, v] = solve({ ...spec, velocity: spec.velocity ?? 0 }, ms / 1000);
  return { x: 1 + d, v };
}

const cache = new Map<string, SpringCurve>();
let computed = 0;

/** Sample a spring (cached by its parameters; velocity rounded to 0.1/s). */
export function springCurve(spec: SpringSpec): SpringCurve {
  const v = Math.round((spec.velocity ?? 0) * 10) / 10;
  const key = `${spec.mass}|${spec.stiffness}|${spec.damping}|${v}`;
  const hit = cache.get(key);
  if (hit) return hit;
  computed++;
  const s = { ...spec, velocity: v };
  const pts: number[] = [];
  let settled = 0; // last ms that was not yet at rest
  let overshoot = 0;
  for (let ms = 0; ms <= MAX_MS; ms++) {
    const [d, vel] = solve(s, ms / 1000);
    pts.push(1 + d);
    overshoot = Math.max(overshoot, d);
    if (Math.abs(d) >= EPS_X || Math.abs(vel) >= EPS_V) settled = ms;
  }
  const end = Math.min(MAX_MS, settled + 1);
  const curve: SpringCurve = { points: pts.slice(0, end + 1).map((p, i) => (i === end ? 1 : p)), ms: end, overshoot: Math.max(0, overshoot) };
  cache.set(key, curve);
  return curve;
}

/** Test hook: how many distinct curves have been computed (cache check). */
export function springComputeCount(): number {
  return computed;
}

const round = (n: number) => Math.round(n * 10000) / 10000;

/** A CSS `linear()` easing for the spring, sampled every ~`step` ms (plus its duration). */
export function springEasing(spec: SpringSpec, step = 12): { easing: string; ms: number } {
  const c = springCurve(spec);
  const n = Math.max(12, Math.ceil(c.ms / step));
  const vals: string[] = [];
  for (let i = 0; i <= n; i++) vals.push(String(round(c.points[Math.round((i / n) * c.ms)])));
  return { easing: `linear(${vals.join(', ')})`, ms: c.ms };
}

/** WAAPI keyframes: `frame(progress)` at evenly spaced offsets (linear between them). */
export function springKeyframes(spec: SpringSpec, frame: (p: number) => Keyframe, step = 16): { keyframes: Keyframe[]; ms: number } {
  const c = springCurve(spec);
  const n = Math.max(8, Math.ceil(c.ms / step));
  const keyframes: Keyframe[] = [];
  for (let i = 0; i <= n; i++) keyframes.push({ ...frame(c.points[Math.round((i / n) * c.ms)]), offset: i / n });
  return { keyframes, ms: c.ms };
}

// ---- the named springs (used consistently; tokens in index.css match these) ----
export const SPRINGS = {
  /** Popovers, chips, toasts: near-critical, no visible overshoot. */
  snappy: { mass: 1, stiffness: 5832, damping: 153 },
  /** Panels, sheets, the column switch: overshoot ≤ 2 %. */
  gentle: { mass: 1, stiffness: 1814.4, damping: 68.4 },
  /** Card flight and FLIP reorders: heavier, ~3 % overshoot. */
  heavy: { mass: 2, stiffness: 3484.8, damping: 123.2 },
  /** Swipe settle / snap-back / drag drop: add the release velocity. */
  release: { mass: 1, stiffness: 1684.8, damping: 75.6 },
} satisfies Record<string, SpringSpec>;

export type SpringName = keyof typeof SPRINGS;

/** The CSS token values for a named spring (index.css carries these literally). */
export function springToken(name: SpringName): { easing: string; ms: number } {
  return springEasing(SPRINGS[name]);
}

/** Lower an initial velocity until the spring's overshoot over `distancePx` stays within `maxPx`. */
export function capOvershoot(spec: SpringSpec, velocity: number, distancePx: number, maxPx: number): number {
  let v = velocity;
  while (v > 0 && springCurve({ ...spec, velocity: v }).overshoot * Math.abs(distancePx) > maxPx) v = v < 1 ? 0 : Math.floor(v * 7) / 10;
  return v;
}

/** Velocity in progress units per second from a finger velocity (px/ms) over a distance (px). */
export function progressVelocity(pxPerMs: number, distancePx: number): number {
  if (!distancePx) return 0;
  return (pxPerMs * 1000) / Math.abs(distancePx);
}
