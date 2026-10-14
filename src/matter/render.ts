import {
  LOGICAL_H,
  LOGICAL_W,
  makeLayer,
  type DirtyRect,
  type RenderLayer,
  type ViewRect,
} from '@/contracts';
import { rasterChunks, type ChunkTargets } from './chunks';
import type { WorldCore } from './core';
import { rasterParticles } from './particles';

/**
 * The pooled screen-space debris/particle layers. Four layers, allocated lazily once and re-used every call:
 *   debris-back  z -20: settled/drifting chunks behind the titans (~3 of 4 chunks, deterministic from chunk id)
 *   debris-mid   z +9:  the fight-plane chunks (over the titans, under every particle), with an emissive mask
 *   fx-front     z +10: the particles (sparks, embers, dust, gas, streams), with an emissive mask; PF_BACK particles (the
 *                       deferred FRACTURE chisel's dust) go to debris-back instead
 *   debris-near  z +15: chunks near the camera (and near-camera puffs) drawn at 2x pixel doubling with extra parallax
 * Chunks are rasterised rotated with nearest sampling (angle quantised to 1/48 turn), edge-lit per tumble angle.
 */
export class MatterRender {
  private back: RenderLayer | null = null;
  private front: RenderLayer | null = null;
  private backEmi: Uint8Array | null = null;
  private frontEmi: Uint8Array | null = null;
  private near: RenderLayer | null = null;
  private nearEmi: Uint8Array | null = null;
  private mid: RenderLayer | null = null;
  private midEmi: Uint8Array | null = null;
  private readonly midRange: Band = { a: 0, b: -1, l: LOGICAL_W, r: -1 };
  private readonly nearRange: Band = { a: 0, b: -1, l: LOGICAL_W, r: -1 };
  private readonly out: RenderLayer[] = [];
  private readonly backRange: Band = { a: 0, b: -1, l: LOGICAL_W, r: -1 };
  private readonly frontRange: Band = { a: 0, b: -1, l: LOGICAL_W, r: -1 };
  /** What each layer held after the previous call (cleared this call, so it must be re-uploaded too). */
  private readonly prev: Band[] = [0, 1, 2, 3].map(() => ({ a: 0, b: -1, l: LOGICAL_W, r: -1 }));
  /** Each layer's dirty rectangle object (reused: no per-frame garbage). */
  private readonly rects: DirtyRect[] = [0, 1, 2, 3].map(() => ({ x0: 0, y0: 0, x1: 0, y1: 0 }));
  private version = 0;
  /** The chunk rasteriser's targets (built once: no per-frame garbage). */
  private targets: ChunkTargets | null = null;

  private ensure(): void {
    if (this.back) return;
    const back = makeLayer('debris-back', 'screen', -20, LOGICAL_W, LOGICAL_H);
    const front = makeLayer('fx-front', 'screen', 10, LOGICAL_W, LOGICAL_H);
    this.backEmi = new Uint8Array(LOGICAL_W * LOGICAL_H);
    this.frontEmi = new Uint8Array(LOGICAL_W * LOGICAL_H);
    back.emissive = this.backEmi;
    front.emissive = this.frontEmi;
    this.back = back;
    this.front = front;
    const near = makeLayer('debris-near', 'screen', 15, LOGICAL_W, LOGICAL_H);
    this.nearEmi = new Uint8Array(LOGICAL_W * LOGICAL_H);
    near.emissive = this.nearEmi;
    this.near = near;
    const mid = makeLayer('debris-mid', 'screen', 9, LOGICAL_W, LOGICAL_H);
    this.midEmi = new Uint8Array(LOGICAL_W * LOGICAL_H);
    mid.emissive = this.midEmi;
    this.mid = mid;
    this.out.push(back, mid, front, near);
  }

