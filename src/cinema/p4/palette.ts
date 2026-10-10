import { hex, rgba } from '@/contracts';
import { masterPalette, OUTLINE_COLOR, VFX_RAMPS } from '@/render/master';
import { linearToOklab, srgbToLinear } from '@/render/palette';

/**
 * P4 colour helpers: every colour the genesis, ruin, ark and parallax actors put down is a MASTER PALETTE colour
 * (shared/UNIFICATION.md §2, src/render/master.ts). Ramps are read from the master by source name; anything computed
 * (the baked 우리 sprite, a blend) is snapped to the nearest master colour in OKLab. Gradients are Bayer-dithered between
 * neighbouring steps of one ramp, never smooth.
 */

const cache = new Map<string, Uint32Array>();

/** A master ramp (dark → light) as packed RGBA, e.g. 'uri.hot', 'uri.cold', 'uri.civ', 'uri.field', 'vfx.flash'. */
export function masterRamp(name: string): Uint32Array {
  let r = cache.get(name);
  if (r) return r;
  const M = masterPalette();
  const idx = M.ramps[name];
  if (!idx || !idx.length) throw new Error(`master palette has no ramp "${name}"`);
  r = Uint32Array.from(idx, (i) => hex(M.colors[i]!));
  cache.set(name, r);
  return r;
}

/** The one outline colour around every titan silhouette. */
export const OUTLINE = hex(OUTLINE_COLOR);
/** The star-flash ramp (deep red → white), the shared VFX's own. */
export const FLASH = Uint32Array.from(VFX_RAMPS.flash, (h) => hex(h));

let labs: Float32Array | null = null;
let packedAll: Uint32Array | null = null;
const near = new Map<number, number>();

/** The master colour nearest to (r, g, b) in OKLab (cached per 5-bit RGB cell, which is far finer than the palette). */
export function nearestMaster(r: number, g: number, b: number): number {
  const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  const hit = near.get(key);
  if (hit !== undefined) return hit;
  if (!labs || !packedAll) {
    const M = masterPalette();
    packedAll = Uint32Array.from(M.colors, (h) => hex(h));
    labs = new Float32Array(M.colors.length * 3);
    M.colors.forEach((h, i) => {
      const c = hex(h);
      linearToOklab(
        srgbToLinear((c & 255) / 255),
        srgbToLinear(((c >>> 8) & 255) / 255),
        srgbToLinear(((c >>> 16) & 255) / 255),
        labs!,
        i * 3,
      );
    });
  }
  const o = [0, 0, 0];
  linearToOklab(srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255), o);
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < packedAll.length; i++) {
    const d = (labs[i * 3]! - o[0]!) ** 2 + (labs[i * 3 + 1]! - o[1]!) ** 2 + (labs[i * 3 + 2]! - o[2]!) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  const c = packedAll[best]!;
  near.set(key, c);
  return c;
}

/** Snap a packed colour to the master palette (alpha kept). */
export const snap = (c: number): number => {
  const m = nearestMaster(c & 255, (c >>> 8) & 255, (c >>> 16) & 255);
  return ((m & 0xffffff) | (c & 0xff000000)) >>> 0;
};

/** The ordered 4×4 Bayer thresholds (0..1), the game's dither. */
export const BAYER4 = Float32Array.from(
  [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5],
  (v) => (v + 0.5) / 16,
);

/** A dithered step of a ramp: v 0..1 picks between two neighbouring steps by the Bayer threshold at (x, y). */
export function rampAt(ramp: Uint32Array, v: number, x: number, y: number): number {
  const f = (v < 0 ? 0 : v > 1 ? 1 : v) * (ramp.length - 1);
  const i = f | 0;
  const up = f - i > BAYER4[((y & 3) << 2) | (x & 3)]! && i < ramp.length - 1;
  return ramp[up ? i + 1 : i]!;
}

/** Deterministic 0..1 hash of three integers (no Math.random anywhere in cinema actors). */
export function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export { rgba };
