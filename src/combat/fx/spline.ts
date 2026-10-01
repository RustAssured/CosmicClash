import { clamp01 } from '@/contracts';
import type { Overlay } from './overlay';

/**
 * Pixel-art spline strokes: tendrils today, the Witness's arms, fibres and membrane edges tomorrow.
 *
 * A stroke is a Catmull-Rom curve through a chain of nodes (world px). It is sampled densely (every ~0.5 px) and each sample
 * stamps a disc of the local radius into a scratch buffer that keeps, per pixel, the sample it lies closest to (relative to that
 * sample's radius). That gives every pixel a position ACROSS the tube (`s` in −1..1) and along it (`u` in 0..1), so the tube is
 * lit per pixel as a cylinder against the stage light (normal = across-axis · s + view axis · √(1 − s²)), ordered-dithered into
 * the material ramp. Width tapers with `u`, joints bulge and carry a dark groove, colour progresses from the root to an optional
 * glowing tip ramp, and a selective outline (dark on the shadow side, a lighter edge on the lit side) separates overlapping
 * strokes. Everything is deterministic and allocation-free per stroke (scratch buffers are sized once to the overlay).
 */

export interface SplineStyle {
  /** Radius in px at the root (u = 0) and at the tip (u = 1). */
  r0: number;
  r1: number;
  /** Taper exponent: 1 = linear; > 1 holds the width near the root and thins late; < 1 thins early. */
  taperPow: number;
  /** Body ramp, dark → light (packed). */
  ramp: readonly number[];
  /** Light offset at the root (negative = darker root) blending to 0 at the tip: the colour progression along the length. */
  rootShade: number;
  /** Contrast of the cylinder lighting (1 = full ramp across the tube). */
  contrast: number;
  /** Optional tip ramp, dark → light, faded in from `tipFrom` (0..1 along the length) to the tip. */
  tipRamp: readonly number[] | null;
  tipFrom: number;
  /** Emissive (0..255) reached at the very tip; scales with the tip blend. */
  tipEmissive: number;
  /** A joint every `jointEvery` nodes (0 = none): radius bulge (fraction of the radius) and a dark groove across the tube. */
  jointEvery: number;
  jointBulge: number;
  /** Outline colours (packed, 0 = none) for the shadow side and the lit side. */
  outlineDark: number;
  outlineLit: number;
}

export const DEFAULT_SPLINE: Readonly<SplineStyle> = Object.freeze({
  r0: 2.5,
  r1: 0.7,
  taperPow: 1.2,
  ramp: [0xff000000, 0xffffffff],
  rootShade: -0.15,
  contrast: 1,
  tipRamp: null,
  tipFrom: 0.75,
  tipEmissive: 0,
  jointEvery: 0,
  jointBulge: 0,
  outlineDark: 0,
  outlineLit: 0,
});

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x: number, y: number): number => (BAYER4[((y & 3) << 2) | (x & 3)]! + 0.5) / 16;

/** Sample spacing along the curve (px): every pixel keeps its nearest sample, so 1 px spacing loses nothing across the tube. */
const STEP = 1;
/** Half-length of a joint groove along the curve (px) and the reach of the joint bulge (px). */
const GROOVE = 0.55;
const BULGE_REACH = 1.8;