  render(core: WorldCore, view: ViewRect, alpha: number): RenderLayer[] {
    this.ensure();
    const back = this.back!;
    const front = this.front!;
    const backEmi = this.backEmi!;
    const frontEmi = this.frontEmi!;
    const near = this.near!;
    const nearEmi = this.nearEmi!;
    const mid = this.mid!;
    const midEmi = this.midEmi!;
    const ranges = [this.backRange, this.midRange, this.frontRange, this.nearRange] as const;
    for (let i = 0; i < 4; i++) Object.assign(this.prev[i]!, ranges[i]);
    clear(back, backEmi, this.backRange);
    clear(front, frontEmi, this.frontRange);
    clear(near, nearEmi, this.nearRange);
    clear(mid, midEmi, this.midRange);
    if (this.targets === null)
      this.targets = {
        backPix: back.pixels,
        backEmi,
        frontPix: mid.pixels,
        frontEmi: midEmi,
        nearPix: near.pixels,
        nearEmi,
        backRange: this.backRange,
        frontRange: this.midRange,
        nearRange: this.nearRange,
      };
    rasterChunks(core, view, alpha, this.targets);
    rasterParticles(
      core.particles,
      view,
      alpha,
      front.pixels,
      frontEmi,
      this.frontRange,
      near.pixels,
      nearEmi,
      this.nearRange,
    );
    // PF_BACK particles (the deferred chisel's dust) behind the titans, over the back chunks
    rasterParticles(
      core.particles,
      view,
      alpha,
      back.pixels,
      backEmi,
      this.backRange,
      undefined,
      undefined,
      undefined,
      true,
    );
    // S21: upload only what changed: the rectangle drawn now plus the one drawn last time (cleared now), merged with any
    // rectangle the renderer has not consumed yet (it nulls `dirty` when it uploads). A layer empty both times is untouched.
    this.version++;
    const layers = [back, mid, front, near] as const;
    for (let i = 0; i < 4; i++)
      markDirty(layers[i]!, ranges[i]!, this.prev[i]!, this.version, this.rects[i]!);
    back.visible = this.backRange.b >= this.backRange.a;
    mid.visible = this.midRange.b >= this.midRange.a;
    front.visible = this.frontRange.b >= this.frontRange.a;
    near.visible = this.nearRange.b >= this.nearRange.a;
    return this.out;
  }

  /**
   * Supersampled export (aftermath PNG): the same four layers at (k·LOGICAL_W)×(k·LOGICAL_H), freshly allocated (export is
   * rare; the per-frame pool above is untouched). Chunks are resampled at k× (sub-pixel placement, finer rotation); particles
   * are pixel-art and are drawn at 1× then nearest-upscaled so they keep their dithered look. Reads the world, never steps it.
   */
  exportLayers(core: WorldCore, view: ViewRect, alpha: number, k: number): RenderLayer[] {
    const s = Math.max(1, Math.min(8, Math.floor(k)));
    const W = LOGICAL_W * s;
    const H = LOGICAL_H * s;
    const mk = (id: string, z: number): RenderLayer => {
      const l = makeLayer(id, 'screen', z, W, H);
      l.emissive = new Uint8Array(W * H);
      return l;
    };
    const back = mk('debris-back', -20);
    const mid = mk('debris-mid', 9);
    const front = mk('fx-front', 10);
    const near = mk('debris-near', 15);
    const r = (): { a: number; b: number } => ({ a: H, b: -1 });
    rasterChunks(
      core,
      view,
      alpha,
      {
        backPix: back.pixels,
        backEmi: back.emissive!,
        frontPix: mid.pixels,
        frontEmi: mid.emissive!,
        nearPix: near.pixels,
        nearEmi: near.emissive!,
        backRange: r(),
        frontRange: r(),
        nearRange: r(),
      },
      s,
    );
    const n1 = LOGICAL_W * LOGICAL_H;
    const fp = new Uint32Array(n1);
    const fe = new Uint8Array(n1);
    const np = new Uint32Array(n1);
    const ne = new Uint8Array(n1);
    rasterParticles(core.particles, view, alpha, fp, fe, { a: LOGICAL_H, b: -1 }, np, ne, {
      a: LOGICAL_H,
      b: -1,
    });
    upscaleOver(fp, fe, front, s);
    upscaleOver(np, ne, near, s);
    const bp = new Uint32Array(n1);
    const be = new Uint8Array(n1);
    rasterParticles(
      core.particles,
      view,
      alpha,
      bp,
      be,
      { a: LOGICAL_H, b: -1 },
      undefined,
      undefined,
      undefined,
      true,
    );
    upscaleOver(bp, be, back, s);
    for (const l of [back, mid, front, near]) {
      l.version = 1;
      l.dirty = null;
      l.visible = true;
    }
    return [back, mid, front, near];
  }
}

