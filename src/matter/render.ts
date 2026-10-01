import { LOGICAL_H, LOGICAL_W, makeLayer, type RenderLayer, type ViewRect } from '@/contracts';
import { rasterChunks } from './chunks';
import type { WorldCore } from './core';
import { rasterParticles } from './particles';

/**
 * The pooled screen-space debris/particle layers. Four layers, allocated lazily once and re-used every call:
 *   debris-back  z -20: settled/drifting chunks behind the titans (~3 of 4 chunks, deterministic from chunk id)
 *   debris-mid   z +9:  the fight-plane chunks (over the titans, under every particle), with an emissive mask
 *   fx-front     z +10: all particles (sparks, embers, dust, gas, streams), with an emissive mask
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
    // Clear only the rows drawn last frame.
    const clear = (l: RenderLayer, emi: Uint8Array, r: { a: number; b: number }): void => {
      if (r.b >= r.a) {
        const a = Math.max(0, r.a) * LOGICAL_W;
        const b = (Math.min(LOGICAL_H - 1, r.b) + 1) * LOGICAL_W;
        l.pixels.fill(0, a, b);
        emi.fill(0, a, b);
      }
      r.a = LOGICAL_H;
      r.b = -1;
    };
    const near = this.near!;
    const nearEmi = this.nearEmi!;
    clear(back, backEmi, this.backRange);
    clear(front, frontEmi, this.frontRange);
    clear(near, nearEmi, this.nearRange);
    const mid = this.mid!;
    const midEmi = this.midEmi!;
    clear(mid, midEmi, this.midRange);
    rasterChunks(core, view, alpha, {
      backPix: back.pixels,
      backEmi,
      frontPix: mid.pixels,
      frontEmi: midEmi,
      nearPix: near.pixels,
      nearEmi,
      backRange: this.backRange,
      frontRange: this.midRange,
      nearRange: this.nearRange,
    });
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
}
