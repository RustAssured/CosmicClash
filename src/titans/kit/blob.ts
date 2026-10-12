import {
  Rng,
  clamp01,
  createMatterMap,
  hex,
  type MatterMap,
  type StageLighting,
  type TitanDef,
} from '@/contracts';
import { ArtCanvas, buildLitRamps, type ShadeParams } from '../art/canvas';
import { blend } from '../art/color';
import { edt, keepLargestComponent } from '../art/field';
import { fbm, hash01, makeWorley, worley } from '../art/noise';
import { sdCircle, sdEllipse, smin } from '../art/sdf';

/**
 * THE BLOB CREATURE: the titan kit's minimal template painter (`npm run new:titan -- <id> … --from blob`). One organic body:
 * a domain-warped ellipse with a few lobes, a thick skin over soft flesh, cell-like markings, a ring of eyes and a glowing
 * core. Every look number is in the titan's JSON `art.params` (see BlobParams); the palette is the JSON materials' ramps.
 *
 * Materials, by key (JSON order is free): skin, flesh, marking, eye, core. Pure and deterministic in (def, seed, lighting).
 */
export interface BlobParams {
  /** Body centre in map cells. */
  centre: [number, number];
  /** Body radii (px). The largest dimension is about 2 × max(rx, ry) + lobes. */
  body: { rx: number; ry: number };
  /** Bulges around the body (0–8) and their size relative to the body (0.2–0.6). */
  lobes: number;
  lobeSize: number;
  /** Organic wobble of the outline (px, 0–10). */
  wobble: number;
  /** Skin thickness (px). */
  skin: number;
  /** Cell-like markings: how big (px) and how many of the cells are marked (0–1). */
  markingSize: number;
  markings: number;
  /** Eyes on the front half (0–7) and the lead eye's radius (px). */
  eyes: number;
  eyeR: number;
  /** The core, offset from the centre (px), radius. */
  core: { x: number; y: number; r: number };
}

export interface BlobRig {
  core: { x: number; y: number; r: number };
  /** Mean body radius (px). */
  radius: number;
  eyes: { x: number; y: number; r: number }[];
  ids: { skin: number; flesh: number; marking: number; eye: number; core: number };
}

const params = (def: TitanDef): BlobParams => def.art.params as unknown as BlobParams;

const matId = (def: TitanDef, key: string): number => {
  const i = def.materials.findIndex((m) => m.key === key);
  if (i < 0) throw new Error(`${def.id} (blob): material '${key}' missing`);
  return i + 1;
};

interface Layout {
  p: BlobParams;
  cx: number;
  cy: number;
  sd(x: number, y: number): number;
  eyes: BlobRig['eyes'];
}

function makeLayout(def: TitanDef, seed: number): Layout {
  const p = params(def);
  const rng = new Rng(seed ^ 0xb10b);
  const [cx, cy] = p.centre;
  const s1 = (seed & 0xffff) + 11;
  const s2 = ((seed >>> 7) & 0xffff) + 23;
  const lobes: { x: number; y: number; r: number }[] = [];
  for (let k = 0; k < p.lobes; k++) {
    const a = ((k + rng.range(-0.3, 0.3)) / Math.max(1, p.lobes)) * Math.PI * 2;
    const r = Math.min(p.body.rx, p.body.ry) * p.lobeSize * rng.range(0.8, 1.15);
    lobes.push({ x: cx + Math.cos(a) * p.body.rx * 0.82, y: cy + Math.sin(a) * p.body.ry * 0.82, r });
  }
  const sd = (x: number, y: number): number => {
    const wx = x + fbm(x * 0.04, y * 0.04, s1, 3) * p.wobble;
    const wy = y + fbm(x * 0.04 + 5.3, y * 0.04 + 1.7, s2, 3) * p.wobble;
    let d = sdEllipse(wx, wy, cx, cy, p.body.rx, p.body.ry);
    for (const l of lobes) d = smin(d, sdCircle(wx, wy, l.x, l.y, l.r), 10);
    return d;
  };
  // eyes: the lead eye forward (+x, facing right), the rest in an arc behind it, all well inside the skin
  const eyes: BlobRig['eyes'] = [];
  for (let k = 0; k < p.eyes; k++) {
    const r = k === 0 ? p.eyeR : p.eyeR * rng.range(0.45, 0.7);
    const a =
      k === 0 ? -0.15 : -0.15 + (k % 2 ? -1 : 1) * (0.45 + 0.3 * Math.ceil(k / 2)) + rng.range(-0.1, 0.1);
    const reach = k === 0 ? 0.45 : 0.6;
    eyes.push({ x: cx + Math.cos(a) * p.body.rx * reach, y: cy + Math.sin(a) * p.body.ry * reach, r });
  }
  return { p, cx, cy, sd, eyes };
}

