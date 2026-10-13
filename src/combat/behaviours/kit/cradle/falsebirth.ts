import type { MatterMap } from '@/contracts';
import type { Overlay } from '../../../fx/overlay';
import { fbm, ridged } from '@/titans/art/noise';

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

/** What lies inside the sac at a world point: the foe's displayed colour there, or 0 (sampled from its live matter). */
export type Inside = (wx: number, wy: number) => number;

const mixc = (a: number, b: number, t: number): number => {
  const u = 1 - t;
  return (
    ((255 << 24) |
      (Math.round(((a >>> 16) & 255) * u + ((b >>> 16) & 255) * t) << 16) |
      (Math.round(((a >>> 8) & 255) * u + ((b >>> 8) & 255) * t) << 8) |
      Math.round((a & 255) * u + (b & 255) * t)) >>>
    0
  );
};

/**
 * THE SAC (False Birth, WJ round 2): a membrane stretched to bursting round the foe, at planetary scale. Translucent: the
 * foe shows through it, dimmed and tinted, and where its body PRESSES against the inside the membrane is drawn taut over it
 * (a lit pressure ridge along its outline, a dark crease just outside); broad contraction folds run toward the poles and
 * squeeze in slow pulses (`squeeze`); a vascular web spreads over it and pulses; calcified ribs strain round it like
 * meridians, knuckled; a wet hem with a pale sheen. `close` 0..1: how far it has closed (it thickens as it closes, but the
 * foe always reads as trapped inside). Presentation: an overlay, tick-driven.
 */
export function drawSac(
  fx: Overlay,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  close: number,
  squeeze: number,
  tick: number,
  seed: number,
  inside: Inside,
): void {
  const x0 = Math.floor(cx - rx - 3);
  const x1 = Math.ceil(cx + rx + 3);
  const y0 = Math.floor(cy - ry - 3);
  const y1 = Math.ceil(cy + ry + 3);
  const RIBS = 7;
  const veinPulse = 0.5 + 0.5 * Math.sin((tick / 140) * Math.PI * 2);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const px = (x + 0.5 - cx) / rx;
      const py = (y + 0.5 - cy) / ry;
      const a = Math.atan2(py, px);
      // stretched to bursting: the outline bulges between the ribs
      const ribA = ((a / (Math.PI * 2)) * RIBS + 100) % 1;
      const bulge = 1 + 0.05 * Math.sin(Math.PI * ribA) - 0.03 * Math.sin(a * 11 - tick * 0.04 + seed);
      const d = Math.hypot(px, py) / bulge;
      if (d >= 1) continue;
      const wx = x + 0.5;
      const wy = y + 0.5;
      // sphere-ish surface coordinates (z out of the screen): folds and ribs wrap round it
      const z = Math.sqrt(Math.max(0, 1 - d * d));
      const lon = Math.atan2(px, z);
      const lat = Math.asin(Math.max(-1, Math.min(1, py / Math.max(0.2, bulge))));
      // the membrane: dried burgundy, thinner (more see-through) where it is stretched over the middle
      let c = d > 0.6 ? VEIL_DARK : VEIL_MID;
      let dens = Math.min(1, 0.42 + 0.35 * close + 0.35 * d * d);
      const foe = inside(wx, wy);
      if (foe) {
        // the foe inside, seen through the tissue, and where it presses, the membrane is taut over it
        const edge = !inside(wx + 2, wy) || !inside(wx - 2, wy) || !inside(wx, wy + 2) || !inside(wx, wy - 2);
        c = mixc(foe, VEIL_MID, 0.45 + 0.25 * close);
        if (edge) c = mixc(c, VEIL_HEM, 0.55);
        dens = Math.min(1, dens + 0.35);
      } else {
        // a dark crease just outside its outline (the tissue drawn in round the body)
        if (inside(wx + 3, wy) || inside(wx - 3, wy) || inside(wx, wy + 3) || inside(wx, wy - 3)) {
          c = VEIL_DARK;
          dens = 1;
        }
      }
      // contraction folds toward the poles, squeezing in pulses: troughs dark, crests wet and lit on the upper left
      const fold = Math.sin(lon * 9 + Math.sin(lat * 2 + seed) * 1.5 + squeeze * 2.5);
      if (fold > 0.8) {
        c = mixc(c, x + y < cx + cy ? VEIL_HEM : VEIL_LIT, 0.55);
        dens = Math.max(dens, 0.9);
      } else if (fold < -0.8) {
        c = mixc(c, VEIL_DARK, 0.7);
        dens = Math.max(dens, 0.85);
      }
      // the vascular web over it: veins branching out from the seams, pulsing
      const vein = Math.abs(Math.sin(lon * 11 + Math.sin(lat * 5 + seed * 1.3) * 3 + lat * 4)) < 0.09;
      const twig = Math.abs(Math.sin(lat * 17 + Math.sin(lon * 6 + seed) * 2.5)) < 0.05 && fold > -0.2;
      if (vein || twig) {
        // dark, blood-filled vessels; a slow pulse runs warm light through the main ones
        c = vein ? mixc(VEIL_DARK, VEIL_LIT, 0.15 + 0.45 * veinPulse) : mixc(VEIL_DARK, VEIL_MID, 0.4);
        dens = 1;
      }
      // calcified ribs straining round it like meridians, knuckled, pale bone with a dark seat
      const ribLon = ((lon / Math.PI + 1) * RIBS * 0.5) % 1;
      const ribW = 0.022 + 0.022 * Math.pow(Math.abs(Math.cos(lat * 6 + seed)), 6);
      if (z > 0.08 && (ribLon < ribW || ribLon > 1 - ribW)) {
        const knuckle = Math.pow(Math.abs(Math.cos(lat * 6 + seed)), 6);
        c = mixc(RIB_BONE, VEIL_DARK, 0.25 - 0.2 * knuckle + (x + y > cx + cy ? 0.25 : 0));
        dens = 1;
      } else if (z > 0.08 && (ribLon < ribW + 0.015 || ribLon > 0.985 - ribW)) {
        c = VEIL_DARK;
        dens = 1;
      }
      // the hem: a thick wet lip, sheen on the lit side
      if (d > 0.965) {
        c = Math.cos(a + 2.35) > 0.3 ? VEIL_HEM : VEIL_LIT;
        dens = 1;
      }
      if (bayer(x, y) >= dens) continue;
      fx.set(x, y, c, c === VEIL_VEIN ? 30 : 0);
    }
}

