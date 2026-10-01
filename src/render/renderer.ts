import {
  AddEquation,
  ClampToEdgeWrapping,
  CustomBlending,
  Data3DTexture,
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearSRGBColorSpace,
  NearestFilter,
  NoToneMapping,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RedFormat,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
  type IUniform,
  type TextureDataType,
  type WebGLRenderTarget,
} from 'three';
import {
  LOGICAL_H,
  LOGICAL_W,
  hex,
  pb,
  pg,
  pr,
  type FrameFx,
  type RenderFrame,
  type RenderStats,
  type Renderer,
  type RendererOptions,
  type StageId,
} from '@/contracts';
import { STAGES } from '@/stages';
import { createScenery } from '@/stages/scenery';
import {
  MAX_IMPULSES,
  MAX_SHOCKS,
  type PrepareStep,
  type SceneryForces,
  type SceneryFrame,
  type SceneryLook,
  type StageScenery,
} from '@/stages/types';
import { LayerCompositor } from './compositor';
import { Foreground } from './foreground';
import { bayerTexels } from './dither';
import { FullscreenPass, dataTexture, disposeSharedGeometry, makeRT, resetSharedGeometry } from './gl';
import { LayerTextures } from './layerTextures';
import { GpuTimer } from './gpuTimer';
import { LutBuilder, PALETTE_TEX_W, paletteTextures, preparePalette, type DitherLut } from './palette';
import { QualityController, type Tier as QualityTier } from './quality';
import { animationFrame, runSliced, runToEnd, scaled } from './slicer';
import {
  BLOOM_DOWN_FRAG,
  BLOOM_UP_FRAG,
  FINAL_FRAG,
  GODRAYS_FRAG,
  GOVERN_FRAG,
  HALO_BLUR_FRAG,
  LAYER_COMPOSITE_FRAG,
  LUM_DOWN_FRAG,
  POST_FRAG,
  SCENERY_DITHER_FRAG,
} from './shaders';
import { LumaReadback, type LumaSample } from './lumaReadback';
import { computeViewport, type ViewportLayout } from './viewport';

/** Per-tier tuning: scenery supersampling, bloom pyramid depth, god-ray taps. (Scenery particle density is the kit's job.) */
interface Tier {
  supersample: 1 | 2;
  bloomLevels: number;
  godSamples: number;
}
const TIERS: Record<QualityTier, Tier> = {
  0: { supersample: 1, bloomLevels: 3, godSamples: 16 },
  1: { supersample: 1, bloomLevels: 4, godSamples: 28 },
  2: { supersample: 2, bloomLevels: 5, godSamples: 44 },
};
/** One palette LUT resolution for every tier, so a tier change never rebuilds it. */
const LUT_SIZE = 40;

/** What the scenery pass looks like when there is no scenery yet (first stage still loading): black, calm, no rays. */
const FALLBACK_LOOK: SceneryLook = {
  exposure: 1,
  contrast: 1,
  bloomThreshold: 1,
  bloomGain: 0,
  godRayGain: 0,
  godRayGas: 0,
  godRayHalo: 100,
  godRayDecay: 0.96,
  vignette: 0.5,
};

/** `'auto'` (default): start at tier 1 and let the QualityController move between tiers 0 and 1 from measured frame pacing. */
export type QualitySetting = QualityTier | 'auto';

export interface RenderInitOptions extends Omit<RendererOptions, 'quality'> {
  /** 0 | 1 | 2 fixes the tier; 'auto' (default) adapts. */
  quality?: QualitySetting;
  /** Milliseconds of work per frame while a stage is being prepared in the background (default 5). */
  prepareBudgetMs?: number;
  /**
   * The Gate B sprite-push A/B (D27): when true, `CameraState.zoom` > 1 (up to SPRITE_PUSH_MAX) resamples the finished frame
   * with sharp-bilinear filtering. When false (default) sprites always stay 1:1 and camera zoom pulses become scenery dolly.
   * Default: the page URL's `push=1`.
   */
  spritePush?: boolean;
}

/**
 * A full dolly (CameraState.dolly = 1) moves the scenery camera this fraction of the way to the fight plane (a dolly-zoom: the
 * fight plane and the 1:1 sprites stay put, the far sky recedes by up to this much, the foreground rushes outward).
 */
export const DOLLY_MAX = 0.1;
/** Without the sprite push, a camera zoom pulse of +6 % becomes this much extra dolly (zoom − 1) × DOLLY_FROM_ZOOM. */
export const DOLLY_FROM_ZOOM = 10;
/** Largest impact parallax kick passed to the scenery (px at depth 1). */
export const KICK_MAX = 24;
/** Largest sprite-push zoom (push=1 only). */
export const SPRITE_PUSH_MAX = 1.1;
/** Luminance governor: largest rise of the frame's mean relative luminance above its 300 ms average (D5 target ≤ 0.20). */
export const GOVERNOR_LIMIT = 0.12;
export const GOVERNOR_TAU = 0.3;

/**
 * Mean relative luminance of the displayed game frame (no UI), read back asynchronously (no stall): `mean` after the
 * governor, `raw` before it, the `gain` it applied, its 300 ms average `avg`, and the frame / sim tick measured.
 */
export type LumaStats = LumaSample;
/** Samples kept for `drainLuma()` when nobody drains them (≈ 10 s at 60 fps). */
const LUMA_KEEP = 600;

/** RenderStats plus what the adaptive controller and the stage loader know. */
export interface RenderStatsEx extends RenderStats {
  /** Current quality tier (0 low … 2 showpiece). */
  tier: QualityTier;
  /** True when the tier is chosen by the adaptive controller. */
  auto: boolean;
  /** Newest measured GPU ms per frame (EXT_disjoint_timer_query_webgl2), or null when unavailable. */
  gpuMs: number | null;
  /** Late-frame rate (> 20 ms) of the controller's last evaluation window, 0..1. */
  lateRate: number;
  /** Number of automatic tier changes so far. */
  tierChanges: number;
  /** The last stage preparation: wall ms, CPU ms spent in our slices, frames it was spread over, longest single slice. */
  prepare: { stage: StageId; wallMs: number; cpuMs: number; frames: number; maxSliceMs: number } | null;
  /**
   * Newest luminance-governor reading (1–3 frames old: read back asynchronously through a PBO + fence, never stalling the
   * frame). Null until the first read completes or where float read-back is unavailable. Every frame's sample is also kept
   * for `drainLuma()`.
   */
  luma: LumaStats | null;
}

/** Readability defaults; a stage overrides any of them through SceneryLook. */
export const DEFAULT_SPRITE_HALO = {
  strength: 0.3,
  radius: 9,
  desat: 0.35,
  rim: 0.5,
  rimReach: 1,
  lift: 0.14,
} as const;
export const DEFAULT_FIGHT_BAND = { top: -130, bottom: 110, feather: 50, ceiling: 0.5, keep: 0.3 } as const;
export const DEFAULT_GLOW_DAMP: readonly [number, number] = [0.6, 0.9];

const ROLL_LIMIT = (1.5 * Math.PI) / 180;
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

class RollingAverage {
  value = 0;
  private n = 0;
  push(v: number): void {
    this.value = this.n === 0 ? v : this.value + (v - this.value) * 0.08;
    this.n++;
  }
}

/**
 * The renderer contract plus what the app needs beyond it: non-blocking stage preparation, adaptive quality and its stats, and
 * a few debug hooks used by the GPU verification page (dev/render/verify.ts).
 */
