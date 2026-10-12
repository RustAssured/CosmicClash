/**
 * Global constants shared by every module. These are LAW: changing one needs a DECISIONS.md entry.
 *
 * Coordinate system (everywhere, always): world units are LOGICAL PIXELS. +x is right, +y is DOWN
 * (canvas convention). Angles are radians, 0 = +x, increasing clockwise on screen (because +y is down).
 */
import { ROSTER_IDS } from './roster';

/** Logical resolution. All game art is drawn at this size, then integer-upscaled. */
export const LOGICAL_W = 640;
export const LOGICAL_H = 360;

/** Fixed simulation tick. The simulation is a pure function of (state, inputs) per tick. */
export const TICK_HZ = 60;
export const TICK_DT = 1 / TICK_HZ;
export const MS_PER_TICK = 1000 / TICK_HZ;

/** Convert seconds/milliseconds to ticks (rounded). Data files store frame data in TICKS. */
export const secToTicks = (s: number): number => Math.round(s * TICK_HZ);
export const msToTicks = (ms: number): number => Math.round((ms * TICK_HZ) / 1000);
export const ticksToMs = (t: number): number => (t * 1000) / TICK_HZ;

/** Input buffer: how many ticks an early button press stays valid (spec: 8–10 frames). */
export const INPUT_BUFFER_TICKS = 9;
/** Windups may be cancelled into Guard/Surge during this fraction of their startup (spec: first 40%). */
export const CANCEL_WINDOW_FRACTION = 0.4;

/** Titan matter maps never exceed this many cells per side (bodies are 90–180 px across). */
export const MAX_BODY_DIM = 300;
/** Titan max cell budget (bodies up to ~25k cells). */
export const MAX_BODY_CELLS = 70_000;

/** Default arena (a stage may override through StageInfo.arena). World origin = top-left of arena. */
export const ARENA_W = 1600;
export const ARENA_H = 560;
/** Two fighters are tethered so both always fit on screen: max horizontal / vertical anchor distance. */
export const MAX_FIGHTER_DX = 430;
export const MAX_FIGHTER_DY = 190;

/** Round rules. */
export const ROUNDS_TO_WIN = 2; // best of 3
export const ROUND_TIME_TICKS = 90 * TICK_HZ;
export const ROUND_INTRO_TICKS = 2 * TICK_HZ;
export const ROUND_OUTRO_TICKS = 3 * TICK_HZ;

/** The Options row ROUND LENGTH (S11): it picks the match config's pace (`MatchConfig.pace`). */
export type RoundLength = 'short' | 'normal' | 'long';
/**
 * Pace per round length: every blow taken does this much more to the MATTER (D34's global pace; knock-back, stun, meter and
 * guard keep their weight). Short is D34's 2.1; WJ (S11): "the rounds perhaps are too quickly over". AI vs AI at the top
 * level over seven pairings (tools/lead/roundlen.ts), median round: Short 43 s, Normal 65 s (× 1.5), Long 93 s (× 2.2).
 * Matter does not follow the pace in proportion (a crater saturates; the colossus sheds whole limbs), hence the uneven steps.
 */
export const ROUND_LENGTH_PACE: Readonly<Record<RoundLength, number>> = {
  short: 2.1,
  normal: 1.3,
  long: 0.65,
};
/**
 * The titans whose health is not matter (우리's loop, the Mouth's jaw-rings) take blows × (pace ratio) ^ this: matter does not
 * follow the pace in proportion (a blow's crater saturates), and 0.7 keeps their rounds stretching like everyone else's.
 */
export const ANALYTIC_PACE_EXP = 0.7;
/** The round clock per round length (s): longer rounds need a longer clock, or the long pairings end on time. */
export const ROUND_LENGTH_SECONDS: Readonly<Record<RoundLength, number>> = {
  short: 90,
  normal: 120,
  long: 180,
};

/**
 * Hit-stop clamp in ticks: 60–135 ms (4–8 ticks). D27 rebudget: hit-stop is a beat, not the carrier of weight (that is the
 * blow's momentum and torque), so the heavy cap dropped from 220 ms (13 ticks) to 8 ticks. D31-5 / VFX_SPEC item 6: the beat
 * now comes from the blow's weight (`BLOW_HITSTOP_TICKS`); 135 ms stays the cap for light to heavy, and only a catastrophic
 * blow may go past it, up to HITSTOP_CATASTROPHIC_MAX_TICKS. A light blow's 40 ms is the floor.
 */
export const HITSTOP_MIN_TICKS = msToTicks(40);
export const HITSTOP_MAX_TICKS = msToTicks(135);
export const HITSTOP_CATASTROPHIC_MAX_TICKS = msToTicks(250);

/**
 * Blow weight (shared/VFX_SPEC.md): one scale for hit-stop, camera shake and the shared impact VFX (S5), so every titan's
 * blows read on the same ladder. Proposal 171.
 */
export type BlowWeight = 'light' | 'medium' | 'heavy' | 'catastrophic';
export const BLOW_WEIGHTS: readonly BlowWeight[] = ['light', 'medium', 'heavy', 'catastrophic'];
/** VFX_SPEC item 6: 0.04 / 0.08 / 0.11 / 0.20–0.25 s → 2 / 5 / 7 / 14 ticks. */
export const BLOW_HITSTOP_TICKS: Readonly<Record<BlowWeight, number>> = {
  light: msToTicks(40),
  medium: msToTicks(80),
  heavy: msToTicks(110),
  catastrophic: msToTicks(230),
};
/** VFX_SPEC item 6: camera shake amplitude (px) by weight (low frequency and damped: the camera's own rule). */
export const BLOW_SHAKE_PX: Readonly<Record<BlowWeight, number>> = {
  light: 3,
  medium: 6,
  heavy: 10,
  catastrophic: 14,
};
/** Time dilation on KO blows (spec: 0.3x). */
export const KO_TIME_SCALE = 0.3;

/** Palette limits (spec: 40–64 colors per stage). */
export const STAGE_PALETTE_MIN = 40;
export const STAGE_PALETTE_MAX = 64;

/** Debris budget defaults (B2 may tune inside these caps). */
/** Raised 400 → 640 in slice Phase 2 (debris is combat history; measured: no p99 cost on WJ's machine, proposal 142). */
export const MAX_DEBRIS_CHUNKS = 640;
export const MAX_PARTICLES = 6000;

/** Number of cells per side of the coarse "region grid" used for targeting, AI and HUD (8x8). */
export const REGION_GRID = 8;

/** Sim performance budget (spec): ms per tick for two full bodies + debris on a mid-range laptop. */
export const SIM_BUDGET_MS_PER_TICK = 5;

/**
 * The roster and arenas the menus, attract mode and random pairings use (`?full=1` shows every implemented one). D34: all six
 * original titans are back, with 우리. D36: the colossus ('colossus', The Last One) and the returning tendril titan ('lastone',
 * The Witness) are two titans.
 */
export const SLICE = {
  // the roster (src/contracts/roster.ts)
  titans: ROSTER_IDS,
  // D34: every original stage is back, beside the slice's two arenas
  stages: ['nursery', 'rim', 'redgiant', 'quasar', 'tussenruimte', 'mausoleum', 'shearfield'] as const,
} as const;

/** KO thresholds (spec: KO when core-anchor integrity or total mass falls below thresholds). */
export const KO_CORE_INTEGRITY = 0.25;
export const KO_MASS_FRAC = 0.22;
