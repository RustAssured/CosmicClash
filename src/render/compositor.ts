import {
  AddEquation,
  CustomBlending,
  DataTexture,
  DoubleSide,
  FloatType,
  NearestFilter,
  RGBAFormat,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  RawShaderMaterial,
  Scene,
  SrcAlphaFactor,
  Vector2,
  Vector4,
  ZeroFactor,
  GLSL3,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { LOGICAL_H, LOGICAL_W, type RenderLayer, type RenderPart, type ViewRect } from '@/contracts';
import { compileScene, unitQuad } from './gl';
import { makePlacement, placeLayer, type LayerPlacement } from './layerMap';
import type { LayerTextures } from './layerTextures';
import { LAYER_FRAG, LAYER_VERT, PART_FRAG } from './shaders';
import { ROT_LUT, rotBoundsEx } from './rotsprite';
import { TITAN_SKY, URI_CEILING_EXEMPT, isTitanLayer, type RenderLayerLit } from './unified';
import { sourceRamp } from './master';
import { UriLivePass } from './uriLivePass';
import { MouthPass, type RenderLayerMouth } from './mouthPass';
import type { MouthDrawList } from './mouthList';
import { URI_FIST_SPREAD_REST, uriIdleJigs, type UriIdleFx } from './uriLive';
import { SIGNATURE, type RenderLayerSig } from './signature';
import { SignaturePass } from './signaturePass';

/** 우리's ramps for the part pass's shade mode, as linear-in-sRGB 0..1 triples (vec3 arrays). */
const URI_SHADE_RAMPS = (() => {
  const tab = (name: string): Float32Array => {
    const c = sourceRamp(name);
    const a = new Float32Array(c.length * 3);
    c.forEach((h, i) => {
      const v = parseInt(h.slice(1), 16);
      a[i * 3] = ((v >> 16) & 255) / 255;
      a[i * 3 + 1] = ((v >> 8) & 255) / 255;
      a[i * 3 + 2] = (v & 255) / 255;
    });
    return a;
  };
  return { s1: tab('uri.s1'), s2: tab('uri.s2'), civ: tab('uri.civ'), field: tab('uri.field') };
})();

/** Maximum number of 2D layers composited per frame (extra layers are dropped with one warning). */
export const MAX_LAYERS = 48;
/** Maximum number of rig parts (RenderLayer.parts) drawn per frame, over all layers. */
export const MAX_PARTS = 96;

interface PartSlot {
  mesh: Mesh;
  material: RawShaderMaterial;
  rect: Vector4;
}

interface Slot {
  mesh: Mesh;
  material: RawShaderMaterial;
  rect: Vector4;
  size: Vector2;
  place: Vector4;
  fl: Vector2;
}

/**
 * Draws every `RenderLayer` (sorted by z) into the colour + emissive attachments of the layer target, with nearest
 * filtering at integer positions, mirror / row-shear done in the fragment shader (see `layerMap.ts`).
 */
export class LayerCompositor {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly slots: Slot[] = [];
  private readonly partSlots: PartSlot[] = [];
  private readonly partOrder: RenderPart[] = [];
  private readonly sorted: RenderLayer[] = [];
  private readonly place: LayerPlacement = makePlacement();
  private warned = false;
  private warnedParts = false;
  /** Rig parts drawn last frame. */
  drawnParts = 0;
  /** Layers drawn last frame (for stats/tests). */
  drawn = 0;
  /** The unified look is drawing (set by the renderer each frame). */
  unified = false;
  /** Quality tier (set by the renderer each frame): the signature pass's cheaper fallback at 0. */
  tier = 1;
  /** Body layers drawn through their signature animation (signature.ts) last frame. */
  sigDrawn = 0;
  private readonly sig: SignaturePass;
  /** 우리's fist chunk tables (centroids, bounds), per layer and part, rebuilt when the layer's version changes. */
  private readonly fistTabs = new Map<
    string,
    { version: number; tex: DataTexture; n: number; maxOff: number; data: Float32Array }
  >();
  /** 우리's living idle: this frame's jigging chunks ([part, u, phase, 0] × n, uriLive.ts uriIdleJigs) and the uniforms' scratch. */
  private readonly jigs = new Float32Array(6 * 4);

  private fistTable(
    layer: RenderLayerLit,
    part: RenderPart,
  ): { tex: DataTexture; n: number; maxOff: number; data: Float32Array } {
    const key = `${layer.id}:${part.z}`;
    let e = this.fistTabs.get(key);
    if (e && e.version === layer.version) return e;
    const ch = layer.chunk!;
    const sums = new Map<number, number[]>();
    for (let y = 0; y < part.sh; y++)
      for (let x = 0; x < part.sw; x++) {
        const o = (part.sy + y) * layer.w + part.sx + x;
        if (layer.pixels[o]! >>> 24 === 0) continue;
        const id = ch[o]!;
        let s = sums.get(id);
        if (!s) sums.set(id, (s = [0, 0, 0, x, y, x + 1, y + 1]));
        s[0]! += x;
        s[1]! += y;
        s[2]!++;
        s[3] = Math.min(s[3]!, x);
        s[4] = Math.min(s[4]!, y);
        s[5] = Math.max(s[5]!, x + 1);
        s[6] = Math.max(s[6]!, y + 1);
      }
    // the oracle draws chunks in id order (later ones on top); up to 256 (the chamber has 233: the living idle loosens it)
    const ids = [...sums.keys()].sort((a, b) => a - b).slice(0, 256);
    const data = new Float32Array(512 * 4);
    let maxOff = 0;
    ids.forEach((id, c) => {
      const s = sums.get(id)!;
      const cx = s[0]! / s[2]!;
      const cy = s[1]! / s[2]!;
      data.set([cx, cy, id, 0, s[3]!, s[4]!, s[5]!, s[6]!], c * 8);
      maxOff = Math.max(maxOff, Math.hypot(cx - part.px, cy - part.py));
    });
    if (!e) {
      const tex = new DataTexture(data, 512, 1, RGBAFormat, FloatType);
      tex.minFilter = NearestFilter;
      tex.magFilter = NearestFilter;
      tex.generateMipmaps = false;
      e = { version: layer.version, tex, n: ids.length, maxOff, data };
      this.fistTabs.set(key, e);
    } else {
      (e.tex.image.data as Float32Array).set(data);
      e.version = layer.version;
      e.n = ids.length;
      e.maxOff = maxOff;
    }
    e.tex.needsUpdate = true;
    return e;
  }

  /**
   * 우리's living idle on one part (shaders.ts PART_FRAG uIdle…, uChunkIdle, uJig): the clocks for the cities and the slit,
   * and on the chunk path the Refusal's push, jitter and flash and this part's jigging chunks (mapped from their hash onto
   * the part's live chunks, pushed 1 whole px along centroid − pivot).
   */
  private idleUniforms(
    u: Record<string, { value: unknown }>,
    idle: UriIdleFx | undefined,
    chunks: boolean,
    tab: { n: number; data: Float32Array } | null,
    part: RenderPart,
    nJig: number,
    view: ViewRect,
  ): void {
    const on = !!idle?.on;
    const S = idle?.scale ?? 1;
    (u.uIdle!.value as Vector4).set(on ? 1 : 0, idle?.t ?? 0, idle?.refT ?? -1, idle?.loose ?? 0);
    (u.uIdleB!.value as Vector4).set(
      (idle?.bx ?? 0) - view.x0,
      (idle?.by ?? 0) - view.y0,
      (idle?.ox ?? 0) - view.x0,
      (idle?.oy ?? 0) - view.y0,
    );
    u.uIdleSC!.value = S;
    u.uPartIdx!.value = part.z;
    const ci = u.uChunkIdle!.value as Vector4;
    const J = u.uJig!.value as Vector4[];
    for (const v of J) v.set(-1, 0, 0, 0);
    if (!on || !chunks || !tab) {
      ci.set(0, 0, 0, 0);
      return;
    }
    const L = idle!.loose;
    ci.set(L * S, L > 0.95 ? 1 : 0, Math.floor(idle!.t * 18), idle!.flash);
    let k = 0;
    for (let j = 0; j < nJig && k < 4; j++) {
      if (this.jigs[j * 4] !== part.z || tab.n <= 0) continue;
      const c = Math.min(tab.n - 1, Math.floor(this.jigs[j * 4 + 1]! * tab.n));
      const dx = tab.data[c * 8]! - part.px;
      const dy = tab.data[c * 8 + 1]! - part.py;
      const dl = Math.hypot(dx, dy) || 1;
      J[k++]!.set(c, Math.round(dx / dl), Math.round(dy / dl), this.jigs[j * 4 + 2]!);
    }
  }

  /** 우리's live pass (created on first use) and whether it drew this frame. */
  private live: UriLivePass | null = null;
  liveUsed = false;
  /** The Mouth's GPU passes (one per draw list: a mirror match has two), and whether one drew this frame. */
  private readonly mouths = new Map<MouthDrawList, MouthPass>();
  mouthUsed = false;
  /** The Mouth pass of a draw list (perf tools read its stats). */
  mouthPassOf(list: MouthDrawList): MouthPass | undefined {
    return this.mouths.get(list);
  }
  /** Additive glow below this contribution is dropped (LAYER_FRAG uGlowFloor). */
  readonly glowFloor = { value: 0.05 };
  private readonly res = new Vector2(LOGICAL_W, LOGICAL_H);

  constructor(
    private readonly textures: LayerTextures,
    private readonly emisGain: { value: number },
  ) {
    for (let i = 0; i < MAX_LAYERS; i++) this.slots.push(this.makeSlot(i));
    for (let i = 0; i < MAX_PARTS; i++) this.partSlots.push(this.makePartSlot());
    this.sig = new SignaturePass(this.scene, this.res, this.emisGain, (m) => setLayerBlend(m, 'normal'));
  }

  private makePartSlot(): PartSlot {
    const rect = new Vector4();
    const material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: LAYER_VERT,
      fragmentShader: PART_FRAG,
      uniforms: {
        uRes: { value: this.res },
        uRect: { value: rect },
        uPart: { value: null },
        uEmis: { value: null },
        uHasEmis: { value: 0 },
        // two-element arrays, written in place every frame (no per-part garbage: S21)
        uPartOrigin: { value: [0, 0] },
        uPartSize: { value: [0, 0] },
        uPivot: { value: [0, 0] },
        uRotCS: { value: [0, 0] },
        uFacing: { value: 1 },
        uRotMode: { value: 0 },
        uDest: { value: [0, 0] },
        uAlpha: { value: 1 },
        uEmisGain: this.emisGain,
        uId: { value: new Vector4() },
        uWet: { value: null },
        uHasWet: { value: 0 },
        uLight: { value: null },
        uHasLight: { value: 0 },
        uSkyDir: { value: TITAN_SKY.dir },
        uShade: { value: null },
        uHasShade: { value: 0 },
        uS1: { value: URI_SHADE_RAMPS.s1 },
        uS2: { value: URI_SHADE_RAMPS.s2 },
        uCiv: { value: URI_SHADE_RAMPS.civ },
        uField: { value: URI_SHADE_RAMPS.field },
        uBind: { value: 0 },
        uFist: { value: 0 },
        uChunkId: { value: null },
        uChunkTab: { value: null },
        uNChunk: { value: 0 },
        uSpreadK: { value: 0 },
        uIdle: { value: new Vector4() },
        uIdleB: { value: new Vector4() },
        uIdleSC: { value: 1 },
        uChunkIdle: { value: new Vector4() },
        uPartIdx: { value: 0 },
        uJig: { value: Array.from({ length: 4 }, () => new Vector4(-1, 0, 0, 0)) },
      },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      side: DoubleSide,
    });
    setLayerBlend(material, 'normal');
    const mesh = new Mesh(unitQuad(), material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.scene.add(mesh);
    return { mesh, material, rect };
  }

  private makeSlot(i: number): Slot {
    const rect = new Vector4();
    const size = new Vector2();
    const place = new Vector4();
    const fl = new Vector2(1, 0);
    const material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: LAYER_VERT,
      fragmentShader: LAYER_FRAG,
      uniforms: {
        uRes: { value: this.res },
        uRect: { value: rect },
        uTex: { value: null },
        uEmis: { value: null },
        uHasEmis: { value: 0 },
        uSize: { value: size },
        uPlace: { value: place },
        uFL: { value: fl },
        uScreen: { value: 0 },
        uAlpha: { value: 1 },
        uEmisGain: this.emisGain,
        uGlowFloor: this.glowFloor,
        uId: { value: new Vector4() },
        uWet: { value: null },
        uHasWet: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      side: DoubleSide,
    });
    setLayerBlend(material, 'normal');
    const mesh = new Mesh(unitQuad(), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = i;
    mesh.visible = false;
    this.scene.add(mesh);
    return { mesh, material, rect, size, place, fl };
  }

  /** Stable insertion sort by z into a reused array (zero allocation; layer counts are small). */
  private sortLayers(layers: readonly RenderLayer[]): number {
    const s = this.sorted;
    let n = 0;
    for (const l of layers) {
      if (!l.visible || l.alpha <= 0 || l.w <= 0 || l.h <= 0) continue;
      if (n >= MAX_LAYERS) {
        if (!this.warned) {
          console.warn(`renderer: more than ${MAX_LAYERS} layers in a frame; extra layers dropped`);
          this.warned = true;
        }
        break;
      }
      let j = n;
      while (j > 0 && s[j - 1]!.z > l.z) {
        s[j] = s[j - 1]!;
        j--;
      }
      s[j] = l;
      n++;
    }
    s.length = n;
    return n;
  }

  draw(
    renderer: WebGLRenderer,
    target: WebGLRenderTarget,
    layers: readonly RenderLayer[],
    view: ViewRect,
    alpha: number,
  ): number {
    const n = this.sortLayers(layers);
    let used = 0;
    let usedParts = 0;
    let usedSig = 0;
    let order = 0;
    this.sig.hide();
    for (let i = 0; i < MAX_LAYERS; i++) this.slots[i]!.mesh.visible = false;
    for (let i = 0; i < MAX_PARTS; i++) this.partSlots[i]!.mesh.visible = false;
    this.live?.hide();
    this.liveUsed = false;
    for (const mp of this.mouths.values()) mp.hide();
    this.mouthUsed = false;
    for (let i = 0; i < n; i++) {
      const layer = this.sorted[i]!;
      // the Mouth (D37): its own GPU pass renders the draw list once, then a compose quad per half (back / front)
      const mfx = (layer as RenderLayerMouth).mouth;
      if (mfx) {
        let mp = this.mouths.get(mfx.list);
        if (!mp) this.mouths.set(mfx.list, (mp = new MouthPass(this.scene, this.emisGain)));
        mp.render(renderer, mfx.list, view);
        mp.stage(mfx.back, ++order, !this.unified);
        this.mouthUsed = true;
        continue;
      }
      // a rig (or 우리's live elements alone, once every part has broken away)
      if (
        layer.space === 'world' &&
        ((layer.parts && layer.parts.length > 0) || (layer as RenderLayerLit).uriLive)
      ) {
        // a rig: the layer is an atlas, each part drawn rotated (and mirrored by `facing`) about its pivot, in part-z order
        const gpu = this.textures.acquire(layer);
        const ps = this.partOrder;
        ps.length = 0;
        for (const part of layer.parts ?? []) {
          let j = ps.length;
          while (j > 0 && ps[j - 1]!.z > part.z) {
            ps[j] = ps[j - 1]!;
            j--;
          }
          ps[j] = part;
        }
        // 우리's live elements (cores, loop, orbit) go right after its chamber part: before the first part in front of it
        const live = (layer as RenderLayerLit).uriLive;
        // 우리's living idle (both its atlas layers carry it): this frame's jigging chunks
        const idle = (layer as RenderLayerLit).uriIdle;
        const idleOn = !!idle?.on && !!gpu.chunk;
        const nJig = idleOn ? uriIdleJigs(idle!, this.jigs, 6) : 0;
        let liveDone = !live;
        const stageLive = (): void => {
          liveDone = true;
          this.live ??= new UriLivePass(this.scene, this.res);
          order = this.live.stage(live!, view.x0, view.y0, order, order);
          this.liveUsed = true;
        };
        for (const part of ps) {
          if (!liveDone && part.z > live!.afterZ) stageLive();
          if (usedParts >= MAX_PARTS) {
            if (!this.warnedParts) {
              console.warn(`renderer: more than ${MAX_PARTS} rig parts in a frame; extra parts dropped`);
              this.warnedParts = true;
            }
            break;
          }
          const qx = part.wx - view.x0;
          const qy = part.wy - view.y0;
          const b = rotBoundsEx({
            pixels: layer.pixels,
            w: part.sw,
            h: part.sh,
            px: part.px,
            py: part.py,
            step: part.step,
            facing: layer.facing,
          });
          // 우리's fists: drawn chunk by chunk, spread out from the pivot (uriLive.ts fistSpread)
          const fist = live && gpu.chunk && live.fistZ ? live.fistZ.indexOf(part.z) : -1;
          const spread = fist >= 0 ? (live!.fistSpread?.[fist] ?? URI_FIST_SPREAD_REST) : 1;
          // …and, with the living idle, any part whose chunks have somewhere to be: the Refusal loosening or flashing it,
          // or one of its chunks jigging (the prototype's drawChunked: every other part stays on the plain sampler)
          let jigHere = false;
          for (let j = 0; j < nJig; j++) if (this.jigs[j * 4] === part.z) jigHere = true;
          const idleChunks = idleOn && (idle!.loose > 0 || idle!.flash > 0 || jigHere);
          const tab = fist >= 0 || idleChunks ? this.fistTable(layer as RenderLayerLit, part) : null;
          const S = idle?.scale ?? 1;
          const m = tab
            ? Math.ceil(tab.maxOff * Math.abs(spread - 1) * 1.9) +
              2 +
              (idleChunks ? Math.ceil(idle!.loose * 5.3 * S) + 1 : 0)
            : 0;
          const x0 = Math.max(0, qx + b.x0 - m);
          const y0 = Math.max(0, qy + b.y0 - m);
          const x1 = Math.min(LOGICAL_W, qx + b.x1 + m);
          const y1 = Math.min(LOGICAL_H, qy + b.y1 + m);
          if (x1 <= x0 || y1 <= y0) continue;
          const s = this.partSlots[usedParts++]!;
          s.mesh.visible = true;
          s.mesh.renderOrder = ++order;
          s.rect.set(x0, y0, x1, y1);
          const u = s.material.uniforms;
          u.uPart!.value = gpu.tex;
          u.uEmis!.value = gpu.emis;
          u.uHasEmis!.value = gpu.emis ? 1 : 0;
          set2(u.uPartOrigin!.value as number[], part.sx, part.sy);
          set2(u.uPartSize!.value as number[], part.sw, part.sh);
          set2(u.uPivot!.value as number[], part.px, part.py);
          const st = ((part.step % ROT_LUT.cos.length) + ROT_LUT.cos.length) % ROT_LUT.cos.length;
          set2(u.uRotCS!.value as number[], ROT_LUT.cos[st]!, ROT_LUT.sin[st]!);
          u.uFacing!.value = layer.facing === -1 ? -1 : 1;
          u.uRotMode!.value = part.sampler === 'majority4' ? 1 : 0; // proposal 174
          set2(u.uDest!.value as number[], qx, qy);
          u.uAlpha!.value = layer.alpha;
          setId(u, layer, order, gpu, this.unified);
          u.uLight!.value = gpu.light;
          u.uHasLight!.value = gpu.light ? 1 : 0;
          u.uShade!.value = gpu.shade;
          u.uHasShade!.value = gpu.shade && gpu.light ? 1 : 0;
          // 우리's fist pieces: compression light (proposal 172 §2; the oracle's drawFist bind = min(1, (0.9 − spread)·6))
          u.uBind!.value = spread < 0.9 ? Math.min(1, (0.9 - spread) * 6) : 0;
          u.uFist!.value = tab ? 1 : 0;
          u.uChunkId!.value = tab ? gpu.chunk : null;
          u.uChunkTab!.value = tab ? tab.tex : null;
          u.uNChunk!.value = tab ? tab.n : 0;
          u.uSpreadK!.value = spread - 1;
          this.idleUniforms(u, idle, idleChunks, tab, part, nJig, view);
          setLayerBlend(s.material, layer.blend);
        }
        if (!liveDone) stageLive();
        if (live?.pylons) {
          this.live ??= new UriLivePass(this.scene, this.res);
          order = this.live.stagePlumes(live, view.x0, view.y0, order, order);
          this.liveUsed = true;
        }
        if (live?.idle?.on) {
          this.live ??= new UriLivePass(this.scene, this.res);
          order = this.live.stageSpecks(live, view.x0, view.y0, order);
          this.liveUsed = true;
        }
        continue;
      }
      const p = this.place;
      placeLayer(layer, view, alpha, p);
      // Off-screen world layers cost nothing: skip if the destination rect misses the frame entirely.
      if (p.x1 <= 0 || p.y1 <= 0 || p.x0 >= LOGICAL_W || p.y0 >= LOGICAL_H) {
        this.textures.acquire(layer); // still keep its texture current so re-entry is instant
        continue;
      }
      const gpu = this.textures.acquire(layer);
      // a body with a signature animation is drawn through the signature pass (same placement, warped sampling)
      const sfx = SIGNATURE.on && !p.screen ? (layer as RenderLayerSig).signature : undefined;
      const sigSlot = sfx && usedSig < SignaturePass.MAX ? this.sig.slots[usedSig++]! : null;
      if (sigSlot) this.sig.apply(sigSlot, layer.id, sfx!, layer.w, layer.h, this.tier);
      const slot = sigSlot ?? this.slots[used++]!;
      slot.mesh.visible = true;
      slot.mesh.renderOrder = ++order;
      const u = slot.material.uniforms;
      // Clip the quad to the frame (the shader still maps by absolute pixel, so clipping is invisible).
      slot.rect.set(
        Math.max(0, p.x0),
        Math.max(0, p.y0),
        Math.min(LOGICAL_W, p.x1),
        Math.min(LOGICAL_H, p.y1),
      );
      slot.size.set(layer.w, layer.h);
      slot.place.set(p.ax, p.ay, p.anchorX, p.anchorY);
      slot.fl.set(p.facing, p.lean);
      u.uTex!.value = gpu.tex;
      u.uEmis!.value = gpu.emis;
      u.uHasEmis!.value = gpu.emis ? 1 : 0;
      if (u.uScreen) u.uScreen.value = p.screen ? 1 : 0;
      u.uAlpha!.value = layer.alpha;
      setId(u, layer, order, gpu, this.unified);
      setLayerBlend(slot.material, layer.blend);
    }
    this.sigDrawn = usedSig;
    used += usedSig;
    this.drawn = used + usedParts + (this.liveUsed ? 1 : 0);
    this.drawnParts = usedParts;
    // The target is a dedicated layer target: it starts each frame transparent, so what it holds afterwards is exactly
    // the premultiplied "over" chain of this frame's layers (colour + alpha, and emissive + alpha).
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    if (used + usedParts > 0 || this.liveUsed || this.mouthUsed) renderer.render(this.scene, this.camera);
    return used + usedParts;
  }

  /** Compile the layer and part programs (all slots share them) before the first frame. */
  compile(renderer: WebGLRenderer): Promise<void> {
    for (const s of this.slots) s.mesh.visible = false;
    for (const s of this.partSlots) s.mesh.visible = false;
    this.slots[0]!.mesh.visible = true;
    this.partSlots[0]!.mesh.visible = true;
    this.sig.slots[0]!.mesh.visible = true;
    return compileScene(renderer, this.scene, this.camera).then(() => {
      this.slots[0]!.mesh.visible = false;
      this.partSlots[0]!.mesh.visible = false;
      this.sig.slots[0]!.mesh.visible = false;
    });
  }

  dispose(): void {
    this.sig.dispose();
    for (const s of this.slots) s.material.dispose();
    for (const s of this.partSlots) s.material.dispose();
    this.live?.dispose();
    for (const mp of this.mouths.values()) mp.dispose();
    this.mouths.clear();
    for (const e of this.fistTabs.values()) e.tex.dispose();
    this.fistTabs.clear();
  }
}