export interface DebuggableRenderer extends Renderer {
  init(canvas: HTMLCanvasElement, opts?: RenderInitOptions): Promise<void>;
  readonly stats: RenderStatsEx;
  /**
   * Build a stage's scenery, palette LUT and shaders in the background, spread over frames (≈ 5 ms per frame) so the game keeps
   * running and the UI can show a progress bar. Resolves when the stage is ready to be shown; the first draw() whose
   * `frame.stage` matches (or `setStage`) then switches to it instantly. Until then draw() keeps showing the previous stage (or
   * black if there is none) — never garbage, never a freeze. Calling it for a stage that is ready or already preparing is free.
   */
  prepareStage(id: StageId, onProgress?: (fraction: number) => void): Promise<void>;
  /** True when `setStage(id)` / a matching draw would switch instantly (the stage is active or prepared). */
  isStageReady(id: StageId): boolean;
  /** Read the composited (pre-post) colour or emissive attachment as packed RGBA, top row first. */
  debugReadFrame(attachment: 0 | 1): Uint32Array;
  /** Number of layer textures currently cached, and upload counters. */
  debugLayerStats(): { cached: number; create: number; full: number; rect: number; texels: number };
  /** Free layer textures not drawn for `frames` frames (default 240). */
  debugSetStaleFrames(frames: number): void;
  /** Simulate a context loss / restore through WEBGL_lose_context. */
  debugLoseContext(lose: boolean): void;
  /** The current canvas layout (physical px). */
  debugLayout(): { scale: number; x: number; y: number; w: number; h: number };
  /** Force a tier now (also what the adaptive controller does). Ignored when out of range. */
  debugSetTier(tier: QualityTier): void;
  /** Switch the foreground dust pass on or off (verification). */
  debugSetForeground(on: boolean): void;
  /** The stage whose scenery is currently drawn (null while none is ready). */
  debugActiveStage(): StageId | null;
  /**
   * Comfort scale 0..1 of the flash-like effects the renderer owns (tinted impulse glow, bloom gain). The FxState applies the
   * same setting to impact lights and refraction. 1 (default) = full; the D5 limits hold at 1.
   */
  setComfort(flash: number): void;
  /**
   * Every luminance-governor sample read back since the last call (oldest first; ≤ 1 per drawn frame, possibly a few frames
   * late). Cheap: a 1×1 float read per frame through a ring of pixel-pack buffers. For telemetry's flash metrics.
   */
  drainLuma(): LumaStats[];
  /** Turn the luminance governor's gain off (measure only) or on (default), for A/B verification. */
  debugSetGovernor(on: boolean): void;
  /** Read-back health (and, with `diag`, record GL errors around its calls): verification only. */
  debugLumaReadback(diag: boolean): { available: boolean; skipped: number; errors: string[]; pollMs: number };
  /** Switch the sharp-bilinear sprite push (push=1) at run time. */
  debugSetSpritePush(on: boolean): void;
}

export function createRenderer(): DebuggableRenderer {
  return new PixelRenderer();
}

interface PaletteResources {
  lut: Data3DTexture;
  size: number;
  srgb: DataTexture;
  lin: DataTexture;
  godColor: [number, number, number];
}

interface PreparedStage {
  id: StageId;
  scenery: StageScenery;
  palette: PaletteResources;
}

interface PrepareJob {
  id: StageId;
  listeners: ((fraction: number) => void)[];
  progress: number;
  cancelled: boolean;
  promise: Promise<void>;
}

/** Wrap a generator so the CPU time spent inside its steps is reported (the stat for "how long did preparing really take"). */
function* timedSteps(
  gen: Generator<PrepareStep, void, void>,
  addMs: (ms: number) => void,
): Generator<PrepareStep, void, void> {
  for (;;) {
    const a = now();
    const r = gen.next();
    addMs(now() - a);
    if (r.done) return;
    yield r.value;
  }
}

class PixelRenderer implements DebuggableRenderer {
  readonly stats: RenderStatsEx = {
    frameMs: 0,
    sceneryMs: 0,
    postMs: 0,
    drawCalls: 0,
    tier: 1,
    auto: false,
    gpuMs: null,
    lateRate: 0,
    tierChanges: 0,
    prepare: null,
    luma: null,
  };

  private three!: WebGLRenderer;
  private canvas!: HTMLCanvasElement;
  private opts: RenderInitOptions = {};
  tier: Tier = TIERS[1]; // read by tools/render/perf.mjs
  private tierNow: QualityTier = 1;
  private controller: QualityController | null = null;
  private gpuTimer: GpuTimer | null = null;
  private lastDrawAt = 0;
  private ready = false;
  private lost = false;
  private layout: ViewportLayout = computeViewport(LOGICAL_W, LOGICAL_H);
  private cssW = LOGICAL_W;
  private cssH = LOGICAL_H;
  private dpr = 1;

  // targets
  private sceneRT!: WebGLRenderTarget;
  private frameRT!: WebGLRenderTarget;
  private layerRT!: WebGLRenderTarget;
  private haloA!: WebGLRenderTarget;
  private haloB!: WebGLRenderTarget;
  private bloomRTs: WebGLRenderTarget[] = [];
  private godRT!: WebGLRenderTarget;
  private postRT!: WebGLRenderTarget;
  private captureRT: WebGLRenderTarget | null = null;
  private hdrType: TextureDataType = HalfFloatType;
  /** Luminance governor: 40×23 block sums and a 1×1 ping-pong state. */
  private lumRT!: WebGLRenderTarget;
  private govRT: WebGLRenderTarget[] = [];
  private govIdx = 0;
  private govType: TextureDataType = HalfFloatType;
  private govReset = true;
  private govOn = true;
  private lumaRead: LumaReadback | null = null;
  private comfort = 1;
  private spritePush = false;

  // passes
  private ditherPass!: FullscreenPass;
  private haloBlur!: FullscreenPass;
  private layerComposite!: FullscreenPass;
  private bloomDown!: FullscreenPass;
  private bloomUp!: FullscreenPass;
  private godPass!: FullscreenPass;
  private postPass!: FullscreenPass;
  private lumPass!: FullscreenPass;
  private govPass!: FullscreenPass;
  private finalPass!: FullscreenPass;
  private layers!: LayerTextures;
  private compositor!: LayerCompositor;

  // shared uniform objects
  private readonly res = new Vector2(LOGICAL_W, LOGICAL_H);
  private readonly emisGain = { value: 1.5 };
  private bayerTex!: DataTexture;

  // stages: the one being drawn, at most one finished-but-not-yet-shown, and the background job(s)
  private wantedStage: StageId = 'nursery';
  private stageRequested = false;
  private active: PreparedStage | null = null;
  private prepared: PreparedStage | null = null;
  private jobs = new Map<StageId, PrepareJob>();
  private jobQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  private godColor = new Vector3(1, 0.7, 0.4);

