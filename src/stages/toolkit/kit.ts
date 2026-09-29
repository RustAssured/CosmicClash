import {
  AddEquation,
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  CustomBlending,
  DataTexture,
  DoubleSide,
  DstColorFactor,
  GLSL3,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  RawShaderMaterial,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  SrcAlphaFactor,
  UnsignedByteType,
  Vector2,
  ZeroFactor,
  type IUniform,
  type Texture,
  type WebGLRenderTarget,
} from 'three';
import { MAX_IMPULSES, MAX_SHOCKS, type SceneryFrame, type SceneryInit } from '../types';
import { FORCES_GLSL, NOISE_GLSL, SCENERY_HEAD } from './glsl';
import { noiseTextureData } from './noise';

/**
 * The shared scaffolding every stage's scenery is built from: one Scene of parallax layers drawn back-to-front into an
 * HDR target, sharing one set of uniforms (view origin, clocks, fight forces). A stage is then CONTENT: it generates
 * particle buffers and fragment shaders and hands them to `addSprites`, `addFullscreen`, `addQuad`.
 *
 * Parallax model: a layer with parallax `p` places content at layer coordinates (x, y); on screen it appears at
 * (x, y) − view.origin × p, where view.origin is the same INTEGER origin the 2D layers use. p = 0 is fixed to the
 * screen, p = 1 moves with the fighters, p > 1 slides past faster than the fight plane.
 */

export type LayerBlend = 'add' | 'normal' | 'multiply';

/** Blend state that never writes alpha for additive layers (alpha carries occluder opacity for god rays). */
function applyBlend(m: RawShaderMaterial, blend: LayerBlend): void {
  m.transparent = true;
  if (blend === 'add') {
    m.blending = CustomBlending;
    m.blendEquation = AddEquation;
    m.blendSrc = SrcAlphaFactor;
    m.blendDst = OneFactor;
    m.blendSrcAlpha = ZeroFactor;
    m.blendDstAlpha = OneFactor;
  } else if (blend === 'multiply') {
    m.blending = CustomBlending;
    m.blendEquation = AddEquation;
    m.blendSrc = DstColorFactor;
    m.blendDst = ZeroFactor;
    m.blendSrcAlpha = ZeroFactor;
    m.blendDstAlpha = OneFactor;
  } else {
    m.blending = CustomBlending;
    m.blendEquation = AddEquation;
    m.blendSrc = SrcAlphaFactor;
    m.blendDst = OneMinusSrcAlphaFactor;
    // occluder opacity accumulates like coverage: a + a_dst(1 - a)
    m.blendSrcAlpha = OneFactor;
    m.blendDstAlpha = OneMinusSrcAlphaFactor;
  }
}
void AdditiveBlending;
void NormalBlending;

export interface KitUniforms {
  [k: string]: IUniform;
  uView: IUniform<Vector2>;
  uRes: IUniform<Vector2>;
  uTime: IUniform<number>;
  uFlow: IUniform<number>;
  uIntensity: IUniform<number>;
  uShock: IUniform<Float32Array>;
  uNShock: IUniform<number>;
  uImp: IUniform<Float32Array>;
  uImp2: IUniform<Float32Array>;
  uNImp: IUniform<number>;
  uNoise: IUniform<Texture>;
}

const SPRITE_VERT = /* glsl */ `${SCENERY_HEAD}${NOISE_GLSL}${FORCES_GLSL}
in vec3 position;
in vec4 aPos;     // x, y (layer coords), z parallax jitter, w seed 0..1
in vec4 aShape;   // half width, half height, rotation, -
in vec4 aColor;   // HDR linear rgb, alpha
uniform float uParallax;
uniform float uSpread;
uniform float uDrift;
uniform float uDriftFreq;
uniform float uDriftSpeed;
uniform float uTwinkle;
uniform float uForceK;
uniform float uSnap;
out vec2 vQ;
out vec4 vColor;
out float vSeed;
void main() {
  float par = uParallax + aPos.z * uSpread;
  vec2 c = aPos.xy - uView * par;
  if (uDrift > 0.0) c += curl2(aPos.xy * uDriftFreq + uFlow * uDriftSpeed * vec2(0.7, 0.4)) * uDrift;
  c = warpByForces(c, uForceK);
  if (uSnap > 0.5) c = floor(c) + 0.5;
  float ext = max(aShape.x, aShape.y) * 1.5 + 4.0;
  if (c.x < -ext || c.y < -ext || c.x > uRes.x + ext || c.y > uRes.y + ext) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vQ = vec2(0.0); vColor = vec4(0.0); vSeed = 0.0;
    return;
  }
  float cs = cos(aShape.z);
  float sn = sin(aShape.z);
  vec2 q = position.xy;
  vec2 off = vec2(q.x * aShape.x * cs - q.y * aShape.y * sn, q.x * aShape.x * sn + q.y * aShape.y * cs);
  vec2 p = c + off;
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
  vQ = q;
  float tw = 1.0 + uTwinkle * sin(uTime * (1.2 + aPos.w * 2.6) + aPos.w * 90.0);
  vColor = vec4(aColor.rgb * tw, aColor.a);
  vSeed = aPos.w;
}
`;

