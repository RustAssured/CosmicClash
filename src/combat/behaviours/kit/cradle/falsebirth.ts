import type { MatterMap } from '@/contracts';
import type { Overlay } from '../../../fx/overlay';

/**
 * FALSE BIRTH (Gate 4, the brief's signature set-piece; the Ultimate button):
 *   1. SPREAD (startup): the membrane spreads out from the disc until it fills the space between the two titans; the
 *      filaments lock on from several directions (the move's `grip` hitbox holds and bites).
 *   2. CONTRACT (active, first ~70 ticks): the membrane closes round the foe and contracts in slow pulses: for a moment the
 *      foe is gone behind it.
 *   3. BIRTH (active ~72): the membrane tears open (the `birth` hitbox) and expels a malformed pseudo-organ grown from the
 *      foe's own matter, in the foe's own colours and roughly in its shape (it was the developmental instructions): a matter
 *      chunk launched after the foe as a projectile, which then drifts on the field as an obstacle for a few seconds.
 *
 * This module draws the membrane (presentation: an overlay, not matter) and grows the pseudo-organ's pixels. Pure and
 * deterministic in its inputs.
 */

/** Packed colours (ABGR) of the membrane: dried burgundy shadow, mid, a lit amber vein, and a pale hem. */
const VEIL_DARK = 0xff1c0c2a;
const VEIL_MID = 0xff2c1648;
const VEIL_LIT = 0xff3a2c7a;
const VEIL_VEIN = 0xff4a6ab8;
const VEIL_HEM = 0xff8ea4c8;

const B4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x: number, y: number): number => (B4[((y & 3) << 2) | (x & 3)]! + 0.5) / 16;

const ihash = (a: number, b: number, s: number): number => {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};

/**
 * Draw the membrane as a lobed sheet centred at (cx, cy) with radius r: `opacity` 0..1 (dithered), veins radiating from
 * (vx, vy) (where it is anchored: the disc), contraction rings pulsing with `pulse` (0..1). `tick` animates it.
 */
export function drawVeil(
  fx: Overlay,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  opacity: number,
  vx: number,
  vy: number,
  pulse: number,
  tick: number,
  seed: number,
): void {
  const x0 = Math.floor(cx - rx - 3);
  const x1 = Math.ceil(cx + rx + 3);
  const y0 = Math.floor(cy - ry - 3);
  const y1 = Math.ceil(cy + ry + 3);
  const SPOKES = 9;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const px = (x + 0.5 - cx) / rx;
      const py = (y + 0.5 - cy) / ry;
      const a = Math.atan2(py, px);
      // a torn, lobed edge that breathes
      const edge = 1 - 0.07 * Math.sin(a * 7 + seed) - 0.04 * Math.sin(a * 13 - tick * 0.05 + seed * 2);
      const d = Math.hypot(px, py) / edge;
      if (d >= 1) continue;
      // the disc opened out: ribs run from its hub, membrane panels between them pool the light
      const ax = x + 0.5 - vx;
      const ay = y + 0.5 - vy;
      const hr = Math.max(6, Math.hypot(ax, ay));
      const va = Math.atan2(ay, ax) + seed * 0.01;
      const q = ((((va / (Math.PI * 2)) * SPOKES) % 1) + 1) % 1;
      const across = Math.sin(Math.PI * q);
      const ribW = 1.3 / ((hr * Math.PI * 2) / SPOKES);
      const rib = q < ribW || q > 1 - ribW;
      const vein = Math.abs(Math.sin(va * 31 + Math.sin(hr * 0.045 + seed) * 2.5)) < 0.05 && across > 0.25;
      const ring = pulse > 0 && Math.abs(Math.sin(d * 7 + tick * 0.2)) < 0.12 * pulse;
      const hem = d > 0.965 && bayer(x + 2, y + 1) < 0.75;
      // translucent: the panels thin toward the ribs and the rim; ribs, hem and veins are solid tissue
      // (opacity above 1 closes it: a contracted sac hides what it holds)
      const dens =
        hem || rib
          ? 1
          : Math.min(1, opacity * (0.3 + 0.55 * across) * (1.1 - 0.4 * d) + Math.max(0, opacity - 1) * 2);
      if (!rib && !hem && !vein && bayer(x, y) >= dens) continue;
      let c = across > 0.75 && d < 0.85 ? VEIL_LIT : across > 0.4 ? VEIL_MID : VEIL_DARK;
      if (ring) c = VEIL_LIT;
      if (vein) c = VEIL_DARK;
      if (across > 0.88 && d > 0.25 && d < 0.75 && bayer(x + 1, y) < 0.25) c = VEIL_VEIN;
      if (rib) c = d < 0.97 ? VEIL_HEM : VEIL_LIT;
      if (hem) c = VEIL_HEM;
      fx.set(x, y, c, c === VEIL_VEIN ? 40 : 0);
    }
}
/** Torn flaps of membrane flung out from (cx, cy), `u` 0..1 through the tear. */
export function drawTear(fx: Overlay, cx: number, cy: number, r: number, u: number, seed: number): void {
  const n = 11;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + ihash(k, 1, seed) * 0.5;
    const d0 = r * (0.6 + 1.5 * u);
    const len = r * 0.35 * (1 - u);
    if (len < 1) continue;
    const ax = cx + Math.cos(a) * d0;
    const ay = cy + Math.sin(a) * d0;
    const bx = cx + Math.cos(a) * (d0 + len);
    const by = cy + Math.sin(a) * (d0 + len);
    fx.capsule(ax, ay, 2.2 * (1 - u) + 0.6, bx, by, 0.6, VEIL_LIT, VEIL_MID, VEIL_DARK, 0);
  }
}

