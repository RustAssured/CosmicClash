import type { UriPartMeta } from './rig';
import { DMath } from '@/contracts/dmath';

/**
 * 우리 at its game size (D34, WJ 2026-10-09: original-like sizes, 우리 about 200 px tall, the asset is about 300).
 *
 * The asset (uri/data/uri_rig.json, packed into uri_rig.bin) stays the source of truth at reference scale, and the kinetic system
 * keeps running in reference px (oracle parity: its numbers are untouched). What changes is the matter: every part's grids are
 * RESAMPLED to `scale` once, at load, field by field with the rule that keeps that field crisp, and the behaviour places the
 * parts at `scale` × their reference positions (src/combat/behaviours/uri.ts).
 *
 * Each output cell covers a (1 / scale)² square of source cells (1.5 × 1.5 at 2/3) and reads them with area weights:
 *  - matter where at least half of the square is matter (the silhouette keeps its size and shape);
 *  - the material code: a light (field, civilisation, slit, habitat, crack) wins when it covers ≥ 30 % of the cell's matter, so a
 *    one-pixel light stays one crisp pixel instead of blurring away or growing; a crevice when it covers ≥ 40 % (lines stay
 *    lines); otherwise the weighted majority;
 *  - warm / cool surface and chunk id: the weighted majority (chunks stay whole, irregular pieces, about 2/3 their size);
 *  - tone, form and the normal: the area mean over the matter (the normal renormalised);
 *  - edge distance: recomputed on the new silhouette (a chamfer distance), so the one-pixel outline is one OUTPUT pixel.
 * Deterministic; at scale 1 it is the identity.
 */

/** A part's grid at a scale: its top-left in scaled reference px, its size, and its pivot in the grid (fractional). */
export interface UriGrid {
  x0: number;
  y0: number;
  w: number;
  h: number;
  pivX: number;
  pivY: number;
}

/** The grid of part `p` at `scale` (scale 1: the asset's own grid). */
export function uriGridOf(p: UriPartMeta, scale: number): UriGrid {
  if (scale === 1) return { x0: p.x0, y0: p.y0, w: p.w, h: p.h, pivX: p.pivX, pivY: p.pivY };
  const x0 = Math.floor(p.x0 * scale);
  const y0 = Math.floor(p.y0 * scale);
  const x1 = Math.ceil((p.x0 + p.w) * scale);
  const y1 = Math.ceil((p.y0 + p.h) * scale);
  return { x0, y0, w: x1 - x0, h: y1 - y0, pivX: p.pgX * scale - x0, pivY: p.pgY * scale - y0 };
}

/** The per-cell fields of one part (the asset's grids). */
export interface UriFields {
  mat: Uint8Array;
  surf: Uint8Array;
  tone: Uint8Array;
  form: Uint8Array;
  nx: Uint8Array;
  ny: Uint8Array;
  nz: Uint8Array;
  edge: Uint8Array;
  chunk: Uint16Array;
}

/** Asset material codes that are LIGHTS (uri/docs/URI_SPEC.md §3): field 2, civilisation 3, habitat 7, crack 8, slit 9. */
const LIGHTS = new Set([2, 3, 7, 8, 9]);
const CREVICE = 10;
const LIGHT_SHARE = 0.3;
const CREVICE_SHARE = 0.4;

