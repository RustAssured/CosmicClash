import { clamp01, createMatterMap, type MatterMap, type StageLighting, type TitanDef } from '@/contracts';
import { ArtCanvas, buildLitRamps, type ShadeParams } from '../art/canvas';
import { DMath } from '@/contracts/dmath';

/**
 * THE IMAGE PAINTER: a kit titan whose body was imported from key art in the titan builder (dev/builder/, "Import art").
 * The import turns the art into cells, each holding a material and a light level within that material's ramp, and stores
 * them in the titan's folder as body.json (`ImageBody`). This painter rebuilds the matter map from them:
 *
 *  material + level → the material's ramp step (the art's own shading, kept)
 *  a gentle dome from the silhouette (`art.params.form`) → the game's stage lighting, rim light and outline on top
 *  ordered dither between ramp steps (`art.params.dither`)
 *
 * The colours come from the JSON's material ramps, not from the image, so the builder's palette panel still recolours an
 * imported titan, and only ramp colours reach the screen (palette-clean, like every painter). Pure and deterministic.
 */

/** A titan body imported from key art: the titan folder's body.json. */
export interface ImageBody {
  version: 1;
  w: number;
  h: number;
  /**
   * One byte per cell, base64, row-major: material id (1–15) in the high nibble, 0 = empty; the light level within that
   * material's ramp (0 = darkest step, 15 = lightest) in the low nibble.
   */
  cells: string;
  /** The core (the KO anchor) in cells: always solid. */
  core: { x: number; y: number; r: number };
}

/** The art recipe numbers an imported titan's JSON carries in `art.params`. */
export interface ImageParams {
  /** 0 = flat (the art exactly as imported), 1 = a strong dome lit by the stage light. */
  form: number;
  /** 0 = hard bands between ramp steps, 1 = dithered across them. */
  dither: number;
}

export interface ImageRig {
  core: { x: number; y: number; r: number };
  /** Mean body radius (px). */
  radius: number;
  /** Material ids the game looks up by key (the core's: the KO anchor). */
  ids: { core: number };
}

/** Encode cells (material ids and levels 0–15) as `ImageBody.cells`. */
export function encodeCells(mat: Uint8Array, level: Uint8Array): string {
  const bytes = new Uint8Array(mat.length);
  for (let i = 0; i < mat.length; i++) bytes[i] = mat[i] ? ((mat[i]! & 15) << 4) | (level[i]! & 15) : 0;
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const decoded = new WeakMap<ImageBody, { mat: Uint8Array; level: Uint8Array }>();

/** The cells of a body: material ids and light levels (0–15). Cached per body. */
export function decodeCells(body: ImageBody): { mat: Uint8Array; level: Uint8Array } {
  const hit = decoded.get(body);
  if (hit) return hit;
  const raw = atob(body.cells);
  const n = body.w * body.h;
  if (raw.length !== n) throw new Error(`image body: ${raw.length} cells for a ${body.w}×${body.h} map`);
  const mat = new Uint8Array(n);
  const level = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const b = raw.charCodeAt(i);
    mat[i] = b >> 4;
    level[i] = b & 15;
  }
  const out = { mat, level };
  decoded.set(body, out);
  return out;
}

export function buildImageRig(def: TitanDef, body: ImageBody): ImageRig {
  const { mat } = decodeCells(body);
  let n = 0;
  for (const m of mat) if (m) n++;
  const core = def.materials.findIndex((m) => m.key === 'core') + 1;
  if (!core) throw new Error(`${def.id} (image): material 'core' missing`);
  return { core: { ...body.core }, radius: Math.sqrt(n / Math.PI), ids: { core } };
}

const SHADE: Partial<ShadeParams> = {
  contrast: 1,
  bias: 0,
  ao: 0.5,
  rim: 0.8,
  outline: 0.9,
  bump: 1,
  bayer8: true,
};

export function paintImage(
  def: TitanDef,
  body: ImageBody,
  lighting: StageLighting,
): { map: MatterMap; rig: ImageRig } {
  const p = def.art.params as Partial<ImageParams>;
  const form = clamp01(p.form ?? 0.25);
  const dither = clamp01(p.dither ?? 0.35);
  const { w: W, h: H } = body;
  const { mat, level } = decodeCells(body);
  const nMat = def.materials.length;
  const cv = new ArtCanvas(W, H);
  for (let i = 0; i < mat.length; i++) cv.mat[i] = mat[i]! <= nMat ? mat[i]! : 0;
  cv.invalidate();
  const dist = cv.distance();

  // where a flat, camera-facing cell lands on the ramp under this light (ArtCanvas.render's light value, normal = +z): the
  // tone cancels it, so a flat cell shows the art's own level and only the dome's slopes add the stage's form light
  const xb = 0.7;
  const lx = lighting.dir[0] * xb;
  const lz = lighting.dir[2] / (DMath.hypot(lx, lighting.dir[1], lighting.dir[2]) || 1);
  const vFlat = clamp01((0.1 + 0.64 * Math.max(0, lz) - 0.5) * (SHADE.contrast ?? 1) + 0.5);
  const steps = def.materials.map((m) => m.visual.ramp.length - 1);

  for (let i = 0; i < mat.length; i++) {
    const m = cv.mat[i]!;
    if (!m) continue;
    const nr = steps[m - 1]!;
    // a floor of 1 keeps the relief map meaningful when the form is flat (craters read it)
    cv.relief[i] = 1 + form * 16 * Math.sqrt(clamp01(dist[i]! / 22));
    cv.tone[i] = (level[i]! / 15) * nr - vFlat * nr;
  }

  const ramps = buildLitRamps(def.materials, lighting, 0.9);
  const shade: Partial<ShadeParams>[] = [];
  for (let m = 1; m <= nMat; m++) shade[m] = { ...SHADE, dither };
  const colors = cv.render({ ramps, params: shade, lighting, rimMix: 0.25 });

  const map = createMatterMap(W, H);
  const rig = buildImageRig(def, body);
  cv.writeTo(map, colors, (m) => (m === rig.ids.core ? 210 : 128));
  map.coreX = Math.round(body.core.x);
  map.coreY = Math.round(body.core.y);
  map.coreRadius = body.core.r;
  return { map, rig };
}