export interface PseudoOrgan {
  pixels: Uint32Array;
  w: number;
  h: number;
  cells: number;
}

const mix = (a: number, b: number, t: number): number => {
  const u = 1 - t;
  const r = (a & 255) * u + (b & 255) * t;
  const g = ((a >>> 8) & 255) * u + ((b >>> 8) & 255) * t;
  const bl = ((a >>> 16) & 255) * u + ((b >>> 16) & 255) * t;
  return ((255 << 24) | (Math.round(bl) << 16) | (Math.round(g) << 8) | Math.round(r)) >>> 0;
};
const lum = (c: number): number => (c & 255) * 0.3 + ((c >>> 8) & 255) * 0.59 + ((c >>> 16) & 255) * 0.11;

/**
 * Grow the pseudo-organ from the foe's matter: the foe's silhouette, shrunk to about `size` px and malformed (swollen lobes,
 * a warped outline), painted with the foe's own colours, then shaded as a living mass (a lit dome, a dark rim), threaded
 * with capillaries and holding a dark developing lumen. Null if the foe has no live matter.
 */
export function growPseudoOrgan(src: MatterMap, size: number, seed: number): PseudoOrgan | null {
  let x0 = src.w;
  let y0 = src.h;
  let x1 = -1;
  let y1 = -1;
  let dark = 0;
  let light = 0;
  let dl = Infinity;
  let ll = -Infinity;
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      const i = y * src.w + x;
      if (src.material[i] === 0) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      if ((x + y) % 3 !== 0) continue;
      const l = lum(src.baseColor[i]!);
      if (l < dl) {
        dl = l;
        dark = src.baseColor[i]!;
      }
      if (l > ll) {
        ll = l;
        light = src.baseColor[i]!;
      }
    }
  if (x1 < 0) return null;
  const sw = x1 - x0 + 1;
  const sh = y1 - y0 + 1;
  const s = Math.min(1, size / Math.max(sw, sh));
  const w = Math.max(8, Math.round(sw * s) + 6);
  const h = Math.max(8, Math.round(sh * s) + 6);
  const px = new Uint32Array(w * h);
  const mask = new Uint8Array(w * h);
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // malformed: swollen lobes push the sampling inward (the organ bulges where the foe had edges)
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const a = Math.atan2(dy, dx);
      const swell = 1 + 0.22 * Math.sin(a * 3 + seed) + 0.12 * Math.sin(a * 5 - seed * 1.7);
      const ux = cx + dx / swell + 1.6 * Math.sin(y * 0.45 + seed);
      const uy = cy + dy / swell + 1.6 * Math.sin(x * 0.4 - seed);
      const sx = Math.floor(x0 + (ux - 3) / s);
      const sy = Math.floor(y0 + (uy - 3) / s);
      if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) continue;
      const si = sy * src.w + sx;
      if (src.material[si] === 0) continue;
      px[y * w + x] = src.baseColor[si]! | 0xff000000;
      mask[y * w + x] = 1;
    }
  // shade it as a living mass: rim dark, upper-left lit, a dark lumen, capillaries
  const lumX = cx + (ihash(1, 2, seed) - 0.5) * w * 0.3;
  const lumY = cy + (ihash(3, 4, seed) - 0.5) * h * 0.3;
  const R = Math.max(w, h) / 2;
  let cells = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      cells++;
      let edge = false;
      for (const [ox, oy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]) edge = true;
      }
      let c = px[i]!;
      const dx = (x + 0.5 - cx) / R;
      const dy = (y + 0.5 - cy) / R;
      const sh = dx + dy;
      c =
        sh < -0.2
          ? mix(c, light, Math.min(0.55, -sh * 0.5))
          : mix(c, dark, Math.min(0.6, Math.max(0, sh) * 0.55));
      if (edge) c = mix(c, dark, 0.8);
      if (Math.hypot(x + 0.5 - lumX, y + 0.5 - lumY) < R * 0.2) c = mix(c, 0xff000000, 0.75);
      // capillaries: thin dark threads in its own darkest tone
      if (
        Math.abs(
          Math.sin(Math.atan2(y - lumY, x - lumX) * 6 + Math.hypot(x - lumX, y - lumY) * 0.25 + seed),
        ) < 0.1
      )
        c = mix(c, dark, 0.7);
      px[i] = c;
    }
  return { pixels: px, w, h, cells };
}
