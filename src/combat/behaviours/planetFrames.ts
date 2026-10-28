import type { StageLighting } from '@/contracts';

/**
 * The Planet's 240 rotation frames (idle handover specs/planet.md §2): per frame and face cell, the colour the painter gives
 * the world turned by fi/240 of a day, and the cell's surface class. Baked in a Web Worker (src/titans/art/planetBake.worker.ts)
 * in the order the rotation needs them, so the sim never waits; a frame not baked yet is simply not drawn (the face holds
 * the last one). Without workers (Node, the unit tests) nothing is baked and the body shows its painted face, as before.
 * Shared per (titan, seed, light): a mirror match of one world bakes once; at most two jobs are kept.
 */
export class PlanetFrames {
  static readonly F = 240;
  readonly nc: number;
  readonly col: Uint32Array;
  readonly cls: Uint8Array;
  readonly have: Uint8Array;
  /** Frames baked so far, and the whole bake's wall time once complete (ms; the perf gate reads `lastBakeMs`). */
  baked = 0;
  bakeMs = -1;
  static lastBakeMs = -1;
  private worker: Worker | null = null;
  private lastAim = -1;
  private lastDir = 0;
  private readonly t0 = typeof performance !== 'undefined' ? performance.now() : 0;

  private static readonly cache = new Map<string, PlanetFrames>();

  static of(titan: string, seed: number, lighting: StageLighting, cells: Int32Array): PlanetFrames {
    const key = `${titan}|${seed >>> 0}|${lighting.dir.join(',')}|${lighting.color}|${lighting.ambient}|${cells.length}`;
    let f = PlanetFrames.cache.get(key);
    if (!f) {
      f = new PlanetFrames(titan, seed, lighting, cells);
      if (PlanetFrames.cache.size >= 2) {
        const old = PlanetFrames.cache.keys().next().value as string;
        PlanetFrames.cache.get(old)?.stop();
        PlanetFrames.cache.delete(old);
      }
      PlanetFrames.cache.set(key, f);
    }
    return f;
  }

  private constructor(titan: string, seed: number, lighting: StageLighting, cells: Int32Array) {
    const F = PlanetFrames.F;
    this.nc = cells.length;
    this.col = new Uint32Array(F * this.nc);
    this.cls = new Uint8Array(F * this.nc);
    this.have = new Uint8Array(F);
    if (typeof Worker === 'undefined' || typeof window === 'undefined') return;
    try {
      this.worker = new Worker(new URL('../../titans/art/planetBake.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      this.worker = null;
      return;
    }
    this.worker.onmessage = (
      e: MessageEvent<{ t: 'frame'; fi: number; col: Uint32Array; cl: Uint8Array }>,
    ): void => {
      const m = e.data;
      if (m.t !== 'frame') return;
      this.col.set(m.col, m.fi * this.nc);
      this.cls.set(m.cl, m.fi * this.nc);
      if (!this.have[m.fi]) this.baked++;
      this.have[m.fi] = 1;
      if (this.baked === F) {
        this.bakeMs = performance.now() - this.t0;
        PlanetFrames.lastBakeMs = this.bakeMs;
      }
    };
    this.worker.postMessage({
      t: 'start',
      titan,
      seed: seed >>> 0,
      lighting,
      cells,
      frames: F,
      aim: 0,
      dir: -1,
    });
  }

  /** The frame on screen and the way the world turns: the worker bakes the nearest missing frames that way first. */
  aim(fi: number, dir: number): void {
    if (!this.worker || this.baked >= PlanetFrames.F) return;
    const d = dir < 0 ? -1 : 1;
    if (fi === this.lastAim && d === this.lastDir) return;
    this.lastAim = fi;
    this.lastDir = d;
    this.worker.postMessage({ t: 'aim', aim: fi, dir: d });
  }

  private stop(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
