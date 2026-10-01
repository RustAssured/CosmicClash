/**
 * Shared offline helpers for the Witness sheets and motion strips (tools only): compose the region bodies at given poses
 * (nearest-neighbour rotation — fine offline; the game will use the shared rotated masks of D27), draw the runtime membranes,
 * fibres and arm splines over them, make thumbnails, and paint the Planet for scale.
 */
import { existsSync, readFileSync } from 'node:fs';
import { hex, type StageLighting, type TitanDef } from '@/contracts';
import { generateTitanBody } from '@/titans/generate';
import type { WitnessAnchor, WitnessBody, WitnessRegion } from '@/titans/art/lastone';
import { Overlay } from '@/combat/fx/overlay';
import type { SplineStyle } from '@/combat/fx/spline';
import { WitnessSoftPen, type MembraneStyle } from '@/combat/rig/witnessDraw';
import type { SheetItem } from '../lead/png';

export interface Pose {
  /** World position of the region's frame origin (its pivot) and its angle (rad). */
  x: number;
  y: number;
  a: number;
}

export const MEMBRANE: MembraneStyle = {
  fill0: hex('#0f1c1a'),
  fill1: hex('#1a2f2a'),
  edge: hex('#5a7f63'),
  edgeHot: hex('#cdf6f2'),
  emissiveHot: 180,
};

export const FIBRE: SplineStyle = {
  r0: 0.75,
  r1: 0.55,
  taperPow: 1,
  ramp: ['#3d8d96', '#7fd2d6', '#cdf6f2'].map(hex),
  rootShade: 0,
  contrast: 0.6,
  tipRamp: null,
  tipFrom: 1,
  tipEmissive: 0,
  jointEvery: 0,
  jointBulge: 0,
  outlineDark: 0,
  outlineLit: 0,
};

/** The rest pose of every region (its frame at its pivot, angle 0). */
export const restPoses = (w: WitnessBody): Pose[] =>
  w.regions.map((r) => ({ x: r.pivotX, y: r.pivotY, a: 0 }));

/** World position of a body-coordinate anchor carried by its region's pose. */
export function anchorAt(
  w: WitnessBody,
  poses: readonly Pose[],
  an: WitnessAnchor,
): { x: number; y: number } {
  const r = w.regions[an.region]!;
  const p = poses[an.region]!;
  const lx = an.x - r.pivotX;
  const ly = an.y - r.pivotY;
  const c = Math.cos(p.a);
  const s = Math.sin(p.a);
  return { x: p.x + c * lx - s * ly, y: p.y + s * lx + c * ly };
}

export interface ComposeOpts {
  /** World window: top-left and size. */
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** Remove the cells of reveal layers < cut inside `cutWedge` (0 = intact). */
  cut?: number;
  cutWedge?: (x: number, y: number) => boolean;
  /** Draw membranes and fibres (between the halo/arms and the shrine/carapace in draw order). */
  soft?: boolean;
  lighting: StageLighting;
}

/** Draw one region at a pose into `px` (nearest-neighbour inverse rotation of its map). */
function drawRegion(
  r: WitnessRegion,
  p: Pose,
  o: ComposeOpts,
  px: Uint32Array,
  skip: ((wx: number, wy: number) => boolean) | null,
): void {
  const m = r.map;
  const c = Math.cos(p.a);
  const s = Math.sin(p.a);
  const plx = r.pivotX - r.ox;
  const ply = r.pivotY - r.oy;
  // rotated bounding box of the map rectangle
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (const [cx, cy] of [
    [0, 0],
    [m.w, 0],
    [0, m.h],
    [m.w, m.h],
  ] as const) {
    const lx = cx - plx;
    const ly = cy - ply;
    const wx = p.x + c * lx - s * ly;
    const wy = p.y + s * lx + c * ly;
    bx0 = Math.min(bx0, wx);
    by0 = Math.min(by0, wy);
    bx1 = Math.max(bx1, wx);
    by1 = Math.max(by1, wy);
  }
  for (let y = Math.floor(by0); y <= Math.ceil(by1); y++) {
    const iy = y - o.y0;
    if (iy < 0 || iy >= o.h) continue;
    for (let x = Math.floor(bx0); x <= Math.ceil(bx1); x++) {
      const ix = x - o.x0;
      if (ix < 0 || ix >= o.w) continue;
      const dx = x + 0.5 - p.x;
      const dy = y + 0.5 - p.y;
      const lx = Math.floor(c * dx + s * dy + plx);
      const ly = Math.floor(-s * dx + c * dy + ply);
      if (lx < 0 || ly < 0 || lx >= m.w || ly >= m.h) continue;
      const i = ly * m.w + lx;
      if (m.material[i] === 0) continue;
      if (skip && skip(lx + r.ox + 0.5, ly + r.oy + 0.5)) continue;
      px[iy * o.w + ix] = m.baseColor[i]!;
    }
  }
}

