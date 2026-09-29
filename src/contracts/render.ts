import type { SimEvent } from './sim';

/* ------------------------------------------------------------------------------------------------ *
 *  STAGES
 * ------------------------------------------------------------------------------------------------ */

export const STAGE_IDS = ['nursery', 'rim', 'redgiant', 'quasar', 'tussenruimte'] as const;
export type StageId = (typeof STAGE_IDS)[number];

/** The playable volume in world coordinates. */
export interface ArenaInfo {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Altitude fighters settle toward when idle (a soft spring, not a floor). */
  restY: number;
  /** Width of the soft wall zone at the arena edges. */
  softWall: number;
}

/** Stage lighting: consumed by the titan generators (rim light, shading) and by the renderer. Vectors are unit length. */
export interface StageLighting {
  /** Direction FROM the surface TOWARD the light in view space (x right, y down, z toward camera). */
  dir: [number, number, number];
  /** Key light colour (hex), fill/ambient colour (hex) and rim colour (hex). */
  color: string;
  ambient: string;
  rim: string;
  /** Screen-space position of the stage light (0..1, 0..1) for god rays; may be outside the view. */
  screenPos: [number, number];
}

export interface StageInfo {
  id: StageId;
  index: number;
  name: string;
  nameKo: string;
  blurb: string;
  arena: ArenaInfo;
  lighting: StageLighting;
  /** Curated palette (40–64 hex colours, hue-shifted ramps) used by the scenery dither. */
  palette: string[];
}

/* ------------------------------------------------------------------------------------------------ *
 *  CAMERA
 * ------------------------------------------------------------------------------------------------ */

