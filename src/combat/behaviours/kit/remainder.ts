import type { EffectiveStats, FighterTickCtx, RenderLayer, ViewRect } from '@/contracts';
import type { ActiveMove } from '../../move';
import { idleSeed } from '../../fx/idle';
import { KitBehaviour } from './base';
import { RemainderIdle } from './remainderIdle';

/**
 * The Remainder's behaviour (titan kit, blob template; body imported from key art). ONE signature mechanic hook:
 * `onSignature` runs when its signature move (remainder.swell) goes active. The placeholder: it swells for two seconds and
 * every blow it lands hits 20 % harder. Its own ideas (Compaction, Loosening, Cannibal) are in docs/titans/remainder/BRIEF.md.
 *
 * Its living idle (the vortex turning, the ichor flowing, the eye breathing, wreckage in orbit) is presentation only:
 * src/combat/behaviours/kit/remainderIdle.ts, drawn at render time from the tick recorded here.
 *
 * Keep the sim deterministic: state in fields, changed only in these hooks, folded into `hashState`.
 */
export class RemainderBehaviour extends KitBehaviour {
  private idle: RemainderIdle | null = null;
  /** Render-side inputs, recorded on the sim tick (not hashed: nothing in the fight reads them). */
  private drawTick = 0;

  protected override onSignature(_m: ActiveMove): void {
    this.signatureLeft = 120; // ticks (60 = one second)
  }

  protected override signatureStats(s: EffectiveStats): void {
    s.damageMul *= 1.2;
  }

  override update(ctx: FighterTickCtx): void {
    super.update(ctx);
    this.drawTick = ctx.tick;
  }

  override reset(heal: number): void {
    super.reset(heal);
    this.idle?.reset();
  }

  override renderLayers(_view: ViewRect, _alpha: number, out: RenderLayer[]): void {
    const f = this.f;
    const body = out[out.length - 1]!;
    this.idle ??= new RemainderIdle(
      f.body.map,
      f.def.materials.map((m) => m.key),
      idleSeed(f.seed, f.slot),
    );
    this.idle.render(
      body,
      f.body.map,
      { tick: this.drawTick, sinceHit: this.drawTick - f.lastHitTick, ko: f.ko && f.stateTicks > 50 },
      out,
    );
  }
}