/** Pale calcified bone of the ribs (ABGR). */
const RIB_BONE = 0xff9ab8d2;

/**
 * THE RUPTURE (`u` 0..1 through it): the sac bursts at continental scale: great torn flaps of membrane (veined, hemmed,
 * ragged-edged) peel back from the opening and fling outward, and long strands of tissue stretch between them and snap.
 */
export function drawRupture(
  fx: Overlay,
  cx: number,
  cy: number,
  r: number,
  u: number,
  tick: number,
  seed: number,
): void {
  const flaps = 7;
  const e = 1 - (1 - u) * (1 - u);
  for (let k = 0; k < flaps; k++) {
    const a = (k / flaps) * Math.PI * 2 + ihash(k, 1, seed) * 0.6;
    const span = 0.5 + 0.2 * ihash(k, 2, seed);
    // each flap: a curved triangle peeling back from the opening, its root on the rim, its tip flung out and curling
    const root = r * (0.7 + 0.35 * e);
    const len = r * (0.7 + 0.5 * ihash(k, 3, seed)) * (1 - 0.35 * u);
    const curl = (ihash(k, 4, seed) - 0.5) * 1.4 * e;
    const steps = 18;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const w = span * (1 - t) * (0.6 + 0.4 * Math.sin(t * 9 + k)); // ragged edge
      const ang = a + curl * t;
      const rr = root + len * t * (0.4 + 0.6 * e);
      for (let q = -8; q <= 8; q++) {
        const aa = ang + (q / 8) * w * 0.5;
        const wx = cx + Math.cos(aa) * rr;
        const wy = cy + Math.sin(aa) * rr;
        const edge = Math.abs(q) >= 7;
        const vein = Math.abs(q) < 2 || (q + s) % 6 === 0;
        const c = edge ? VEIL_HEM : vein ? VEIL_VEIN : t < 0.5 ? VEIL_MID : VEIL_DARK;
        // the flap thins as it tears: dithered toward its tip and as the rupture ends
        const dens = (1 - t * 0.35) * (1 - u * u * 0.8);
        if (bayer(Math.floor(wx), Math.floor(wy)) >= dens) continue;
        fx.set(Math.floor(wx), Math.floor(wy), c, vein ? 25 : 0);
        fx.set(Math.floor(wx) + 1, Math.floor(wy), c, 0);
        fx.set(Math.floor(wx), Math.floor(wy) + 1, c, 0);
      }
    }
    // strands: stretched between this flap's tip and the next flap's root, thinning and snapping as u grows
    if (u < 0.7) {
      const b = ((k + 1) / flaps) * Math.PI * 2 + ihash(k + 1, 1, seed) * 0.6;
      const ax = cx + Math.cos(a + curl) * (root + len * 0.8);
      const ay = cy + Math.sin(a + curl) * (root + len * 0.8);
      const bx = cx + Math.cos(b) * root;
      const by = cy + Math.sin(b) * root;
      const mx = (ax + bx) / 2 + Math.sin(tick * 0.05 + k) * 4;
      const my = (ay + by) / 2 + 10 * e;
      const th = 1.4 * (1 - u / 0.7);
      let pxp = ax;
      let pyp = ay;
      for (let s = 1; s <= 10; s++) {
        const t = s / 10;
        const qx = (1 - t) * (1 - t) * ax + 2 * (1 - t) * t * mx + t * t * bx;
        const qy = (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * my + t * t * by;
        // it has already snapped in the middle once it has stretched far enough
        if (!(u > 0.35 && t > 0.45 && t < 0.6))
          fx.capsule(pxp, pyp, th, qx, qy, th * 0.8, VEIL_HEM, VEIL_LIT, VEIL_DARK, 0);
        pxp = qx;
        pyp = qy;
      }
    }
  }
}
export interface PseudoOrgan {
  pixels: Uint32Array;
  emissive: Uint8Array;
  w: number;
  h: number;
  cells: number;
  /** Points on its veins and on its rim, relative to its centre (px): where it pulses and where it drips. */
  veins: { x: number; y: number }[];
  rim: { x: number; y: number }[];
}

