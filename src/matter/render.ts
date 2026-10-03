import { LOGICAL_H, LOGICAL_W, makeLayer, type RenderLayer, type ViewRect } from '@/contracts';
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
  private readonly midRange = { a: 0, b: -1 };
  private readonly nearRange = { a: 0, b: -1 };
  private readonly out: RenderLayer[] = [];
  private readonly backRange = { a: 0, b: -1 };
  private readonly frontRange = { a: 0, b: -1 };
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
    clear(back, backEmi, this.backRange);
    clear(front, frontEmi, this.frontRange);
    clear(near, nearEmi, this.nearRange);
    const mid = this.mid!;
    const midEmi = this.midEmi!;
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
    this.version++;
    back.version = this.version;
    mid.version = this.version;
    front.version = this.version;
    near.version = this.version;
    back.dirty = null;
    mid.dirty = null;
    front.dirty = null;
    near.dirty = null;
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

/** Clear only the rows a layer had drawn last frame, and reset its row range. */
function clear(l: RenderLayer, emi: Uint8Array, r: { a: number; b: number }): void {
  if (r.b >= r.a) {
    const a = Math.max(0, r.a) * LOGICAL_W;
    const b = (Math.min(LOGICAL_H - 1, r.b) + 1) * LOGICAL_W;
    l.pixels.fill(0, a, b);
    emi.fill(0, a, b);
  }
  r.a = LOGICAL_H;
  r.b = -1;
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
