/**
 * Palette maths for the scenery dither. Pure TypeScript (no three, no DOM) so it is unit-tested in Node and could run
 * in a worker.
 *
 * Ordered dithering against an arbitrary palette works like this: for an input colour T pick TWO palette colours A, B
 * and a ratio r so that mixing A and B in the proportion r reproduces T once the eye averages neighbouring pixels.
 * Each screen pixel then shows B when its Bayer threshold falls below r, otherwise A. We choose the pair in a
 * perceptual space (OKLab) and PENALISE pairs that are far apart, which is what keeps the result reading as clean,
 * deliberate pixel-art dithering between neighbouring ramp steps instead of noisy confetti.
 *
 * The pair is stored in a small 3D LUT built once when a stage loads (so the shader needs one texture fetch to know
 * which two palette entries matter). The exact ratio is then recomputed per pixel by projecting the true colour on
 * the A→B segment, which is what makes gradients smooth even though the LUT itself is coarse.
 */
import { hex, pb, pg, pr } from '@/contracts';

/* --------------------------------- colour spaces --------------------------------- */

export const srgbToLinear = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
export const linearToSrgb = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

/** Linear sRGB → OKLab (Björn Ottosson). Writes L, a, b into `out[o..o+2]`. */
export function linearToOklab(r: number, g: number, b: number, out: Float32Array | number[], o = 0): void {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[o] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[o + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

/* ----------------------------------- palette ------------------------------------- */

export interface PaletteData {
  readonly count: number;
  /** sRGB bytes r,g,b per entry. */
  readonly srgb: Uint8Array;
  /** Linear-light r,g,b per entry. */
  readonly linear: Float32Array;
  /** OKLab L,a,b per entry. */
  readonly lab: Float32Array;
  /** Ramp index per entry (a ramp is a dark→light run of related colours). */
  readonly rampOf: Uint8Array;
  /** Colour pairs allowed to be mixed by the dither: neighbours along a ramp, plus very close cross-ramp pairs. */
  readonly pairA: Uint8Array;
  readonly pairB: Uint8Array;
}

/** Cross-ramp pairs closer than this (OKLab distance) may be mixed, so ramps can hand over to each other. */
export const CROSS_RAMP_MAX = 0.11;

/**
 * Split a palette into ramps. Authors list palettes ramp by ramp, dark → light, so a drop in lightness marks a new
 * ramp. `rampLengths` states the split explicitly when the author knows it.
 */
export function inferRamps(lab: Float32Array, count: number, rampLengths?: readonly number[]): Uint8Array {
  const rampOf = new Uint8Array(count);
  if (rampLengths && rampLengths.reduce((a, c) => a + c, 0) === count) {
    let i = 0;
    rampLengths.forEach((len, r) => {
      for (let k = 0; k < len; k++) rampOf[i++] = r;
    });
    return rampOf;
  }
  let r = 0;
  for (let i = 1; i < count; i++) {
    if (lab[i * 3]! < lab[(i - 1) * 3]! - 1e-4) r++;
    rampOf[i] = r;
  }
  return rampOf;
}

/** Palette texture width; palettes are padded to this so the shader can use a constant-size 1D texture. */
export const PALETTE_TEX_W = 64;

export function preparePalette(hexes: readonly string[], rampLengths?: readonly number[]): PaletteData {
  const n = hexes.length;
  if (n < 2) throw new Error('palette needs at least two colours');
  if (n > PALETTE_TEX_W) throw new Error(`palette has ${n} colours, max ${PALETTE_TEX_W}`);
  const srgb = new Uint8Array(n * 3);
  const linear = new Float32Array(n * 3);
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = hex(hexes[i]!);
    const r = pr(c);
    const g = pg(c);
    const b = pb(c);
    srgb[i * 3] = r;
    srgb[i * 3 + 1] = g;
    srgb[i * 3 + 2] = b;
    const lr = srgbToLinear(r / 255);
    const lg = srgbToLinear(g / 255);
    const lb = srgbToLinear(b / 255);
    linear[i * 3] = lr;
    linear[i * 3 + 1] = lg;
    linear[i * 3 + 2] = lb;
    linearToOklab(lr, lg, lb, lab, i * 3);
  }
  const rampOf = inferRamps(lab, n, rampLengths);
  const pa: number[] = [];
  const pb: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const same = rampOf[i] === rampOf[j];
      if (same && j !== i + 1) continue; // within a ramp only neighbours mix
      if (!same) {
        const dl = lab[i * 3]! - lab[j * 3]!;
        const da = lab[i * 3 + 1]! - lab[j * 3 + 1]!;
        const db = lab[i * 3 + 2]! - lab[j * 3 + 2]!;
        if (Math.hypot(dl, da, db) > CROSS_RAMP_MAX) continue;
      }
      pa.push(i);
      pb.push(j);
    }
  }
  return { count: n, srgb, linear, lab, rampOf, pairA: Uint8Array.from(pa), pairB: Uint8Array.from(pb) };
}

