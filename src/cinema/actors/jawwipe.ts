import type { Actor, CineContext, NativeBuffer } from '../types';
import { registerActor } from './index';
import { EDGE } from '../p6/edge';
import { drawPackFrame, loadPack, packNow } from '../p6/pack';
import { masterRamp } from '../p4/palette';

/**
 * JAW WIPE (P6, TRAILER_V3 1:29): the jaw-rings close over the camera. The LOCKED Mouth's head seen down its own axis, so
 * large that at first its mouth is wider than the frame: its rows of teeth and jaw-rings close in from the edges as an
 * iris, the gullet cut out of it so the scene shows through the shrinking opening (jaw pack, tools/cinema/mouth-bake.ts),
 * and it bites shut: black from EDGE.wipeEnd until `holdUntil`.
 *
 * params: holdUntil (timeline seconds of black after the bite, default EDGE.wipeEnd + 0.1).
 */
const num = (p: Readonly<Record<string, unknown>>, k: string, d: number): number =>
  typeof p[k] === 'number' ? (p[k] as number) : d;

export function jawwipeActor(id: string, depth: number, params: Readonly<Record<string, unknown>>): Actor {
  const holdUntil = num(params, 'holdUntil', EDGE.wipeEnd + 0.1);
  return {
    id,
    depth,
    async init() {
      await loadPack('jaw');
    },
    draw(buf: NativeBuffer, ctx: CineContext) {
      const t = ctx.t;
      if (t < EDGE.wipeStart || t >= holdUntil) return;
      const jaw = packNow('jaw');
      const f = Math.round((t - EDGE.wipeStart) * EDGE.fps);
      if (!jaw || f >= jaw.frames - 1) {
        // shut: the Mouth's own black (the darkest master colour)
        buf.pixels.fill(masterRamp('mouth.black')[0]!);
        buf.emissive.fill(0);
        return;
      }
      drawPackFrame(buf, jaw, f);
    },
  };
}

registerActor('jawwipe', jawwipeActor);
