import type { WebGLRenderer, WebGLRenderTarget } from 'three';
import type { CameraState, FrameFx, StageId, StageInfo, ViewRect } from '@/contracts';

/**
 * A stage's living 3D backdrop. The renderer owns the GL context and the render targets; a scenery only draws into the
 * HDR target it is handed. The renderer then lenses it, tone-maps it and dithers it into the stage palette.
 *
 * Output convention for `render`: LINEAR-light HDR colour in rgb (values above 1 are fine and feed bloom), and in
 * alpha the OCCLUDER opacity (dust, dark matter) that should cut god rays. Additive layers must not write alpha.
 */

export type QualityTier = 0 | 1 | 2;

/** Everything a scenery needs to build its GL resources. */
export interface SceneryInit {
  renderer: WebGLRenderer;
  info: StageInfo;
  quality: QualityTier;
  /** Size of the HDR target the scenery draws into, in pixels (logical size × supersample). */
  width: number;
  height: number;
}

/** Screen-space (logical px) packed disturbances, precomputed by the renderer from `FrameFx` for the shaders. */
export interface SceneryForces {
  /** Shockwaves: x, y, radius px, displacement px. Up to MAX_SHOCKS. */
  shock: Float32Array;
  nShock: number;
  /** Impulses (swirl): x, y, radius px, strength (already decayed by age). */
  impulse: Float32Array;
  /** Impulse extras: age 0..1, hue 0..1 (or -1), unused, unused. */
  impulse2: Float32Array;
  nImpulse: number;
}

export const MAX_SHOCKS = 8;
export const MAX_IMPULSES = 6;

export interface SceneryFrame {
  /** Scenery clock in seconds: advances with `fx.timeScale`, so the universe slows with a KO. */
  timeSec: number;
  /** Real seconds since the previous update multiplied by `fx.timeScale`. */
  dtSec: number;
  /** Integer view origin: the same one the 2D layers use. Parallax offsets derive from it. */
  view: ViewRect;
  camera: CameraState;
  fx: FrameFx;
  forces: SceneryForces;
}

/** How the renderer should grade this stage (all optional overrides live here so stages stay data-driven). */
export interface SceneryLook {
  /** Multiplier on HDR before tone mapping. */
  exposure: number;
  /** Contrast about mid-grey after tone mapping (1 = none). */
  contrast: number;
  /** HDR luminance where scenery starts to glow, and how strongly. */
  bloomThreshold: number;
  bloomGain: number;
  /** God ray gain, how much bright open gas contributes as a light source, halo radius (px), decay per step. */
  godRayGain: number;
  godRayGas: number;
  godRayHalo: number;
  godRayDecay: number;
  vignette: number;
}

export interface StageScenery {
  readonly id: StageId;
  readonly look: SceneryLook;
  init(ctx: SceneryInit): void;
  /** Advance and stage this frame (uniforms, ambient life). Must not allocate. */
  update(frame: SceneryFrame): void;
  /** Draw the whole backdrop into `target` (cleared by the scenery). */
  render(target: WebGLRenderTarget): void;
  /** Where the stage light currently sits on screen (logical px, may lie outside the frame). */
  lightScreenPos(out: { x: number; y: number }): void;
  /** The GL context was restored: re-upload any CPU-side textures. */
  restore?(): void;
  dispose(): void;
}
