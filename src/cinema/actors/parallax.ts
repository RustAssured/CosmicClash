import type { Actor, CineContext, NativeBuffer } from '../types';
import { NATIVE_H, NATIVE_W, parallaxOf } from '../types';
import { registerActor } from './index';
import { BAYER4, OUTLINE, hash3, masterRamp, rampAt } from '../p4/palette';

/**
 * PARALLAX (P4, TRAILER_V3 §2.1 "3–4 depth layers"): one actor per layer, so each sits at its own RenderLayer depth and
 * moves with the camera by parallaxOf(depth) (far layers barely move, near ones sweep past):
 *  - 'nebula'  (far, e.g. depth −95): a dim cloud in the cool stone's darkest steps, Bayer-dithered, never smooth;
 *  - 'dust'    (mid, −60): sparse specks of the shared lingering-dust greys, drifting;
 *  - 'debris'  (near, +10): rock chunks of the shared debris ramp with a lit edge toward the one sky, slowly drifting;
 *  - 'fore'    (foreground particles, +35): a few big dark fragments sliding past the lens, rimmed with the outline.
 * Everything tiles (wraps) so any camera move has content; positions are hashes of the index: deterministic.
 *
 * params: layer ('nebula' | 'dust' | 'debris' | 'fore'), count (per screen), drift (px/s), seed.
 */

type Layer = 'nebula' | 'dust' | 'debris' | 'fore';
const num = (p: Readonly<Record<string, unknown>>, k: string, d: number): number =>
  typeof p[k] === 'number' ? (p[k] as number) : d;

// the nebula cloud: value noise baked once into a tile (2 screens wide), then sampled with wrap
const TW = NATIVE_W * 2;
const TH = NATIVE_H * 2;
let nebula: Float32Array | null = null;
const CELL = 80; // divides both tile sides (1280 × 720), and so do its halves and quarters
function vnoise(x: number, y: number, s: number, oct: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  // wrap the lattice so the tile tiles
  const PX = (TW / CELL) * oct;
  const PY = (TH / CELL) * oct;
  const h = (a: number, b: number): number => hash3(((a % PX) + PX) % PX, ((b % PY) + PY) % PY, s);
  const a0 = h(xi, yi) + (h(xi + 1, yi) - h(xi, yi)) * u;
  const a1 = h(xi, yi + 1) + (h(xi + 1, yi + 1) - h(xi, yi + 1)) * u;
  return a0 + (a1 - a0) * v;
}
function nebulaTile(seed: number): Float32Array {
  if (nebula) return nebula;
  nebula = new Float32Array(TW * TH);
  for (let y = 0; y < TH; y++)
    for (let x = 0; x < TW; x++) {
      const u = x / CELL;
      const v = y / CELL;
      // three octaves, each on a lattice that divides the tile, so the tile wraps seamlessly
      const n =
        vnoise(u, v, seed, 1) * 0.6 +
        vnoise(u * 2, v * 2, seed + 1, 2) * 0.28 +
        vnoise(u * 4, v * 4, seed + 2, 4) * 0.12;
      nebula[y * TW + x] = n;
    }
  return nebula;
}

export function parallaxActor(id: string, depth: number, params: Readonly<Record<string, unknown>>): Actor {
  const layer = (typeof params.layer === 'string' ? params.layer : 'dust') as Layer;
  const seed = num(params, 'seed', 3);
  const drift = num(params, 'drift', layer === 'fore' ? 14 : layer === 'debris' ? 5 : 2);
  const count = num(
    params,
    'count',
    layer === 'dust' ? 260 : layer === 'debris' ? 46 : layer === 'fore' ? 5 : 0,
  );
  const dark = masterRamp('uri.s2');
  const dust = masterRamp('vfx.dust');
  const rock = masterRamp('vfx.rock');
  return {
    id,
    depth,
    init() {
      if (layer === 'nebula') nebulaTile(seed);
    },
    draw(buf: NativeBuffer, ctx: CineContext) {
      const { w: W, h: H, pixels, emissive } = buf;
      const p = parallaxOf(depth);
      const vx = ctx.view.x0 * p;
      const vy = ctx.view.y0 * p;
      const T = ctx.t;
      if (layer === 'nebula') {
        const tile = nebulaTile(seed);
        const ox = Math.floor(vx);
        const oy = Math.floor(vy);
        for (let y = 0; y < H; y++) {
          const ty = (((y + oy) % TH) + TH) % TH;
          for (let x = 0; x < W; x++) {
            const tx = (((x + ox) % TW) + TW) % TW;
            const n = tile[ty * TW + tx]!;
            if (n < 0.46) continue;
            const v = (n - 0.46) / 0.54;
            const th = BAYER4[((y & 3) << 2) | (x & 3)]!;
            if (v < 0.12 && th > v / 0.12) continue; // the cloud's edge thins out through the dither
            // the deep cool stone (uri.s2's darkest steps): a cloud you feel more than see
            pixels[y * W + x] = rampAt(dark, 0.06 + v * 0.3, x, y);
          }
        }
        return;
      }
      for (let k = 0; k < count; k++) {
        const hx = hash3(k, seed, 1);
        const hy = hash3(k, seed, 2);
        const sp = 0.6 + 0.8 * hash3(k, seed, 3);
        const x = ((((hx * W - vx + T * drift * sp) % W) + W) % W) | 0;
        const y = ((((hy * H - vy + T * drift * sp * 0.25) % H) + H) % H) | 0;
        if (layer === 'dust') {
          if (x >= W || y >= H) continue;
          pixels[y * W + x] = dust[Math.floor(hash3(k, seed, 4) * 3)]!;
          continue;
        }
        const size =
          layer === 'fore' ? 7 + Math.floor(hash3(k, seed, 5) * 9) : 2 + Math.floor(hash3(k, seed, 5) * 3);
        // an irregular chunk: 6 sectors with seeded radii (the shared VFX's chunk shape), lit edge toward the upper left
        const inside = (dx: number, dy: number): boolean => {
          const r = Math.hypot(dx, dy);
          if (r < 0.5) return true;
          const sec = Math.floor(((Math.atan2(dy, dx) / (Math.PI * 2) + 0.5) * 6) % 6);
          return r <= size * (0.5 + 0.45 * hash3(k, sec, seed + 9)) + 0.25;
        };
        for (let dy = -size; dy <= size; dy++)
          for (let dx = -size; dx <= size; dx++) {
            if (!inside(dx, dy)) continue;
            const X = x + dx;
            const Y = y + dy;
            if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
            const i = Y * W + X;
            const edge = !inside(dx - 1, dy - 1);
            const rim = !inside(dx + 1, dy) || !inside(dx, dy + 1);
            if (layer === 'fore') pixels[i] = edge ? rock[2]! : rim ? OUTLINE : rock[0]!;
            else pixels[i] = edge ? rock[4]! : rim ? rock[0]! : rock[1 + ((dx + dy) & 1)]!;
            emissive[i] = 0;
          }
      }
    },
  };
}

registerActor('parallax', parallaxActor);
