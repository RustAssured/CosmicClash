import type { Actor, CineContext, NativeBuffer } from '../types';
import { registerActor } from './index';
import { loadUriBake, uriBakeNow } from '../p4/assets';
import { drawThrust, drawUri, genesisCues, weldTa, type UriBake } from '../p4/uri';
import { drawImpacts, type VfxImpact } from '../p4/sparks';

/**
 * GENESIS (P4, TRAILER_V3 Act II): 우리 built from the wreck of the two worlds, from its real rig parts.
 *
 * One clock for the whole act, so the montage can cut anywhere and the body is always in the same state: the assembly
 * k = (t − start) / dur runs on TIMELINE seconds (not shot time).
 *  - k 0 → 0.16: the two cores are hauled together from where their worlds died (the ruin's positions);
 *  - 0.15 → 0.27: the loop ignites round its circuit;
 *  - then chamber, hips, pylons, shoulder domes, arms, each part on its drum cue (genesisCues): a weld flash in the shared
 *    star-flash ramp and the game's own spark VFX on every landing;
 *  - 0.68 → 0.9: the fists form from rubble in two clenches; 0.77 → 0.97 the command moon swings in on its tether and locks.
 * After it: `braceAt` lifts into the real guard stance (the kinetic pass's pose) with the loop flaring and the pylons
 * igniting; `launchAt` throws it at the camera (whole-number magnification, centred).
 *
 * params (timeline.json): start 27, dur 14, braceAt 41, launchAt 44, x 0, y 0 (world px of the body's centre),
 * sparks true. Weld and drum times for the audio and the cuts: `genesisCues(bake, start, dur)` (p4/uri.ts).
 */

const num = (p: Readonly<Record<string, unknown>>, k: string, d: number): number =>
  typeof p[k] === 'number' ? (p[k] as number) : d;

export function genesisActor(id: string, depth: number, params: Readonly<Record<string, unknown>>): Actor {
  const start = num(params, 'start', 27);
  const dur = num(params, 'dur', 14);
  const braceAt = num(params, 'braceAt', 41);
  const launchAt = num(params, 'launchAt', 44);
  const wx = num(params, 'x', 0);
  const wy = num(params, 'y', 0);
  const sparks = params.sparks !== false;
  let bake: UriBake | null = uriBakeNow();
  return {
    id,
    depth,
    async init() {
      bake = uriBakeNow() ?? (await loadUriBake());
    },
    draw(buf: NativeBuffer, ctx: CineContext) {
      if (!bake) return;
      const t = ctx.t;
      const k = Math.max(0, Math.min(1.0001, (t - start) / dur));
      const brace = Math.max(0, Math.min(1, (t - braceAt) / 1.4));
      const flare = t > braceAt + 0.9 ? Math.max(0, 1 - (t - braceAt - 0.9) / 1.5) : 0;
      const launch = t > launchAt ? Math.min(1, (t - launchAt) / 1.6) : 0;
      // the launch: magnified in whole steps (1, 2, 3 … 6) about the body's centre, accelerating toward the lens
      const scale = 1 + Math.floor(launch * launch * 5.999);
      const A = bake.A;
      const ox = Math.round(wx - A.w / 2 - ctx.view.x0);
      const oy = Math.round(wy - A.h / 2 - ctx.view.y0);
      if (brace > 0 && launch < 0.4)
        drawThrust(buf, bake, ox, oy, 0.35 + brace * 0.65 + flare * 0.5, ctx.sceneT);
      const hits = drawUri(buf, bake, ox, oy, {
        k: k >= 1 ? 2 : k,
        morph: brace,
        heat: k >= 1 ? 0.4 * brace + flare : 0,
        time: ctx.sceneT,
        scale,
      });
      if (sparks && k < 1) {
        // the game's own impact VFX on the welds: the big landings (and every core, fist and moon) throw a heavy blow's
        // sparks, the chunks of a part a light one's; the newest 24 are drawn, as in a fight
        const impacts: VfxImpact[] = [];
        for (const h of hits) {
          const big = h.size > 250 || h.code >= 11;
          if (!big && h.size < 60) continue;
          impacts.push({
            x: h.x,
            y: h.y,
            weight: big ? 2 : 0,
            age: h.age * dur,
            dirX: Math.cos(h.seed),
            dirY: Math.sin(h.seed),
            seed: h.seed,
            matter: 'uri',
          });
        }
        drawImpacts(buf, impacts.slice(-24));
      }
    },
  };
}

registerActor('genesis', genesisActor);

export { genesisCues, weldTa };
