import type { Actor, CineContext, NativeBuffer } from '../types';
import { drawPackFrame, loadPack, packNow } from '../p6/pack';
import { registerActor } from './index';

/**
 * `mouth`: the LOCKED Mouth, played back from a frame pack baked from the oracle (tools/cinema/mouth-strike.ts →
 * tools/cinema/mouth-pack.ts; src/cinema/p6/pack.ts). Every pixel is the oracle's own, snapped to the master palette.
 * params: pack (name of press/cinema/work/mouth/<pack>.cfp), start (timeline second of the pack's frame 0), dx, dy
 * (native offset). Before its first frame and after its last it draws nothing (hold: `hold: true` keeps the last frame).
 */
registerActor('mouth', (id, depth, params): Actor => {
  const name = String(params.pack ?? 'strike');
  const start = Number(params.start ?? 0);
  const dx = Number(params.dx ?? 0);
  const dy = Number(params.dy ?? 0);
  const hold = params.hold === true;
  return {
    id,
    depth,
    async init(): Promise<void> {
      await loadPack(name);
    },
    draw(buf: NativeBuffer, ctx: CineContext): void {
      const pack = packNow(name);
      if (!pack) return;
      let f = Math.round((ctx.t - start) * 60);
      if (f < 0) return;
      if (f >= pack.frames) {
        if (!hold) return;
        f = pack.frames - 1;
      }
      drawPackFrame(buf, pack, f, dx, dy);
    },
  };
});