const SPRITE_FRAG = /* glsl */ `${SCENERY_HEAD}${NOISE_GLSL}
uniform float uSoft;
uniform float uBreakup;
uniform float uGain;
in vec2 vQ;
in vec4 vColor;
in float vSeed;
out vec4 o;
void main() {
  float r2 = dot(vQ, vQ);
  if (r2 >= 1.0) discard;
  float a = exp(-r2 * uSoft) * (1.0 - r2);
  if (uBreakup > 0.0) {
    float n = vnoise(vQ * 1.7 + vSeed * 91.0);
    a *= mix(1.0, smoothstep(0.2, 0.8, n) * 1.6, uBreakup);
  }
  o = vec4(vColor.rgb * uGain, vColor.a * a);
}
`;

const FULL_VERT = /* glsl */ `${SCENERY_HEAD}
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const QUAD_VERT = /* glsl */ `${SCENERY_HEAD}
in vec3 position;   // 0..1 unit quad
uniform vec4 uRect;       // layer-space x, y, w, h
uniform float uParallax;
uniform vec2 uView;
uniform vec2 uRes;
uniform float uPad;       // extra px around the rect so force displacement never reveals the edge
out vec2 vScreen;
void main() {
  vec2 s = uRect.xy - uView * uParallax + (position.xy * 2.0 - 1.0) * uPad + position.xy * uRect.zw;
  vScreen = s;
  gl_Position = vec4(s.x / uRes.x * 2.0 - 1.0, 1.0 - s.y / uRes.y * 2.0, 0.0, 1.0);
}
`;

/* ------------------------------------------------------------------------------------------------ */

export interface SpriteBuffer {
  /** Number of sprites. */
  count: number;
  /** x, y, parallax jitter, seed per sprite. */
  pos: Float32Array;
  /** half width, half height, rotation, unused. */
  shape: Float32Array;
  /** linear HDR r, g, b, alpha. */
  color: Float32Array;
}

/** Growable builder for `SpriteBuffer`. */
export class SpriteBuilder {
  private pos: number[] = [];
  private shape: number[] = [];
  private color: number[] = [];

  get count(): number {
    return this.pos.length / 4;
  }

  push(
    x: number,
    y: number,
    jitter: number,
    seed: number,
    hw: number,
    hh: number,
    rot: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    this.pos.push(x, y, jitter, seed);
    this.shape.push(hw, hh, rot, 0);
    this.color.push(r, g, b, a);
  }

  build(): SpriteBuffer {
    return {
      count: this.pos.length / 4,
      pos: new Float32Array(this.pos),
      shape: new Float32Array(this.shape),
      color: new Float32Array(this.color),
    };
  }
}

export interface SpriteSpec {
  buffer: SpriteBuffer;
  parallax: number;
  /** Per-sprite parallax jitter range (multiplied by the sprite's jitter attribute, ±1). */
  spread?: number;
  blend: LayerBlend;
  /** Curl-noise drift amplitude in px, spatial frequency (per layer px) and speed. */
  drift?: number;
  driftFreq?: number;
  driftSpeed?: number;
  /** Gaussian exponent (bigger = tighter core) and internal noise breakup 0..1. */
  soft?: number;
  breakup?: number;
  twinkle?: number;
  /** Snap sprite centres to pixel centres (crisp stars). */
  snap?: boolean;
  /** How strongly shockwaves / impulses move this layer (near layers react more). */
  forceK?: number;
  gain?: number;
}

export interface KitLayer {
  readonly name: string;
  readonly mesh: Mesh;
  /** Uniform bag of this layer's material (for per-frame tweaks by the stage). */
  readonly uniforms: Record<string, IUniform>;
  dispose(): void;
}

let spriteQuad: BufferGeometry | null = null;
function spriteQuadGeometry(): BufferGeometry {
  if (!spriteQuad) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    spriteQuad = g;
  }
  return spriteQuad;
}

export class SceneryKit {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly uniforms: KitUniforms;
  readonly quality: 0 | 1 | 2;
  readonly layers: KitLayer[] = [];
  private readonly noiseTex: DataTexture;
  private order = 0;
  private flow = 0;
  private flowSeeded = false;
  private swirlEnergy = 0;

  constructor(init: SceneryInit, noiseSeed = 0x5eed) {
    this.quality = init.quality;
    this.noiseTex = new DataTexture(noiseTextureData(noiseSeed), 256, 256, RGBAFormat, UnsignedByteType);
    this.noiseTex.wrapS = RepeatWrapping;
    this.noiseTex.wrapT = RepeatWrapping;
    this.noiseTex.minFilter = LinearFilter;
    this.noiseTex.magFilter = LinearFilter;
    this.noiseTex.generateMipmaps = false;
    this.noiseTex.needsUpdate = true;
    this.uniforms = {
      uView: { value: new Vector2(0, 0) },
      uRes: { value: new Vector2(640, 360) },
      uTime: { value: 0 },
      uFlow: { value: 0 },
      uIntensity: { value: 0 },
      uShock: { value: new Float32Array(MAX_SHOCKS * 4) },
      uNShock: { value: 0 },
      uImp: { value: new Float32Array(MAX_IMPULSES * 4) },
      uImp2: { value: new Float32Array(MAX_IMPULSES * 4) },
      uNImp: { value: 0 },
      uNoise: { value: this.noiseTex },
    };
  }

  private nextOrder(): number {
    return this.order++;
  }

  /** Uniforms every kit shader reads, by reference: one update reaches every layer. */
  private shared(extra: Record<string, IUniform>): Record<string, IUniform> {
    return { ...this.uniforms, ...extra };
  }

  /** A cloud of instanced soft sprites (nebula puffs, stars, dust, bokeh). */
  addSprites(name: string, spec: SpriteSpec): KitLayer {
    const b = spec.buffer;
    const geo = new InstancedBufferGeometry();
    const q = spriteQuadGeometry();
    geo.setAttribute('position', q.getAttribute('position'));
    geo.setIndex(q.getIndex());
    geo.setAttribute('aPos', new InstancedBufferAttribute(b.pos, 4));
    geo.setAttribute('aShape', new InstancedBufferAttribute(b.shape, 4));
    geo.setAttribute('aColor', new InstancedBufferAttribute(b.color, 4));
    geo.instanceCount = b.count;
    const uniforms = this.shared({
      uParallax: { value: spec.parallax },
      uSpread: { value: spec.spread ?? 0 },
      uDrift: { value: spec.drift ?? 0 },
      uDriftFreq: { value: spec.driftFreq ?? 0.01 },
      uDriftSpeed: { value: spec.driftSpeed ?? 0.05 },
      uTwinkle: { value: spec.twinkle ?? 0 },
      uForceK: { value: spec.forceK ?? 1 },
      uSnap: { value: spec.snap ? 1 : 0 },
      uSoft: { value: spec.soft ?? 2.5 },
      uBreakup: { value: spec.breakup ?? 0 },
      uGain: { value: spec.gain ?? 1 },
    });
    const mat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: SPRITE_VERT,
      fragmentShader: SPRITE_FRAG,
      uniforms,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    applyBlend(mat, spec.blend);
    const mesh = new Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = this.nextOrder();
    this.scene.add(mesh);
    const layer: KitLayer = {
      name,
      mesh,
      uniforms,
      dispose: () => {
        geo.dispose();
        mat.dispose();
      },
    };
    this.layers.push(layer);
    return layer;
  }

  /**
   * A full-screen procedural layer. `fragment` is the shader BODY: it may use vUv (0..1, y up), all kit uniforms and the
   * NOISE_GLSL / FORCES_GLSL helpers, plus `uParallax`, and must write `o`.
   */
  addFullscreen(
    name: string,
    fragment: string,
    blend: LayerBlend,
    parallax: number,
    extra: Record<string, IUniform> = {},
  ): KitLayer {
    const uniforms = this.shared({ uParallax: { value: parallax }, ...extra });
    const mat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: FULL_VERT,
      fragmentShader: `${SCENERY_HEAD}${NOISE_GLSL}${FORCES_GLSL}
