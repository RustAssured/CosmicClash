import type { Actor, CineContext, NativeBuffer } from '../types';
import { parallaxOf } from '../types';
import { registerActor } from './index';
import { hash3, masterRamp } from '../p4/palette';

/**
 * ARKS (P4, TRAILER_V3 0:24 "arks like embers"): the survivors' ships, an emissive point swarm drifting like embers off a
 * fire. Each ark is one civilization-light pixel (the 우리 civ ramp: the same light as 우리's windows) with a short, dimmer
 * wake; they rise slowly and sway, their light breathes (slowly: never a flicker). `gather` pulls them toward a point over
 * the shot, so in the genesis they join the build.
 *
 * params: n 180, x 0, y 0, w 620, h 300 (world box the swarm lives in), rise 6 (px/s), gather 0, gx/gy (gather point,
 * default the box centre).
 */

const num = (p: Readonly<Record<string, unknown>>, k: string, d: number): number =>
  typeof p[k] === 'number' ? (p[k] as number) : d;

export function arkActor(id: string, depth: number, params: Readonly<Record<string, unknown>>): Actor {
  const n = num(params, 'n', 180);
  const bx = num(params, 'x', 0);
  const by = num(params, 'y', 0);
  const bw = num(params, 'w', 620);
  const bh = num(params, 'h', 300);
  const rise = num(params, 'rise', 6);
  const gather = num(params, 'gather', 0);
  const gx = num(params, 'gx', bx);
  const gy = num(params, 'gy', by);
  const civ = masterRamp('uri.civ');
  return {
    id,
    depth,
    draw(buf: NativeBuffer, ctx: CineContext) {
      const { w: W, h: H, pixels, emissive } = buf;
      const p = parallaxOf(depth);
      const T = ctx.t; // timeline clock: the swarm is continuous across cuts
      const g = Math.max(0, Math.min(1, gather * ctx.shotT));
      for (let k = 0; k < n; k++) {
        const h1 = hash3(k, 11, 1);
        const h2 = hash3(k, 12, 1);
        const sp = 0.5 + hash3(k, 13, 1);
        // wrap the rise inside the box so the swarm never runs out
        let y = by - bh / 2 + ((((h2 * bh - T * rise * sp) % bh) + bh) % bh);
        let x = bx - bw / 2 + h1 * bw + Math.sin(T * 0.4 * sp + k) * 6;
        const pull = g * (0.4 + 0.6 * hash3(k, 14, 1));
        x += (gx - x) * pull;
        y += (gy - y) * pull;
        const X = Math.round(x - ctx.view.x0 * p);
        const Y = Math.round(y - ctx.view.y0 * p);
        if (X < 1 || Y < 1 || X >= W - 1 || Y >= H - 3) continue;
        const breath = 0.5 + 0.5 * Math.sin(T * (0.7 + sp) + k * 2.3);
        const c = civ[breath > 0.66 ? 2 : breath > 0.25 ? 1 : 0]!;
        const i = Y * W + X;
        pixels[i] = c;
        emissive[i] = 200 + Math.round(55 * breath);
        // the wake: one or two dimmer pixels below (they rise), only for the brighter half
        if (hash3(k, 15, 1) > 0.5) {
          pixels[i + W] = civ[0]!;
          emissive[i + W] = 90;
          if (sp > 1.1) {
            pixels[i + 2 * W] = civ[0]!;
            emissive[i + 2 * W] = 40;
          }
        }
      }
    },
  };
}

registerActor('ark', arkActor);
