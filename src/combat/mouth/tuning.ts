/**
 * The Mouth's numbers (mouth/docs/MOUTH_TUNING.md, the locked prototype `mouth/src/30_mouth_core_motion_damage.js`) and
 * the game-side values Gate 3A (docs/integration/GATE_3A.md, D37) added. Everything is mutable so the debug overlay can
 * tune it during a real match (MASTER_PROMPT ground rule 6); the defaults are WJ's tuning.
 *
 * `MOUTH_TUNE` is the oracle's own slider block (TUNE in the prototype). `MOUTH_GAME` holds what the oracle has no number
 * for: each entry says where it comes from, and "to tune" marks a provisional value (Gate 3A §7 / Phase 4 balance).
 */

/** The oracle's sliders (1.00 = neutral), WJ's tuning: slide 243 px/s, strike 1.18, lag 1.00, reach 0.90, tracking 1.39. */
export const MOUTH_TUNE = { slide: 243, strike: 1.18, lag: 1, reach: 0.9, track: 1.39 };

/** Beats of each strike (seconds): MOUTH_TUNING.md "Moves". Strike / sweep beats are ÷ strike speed × height factor. */
export const MOUTH_MOVES = {
  bite: [
    ['load', 0.42],
    ['strike', 0.18],
    ['bite', 0.16],
    ['hold', 0.12],
    ['recover', 0.7],
  ],
  sweep: [
    ['load', 0.38],
    ['sweep', 0.5],
    ['bite', 0.14],
    ['recover', 0.75],
  ],
  coil: [
    ['reach', 0.36],
    ['coil', 0.7],
    ['crush', 0.4],
    ['release', 0.8],
  ],
} as const satisfies Record<string, readonly (readonly [string, number])[]>;
export type MouthMoveName = keyof typeof MOUTH_MOVES;
export type MouthBeat =
  | 'watching'
  | 'load'
  | 'strike'
  | 'bite'
  | 'hold'
  | 'recover'
  | 'sweep'
  | 'reach'
  | 'coil'
  | 'crush'
  | 'release'
  | 'ko';

/** The prototype's fixed numbers (MOUTH_TUNING.md), named. */
export const MOUTH_CONST = {
  /** Corners rounded with a normal blend over this many px; the neck exits this far inward. */
  cornerBlend: 110,
  exitInset: 48,
  /** Slide: velocity eases toward its target at this rate (/s); ×0.55 at corners; ×0.2 during a strike or knockout. */
  slideEase: 2.2,
  cornerSlide: 0.55,
  strikeSlide: 0.2,
  /** Auto-aim arc around the edge normal (rad). */
  arc: 1.35,
  /** Max reach (px) before the reach slider and the height factor; idle reach min(230, 0.55 × distance). */
  maxReach: 520,
  idleReachMax: 230,
  idleReachK: 0.55,
  /** Head radius (lip ring), funnel length (× Rh), neck radius at the funnel. */
  Rh: 58,
  funnel: 1.9,
  neckR: 24,
  /** Head speed caps (px/s): rest, strike / sweep. */
  capRest: 520,
  capStrike: 1300,
  /** The head stays this far inside the arena. */
  headInset: 50,
  /** Neck samples. */
  neckSamples: 24,
  /** Health, ring hp, strand sever threshold, severed strands for the severed knockout. */
  hp: 100,
  ringHp: 5,
  severAt: 2.5,
  severKo: 3,
  /** KO timelines (s): drag convulse 0.9, slack to 2.2, dragged to 5.2; sever stump 1.6, coils withdraw from 2.5. */
  koConvulse: 0.9,
  koSlack: 2.2,
  koDragEnd: 5.2,
} as const;

/**
 * Game-side values (Gate 3A, D37). Units: px, s, energy.
 * - Arena B (§1): a Mouth match plays in a rim arena restY ± `arenaHalfH`, the stage's width kept.
 * - Hurtboxes (§2): head capsule from the lips back `headBack` px, r = Rh; neck r = braid radius + `neckPad`; coils r 40.
 * - Blows taken (§2): power = energy / `eRef` (a heavy blow ≈ power 2); head −4, neck −5 (×1.6 stretched), coil −2 per power.
 * - Coil & crush (§3): grab circle r 75; Surge escape in the first 0.35 s of the coil beat; wrap escape at 1.5 sever units.
 * - Corners (§4): the head keeps `keepOut` px (coil radius 40 + Rh 58) from the coil spine.
 * - Reach (§7): the bite's lip circle stays out of the far `safeStrip` px of a side-wall view.
 */
