import {
  AddEquation,
  BufferAttribute,
  CustomBlending,
  DoubleSide,
  GLSL3,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  OrthographicCamera,
  RawShaderMaterial,
  Scene,
  SrcAlphaFactor,
  Vector2,
  ZeroFactor,
  type IUniform,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { Rng } from '@/contracts';
import { FORCES_GLSL, SCENERY_HEAD } from '@/stages/toolkit/glsl';

/**
 * The FOREGROUND pass: sparse, large, soft dust motes, wisps and a few small drifting rock silhouettes that slide past IN FRONT of the
 * fighters at 1.5–2.2× the camera's motion. It is what makes the fight read as happening inside a space rather than on a poster.
 * Composited into the frame after the 2D layers and before bloom / post.
 *
 * Kept from ever getting in the way: alpha ≤ 0.35 everywhere, halved across the fight band, faded to a quarter around each body's light
 * (fighters carry lights), and most instances live near the top and bottom edges. Depth of field is faked with two softness classes
 * (big + very soft, small + firmer) and hard-edged rock silhouettes in the smallest class. Motion is a pure function of the clock;
 * shockwaves and impulses (including the 'wake' impulses of fast heavy bodies) shove it about with a gain well above the scenery's.
 */

export interface ForegroundLook {
  /** Linear colour of the dust; rocks are drawn 45 % darker. */
  color: readonly [number, number, number];
  /** Peak alpha multiplier (default 1, capped at 0.35 in the shader). */
  alpha?: number;
  /** Multiplier on the instance count (default 1). */
  density?: number;
}

export const FOREGROUND_MAX = 72;
const TIER_FRACTION = [0, 0.5, 1] as const;

const VERT = /* glsl */ `${SCENERY_HEAD}${FORCES_GLSL}
in vec3 position;
in vec4 aF0;   // x, y (layer px), parallax, seed
in vec4 aF1;   // half size px, alpha, softness, kind (0 mote/wisp, 1 rock)
uniform vec4 uLt[4];
uniform int uNLt;
uniform vec3 uColor;
uniform float uForceK;
uniform vec2 uBand;   // fight band top / bottom (screen px)
uniform float uAlphaK;
out vec2 vQ;
out vec4 vP;          // seed, softness, kind, alpha
void main() {
  float par = aF0.z;
  float ph = aF0.w * 6.2831;
  vec2 drift = vec2(sin(uTime * 0.045 + ph) * 14.0 + cos(uTime * 0.021 + ph * 2.3) * 9.0, cos(uTime * 0.037 + ph * 1.7) * 8.0);
  vec2 c = aF0.xy - floor(uView * par + 0.5) + drift;
  c = warpByForces(c, uForceK);
  float size = aF1.x;
  float ext = size * 1.6 + 4.0;
  if (c.x < -ext || c.y < -ext || c.x > uRes.x + ext || c.y > uRes.y + ext) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vQ = vec2(0.0); vP = vec4(0.0);
    return;
  }
  float a = aF1.y * uAlphaK;
  // across the fight band the foreground is only a whisper
  float inBand = smoothstep(uBand.x - 30.0, uBand.x + 10.0, c.y) * (1.0 - smoothstep(uBand.y - 10.0, uBand.y + 30.0, c.y));
  a *= 1.0 - 0.6 * inBand;
  // and it never sits on a body: the fighters carry lights
  for (int i = 0; i < 4; i++) {
    if (i >= uNLt) break;
    float d = length(c - uLt[i].xy) / max(uLt[i].z, 1.0);
    a *= 0.25 + 0.75 * smoothstep(0.35, 0.9, d);
  }
  float rot = aF0.w * 6.2831 + uTime * 0.01 * (aF0.w - 0.5);
  float cs = cos(rot); float sn = sin(rot);
  vec2 q = position.xy;
  vec2 off = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs) * size * 1.4;
  vec2 p = c + off;
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
  vQ = q * 1.4;
  vP = vec4(aF0.w, aF1.z, aF1.w, min(a, 0.35));
}
`;

const FRAG = /* glsl */ `${SCENERY_HEAD}
uniform vec3 uColor;
in vec2 vQ;
in vec4 vP;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  float r2 = dot(vQ, vQ);
  float a;
  vec3 col = uColor;
  if (vP.z > 0.5) {
    // a small drifting rock: hard, lumpy silhouette, a little darker than the dust, one lit edge
    float ang = atan(vQ.y, vQ.x);
    float rr = 1.0 - 0.3 * sin(ang * 3.0 + vP.x * 40.0) - 0.16 * sin(ang * 5.0 + vP.x * 17.0);
    float d = sqrt(r2) / (rr * 0.75);
    a = 1.0 - smoothstep(0.86, 1.0, d);
    col *= 0.55 + 0.6 * smoothstep(0.2, 1.0, dot(normalize(vQ + 1e-4), vec2(-0.6, -0.8)) * 0.5 + 0.5) * (1.0 - a * 0.0);
  } else {
    if (r2 >= 1.96) discard;
    a = exp(-r2 * vP.y) * (1.0 - r2 / 1.96);
  }
  o0 = vec4(col, vP.w * a);
  o1 = vec4(0.0);
}
`;

export class Foreground {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geo = new InstancedBufferGeometry();
  private readonly mat: RawShaderMaterial;
  private readonly mesh: Mesh;
  readonly uniforms: Record<string, IUniform>;
  private count = FOREGROUND_MAX;
  private enabled = true;

  constructor(
    res: Vector2,
    uniformsShared: {
      view: IUniform<Vector2>;
      time: IUniform<number>;
      flow: IUniform<number>;
      intensity: IUniform<number>;
      shock: IUniform<Float32Array>;
      nShock: IUniform<number>;
      imp: IUniform<Float32Array>;
      imp2: IUniform<Float32Array>;
      nImp: IUniform<number>;
      lights: IUniform<Float32Array>;
      nLights: IUniform<number>;
    },
  ) {
    const pos = new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3);
    this.geo.setAttribute('position', pos);
    this.geo.setIndex([0, 1, 2, 2, 1, 3]);
    this.uniforms = {
      uRes: { value: res },
      uView: uniformsShared.view,
      uTime: uniformsShared.time,
      uFlow: uniformsShared.flow,
      uIntensity: uniformsShared.intensity,
      uShock: uniformsShared.shock,
      uNShock: uniformsShared.nShock,
      uImp: uniformsShared.imp,
      uImp2: uniformsShared.imp2,
      uNImp: uniformsShared.nImp,
      uLt: uniformsShared.lights,
      uNLt: uniformsShared.nLights,
      uColor: { value: [0.03, 0.03, 0.04] },
      uForceK: { value: 2.4 },
      uBand: { value: new Vector2(60, 250) },
      uAlphaK: { value: 1 },
    };
    this.mat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      transparent: true,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: SrcAlphaFactor,
      blendDst: OneMinusSrcAlphaFactor,
      blendSrcAlpha: ZeroFactor,
      blendDstAlpha: OneFactor,
    });
    this.mesh = new Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  /** Lay the instances out for a stage's arena (deterministic per stage seed). Cheap: a few thousand floats. */
  setup(
    arena: { minX: number; maxX: number; minY: number; maxY: number },
    look: ForegroundLook,
    seed: number,
  ): void {
    const rng = new Rng(seed);
    const n = Math.min(FOREGROUND_MAX, Math.round(FOREGROUND_MAX * (look.density ?? 1)));
    const f0 = new Float32Array(FOREGROUND_MAX * 4);
    const f1 = new Float32Array(FOREGROUND_MAX * 4);
    for (let i = 0; i < FOREGROUND_MAX; i++) {
      const par = 1.5 + rng.next() * 0.7;
      // layer-space rectangle a layer of this parallax must cover (same rule as layerBounds), then a screen-space band choice:
      // 40 % along the top edge, 40 % along the bottom, 20 % anywhere (kept faint by the shader across the fight band)
      const x0 = arena.minX * par - 60;
      const x1 = (arena.maxX - 640) * par + 640 + 60;
      const y0 = arena.minY * par - 60;
      const y1 = (arena.maxY - 360) * par + 360 + 60;
      const u = rng.next();
      const camY = 110 * par; // composed for the reference camera (arena centre)
      const sy = u < 0.4 ? rng.range(-30, 70) : u < 0.8 ? rng.range(280, 390) : rng.range(0, 360);
      const rock = i % 6 === 5;
      const size = rock ? rng.range(7, 16) : rng.range(26, 80);
      f0.set([rng.range(x0, x1), Math.min(Math.max(sy + camY, y0), y1), par, rng.next()], i * 4);
      f1.set(
        [
          size,
          rock ? rng.range(0.22, 0.34) : rng.range(0.16, 0.35),
          size > 34 ? rng.range(1.0, 1.5) : rng.range(1.8, 2.6),
          rock ? 1 : 0,
        ],
        i * 4,
      );
    }
    this.geo.setAttribute('aF0', new InstancedBufferAttribute(f0, 4));
    this.geo.setAttribute('aF1', new InstancedBufferAttribute(f1, 4));
    this.count = n;
    this.uniforms.uColor!.value = [...look.color];
    this.uniforms.uAlphaK!.value = look.alpha ?? 1;
  }

  setTier(tier: 0 | 1 | 2): void {
    this.enabled = TIER_FRACTION[tier] > 0;
    this.geo.instanceCount = Math.max(1, Math.round(this.count * TIER_FRACTION[tier]));
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  setBand(top: number, bottom: number): void {
    (this.uniforms.uBand!.value as Vector2).set(top, bottom);
  }

  get active(): boolean {
    return this.enabled && this.geo.getAttribute('aF0') !== undefined;
  }

  /** Draw over `target` (an MRT frame target: colour + emissive; emissive and occlusion alpha are left untouched). */
  render(renderer: WebGLRenderer, target: WebGLRenderTarget): void {
    if (!this.active) return;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