const mix = (a: number, b: number, t: number): number => {
  const u = 1 - t;
  const r = (a & 255) * u + (b & 255) * t;
  const g = ((a >>> 8) & 255) * u + ((b >>> 8) & 255) * t;
  const bl = ((a >>> 16) & 255) * u + ((b >>> 16) & 255) * t;
  return ((255 << 24) | (Math.round(bl) << 16) | (Math.round(g) << 8) | Math.round(r)) >>> 0;
};
const lum = (c: number): number => (c & 255) * 0.3 + ((c >>> 8) & 255) * 0.59 + ((c >>> 16) & 255) * 0.11;

/** The Cradle's own flesh tones (ABGR) that run through what it grows: burgundy, its vessels, its pale collagen. */
const FLESH = 0xff3a2470;
const VESSEL = 0xff1e1250;
const PEARL = 0xffbad0e6;

/**
 * Grow the pseudo-organ from the foe's matter (FALSE BIRTH): planetary in scale, so its detail reads as continents of tissue
 * (large forms, fine surface), never as small-creature gore:
 *  - its mass is the foe's silhouette, swollen and malformed, fused with a lobed body of its own;
 *  - the foe's colours are MARBLED through it in long swirls, with the Cradle's flesh tone running between them;
 *  - wet membrane FOLDS cross it, their crests catching a pale sheen on the lit side;
 *  - a VASCULAR web branches in from its rim; calcified NODULES sit in it like islands; a dark developing lumen;
 *  - TORN UMBILICAL STRANDS trail from it, ringed and ragged at the ends.
 * The behaviour adds what moves: the veins pulse slowly and fluid seeps from the rim as beads (CradleBehaviour.organFx).
 */
