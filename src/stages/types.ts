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
  /**
   * Fighter readability (all optional; the renderer supplies tasteful defaults). Everything the 2D layers draw casts a soft dark,
   * slightly desaturated halo and a thin dark contact rim into the scenery beneath it, multiplied in before the palette dither.
   */
  spriteHalo?: {
    /** Peak darkening under the halo, 0..~0.5 (the halo is capped: a look, not a black hole). */
    strength: number;
    /** Blur radius of the halo in logical px. */
    radius: number;
    /** 0..1 desaturation under the halo. */
    desat: number;
    /** Darkening of the 1–2 px contact rim just outside a silhouette, 0..1. */
    rim: number;
    /** Rim width in px (1 or 2). */
    rimReach?: number;
    /** Linear-light floor the surround of a DARK body is lifted to (a faint backlight rim), so dark bodies never sink into dark space. */
    lift?: number;
  };
  /**
   * The vertical band where fighters live (offsets in WORLD px from the arena's restY): scenery highlights above `ceiling`
   * (linear light, after exposure) are compressed there so a bright cloud never sits right behind a body.
   */
  fightBand?: { top: number; bottom: number; feather: number; ceiling: number; keep: number };
  /** 0..1: how much bloom / god rays are damped ON a sprite's own pixels (they still glow around it). [bloom, rays] */
  glowDamp?: [number, number];
  /** Foreground dust and small rocks passing in front of the fighters (renderer pass): linear tint (default neutral dark), alpha multiplier and density. */
  foreground?: { color: [number, number, number]; alpha?: number; density?: number };
}

/**
 * What a build generator may yield: a progress fraction 0..1, nothing (a plain pause point), or a Promise the loader waits for
 * (e.g. `BakeJob.ready`, an off-thread shader compile).
 */
export type PrepareStep = number | void | Promise<unknown>;

export interface StageScenery {
  readonly id: StageId;
  readonly look: SceneryLook;
  /**
   * Build every GL resource in small steps: a generator that yields at each point where pausing is safe (after a particle
   * field, a bake pass, a layer…), reporting progress 0..1. The renderer drives it over several frames (`Renderer.prepareStage`)
   * so a stage load never freezes the game; `init` runs it to completion.
   */
  prepare(ctx: SceneryInit): Generator<PrepareStep, void, void>;
  /** `prepare` run to completion (blocking; sandboxes, tests, and the synchronous `setStage`). */
  init(ctx: SceneryInit): void;
  /** Compile shader programs ahead of the first frame without blocking (KHR_parallel_shader_compile where available). */
  compile(target: WebGLRenderTarget): Promise<void>;
  /** Change quality tier without rebuilding: thins particle clouds (brightness compensated) and trims shader detail. */
  setQuality(q: QualityTier): void;
  /** Advance and stage this frame (uniforms, ambient life). Must not allocate. */
  update(frame: SceneryFrame): void;
  /** Draw the whole backdrop into `target` (cleared by the scenery). */
  render(target: WebGLRenderTarget): void;
  /** Where the stage light currently sits on screen (logical px, may lie outside the frame). */
  lightScreenPos(out: { x: number; y: number }): void;
  dispose(): void;
}
