/**
 * Global constants shared by every module. These are LAW: changing one needs a DECISIONS.md entry.
 *
 * Coordinate system (everywhere, always): world units are LOGICAL PIXELS. +x is right, +y is DOWN
 * (canvas convention). Angles are radians, 0 = +x, increasing clockwise on screen (because +y is down).
 */

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
export const MAX_BODY_DIM = 224;
/** Titan max cell budget (bodies up to ~25k cells). */
export const MAX_BODY_CELLS = 30_000;

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

/** Hit-stop clamp in ticks (spec: 60–220 ms). */
export const HITSTOP_MIN_TICKS = msToTicks(60);
export const HITSTOP_MAX_TICKS = msToTicks(220);
/** Time dilation on KO blows (spec: 0.3x). */
export const KO_TIME_SCALE = 0.3;

/** Palette limits (spec: 40–64 colors per stage). */
export const STAGE_PALETTE_MIN = 40;
export const STAGE_PALETTE_MAX = 64;

/** Debris budget defaults (B2 may tune inside these caps). */
export const MAX_DEBRIS_CHUNKS = 400;
export const MAX_PARTICLES = 6000;

/** Number of cells per side of the coarse "region grid" used for targeting, AI and HUD (8x8). */
export const REGION_GRID = 8;

/** Sim performance budget (spec): ms per tick for two full bodies + debris on a mid-range laptop. */
export const SIM_BUDGET_MS_PER_TICK = 5;

/** KO thresholds (spec: KO when core-anchor integrity or total mass falls below thresholds). */
export const KO_CORE_INTEGRITY = 0.25;
export const KO_MASS_FRAC = 0.22;
