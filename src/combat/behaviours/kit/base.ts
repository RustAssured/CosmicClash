import type { EffectiveStats, FighterTickCtx, RenderLayer, ViewRect } from '@/contracts';
import { Behaviour } from '../../behaviour';
import type { ActiveMove } from '../../move';
import { KitMotion } from './motion';

/**
 * The titan kit's behaviour base: a titan with no body-external parts (no tendrils, moons or swarms) and ONE signature
 * mechanic hook. A scaffolded titan (`npm run new:titan`) extends it in src/combat/behaviours/kit/<id>.ts and fills in
 * `onSignature` (and, if it wants, `signatureTick` while the effect lasts and `signatureStats` to bend its stats).
 *
 * Determinism: keep every piece of state that changes the fight in fields, change it only from these hooks (they run on the
 * sim tick), and fold it into `hashState` so the replay check (roster.test.ts) sees it.
 */
export abstract class KitBehaviour extends Behaviour {
  /** Ticks left on the signature effect (0 = off). */
  protected signatureLeft = 0;
  /** Its animation presets (`kit.motion`), built on the first drawn frame; presentation only. */
  private motion: KitMotion | null | undefined;

  /** The signature move's active phase began: start the titan's mechanic here. */
  protected onSignature(_m: ActiveMove): void {}
  /** Every tick while `signatureLeft > 0` (it counts down by itself). */
  protected signatureTick(_ctx: FighterTickCtx): void {}
  /** Bend live stats while the signature effect lasts (e.g. `s.damageMul *= 1.2`). */
  protected signatureStats(_s: EffectiveStats): void {}
  /** Fold any extra state into the determinism hash. */
  protected hashState(h: number): number {
    return h;
  }

  override onRelease(m: ActiveMove): void {
    if (m.def?.slot === 'signature') this.onSignature(m);
  }

  override update(ctx: FighterTickCtx): void {
    if (this.signatureLeft > 0) {
      this.signatureTick(ctx);
      this.signatureLeft--;
    }
  }

  override adjustStats(s: EffectiveStats, _massFrac: number): void {
    if (this.signatureLeft > 0) this.signatureStats(s);
  }

  override reset(_heal: number): void {
    this.signatureLeft = 0;
  }

  /**
   * Draw its animation presets (`kit.motion`, src/combat/behaviours/kit/motion.ts), if it has any. A behaviour with a
   * hand-written idle overrides this and draws its own instead.
   */
  override renderLayers(_view: ViewRect, _alpha: number, out: RenderLayer[]): void {
    const f = this.f;
    if (this.motion === undefined)
      this.motion = f.def.kit?.motion?.length ? new KitMotion(f.body.map, f.def) : null;
    const k = this.motion;
    if (!k?.active || (f.ko && f.stateTicks > 50)) return;
    const m = f.mv;
    k.render(
      out[out.length - 1]!,
      f.body.map,
      {
        tick: f.tickNo,
        slot: m.def ? m.def.slot : null,
        phase: m.phase,
        phaseTick: m.phaseTick,
        startup: m.startup,
        active: m.active,
        recovery: m.recovery,
        aim: m.aim,
        guarding: f.state === 'guard',
      },
      out,
    );
  }

  override hash(h: number): number {
    return this.hashState(Math.imul(h ^ this.signatureLeft, 0x01000193) >>> 0);
  }
}
