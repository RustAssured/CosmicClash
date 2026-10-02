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
  /**
   * Stick response of the underdamped velocity filter: natural frequency (rad/s) for a mass-5 body before the per-titan feel.
   * Scale of motion (D28): 6 rad/s (was 8.6) — about 70 % of top speed after 0.3 s, so the root's velocity builds over
   * ≥ 0.25 s after the first pixel instead of snapping.
   */
  steerOmega: 6,
  /** Bob (px) of the idle breathing offset applied to the body transform (only when a titan's feel does not set one). */
  idleBob: 1.4,
  /**
   * Steering is a bounded FORCE, not a velocity override: the stick filter's acceleration is capped at this (px/s², mass-5
   * body, divided by the titan's accelMul), so momentum from a blow or a collision has to be fought off, not deleted.
   */
  steerAccelMax: 1500,
  /** Velocity time constant (s) of a KO'd body's long tumble. */
  koGlideTau: 0.95,
  /** Velocity time constant (s) while stunned: the struck body brakes its slide slowly (D28: long and slow, never a jiggle). */
  stunDragTau: 0.65,

  /* ---- pixel-first response (every accepted command changes a drawn pixel on its accept tick) ---- */
  /** A new stick direction: the root steps this many px at once and the top lags (counter-lean, px). */
  steerNudgePx: 1,
  steerCounterLean: 1.6,
  /** Ticks the stick must stay neutral before a new push counts as a new command, and the direction change that counts as one. */
  steerRearmTicks: 4,
  steerTurnCos: 0.7,
  /** A facing flip keeps the world lean and adds this counter-rotation (px, the top lags behind the new forward). */
  turnCounterLean: 2.4,
  /** Guard raise: the body braces back (lean px); feint: a jolt (lean px toward upright and beyond). */
  guardBrace: -1.6,
  feintJolt: 2,
  /** Whole-body torsion kick (rad/s) of a guard, feint or stick command: the mass rocks and settles with overshoot. */
  commandTorsion: 0.5,
  /** Settle: lean within this of its target, lean speed and spin under these, for 3 ticks. */
  settleLean: 0.6,
  settleLeanV: 4,
  settleSpin: 0.12,
  settleSpeedFrac: 0.08,

  /* ---- lean (integer row shear; spring-damper so direction changes overshoot a little) ---- */
  leanPerSpeed: 7,
  /** Scale of motion (D28): ω 6.5 rad/s ≈ 1 Hz (was 15 ≈ 2.4 Hz) and ζ 0.6: one slow overshoot, never a quiver. */
  leanOmega: 6.5,
  leanZeta: 0.6,

  /* ---- lean limits and the angular state ---- */
  /** |lean| cap in px (velocity lean + pose + torsion together). */
  leanMax: 18,
  /** Torsion (a body that springs back upright): natural frequency (rad/s), damping ratio, spin drag (s), caps. */
  torsionOmega: 5,
  torsionZeta: 0.5,
  torsionDragTau: 1.2,
  /** Free spin (a world): spin drag time constant (s). */
  spinDragTau: 2.6,
  maxSpin: 6,
  maxTorsion: 0.2,

  /* ---- hits ---- */
  /**
   * A blow's momentum J = hitbox.knockback × knockScale × attacker mass × (clamped mass-ratio correction), so the
   * defender's Δv = J / its mass equals knockback × knockScale × (mA/mD)^knockMassExp, capped at knockMax. It goes into
   * the body's ONE velocity (real momentum): drag and the defender's own thrust take it out, nothing else.
   */
  massNeutral: 5,
  knockScale: 0.5,
  knockMassExp: 1,
  knockRatioMin: 0.22,
  knockRatioMax: 1.9,
  knockMax: 580,
  /** A blow that KOs launches this much harder (a long tumble under the slow-motion time scale). */
  koKnockMul: 1.4,
  /** Bodies in contact exchange momentum along the contact normal with this restitution (heavy, nearly inelastic). */
  restitution: 0.1,
  /** Share of the overlap and of the momentum exchange worked out per tick of contact (soft contact, D28 scale of motion). */
  contactSoftness: 0.12,
  /** Recoil: lean velocity kick per unit of raw knockback, capped (px/s of shear velocity). */
  recoilGain: 0.16,
  recoilMax: 150,
  /** Victim vibration amplitude (px) = shudderBase + energy/shudderEnergy, decaying by shudderDecay per tick; capped at 2. */
  shudderBase: 0.9,
  shudderEnergy: 1500,
  shudderDecay: 0.8,
  /** Attacker follow-through: visual push (px) through the contact and its per-tick decay. */
  followMax: 6,
  followDecay: 0.93,
  /** Low-frequency thud shake of a heavy release (Crush or Ultimate), amplitude = thudGain x (mass/5)^thudMassExp. */
  thudGain: 1.6,
  thudMassExp: 1.1,
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
  /** Ticks over which a Surge's dash velocity builds (a massive launch, not a teleport; other keys use KEY_RAMP_TICKS). */
  surgeRampTicks: 6,
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
  /**
   * Hit-stop is a beat, not the carrier of weight (D27): ticks = MIN + (MAX − MIN) × clamp01(frame.hitstop / hitstopBaseRef ×
   * energy / hitstopEnergyRef × sqrt((mA + mB)/10) × (1 − 0.4 blocked)). A heavy blow reaches the 8-tick cap; a Strike sits near 5.
   */
  hitstopEnergyRef: 1000,
  hitstopBaseRef: 12,
  /** Camera roll (rad) per rad/s of spin a blow puts into the target (ω-driven roll; the camera caps it at 1.5°). */
  rollPerSpin: 0.006,
} as const;
