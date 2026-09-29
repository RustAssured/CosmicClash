import { CellFlag } from '@/contracts';
import { TILE, TILE_SHIFT, type Body } from './body';
import type { WorldCore } from './core';
import { BAYER4, hashI, lerpPx, scalePx } from './util';

const F_BURN = CellFlag.BURNING;
const F_CRACK = CellFlag.CRACKED;
const F_CHAR = CellFlag.CHARRED;
const F_ASSIM = CellFlag.ASSIMILATED;
const F_SHRAP = CellFlag.SHRAPNEL;
const F_SURF = CellFlag.SURFACE;

/** Heat below this (temperature units) has no visible glow. */
export const GLOW_START = 70;

/**
 * Recompute `map.pixels` / `map.emissive` for every tile flagged in `tileVis` (and everything if `visAll`). Layers the
 * displayed colour on the generator's `baseColor`:
 *   integrity dimming -> char -> infection tint + lattice pattern -> crack fissures -> freshly exposed edge re-lighting
 *   -> compression tint -> heat glow -> shrapnel glints. Idempotent: the result depends only on cell state.
 * Returns true if anything was refreshed (the map version is bumped and `map.dirty` expanded).
 */
export function refreshVisuals(core: WorldCore, body: Body): boolean {
  if (!body.visDirty && !body.visAll) return false;
  const tv = body.tileVis;
  if (body.visAll) {
    tv.fill(1);
    body.visAll = false;
  }
  const map = body.map;
  let dx0 = 1 << 20;
  let dy0 = 1 << 20;
  let dx1 = -1;
  let dy1 = -1;
  let any = false;
  for (let ty = 0; ty < body.tilesY; ty++) {
    for (let tx = 0; tx < body.tilesX; tx++) {
      const ti = ty * body.tilesX + tx;
      if (tv[ti] === 0) continue;
      tv[ti] = 0;
      const x0 = tx << TILE_SHIFT;
      const y0 = ty << TILE_SHIFT;
      const x1 = Math.min(body.w, x0 + TILE);
      const y1 = Math.min(body.h, y0 + TILE);
      refreshRect(core, body, x0, y0, x1, y1);
      any = true;
      if (x0 < dx0) dx0 = x0;
      if (y0 < dy0) dy0 = y0;
      if (x1 > dx1) dx1 = x1;
      if (y1 > dy1) dy1 = y1;
    }
  }
  body.visDirty = false;
  if (any) {
    map.version++;
    const d = map.dirty;
    if (d === null) map.dirty = { x0: dx0, y0: dy0, x1: dx1, y1: dy1 };
    else {
      if (dx0 < d.x0) d.x0 = dx0;
      if (dy0 < d.y0) d.y0 = dy0;
      if (dx1 > d.x1) d.x1 = dx1;
      if (dy1 > d.y1) d.y1 = dy1;
    }
  }
  return any;
}

