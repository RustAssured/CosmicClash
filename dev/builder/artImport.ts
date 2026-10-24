import type { MaterialSpec, TitanKind } from '@/contracts';
import { MATERIAL_ARCHETYPES } from '@/matter/archetypes';
import { encodeCells, type ImageBody } from '@/titans/kit/image';
import { KIND_PRESETS } from '@/titans/kit/kinds';

/**
 * KEY ART → PIXEL MATTER (the titan builder's "Import art"): the authoring half of the image painter
 * (src/titans/kit/image.ts). It works on a working copy of the art (`Source`) and a creature mask the user shapes with a
 * lasso, a brush and background samples, then:
 *
 *  1. crops to the mask and scales it to the titan's size (area average of the masked pixels, ≥ half covered = solid),
 *     keeping only the largest 4-connected piece (a body is one piece of matter);
 *  2. groups the colours into materials (k-means in OKLab, chroma weighted, deterministic), smoothed by a majority filter
 *     so materials form regions (their seams are where the body breaks), plus a solid `core` disc at the chosen point;
 *  3. builds each material's ramp from its own pixels (lightness quantiles, dark → light) and stores each cell's level
 *     within it, so the painter shows the art's shading in the material's colours;
 *  4. names the materials by colour and gives them physics archetypes from the titan's kind (outer → skin, then flesh,
 *     the brightest saturated one glows like a marking, the core like the kind's core).
 */

export interface Source {
  w: number;
  h: number;
  /** RGBA bytes. */
  rgba: Uint8ClampedArray;
  /** OKLab per pixel (L, a, b). */
  lab: Float32Array;
}

/* ------------------------------------------------------------------------------------------------ colour */

const lin = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const gam = (v: number): number => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};
const LIN = Float32Array.from({ length: 256 }, (_, i) => lin(i));

function toLab(r: number, g: number, b: number, out: Float32Array, o: number): void {
  const R = LIN[r]!;
  const G = LIN[g]!;
  const B = LIN[b]!;
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  out[o] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[o + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

function labHex(L: number, a: number, b: number): string {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  const r = gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const bl = gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return '#' + [r, g, bl].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** A working copy of the art: at most `maxSide` px on its long side. */
export function makeSource(
  img: CanvasImageSource & { width: number; height: number },
  maxSide = 900,
): Source {
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const lab = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) toLab(rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!, lab, i * 3);
  return { w, h, rgba, lab };
}

/* ------------------------------------------------------------------------------------------------ the mask */

/** Fill (value 1) or cut (0) a polygon into the mask (even-odd scanline fill). */
export function fillPolygon(
  mask: Uint8Array,
  w: number,
  h: number,
  pts: [number, number][],
  value: 0 | 1,
): void {
  if (pts.length < 3) return;
  const xs: number[] = [];
  for (let y = 0; y < h; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [x0, y0] = pts[j]!;
      const [x1, y1] = pts[i]!;
      if (y0 <= cy !== y1 <= cy) xs.push(x0 + ((cy - y0) / (y1 - y0)) * (x1 - x0));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k]! - 0.5));
      const b = Math.min(w - 1, Math.floor(xs[k + 1]! - 0.5));
      for (let x = a; x <= b; x++) mask[y * w + x] = value;
    }
  }
}

export function brush(
  mask: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  r: number,
  value: 0 | 1,
): void {
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++)
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) mask[y * w + x] = value;
}

/** Keep only the largest 4-connected piece of a mask. */
export function keepLargest(mask: Uint8Array, w: number, h: number): void {
  const label = new Int32Array(w * h);
  const stack: number[] = [];
  let best = 0;
  let bestSize = 0;
  let next = 0;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s]) continue;
    next++;
    let size = 0;
    label[s] = next;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % w;
      for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1])
        if (j >= 0 && j < mask.length && mask[j] && !label[j]) {
          label[j] = next;
          stack.push(j);
        }
    }
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
  }
  for (let i = 0; i < mask.length; i++) if (mask[i] && label[i] !== best) mask[i] = 0;
}

/** Fill the holes of a mask (empty regions that do not reach the border). */
export function fillHoles(mask: Uint8Array, w: number, h: number): void {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const seed = (i: number): void => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (i >= w) seed(i - w);
    if (i < w * (h - 1)) seed(i + w);
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
  }
  for (let i = 0; i < mask.length; i++) if (!outside[i]) mask[i] = 1;
}

