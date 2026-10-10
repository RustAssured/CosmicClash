import type { Actor, CineContext, NativeBuffer } from '../types';
import { registerActor } from './index';
import { loadUriBake, uriBakeNow } from '../p4/assets';
import { OUTLINE, hash3, masterRamp, rampAt } from '../p4/palette';
import type { UriBake } from '../p4/uri';

/**
 * RUIN (P4, TRAILER_V3 0:24): what is left of the two worlds. Their two naked cores, world A's hot orange and world B's cold
 * violet, hang where the worlds died, breathing light, in a field of their own drifting crust.
 *
 * The cores are 우리's own core pixels (the bake's groups 200 and 201) at exactly the places the genesis hauls them from
 * (p4/uri.ts RUIN_CORE_OFFSET), so the cut into the genesis is seamless: these ARE the hearts 우리 is built around.
 *
 * params: x 0, y 0 (world px of 우리's future centre), wreck 260 (crust chunks), spread 1.
 */

const num = (p: Readonly<Record<string, unknown>>, k: string, d: number): number =>
  typeof p[k] === 'number' ? (p[k] as number) : d;

export function ruinActor(id: string, depth: number, params: Readonly<Record<string, unknown>>): Actor {
  const wx = num(params, 'x', 0);
  const wy = num(params, 'y', 0);
  const nWreck = num(params, 'wreck', 260);
  const spread = num(params, 'spread', 1);
  let bake: UriBake | null = uriBakeNow();
  return {
    id,
    depth,
    async init() {
      bake = uriBakeNow() ?? (await loadUriBake());
    },
    draw(buf: NativeBuffer, ctx: CineContext) {
      if (!bake) return;
      const { w: W, h: H, pixels, emissive } = buf;
      const A = bake.A;
      const ox = wx - A.w / 2 - ctx.view.x0;
      const oy = wy - A.h / 2 - ctx.view.y0;
      const T = ctx.sceneT;
      const stone = [masterRamp('uri.s1'), masterRamp('uri.s2'), masterRamp('vfx.rock')];
      const hotR = masterRamp('uri.hot');
      // drifting crust: angular chunks, lit from the one sky (upper left), slowly tumbling outward from the two hearts
      for (let k = 0; k < nWreck; k++) {
        const side = k & 1 ? 201 : 200;
        const g = A.list.find((q) => q.code === side);
        const c0x = ox + (g ? g.cx + g.fx : 0);
        const c0y = oy + (g ? g.cy + g.fy : 0);
        const a = hash3(k, 1, 7) * Math.PI * 2 + T * 0.02 * (hash3(k, 2, 7) - 0.5);
        const r = (24 + hash3(k, 3, 7) ** 0.7 * 230) * spread * (1 + T * 0.012);
        const x = Math.round(c0x + Math.cos(a) * r);
        const y = Math.round(c0y + Math.sin(a) * r * 0.55);
        const z = 1 + Math.floor(hash3(k, 4, 7) * 4);
        const ramp = stone[k % 3]!;
        const molten = hash3(k, 5, 7) > 0.86;
        for (let yy = 0; yy < z; yy++)
          for (let xx = 0; xx < z + 1; xx++) {
            const X = x + xx;
            const Y = y + yy;
            if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
            if ((xx === z && yy === 0) || (xx === 0 && yy === z - 1 && z > 2)) continue; // chip the corners
            const i = Y * W + X;
            const lit = yy === 0 || xx === 0;
            pixels[i] = molten && yy >= z - 1 ? hotR[3]! : rampAt(ramp, lit ? 0.55 : 0.22, X, Y);
            emissive[i] = molten && yy >= z - 1 ? 160 : 0;
          }
      }
      // the hearts: their own pixels, a dark outline, and a slow breath of light round them (no flashing)
      for (const g of A.list) {
        if (g.code !== 200 && g.code !== 201) continue;
        const ramp = masterRamp(g.code === 200 ? 'uri.hot' : 'uri.cold');
        const cx = ox + g.cx + g.fx;
        const cy = oy + g.cy + g.fy;
        let rad = 0;
        for (let q = 0; q < g.off.length; q += 2) rad = Math.max(rad, Math.hypot(g.off[q]!, g.off[q + 1]!));
        const breath = 0.5 + 0.5 * Math.sin(T * (g.code === 200 ? 1.3 : 1.7));
        const R2 = rad * (2.2 + breath * 0.4);
        for (let y = Math.floor(cy - R2); y <= cy + R2; y++)
          for (let x = Math.floor(cx - R2); x <= cx + R2; x++) {
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            const d = Math.hypot(x - cx, y - cy);
            if (d < rad || d > R2) continue;
            const f = 1 - (d - rad) / (R2 - rad);
            const i = y * W + x;
            if (f * f * (0.45 + 0.25 * breath) < hash3(x, y, 3) * 0.9) continue;
            if (pixels[i] >>> 24) continue; // the wreck in front of the halo stays
            pixels[i] = rampAt(ramp, 0.15 + f * 0.35, x, y);
            emissive[i] = Math.round(90 * f);
          }
        const occ = new Set<number>();
        for (let q = 0; q < g.col.length; q++) {
          const X = Math.round(cx + g.off[q * 2]!);
          const Y = Math.round(cy + g.off[q * 2 + 1]!);
          if (X < 1 || Y < 1 || X >= W - 1 || Y >= H - 1) continue;
          const i = Y * W + X;
          pixels[i] = g.col[q]!;
          emissive[i] = 255;
          occ.add(i);
        }
        for (const i of occ)
          for (const j of [i - 1, i + 1, i - W, i + W])
            if (!occ.has(j)) {
              pixels[j] = OUTLINE;
              emissive[j] = 0;
            }
      }
    },
  };
}

registerActor('ruin', ruinActor);
