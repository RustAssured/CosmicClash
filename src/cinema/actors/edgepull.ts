import type { Actor, CineContext, NativeBuffer } from '../types';
import { registerActor } from './index';
import { EDGE, arenaRect, edgeWordCues, EDGE_WORDS } from '../p6/edge';
import { drawPackFrame, loadPack, packNow } from '../p6/pack';
import { BAYER4, hash3, masterRamp, OUTLINE } from '../p4/palette';

/**
 * EDGE PULL (P6, TRAILER_V3 1:20–1:29), with the LOCKED Mouth (frame packs baked from mouth-LOCKED-full.html by
 * tools/cinema/mouth-bake.ts and mouth-pack.ts; the clock and geometry are src/cinema/p6/edge.ts):
 *  - 1:20–1:23: the stars along all four edges of the frame slide toward the rim, and the Mouth's coils slide in along the
 *    bottom edge (its own figure over the arena; transparent elsewhere, so the fight shows through);
 *  - 1:23–1:29: the pull-back. The arena (the game frame) shrinks exponentially to a small rectangle, the Mouth at its
 *    edge shrinking with it, while the rest of its body, the coil heap braided by the oracle at the camera's scale every
 *    frame, fills the frame around it.
 *  - The words HUNGER. DEVOURS. ENDS. REPEATS. come one per coil pass: `edgeWordCues()` (timeline seconds) for the cards.
 *
 * The arena's picture comes from the Director (`setArenaSource`): during the pull-back this actor draws it, shrunk, inside
 * the coils. Without one, the arena is the dark of space.
 *
 * params: none needed (the clock is EDGE); stars (count, default 220).
 */
type ArenaSource = (t: number) => { w: number; h: number; pixels: Uint32Array; emissive?: Uint8Array } | null;
let arenaSource: ArenaSource | null = null;
/** The Director (or a tool) hands in the arena's frame at timeline second t (native 640×360, packed RGBA). */
export function setArenaSource(fn: ArenaSource | null): void {
  arenaSource = fn;
}
export { edgeWordCues, EDGE_WORDS };

const num = (p: Readonly<Record<string, unknown>>, k: string, d: number): number =>
  typeof p[k] === 'number' ? (p[k] as number) : d;

export function edgepullActor(id: string, depth: number, params: Readonly<Record<string, unknown>>): Actor {
  const nStars = num(params, 'stars', 220);
  const scratch = { w: 640, h: 360, pixels: new Uint32Array(640 * 360), emissive: new Uint8Array(640 * 360) };
  return {
    id,
    depth,
    async init() {
      await Promise.all(['edge', 'heap'].map((n) => loadPack(n)));
    },
    draw(buf: NativeBuffer, ctx: CineContext) {
      const t = ctx.t;
      if (t < EDGE.slideStart || t >= EDGE.pullEnd) return;
      const edge = packNow('edge');
      const heap = packNow('heap');
      const { w: W, h: H, pixels, emissive } = buf;
      const dust = masterRamp('vfx.dust');
      const white = masterRamp('vfx.flash');
      const fe = Math.round((t - EDGE.slideStart) * EDGE.fps);
      if (t < EDGE.pullStart) {
        // the stars near the edges slide toward the rim, faster the nearer the rim; the middle of the frame stays still
        const u = (t - EDGE.slideStart) / (EDGE.pullStart - EDGE.slideStart);
        for (let k = 0; k < nStars; k++) {
          const a = hash3(k, 1, 31) * Math.PI * 2;
          const r0 = 0.55 + hash3(k, 2, 31) * 0.45; // in the outer band only
          const pull = u * u * (0.25 + hash3(k, 3, 31) * 0.5);
          const r = r0 + pull;
          const x = Math.round(320 + Math.cos(a) * r * 360);
          const y = Math.round(180 + Math.sin(a) * r * 200);
          // a streak back toward where it was: the sky being dragged
          const len = Math.ceil(pull * 30);
          for (let j = 0; j <= len; j++) {
            const X = Math.round(x - Math.cos(a) * j);
            const Y = Math.round(y - Math.sin(a) * j * 0.56);
            if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
            const i = Y * W + X;
            if (j > 0 && BAYER4[((Y & 3) << 2) | (X & 3)]! < j / (len + 1)) continue;
            pixels[i] = j === 0 ? white[5]! : dust[Math.max(0, 5 - Math.floor((j / (len + 1)) * 5))]!;
            emissive[i] = j === 0 ? 180 : 0;
          }
        }
        if (edge) drawPackFrame(buf, edge, fe);
        return;
      }
      // the pull-back: space, the heap at the camera's scale, then the shrinking arena with the Mouth at its edge
      const fh = Math.round((t - EDGE.pullStart) * EDGE.fps);
      const space = masterRamp('mouth.black')[0]!;
      pixels.fill(space);
      emissive.fill(0);
      // far stars, barely moving
      for (let k = 0; k < 160; k++) {
        const X = Math.floor(hash3(k, 5, 37) * W);
        const Y = Math.floor(hash3(k, 6, 37) * H);
        pixels[Y * W + X] = dust[1 + Math.floor(hash3(k, 7, 37) * 4)]!;
      }
      if (heap) drawPackFrame(buf, heap, Math.min(heap.frames - 1, fh));
      const R = arenaRect(t);
      // the arena: the fight as it is, shrunk (sampled, never smoothed), and the Mouth at its edge shrinking with it
      scratch.pixels.fill(0);
      scratch.emissive.fill(0);
      const src = arenaSource?.(t);
      if (src) scratch.pixels.set(src.pixels);
      else scratch.pixels.fill(masterRamp('uri.s2')[0]!);
      if (edge) drawPackFrame(scratch, edge, Math.min(edge.frames - 1, fe));
      for (let y = 0; y < R.h; y++) {
        const Y = R.y + y;
        if (Y < 0 || Y >= H) continue;
        const sy = Math.min(359, Math.floor(((y + 0.5) * 360) / R.h));
        for (let x = 0; x < R.w; x++) {
          const X = R.x + x;
          if (X < 0 || X >= W) continue;
          const sx = Math.min(639, Math.floor(((x + 0.5) * 640) / R.w));
          const c = scratch.pixels[sy * 640 + sx]!;
          pixels[Y * W + X] = c >>> 24 ? c : space;
          emissive[Y * W + X] = scratch.emissive[sy * 640 + sx]!;
        }
      }
      // its rim: a thin dark line and a dotted gold one, so the small rectangle reads as the screen it was
      const gold = white[3]!;
      for (let x = -1; x <= R.w; x++)
        for (const y of [-1, R.h]) {
          const X = R.x + x;
          const Y = R.y + y;
          if (X >= 0 && Y >= 0 && X < W && Y < H) pixels[Y * W + X] = (x >> 1) & 1 ? OUTLINE : gold;
        }
      for (let y = -1; y <= R.h; y++)
        for (const x of [-1, R.w]) {
          const X = R.x + x;
          const Y = R.y + y;
          if (X >= 0 && Y >= 0 && X < W && Y < H) pixels[Y * W + X] = (y >> 1) & 1 ? OUTLINE : gold;
        }
    },
  };
}

registerActor('edgepull', edgepullActor);