/** Distance (px, 8-neighbour chamfer) from every masked pixel to the nearest unmasked one. */
function chamfer(mask: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  const INF = 1e9;
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
  const D = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i]!;
      v = Math.min(v, x > 0 ? d[i - 1]! + 1 : 1, y > 0 ? d[i - w]! + 1 : 1);
      v = Math.min(v, x > 0 && y > 0 ? d[i - w - 1]! + D : 1, x < w - 1 && y > 0 ? d[i - w + 1]! + D : 1);
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i]!;
      v = Math.min(v, x < w - 1 ? d[i + 1]! + 1 : 1, y < h - 1 ? d[i + w]! + 1 : 1);
      v = Math.min(
        v,
        x < w - 1 && y < h - 1 ? d[i + w + 1]! + D : 1,
        x > 0 && y < h - 1 ? d[i + w - 1]! + D : 1,
      );
      d[i] = v;
    }
  return d;
}

/** The most interior point of a mask (a good default core). */
export function interiorPoint(mask: Uint8Array, w: number, h: number): { x: number; y: number } {
  const d = chamfer(mask, w, h);
  let best = 0;
  for (let i = 1; i < d.length; i++) if (d[i]! > d[best]!) best = i;
  return { x: best % w, y: Math.floor(best / w) };
}

/**
 * Cut the background out of the mask by colour: a masked pixel goes when its colour is nearer the background samples than
 * the creature's own colours (sampled deep inside the mask), weighted by `strength` (0.5 timid … 2 aggressive). Uses a
 * 32³ OKLab lookup so a megapixel takes a moment, not seconds. Then keeps the largest piece.
 */
export function cutBackground(
  src: Source,
  mask: Uint8Array,
  bg: readonly { x: number; y: number }[],
  strength: number,
): void {
  const { w, h, lab } = src;
  if (!bg.length) return;
  const d = chamfer(mask, w, h);
  const fg: number[] = [];
  const deep = Math.max(4, Math.min(w, h) * 0.02);
  for (let i = 0, k = 0; i < d.length; i++) if (d[i]! >= deep && k++ % 37 === 0) fg.push(i);
  const bgPix: number[] = [];
  for (const p of bg)
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const x = Math.round(p.x) + dx;
        const y = Math.round(p.y) + dy;
        if (x >= 0 && y >= 0 && x < w && y < h) bgPix.push(y * w + x);
      }
  const feat = (i: number): [number, number, number] => [
    lab[i * 3]!,
    lab[i * 3 + 1]! * 2,
    lab[i * 3 + 2]! * 2,
  ];
  const F = fg.map(feat);
  const B = bgPix.map(feat);
  const near = (set: [number, number, number][], L: number, a: number, b: number): number => {
    let best = Infinity;
    for (const s of set) {
      const q = (s[0] - L) * (s[0] - L) + (s[1] - a) * (s[1] - a) + (s[2] - b) * (s[2] - b);
      if (q < best) best = q;
    }
    return Math.sqrt(best);
  };
  // the lookup: is this colour background? (L 0..1, a/b −0.4..0.4, doubled)
  const N = 32;
  const lut = new Int8Array(N * N * N).fill(-1);
  const bin = (L: number, a: number, b: number): number => {
    const li = Math.max(0, Math.min(N - 1, Math.floor(L * N)));
    const ai = Math.max(0, Math.min(N - 1, Math.floor(((a + 0.8) / 1.6) * N)));
    const bi = Math.max(0, Math.min(N - 1, Math.floor(((b + 0.8) / 1.6) * N)));
    return (li * N + ai) * N + bi;
  };
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    const [L, a, b] = feat(i);
    const k = bin(L, a, b);
    if (lut[k] === -1) lut[k] = near(B, L, a, b) * strength < near(F, L, a, b) ? 1 : 0;
    if (lut[k] === 1) mask[i] = 0;
  }
  keepLargest(mask, w, h);
}