export function buildBlobRig(def: TitanDef, seed: number): BlobRig {
  const L = makeLayout(def, seed);
  const p = L.p;
  return {
    core: { x: L.cx + p.core.x, y: L.cy + p.core.y, r: p.core.r },
    radius: (p.body.rx + p.body.ry) / 2,
    eyes: L.eyes,
    ids: {
      skin: matId(def, 'skin'),
      flesh: matId(def, 'flesh'),
      marking: matId(def, 'marking'),
      eye: matId(def, 'eye'),
      core: matId(def, 'core'),
    },
  };
}

export function paintBlob(
  def: TitanDef,
  seed: number,
  lighting: StageLighting,
): { map: MatterMap; rig: BlobRig } {
  const L = makeLayout(def, seed);
  const rig = buildBlobRig(def, seed);
  const { ids } = rig;
  const p = L.p;
  const W = def.art.w;
  const H = def.art.h;
  const cv = new ArtCanvas(W, H);
  const sA = (seed & 0xfff) + 501;
  const sB = ((seed >>> 12) & 0xfff) + 607;
  const wc = makeWorley();

  const mask = new Uint8Array(W * H);
  for (let y = 2; y < H - 2; y++)
    for (let x = 2; x < W - 2; x++) if (L.sd(x + 0.5, y + 0.5) < 0) mask[y * W + x] = 1;
  keepLargestComponent(mask, W, H);
  const dist = edt(mask, W, H, false);

  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!mask[i]) continue;
      const fx = x + 0.5;
      const fy = y + 0.5;
      const d = dist[i]!;
      const skinT = p.skin + fbm(fx * 0.12, fy * 0.12, sA, 2) * 1.5;
      // a soft dome with fleshy folds
      let rel = 18 * Math.sqrt(clamp01(d / 30)) + fbm(fx * 0.07, fy * 0.07, sB, 3) * 3;
      let tone = (hash01(x, y, sB) - 0.5) * 0.4;
      let m: number;
      if (d < skinT) {
        m = ids.skin;
        tone += fbm(fx * 0.2, fy * 0.2, sA + 3, 2) * 0.9;
      } else {
        m = ids.flesh;
        tone += fbm(fx * 0.05, fy * 0.05, sA + 9, 2) * 0.8;
      }
      // cell-like markings (Worley cells, some of them marked, with darker borders)
      worley(fx / p.markingSize, fy / p.markingSize, sB + 40, wc, 0.85);
      if (wc.id < p.markings && (wc.f2 - wc.f1) * p.markingSize > 1.4 && d > 2) {
        m = ids.marking;
        tone += 0.4 - wc.f1 * 0.8;
        rel += 1.2;
      } else if ((wc.f2 - wc.f1) * p.markingSize < 0.9) {
        tone -= 0.9; // the folds between cells
        rel -= 0.7;
      }
      cv.mat[i] = m;
      cv.relief[i] = Math.max(0.3, rel);
      cv.tone[i] = tone;
    }

  // the core: a glowing heart under the flesh (the KO anchor)
  const coreX = rig.core.x;
  const coreY = rig.core.y;
  const CR = rig.core.r;
  for (let y = Math.floor(coreY - CR - 2); y <= Math.ceil(coreY + CR + 2); y++)
    for (let x = Math.floor(coreX - CR - 2); x <= Math.ceil(coreX + CR + 2); x++) {
      const i = y * W + x;
      if (x < 0 || y < 0 || x >= W || y >= H || !mask[i]) continue;
      const r = Math.hypot(x + 0.5 - coreX, y + 0.5 - coreY);
      if (r < CR) {
        cv.mat[i] = ids.core;
        cv.relief[i] = 10 + (1 - r / CR) * 5;
        cv.tone[i] = (1 - r / CR) * 1.5;
      }
    }
  // eyes: glossy domes
  for (const e of rig.eyes)
    for (let y = Math.floor(e.y - e.r - 2); y <= Math.ceil(e.y + e.r + 2); y++)
      for (let x = Math.floor(e.x - e.r - 2); x <= Math.ceil(e.x + e.r + 2); x++) {
        const i = y * W + x;
        if (x < 0 || y < 0 || x >= W || y >= H || !mask[i]) continue;
        const r = Math.hypot(x + 0.5 - e.x, y + 0.5 - e.y);
        if (r < e.r) {
          cv.mat[i] = ids.eye;
          cv.relief[i] = 12 + Math.sqrt(1 - (r / e.r) ** 2) * e.r * 0.8;
          cv.tone[i] = 0;
        } else if (r < e.r + 1.6) {
          cv.tone[i] = cv.tone[i]! - 1.2; // the lid
          cv.relief[i] = cv.relief[i]! + 1.5;
        }
      }
  cv.invalidate();

  const ramps = buildLitRamps(def.materials, lighting, 0.9);
  const shade: (Partial<ShadeParams> | undefined)[] = [];
  shade[ids.skin] = { contrast: 1.2, dither: 0.6, ao: 0.9, bayer8: true };
  shade[ids.flesh] = { contrast: 1.1, dither: 0.55 };
  shade[ids.marking] = { contrast: 1.25, dither: 0.3 };
  shade[ids.eye] = { contrast: 0.9, dither: 0, rim: 0.4, outline: 0.8, ao: 0 };
  shade[ids.core] = { contrast: 0.8, dither: 0.3, rim: 0, outline: 0 };
  const colors = cv.render({ ramps, params: shade, lighting, rimMix: 0.25 });

  // hand-painted overrides: each eye's pupil and its wet highlight (from the eye ramp, so the palette stays clean)
  const eyeRamp = def.materials[ids.eye - 1]!.visual.ramp.map(hex);
  for (const e of rig.eyes) {
    const pr = Math.max(1.2, e.r * 0.42);
    for (let y = Math.floor(e.y - e.r); y <= Math.ceil(e.y + e.r); y++)
      for (let x = Math.floor(e.x - e.r); x <= Math.ceil(e.x + e.r); x++) {
        const i = y * W + x;
        if (cv.mat[i] !== ids.eye) continue;
        const dx = x + 0.5 - (e.x + e.r * 0.15);
        const dy = y + 0.5 - e.y;
        if (Math.hypot(dx, dy) < pr) colors[i] = blend(eyeRamp[0]!, 0xff000000, 0.6);
        const hx = x + 0.5 - (e.x - e.r * 0.35);
        const hy = y + 0.5 - (e.y - e.r * 0.4);
        if (Math.hypot(hx, hy) < Math.max(0.8, e.r * 0.2)) colors[i] = eyeRamp[eyeRamp.length - 1]!;
      }
  }

  keepLargestComponent(cv.mat, W, H);
  const map = createMatterMap(W, H);
  cv.writeTo(map, colors, (m) =>
    m === ids.core ? 210 : m === ids.skin ? 140 : m === ids.eye ? 96 : m === ids.marking ? 128 : 118,
  );
  map.coreX = Math.round(coreX);
  map.coreY = Math.round(coreY);
  map.coreRadius = CR;
  return { map, rig };
}