  // per-frame scratch (no allocation in draw)
  private readonly forces: SceneryForces = {
    shock: new Float32Array(MAX_SHOCKS * 4),
    nShock: 0,
    impulse: new Float32Array(MAX_IMPULSES * 4),
    impulse2: new Float32Array(MAX_IMPULSES * 4),
    nImpulse: 0,
  };
  private readonly postShock = new Float32Array(MAX_SHOCKS * 4);
  /**
   * Dynamic lights (screen px): x, y, radius, intensity per light, their colours, and whether each is an impact light. Body
   * lights are packed first. Shared by the grade, post and foreground passes.
   */
  private readonly lightData: IUniform<Float32Array> = { value: new Float32Array(16) };
  private readonly lightCol: IUniform<Float32Array> = { value: new Float32Array(12) };
  private readonly lightImp: IUniform<Float32Array> = { value: new Float32Array(4) };
  private readonly nLights: IUniform<number> = { value: 0 };
  /** Local wound refraction around the strongest impact lights: x, y, radius, strength (≤ 2). */
  private readonly refr = new Float32Array(8);
  private nRefr = 0;
  private foreground: Foreground | null = null;
  private fgEnabled = true;
  private readonly fgShared = {
    view: { value: new Vector2() },
    time: { value: 0 },
    flow: { value: 0 },
    intensity: { value: 0 },
    shock: { value: this.forces.shock },
    nShock: { value: 0 },
    imp: { value: this.forces.impulse },
    imp2: { value: this.forces.impulse2 },
    nImp: { value: 0 },
    lights: this.lightData,
    nLights: this.nLights,
    dolly: { value: 0 },
    kick: { value: new Vector2() },
  };
  /** Reused every frame (no per-frame allocation). */
  private readonly sceneryFrame: SceneryFrame = {
    timeSec: 0,
    dtSec: 0,
    view: { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H },
    camera: { x: 0, y: 0, zoom: 1, roll: 0, shakeX: 0, shakeY: 0, dolly: 0, kickX: 0, kickY: 0 },
    cam: { dolly: 0, kickX: 0, kickY: 0 },
    comfort: 1,
    fx: { shockwaves: [], lenses: [], impulses: [], flash: 0, aberration: 0, intensity: 0, timeScale: 1 },
    forces: this.forces,
  };
  private readonly lens = new Float32Array(16);
  private readonly lightPos = { x: 0, y: 0 };
  private lastTimeSec = -1;
  private sceneTime = 0;
  private frameNo = 0;
  private drawnOnce = false;
  private readonly avgFrame = new RollingAverage();
  private readonly avgScenery = new RollingAverage();
  private readonly avgPost = new RollingAverage();
  private onLost = (e: Event): void => {
    e.preventDefault();
    if (!this.lost) console.error('renderer: WebGL context lost; waiting for restore');
    this.lost = true;
  };
  /** A hidden tab is not a slow renderer: tell the adaptive controller to forget the frames around it. */
  private onVisibility = (): void => {
    this.controller?.disrupt(now());
    this.lastDrawAt = 0;
  };

  private onRestored = (): void => {
    // Every GL object we created died with the old context, and calling dispose() on them now only makes the browser
    // print "object does not belong to this context". So drop them (never dispose) and rebuild from scratch. The scenery is
    // rebuilt in the background (draw() shows black meanwhile); callers may `await prepareStage(id)` to know when it is back.
    this.lost = false;
    resetSharedGeometry();
    this.layers = new LayerTextures(this.three);
    this.compositor = new LayerCompositor(this.layers, this.emisGain);
    this.captureRT = null;
    // the timer-query extension object belongs to the dead context: ask the new one
    this.gpuTimer = GpuTimer.create(this.three.getContext() as WebGL2RenderingContext);
    this.stats.gpuMs = null;
    // the pixel-pack buffers and fences died with the old context too (dropped, never deleted)
    this.lumaRead = null;
    this.lumaRead = this.makeLumaReadback();
    this.govReset = true;
    this.active = null;
    this.prepared = null;
    this.jobs.clear();
    this.jobQueue = Promise.resolve();
    this.buildTargets();
    this.buildPasses();
    this.resize(this.cssW, this.cssH, this.dpr);
    this.controller?.disrupt(now());
    void this.prepareStage(this.wantedStage).catch(() => undefined);
  };