/** A first mask without any input: everything that does not look like the border's colours, the piece at the centre. */
export function autoMask(src: Source, strength = 1): Uint8Array {
  const { w, h } = src;
  const mask = new Uint8Array(w * h);
  // start from an ellipse filling the middle of the frame, then let the border's colours eat into it
  const pts: [number, number][] = [];
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    pts.push([w / 2 + Math.cos(a) * w * 0.46, h / 2 + Math.sin(a) * h * 0.46]);
  }
  fillPolygon(mask, w, h, pts, 1);
  const bg: { x: number; y: number }[] = [];
  const step = Math.max(8, Math.round((w + h) / 60));
  for (let x = 2; x < w; x += step) bg.push({ x, y: 2 }, { x, y: h - 3 });
  for (let y = 2; y < h; y += step) bg.push({ x: 2, y }, { x: w - 3, y });
  cutBackground(src, mask, bg, strength);
  return mask;
}

/* ------------------------------------------------------------------------------------------------ conversion */

export interface ConvertOptions {
  /** The body's longest side at game size (px). */
  target: number;
  /** Materials besides the core (2–10). */
  materials: number;
  /** The core: centre in source px and radius in game px. */
  core: { x: number; y: number };
  coreR: number;
  kind: TitanKind;
  /** Ramp steps per material (5–8). */
  steps: number;
  /** Kuwahara radius (working px, 0 = off): flattens painterly texture into clean regions before the downscale. */
  simplify: number;
  /** Colourfulness of the ramps (1 = as painted). */
  vibrance: number;
  /**
   * 0 = materials are colour groups, 1 = materials are regions: clustered by the colour of their surroundings, so they
   * follow the anatomy (shell, membrane, vortex) and each region's ramp carries its colours from dark to light. Region
   * materials matter in a fight: the matter world weakens every bond between two different materials.
   */
  structure: number;
  /** At most this many vein materials (0–3): strongly coloured streaks their region's ramp cannot show, glowing. */
  veins: number;
}

/** Box blur of the cell colours over solid cells only (the surroundings' colour, for region clustering). */
function regionColour(col: Float32Array, solid: Uint8Array, W: number, H: number, r: number): Float32Array {
  const out = new Float32Array(col.length);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!solid[i]) continue;
      let n = 0;
      let L = 0;
      let a = 0;
      let b = 0;
      for (let yy = Math.max(0, y - r); yy <= Math.min(H - 1, y + r); yy++)
        for (let xx = Math.max(0, x - r); xx <= Math.min(W - 1, x + r); xx++) {
          const j = yy * W + xx;
          if (!solid[j]) continue;
          n++;
          L += col[j * 3]!;
          a += col[j * 3 + 1]!;
          b += col[j * 3 + 2]!;
        }
      out.set([L / n, a / n, b / n], i * 3);
    }
  return out;
}

/** The dominant (a, b) of a set of cells: split by hue into two groups and take the bigger one's mean (no grey averages). */
function dominantAB(cells: number[], col: Float32Array): [number, number] {
  let a0 = 0;
  let b0 = 0;
  for (const c of cells) {
    a0 += col[c * 3 + 1]!;
    b0 += col[c * 3 + 2]!;
  }
  a0 /= cells.length;
  b0 /= cells.length;
  // the axis of the widest hue spread, then the bigger side of it
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const c of cells) {
    const da = col[c * 3 + 1]! - a0;
    const db = col[c * 3 + 2]! - b0;
    sxx += da * da;
    sxy += da * db;
    syy += db * db;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const side = [
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const c of cells) {
    const a = col[c * 3 + 1]!;
    const b = col[c * 3 + 2]!;
    const k = (a - a0) * ux + (b - b0) * uy >= 0 ? 0 : 1;
    side[k]![0]! += a;
    side[k]![1]! += b;
    side[k]![2]!++;
  }
  const big = side[0]![2]! >= side[1]![2]! ? side[0]! : side[1]!;
  // a clear split (two hues) takes the bigger hue; a single hue keeps the mean
  const spread = Math.sqrt((sxx + syy) / cells.length);
  return spread > 0.03 && big[2]! > 0 ? [big[0]! / big[2]!, big[1]! / big[2]!] : [a0, b0];
}

const simplified = new WeakMap<Source, Map<number, Float32Array>>();

/**
 * The Kuwahara filter: each pixel takes the mean colour of the least varied of the four quadrants around it (by
 * lightness), which flattens texture while keeping edges: painterly art becomes the clean regions pixel art is made of.
 * Summed-area tables make it O(1) a pixel. Cached per source and radius.
 */