export function growPseudoOrgan(src: MatterMap, size: number, seed: number): PseudoOrgan | null {
  let x0 = src.w;
  let y0 = src.h;
  let x1 = -1;
  let y1 = -1;
  const tones: number[] = [];
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      const i = y * src.w + x;
      if (src.material[i] === 0) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      if ((x * 7 + y * 13) % 17 === 0) tones.push(src.baseColor[i]! | 0xff000000);
    }
  if (x1 < 0 || tones.length === 0) return null;
  // the victim's palette, dark → light (five tones by luminance)
  tones.sort((a, b) => lum(a) - lum(b));
  const pal = [0, 0.2, 0.45, 0.7, 0.95].map((q) => tones[Math.floor(q * (tones.length - 1))]!);
  const dark = mix(pal[0]!, 0xff000000, 0.3);
  const light = pal[4]!;
  const sw = x1 - x0 + 1;
  const sh = y1 - y0 + 1;
  const s = Math.min(1.6, size / Math.max(sw, sh));
  const M = 18;
  const bw = Math.max(16, Math.round(sw * s));
  const bh = Math.max(16, Math.round(sh * s));
  const w = bw + 2 * M;
  const h = bh + 2 * M;
  const px = new Uint32Array(w * h);
  const em = new Uint8Array(w * h);
  const mask = new Uint8Array(w * h);
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.max(bw, bh) / 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const a = Math.atan2(dy, dx);
      // its own lobed body (so even a lattice of a foe becomes a mass) …
      const lobe = R * (0.62 + 0.1 * Math.sin(a * 3 + seed) + 0.06 * Math.sin(a * 5 - seed * 1.3));
      let inside = Math.hypot(dx, dy * 1.1) < lobe;
      // … fused with the foe's silhouette, swollen and warped
      const swell = 1 + 0.2 * Math.sin(a * 3 + seed) + 0.1 * Math.sin(a * 5 - seed * 1.7);
      const ux = (dx / swell + 2.2 * Math.sin(y * 0.21 + seed)) / s;
      const uy = (dy / swell + 2.2 * Math.sin(x * 0.19 - seed)) / s;
      const sx = Math.floor(x0 + sw / 2 + ux);
      const sy = Math.floor(y0 + sh / 2 + uy);
      let col = 0;
      if (sx >= 0 && sy >= 0 && sx < src.w && sy < src.h && src.material[sy * src.w + sx] !== 0) {
        inside = true;
        col = src.baseColor[sy * src.w + sx]! | 0xff000000;
      }
      if (!inside) continue;
      const i = y * w + x;
      mask[i] = 1;
      // marbled: long swirls of the victim's tones, the Cradle's flesh running between them
      const swirl = fbm(x * 0.03, y * 0.03, seed, 2) * 3.6;
      const band = 0.5 + 0.5 * Math.sin(x * 0.06 + y * 0.035 + swirl);
      const tone = pal[Math.min(4, Math.floor(band * 4.99))]!;
      let c = col ? mix(col, tone, 0.55) : tone;
      if (Math.abs(Math.sin(x * 0.06 + y * 0.035 + swirl + 1.6)) < 0.2) c = mix(c, FLESH, 0.55);
      else c = mix(c, FLESH, 0.18);
      px[i] = c;
    }
  // shading: a swollen mass lit from the upper left; wet folds with a sheen on their crests; troughs in shadow
  let cells = 0;
  const rim: { x: number; y: number }[] = [];
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
      const slope = dx + dy;
      c =
        slope < -0.25
          ? mix(c, light, Math.min(0.35, -slope * 0.3))
          : mix(c, dark, Math.min(0.55, Math.max(0, slope) * 0.45));
      // broad folds (planet-sized: a few across the whole mass), their crests wet and catching the light
      const fold = ridged(x * 0.035 + seed * 0.01, y * 0.05, seed + 9, 2);
      const foldUp = ridged((x - 1.5) * 0.035 + seed * 0.01, (y - 1.5) * 0.05, seed + 9, 2);
      if (fold > 0.82) c = foldUp < fold - 0.01 ? mix(c, mix(light, PEARL, 0.5), 0.6) : mix(c, light, 0.25);
      else if (fold > 0.7) c = mix(c, light, 0.12);
      else if (fold < 0.3) c = mix(c, dark, 0.3);
      if (edge) {
        c = mix(c, dark, 0.8);
        if ((x + y * 3) % 5 === 0) rim.push({ x: x + 0.5 - cx, y: y + 0.5 - cy });
      }
      px[i] = c;
    }
  // the vascular web: trees branching in from the rim, thick at the root, in its darkest tone and the Cradle's vessel red
  const veins: { x: number; y: number }[] = [];
  const trees = 5;
  for (let tr = 0; tr < trees; tr++) {
    const a0 = (tr / trees) * Math.PI * 2 + ihash(tr, 1, seed) * 0.8;
    // start on the rim: march outward from the centre to the last body cell
    let x = cx;
    let y = cy;
    for (let d = 0; d < Math.max(w, h); d++) {
      const nx = cx + Math.cos(a0) * d;
      const ny = cy + Math.sin(a0) * d;
      const ix = Math.floor(nx);
      const iy = Math.floor(ny);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h || !mask[iy * w + ix]) break;
      x = nx;
      y = ny;
    }
    const branch = (bx: number, by: number, ang: number, len: number, thick: number, depth: number): void => {
      let px0 = bx;
      let py0 = by;
      let a = ang;
      for (let k = 0; k < len; k++) {
        a += (ihash(k + depth * 31, tr, seed + 5) - 0.5) * 0.8;
        px0 += Math.cos(a);
        py0 += Math.sin(a);
        const ix = Math.floor(px0);
        const iy = Math.floor(py0);
        if (ix < 1 || iy < 1 || ix >= w - 1 || iy >= h - 1 || !mask[iy * w + ix]) return;
        const i = iy * w + ix;
        px[i] = mix(mix(px[i]!, dark, 0.7), VESSEL, 0.35);
        em[i] = 14;
        if (thick > 1 && mask[i + 1]) px[i + 1] = mix(px[i + 1]!, dark, 0.55);
        if (k % 4 === 0) veins.push({ x: px0 - cx, y: py0 - cy });
        if (depth < 2 && k > 3 && ihash(k, depth + 7, seed + tr) < 0.16)
          branch(px0, py0, a + (ihash(k, 3, seed) < 0.5 ? -0.9 : 0.9), Math.floor(len * 0.6), 1, depth + 1);
      }
    };
    branch(x, y, a0 + Math.PI, Math.round(R * 1.1), 2, 0);
  }
  // calcified nodules: islands of pale mineral with a dark seat
  for (let k = 0; k < 7; k++) {
    const nx = cx + (ihash(k, 11, seed) - 0.5) * R * 1.3;
    const ny = cy + (ihash(k, 12, seed) - 0.5) * R * 1.3;
    const r = 1.6 + ihash(k, 13, seed) * 1.8;
    for (let y = Math.floor(ny - r - 1); y <= ny + r + 1; y++)
      for (let x = Math.floor(nx - r - 1); x <= nx + r + 1; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h || !mask[y * w + x]) continue;
        const d = Math.hypot(x + 0.5 - nx, y + 0.5 - ny);
        const i = y * w + x;
        // a domed island of mineral half sunk in the flesh: lit on its upper left, shadowed below
        const side = (x + 0.5 - nx + (y + 0.5 - ny)) / r;
        if (d < r) px[i] = mix(px[i]!, side < -0.2 ? mix(PEARL, light, 0.3) : mix(PEARL, dark, 0.45), 0.6);
        else if (d < r + 1 && side > 0) px[i] = mix(px[i]!, dark, 0.45);
      }
  }
  // the developing lumen: a dark, lobed mass sunk in it, its rim lit
  const lumX = cx + (ihash(1, 2, seed) - 0.5) * R * 0.5;
  const lumY = cy + (ihash(3, 4, seed) - 0.5) * R * 0.5;
  const lr = R * 0.2;
  for (let y = Math.floor(lumY - lr - 2); y <= lumY + lr + 2; y++)
    for (let x = Math.floor(lumX - lr - 2); x <= lumX + lr + 2; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h || !mask[y * w + x]) continue;
      const a = Math.atan2(y - lumY, x - lumX);
      const d = Math.hypot(x + 0.5 - lumX, y + 0.5 - lumY) / (lr * (0.85 + 0.2 * Math.sin(a * 3 + seed)));
      const i = y * w + x;
      if (d < 1) px[i] = mix(px[i]!, mix(dark, VESSEL, 0.4), 0.85 - 0.35 * d);
      else if (d < 1.3 && Math.sin(a) < 0) px[i] = mix(px[i]!, light, 0.25);
    }
  // torn umbilical strands trailing from it: ringed cords, tapering, ragged at the ends
  for (let k = 0; k < 3; k++) {
    if (rim.length === 0) break;
    const p = rim[Math.floor(ihash(k, 21, seed) * rim.length)]!;
    const a = Math.atan2(p.y, p.x) + (ihash(k, 22, seed) - 0.5) * 0.6;
    const len = 10 + ihash(k, 23, seed) * 9;
    let x = p.x + cx;
    let y = p.y + cy;
    let ang = a;
    for (let d = 0; d < len; d++) {
      // a heavy cord droops and curls as it trails
      ang += (ihash(d, k, seed + 31) - 0.5) * 0.35 + 0.06 * (k % 2 ? 1 : -1);
      x += Math.cos(ang);
      y += Math.sin(ang);
      const th = d < len * 0.45 ? 1.5 : d < len * 0.8 ? 1 : 0.5;
      // frayed at the end: the last stretch splits into two fibres
      const fray = d > len * 0.8 ? [-1.2, 1.2] : null;
      for (let o = -Math.ceil(th); o <= Math.ceil(th); o++) {
        if (fray ? !fray.some((f) => Math.abs(o - f) < 0.6) : Math.abs(o) > th) continue;
        const ix = Math.floor(x - Math.sin(ang) * o);
        const iy = Math.floor(y + Math.cos(ang) * o);
        if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
        const i = iy * w + ix;
        if (mask[i]) continue;
        const ring = d % 4 === 0;
        px[i] =
          d > len - 2 ? mix(dark, VESSEL, 0.5) : ring ? mix(PEARL, FLESH, 0.4) : mix(FLESH, pal[2]!, 0.3);
      }
    }
  }
  return { pixels: px, emissive: em, w, h, cells, veins, rim };
}