/* ------------------------------------ the LUT ------------------------------------ */

export interface DitherLut {
  /** Nodes per axis. */
  readonly size: number;
  /** size³ × 4 bytes: [paletteIndexA, paletteIndexB, ratio(0..255), 0], x = red fastest, then green, then blue. */
  readonly data: Uint8Array;
}

export interface LutOptions {
  /** Nodes per axis. The exact ratio is recomputed per pixel, so this only has to resolve which PAIR to use. */
  size?: number;
}

/**
 * Best (A, B, ratio) for one linear-light target, shared by the LUT builder and the tests.
 *
 * Candidates are (a) every single colour and (b) every ALLOWED pair (`pal.pairA/B`: neighbours along a ramp plus very
 * close cross-ramp pairs). Restricting mixing to ramp neighbours is what makes the dither read as a pixel artist's:
 * light and dark steps of ONE hue interleave; unrelated hues never speckle each other. Error is measured in OKLab.
 * Result in `out` = [A, B, ratio 0..1], ordered so that A is the darker colour.
 */
function bestPair(pal: PaletteData, tr: number, tg: number, tb: number, labTmp: Float32Array, out: Float32Array): void {
  linearToOklab(tr, tg, tb, labTmp, 0);
  const tl = labTmp[0]!;
  const ta = labTmp[1]!;
  const tbb = labTmp[2]!;
  const n = pal.count;
  const lab = pal.lab;
  const lin = pal.linear;

  let bestErr = Infinity;
  let bestA = 0;
  let bestB = 0;
  let bestR = 0;
  for (let i = 0; i < n; i++) {
    const dl = lab[i * 3]! - tl;
    const da = lab[i * 3 + 1]! - ta;
    const db = lab[i * 3 + 2]! - tbb;
    const d = dl * dl + da * da + db * db;
    if (d < bestErr) {
      bestErr = d;
      bestA = i;
      bestB = i;
    }
  }
  const pa = pal.pairA;
  const pb = pal.pairB;
  for (let s = 0; s < pa.length; s++) {
    const ia = pa[s]!;
    const ib = pb[s]!;
    const ar = lin[ia * 3]!;
    const ag = lin[ia * 3 + 1]!;
    const ab = lin[ia * 3 + 2]!;
    const dr = lin[ib * 3]! - ar;
    const dg = lin[ib * 3 + 1]! - ag;
    const db2 = lin[ib * 3 + 2]! - ab;
    const len2 = dr * dr + dg * dg + db2 * db2;
    if (len2 < 1e-9) continue;
    // Ratio = projection of the target on the A→B segment in LINEAR light (the eye averages light, not gamma).
    let r = ((tr - ar) * dr + (tg - ag) * dg + (tb - ab) * db2) / len2;
    r = r < 0 ? 0 : r > 1 ? 1 : r;
    linearToOklab(ar + dr * r, ag + dg * r, ab + db2 * r, labTmp, 0);
    const el = labTmp[0]! - tl;
    const ea = labTmp[1]! - ta;
    const eb = labTmp[2]! - tbb;
    const err = el * el + ea * ea + eb * eb;
    if (err < bestErr) {
      bestErr = err;
      bestA = ia;
      bestB = ib;
      bestR = r;
    }
  }
  if (bestB !== bestA && lab[bestB * 3]! < lab[bestA * 3]!) {
    const t = bestA;
    bestA = bestB;
    bestB = t;
    bestR = 1 - bestR;
  }
  out[0] = bestA;
  out[1] = bestB;
  out[2] = bestR;
}