  async init(canvas: HTMLCanvasElement, opts: RenderInitOptions = {}): Promise<void> {
    if (this.ready) throw new Error('renderer already initialised');
    this.canvas = canvas;
    this.opts = opts;
    const q = opts.quality ?? 'auto';
    this.spritePush =
      opts.spritePush ??
      (typeof location !== 'undefined' && new URLSearchParams(location.search).get('push') === '1');
    this.stats.auto = q === 'auto';
    this.tierNow = q === 'auto' ? 1 : q;
    this.tier = TIERS[this.tierNow];
    this.stats.tier = this.tierNow;
    // tier 2 (2× supersampled scenery) stays opt-in (SLICE_PLAN §0: an integrated GPU must not probe its way into it)
    this.controller = q === 'auto' ? new QualityController({ startTier: 1, maxTier: 1 }) : null;
    this.three = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    });
    const r = this.three;
    if (!r.capabilities.isWebGL2) throw new Error('WebGL2 is required');
    r.autoClear = false;
    r.outputColorSpace = LinearSRGBColorSpace;
    r.toneMapping = NoToneMapping;
    r.setPixelRatio(1);
    r.info.autoReset = false;
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);

    // HDR scenery needs a renderable float target; fall back to 8-bit (less headroom, still correct).
    const canFloat =
      r.extensions.has('EXT_color_buffer_float') || r.extensions.has('EXT_color_buffer_half_float');
    this.hdrType = canFloat ? HalfFloatType : UnsignedByteType;
    // the governor's running average wants full float (an EMA in half float stalls on tiny steps); half float otherwise
    this.govType = r.extensions.has('EXT_color_buffer_float') ? FloatType : this.hdrType;
    r.extensions.get('EXT_color_buffer_float');
    r.extensions.get('EXT_color_buffer_half_float');
    r.extensions.get('OES_texture_float_linear');
    this.gpuTimer = GpuTimer.create(r.getContext() as WebGL2RenderingContext);
    this.lumaRead = this.makeLumaReadback();

    this.layers = new LayerTextures(r);
    this.compositor = new LayerCompositor(this.layers, this.emisGain);
    this.buildTargets();
    this.buildPasses();
    this.ready = true;
    this.resize(this.cssW, this.cssH, this.dpr);
    // Our own programs compile now (in parallel where the browser can), so the first frame does not pay for them.
    await this.compileOwnPasses();
    // Scenery (shader compile, palette LUT, pillar bakes ≈ seconds) is built by the first setStage()/prepareStage()/draw().
    if (this.stageRequested) this.setStage(this.wantedStage);
  }

  private async compileOwnPasses(): Promise<void> {
    const r = this.three;
    const passes = [
      this.ditherPass,
      this.haloBlur,
      this.layerComposite,
      this.bloomDown,
      this.bloomUp,
      this.godPass,
      this.postPass,
      this.lumPass,
      this.govPass,
      this.finalPass,
    ];
    await Promise.all([...passes.map((p) => p.compile(r)), this.compositor.compile(r)]);
  }

  private buildTargets(): void {
    const ss = this.tier.supersample;
    this.sceneRT = makeRT(LOGICAL_W * ss, LOGICAL_H * ss, { type: this.hdrType, filter: 'linear' });
    this.frameRT = makeRT(LOGICAL_W, LOGICAL_H, { count: 2, filter: 'nearest' });
    this.layerRT = makeRT(LOGICAL_W, LOGICAL_H, { count: 2, filter: 'nearest' });
    this.haloA = makeRT(LOGICAL_W >> 1, LOGICAL_H >> 1, { filter: 'linear' });
    this.haloB = makeRT(LOGICAL_W >> 1, LOGICAL_H >> 1, { filter: 'linear' });
    // linear: only the sharp-bilinear final path filters it; every other read is texelFetch (exact)
    this.postRT = makeRT(LOGICAL_W, LOGICAL_H, { filter: 'linear' });
    this.lumRT = makeRT(Math.ceil(LOGICAL_W / 16), Math.ceil(LOGICAL_H / 16), { type: this.govType });
    this.govRT = [makeRT(1, 1, { type: this.govType }), makeRT(1, 1, { type: this.govType })];
    this.govReset = true;
    this.godRT = makeRT(LOGICAL_W >> 1, LOGICAL_H >> 1, { filter: 'linear' });
    this.buildBloomChain();
  }

  private buildBloomChain(): void {
    this.bloomRTs = [];
    let w = LOGICAL_W >> 1;
    let h = LOGICAL_H >> 1;
    for (let i = 0; i < this.tier.bloomLevels; i++) {
      this.bloomRTs.push(makeRT(Math.max(2, w), Math.max(2, h), { type: this.hdrType, filter: 'linear' }));
      w = Math.ceil(w / 2);
      h = Math.ceil(h / 2);
    }
  }

  private buildPasses(): void {
    this.foreground = new Foreground(this.res, this.fgShared);
    this.foreground.setTier(this.tierNow);
    this.foreground.setEnabled(this.fgEnabled);
    const res = { value: this.res };
    this.bayerTex = new DataTexture(bayerTexels(4), 4, 4, RedFormat, UnsignedByteType);
    this.bayerTex.minFilter = NearestFilter;
    this.bayerTex.magFilter = NearestFilter;
    this.bayerTex.unpackAlignment = 1;
    this.bayerTex.generateMipmaps = false;
    this.bayerTex.needsUpdate = true;

    this.ditherPass = new FullscreenPass(SCENERY_DITHER_FRAG, {
      uRes: res,
      uScene: { value: this.sceneRT.texture },
      uTaps: { value: this.tier.supersample === 2 ? 4 : 1 },
      uLut: { value: null },
      uLutSize: { value: 32 },
      uPalSrgb: { value: null },
      uPalLin: { value: null },
      uBayer: { value: this.bayerTex },
      uLevels: { value: 4 },
      uExposure: { value: 1 },
      uContrast: { value: 1 },
      uDither: { value: 1 },
      uLens: { value: new Float32Array(16) },
      uNumLens: { value: 0 },
      uBloomThreshold: { value: 0.7 },
      uBloomGain: { value: 0.5 },
      uHalo: { value: this.haloB.texture },
      uCover: { value: this.layerRT.textures[0] },
      uHasLayers: { value: 0 },
      uHaloParams: { value: new Vector4(0.3, 0.35, 0.5, 1) },
      uHaloLift: { value: new Vector2(0.14, 0) },
      uBand: { value: new Vector4(0, 0, 40, 0.5) },
      uBandRatio: { value: 0.3 },
      uLt: this.lightData,
      uLtCol: this.lightCol,
      uLtImp: this.lightImp,
      uNLt: this.nLights,
      uRelight: { value: 0 },
    });
    this.haloBlur = new FullscreenPass(HALO_BLUR_FRAG, {
      uSrc: { value: null },
      uStep: { value: new Vector2() },
      uFromLayers: { value: 1 },
    });
    this.layerComposite = new FullscreenPass(LAYER_COMPOSITE_FRAG, {
      uRes: res,
      uColor: { value: this.layerRT.textures[0] },
      uEmis: { value: this.layerRT.textures[1] },
    });
    {
      // premultiplied "over": the layer target already holds premultiplied colour and coverage
      const m = this.layerComposite.material;
      m.blending = CustomBlending;
      m.blendEquation = AddEquation;
      m.blendSrc = OneFactor;
      m.blendDst = OneMinusSrcAlphaFactor;
      m.blendSrcAlpha = OneFactor;
      m.blendDstAlpha = OneMinusSrcAlphaFactor;
      m.transparent = true;
    }
    this.bloomDown = new FullscreenPass(BLOOM_DOWN_FRAG, {
      uSrc: { value: null },
      uTexel: { value: new Vector2() },
    });
    this.bloomUp = new FullscreenPass(BLOOM_UP_FRAG, {
      uSrc: { value: null },
      uTexel: { value: new Vector2() },
      uWeight: { value: 1 },
    });
    // Up passes accumulate into the level above: additive blending on that pass only.
    const m = this.bloomUp.material;
    m.blending = CustomBlending;
    m.blendEquation = AddEquation;
    m.blendSrc = OneFactor;
    m.blendDst = OneFactor;
    m.blendSrcAlpha = OneFactor;
    m.blendDstAlpha = OneFactor;
    m.transparent = true;

    this.godPass = new FullscreenPass(GODRAYS_FRAG, {
      uRes: res,
      uFrame: { value: this.frameRT.textures[0] },
      uLight: { value: new Vector2() },
      uSamples: { value: this.tier.godSamples },
      uDensity: { value: 0.95 },
      uDecay: { value: 0.965 },
      uHaloR: { value: 90 },
      uGasK: { value: 0.6 },
      uOcc: { value: 0.3 },
    });
    this.postPass = new FullscreenPass(POST_FRAG, {
      uRes: res,
      uFrame: { value: this.frameRT.textures[0] },
      uBloom: { value: this.bloomRTs[0]!.texture },
      uGod: { value: this.godRT.texture },
      uBayer: { value: this.bayerTex },
      uCover: { value: this.layerRT.textures[0] },
      uHasLayers: { value: 0 },
      uGlowDamp: { value: new Vector2(0.6, 0.9) },
      uLt: this.lightData,
      uLtCol: this.lightCol,
      uLtImp: this.lightImp,
      uNLt: this.nLights,
      uRelight: { value: 0 },
      uShock: { value: this.postShock },
      uNumShock: { value: 0 },
      uRefr: { value: this.refr },
      uNumRefr: { value: 0 },
      uBloomGain: { value: 1 },
      uBloomLevels: { value: 14 },
      uGodColor: { value: this.godColor },
      uGodGain: { value: 1 },
      uVignette: { value: 0.5 },
      uGrain: { value: 0.03 },
      uFrameNo: { value: 0 },
      uGodTint: { value: 0.5 },
    });
    this.lumPass = new FullscreenPass(LUM_DOWN_FRAG, {
      uRes: res,
      uSrc: { value: this.postRT.texture },
    });
    this.govPass = new FullscreenPass(GOVERN_FRAG, {
      uBlocks: { value: this.lumRT.texture },
      uPrev: { value: this.govRT[1]!.texture },
      uDt: { value: 1 / 60 },
      uTau: { value: GOVERNOR_TAU },
      uLimit: { value: GOVERNOR_LIMIT },
      uReset: { value: 1 },
      uOn: { value: 1 },
    });
    this.finalPass = new FullscreenPass(FINAL_FRAG, {
      uRes: res,
      uPost: { value: this.postRT.texture },
      uUi: { value: null },
      uHasUi: { value: 0 },
      uZoom: { value: 1 },
      uRoll: { value: 0 },
      uPush: { value: 0 },
      uSharp: { value: 1 },
      uGov: { value: this.govRT[0]!.texture },
      uHasGov: { value: 0 },
    });
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  Stages: prepare in the background, switch instantly
   * ------------------------------------------------------------------------------------------------ */

  isStageReady(id: StageId): boolean {
    return this.active?.id === id || this.prepared?.id === id;
  }

  debugActiveStage(): StageId | null {
    return this.active?.id ?? null;
  }

  /** The palette-LUT + scenery + compile pipeline as one resumable generator (progress 0..1). */
  private *stageSteps(id: StageId, out: { stage: PreparedStage | null }): Generator<PrepareStep, void, void> {
    const info = STAGES[id];
    const pal = preparePalette(info.palette, info.ramps);
    const lutBuilder = new LutBuilder(pal, { size: LUT_SIZE });
    yield 0.01;
    while (!lutBuilder.done) {
      lutBuilder.step();
      yield 0.01 + 0.14 * lutBuilder.progress;
    }
    const scenery = createScenery(id);
    yield* scaled(
      scenery.prepare({
        renderer: this.three,
        info,
        quality: this.tierNow,
        width: this.sceneRT.width,
        height: this.sceneRT.height,
      }),
      0.15,
      0.88,
    );
    out.stage = { id, scenery, palette: this.makePalette(pal, lutBuilder.result(), info.lighting.color) };
    yield 0.98;
  }

  private makePalette(
    pal: ReturnType<typeof preparePalette>,
    lut: DitherLut,
    lightColor: string,
  ): PaletteResources {
    const t3 = new Data3DTexture(lut.data, lut.size, lut.size, lut.size);
    t3.format = RGBAFormat;
    t3.type = UnsignedByteType;
    t3.minFilter = NearestFilter;
    t3.magFilter = NearestFilter;
    t3.wrapS = ClampToEdgeWrapping;
    t3.wrapT = ClampToEdgeWrapping;
    t3.wrapR = ClampToEdgeWrapping;
    t3.generateMipmaps = false;
    t3.unpackAlignment = 1;
    t3.needsUpdate = true;
    const tex = paletteTextures(pal);
    const c = hex(lightColor);
    return {
      lut: t3,
      size: lut.size,
      srgb: dataTexture(tex.srgb8, PALETTE_TEX_W, 1, RGBAFormat, UnsignedByteType),
      lin: dataTexture(tex.linear32, PALETTE_TEX_W, 1, RGBAFormat, FloatType),
      godColor: [pr(c) / 255, pg(c) / 255, pb(c) / 255],
    };
  }

  private disposeStage(p: PreparedStage | null): void {
    if (!p) return;
    p.scenery.dispose();
    p.palette.lut.dispose();
    p.palette.srgb.dispose();
    p.palette.lin.dispose();
  }

  /** Make a finished stage the one being drawn (instant), retiring the previous one. */
  private activate(p: PreparedStage): void {
    const old = this.active;
    this.active = p;
    if (this.prepared === p) this.prepared = null;
    const u = this.ditherPass.uniforms;
    u.uLut!.value = p.palette.lut;
    u.uLutSize!.value = p.palette.size;
    u.uPalSrgb!.value = p.palette.srgb;
    u.uPalLin!.value = p.palette.lin;
    this.godColor.set(p.palette.godColor[0], p.palette.godColor[1], p.palette.godColor[2]);
    p.scenery.setQuality(this.tierNow);
    this.foreground?.setup(
      STAGES[p.id].arena,
      p.scenery.look.foreground ?? { color: [0.03, 0.03, 0.04] },
      0x46470 + STAGES[p.id].index * 977,
    );
    this.foreground?.setTier(this.tierNow);
    this.wantedStage = p.id;
    this.lastTimeSec = -1;
    this.sceneTime = 0;
    this.drawnOnce = false;
    this.govReset = true;
    this.controller?.disrupt(now());
    if (old && old !== p) this.disposeStage(old);
  }

  /** Blocking switch: prepares in one go if the stage is not ready. Prefer `prepareStage` ahead of time (stage-select screen). */
  setStage(id: StageId): void {
    this.wantedStage = id;
    this.stageRequested = true;
    if (!this.ready) return;
    if (this.active?.id === id) return;
    if (this.prepared?.id === id) {
      this.activate(this.prepared);
      return;
    }
    const job = this.jobs.get(id);
    if (job) job.cancelled = true; // the blocking build below supersedes it
    const out: { stage: PreparedStage | null } = { stage: null };
    runToEnd(this.stageSteps(id, out));
    if (out.stage) this.activate(out.stage);
  }

  prepareStage(id: StageId, onProgress?: (fraction: number) => void): Promise<void> {
    if (!this.ready) return Promise.reject(new Error('renderer not initialised'));
    this.wantedStage = id;
    this.stageRequested = true;
    if (this.isStageReady(id)) {
      onProgress?.(1);
      return Promise.resolve();
    }
    const existing = this.jobs.get(id);
    if (existing && !existing.cancelled) {
      if (onProgress) {
        existing.listeners.push(onProgress);
        onProgress(existing.progress);
      }
      return existing.promise;
    }
    const job: PrepareJob = {
      id,
      listeners: onProgress ? [onProgress] : [],
      progress: 0,
      cancelled: false,
      promise: Promise.resolve(),
    };
    job.promise = this.jobQueue = this.jobQueue.then(() => this.runJob(job));
    this.jobs.set(id, job);
    // A failed job must not poison the queue for the next one.
    this.jobQueue = this.jobQueue.catch(() => undefined);
    return job.promise;
  }

  private async runJob(job: PrepareJob): Promise<void> {
    const t0 = now();
    try {
      if (job.cancelled || this.disposed || this.isStageReady(job.id)) return;
      const out: { stage: PreparedStage | null } = { stage: null };
      let cpu = 0;
      const report = (f: number): void => {
        job.progress = Math.max(job.progress, f);
        for (const l of job.listeners) l(job.progress);
      };
      const timed = timedSteps(this.stageSteps(job.id, out), (ms) => (cpu += ms));
      const res = await runSliced(timed, {
        budgetMs: this.opts.prepareBudgetMs ?? 5,
        now,
        nextFrame: animationFrame,
        onProgress: (f) => report(f * 0.88),
        cancelled: () => job.cancelled || this.disposed || this.lost,
      });
      if (!res.completed || !out.stage) {
        this.disposeStage(out.stage);
        return;
      }
      const stage = out.stage;
      report(0.9);
      // Shader programs compile in parallel with the game running (falls back to a synchronous compile without the extension).
      await stage.scenery.compile(this.sceneRT);
      if (job.cancelled || this.disposed) {
        this.disposeStage(stage);
        return;
      }
      if (this.prepared) this.disposeStage(this.prepared);
      this.prepared = stage;
      report(1);
      this.stats.prepare = {
        stage: job.id,
        wallMs: now() - t0,
        cpuMs: cpu,
        frames: res.frames,
        maxSliceMs: res.maxSliceMs,
      };
    } finally {
      if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
    }
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssW = Math.max(1, cssWidth);
    this.cssH = Math.max(1, cssHeight);
    this.dpr = Math.max(0.5, dpr || 1);
    if (!this.ready) return;
    const physW = Math.max(1, Math.round(this.cssW * this.dpr));
    const physH = Math.max(1, Math.round(this.cssH * this.dpr));
    this.three.setSize(physW, physH, false);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    this.layout = computeViewport(physW, physH, this.opts.integerScale !== false);
    this.controller?.disrupt(now());
  }

  /** FrameFx positions are WORLD coordinates; the shaders want logical screen px. */
  private packFx(fx: FrameFx, vx: number, vy: number): void {
    const f = this.forces;
    let n = 0;
    for (let i = 0; i < fx.shockwaves.length && n < MAX_SHOCKS; i++) {
      const s = fx.shockwaves[i]!;
      const life = Math.max(0, 1 - s.age);
      if (life <= 0 || s.radius < 1) continue;
      // `strength` is the CURRENT refraction strength (producers already decay it); the age term only rounds off the
      // last part of the ring's life so it never pops out.
      const disp = s.strength * 14 * (1 - s.age * s.age);
      f.shock[n * 4] = s.x - vx;
      f.shock[n * 4 + 1] = s.y - vy;
      f.shock[n * 4 + 2] = s.radius;
      f.shock[n * 4 + 3] = disp;
      this.postShock[n * 4] = s.x - vx;
      this.postShock[n * 4 + 1] = s.y - vy;
      this.postShock[n * 4 + 2] = s.radius;
      this.postShock[n * 4 + 3] = disp * 0.9;
      n++;
    }
    f.nShock = n;
    let m = 0;
    for (let i = 0; i < fx.impulses.length && m < MAX_IMPULSES; i++) {
      const s = fx.impulses[i]!;
      const life = Math.max(0, 1 - s.age);
      if (life <= 0) continue;
      f.impulse[m * 4] = s.x - vx;
      f.impulse[m * 4 + 1] = s.y - vy;
      f.impulse[m * 4 + 2] = Math.max(8, s.radius);
      // `strength` is current (producers decay it); the age term only fades the tail. ≈ 0.5 rad of twist at the centre for 0.6.
      f.impulse[m * 4 + 3] = s.strength * Math.sqrt(life) * 0.9;
      f.impulse2[m * 4] = s.age;
      f.impulse2[m * 4 + 1] = s.hue;
      m++;
    }
    f.nImpulse = m;
    const lens = this.lens;
    let k = 0;
    for (let i = 0; i < fx.lenses.length && k < 4; i++) {
      const l = fx.lenses[i]!;
      if (l.horizonR <= 0) continue;
      lens[k * 4] = l.x - vx;
      lens[k * 4 + 1] = l.y - vy;
      lens[k * 4 + 2] = l.horizonR;
      lens[k * 4 + 3] = l.strength;
      k++;
    }
    // lights: body lights first (they own sprite relighting), then impact lights; ≤ 4 in all
    const lt = this.lightData.value;
    const lc = this.lightCol.value;
    const li = this.lightImp.value;
    let nl = 0;
    let maxImp = 0;
    const lights = fx.lights;
    if (lights) {
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < lights.length && nl < 4; i++) {
          const l = lights[i]!;
          const imp = l.kind === 'impact';
          if (imp !== (pass === 1)) continue;
          if (!(l.intensity > 0.02) || !(l.radius > 1)) continue;
          lt[nl * 4] = l.x - vx;
          lt[nl * 4 + 1] = l.y - vy;
          lt[nl * 4 + 2] = l.radius;
          lt[nl * 4 + 3] = l.intensity;
          lc[nl * 3] = l.r;
          lc[nl * 3 + 1] = l.g;
          lc[nl * 3 + 2] = l.b;
          li[nl] = imp ? 1 : 0;
          if (imp) maxImp = Math.max(maxImp, l.intensity);
          nl++;
        }
      }
    }
    this.nLights.value = nl;
    // Local wound refraction (D5, replaces the full-frame aberration): around the impact lights, `fx.aberration` is the
    // strongest lens strength (FxState decays it with its light), shared out by each impact light's share of the brightest.
    let nr = 0;
    if (fx.aberration > 0.01 && maxImp > 0) {
      for (let i = 0; i < nl && nr < 2; i++) {
        if (li[i]! < 0.5) continue;
        const s = (Math.min(1, fx.aberration) * lt[i * 4 + 3]!) / maxImp;
        if (s < 0.02) continue;
        this.refr[nr * 4] = lt[i * 4]!;
        this.refr[nr * 4 + 1] = lt[i * 4 + 1]!;
        this.refr[nr * 4 + 2] = lt[i * 4 + 2]! * 0.7;
        this.refr[nr * 4 + 3] = s;
        nr++;
      }
    }
    this.nRefr = nr;
    this.ditherPass.uniforms.uNumLens!.value = k;
    (this.ditherPass.uniforms.uLens!.value as Float32Array).set(lens);
  }

  /** What the scenery does with the camera this frame (D27): dolly scale at parallax 1 and the impact kick. */
  private sceneryCamera(cam: RenderFrame['camera'], out: SceneryFrame['cam']): void {
    const zoomDolly = this.spritePush ? 0 : Math.max(0, (cam.zoom ?? 1) - 1) * DOLLY_FROM_ZOOM;
    const d = Math.max(0, Math.min(1, (cam.dolly ?? 0) + zoomDolly));
    out.dolly = d * DOLLY_MAX;
    out.kickX = Math.max(-KICK_MAX, Math.min(KICK_MAX, cam.kickX ?? 0));
    out.kickY = Math.max(-KICK_MAX, Math.min(KICK_MAX, cam.kickY ?? 0));
  }

  draw(frame: RenderFrame): void {
    if (!this.ready || this.lost) return;
    const t0 = now();
    const r = this.three;
    // A stage switch never blocks: use the prepared one if it is ready; otherwise start preparing in the background and keep
    // showing the previous stage (or black when there is none yet).
    if (frame.stage !== this.active?.id) {
      if (this.prepared?.id === frame.stage) this.activate(this.prepared);
      else if (!this.jobs.has(frame.stage)) void this.prepareStage(frame.stage).catch(() => undefined);
    }
    const scenery = this.active?.scenery ?? null;
    this.collectLuma();
    r.info.reset();
    this.frameNo++;
    this.layers.beginFrame();
    this.gpuTimer?.begin();
    const fx = frame.fx;
    const view = frame.view;

    // ---- scenery clock: follows sim time scale so the universe slows with a KO ----
    // The first frame adopts the caller's clock (deterministic harness: `?t=30` shows the universe at 30 s); after that
    // the scenery clock advances by real elapsed time × the sim's time scale. A big jump (hidden tab) moves the clock
    // but is clamped for the integrators (`dt`).
    const elapsed = this.lastTimeSec < 0 ? 0 : Math.max(0, frame.timeSec - this.lastTimeSec);
    if (this.lastTimeSec < 0) this.sceneTime = frame.timeSec;
    this.lastTimeSec = frame.timeSec;
    this.sceneTime += elapsed * fx.timeScale;
    const dt = Math.min(0.1, elapsed) * fx.timeScale;

    this.packFx(fx, view.x0, view.y0);
    const look = scenery?.look ?? FALLBACK_LOOK;
    const sf = this.sceneryFrame;
    this.sceneryCamera(frame.camera, sf.cam);
    if (scenery) {
      sf.timeSec = this.sceneTime;
      sf.dtSec = dt;
      sf.view = view;
      sf.camera = frame.camera;
      sf.comfort = this.comfort;
      sf.fx = fx;
      scenery.update(sf);
      scenery.render(this.sceneRT);
    }
    const t1 = now();

    // ---- 2D layers first, into their own target: their coverage shapes the scenery grade beneath them ----
    this.emisGain.value = 1.5;
    const drawn = this.compositor.draw(r, this.layerRT, frame.layers, view, frame.alpha);
    const hasLayers = drawn > 0;
    const halo = look.spriteHalo ?? DEFAULT_SPRITE_HALO;
    if (hasLayers) this.blurCoverage(halo.radius);

    // ---- resolve: lens → tone map → readability grade → dither into the stage palette ----
    const du = this.ditherPass.uniforms;
    // D5: the fight's intensity only nudges exposure (it used to step it +18 %); FxState also slew-limits intensity itself
    du.uExposure!.value = look.exposure * (1 + 0.06 * fx.intensity);
    du.uContrast!.value = look.contrast;
    du.uBloomThreshold!.value = look.bloomThreshold;
    du.uBloomGain!.value = look.bloomGain;
    du.uHasLayers!.value = hasLayers ? 1 : 0;
    (du.uHaloParams!.value as Vector4).set(halo.strength, halo.desat, halo.rim, halo.rimReach ?? 1);
    (du.uHaloLift!.value as Vector2).set(halo.lift ?? DEFAULT_SPRITE_HALO.lift, 0);
    const band = look.fightBand ?? DEFAULT_FIGHT_BAND;
    const restY = STAGES[this.active?.id ?? frame.stage].arena.restY;
    (du.uBand!.value as Vector4).set(
      restY + band.top - view.y0,
      restY + band.bottom - view.y0,
      band.feather,
      band.ceiling,
    );
    du.uBandRatio!.value = band.keep;
    r.setClearColor(0x000000, 1);
    if (scenery) {
      this.ditherPass.render(r, this.frameRT);
    } else {
      r.setRenderTarget(this.frameRT);
      r.clear(true, false, false);
    }
    if (hasLayers) this.layerComposite.render(r, this.frameRT);
    // ---- foreground: soft dust and small rocks drifting in front of the fighters (before bloom and post) ----
    if (this.foreground?.active && this.tierNow > 0) {
      const fu = this.fgShared;
      fu.view.value.set(view.x0, view.y0);
      fu.time.value = this.sceneTime;
      fu.flow.value = this.sceneTime;
      fu.intensity.value = fx.intensity;
      fu.nShock.value = this.forces.nShock;
      fu.nImp.value = this.forces.nImpulse;
      fu.dolly.value = sf.cam.dolly;
      fu.kick.value.set(sf.cam.kickX, sf.cam.kickY);
      this.foreground.setBand(restY + band.top - view.y0, restY + band.bottom - view.y0);
      this.foreground.render(r, this.frameRT);
    }

    // ---- bloom pyramid ----
    this.runBloom();

    // ---- god rays (half res) ----
    if (scenery) scenery.lightScreenPos(this.lightPos);
    this.warpLight(this.lightPos, sf.cam);
    const gu = this.godPass.uniforms;
    (gu.uLight!.value as Vector2).set(this.lightPos.x, this.lightPos.y);
    gu.uHaloR!.value = look.godRayHalo;
    gu.uDecay!.value = look.godRayDecay;
    gu.uGasK!.value = look.godRayGas;
    this.godPass.render(r, this.godRT);

    // ---- post ----
    const pu = this.postPass.uniforms;
    pu.uRelight!.value = this.tierNow > 0 ? 1 : 0;
    pu.uNumShock!.value = this.forces.nShock;
    pu.uNumRefr!.value = this.nRefr;
    pu.uBloomGain!.value = 0.6 + 0.4 * this.comfort;
    pu.uGodGain!.value = look.godRayGain * (0.85 + 0.25 * fx.intensity);
    pu.uVignette!.value = look.vignette;
    pu.uFrameNo!.value = frame.tick & 1023; // grain follows the sim tick: identical frames render identically
    pu.uHasLayers!.value = hasLayers ? 1 : 0;
    const damp = look.glowDamp ?? DEFAULT_GLOW_DAMP;
    (pu.uGlowDamp!.value as Vector2).set(damp[0], damp[1]);
    this.postPass.render(r, this.postRT);

    // ---- luminance governor: measure the frame, hold back any full-frame brightening beyond the limit ----
    this.govern(frame.tick, Math.min(0.1, elapsed));

    // ---- present ----
    this.present(frame);

    const t2 = now();
    this.stats.drawCalls = r.info.render.calls;
    this.avgFrame.push(t2 - t0);
    this.avgScenery.push(t1 - t0);
    this.avgPost.push(t2 - t1);
    this.stats.frameMs = this.avgFrame.value;
    this.stats.sceneryMs = this.avgScenery.value;
    this.stats.postMs = this.avgPost.value;
    this.layers.sweep();
    this.drawnOnce = true;
    this.gpuTimer?.end();
    this.adaptQuality(t0);
  }

  /** Feed the frame pacing to the adaptive controller and apply the tier it asks for. */
  private adaptQuality(t: number): void {
    const gpu = this.gpuTimer?.poll() ?? null;
    if (gpu !== null) this.stats.gpuMs = gpu;
    const c = this.controller;
    const delta = this.lastDrawAt > 0 ? t - this.lastDrawAt : 0;
    this.lastDrawAt = t;
    if (!c || delta <= 0) return;
    const next = c.sample(t, delta, gpu);
    const snap = c.snapshot(t);
    this.stats.lateRate = snap.lateRate;
    this.stats.tierChanges = snap.changes;
    if (next !== null) this.applyTier(next);
  }

  /** Change quality tier now: resize what depends on it, tell the scenery. Cheap enough to do mid-fight. */
  private applyTier(t: QualityTier): void {
    if (t === this.tierNow) return;
    const prev = this.tier;
    this.tierNow = t;
    this.tier = TIERS[t];
    this.stats.tier = t;
    if (prev.supersample !== this.tier.supersample) {
      this.sceneRT.dispose();
      this.sceneRT = makeRT(LOGICAL_W * this.tier.supersample, LOGICAL_H * this.tier.supersample, {
        type: this.hdrType,
        filter: 'linear',
      });
      this.ditherPass.uniforms.uScene!.value = this.sceneRT.texture;
      this.ditherPass.uniforms.uTaps!.value = this.tier.supersample === 2 ? 4 : 1;
    }
    if (prev.bloomLevels !== this.tier.bloomLevels) {
      for (const b of this.bloomRTs) b.dispose();
      this.buildBloomChain();
      this.postPass.uniforms.uBloom!.value = this.bloomRTs[0]!.texture;
    }
    this.godPass.uniforms.uSamples!.value = this.tier.godSamples;
    this.foreground?.setTier(t);
    this.active?.scenery.setQuality(t);
    this.prepared?.scenery.setQuality(t);
  }

  debugSetForeground(on: boolean): void {
    this.fgEnabled = on;
    this.foreground?.setEnabled(on);
  }

  debugSetTier(tier: QualityTier): void {
    if (tier === 0 || tier === 1 || tier === 2) this.applyTier(tier);
  }

  /** Layer coverage → soft halo (two separable passes at half res): layerRT.a → haloA (horizontal) → haloB (vertical). */
  private blurCoverage(radiusPx: number): void {
    const r = this.three;
    const u = this.haloBlur.uniforms;
    // 9 taps spanning ≈ 2.4σ: tap spacing in half-res texels so that the kernel reaches `radiusPx` logical px.
    const stepPx = Math.max(0.5, radiusPx / 4);
    u.uSrc!.value = this.layerRT.textures[0];
    u.uFromLayers!.value = 1;
    (u.uStep!.value as Vector2).set(stepPx / LOGICAL_W, 0);
    this.haloBlur.render(r, this.haloA);
    u.uSrc!.value = this.haloA.texture;
    u.uFromLayers!.value = 0;
    (u.uStep!.value as Vector2).set(0, stepPx / LOGICAL_H);
    this.haloBlur.render(r, this.haloB);
  }

  private runBloom(): void {
    const r = this.three;
    const chain = this.bloomRTs;
    const src0 = this.frameRT.textures[1]!;
    const dn = this.bloomDown.uniforms;
    // down: emissive (logical) → level 0 (half) → … deeper
    let src = src0;
    let sw = LOGICAL_W;
    let sh = LOGICAL_H;
    for (let i = 0; i < chain.length; i++) {
      dn.uSrc!.value = src;
      (dn.uTexel!.value as Vector2).set(1 / sw, 1 / sh);
      this.bloomDown.render(r, chain[i]!);
      src = chain[i]!.texture;
      sw = chain[i]!.width;
      sh = chain[i]!.height;
    }
    // up: accumulate each smaller level into the one above (tent), deepest first
    const up = this.bloomUp.uniforms;
    for (let i = chain.length - 1; i > 0; i--) {
      up.uSrc!.value = chain[i]!.texture;
      (up.uTexel!.value as Vector2).set(1 / chain[i]!.width, 1 / chain[i]!.height);
      up.uWeight!.value = 1.0;
      this.bloomUp.render(r, chain[i - 1]!);
    }
  }

  /** The god-ray light is far away (parallax ≈ 0.1): it follows the scenery dolly / kick like a far layer. */
  private warpLight(p: { x: number; y: number }, cam: SceneryFrame['cam']): void {
    const par = 0.1;
    const s = (1 - cam.dolly) / (1 - par * cam.dolly);
    const kx = p.x + cam.kickX * (par - 1);
    const ky = p.y + cam.kickY * (par - 1);
    p.x = LOGICAL_W / 2 + (kx - LOGICAL_W / 2) * s;
    p.y = LOGICAL_H / 2 + (ky - LOGICAL_H / 2) * s;
  }

  private readonly lumaQueue: LumaSample[] = [];

  /**
   * Luminance governor (D5 safety net): block sums of the post frame → a 1×1 state that holds back any rise of the frame's mean
   * relative luminance beyond GOVERNOR_LIMIT above its 300 ms average (the final pass applies the gain; UI excluded). Its state
   * is read back asynchronously for `stats.luma` / `drainLuma()`.
   */
  private govern(tick: number, dtSec: number): void {
    const r = this.three;
    this.lumPass.render(r, this.lumRT);
    const prev = this.govRT[this.govIdx]!;
    const next = this.govRT[1 - this.govIdx]!;
    const g = this.govPass.uniforms;
    g.uPrev!.value = prev.texture;
    g.uDt!.value = dtSec;
    g.uReset!.value = this.govReset ? 1 : 0;
    g.uOn!.value = this.govOn ? 1 : 0;
    // the comfort setting tightens the cap too (half of it at 0 %)
    g.uLimit!.value = GOVERNOR_LIMIT * (0.5 + 0.5 * this.comfort);
    this.govPass.render(r, next);
    this.govIdx = 1 - this.govIdx;
    this.govReset = false;
    const fu = this.finalPass.uniforms;
    fu.uGov!.value = next.texture;
    fu.uHasGov!.value = 1;
    const rb = this.lumaRead;
    if (rb) {
      // `next` is still the bound framebuffer: queue its 16 bytes into a pack buffer, collect the ones that have landed
      rb.capture(this.frameNo, tick);
    }
  }

  /**
   * Collect finished luminance reads. Called at the START of a frame, before it issues any GL command, so the buffer read
   * only has to wait for the previous frame's (already submitted) commands to reach the GPU process.
   */
  private collectLuma(): void {
    const rb = this.lumaRead;
    if (!rb) return;
    const a = now();
    const q = this.lumaQueue;
    const before = q.length;
    rb.poll(q, this.frameNo);
    if (q.length > before) this.stats.luma = q[q.length - 1]!;
    if (q.length > LUMA_KEEP) q.splice(0, q.length - LUMA_KEEP);
    this.lumaPollMs = Math.max(this.lumaPollMs * 0.98, now() - a);
  }

  /** Slowly decaying maximum CPU ms of collectLuma (verification). */
  private lumaPollMs = 0;

  private makeLumaReadback(): LumaReadback | null {
    this.lumaRead?.dispose();
    if (this.govType !== FloatType) return null;
    return LumaReadback.create(this.three.getContext() as WebGL2RenderingContext);
  }

  drainLuma(): LumaStats[] {
    const out = this.lumaQueue.slice();
    this.lumaQueue.length = 0;
    return out;
  }

  setComfort(flash: number): void {
    this.comfort = Math.max(0, Math.min(1, Number.isFinite(flash) ? flash : 1));
  }

  debugSetGovernor(on: boolean): void {
    this.govOn = on;
  }

  debugLumaReadback(diag: boolean): {
    available: boolean;
    skipped: number;
    errors: string[];
    pollMs: number;
  } {
    const rb = this.lumaRead;
    if (rb) rb.diag = diag;
    return {
      available: rb !== null,
      skipped: rb?.skipped ?? 0,
      errors: rb ? [...rb.errors] : [],
      pollMs: this.lumaPollMs,
    };
  }

  debugSetSpritePush(on: boolean): void {
    this.spritePush = on;
  }

  private present(frame: RenderFrame): void {
    const r = this.three;
    const fu = this.finalPass.uniforms;
    const cam = frame.camera;
    // D27: sprites stay 1:1 unless the sprite-push A/B (push=1) is on; then zoom resamples sharp-bilinearly
    const zoom = this.spritePush ? Math.max(1, Math.min(SPRITE_PUSH_MAX, cam.zoom)) : 1;
    fu.uZoom!.value = zoom;
    fu.uPush!.value = this.spritePush ? 1 : 0;
    fu.uSharp!.value = this.layout.scale * zoom;
    fu.uRoll!.value = Math.max(-ROLL_LIMIT, Math.min(ROLL_LIMIT, cam.roll));
    if (frame.ui && frame.ui.visible) {
      fu.uUi!.value = this.layers.acquire(frame.ui).tex;
      fu.uHasUi!.value = 1;
    } else {
      fu.uHasUi!.value = 0;
    }
    const L = this.layout;
    r.setRenderTarget(null);
    r.setScissorTest(false);
    r.setViewport(0, 0, L.physW, L.physH);
    r.setClearColor(0x000000, 1);
    r.clear(true, false, false);
    // three's viewport origin is bottom-left; the letterbox is symmetric so y needs no flip.
    r.setViewport(L.x, L.y, L.w, L.h);
    this.finalPass.render(r, null);
    r.setViewport(0, 0, L.physW, L.physH);
  }

  captureLogical(): Uint32Array {
    if (!this.ready || !this.drawnOnce) return new Uint32Array(LOGICAL_W * LOGICAL_H);
    const r = this.three;
    if (!this.captureRT) this.captureRT = makeRT(LOGICAL_W, LOGICAL_H, { filter: 'nearest' });
    const fu = this.finalPass.uniforms;
    const zoom = fu.uZoom!.value;
    const roll = fu.uRoll!.value;
    const sharp = fu.uSharp!.value;
    fu.uZoom!.value = 1;
    fu.uRoll!.value = 0;
    fu.uSharp!.value = 1;
    this.finalPass.render(r, this.captureRT);
    fu.uZoom!.value = zoom;
    fu.uRoll!.value = roll;
    fu.uSharp!.value = sharp;
    const bytes = new Uint8Array(LOGICAL_W * LOGICAL_H * 4);
    r.readRenderTargetPixels(this.captureRT, 0, 0, LOGICAL_W, LOGICAL_H, bytes);
    r.setRenderTarget(null);
    const src = new Uint32Array(bytes.buffer);
    const out = new Uint32Array(LOGICAL_W * LOGICAL_H);
    // GL rows are bottom-first; the contract wants the top row first.
    for (let y = 0; y < LOGICAL_H; y++) {
      const s = (LOGICAL_H - 1 - y) * LOGICAL_W;
      out.set(src.subarray(s, s + LOGICAL_W), y * LOGICAL_W);
    }
    return out;
  }

  debugReadFrame(attachment: 0 | 1): Uint32Array {
    const bytes = new Uint8Array(LOGICAL_W * LOGICAL_H * 4);
    this.three.readRenderTargetPixels(this.frameRT, 0, 0, LOGICAL_W, LOGICAL_H, bytes, undefined, attachment);
    const src = new Uint32Array(bytes.buffer);
    const out = new Uint32Array(LOGICAL_W * LOGICAL_H);
    for (let y = 0; y < LOGICAL_H; y++) {
      const s = (LOGICAL_H - 1 - y) * LOGICAL_W;
      out.set(src.subarray(s, s + LOGICAL_W), y * LOGICAL_W);
    }
    return out;
  }

  debugLayerStats(): { cached: number; create: number; full: number; rect: number; texels: number } {
    return { cached: this.layers.size, ...this.layers.uploads };
  }

  debugSetStaleFrames(frames: number): void {
    this.layers.staleFrames = frames;
  }

  debugLoseContext(lose: boolean): void {
    const ext = this.three.extensions.get('WEBGL_lose_context') as {
      loseContext(): void;
      restoreContext(): void;
    } | null;
    if (!ext) return;
    if (lose) ext.loseContext();
    else ext.restoreContext();
  }

  debugLayout(): { scale: number; x: number; y: number; w: number; h: number } {
    const { scale, x, y, w, h } = this.layout;
    return { scale, x, y, w, h };
  }

  dispose(): void {
    if (!this.ready) return;
    this.ready = false;
    this.disposed = true;
    for (const j of this.jobs.values()) j.cancelled = true;
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    this.disposeStage(this.active);
    this.disposeStage(this.prepared);
    this.active = null;
    this.prepared = null;
    this.foreground?.dispose();
    this.layers.dispose();
    this.compositor.dispose();
    for (const p of [
      this.ditherPass,
      this.haloBlur,
      this.layerComposite,
      this.bloomDown,
      this.bloomUp,
      this.godPass,
      this.postPass,
      this.lumPass,
      this.govPass,
      this.finalPass,
    ])
      p.dispose();
    this.lumaRead?.dispose();
    this.lumaRead = null;
    for (const t of [
      this.sceneRT,
      this.frameRT,
      this.layerRT,
      this.haloA,
      this.haloB,
      this.godRT,
      this.postRT,
      this.captureRT,
      this.lumRT,
      ...this.govRT,
      ...this.bloomRTs,
    ])
      t?.dispose();
    this.bayerTex.dispose();
    disposeSharedGeometry();
    this.three.dispose();
    this.three.forceContextLoss();
  }
}