/** Resample part `p`'s fields to `scale` (see the header). */
export function scaleUriFields(p: UriPartMeta, f: UriFields, scale: number): UriFields {
  if (scale === 1) return f;
  const g = uriGridOf(p, scale);
  const n = g.w * g.h;
  const out: UriFields = {
    mat: new Uint8Array(n),
    surf: new Uint8Array(n),
    tone: new Uint8Array(n),
    form: new Uint8Array(n),
    nx: new Uint8Array(n),
    ny: new Uint8Array(n),
    nz: new Uint8Array(n),
    edge: new Uint8Array(n),
    chunk: new Uint16Array(n),
  };
  const inv = 1 / scale;
  // per-cell weights by code / surface / chunk (small maps, reused)
  const codeW = new Float64Array(256);
  const surfW = new Float64Array(4);
  const chunkW = new Map<number, number>();
  for (let Y = 0; Y < g.h; Y++)
    for (let X = 0; X < g.w; X++) {
      // the source square in the part's own grid
      const sx0 = (g.x0 + X) * inv - p.x0;
      const sy0 = (g.y0 + Y) * inv - p.y0;
      const sx1 = sx0 + inv;
      const sy1 = sy0 + inv;
      codeW.fill(0);
      surfW.fill(0);
      chunkW.clear();
      let live = 0;
      let tone = 0;
      let form = 0;
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let y = Math.max(0, Math.floor(sy0)); y < Math.min(p.h, Math.ceil(sy1)); y++) {
        const wy = Math.min(sy1, y + 1) - Math.max(sy0, y);
        if (wy <= 0) continue;
        for (let x = Math.max(0, Math.floor(sx0)); x < Math.min(p.w, Math.ceil(sx1)); x++) {
          const wx = Math.min(sx1, x + 1) - Math.max(sx0, x);
          if (wx <= 0) continue;
          const i = y * p.w + x;
          const m = f.mat[i]!;
          if (!m) continue;
          const w = wx * wy;
          live += w;
          codeW[m]! += w;
          surfW[f.surf[i]! & 3]! += w;
          const c = f.chunk[i]!;
          chunkW.set(c, (chunkW.get(c) ?? 0) + w);
          tone += f.tone[i]! * w;
          form += f.form[i]! * w;
          nx += ((f.nx[i]! - 128) / 120) * w;
          ny += ((f.ny[i]! - 128) / 120) * w;
          nz += (f.nz[i]! / 250) * w;
        }
      }
      // matter where at least half of the square is matter
      if (live < 0.5 * inv * inv) continue;
      const o = Y * g.w + X;
      out.mat[o] = pickCode(codeW, live);
      out.surf[o] = argmax(surfW);
      let bc = 0;
      let bw = -1;
      for (const [c, w] of chunkW)
        if (w > bw || (w === bw && c < bc)) {
          bw = w;
          bc = c;
        }
      out.chunk[o] = bc;
      out.tone[o] = Math.round(tone / live);
      out.form[o] = Math.round(form / live);
      const l = DMath.hypot(nx, ny, nz) || 1;
      out.nx[o] = clamp255(Math.round((nx / l) * 120 + 128));
      out.ny[o] = clamp255(Math.round((ny / l) * 120 + 128));
      out.nz[o] = clamp255(Math.round((nz / l) * 250));
    }
  edgeDistance(out.mat, g.w, g.h, out.edge);
  return out;
}

/** The material code of a cell from its weights by code: a light or a crevice when it holds its share, else the majority. */
function pickCode(codeW: Float64Array, live: number): number {
  let light = 0;
  let lightW = 0;
  let best = 0;
  let bestW = 0;
  for (let c = 1; c < codeW.length; c++) {
    const w = codeW[c]!;
    if (w <= 0) continue;
    if (LIGHTS.has(c) && w > lightW) {
      light = c;
      lightW = w;
    }
    if (w > bestW) {
      best = c;
      bestW = w;
    }
  }
  if (light && lightW >= LIGHT_SHARE * live) return light;
  if (codeW[CREVICE]! >= CREVICE_SHARE * live) return CREVICE;
  return best;
}

function argmax(w: Float64Array): number {
  let k = 0;
  for (let i = 1; i < w.length; i++) if (w[i]! > w[k]!) k = i;
  return k;
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Distance (px) from every matter cell to the nearest empty cell or the grid's border: a two-pass 3-4 chamfer, divided by 3
 * (edge cells read 1, like the asset's `distance_transform_edt`).
 */
function edgeDistance(mat: Uint8Array, w: number, h: number, out: Uint8Array): void {
  const BIG = 1 << 20;
  const d = new Int32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mat[i] ? BIG : 0;
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]!);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i]!, at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i]!, at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  for (let i = 0; i < d.length; i++) out[i] = mat[i] ? clamp255(Math.round(d[i]! / 3)) : 0;
}