export function kuwahara(src: Source, r: number): Float32Array {
  if (r < 1) return src.lab;
  let byR = simplified.get(src);
  if (!byR) simplified.set(src, (byR = new Map()));
  const hit = byR.get(r);
  if (hit) return hit;
  const { w, h, lab } = src;
  const W1 = w + 1;
  const sat = [0, 1, 2, 3].map(() => new Float64Array(W1 * (h + 1)));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const L = lab[i * 3]!;
      const vals = [L, L * L, lab[i * 3 + 1]!, lab[i * 3 + 2]!];
      const o = (y + 1) * W1 + x + 1;
      for (let c = 0; c < 4; c++)
        sat[c]![o] = vals[c]! + sat[c]![o - 1]! + sat[c]![o - W1]! - sat[c]![o - W1 - 1]!;
    }
  const sum = (c: number, x0: number, y0: number, x1: number, y1: number): number => {
    const t = sat[c]!;
    return t[y1 * W1 + x1]! - t[y0 * W1 + x1]! - t[y1 * W1 + x0]! + t[y0 * W1 + x0]!;
  };
  const out = new Float32Array(lab.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let best = Infinity;
      let L = 0;
      let a = 0;
      let b = 0;
      for (const [qx0, qy0] of [
        [x - r, y - r],
        [x, y - r],
        [x - r, y],
        [x, y],
      ] as const) {
        const x0 = Math.max(0, qx0);
        const y0 = Math.max(0, qy0);
        const x1 = Math.min(w, qx0 + r + 1);
        const y1 = Math.min(h, qy0 + r + 1);
        const n = (x1 - x0) * (y1 - y0);
        if (n <= 0) continue;
        const mL = sum(0, x0, y0, x1, y1) / n;
        const v = sum(1, x0, y0, x1, y1) / n - mL * mL;
        if (v < best) {
          best = v;
          L = mL;
          a = sum(2, x0, y0, x1, y1) / n;
          b = sum(3, x0, y0, x1, y1) / n;
        }
      }
      out.set([L, a, b], (y * w + x) * 3);
    }
  byR.set(r, out);
  return out;
}

export interface Converted {
  body: ImageBody;
  materials: MaterialSpec[];
  /** Suggested accent pair (the two most colourful materials' bright steps). */
  accent: [string, string];
  /** Body size at game scale. */
  w: number;
  h: number;
}

const HUES: [number, string][] = [
  [20, 'red'],
  [55, 'orange'],
  [95, 'gold'],
  [150, 'green'],
  [200, 'teal'],
  [255, 'blue'],
  [300, 'violet'],
  [345, 'magenta'],
  [361, 'red'],
];

function colourName(L: number, a: number, b: number): string {
  const C = Math.hypot(a, b);
  if (L < 0.22) return 'dark';
  if (C < 0.035) return L > 0.75 ? 'pale' : 'grey';
  const deg = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  const hue = HUES.find(([lim]) => deg < lim)![1];
  return L > 0.78 ? `pale${hue}` : hue;
}

/** Deterministic k-means in OKLab (a/b weighted ×2), seeded by farthest-point initialisation. */
function kmeans(pts: Float32Array, n: number, k: number): { label: Uint8Array; centres: Float32Array } {
  const centres = new Float32Array(k * 3);
  const dist2 = (i: number, c: number): number => {
    const dL = pts[i * 3]! - centres[c * 3]!;
    const da = (pts[i * 3 + 1]! - centres[c * 3 + 1]!) * 2;
    const db = (pts[i * 3 + 2]! - centres[c * 3 + 2]!) * 2;
    return dL * dL + da * da + db * db;
  };
  // first centre: the mean; the rest: the point farthest from every centre so far
  let mL = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    mL += pts[i * 3]!;
    ma += pts[i * 3 + 1]!;
    mb += pts[i * 3 + 2]!;
  }
  centres.set([mL / n, ma / n, mb / n], 0);
  const nearest = new Float32Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let far = 0;
    for (let i = 0; i < n; i++) {
      nearest[i] = Math.min(nearest[i]!, dist2(i, c - 1));
      if (nearest[i]! > nearest[far]!) far = i;
    }
    centres.set([pts[far * 3]!, pts[far * 3 + 1]!, pts[far * 3 + 2]!], c * 3);
  }
  const label = new Uint8Array(n);
  for (let it = 0; it < 16; it++) {
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(i, c);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      label[i] = best;
    }
    const sum = new Float64Array(k * 4);
    for (let i = 0; i < n; i++) {
      const c = label[i]!;
      sum[c * 4] += pts[i * 3]!;
      sum[c * 4 + 1] += pts[i * 3 + 1]!;
      sum[c * 4 + 2] += pts[i * 3 + 2]!;
      sum[c * 4 + 3]++;
    }
    for (let c = 0; c < k; c++)
      if (sum[c * 4 + 3])
        centres.set(
          [0, 1, 2].map((j) => sum[c * 4 + j]! / sum[c * 4 + 3]!),
          c * 3,
        );
  }
  return { label, centres };
}

