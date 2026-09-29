/**
 * Every feel knob of the Fighter framework in one place. Numbers are per second unless a name says Ticks.
 * The measurable targets (docs/briefs/B3, DESIGN §4) are asserted by src/combat/feel.test.ts.
 */
export const TUNING = {
  /* ---- movement ---- */
  /** Top speed (px/s) = speedBase + speedPerTempo × TEMPO, × live speedMul. */
  speedBase: 130,
  speedPerTempo: 13,
  /** Vertical top speed relative to horizontal. */
  vertSpeedMul: 0.75,
  /** First-order stick response time constant (s): 70% of top speed after 0.2 s (1 − e^(−0.2/0.166) = 0.70). */
  accelTau: 0.166,
  /** Half-life (s) of the glide when the stick is released (spec: long glide). */
  glideHalfLife: 0.35,
  /** Below this stick magnitude the input counts as released. */
  stickDeadzone: 0.12,
  /** Altitude spring toward arena.restY (1/s²) and its damping (1/s): a soft pull, never a floor. */
  altitudeK: 3.2,
  altitudeC: 1.1,
  /** Stick response multiplier while in each phase (attacks keep some steering, never a rail). */
  ctlStartup: 0.35,
  ctlCharge: 0.3,
  ctlActive: 0.15,
  ctlRecovery: 0.4,
  ctlGuard: 0.42,
  /** Facing flips only when the foe is at least this far (px) past the anchor (no flicker at crossover). */
  turnHysteresis: 10,
  /** Bodies may overlap this many px at the edges before they push apart; cores never pass through each other. */
  overlapAllowance: 9,
  /** Soft wall: fraction of arena.softWall over which speed into the wall is bled off. */
  wallBleed: 0.9,
  /** Bob (px) of the idle breathing offset applied to the body transform. */
  idleBob: 1.4,

  /* ---- lean (integer row shear; spring-damper so direction changes overshoot a little) ---- */
  leanPerSpeed: 7,
  leanOmega: 15,
  leanZeta: 0.5,

  /* ---- hits ---- */
  /** Knockback = hitbox.knockback / (effective mass / 5); velocity impulse in px/s. */
  massNeutral: 5,
  /** Fraction of the matter world's reported impulse that becomes knockback (on top of the hitbox's own). */
  worldImpulseGain: 0.02,
  /** Hit-stun ticks = base × sqrt(energy/300) × sqrt(5/mass), clamped. Heavy titans are stunned less. */
  stunBase: 15,
  stunMin: 6,
  stunMax: 34,
  /** After hit-stun ends, further stun within this window is scaled down (no stun-lock). */
  stunGraceTicks: 40,
  stunComboScale: 0.55,
  /** Ticks into hit-stun after which SURGE breaks out (the escape route). */
  stunEscapeTicks: 9,
  /** Cooldown (ticks) between stun-escape surges. */
  escapeCooldown: 90,
  /** Surge (any) cooldown so it stays a decision, not a spam key. */
  surgeCooldown: 14,
  /** Feint recovery (ticks). */
  feintRecovery: 10,
  /** Hit-event rate limit for continuous (beam) hitboxes, ticks. */
  continuousEventEvery: 5,

  /* ---- guard ---- */
  guardRaiseTicks: 3,
  guardDropTicks: 5,
  guardBreakStun: 54,
  guardRegenPerSec: 0.22,
  guardBreakRecover: 0.45,
  /** Guard health drained per hit = pressure × (guardDrainBase + energy / guardDrainEnergy). */
  guardDrainBase: 0.1,
  guardDrainEnergy: 2500,
  /** Guard also cuts knockback and stun by this factor. */
  guardKnockbackMul: 0.3,

  /* ---- meter ---- */
  meterDealt: 1 / 3200,
  meterTaken: 1 / 6400,
  meterCarryOver: 0.35,

  /* ---- KO ---- */
  koTimescale: 0.3,
  koTimescaleTicks: 45,

  /* ---- live stats from remaining mass ---- */
  lightSpeedGain: 0.45,
  lightTempoGain: 0.35,
  lightDamageLoss: 0.6,
  lightMassLoss: 0.55,
  lightReachLoss: 0.15,

  /* ---- presentation ---- */
  /** Hit-stop ticks = frame.hitstop × (0.7 + energy/900) × sqrt((mA + mB)/10). */
  hitstopEnergyRef: 900,
} as const;