in vec2 vUv;
out vec4 o;
uniform float uParallax;
vec2 screenPx() { return vec2(vUv.x * uRes.x, (1.0 - vUv.y) * uRes.y); }
${fragment}`,
      uniforms,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    applyBlend(mat, blend);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const mesh = new Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = this.nextOrder();
    this.scene.add(mesh);
    const layer: KitLayer = {
      name,
      mesh,
      uniforms,
      dispose: () => {
        geo.dispose();
        mat.dispose();
      },
    };
    this.layers.push(layer);
    return layer;
  }

  /**
   * A textured rectangle in layer space (e.g. a baked pillar sculpt). `fragment` is a body that reads `vec4 sampleMap(vec2 screenPx)`
   * (already displaced by fight forces) and must write `o`.
   */
  addQuad(
    name: string,
    opts: {
      rect: [number, number, number, number];
      parallax: number;
      blend: LayerBlend;
      map: Texture;
      forceK?: number;
      pad?: number;
      fragment: string;
      extra?: Record<string, IUniform>;
    },
  ): KitLayer {
    const map = opts.map;
    map.wrapS = ClampToEdgeWrapping;
    map.wrapT = ClampToEdgeWrapping;
    const uniforms = this.shared({
      uRect: { value: [...opts.rect] },
      uParallax: { value: opts.parallax },
      uPad: { value: opts.pad ?? 24 },
      uForceK: { value: opts.forceK ?? 1 },
      uMap: { value: map },
      ...(opts.extra ?? {}),
    });
    const frag = `${SCENERY_HEAD}${NOISE_GLSL}${FORCES_GLSL}
