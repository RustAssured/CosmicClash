import type {
  MoveDef,
  DamageEvent,
  DamageShape,
  DebugShape,
  EffectiveStats,
  FighterTickCtx,
  OverlapResult,
  RenderLayer,
  ViewRect,
} from '@/contracts';
import type { DamageSum } from './damageSum';
import type { FighterImpl } from './fighter';
import type { ActiveMove } from './move';
import type { FatShape } from './shapes';

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
  /**
   * Is this titan's sprite mirrored to face its opponent? Default true. False (우리, URI_SPEC §5: arm roles come from the
   * opponent's side, the body is never flipped): the fighter writes facing +1 and no row-shear lean on the primary body, and
   * answers an accept tick with its root instead of a lean. `FighterImpl.facing` still says which side the opponent is on.
   */
  mirrors(): boolean {
    return true;
  }
  /**
   * Called once after `attach` with the fighter's own body layer (the primary body's sprite): a multi-body titan can put the
   * part pass's planes on it (`light` / `shade` / `chunk`, src/render/unified's RenderLayerLit), as on its region layers.
   * Re-pack them here or later in place (and bump nothing: the layer's version follows the body's map).
   */
  decorateBodyLayer(_layer: RenderLayer): void {}
  /**
   * A titan whose health is not its matter (우리: the loop's integrity, 0..100; proposal 176). Non-null: the fighter shows it as
   * `view.integrityPct` and goes KO when it reaches 0, instead of the mass / core thresholds. Default null (matter integrity).
   */
  healthPct(): number | null {
    return null;
  }
  /** Extra cosmetic lean (px, facing-relative) added to the fighter's velocity/pose lean (asteroid tumble, idle sway). */
  leanBias(): number {
    return 0;
  }
  /**
   * The body's own pose this tick (the Asteroid's living idle, WJ 2026-10-17): `ox`/`oy` whole-pixel world offsets added like
   * the bob and sway, and `rot` a rotation step (contracts/rotation.ts) for the primary body, or −1 to leave the transform's
   * rotation alone. Called once per tick from the fighter's transform, before this tick's hits: what is drawn is what is hit,
   * so this is SIM state (deterministic, in `hash()`). Default: no pose.
   */
  bodyPose(_out: { ox: number; oy: number; rot: number }): void {}
  /** Hit-stop began (visual freeze). */
  onFreeze(_ticks: number): void {}
  /**
   * The channel through which this behaviour answers `cmd` (a move slot, 'guard', 'feint', 'steer') on THIS tick, or null.
   * Called on the accept tick, after the command took effect (a move's telegraph is armed in onMoveStart; a raised Guard is
   * `guardUp`). A non-null answer is that command's accept-tick pixel: the fighter reports `respond` through it and adds no
   * root/lean nudge of its own (a world answers with light and fx, not by shuffling).
   */
  feelRespond(_cmd: string): 'light' | 'fx' | null {
    return null;
  }
  /**
   * Scale-of-motion instrumentation (`tools/feel/scale.ts`, docs/briefs/scale-spec.md): push the world x,y of the parts that
   * should move at planet scale (tendril/arm tips, moons, halo segments…) into `out` as pairs; return how many pairs. The
   * order must be stable from tick to tick (one signal per index). Optionally push one kind per pair into `kinds`: 0 = a part
   * (held to the whole spec), 1 = a projectile in flight (a slung moon: held to the wobble limit only). Default: none.
   */
  trackPoints(_out: number[], _kinds?: number[]): number {
    return 0;
  }

  /**
   * Hold alternatives (proposal 133): for a move with `extra.hold = { after, move? }`, the fighter asks this once, on startup
   * tick `after`, while the move's button is still held. Return the move it turns into (null = keep the move). The default
   * returns `extra.hold.move` when the JSON names one. The fighter swaps through `startMove` (same move event, costs and
   * `onMoveStart`) without a second feel accept: it is still one command.
   */
  holdAlternative(m: ActiveMove): MoveDef | null {
    const id = (m.def?.extra?.['hold'] as { move?: string } | undefined)?.move;
    return id ? (this.f.moveById(id) ?? null) : null;
  }

  /* ---- multi-body fighters (the Witness, proposal 160) ---- */

  /**
   * Place the fighter's region bodies for THIS tick (transforms: x, y, rot), right after the primary body's transform was
   * set and before this tick's hits are resolved, so a blow meets the regions where they are drawn. Default: nothing.
   */
  placeRegions(): void {}
  /**
   * Apply an incoming blow to the fighter's matter yourself (e.g. front-to-back through reveal layers): call
   * `world.applyDamage` for each body the energy reaches and fold each result in at once with `addDamageResult(out, r)`
   * (`src/combat/damageSum.ts`). Return true when handled; false = the fighter's default routing (the primary body, or the
   * blow split over every touched region body by cells touched).
   */
  routeDamage(_ev: DamageEvent, _out: DamageSum): boolean {
    return false;
  }
  /**
   * The mass frame the impact model turns a blow about (lever arm, inertia): WORLD centre of mass, radius of gyration and
   * outer radius (px) of the whole fighter. Return true to supply it (a rig whose load is spread over many regions); false =
   * the primary body's own mass properties.
   */
  massFrame(_out: { x: number; y: number; gyration: number; radius: number }): boolean {
    return false;
  }
  /**
   * Attached hitboxes: move the live shape of hitbox `hb` (its JSON id) onto the part that really carries it this tick (the
   * Cradle's jaw-organ at the end of its rig chain), so the blow lands where it is drawn. Called after the template was placed
   * (resolution and `liveHitShape`). Return true when the shape was moved: the fighter then skips its look-ahead (the template
   * no longer predicts where the part will be). Default: false, the template stands.
   */
  attachHitShape(_hb: string, _shape: FatShape): boolean {
    return false;
  }
  /** Fold behaviour-owned sim state (a rig) into a determinism hash. Default: unchanged. */
  hash(h: number): number {
    return h;
  }
  setVictory(): void {}
}

export class DefaultBehaviour extends Behaviour {}