export function convert(src: Source, mask: Uint8Array, o: ConvertOptions): Converted {
  const { w: SW, h: SH } = src;
  const lab = kuwahara(src, Math.round(o.simplify));
  const vib = o.vibrance;
  // 1. crop and scale
  let x0 = SW;
  let y0 = SH;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < SH; y++)
    for (let x = 0; x < SW; x++)
      if (mask[y * SW + x]) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  if (x1 < 0) throw new Error('the mask is empty: mark the creature first');
  const k = o.target / Math.max(x1 - x0 + 1, y1 - y0 + 1);
  const PAD = 4;
  const bw = Math.ceil((x1 - x0 + 1) * k);
  const bh = Math.ceil((y1 - y0 + 1) * k);
  const W = bw + PAD * 2;
  const H = bh + PAD * 2;
  if (W > 300 || H > 300)
    throw new Error(`${W}×${H} cells: the matter map is at most 300×300 (lower the size)`);
  const solid = new Uint8Array(W * H);
  const col = new Float32Array(W * H * 3);
  for (let gy = 0; gy < bh; gy++)
    for (let gx = 0; gx < bw; gx++) {
      const sx0 = x0 + Math.floor(gx / k);
      const sx1 = Math.max(sx0 + 1, x0 + Math.floor((gx + 1) / k));
      const sy0 = y0 + Math.floor(gy / k);
      const sy1 = Math.max(sy0 + 1, y0 + Math.floor((gy + 1) / k));
      let n = 0;
      let m = 0;
      let L = 0;
      let a = 0;
      let b = 0;
      for (let sy = sy0; sy < Math.min(sy1, SH); sy++)
        for (let sx = sx0; sx < Math.min(sx1, SW); sx++) {
          n++;
          const i = sy * SW + sx;
          if (!mask[i]) continue;
          m++;
          L += lab[i * 3]!;
          a += lab[i * 3 + 1]!;
          b += lab[i * 3 + 2]!;
        }
      if (!m || m * 2 < n) continue;
      const c = (gy + PAD) * W + gx + PAD;
      solid[c] = 1;
      col.set([L / m, a / m, b / m], c * 3);
    }
  // the core: a solid disc at the chosen point (filled from its surroundings if the art has a hole there)
  const cx = (o.core.x - x0) * k + PAD;
  const cy = (o.core.y - y0) * k + PAD;
  const R = o.coreR;
  const inCore = (x: number, y: number): boolean => (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= R * R;
  for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(H - 1, Math.ceil(cy + R)); y++)
    for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(W - 1, Math.ceil(cx + R)); x++)
      if (inCore(x, y) && !solid[y * W + x]) {
        solid[y * W + x] = 1;
        col.set([0.12, 0, 0], (y * W + x) * 3);
      }
  keepLargest(solid, W, H);
  if (!solid[Math.round(cy) * W + Math.round(cx)])
    throw new Error('the core is outside the body: place it on the creature');

  // 2. materials: k-means over the body (not the core), then a majority filter
  const idx: number[] = [];
  for (let i = 0; i < W * H; i++) if (solid[i] && !inCore(i % W, Math.floor(i / W))) idx.push(i);
  // features: the cell's colour blended with its surroundings' (structure 1 = regions, 0 = colours)
  const st = Math.max(0, Math.min(1, o.structure));
  const around = regionColour(col, solid, W, H, Math.max(3, Math.round(Math.max(W, H) / 28)));
  const pts = new Float32Array(idx.length * 3);
  idx.forEach((c, j) => {
    for (let q = 0; q < 3; q++) pts[j * 3 + q] = col[c * 3 + q]! * (1 - st) + around[c * 3 + q]! * st;
  });
  const K = Math.max(2, Math.min(10, o.materials));
  const km = kmeans(pts, idx.length, K);
  const label = new Int16Array(W * H).fill(-1);
  idx.forEach((c, j) => (label[c] = km.label[j]!));
  for (let pass = 0; pass < 2; pass++) {
    const next = label.slice();
    const votes = new Int32Array(K);
    for (const c of idx) {
      votes.fill(0);
      const x = c % W;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const j = c + dy * W + dx;
          if (x + dx < 0 || x + dx >= W || j < 0 || j >= W * H || label[j]! < 0) continue;
          votes[label[j]!]++;
        }
      let best = label[c]!;
      for (let q = 0; q < K; q++) if (votes[q]! > votes[best]! + 1) best = q;
      next[c] = best;
    }
    label.set(next);
  }

  // 3. ramps from each material's own lightness quantiles; each cell's level within its ramp
  const dist = chamfer(solid, W, H);
  interface Group {
    cells: number[];
    ramp: string[];
    rampL: number[];
    meanL: number;
    chroma: number;
    depth: number;
    name: string;
    /** The ramp steps' (a, b) before vibrance: what the region can show at each lightness. */
    rampAB: [number, number][];
    vein: boolean;
  }
  const groups: Group[] = [];
  const build = (cells: number[], steps: number): Group => {
    const sorted = cells.slice().sort((p, q) => col[p * 3]! - col[q * 3]!);
    const ramp: string[] = [];
    const rampL: number[] = [];
    const rampAB: [number, number][] = [];
    let Ls = 0;
    let As = 0;
    let Bs = 0;
    for (let s = 0; s < steps; s++) {
      const lo = Math.floor((s / steps) * sorted.length);
      const hi = Math.max(lo + 1, Math.floor(((s + 1) / steps) * sorted.length));
      let L = 0;
      for (let j = lo; j < hi; j++) L += col[sorted[j]! * 3]!;
      const n = hi - lo;
      const [a, b] = dominantAB(sorted.slice(lo, hi), col).map((v) => v * n);
      // keep the steps apart so the ramp reads as steps (a flat cluster would give near-identical colours)
      const Lq = Math.max(L / n, (rampL[s - 1] ?? -1) + 0.035);
      rampL.push(Lq);
      rampAB.push([a! / n, b! / n]);
      ramp.push(labHex(Math.min(0.98, Lq), (a! / n) * vib, (b! / n) * vib));
      Ls += L;
      As += a!;
      Bs += b!;
    }
    const n = cells.length;
    let depth = 0;
    for (const c of cells) depth += dist[c]!;
    return {
      cells,
      ramp,
      rampL,
      meanL: Ls / n,
      chroma: Math.hypot(As / n, Bs / n),
      depth: depth / n,
      name: colourName(Ls / n, As / n, Bs / n),
      rampAB,
      vein: false,
    };
  };
  for (let q = 0; q < K; q++) {
    const cells = idx.filter((c) => label[c] === q);
    if (cells.length) groups.push(build(cells, o.steps));
  }

  // veins: strongly coloured cells their region's ramp cannot show (the green ichor running through a violet region)
  // become their own glowing materials; isolated specks stay in their region
  const veins: Group[] = [];
  if (o.veins > 0) {
    const off: number[] = [];
    for (const g of groups)
      for (const c of g.cells) {
        const L = col[c * 3]!;
        const a = col[c * 3 + 1]!;
        const b = col[c * 3 + 2]!;
        let s = 0;
        for (let q = 1; q < g.rampL.length; q++)
          if (Math.abs(g.rampL[q]! - L) < Math.abs(g.rampL[s]! - L)) s = q;
        const [ra, rb] = g.rampAB[s]!;
        if (Math.hypot(a, b) > 0.06 && Math.hypot(a - ra, b - rb) > 0.07) off.push(c);
      }
    const isOff = new Uint8Array(W * H);
    for (const c of off) isOff[c] = 1;
    const kept = off.filter((c) => {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && isOff[c + dy * W + dx]) n++;
      return n >= 3;
    });
    if (kept.length >= 40) {
      const vp = new Float32Array(kept.length * 3);
      kept.forEach((c, j) => vp.set(col.subarray(c * 3, c * 3 + 3), j * 3));
      const vk = kmeans(vp, kept.length, Math.min(3, Math.round(o.veins)));
      const taken = new Set<number>();
      for (let q = 0; q < Math.min(3, Math.round(o.veins)); q++) {
        const cells = kept.filter((_, j) => vk.label[j] === q);
        if (cells.length < 24) continue;
        for (const c of cells) taken.add(c);
        veins.push({ ...build(cells, Math.min(6, o.steps)), vein: true });
      }
      for (let q = 0; q < groups.length; q++) {
        const rest = groups[q]!.cells.filter((c) => !taken.has(c));
        if (rest.length >= 24) groups[q] = build(rest, o.steps);
      }
    }
  }
  // outer → inner: the outermost region is the skin; the veins follow the regions
  groups.sort((p, q) => p.depth - q.depth);
  groups.push(...veins);
  const coreCells: number[] = [];
  for (let i = 0; i < W * H; i++) if (solid[i] && inCore(i % W, Math.floor(i / W))) coreCells.push(i);
  const core = build(coreCells, Math.min(6, o.steps));
  core.name = 'core';

  // 4. names, archetypes, glow
  const preset = KIND_PRESETS[o.kind].materials;
  const used = new Map<string, number>();
  const unique = (n: string): string => {
    const c = (used.get(n) ?? 0) + 1;
    used.set(n, c);
    return c === 1 ? n : `${n}${c}`;
  };
  // without veins, the most colourful region glows like a marking
  const glowiest = veins.length
    ? -1
    : groups.reduce(
        (best, g, i) => (g.chroma * g.meanL > groups[best]!.chroma * groups[best]!.meanL ? i : best),
        0,
      );
  const materials: MaterialSpec[] = groups.map((g, i) => {
    const glow = g.vein || i === glowiest;
    const role = i === 0 ? preset.skin : glow ? preset.marking : preset.flesh;
    const base = MATERIAL_ARCHETYPES[role.base] ? role.base : 'rock';
    const emissive = glow ? Math.round(Math.min(45, g.chroma * 180)) : 0;
    return {
      key: unique(g.name),
      base,
      visual: {
        ramp: g.ramp,
        emissive,
        char: g.ramp[1]!,
        crack: g.ramp[0]!,
        debris: g.ramp[Math.floor(g.ramp.length / 2)]!,
      },
    };
  });
  materials.push({
    key: 'core',
    base: preset.core.base,
    physics: { density: 3, toughness: 0.9 },
    visual: {
      ramp: core.ramp,
      emissive: 60,
      char: core.ramp[1]!,
      crack: core.ramp[0]!,
      debris: core.ramp[2]!,
    },
  });

  const mat = new Uint8Array(W * H);
  const level = new Uint8Array(W * H);
  const all = [...groups, core];
  all.forEach((g, gi) => {
    for (const c of g.cells) {
      if (!solid[c]) continue;
      mat[c] = gi + 1;
      const L = col[c * 3]!;
      const r = g.rampL;
      let f = 0;
      if (L >= r[r.length - 1]!) f = r.length - 1;
      else if (L > r[0]!)
        for (let s = 0; s + 1 < r.length; s++)
          if (L <= r[s + 1]!) {
            f = s + (L - r[s]!) / (r[s + 1]! - r[s]!);
            break;
          }
      level[c] = Math.round((f / (r.length - 1)) * 15);
    }
  });

  const byColour = groups
    .map((g, i) => ({ c: g.chroma, hex: g.ramp[g.ramp.length - 2]!, i }))
    .sort((p, q) => q.c - p.c);
  const accent: [string, string] = [byColour[0]?.hex ?? '#888888', byColour[1]?.hex ?? '#cccccc'];

  return {
    body: {
      version: 1,
      w: W,
      h: H,
      cells: encodeCells(mat, level),
      core: { x: Math.round(cx * 10) / 10, y: Math.round(cy * 10) / 10, r: R },
    },
    materials,
    accent,
    w: bw,
    h: bh,
  };
}