in vec2 vScreen;
out vec4 o;
uniform vec4 uRect;
uniform float uParallax;
uniform float uForceK;
uniform sampler2D uMap;
// Sample the baked map at a screen position after undoing the fight displacement. Outside the rect → transparent.
vec4 sampleMap(vec2 sp) {
  vec2 q = warpByForces(sp, -uForceK);
  vec2 lp = q + uView * uParallax - uRect.xy;
  vec2 uv = lp / uRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return texture(uMap, vec2(uv.x, 1.0 - uv.y));
}
${opts.fragment}`;
    const mat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: QUAD_VERT,
      fragmentShader: frag,
      uniforms,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    applyBlend(mat, opts.blend);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 2, 1, 3]);
    const mesh = new Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = this.nextOrder();
    this.scene.add(mesh);
    const layer: KitLayer = {
      name,
      mesh,
      uniforms,
      dispose: () => {
        geo.dispose();
        mat.dispose();
      },
    };
    this.layers.push(layer);
    return layer;
  }

  /** Push the frame's clocks, view and fight forces into the shared uniforms. */
  update(f: SceneryFrame): void {
    const u = this.uniforms;
    u.uView.value.set(f.view.x0, f.view.y0);
    u.uTime.value = f.timeSec;
    // Impulse energy speeds the flow so nebulae visibly swirl after a blast, then settle.
    let energy = 0;
    for (let i = 0; i < f.forces.nImpulse; i++) energy += Math.abs(f.forces.impulse[i * 4 + 3]!);
    this.swirlEnergy += (energy - this.swirlEnergy) * 0.15;
    if (!this.flowSeeded) {
      this.flow = f.timeSec;
      this.flowSeeded = true;
    }
    this.flow += f.dtSec * (1 + 1.6 * f.fx.intensity + 2.5 * Math.min(1, this.swirlEnergy));
    u.uFlow.value = this.flow;
    u.uIntensity.value = f.fx.intensity;
    u.uShock.value.set(f.forces.shock);
    u.uNShock.value = f.forces.nShock;
    u.uImp.value.set(f.forces.impulse);
    u.uImp2.value.set(f.forces.impulse2);
    u.uNImp.value = f.forces.nImpulse;
  }

  render(renderer: SceneryInit['renderer'], target: WebGLRenderTarget): void {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(this.scene, this.camera);
  }

  /** Re-upload CPU-backed textures after a context restore. */
  restore(): void {
    this.noiseTex.needsUpdate = true;
  }

  dispose(): void {
    for (const l of this.layers) l.dispose();
    this.layers.length = 0;
    this.noiseTex.dispose();
    spriteQuad?.dispose();
    spriteQuad = null;
  }
}
