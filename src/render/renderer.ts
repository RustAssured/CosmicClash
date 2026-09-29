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
  RedFormat,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderer,
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
import { STAGE_RAMPS } from '@/stages/info';
import { createScenery } from '@/stages/scenery';
import {
  MAX_IMPULSES,
  MAX_SHOCKS,
  type SceneryForces,
  type SceneryFrame,
  type StageScenery,
} from '@/stages/types';
import { LayerCompositor } from './compositor';
import { bayerTexels } from './dither';
import { FullscreenPass, dataTexture, disposeSharedGeometry, makeRT, resetSharedGeometry } from './gl';
import { LayerTextures } from './layerTextures';
import { PALETTE_TEX_W, buildDitherLut, paletteTextures, preparePalette } from './palette';
import {
  BLOOM_DOWN_FRAG,
  BLOOM_UP_FRAG,
  FINAL_FRAG,
  GODRAYS_FRAG,
  POST_FRAG,
  SCENERY_DITHER_FRAG,
} from './shaders';
import { computeViewport, type ViewportLayout } from './viewport';

/** Per-tier tuning: scenery supersampling, bloom pyramid depth, god-ray taps, LUT resolution. */
interface Tier {
  supersample: 1 | 2;
  bloomLevels: number;
  godSamples: number;
  lutSize: number;
}
const TIERS: Record<0 | 1 | 2, Tier> = {
  0: { supersample: 1, bloomLevels: 3, godSamples: 16, lutSize: 32 },
  1: { supersample: 1, bloomLevels: 4, godSamples: 28, lutSize: 40 },
  2: { supersample: 2, bloomLevels: 5, godSamples: 44, lutSize: 48 },
};

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

/** Extra, non-contract hooks used by the GPU verification page (dev/render/verify.ts). Not needed by the app. */
export interface DebuggableRenderer extends Renderer {
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
}

export function createRenderer(): DebuggableRenderer {
  return new PixelRenderer();
}

class PixelRenderer implements DebuggableRenderer {
  readonly stats: RenderStats = { frameMs: 0, sceneryMs: 0, postMs: 0, drawCalls: 0 };

  private three!: WebGLRenderer;
  private canvas!: HTMLCanvasElement;
  private opts: RendererOptions = {};
  private tier: Tier = TIERS[2];
  private quality: 0 | 1 | 2 = 2;
  private ready = false;
  private lost = false;
  private layout: ViewportLayout = computeViewport(LOGICAL_W, LOGICAL_H);
  private cssW = LOGICAL_W;
  private cssH = LOGICAL_H;
  private dpr = 1;

  // targets
  private sceneRT!: WebGLRenderTarget;
  private frameRT!: WebGLRenderTarget;
  private bloomRTs: WebGLRenderTarget[] = [];
  private godRT!: WebGLRenderTarget;
  private postRT!: WebGLRenderTarget;
  private captureRT: WebGLRenderTarget | null = null;
  private hdrType: TextureDataType = HalfFloatType;

  // passes
  private ditherPass!: FullscreenPass;
  private bloomDown!: FullscreenPass;
  private bloomUp!: FullscreenPass;
  private godPass!: FullscreenPass;
  private postPass!: FullscreenPass;
  private finalPass!: FullscreenPass;
  private layers!: LayerTextures;
  private compositor!: LayerCompositor;

  // shared uniform objects
  private readonly res = new Vector2(LOGICAL_W, LOGICAL_H);
  private readonly emisGain = { value: 1.5 };
  private bayerTex!: DataTexture;
  private lutTex: Data3DTexture | null = null;
  private palSrgbTex: DataTexture | null = null;
  private palLinTex: DataTexture | null = null;