/** Rows a..b and columns l..r a layer touched (empty when b < a). */
interface Band {
  a: number;
  b: number;
  l: number;
  r: number;
}

/**
 * Bump the layer's version with the rectangle that changed: `now` ∪ `before` (∪ an unconsumed pending rect). Untouched layers
 * (empty now and before) keep their version: no upload at all.
 */
function markDirty(l: RenderLayer, now: Band, before: Band, version: number, rect: DirtyRect): void {
  const hasNow = now.b >= now.a && now.r >= now.l;
  const hasBefore = before.b >= before.a && before.r >= before.l;
  if (!hasNow && !hasBefore) return;
  let x0 = LOGICAL_W;
  let y0 = LOGICAL_H;
  let x1 = 0;
  let y1 = 0;
  for (const band of [now, before]) {
    if (band.b < band.a || band.r < band.l) continue;
    x0 = Math.min(x0, Math.max(0, band.l));
    y0 = Math.min(y0, Math.max(0, band.a));
    x1 = Math.max(x1, Math.min(LOGICAL_W, band.r + 1));
    y1 = Math.max(y1, Math.min(LOGICAL_H, band.b + 1));
  }
  const d = l.dirty;
  if (d) {
    // not uploaded since the last call (the layer was hidden or skipped): keep that area too
    x0 = Math.min(x0, d.x0);
    y0 = Math.min(y0, d.y0);
    x1 = Math.max(x1, d.x1);
    y1 = Math.max(y1, d.y1);
  }
  rect.x0 = x0;
  rect.y0 = y0;
  rect.x1 = x1;
  rect.y1 = y1;
  l.dirty = rect;
  l.version = version;
}

/** Clear only the rows a layer had drawn last frame, and reset its row and column range. */
function clear(l: RenderLayer, emi: Uint8Array, r: Band): void {
  if (r.b >= r.a) {
    const a = Math.max(0, r.a) * LOGICAL_W;
    const b = (Math.min(LOGICAL_H - 1, r.b) + 1) * LOGICAL_W;
    l.pixels.fill(0, a, b);
    emi.fill(0, a, b);
  }
  r.a = LOGICAL_H;
  r.b = -1;
  r.l = LOGICAL_W;
  r.r = -1;
}

/** Nearest-upscale a 1× screen layer by `s` and draw its opaque pixels over `dst` (pixels + emissive). */
function upscaleOver(pix: Uint32Array, emi: Uint8Array, dst: RenderLayer, s: number): void {
  const W = LOGICAL_W * s;
  const dp = dst.pixels;
  const de = dst.emissive!;
  for (let y = 0; y < LOGICAL_H; y++)
    for (let x = 0; x < LOGICAL_W; x++) {
      const i = y * LOGICAL_W + x;
      const p = pix[i]!;
      if (p >>> 24 === 0) continue;
      const e = emi[i]!;
      for (let yy = 0; yy < s; yy++) {
        const o = (y * s + yy) * W + x * s;
        for (let xx = 0; xx < s; xx++) {
          dp[o + xx] = p;
          if (e > de[o + xx]!) de[o + xx] = e;
        }
      }
    }
}
