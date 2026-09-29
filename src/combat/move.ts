import type { AimDir, FrameData, MoveDef, MovePhase, MoveVariant } from '@/contracts';

/** Max hitboxes per variant the runtime tracks re-hit state for (validated when a move starts). */
export const MAX_HITBOXES = 24;
export const MAX_DISP = 400;

/**
 * Runtime state of the move in progress (one preallocated instance per fighter — moves never allocate).
 * Ticks are 1-based: the press tick is tick 1 (the anticipation pose shows there), the first active tick is
 * `startup + 1`, and hitbox windows are relative to the first active tick.
 */
export class ActiveMove {
  def: MoveDef | null = null;
  variant: MoveVariant | null = null;
  aim: AimDir = 'forward';
  /** The button that started the move (hold-to-charge reads it). */
  button = 0;

  /* frame data resolved at start (tempo-scaled startup/recovery, aim overrides applied) */
  startup = 1;
  active = 0;
  recovery = 0;
  chargeMax = 0;
  cancelWindow = 0.4;
  hitstop = 0;

  /** Ticks since the move began (1-based) and phase bookkeeping. */
  tick = 0;
  phase: MovePhase = 'startup';
  phaseTick = 0;
  chargeTicks = 0;
  /** Charge scaling: energy multiplier and length multiplier (1 = uncharged). */
  power = 1;
  reach = 1;
  /** Last tick each hitbox connected (−1 = not yet). */
  readonly hitAt = new Int32Array(MAX_HITBOXES).fill(-1);
  /** Next movement key to fire. */
  keyIdx = 0;
  /** Per-second velocity retention set by the latest movement key (1 = none). */
  damp = 1;
  /** 8-way surge direction (world). */
  dirX = 1;
  dirY = 0;
  /** Cancelled by a feint: no hitboxes, short stumble recovery. */
  feint = false;
  /** True once the release event fired. */
  released = false;
  /** Set when this move ended by being cancelled or interrupted (behaviours can react). */
  interrupted = false;
  /** Counts hits this move connected (AI/passives). */
  hits = 0;
  /**
   * Predicted forward displacement (px, facing-relative) of the anchor at each choreography tick since the move began, from the
   * movement keys and the same decay maths as the fighter's movement. Used to place UPCOMING hit shapes where the attack will
   * actually be when it goes live (a lunge covers ground before its hitbox appears).
   */
  readonly disp = new Float32Array(MAX_DISP);

  reset(): void {
    this.def = null;
    this.variant = null;
    this.tick = 0;
    this.phaseTick = 0;
    this.phase = 'startup';
    this.chargeTicks = 0;
    this.power = 1;
    this.reach = 1;
    this.hitAt.fill(-1);
    this.keyIdx = 0;
    this.damp = 1;
    this.feint = false;
    this.released = false;
    this.interrupted = false;
    this.hits = 0;
  }
}

/** Merge a variant's frame override over the move's default frame data. */
export function resolveFrame(def: MoveDef, variant: MoveVariant): FrameData {
  return variant.frame ? { ...def.frame, ...variant.frame } : def.frame;
}

/** Stick → aim: up / down beyond 0.45 deflection, otherwise forward (neutral or toward the foe). */
export function aimFromStick(moveY: number): AimDir {
  return moveY < -0.45 ? 'up' : moveY > 0.45 ? 'down' : 'forward';
}

/** Fill `out` with forward displacement per tick for a move's movement keys, starting from forward velocity `v0` (px/s). */
export function fillDisplacement(
  out: Float32Array,
  keys: readonly { at: number; ix: number; damp?: number }[],
  v0: number,
  dt: number,
  glideHalfLife: number,
): void {
  const half = Math.pow(0.5, dt / glideHalfLife);
  let v = v0;
  let x = 0;
  let damp = 1;
  let ki = 0;
  for (let t = 0; t < out.length; t++) {
    while (ki < keys.length && keys[ki]!.at <= t) {
      const k = keys[ki++]!;
      v += k.ix;
      if (k.damp !== undefined) damp = k.damp;
    }
    v *= damp < 1 ? Math.pow(damp, dt) : half;
    x += v * dt;
    out[t] = x;
  }
}
