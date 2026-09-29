import type {
  DamageEvent,
  DamageShape,
  DebugShape,
  EffectiveStats,
  FighterTickCtx,
  OverlapResult,
  RenderLayer,
  ViewRect,
} from '@/contracts';
import type { FighterImpl } from './fighter';
import type { ActiveMove } from './move';

/** What the attacker tells the defender about the blow (set before `receive`, read by the defender's fighter). */
export interface HitInfo {
  /** Knockback at mass-neutral, world px/s. */
  knockX: number;
  knockY: number;
  guardPressure: number;
  hitstopBase: number;
  heavy: boolean;
  continuous: boolean;
  /** Scales the hit-stun this blow inflicts (beams stun less). */
  stunMul: number;
  moveId: string;
}

/** What a defender's parts (tendrils, moons, fragments) did to an incoming blow. */
export interface InterceptResult {
  /** Fraction (0..1) of the blow's energy soaked by parts. */
  absorbed: number;
  /** Number of part hits (severs, knock-offs). */
  partsHit: number;
  /** Cells removed by extra events the behaviour applied itself (e.g. the exposed eye). */
  extraCells: number;
  extraMass: number;
  /** True if the parts alone connected (nothing solid was touched by the shape). */
  touched: boolean;
}

/**
 * The seam between the generic Fighter and one titan's unique parts (tendrils, moons, fragments, disk…). The Fighter
 * owns state machine, movement, hit resolution and the view; a Behaviour supplies the body-external pieces and the
 * failure mode. Every hook has a no-op default so a new titan overrides only what it needs.
 */
export abstract class Behaviour {
  protected readonly f: FighterImpl;
  constructor(f: FighterImpl) {
    this.f = f;
  }

  /** Called once after the body exists. Allocate pools here. */
  attach(): void {}
  /** Between rounds (after the body healed). */
  reset(_heal: number): void {}
  /** Every tick after movement and the state machine, before threats/view sync. */
  update(_ctx: FighterTickCtx): void {}
  /** Adjust live stats after `computeStats` (rubble pile, momentum, inverted mass for accretors…). */
  adjustStats(_s: EffectiveStats, _massFrac: number): void {}

  onMoveStart(_m: ActiveMove): void {}
  onRelease(_m: ActiveMove): void {}
  onMoveEnd(_m: ActiveMove, _interrupted: boolean): void {}
  /** The fighter was knocked out. */
  onKo(): void {}
  /** This fighter connected with something. */
  onDealt(_energy: number): void {}
  /** This fighter was hit (after guard/parts/world). */
  onDamaged(_energy: number, _hitDirX: number, _hitDirY: number): void {}

  /** Extra hit volumes owned by the behaviour (swarm fragments): resolve them against the foe now. */
  resolveVolumes(_ctx: FighterTickCtx): void {}

  /** Add part hits to `out` (cells, centroid) and return how many parts the shape touches. */
  probeParts(_shape: DamageShape, _out: OverlapResult): number {
    return 0;
  }
  /** Intercept an incoming blow with parts. May reduce `res.absorbed`, sever things, apply extra damage. */
  intercept(_ev: DamageEvent, _info: HitInfo, _res: InterceptResult): void {}
  /** Multiplier (0..1.5) on how strong the Guard shell is right now (e.g. tendrils left). */
  guardMultiplier(): number {
    return 1;
  }

  /** Append overlay layers for this frame. */
  renderLayers(_view: ViewRect, _alpha: number, _out: RenderLayer[]): void {}
  debugShapes(_out: DebugShape[]): void {}
  /** Extra cosmetic lean (px, facing-relative) added to the fighter's velocity/pose lean (asteroid tumble, idle sway). */
  leanBias(): number {
    return 0;
  }
  /** Hit-stop began (visual freeze). */
  onFreeze(_ticks: number): void {}
  setVictory(): void {}
}

export class DefaultBehaviour extends Behaviour {}