export class SplinePen {
  readonly w: number;
  readonly h: number;
  /** Per pixel: squared normalised distance to the closest sample ((d / r)²), reused for the light in the outline pass. */
  private readonly best: Float32Array;
  private readonly across: Float32Array;
  private readonly along: Float32Array;
  private readonly nx: Float32Array;
  private readonly ny: Float32Array;
  private readonly groove: Uint8Array;
  /** Generation stamp of the stroke that covered the pixel (avoids clearing the buffers between strokes). */
  private readonly gen: Uint32Array;
  private readonly outGen: Uint32Array;
  private curGen = 0;
  /** Pixels covered by the current stroke (layer-local indices). */
  private readonly touched: Int32Array;
  private nTouched = 0;
  /** Unit light direction (x right, y down, z toward the camera). */
  private lx = -0.5;
  private ly = -0.5;
  private lz = 0.7;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    const n = w * h;
    this.best = new Float32Array(n);
    this.across = new Float32Array(n);
    this.along = new Float32Array(n);
    this.nx = new Float32Array(n);
    this.ny = new Float32Array(n);
    this.groove = new Uint8Array(n);
    this.gen = new Uint32Array(n);
    this.outGen = new Uint32Array(n);
    this.touched = new Int32Array(n);
  }

  /** Stage light direction FROM the surface TOWARD the light (view space, as `StageLighting.dir`). */
  setLight(dir: readonly [number, number, number] | readonly number[]): void {
    const l = Math.hypot(dir[0]!, dir[1]!, dir[2]!) || 1;
    this.lx = dir[0]! / l;
    this.ly = dir[1]! / l;
    this.lz = dir[2]! / l;
  }

  /**
   * Draw one stroke through nodes `[base, base + cnt)` of (xs, ys) into `ov`. `fullNodes` is the node count of the intact chain
   * (a cut chain keeps its thick-root taper); `widthMul` scales the radius (stretched whips thin out); `opacity` < 1 dissolves the
   * stroke with an ordered dither (falling pieces); `glow` (0..1) brightens the tip ramp; `nodeOffset` is the index of the first
   * node within the intact chain (a severed piece keeps its place in the taper and the joint rhythm). Returns the pixels filled.
   */
  stroke(
    ov: Overlay,
    xs: ArrayLike<number>,
    ys: ArrayLike<number>,
    base: number,
    cnt: number,
    fullNodes: number,
    st: SplineStyle,
    widthMul = 1,
    opacity = 1,
    glow = 0,
    nodeOffset = 0,
  ): number {
    if (cnt < 2) return 0;
    if (this.curGen >= 0xfffffff0) {
      this.gen.fill(0);
      this.outGen.fill(0);
      this.curGen = 0;
    }
    const g = ++this.curGen;
    this.nTouched = 0;
    const uScale = 1 / Math.max(1, fullNodes - 1);
    for (let k = 0; k + 1 < cnt; k++) {
      const i1 = base + k;
      const i2 = i1 + 1;
      const x1 = xs[i1]!;
      const y1 = ys[i1]!;
      const x2 = xs[i2]!;
      const y2 = ys[i2]!;
      // neighbours for the Catmull-Rom tangents (reflected at the ends)
      const x0 = k > 0 ? xs[i1 - 1]! : 2 * x1 - x2;
      const y0 = k > 0 ? ys[i1 - 1]! : 2 * y1 - y2;
      const x3 = k + 2 < cnt ? xs[i2 + 1]! : 2 * x2 - x1;
      const y3 = k + 2 < cnt ? ys[i2 + 1]! : 2 * y2 - y1;
      const segLen = Math.hypot(x2 - x1, y2 - y1);
      const n = Math.max(2, Math.ceil(segLen / STEP));
      const kk = k + nodeOffset;
      const jointA = st.jointEvery > 0 && kk > 0 && kk % st.jointEvery === 0;
      const jointB = st.jointEvery > 0 && (kk + 1) % st.jointEvery === 0 && k + 2 < cnt;
      for (let j = k === 0 ? 0 : 1; j <= n; j++) {
        const t = j / n;
        const t2 = t * t;
        const t3 = t2 * t;
        // uniform Catmull-Rom position and derivative
        const px =
          0.5 *
          (2 * x1 +
            (-x0 + x2) * t +
            (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 +
            (-x0 + 3 * x1 - 3 * x2 + x3) * t3);
        const py =
          0.5 *
          (2 * y1 +
            (-y0 + y2) * t +
            (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 +
            (-y0 + 3 * y1 - 3 * y2 + y3) * t3);
        let tx =
          0.5 * (-x0 + x2 + 2 * (2 * x0 - 5 * x1 + 4 * x2 - x3) * t + 3 * (-x0 + 3 * x1 - 3 * x2 + x3) * t2);
        let ty =
          0.5 * (-y0 + y2 + 2 * (2 * y0 - 5 * y1 + 4 * y2 - y3) * t + 3 * (-y0 + 3 * y1 - 3 * y2 + y3) * t2);
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl;
        ty /= tl;
        const u = clamp01((kk + t) * uScale);
        let r = (st.r0 + (st.r1 - st.r0) * Math.pow(u, st.taperPow)) * widthMul;
        // joints: a bulge around the node and a groove right on it
        const dA = t * segLen;
        const dB = (1 - t) * segLen;
        let grooveHere = 0;
        if (jointA && dA < BULGE_REACH) {
          r *= 1 + st.jointBulge * (1 - dA / BULGE_REACH);
          if (dA < GROOVE) grooveHere = 1;
        }
        if (jointB && dB < BULGE_REACH) {
          r *= 1 + st.jointBulge * (1 - dB / BULGE_REACH);
          if (dB < GROOVE) grooveHere = 1;
        }
        if (r < 0.5) r = 0.5;
        this.stamp(ov, px, py, r, -ty, tx, u, grooveHere, g);
      }
    }
    return this.resolve(ov, st, opacity, glow, g);
  }

  /** Stamp one sample: every pixel within `r` keeps it if it is the closest sample so far (relative to the radius). */
  private stamp(
    ov: Overlay,
    cx: number,
    cy: number,
    r: number,
    nx: number,
    ny: number,
    u: number,
    groove: number,
    g: number,
  ): void {
    const W = this.w;
    const H = this.h;
    const lx0 = Math.max(0, Math.floor(cx - r) - ov.ox);
    const lx1 = Math.min(W - 1, Math.ceil(cx + r) - ov.ox);
    const ly0 = Math.max(0, Math.floor(cy - r) - ov.oy);
    const ly1 = Math.min(H - 1, Math.ceil(cy + r) - ov.oy);
    const inv = 1 / r;
    const r2 = r * r;
    const inv2 = inv * inv;
    for (let y = ly0; y <= ly1; y++) {
      const dy = y + ov.oy + 0.5 - cy;
      const row = y * W;
      for (let x = lx0; x <= lx1; x++) {
        const dx = x + ov.ox + 0.5 - cx;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        // (d / r)², compared monotonically: no square root per pixel
        const q = d2 * inv2;
        const i = row + x;
        if (this.gen[i] !== g) {
          this.gen[i] = g;
          this.touched[this.nTouched++] = i;
        } else if (q >= this.best[i]!) continue;
        this.best[i] = q;
        this.across[i] = (dx * nx + dy * ny) * inv;
        this.along[i] = u;
        this.nx[i] = nx;
        this.ny[i] = ny;
        this.groove[i] = groove;
      }
    }
  }

  /** Light, colour and outline the covered pixels, writing them into the overlay. */
  private resolve(ov: Overlay, st: SplineStyle, opacity: number, glow: number, g: number): number {
    const W = this.w;
    const ramp = st.ramp;
    const nr = ramp.length - 1;
    const tip = st.tipRamp;
    const nt = tip ? tip.length - 1 : 0;
    const lx = this.lx;
    const ly = this.ly;
    const lz = this.lz;
    const dissolve = opacity < 1;
    let filled = 0;
    for (let k = 0; k < this.nTouched; k++) {
      const i = this.touched[k]!;
      const x = i % W;
      const y = (i - x) / W;
      const wx = x + ov.ox;
      const wy = y + ov.oy;
      if (dissolve && bayer(wx * 3 + 1, wy * 5) > opacity) {
        this.gen[i] = 0;
        continue;
      }
      let s = this.across[i]!;
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      const nz = Math.sqrt(1 - s * s);
      // cylinder normal: across axis (in the screen plane) tilted by s, the rest toward the camera
      const dot = this.nx[i]! * s * lx + this.ny[i]! * s * ly + nz * lz;
      const u = this.along[i]!;
      let v = 0.5 + 0.5 * dot * st.contrast + st.rootShade * (1 - u);
      if (this.groove[i]) v -= 0.3;
      let c: number;
      let em = 0;
      if (dot > 0.9 && !this.groove[i]) c = ramp[nr]!;
      else c = pick(ramp, nr, v, wx, wy);
      if (tip !== null && u > st.tipFrom) {
        const w = clamp01((u - st.tipFrom) / Math.max(1e-3, 1 - st.tipFrom));
        if (w > bayer(wx, wy + 1)) {
          c = pick(tip, nt, v + 0.25 * glow, wx, wy);
          em = Math.round(st.tipEmissive * w * (0.6 + 0.4 * glow));
        }
      }
      ov.set(wx, wy, c, em);
      // remember the lighting for the outline pass (best[] is free now)
      this.best[i] = dot;
      filled++;
    }
    if (!dissolve && (st.outlineDark !== 0 || st.outlineLit !== 0)) this.outline(ov, st, g);
    return filled;
  }

  /** Selective outline: every uncovered 4-neighbour of a covered pixel takes the dark or the lit edge colour. */
  private outline(ov: Overlay, st: SplineStyle, g: number): void {
    const W = this.w;
    const H = this.h;
    for (let k = 0; k < this.nTouched; k++) {
      const i = this.touched[k]!;
      if (this.gen[i] !== g) continue;
      const x = i % W;
      const y = (i - x) / W;
      const lit = this.best[i]! > 0.35;
      const c = lit ? st.outlineLit : st.outlineDark;
      if (c === 0) continue;
      if (x > 0) this.edge(ov, i - 1, c, g);
      if (x < W - 1) this.edge(ov, i + 1, c, g);
      if (y > 0) this.edge(ov, i - W, c, g);
      if (y < H - 1) this.edge(ov, i + W, c, g);
    }
  }

  private edge(ov: Overlay, j: number, c: number, g: number): void {
    if (this.gen[j] === g || this.outGen[j] === g) return;
    this.outGen[j] = g;
    const x = j % this.w;
    ov.set(x + ov.ox, (j - x) / this.w + ov.oy, c);
  }
}

function pick(ramp: readonly number[], n: number, v: number, x: number, y: number): number {
  const s = clamp01(v) * n;
  const fl = Math.floor(s);
  return ramp[Math.min(n, fl + (s - fl > bayer(x, y) ? 1 : 0))]!;
}
