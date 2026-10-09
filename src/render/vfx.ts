import {
  CustomBlending,
  AddEquation,
  DoubleSide,
  DynamicDrawUsage,
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
  type DataTexture,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { LOGICAL_H, LOGICAL_W, hex, pb, pg, pr, type FrameFx } from '@/contracts';
import { compileScene, unitQuad } from './gl';
import { VFX_RAMPS, masterPalette } from './master';
import { TITAN_SKY } from './unified';

/**
 * THE SHARED IMPACT VFX (shared/VFX_SPEC.md): one recipe for every titan, scaled by blow weight, drawn on the GPU into the layer
 * target so every pixel is snapped to the master palette by the final pass.
 *
 *  1. anticipation — a tight bright pinpoint and a one-frame inward-pulled ring at the contact point;
 *  2. core flash — an irregular star with angular spikes in 4–6 palette steps (white → pale yellow → orange → red → deep red),
 *     dithered edge, shrinking and cooling frame by frame; never a disc;
 *  3. shockwave — a screen-space distortion ring (post pass) with a thin bright leading edge (here), slightly flattened toward
 *     the camera;
 *  4. debris — stepped pixel sprites with no rotation: rock chunks (dark, lit edge toward the one sky) or titan matter, angular
 *     sparks; slow drag, some persist;
 *  5. lingering — low-contrast dust puffs drifting for 1–3 s.
 * Every element is an analytic function of the impact's age and seed: no simulation state, identical frames for identical
 * inputs (replays, captures). Hitstop / shake by weight are S1's table; this module only draws.
 */

export type VfxWeight = 0 | 1 | 2 | 3;
export const VFX_WEIGHT_NAMES = ['light', 'medium', 'heavy', 'catastrophic'] as const;

/** What the debris is made of (VFX_SPEC "titan-specific matter" hooks). 우리's torn chunks are its own matter: no sprites. */
export type VfxMatter = 'rock' | 'witness' | 'planet' | 'mouth' | 'uri';
const MATTERS: readonly VfxMatter[] = ['rock', 'witness', 'planet', 'mouth', 'uri'];

/** One impact for the renderer (FrameFx.vfx, proposal 167). WORLD coordinates; `age` in seconds since contact. */
export interface VfxImpact {
  x: number;
  y: number;
  weight: VfxWeight;
  age: number;
  /** The blow's direction (unit; sparks leave against it). */
  dirX: number;
  dirY: number;
  seed: number;
  matter: VfxMatter;
  /**
   * 우리's break-apart (the oracle's breakApart ring): besides the catastrophic recipe, a 3 px pale blue-white ring flattened to 0.55
   * that grows 7 px a frame from 6 px while it fades (alpha 1.4 − 0.012 per frame: about 2 s). The oracle's flash disc is a
   * placeholder (VFX_SPEC): the shared star flash stands in for it.
   */
  snap?: boolean;
}
/** The screen-wide flash (D34): colour 0..1, amount 0..1 now, centre (world). Applied scaled by the comfort setting. */
export interface WashFx {
  r: number;
  g: number;
  b: number;
  a: number;
  x: number;
  y: number;
}
export type FrameFxVfx = FrameFx & { vfx?: readonly VfxImpact[]; wash?: WashFx };

/**
 * Per weight: frames at 60 fps and sizes in logical px. VFX_SPEC fixes the timing ranges (anticipation 1–2 frames, flash 3–5,
 * shockwave 8–20, debris 0.5–2 s, lingering 1–3 s, 4–6 flash steps); the sizes and counts are this module's tuning (config).
 */
export interface VfxWeightConfig {
  pinFrames: number;
  pinPx: number;
  pullPx: number;
  flashFrames: number;
  flashPx: number;
  flashSteps: number;
  spikes: number;
  ringFrames: number;
  ringPx: number;
  /** Refraction of the distortion ring at its start (px of displacement). */
  ringDisp: number;
  sparks: number;
  debris: number;
  debrisLife: [number, number];
  debrisPx: [number, number];
  dust: number;
  dustLife: [number, number];
}
export const VFX_WEIGHTS: readonly VfxWeightConfig[] = [
  {
    pinFrames: 1,
    pinPx: 1,
    pullPx: 5,
    flashFrames: 3,
    flashPx: 6,
    flashSteps: 4,
    spikes: 4,
    ringFrames: 8,
    ringPx: 22,
    ringDisp: 2,
    sparks: 3,
    debris: 0,
    debrisLife: [0.5, 0.7],
    debrisPx: [1, 2],
    dust: 1,
    dustLife: [1, 1.4],
  },
  {
    pinFrames: 1,
    pinPx: 1,
    pullPx: 8,
    flashFrames: 4,
    flashPx: 10,
    flashSteps: 5,
    spikes: 5,
    ringFrames: 12,
    ringPx: 38,
    ringDisp: 3,
    sparks: 5,
    debris: 3,
    debrisLife: [0.6, 1.1],
    debrisPx: [1, 2],
    dust: 2,
    dustLife: [1.2, 2],
  },
  {
    pinFrames: 2,
    pinPx: 2,
    pullPx: 12,
    flashFrames: 5,
    flashPx: 15,
    flashSteps: 6,
    spikes: 6,
    ringFrames: 16,
    ringPx: 60,
    ringDisp: 5,
    sparks: 8,
    debris: 6,
    debrisLife: [0.8, 1.6],
    debrisPx: [2, 3],
    dust: 4,
    dustLife: [1.5, 2.5],
  },
  {
    pinFrames: 2,
    pinPx: 2,
    pullPx: 18,
    flashFrames: 5,
    flashPx: 24,
    flashSteps: 6,
    spikes: 8,
    ringFrames: 20,
    ringPx: 104,
    ringDisp: 8,
    sparks: 14,
    debris: 12,
    debrisLife: [1, 2],
    debrisPx: [2, 4],
    dust: 8,
    dustLife: [2, 3],
  },
];

/** Longest an impact draws anything (lingering dust of a catastrophic blow). */
export const VFX_MAX_AGE = 3;
/** Most impacts drawn at once (the newest win). */
export const MAX_VFX_IMPACTS = 24;
const MAX_INSTANCES = 1024;

/** Element kinds (instance attribute `aA.x`). */
const K_PIN = 0;
const K_PULL = 1;
const K_STAR = 2;
const K_ROCK = 3;
const K_SPARK = 4;
const K_DUST = 5;
const K_EDGE = 6;
const K_SNAP = 7;

/** Palette table indices (uniform uPal): flash ramp 0..5 (dark → white), dust 6..12, matter debris ramps 6 each from 13. */
const PAL_FLASH = 0;
const PAL_DUST = 6;
const PAL_MATTER = 13;

/** Deterministic 0..1 hash of (seed, k). */
export function vfxHash(seed: number, k: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(k + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Position after `t` seconds of motion with speed v0 under linear drag k (1/s): v0 / k · (1 − e^(−k t)). */
const dragged = (v0: number, k: number, t: number): number => (v0 / k) * (1 - Math.exp(-k * t));

/**
 * Instance stream for this frame: per element 12 floats — kind, x, y, size | p0..p3 | p4..p7 (see VFX_FRAG). Screen px
 * (view applied), integer-snapped centres. Returns the instance count.
 */
export function buildVfxInstances(
  impacts: readonly VfxImpact[],
  vx: number,
  vy: number,
  out: Float32Array,
  shocks?: { data: Float32Array; ell: Float32Array; start: number; max: number },
): { count: number; shocks: number } {
  let n = 0;
  let ns = shocks?.start ?? 0;
  const cap = Math.min(MAX_INSTANCES, Math.floor(out.length / 12));
  const put = (kind: number, x: number, y: number, size: number, a: number[], b: number[]): void => {
    if (n >= cap) return;
    const o = n * 12;
    out[o] = kind;
    out[o + 1] = Math.round(x);
    out[o + 2] = Math.round(y);
    out[o + 3] = size;
    for (let i = 0; i < 4; i++) {
      out[o + 4 + i] = a[i] ?? 0;
      out[o + 8 + i] = b[i] ?? 0;
    }
    n++;
  };
  const first = Math.max(0, impacts.length - MAX_VFX_IMPACTS);
  for (let ii = first; ii < impacts.length; ii++) {
    const im = impacts[ii]!;
    if (!(im.age >= 0) || im.age > VFX_MAX_AGE) continue;
    const W = VFX_WEIGHTS[im.weight]!;
    const f = Math.floor(im.age * 60 + 1e-6);
    const x0 = im.x - vx;
    const y0 = im.y - vy;
    const dl = Math.hypot(im.dirX, im.dirY) || 1;
    const dx = im.dirX / dl;
    const dy = im.dirY / dl;
    const s = im.seed >>> 0;
    const mat = PAL_MATTER + 6 * Math.max(0, MATTERS.indexOf(im.matter));

    // 3. the shockwave: its bright leading edge here, the distortion in the post pass
    // (it leaves the contact after the anticipation frame; a ring of a few px would only magnify what sits under the flash)
    if (f >= 1 && f <= W.ringFrames) {
      const u = f / W.ringFrames;
      const r = W.ringPx * (1 - (1 - u) * (1 - u));
      put(K_EDGE, x0, y0, r, [1 - u, 0.85, 0, 0], []);
      if (shocks && ns < shocks.max) {
        shocks.data[ns * 4] = x0;
        shocks.data[ns * 4 + 1] = y0;
        shocks.data[ns * 4 + 2] = r;
        shocks.data[ns * 4 + 3] = W.ringDisp * (1 - u) * Math.min(1, r / 14);
        shocks.ell[ns] = 0.85;
        ns++;
      }
    }
    // 4a. sparks: angular streaks leaving against the blow and along the surface, fast, short-lived
    for (let i = 0; i < W.sparks; i++) {
      const life = 0.22 + 0.2 * vfxHash(s, 100 + i);
      if (im.age > life) continue;
      const a = Math.atan2(-dy, -dx) + (vfxHash(s, 200 + i) - 0.5) * 2.6;
      const sp = 110 + 140 * vfxHash(s, 300 + i);
      const kd = 4;
      const px = x0 + Math.cos(a) * dragged(sp, kd, im.age);
      const py = y0 + Math.sin(a) * dragged(sp, kd, im.age);
      const v = sp * Math.exp(-kd * im.age);
      const len = Math.max(1, Math.min(4, v / 45));
      put(K_SPARK, px, py, len, [Math.cos(a), Math.sin(a), im.age / life, 0], []);
    }
    // 4b. debris: rock chunks or titan matter, slow drag, stepped shape frames (no rotation)
    if (im.matter !== 'uri') {
      for (let i = 0; i < W.debris; i++) {
        const life = W.debrisLife[0] + (W.debrisLife[1] - W.debrisLife[0]) * vfxHash(s, 400 + i);
        if (im.age > life) continue;
        const a = Math.atan2(-dy, -dx) + (vfxHash(s, 500 + i) - 0.5) * 4.2;
        const sp = 28 + 80 * vfxHash(s, 600 + i);
        const kd = 1.1;
        const px = x0 + Math.cos(a) * dragged(sp, kd, im.age);
        const py = y0 + Math.sin(a) * dragged(sp, kd, im.age) + 6 * im.age * im.age;
        const size = W.debrisPx[0] + Math.round((W.debrisPx[1] - W.debrisPx[0]) * vfxHash(s, 700 + i));
        const frame = Math.floor(im.age * 7.5); // a new stepped shape every 8 frames: the chunk tumbles without rotating
        const fade = Math.max(0, (im.age - life * 0.7) / (life * 0.3));
        put(K_ROCK, px, py, size, [(s + i * 977 + frame * 131) & 0xffff, mat, fade, 0], []);
      }
    }
    // 5. lingering dust: low-contrast puffs that swell and drift
    for (let i = 0; i < W.dust; i++) {
      const t0 = 0.05 + 0.1 * vfxHash(s, 800 + i);
      const life = W.dustLife[0] + (W.dustLife[1] - W.dustLife[0]) * vfxHash(s, 900 + i);
      const t = im.age - t0;
      if (t < 0 || t > life) continue;
      const a = vfxHash(s, 1000 + i) * Math.PI * 2;
      const sp = 6 + 10 * vfxHash(s, 1100 + i);
      const px = x0 + Math.cos(a) * (4 + dragged(sp, 0.6, t));
      const py = y0 + Math.sin(a) * (3 + dragged(sp, 0.6, t)) - 3 * t;
      const r = Math.round(2 + (3 + 3 * im.weight) * Math.min(1, t / (life * 0.5)));
      const density = 0.55 * (1 - t / life);
      put(K_DUST, px, py, r, [density, 1 + Math.floor(vfxHash(s, 1200 + i) * 3), (s + i) & 0xffff, 0], []);
    }
  }
  // 우리's break-apart ring (on top of the debris it flings)
  for (let ii = first; ii < impacts.length; ii++) {
    const im = impacts[ii]!;
    if (!im.snap || !(im.age >= 0)) continue;
    const f = Math.floor(im.age * 60 + 1e-6);
    const a = 1.4 - 0.012 * f;
    if (a <= 0) continue;
    put(K_SNAP, im.x - vx, im.y - vy, 6 + 7 * f, [Math.min(1, a), 0.55, 0, 0], []);
  }
  // the anticipation and the core flash go last: they sit on top of the debris and sparks thrown from under them
  for (let ii = first; ii < impacts.length; ii++) {
    const im = impacts[ii]!;
    if (!(im.age >= 0) || im.age > VFX_MAX_AGE) continue;
    const W = VFX_WEIGHTS[im.weight]!;
    const f = Math.floor(im.age * 60 + 1e-6);
    const x0 = im.x - vx;
    const y0 = im.y - vy;
    // 1. anticipation: pinpoint (frames 0..pinFrames-1) and the inward-pulled ring (frame 0 only)
    if (f < W.pinFrames) put(K_PIN, x0, y0, W.pinPx, [0, 0, 0, 0], []);
    if (f === 0) put(K_PULL, x0, y0, W.pullPx, [0, 0, 0, 0], []);
    // 2. the star flash: frames 1..flashFrames, shrinking and cooling
    if (f >= 1 && f <= W.flashFrames) {
      const k = f - 1;
      const R = W.flashPx * (1 - (0.55 * k) / W.flashFrames);
      const a = Math.atan2(im.dirY, im.dirX);
      put(
        K_STAR,
        x0,
        y0,
        Math.max(2, R),
        [W.spikes, (im.seed >>> 0) & 0xffff, k, W.flashSteps],
        [a, 0, 0, 0],
      );
    }
  }
  return { count: n, shocks: ns - (shocks?.start ?? 0) };
}

/* ------------------------------------------------------------------------------------------------ *
 *  GPU: one instanced quad per element, the shape decided per pixel at integer offsets from the element's centre.
 * ------------------------------------------------------------------------------------------------ */

const VFX_VERT = /* glsl */ `
precision highp float;
precision highp int;
in vec3 position;
in vec4 aA;   // kind, x, y, size
in vec4 aB;
in vec4 aC;
uniform vec2 uRes;
flat out vec4 vA;
flat out vec4 vB;
flat out vec4 vC;
void main() {
  float ext = aA.w + 3.0;
  if (aA.x == 4.0) ext = aA.w + 2.0;
  vec2 p = aA.yz + (position.xy * 2.0 - 1.0) * (ext + 1.0);
  vA = aA;
  vB = aB;
  vC = aC;
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}
`;

const VFX_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec2 uRes;
uniform sampler2D uBayer;
uniform vec3 uPal[38];
uniform vec2 uLightDir;   // screen direction TOWARD the one sky's key (upper-left)
flat in vec4 vA;
flat in vec4 vB;
flat in vec4 vC;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oEmis;
layout(location = 2) out vec4 oId;
float h1(float a, float b) { return fract(sin(a * 12.9898 + b * 78.233) * 43758.5453); }
void emit(vec3 c, bool glow) {
  oColor = vec4(c, 1.0);
  oEmis = vec4(glow ? c : vec3(0.0), 1.0);
  oId = vec4(0.0, 0.0, 0.0, 1.0);
}
// irregular chunk: a polygon of 6 sectors with seeded radii
bool chunkAt(vec2 o, float size, float seed) {
  float r = length(o);
  if (r < 0.5) return true;
  float a = atan(o.y, o.x) / 6.2831853 + 0.5;
  float sec = floor(a * 6.0);
  float R = size * (0.62 + 0.45 * h1(seed, sec));
  return r <= R + 0.25;
}
void main() {
  ivec2 P = ivec2(floor(gl_FragCoord.x), int(floor(uRes.y - gl_FragCoord.y)));
  vec2 o = vec2(P) + 0.5 - (vA.yz + 0.5);
  float th = texelFetch(uBayer, ivec2(gl_FragCoord.xy) & 3, 0).r;
  int kind = int(vA.x + 0.5);
  float s = vA.w;
  if (kind == 0) {
    // pinpoint: a hard cross, white
    if (abs(o.x) + abs(o.y) > s + 0.1 || (abs(o.x) > 0.6 && abs(o.y) > 0.6)) discard;
    emit(uPal[5], true);
    return;
  }
  if (kind == 1) {
    // the pull ring: one pixel thick, pale, dotted every other pixel
    float r = length(o);
    if (abs(r - s) > 0.55 || ((P.x + P.y) & 1) == 1) discard;
    emit(uPal[4], true);
    return;
  }
  if (kind == 2) {
    // the star flash: K angular spikes of seeded length; colour steps outward, cooling by frame; dithered rim
    float K = vB.x;
    float r = length(o);
    float a = atan(o.y, o.x) - vC.x;
    float sector = 6.2831853 / K;
    float sa = mod(a + 0.5 * sector, sector) - 0.5 * sector;
    float idx = floor((a + 0.5 * sector) / sector);
    float L = 0.55 + 0.45 * h1(vB.y, mod(idx, K));
    // each spike has its own width and a slight lean: an irregular star, never a flower
    float wid = 0.55 + 0.45 * h1(vB.y + 7.0, mod(idx, K));
    float lean = (h1(vB.y + 3.0, mod(idx, K)) - 0.5) * 0.35 * sector;
    float tri = 1.0 - abs(sa - lean) / (0.5 * sector * wid);
    float rr = s * (0.26 + (L - 0.26) * pow(max(tri, 0.0), 2.6));
    if (r > rr + 0.3) discard;
    float f = r / max(rr, 1.0);
    if (f > 0.78 && th < (f - 0.78) / 0.22) discard;
    float steps = vB.w;
    float band = floor(f * (steps - 1.0) * 0.9 + vB.z * 0.75);
    int ci = 5 - int(clamp(band, 0.0, steps - 1.0));
    ci = max(ci, 6 - int(steps));
    emit(uPal[ci], true);
    return;
  }
  if (kind == 3) {
    // debris chunk: dark body, a lit edge toward the one sky; fades out through the dither
    if (!chunkAt(o, s, vB.x)) discard;
    if (th < vB.z) discard;
    int base = int(vB.y + 0.5);
    bool edge = !chunkAt(o + uLightDir, s, vB.x);
    bool shadow = !chunkAt(o - uLightDir, s, vB.x);
    vec3 c = edge ? uPal[base + 4] : shadow ? uPal[base] : (h1(vB.x, o.x * 7.0 + o.y) > 0.5 ? uPal[base + 2] : uPal[base + 1]);
    emit(c, false);
    return;
  }
  if (kind == 4) {
    // spark: an angular streak along its flight, cooling white → orange → red
    vec2 d = vB.xy;
    float t = dot(o, -d);
    float side = abs(o.x * d.y - o.y * d.x);
    if (t < -0.5 || t > s + 0.5 || side > 0.55) discard;
    int ci = 5 - int(clamp(floor(vB.z * 4.0 + t / max(s, 1.0)), 0.0, 3.0));
    emit(uPal[ci], true);
    return;
  }
  if (kind == 5) {
    // dust: a soft puff in low-contrast palette greys, transparent through the dither
    float r = length(o) / max(s, 1.0);
    if (r > 1.0) discard;
    float dens = vB.x * (1.0 - r * r);
    if (th >= dens) discard;
    emit(uPal[6 + int(vB.y + 0.5)], false);
    return;
  }
  if (kind == 7) {
    // 우리's break-apart ring: 3 px, pale blue-white, flattened 0.55, fading through the dither
    vec2 e = vec2(o.x, o.y / vB.y);
    float r = length(e);
    if (abs(r - s) > 1.5 || th >= vB.x) discard;
    emit(uPal[37], true);
    return;
  }
  if (kind == 6) {
    // the shockwave's thin bright leading edge, flattened toward the camera, thinning out as it fades
    vec2 e = vec2(o.x, o.y / vB.y);
    float r = length(e);
    if (abs(r - s) > 0.55 || th >= vB.x) discard;
    emit(uPal[3], true);
    return;
  }
  discard;
}
`;

/** Draws the elements built by `buildVfxInstances` into the layer target (colour, emissive, id attachments). */
export class VfxPass {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geo: InstancedBufferGeometry;
  private readonly mat: RawShaderMaterial;
  private readonly mesh: Mesh;
  readonly data = new Float32Array(MAX_INSTANCES * 12);
  private readonly aA: InstancedBufferAttribute;
  private readonly aB: InstancedBufferAttribute;
  private readonly aC: InstancedBufferAttribute;
  private readonly bufA = new Float32Array(MAX_INSTANCES * 4);
  private readonly bufB = new Float32Array(MAX_INSTANCES * 4);
  private readonly bufC = new Float32Array(MAX_INSTANCES * 4);
  /** Elements drawn last frame. */
  drawn = 0;

  constructor(res: Vector2, bayer: DataTexture) {
    const q = unitQuad();
    this.geo = new InstancedBufferGeometry();
    this.geo.setAttribute('position', q.getAttribute('position'));
    this.geo.setIndex(q.getIndex());
    this.aA = new InstancedBufferAttribute(this.bufA, 4).setUsage(DynamicDrawUsage);
    this.aB = new InstancedBufferAttribute(this.bufB, 4).setUsage(DynamicDrawUsage);
    this.aC = new InstancedBufferAttribute(this.bufC, 4).setUsage(DynamicDrawUsage);
    this.geo.setAttribute('aA', this.aA);
    this.geo.setAttribute('aB', this.aB);
    this.geo.setAttribute('aC', this.aC);
    this.geo.instanceCount = 0;
    const pal = new Float32Array(38 * 3);
    const set = (i: number, h: string): void => {
      const c = hex(h);
      pal[i * 3] = pr(c) / 255;
      pal[i * 3 + 1] = pg(c) / 255;
      pal[i * 3 + 2] = pb(c) / 255;
    };
    VFX_RAMPS.flash.forEach((h, i) => set(PAL_FLASH + i, h));
    VFX_RAMPS.dust.forEach((h, i) => set(PAL_DUST + i, h));
    const m = masterPalette();
    const ramp = (name: string): string[] => (m.ramps[name] ?? []).map((i) => m.colors[i]!);
    // per matter: 6 colours, dark → light (index 4 = the lit edge)
    const pick6 = (r: string[]): string[] =>
      [0, 1, 2, 3, 4, 5].map((k) => r[Math.min(r.length - 1, Math.round((k * (r.length - 1)) / 5))]!);
    const tables: string[][] = [
      [...VFX_RAMPS.rock],
      pick6(ramp('witness.gold')),
      pick6([...ramp('vfx.rock').slice(0, 3), ...ramp('planet.magma').slice(2, 5)]),
      pick6(ramp('mouth.bone')),
      [...VFX_RAMPS.rock],
    ];
    tables.forEach((t, k) => t.forEach((h, i) => set(PAL_MATTER + k * 6 + i, h)));
    // the break-apart ring's pale blue-white (the oracle's rgba(230, 240, 255)), snapped to the master palette by the final pass
    set(37, '#e6f0ff');
    const l = TITAN_SKY.dir;
    const ll = Math.hypot(l[0], l[1]) || 1;
    this.mat = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VFX_VERT,
      fragmentShader: VFX_FRAG,
      uniforms: {
        uRes: { value: res },
        uBayer: { value: bayer },
        uPal: { value: pal },
        uLightDir: { value: new Vector2(Math.round(l[0] / ll), Math.round(l[1] / ll)) },
      },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      side: DoubleSide,
    });
    const mt = this.mat;
    mt.blending = CustomBlending;
    mt.blendEquation = AddEquation;
    mt.blendSrc = SrcAlphaFactor;
    mt.blendDst = OneMinusSrcAlphaFactor;
    mt.blendSrcAlpha = OneFactor;
    mt.blendDstAlpha = OneMinusSrcAlphaFactor;
    this.mesh = new Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  /** Upload this frame's elements (from `data`) and draw them over what the layer target holds. */
  draw(renderer: WebGLRenderer, target: WebGLRenderTarget, count: number): void {
    this.drawn = count;
    if (count <= 0) return;
    const d = this.data;
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 4; k++) {
        this.bufA[i * 4 + k] = d[i * 12 + k]!;
        this.bufB[i * 4 + k] = d[i * 12 + 4 + k]!;
        this.bufC[i * 4 + k] = d[i * 12 + 8 + k]!;
      }
    }
    for (const a of [this.aA, this.aB, this.aC]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, count * 4);
      a.needsUpdate = true;
    }
    this.geo.instanceCount = count;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  compile(renderer: WebGLRenderer): Promise<void> {
    this.geo.instanceCount = 1;
    return compileScene(renderer, this.scene, this.camera).then(() => {
      this.geo.instanceCount = 0;
    });
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

/** Logical frame size, for callers placing test impacts. */
export const VFX_FRAME = { w: LOGICAL_W, h: LOGICAL_H } as const;
