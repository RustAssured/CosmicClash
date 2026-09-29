import type { WebGLRenderer, WebGLRenderTarget } from 'three';
import type { StageId } from '@/contracts';
import { runToEnd } from '@/render/slicer';
import type {
  PrepareStep,
  QualityTier,
  SceneryFrame,
  SceneryInit,
  SceneryLook,
  StageScenery,
} from '../types';
import { SceneryKit } from './kit';

/**
 * Boilerplate every stage shares: owns the `SceneryKit`, runs `build` as a resumable generator (so `Renderer.prepareStage` can
 * spread it over frames), forwards `update/render/setQuality/compile/dispose`, and keeps the stage light position.
 *
 * A stage subclass supplies its `id`, `look`, a noise seed and `*build(kit, ctx)` — a generator that adds layers to the kit and
 * `yield`s a progress fraction after each expensive step (a particle field, a bake pass) so the load can pause there.
 */
export abstract class SceneryBase implements StageScenery {
  abstract readonly id: StageId;
  abstract readonly look: SceneryLook;
  protected abstract readonly noiseSeed: number;
  protected kit: SceneryKit | null = null;
  protected renderer: WebGLRenderer | null = null;

  protected abstract build(kit: SceneryKit, ctx: SceneryInit): Generator<PrepareStep, void, void>;
  /** Per-frame hook after the kit's uniforms are updated (ambient life, stage-specific state). */
  protected onUpdate(_frame: SceneryFrame): void {}
  abstract lightScreenPos(out: { x: number; y: number }): void;

  *prepare(ctx: SceneryInit): Generator<PrepareStep, void, void> {
    this.renderer = ctx.renderer;
    const kit = new SceneryKit(ctx, this.noiseSeed);
    this.kit = kit;
    yield 0.02;
    yield* this.build(kit, ctx);
    kit.setQuality(ctx.quality);
    yield 1;
  }

  init(ctx: SceneryInit): void {
    runToEnd(this.prepare(ctx));
  }

  async compile(target: WebGLRenderTarget): Promise<void> {
    if (this.kit && this.renderer) await this.kit.compile(this.renderer, target);
  }

  setQuality(q: QualityTier): void {
    this.kit?.setQuality(q);
  }

  update(frame: SceneryFrame): void {
    this.kit?.update(frame);
    this.onUpdate(frame);
  }

  render(target: WebGLRenderTarget): void {
    if (this.kit && this.renderer) this.kit.render(this.renderer, target);
  }

  dispose(): void {
    this.kit?.dispose();
    this.kit = null;
    this.disposeExtras();
  }

  /** Free stage-owned GPU objects (bake targets…). */
  protected disposeExtras(): void {}
}