  // stage
  private stage: StageId = 'nursery';
  private scenery: StageScenery | null = null;
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
  /** Reused every frame (no per-frame allocation). */
  private readonly sceneryFrame: SceneryFrame = {
    timeSec: 0,
    dtSec: 0,
    view: { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H },
    camera: { x: 0, y: 0, zoom: 1, roll: 0, shakeX: 0, shakeY: 0 },
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
  private onRestored = (): void => {
    // Every GL object we created died with the old context, and calling dispose() on them now only makes the browser
    // print "object does not belong to this context". So drop them (never dispose) and rebuild from scratch.
    this.lost = false;
    resetSharedGeometry();
    this.layers = new LayerTextures(this.three);
    this.compositor = new LayerCompositor(this.layers, this.emisGain);
    this.captureRT = null;
    this.lutTex = null;
    this.palSrgbTex = null;
    this.palLinTex = null;
    this.buildTargets();
    this.buildPasses();
    this.resize(this.cssW, this.cssH, this.dpr);
    this.setStage(this.stage, false);
  };

  async init(canvas: HTMLCanvasElement, opts: RendererOptions = {}): Promise<void> {
    if (this.ready) throw new Error('renderer already initialised');
    this.canvas = canvas;
    this.opts = opts;
    this.quality = opts.quality ?? 2;
    this.tier = TIERS[this.quality];
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

    // HDR scenery needs a renderable float target; fall back to 8-bit (less headroom, still correct).
    const canFloat =
      r.extensions.has('EXT_color_buffer_float') || r.extensions.has('EXT_color_buffer_half_float');
    this.hdrType = canFloat ? HalfFloatType : UnsignedByteType;
    r.extensions.get('EXT_color_buffer_float');
    r.extensions.get('EXT_color_buffer_half_float');
    r.extensions.get('OES_texture_float_linear');

    this.layers = new LayerTextures(r);
    this.compositor = new LayerCompositor(this.layers, this.emisGain);
    this.buildTargets();
    this.buildPasses();
    this.ready = true;
    this.resize(this.cssW, this.cssH, this.dpr);
    this.setStage(this.stage);
  }

  private buildTargets(): void {
    const ss = this.tier.supersample;
    this.sceneRT = makeRT(LOGICAL_W * ss, LOGICAL_H * ss, { type: this.hdrType, filter: 'linear' });
    this.frameRT = makeRT(LOGICAL_W, LOGICAL_H, { count: 2, filter: 'nearest' });
    this.postRT = makeRT(LOGICAL_W, LOGICAL_H, { filter: 'nearest' });
    this.godRT = makeRT(LOGICAL_W >> 1, LOGICAL_H >> 1, { filter: 'linear' });
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
      uFlash: { value: 0 },
    });
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
    });
    this.postPass = new FullscreenPass(POST_FRAG, {
      uRes: res,
      uFrame: { value: this.frameRT.textures[0] },
      uBloom: { value: this.bloomRTs[0]!.texture },
      uGod: { value: this.godRT.texture },
      uBayer: { value: this.bayerTex },
      uShock: { value: this.postShock },
      uNumShock: { value: 0 },
      uAberration: { value: 0 },
      uFlash: { value: 0 },
      uBloomGain: { value: 1 },
      uBloomLevels: { value: 14 },
      uGodColor: { value: this.godColor },
      uGodGain: { value: 1 },
      uVignette: { value: 0.5 },
      uGrain: { value: 0.03 },
      uFrameNo: { value: 0 },
      uGodTint: { value: 0.5 },
    });
    this.finalPass = new FullscreenPass(FINAL_FRAG, {
      uRes: res,
      uPost: { value: this.postRT.texture },
      uUi: { value: null },
      uHasUi: { value: 0 },
      uZoom: { value: 1 },
      uRoll: { value: 0 },
    });
  }

  setStage(id: StageId, disposePrevious = true): void {
    this.stage = id;
    if (!this.ready) return;
    const info = STAGES[id];
    if (disposePrevious) this.scenery?.dispose();
    const s = createScenery(id);
    s.init({
      renderer: this.three,
      info,
      quality: this.quality,
      width: this.sceneRT.width,
      height: this.sceneRT.height,
    });
    this.scenery = s;
    this.buildPaletteTextures(info.palette, STAGE_RAMPS[id]);
    const c = hex(info.lighting.color);
    this.godColor.set(pr(c) / 255, pg(c) / 255, pb(c) / 255);
    this.lastTimeSec = -1;
    this.sceneTime = 0;
    this.drawnOnce = false;
  }

  private buildPaletteTextures(palette: readonly string[], ramps: readonly number[]): void {
    const pal = preparePalette(palette, ramps);
    const lut = buildDitherLut(pal, { size: this.tier.lutSize });
    this.lutTex?.dispose();
    this.palSrgbTex?.dispose();
    this.palLinTex?.dispose();
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
    this.lutTex = t3;
    const tex = paletteTextures(pal);
    this.palSrgbTex = dataTexture(tex.srgb8, PALETTE_TEX_W, 1, RGBAFormat, UnsignedByteType);
    this.palLinTex = dataTexture(tex.linear32, PALETTE_TEX_W, 1, RGBAFormat, FloatType);
    const u = this.ditherPass.uniforms;
    u.uLut!.value = this.lutTex;
    u.uLutSize!.value = lut.size;
    u.uPalSrgb!.value = this.palSrgbTex;
    u.uPalLin!.value = this.palLinTex;
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
  }

  /** FrameFx positions are WORLD coordinates; the shaders want logical screen px. */
  private packFx(fx: FrameFx, vx: number, vy: number): void {
    const f = this.forces;
    let n = 0;
    for (let i = 0; i < fx.shockwaves.length && n < MAX_SHOCKS; i++) {
      const s = fx.shockwaves[i]!;
      const life = Math.max(0, 1 - s.age);
      if (life <= 0 || s.radius < 1) continue;
      const disp = s.strength * 15 * life * life;
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
      f.impulse[m * 4 + 3] = s.strength * Math.pow(life, 1.5) * 0.6;
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
    this.ditherPass.uniforms.uNumLens!.value = k;
    (this.ditherPass.uniforms.uLens!.value as Float32Array).set(lens);
  }

  draw(frame: RenderFrame): void {
    if (!this.ready || this.lost) return;
    if (frame.stage !== this.stage || !this.scenery) this.setStage(frame.stage);
    if (!this.scenery) return;
    const t0 = now();
    const r = this.three;
    r.info.reset();
    this.frameNo++;
    this.layers.beginFrame();
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
    const sc = this.scenery;
    const look = sc.look;
    const sf = this.sceneryFrame;
    sf.timeSec = this.sceneTime;
    sf.dtSec = dt;
    sf.view = view;
    sf.camera = frame.camera;
    sf.fx = fx;
    sc.update(sf);
    sc.render(this.sceneRT);
    const t1 = now();

    // ---- resolve: lens → tone map → dither into the stage palette ----
    const du = this.ditherPass.uniforms;
    du.uExposure!.value = look.exposure * (1 + 0.18 * fx.intensity);
    du.uContrast!.value = look.contrast;
    du.uBloomThreshold!.value = look.bloomThreshold;
    du.uBloomGain!.value = look.bloomGain;
    du.uFlash!.value = Math.min(1, fx.flash) * 0.6;
    r.setClearColor(0x000000, 1);
    this.ditherPass.render(r, this.frameRT);

    // ---- 2D layers ----
    this.emisGain.value = 1.5;
    this.compositor.draw(r, this.frameRT, frame.layers, view, frame.alpha);

    // ---- bloom pyramid ----
    this.runBloom();

    // ---- god rays (half res) ----
    sc.lightScreenPos(this.lightPos);
    const gu = this.godPass.uniforms;
    (gu.uLight!.value as Vector2).set(this.lightPos.x, this.lightPos.y);
    gu.uHaloR!.value = look.godRayHalo;
    gu.uDecay!.value = look.godRayDecay;
    gu.uGasK!.value = look.godRayGas;
    this.godPass.render(r, this.godRT);

    // ---- post ----
    const pu = this.postPass.uniforms;
    pu.uNumShock!.value = this.forces.nShock;
    pu.uAberration!.value = Math.min(1, fx.aberration);
    pu.uFlash!.value = Math.min(1, fx.flash) * 0.5;
    pu.uGodGain!.value = look.godRayGain * (0.75 + 0.5 * fx.intensity);
    pu.uVignette!.value = look.vignette;
    pu.uFrameNo!.value = frame.tick & 1023; // grain follows the sim tick: identical frames render identically
    this.postPass.render(r, this.postRT);

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

  private present(frame: RenderFrame): void {
    const r = this.three;
    const fu = this.finalPass.uniforms;
    const cam = frame.camera;
    fu.uZoom!.value = Math.max(1, Math.min(1.06, cam.zoom));
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
    fu.uZoom!.value = 1;
    fu.uRoll!.value = 0;
    this.finalPass.render(r, this.captureRT);
    fu.uZoom!.value = zoom;
    fu.uRoll!.value = roll;
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
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.scenery?.dispose();
    this.scenery = null;
    this.layers.dispose();
    this.compositor.dispose();
    for (const p of [
      this.ditherPass,
      this.bloomDown,
      this.bloomUp,
      this.godPass,
      this.postPass,
      this.finalPass,
    ])
      p.dispose();
    for (const t of [this.sceneRT, this.frameRT, this.godRT, this.postRT, this.captureRT, ...this.bloomRTs])
      t?.dispose();
    for (const t of [this.bayerTex, this.lutTex, this.palSrgbTex, this.palLinTex]) t?.dispose();
    disposeSharedGeometry();
    this.three.dispose();
    this.three.forceContextLoss();
  }
}