export const MOUTH_GAME = {
  arenaHalfH: 180,
  headBack: 40,
  neckPad: 3,
  coilR: 40,
  /**
   * to tune (§2 / §7): energy of a blow that counts as power 1. Gate 3A proposed ~600 (a heavy blow ≈ power 2); the first
   * AI-vs-AI pass across the roster (tools/mouth/duel.ts) lowered it to 360 so the roster's blows tell against the
   * jaw-rings. S11 (WJ: "the Mouth is too weak"; ROUND LENGTH Normal): 380.
   */
  eRef: 380,
  /**
   * to tune (Phase 4): multiplier on all health damage taken (1 = the oracle's numbers; the first AI pass: 1.2). S11: 0.9 at
   * the Normal pace (the jaw-rings also take × core.paceMul, so at Short — D34's pace — this is the old 1.2 again; the
   * bites are what got stronger there).
   */
  damageMul: 0.9,
  /**
   * power clamp per blow (the prototype's clicks are 1–2). S11: 3 → 2.5, so no single catastrophic blow (the Black Hole's
   * 6000-energy tide, the colossus's opening fracture) takes more than about half a jaw-ring.
   */
  powerMax: 2.5,
  /**
   * to tune (§2: "CONTINUOUS beams apply per tick with power × duration share"): a beam's per-tick energy, summed over its
   * life, is several heavy blows' worth on matter; on the jaw-rings it counts this share (a held gaze ≈ one heavy blow).
   */
  continuousMul: 0.3,
  /** to tune (§2, D30): debris impacts on the capsules count this share of their energy (they still bounce in full). */
  debrisMul: 0.4,
  /**
   * S11: for this many ticks after a blow it landed, debris that was not thrown does not wound it — the spray of its own bite
   * (against 우리, whose parts tear out whole round the head, it took more from its own bites than from the foe).
   */
  ownSprayTicks: 45,
  /**
   * Bite / sweep bite: a point CRUSH at the mouth centre, r = lip ring (VFX heavy). Energy: to tune (§7 D30 parity).
   * S11: 620 / 520 → 760 / 640 (the foe's matter takes it × its pace, like any blow).
   */
  biteR: 58,
  biteEnergy: 760,
  sweepEnergy: 640,
  /**
   * Coil: a light CRUSH ring every `coilEvery` ticks; crush: one heavy ring (energy to tune). Both go through Guard (a grab;
   * S11). S11: coil 50 → 90 (a grab the foe escapes still costs it), crush 700 → 950.
   */
  coilEnergy: 90,
  coilEvery: 12,
  crushEnergy: 950,
  /** Grab (§3). */
  grabR: 75,
  /** Held foe: root pulled to the coil centre at this rate (1/s; ≈ 2 Hz, inside the ≤ 4 Hz scale spec). */
  holdRate: 12,
  surgeEscape: 0.35,
  wrapEscape: 1.5,
  /** Visible wrap: foe core radius + this (strand radius at the tip ≈ 14.5 − 4.5) + clearance. */
  wrapPad: 26,
  /** Corners (§4). */
  keepOut: 98,
  /** Reach safe strip (§7, WJ: keep one): px of a side-wall view kept out of the bite's lip circle. */
  safeStrip: 120,
  /** Knockback taken by the head (px/s per px/s of the blow's knock) — the spring absorbs it. */
  headKick: 0.6,
  /** Input buffer for strikes pressed during a move (ticks). */
  buffer: 9,
} as const;
export type MouthGame = { -readonly [K in keyof typeof MOUTH_GAME]: number };
/** The live, tunable copy (debug overlay). */
export const MOUTH_LIVE: MouthGame = { ...MOUTH_GAME };

/** Presentation switches (debug overlay): the light rig (0 the oracle's own, 1 the one titan sky) and the readability marks. */
export const MOUTH_LOOK = { sky: 1, tell: true };

/**
 * The final boss (D35): more health and an enraged last ring. `hpMul` multiplies health (the HUD still reads 0–100 %);
 * in the last jaw-ring (health below 25 %) the crane is enraged: faster slide and strikes, shorter recovery, sharper tracking.
 * to tune with the tournament ladder.
 */
export const MOUTH_BOSS = {
  hpMul: 2,
  enrageBelow: 0.25,
  enrage: { slide: 1.3, strike: 1.25, recover: 0.75, track: 1.35, power: 1.2 },
};