/**
 * The unified path's id attachment: titan flag (isTitanLayer), the draw rank (depth seams: a higher rank is in front) and the wet
 * mask. Additive layers write nothing there.
 */
function setId(
  u: Record<string, { value: unknown }>,
  layer: RenderLayer,
  order: number,
  gpu: { wet: unknown },
  unified: boolean,
): void {
  const titan = layer.blend !== 'add' && isTitanLayer(layer);
  // 우리-style layers (with the shade plane) also cast shadows on their own parts behind (0.75 marks them)
  const shadeCls = titan && (layer as RenderLayerLit).shade ? 0.75 : 1;
  // unified path: an additive glow layer (a halo, an atmosphere) IS light: all of it feeds the shared bloom
  const glow = unified && layer.blend === 'add' ? 1 : 0;
  // 우리 under the ceiling switch counts as 'wet' (may take the top step)
  const exempt = shadeCls < 1 && URI_CEILING_EXEMPT ? 1 : 0;
  (u.uId!.value as Vector4).set(titan ? shadeCls : 0, Math.min(255, order) / 255, exempt, glow);
  u.uWet!.value = gpu.wet;
  u.uHasWet!.value = gpu.wet && titan ? 1 : 0;
}

function set2(a: number[], x: number, y: number): void {
  a[0] = x;
  a[1] = y;
}

function setLayerBlend(m: RawShaderMaterial, blend: 'normal' | 'add'): void {
  m.blending = CustomBlending;
  m.blendEquation = AddEquation;
  if (blend === 'add') {
    m.blendSrc = SrcAlphaFactor;
    m.blendDst = OneFactor;
    // additive glows must not become occluders for god rays
    m.blendSrcAlpha = ZeroFactor;
    m.blendDstAlpha = OneFactor;
  } else {
    m.blendSrc = SrcAlphaFactor;
    m.blendDst = OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = OneFactor;
    m.blendDstAlpha = OneMinusSrcAlphaFactor;
  }
}