export function buildDitherLut(pal: PaletteData, opts: LutOptions = {}): DitherLut {
  const size = opts.size ?? 32;
  const data = new Uint8Array(size * size * size * 4);
  const lab = new Float32Array(3);
  const res = new Float32Array(3);
  const inv = 1 / (size - 1);
  let o = 0;
  for (let b = 0; b < size; b++) {
    const tb = srgbToLinear(b * inv);
    for (let g = 0; g < size; g++) {
      const tg = srgbToLinear(g * inv);
      for (let r = 0; r < size; r++) {
        // The target is re-derived from the node's sRGB coordinates each time (the LUT is indexed in sRGB).
        bestPair(pal, srgbToLinear(r * inv), tg, tb, lab, res);
        data[o++] = res[0]!;
        data[o++] = res[1]!;
        data[o++] = Math.round(res[2]! * 255);
        data[o++] = 0;
      }
    }
  }
  return { size, data };
}

/** LUT node index for sRGB values in 0..1 — MUST match the shader's `(rgb*(size-1)+0.5)/size` nearest-node fetch. */
export function lutNode(size: number, sr: number, sg: number, sb: number): number {
  const q = (v: number): number => Math.min(size - 1, Math.max(0, Math.floor(v * (size - 1) + 0.5)));
  return ((q(sb) * size + q(sg)) * size + q(sr)) * 4;
}

/**
 * CPU reference of the shader's per-pixel decision (see `dither.frag`): LUT pair + exact per-pixel ratio + Bayer
 * threshold ⇒ palette index. `lr,lg,lb` are the tone-mapped LINEAR colour in 0..1; `threshold` ∈ (0,1).
 */
export function ditherToIndex(
  pal: PaletteData,
  lut: DitherLut,
  lr: number,
  lg: number,
  lb: number,
  threshold: number,
): number {
  const c = (v: number): number => linearToSrgb(Math.min(1, Math.max(0, v)));
  const o = lutNode(lut.size, c(lr), c(lg), c(lb));
  const a = lut.data[o]!;
  const b = lut.data[o + 1]!;
  if (a === b) return a;
  const lin = pal.linear;
  const dr = lin[b * 3]! - lin[a * 3]!;
  const dg = lin[b * 3 + 1]! - lin[a * 3 + 1]!;
  const db = lin[b * 3 + 2]! - lin[a * 3 + 2]!;
  const len2 = dr * dr + dg * dg + db * db;
  let r = len2 > 1e-9 ? ((lr - lin[a * 3]!) * dr + (lg - lin[a * 3 + 1]!) * dg + (lb - lin[a * 3 + 2]!) * db) / len2 : 0;
  r = r < 0 ? 0 : r > 1 ? 1 : r;
  return threshold < r ? b : a;
}

/** Palette as a PALETTE_TEX_W×1 RGBA8 buffer (sRGB) and a matching RGBA32F buffer of linear values for the shader. */
export function paletteTextures(pal: PaletteData): { srgb8: Uint8Array; linear32: Float32Array } {
  const srgb8 = new Uint8Array(PALETTE_TEX_W * 4);
  const linear32 = new Float32Array(PALETTE_TEX_W * 4);
  for (let i = 0; i < PALETTE_TEX_W; i++) {
    const s = Math.min(i, pal.count - 1);
    for (let k = 0; k < 3; k++) {
      srgb8[i * 4 + k] = pal.srgb[s * 3 + k]!;
      linear32[i * 4 + k] = pal.linear[s * 3 + k]!;
    }
    srgb8[i * 4 + 3] = 255;
    linear32[i * 4 + 3] = 1;
  }
  return { srgb8, linear32 };
}