/** View window in world coords. x0/y0 are INTEGERS (pixel-snapped) so 2D layers scroll without shimmer. */
export interface ViewRect {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

export interface CameraState {
  /** World position of the view centre (float; the renderer snaps the view rect to integers). */
  x: number;
  y: number;
  /** 1 = native. Micro-zoom pulses on hits go up to ~1.06; applied in the final upscale (nearest). */
  zoom: number;
  /** Radians, |roll| ≤ 1.5°. */
  roll: number;
  /** Additional shake offset in px (already damped low-frequency). */
  shakeX: number;
  shakeY: number;
}

export interface CameraTarget {
  x: number;
  y: number;
  /** Half extents of the live body. */
  hw: number;
  hh: number;
}

export interface CameraTargets {
  a: CameraTarget;
  b: CameraTarget;
  arena: ArenaInfo;
  /** Optional director focus (ultimate choreography): world point and 0..1 weight, plus zoom bias. */
  focus?: { x: number; y: number; weight: number; zoom: number };
}

export interface CameraApi {
  reset(x: number, y: number): void;
  /** Advance one sim tick; consumes shake/zoom/hit events. Heavy, slow dolly (spec: "the universe moves"). */
  tick(targets: CameraTargets, events: readonly SimEvent[]): void;
  /** Interpolated camera for render alpha ∈ [0,1). */
  sample(alpha: number): { state: CameraState; view: ViewRect };
}

/* ------------------------------------------------------------------------------------------------ *
 *  RENDER LAYERS — the ONLY way pixels travel from simulation modules to the renderer.
 * ------------------------------------------------------------------------------------------------ */

export interface RenderLayer {
  id: string;
  /**
   * 'world': `pixels` is a w×h sprite placed at world (x,y) with anchor/facing/lean (see space.ts) — the renderer draws
   *          it at integer positions with nearest filtering (interpolating x,y between prevX/prevY).
   * 'screen': `pixels` is exactly LOGICAL_W×LOGICAL_H, already aligned to the integer view origin it was rasterised for.
   */
  space: 'world' | 'screen';
  /** Draw order, low first. Reserved: -100 scenery, -20 back debris, 0 titans, 10 front debris/particles, 20 fx, 100 UI. */
  z: number;
  w: number;
  h: number;
  /** Packed RGBA (see color.ts), alpha 0 = transparent. */
  pixels: Uint32Array;
  /** Optional emissive intensity 0..255 per pixel (same dims): feeds bloom. */
  emissive?: Uint8Array;
  /** World-space placement (space === 'world'). */
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  anchorX: number;
  anchorY: number;
  facing: 1 | -1;
  lean: number;
  /** Changed-cell rect since last upload (map-local / layer-local); null = whole layer if version changed. */
  dirty: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Bumped when pixels change; the renderer re-uploads when it differs from its cached version. */
  version: number;
  alpha: number;
  blend: 'normal' | 'add';
  visible: boolean;
}

/** Convenience constructor for a hidden/empty layer object (callers keep and mutate it — no per-frame allocation). */
export function makeLayer(
  id: string,
  space: 'world' | 'screen',
  z: number,
  w: number,
  h: number,
): RenderLayer {
  return {
    id,
    space,
    z,
    w,
    h,
    pixels: new Uint32Array(w * h),
    x: 0,
    y: 0,
    prevX: 0,
    prevY: 0,
    anchorX: 0,
    anchorY: 0,
    facing: 1,
    lean: 0,
    dirty: null,
    version: 0,
    alpha: 1,
    blend: 'normal',
    visible: true,
  };
}

/* ------------------------------------------------------------------------------------------------ *
 *  FRAME FX (per-frame non-pixel inputs to the renderer / stage)
 * ------------------------------------------------------------------------------------------------ */

export interface ShockwaveFx {
  x: number;
  y: number;
  /** 0 = just spawned … 1 = dissipated. */
  age: number;
  /** Current radius in px and peak refraction strength 0..1. */
  radius: number;
  strength: number;
}

export interface LensFx {
  x: number;
  y: number;
  /** Event-horizon radius in px (the lensing scales with it); 0 disables. */
  horizonR: number;
  /** 0..1.5 lensing strength (grows with accreted mass). */
  strength: number;
}

/** A disturbance the scenery reacts to: nebulae swirl, dust sheets ripple, starlight bends. */
export interface StageImpulseFx {
  x: number;
  y: number;
  strength: number;
  radius: number;
  age: number;
  /** Hue hint 0..1 for tinted dust glow (e.g. fire = orange), or -1 for none. */
  hue: number;
}

export interface FrameFx {
  shockwaves: ShockwaveFx[];
  lenses: LensFx[];
  impulses: StageImpulseFx[];
  /** 0..1 white flash (KO blow, ultimate). */
  flash: number;
  /** 0..1 extra chromatic aberration. */
  aberration: number;
  /** 0..1 how hot the fight is: drives nebula swirl speed and stage brightness. */
  intensity: number;
  /** Current sim time scale (KO dilation) so the scenery slows with the universe. */
  timeScale: number;
}

export interface RenderFrame {
  tick: number;
  timeSec: number;
  alpha: number;
  camera: CameraState;
  view: ViewRect;
  stage: StageId;
  layers: RenderLayer[];
  /** Full-screen UI/HUD layer composited last at logical resolution (crisp, never bloomed). */
  ui: RenderLayer | null;
  fx: FrameFx;
}

export interface RenderStats {
  /** Rolling average CPU ms per draw() call and per stage of the pipeline (ms). */
  frameMs: number;
  sceneryMs: number;
  postMs: number;
  drawCalls: number;
}

export interface RendererOptions {
  /** Force pixel-art scale (integer) — default: largest integer that fits, letterboxed. */
  integerScale?: boolean;
  /** Preserve drawing buffer so screenshots work (harness). */
  preserveDrawingBuffer?: boolean;
  /** Quality tier for the 3D scenery and post (0 low … 2 high). */
  quality?: 0 | 1 | 2;
}

export interface Renderer {
  init(canvas: HTMLCanvasElement, opts?: RendererOptions): Promise<void>;
  setStage(id: StageId): void;
  draw(frame: RenderFrame): void;
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  readonly stats: RenderStats;
  /** Read back the final LOGICAL_W×LOGICAL_H frame as packed RGBA (top row first) — for tests/screenshots. */
  captureLogical(): Uint32Array;
  dispose(): void;
}