/** Composite the Witness at the given region poses (with optional soft structure and cutaways). */
export function compose(w: WitnessBody, poses: readonly Pose[], o: ComposeOpts): SheetItem {
  const px = new Uint32Array(o.w * o.h);
  const order = w.regions.map((r, i) => ({ r, i })).sort((a, b) => a.r.z - b.r.z || a.i - b.i);
  let softDone = false;
  for (const { r, i } of order) {
    if (o.soft && !softDone && r.z >= 3) {
      drawSoft(w, poses, o, px);
      softDone = true;
    }
    const skip =
      o.cut && o.cutWedge && r.layer >= 0 && r.layer < o.cut
        ? (x: number, y: number) => o.cutWedge!(x, y)
        : null;
    drawRegion(r, poses[i]!, o, px, skip);
  }
  return { pixels: px, w: o.w, h: o.h };
}

/** Membranes and fibres (the runtime pen) at the current poses, written into the composite. */
function drawSoft(w: WitnessBody, poses: readonly Pose[], o: ComposeOpts, px: Uint32Array): void {
  const ov = new Overlay('soft', 0, o.w, o.h, 'normal', true);
  const sp = new WitnessSoftPen(o.w, o.h);
  sp.setLight(o.lighting.dir);
  ov.begin(o.x0 + (o.w >> 1), o.y0 + (o.h >> 1));
  const rest = restPoses(w);
  for (const [a, b, c] of w.membranes) {
    const pa = anchorAt(w, poses, a);
    const pb = anchorAt(w, poses, b);
    const pc = anchorAt(w, poses, c);
    const rb = anchorAt(w, rest, b);
    const rcp = anchorAt(w, rest, c);
    sp.membrane(ov, pa.x, pa.y, pb.x, pb.y, pc.x, pc.y, Math.hypot(rcp.x - rb.x, rcp.y - rb.y), 0, MEMBRANE);
  }
  for (const [a, b] of w.fibres) {
    const pa = anchorAt(w, poses, a);
    const pb = anchorAt(w, poses, b);
    const ra = anchorAt(w, rest, a);
    const rb = anchorAt(w, rest, b);
    sp.fibre(ov, pa.x, pa.y, pb.x, pb.y, Math.hypot(rb.x - ra.x, rb.y - ra.y) * 1.08, 0, FIBRE);
  }
  ov.end();
  for (let y = 0; y < o.h; y++)
    for (let x = 0; x < o.w; x++) {
      const c = ov.layer.pixels[y * o.w + x]!;
      if (c >>> 24 === 0) continue;
      const ix = x + ov.ox - o.x0;
      const iy = y + ov.oy - o.y0;
      if (ix >= 0 && iy >= 0 && ix < o.w && iy < o.h) px[iy * o.w + ix] = c;
    }
}

/** Box-filter downscale so the longest side is `target` px (as tools/titans/sheet.ts does for the roster). */
export function thumbnail(src: SheetItem, target: number): SheetItem {
  const k = target / Math.max(src.w, src.h);
  const w = Math.max(1, Math.round(src.w * k));
  const h = Math.max(1, Math.round(src.h * k));
  const pixels = new Uint32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x / k);
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) / k));
      const sy0 = Math.floor(y / k);
      const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) / k));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < Math.min(src.h, sy1); sy++)
        for (let sx = sx0; sx < Math.min(src.w, sx1); sx++) {
          const c = src.pixels[sy * src.w + sx]!;
          n++;
          if (c >>> 24 === 0) continue;
          r += c & 255;
          g += (c >>> 8) & 255;
          b += (c >>> 16) & 255;
          a++;
        }
      if (a === 0 || a / n < 0.4) continue;
      pixels[y * w + x] =
        ((255 << 24) | (Math.round(b / a) << 16) | (Math.round(g / a) << 8) | Math.round(r / a)) >>> 0;
    }
  return { pixels, w, h };
}

/** The Planet's painted body (cropped) and its visible diameter, for scale. */
export function planetItem(seed: number, lighting: StageLighting): { item: SheetItem; diameter: number } {
  const path = 'src/titans/planet.json';
  if (!existsSync(path)) throw new Error('no planet.json');
  const def = JSON.parse(readFileSync(path, 'utf8')) as TitanDef;
  const m = generateTitanBody(def, seed, lighting).map;
  let x0 = m.w;
  let y0 = m.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++)
      if (m.material[y * m.w + x] !== 0) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  const w = x1 - x0 + 3;
  const h = y1 - y0 + 3;
  const pixels = new Uint32Array(w * h);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * m.w + x;
      if (m.material[i] !== 0) pixels[(y - y0 + 1) * w + (x - x0 + 1)] = m.baseColor[i]! | 0xff000000;
    }
  return { item: { pixels, w, h }, diameter: Math.max(x1 - x0 + 1, y1 - y0 + 1) };
}
