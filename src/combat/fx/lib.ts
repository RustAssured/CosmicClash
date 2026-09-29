import { clamp01 } from '@/contracts';
import { hash01 } from '@/titans/art/noise';
import type { Overlay } from './overlay';

/**
 * Drawing helpers shared by the Phase 2 titans' effects: a tiling noise table that is cheap to sample per pixel (flames, plasma
 * and cloud flow), colour-ramp lookup, and a few reusable shapes (plasma ball, flame column, expanding ring band, soft glow
 * streak). Everything is deterministic in its arguments — no state, no randomness.
 */

const TN = 64;
const TABLE = new Float32Array(TN * TN);
(function buildTable(): void {
  // two octaves of smooth value noise on a wrapping lattice: 8-cell and 16-cell periods
  const lat = (period: number, seed: number): Float32Array => {
    const g = new Float32Array(period * period);
    for (let y = 0; y < period; y++) for (let x = 0; x < period; x++) g[y * period + x] = hash01(x, y, seed);
    return g;
  };
  const smooth = (t: number): number => t * t * (3 - 2 * t);
  const sample = (g: Float32Array, period: number, x: number, y: number): number => {
    const fx = (x / TN) * period;
    const fy = (y / TN) * period;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = smooth(fx - x0);
    const ty = smooth(fy - y0);
    const a = g[(y0 % period) * period + (x0 % period)]!;
    const b = g[(y0 % period) * period + ((x0 + 1) % period)]!;
    const c = g[((y0 + 1) % period) * period + (x0 % period)]!;
    const d = g[((y0 + 1) % period) * period + ((x0 + 1) % period)]!;
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
  const g1 = lat(8, 901);
  const g2 = lat(16, 902);
  for (let y = 0; y < TN; y++)
    for (let x = 0; x < TN; x++) TABLE[y * TN + x] = 0.62 * sample(g1, 8, x, y) + 0.38 * sample(g2, 16, x, y);
})();

/** Wrapping noise in 0..1 with a feature size of ~8 px (x, y in px; tiles every 64 px). Bilinear, so it may be animated smoothly. */
export function tn(x: number, y: number): number {
  const fx = ((x % TN) + TN) % TN;
  const fy = ((y % TN) + TN) % TN;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const x1 = (x0 + 1) & (TN - 1);
  const y1 = (y0 + 1) & (TN - 1);
  const a = TABLE[y0 * TN + x0]!;
  const b = TABLE[y0 * TN + x1]!;
  const c = TABLE[y1 * TN + x0]!;
  const d = TABLE[y1 * TN + x1]!;
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/** Ramp lookup (dark → light) at v ∈ 0..1, nearest step. */
export const rampAt = (ramp: readonly number[], v: number): number =>
  ramp[Math.min(ramp.length - 1, Math.max(0, Math.round(clamp01(v) * (ramp.length - 1))))]!;

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Ordered-dither ramp lookup: v ∈ 0..1 quantised with a 4×4 Bayer threshold at pixel (x, y). */
export function rampDither(ramp: readonly number[], v: number, x: number, y: number): number {
  const s = clamp01(v) * (ramp.length - 1);
  const fl = Math.floor(s);
  const idx = fl + (s - fl > (BAYER[((y & 3) << 2) | (x & 3)]! + 0.5) / 16 ? 1 : 0);
  return ramp[Math.min(ramp.length - 1, idx)]!;
}

/**
 * A ball of churning plasma: a hard-edged flame body (noise-eroded rim) shaded white-hot at the core to red at the edge, with
 * the flow of the noise carried by (`flowX`, `flowY`) px/tick so it streams behind a moving ball. `emissive` feeds the bloom.
 */
export function plasmaBall(
  ov: Overlay,
  cx: number,
  cy: number,
  r: number,
  tick: number,
  ramp: readonly number[],
  flowX = 0,
  flowY = 0,
  emissive = 255,
): void {
  const R = Math.ceil(r * 1.25);
  const x0 = Math.floor(cx - R);
  const y0 = Math.floor(cy - R);
  for (let y = y0; y <= y0 + 2 * R; y++)
    for (let x = x0; x <= x0 + 2 * R; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy) / r;
      if (d > 1.22) continue;
      const n = tn(x * 0.8 - tick * flowX * 0.8, y * 0.8 - tick * flowY * 0.8);
      const edge = 1 + 0.2 * (n - 0.5) * 2;
      if (d > edge) continue;
      const heat = 1 - d / edge; // 1 at the heart
      const v = 0.18 + 0.86 * heat + 0.2 * (n - 0.5);
      ov.set(x, y, rampDither(ramp, v, x, y), heat > 0.35 ? emissive : Math.round(emissive * 0.7));
    }
}

/**
 * A column of flame standing on (`x`, `yBottom`) and licking up to `yTop`, about `halfW` px either side at the base and narrowing
 * toward the tips. Every pixel is a density from a rising noise field (the pattern climbs with time), thresholded into tongues
 * that break into sparks at the top; brightness falls from the base. Opaque writes (for additive layers).
 */
export function flameColumn(
  ov: Overlay,
  x: number,
  yTop: number,
  yBottom: number,
  halfW: number,
  tick: number,
  ramp: readonly number[],
  gain = 1,
): void {
  const H = Math.max(1, yBottom - yTop);
  const xr = Math.round(x);
  const yb = Math.round(yBottom);
  const W = Math.ceil(halfW * 1.5);
  for (let k = 0; k < H; k++) {
    const u = k / H; // 0 base → 1 tip
    const w = halfW * (1 - 0.5 * u) + 0.6;
    const y = yb - k;
    const fall = 1 - Math.pow(u, 1.25);
    for (let dx = -W; dx <= W; dx++) {
      const xx = xr + dx;
      const n = tn(xx * 0.42 + 11, y * 0.16 + tick * 0.95);
      const lat = 1 - Math.abs(dx) / w;
      const d = lat * fall * gain + (n - 0.5) * 0.95 - 0.06;
      if (d < 0.16) continue;
      if (u > 0.8 && ((xx + y + tick) & 1) !== 0 && d < 0.4) continue; // tips break into sparks
      ov.set(xx, y, rampDither(ramp, 0.18 + d * 0.9, xx, y), Math.round(210 * clamp01(d * 1.4)));
    }
  }
}

/**
 * An expanding shock ring: an annulus [r0, r1] around (cx, cy), drawn by a polar sweep (cost ∝ its area, not the bounding
 * box). The leading edge (outer ~9 px) is a solid white-hot band with a noise-torn rim; behind it the wake thins out as an
 * ordered-dither spray of cooling embers, so a thick hitbox annulus still reads as a crisp wave of fire and not a filled disc.
 * `squash` < 1 flattens the ring into an ellipse (a ring lying on the ground plane). Only the part inside the overlay is written.
 */
export function ringBand(
  ov: Overlay,
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  tick: number,
  ramp: readonly number[],
  gain = 1,
  arc: [number, number] = [0, Math.PI * 2],
  squash = 1,
): void {
  const steps = Math.max(24, Math.ceil(Math.abs(arc[1] - arc[0]) * r1 * 1.15));
  const width = r1 - r0;
  const lead = Math.min(width, 9);
  for (let s = 0; s < steps; s++) {
    const a = arc[0] + ((arc[1] - arc[0]) * s) / steps;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const n = tn(a * 26 + tick * 0.35, tick * 0.6);
    const ragged = 0.14 * lead * (n - 0.5) * 2;
    for (let k = 0; k <= width; k++) {
      const rr = r0 + k + ragged;
      const x = Math.round(cx + ca * rr);
      const y = Math.round(cy + sa * rr * squash);
      if (x < ov.ox || y < ov.oy || x >= ov.ox + ov.w || y >= ov.oy + ov.h) continue;
      const fromEdge = width - k; // 0 at the leading edge
      if (fromEdge > lead) {
        // wake: sparse, cooling
        const w = 1 - (fromEdge - lead) / Math.max(1, width - lead); // 1 just behind the edge → 0 at the trailing edge
        const dens = Math.pow(w, 2.2) * 0.8 * gain;
        if (dens <= (BAYER[((y & 3) << 2) | (x & 3)]! + 0.5) / 16) continue;
        ov.set(x, y, rampDither(ramp, 0.12 + 0.5 * w + 0.2 * (n - 0.5), x, y), Math.round(150 * w));
      } else {
        const e = 1 - fromEdge / lead; // 0 → 1 toward the very edge
        const v = (0.55 + 0.45 * e) * gain * (0.85 + 0.3 * n);
        ov.set(x, y, rampDither(ramp, v, x, y), Math.round(240 * clamp01(0.6 + e)));
      }
    }
  }
}

/** A soft additive streak (comet tail / motion smear) from (x0, y0) to (x1, y1): brightest at the head, fading along its length. */
export function streak(
  ov: Overlay,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  g: number,
  b: number,
  gain = 1,
): void {
  const len = Math.max(1, Math.hypot(x1 - x0, y1 - y0));
  const n = Math.ceil(len);
  for (let i = 0; i <= n; i++) {
    const u = i / n; // 0 head → 1 tail
    const k = (1 - u) * (1 - u) * gain;
    ov.add(Math.round(x0 + (x1 - x0) * u), Math.round(y0 + (y1 - y0) * u), r * k, g * k, b * k);
  }
}

/**
 * A soft additive glow in pixel-art clothes: the quadratic falloff is quantised to six levels and ordered-dithered, so it reads
 * as banded, dotted light instead of a smooth blur. Same signature as `Overlay.glow` (colour components 0..255, `strength` scales).
 */
export function glowD(
  ov: Overlay,
  cx: number,
  cy: number,
  r: number,
  cr: number,
  cg: number,
  cb: number,
  strength = 1,
): void {
  const r2 = r * r;
  const L = 6;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const t = (1 - d2 / r2) ** 2 * strength * L;
      const fl = Math.floor(t);
      const lvl = fl + (t - fl > (BAYER[((y & 3) << 2) | (x & 3)]! + 0.5) / 16 ? 1 : 0);
      if (lvl <= 0) continue;
      const k = Math.min(1, lvl / L);
      ov.add(x, y, cr * k, cg * k, cb * k);
    }
}