function refreshRect(core: WorldCore, body: Body, x0: number, y0: number, x1: number, y1: number): void {
  const map = body.map;
  const w = body.w;
  const h = body.h;
  const mats = body.materials;
  const mat = map.material;
  const integ = map.integrity;
  const flags = map.flags;
  const temp = map.temperature;
  const inf = map.infection;
  const dens = map.density;
  const base = map.baseColor;
  const px = map.pixels;
  const emi = map.emissive;
  const bondR = map.bondR;
  const bondD = map.bondD;
  const snapFlags = body.snap.flags;
  const L = core.lighting;
  const tick = core.tick;
  const heatScale = Math.max(0.3, body.heatScale) * (0.5 + body.attributes.heat * 0.1);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      const m = mat[i]!;
      if (m === 0) {
        px[i] = 0;
        emi[i] = 0;
        continue;
      }
      const md = mats[m]!;
      let col = base[i]!;
      if (col >>> 24 === 0) col = (col | 0xff000000) >>> 0;
      const fl = flags[i]!;
      const ig = integ[i]!;
      const T = temp[i]!;
      const inv = inf[i]!;
      const dn = dens[i]!;
      let em = md.emissive;
      // Fast path: pristine untouched cell.
      if (
        ig === 255 &&
        (fl & ~F_SURF) === 0 &&
        T <= GLOW_START * 0.2 &&
        inv === 0 &&
        dn === 128 &&
        (fl & F_SURF) === (snapFlags[i]! & F_SURF)
      ) {
        px[i] = col;
        emi[i] = em;
        continue;
      }
      const ramp = md.ramp;
      const dark = ramp[0]! | 0;
      const light = ramp[ramp.length - 1]! | 0;

      /* ---- freshly exposed surface re-lit with the stage light ---- */
      if ((fl & F_SURF) !== 0 && (snapFlags[i]! & F_SURF) === 0) {
        let nx = 0;
        let ny = 0;
        const xl = x > 0;
        const xr = x < w - 1;
        const yu = y > 0;
        const yd = y < h - 1;
        if (!xl || mat[i - 1] === 0) nx -= 1;
        if (!xr || mat[i + 1] === 0) nx += 1;
        if (!yu || mat[i - w] === 0) ny -= 1;
        if (!yd || mat[i + w] === 0) ny += 1;
        if (xl && yu && mat[i - w - 1] === 0) {
          nx -= 0.6;
          ny -= 0.6;
        }
        if (xr && yu && mat[i - w + 1] === 0) {
          nx += 0.6;
          ny -= 0.6;
        }
        if (xl && yd && mat[i + w - 1] === 0) {
          nx -= 0.6;
          ny += 0.6;
        }
        if (xr && yd && mat[i + w + 1] === 0) {
          nx += 0.6;
          ny += 0.6;
        }
        const nl = Math.sqrt(nx * nx + ny * ny);
        if (nl > 0.01) {
          const lit = (nx * L.lx + ny * L.ly) / nl; // -1 (facing away) .. 1 (facing the light)
          if (lit > 0.15) {
            const hl = lerpPx(light, L.key | 0, 56);
            col = lerpPx(col, hl, Math.min(230, (lit * 200) | 0));
          } else if (lit < -0.1) {
            col = lerpPx(col, dark, Math.min(220, (-lit * 190) | 0));
          } else {
            col = lerpPx(col, dark, 40);
          }
        }
      }

      /* ---- integrity dimming (damaged matter looks bruised) ---- */
      if (ig < 255) {
        const t = ((255 - ig) * 140) / 255; // up to ~55% toward the dark end of the ramp
        col = lerpPx(col, dark, t | 0);
      }

      /* ---- compression (CRUSH): denser than nominal = darker, slightly cooler ---- */
      if (dn > 132) {
        col = scalePx(col, 256 - (((dn - 128) * 60) >> 7));
      }

      /* ---- char ---- */
      if ((fl & F_CHAR) !== 0) {
        const t = 90 + (((255 - ig) * 110) >> 8);
        col = lerpPx(col, md.char | 0, t);
      }

      /* ---- assimilation: crimson lattice ---- */
      if (inv > 0) {
        if ((fl & F_ASSIM) !== 0) {
          // Converted: a wire lattice (diagonal strands, glowing nodes where they cross) over a dark, crimson-tinted body.
          const a = (x + y) & 3;
          const b = (x - y) & 3;
          const body = lerpPx(scalePx(col, 120), scalePx(md.infect | 0, 64), 176);
          if (a === 0 && b === 0) {
            col = lerpPx(md.infect | 0, -1, 150);
            if (em < 120) em = 120;
          } else if (a === 0 || b === 0) {
            col = lerpPx(md.infect | 0, 0xffffe4d6 | 0, 40);
            if (em < 44) em = 44;
          } else col = body;
        } else if (inv >= BAYER4[((y & 3) << 2) | (x & 3)]! * 16 + 12) {
          // Creeping front: ordered dither of crimson into the untouched matter, denser as infection deepens.
          col = lerpPx(col, md.infect | 0, 190);
        }
      }

      /* ---- crack fissures (dark lines on cells beside a broken bond) ---- */
      if ((fl & F_CRACK) !== 0) {
        let strong = false;
        let weak = false;
        if (x < w - 1 && bondR[i] === 0 && mat[i + 1] !== 0) strong = true;
        if (y < h - 1 && bondD[i] === 0 && mat[i + w] !== 0) strong = true;
        if (x > 0 && bondR[i - 1] === 0 && mat[i - 1] !== 0) weak = true;
        if (y > 0 && bondD[i - w] === 0 && mat[i - w] !== 0) weak = true;
        // A chasm: the far wall is dark, the near lip catches the light.
        if (strong) col = lerpPx(col, md.crack | 0, 235);
        else if (weak) col = lerpPx(col, light, 70);
      }

      /* ---- heat glow ---- */
      if (T > GLOW_START) {
        const vap = md.vaporize > 0 ? md.vaporize : 1800;
        const hot = Math.max(1, vap * heatScale * 0.85 - GLOW_START);
        const f = Math.min(1, (T - GLOW_START) / hot);
        const gr = md.glowRamp;
        const gi = Math.min(gr.length - 1, (f * (gr.length - 0.001)) | 0);
        const s = Math.min(240, ((T - GLOW_START) * 256) / 260) | 0;
        col = lerpPx(col, gr[gi]! | 0, s);
        const flick = (fl & F_BURN) !== 0 ? hashI(x, y, tick >> 1) & 31 : 0;
        const e = 70 + f * 185 + flick;
        if (e > em) em = e > 255 ? 255 : e | 0;
      }

      /* ---- shrapnel glint ---- */
      if ((fl & F_SHRAP) !== 0) {
        const ph = (tick + (i & 15)) & 15;
        if (ph < 3) {
          col = lerpPx(col, -1, ph === 1 ? 210 : 140);
          if (em < 200) em = 200;
        } else col = lerpPx(col, light, 70);
      }

      px[i] = col;
      emi[i] = em;
    }
  }
}