/**
 * A tapered comet stroke along `pos(u)` for u from `u0` (the tail) to `u1` (the head): thick and white-hot at the head, thin and
 * red at the tail, sampled every ~1.2 px so it is a continuous ribbon rather than beads. `pos` writes world coordinates into `out`.
 */
export function ribbon(
  ov: Overlay,
  pos: (u: number, out: { x: number; y: number }) => void,
  u0: number,
  u1: number,
  totalLen: number,
  rTail: number,
  rHead: number,
  tick: number,
  ramp: readonly number[],
): void {
  const n = Math.max(4, Math.ceil((Math.abs(u1 - u0) * totalLen) / 1.2));
  const p = { x: 0, y: 0 };
  for (let i = 0; i <= n; i++) {
    const q = i / n; // 0 tail → 1 head
    pos(u0 + (u1 - u0) * q, p);
    const r = rTail + (rHead - rTail) * q * q;
    const flick = tn(i * 2.3 + tick * 0.8, 5);
    const v = 0.2 + 0.7 * q + 0.15 * (flick - 0.5);
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    ov.disc(p.x, p.y, r, rampDither(ramp, v, x, y), Math.round(120 + 130 * q));
    if (r > 2.5) ov.disc(p.x, p.y, r * 0.5, rampAt(ramp, 0.8 + 0.2 * q), 255);
  }
}
