import {
  DepthTexture,
  DoubleSide,
  DynamicDrawUsage,
  FloatType,
  GLSL3,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LessDepth,
  Mesh,
  NearestFilter,
  NoBlending,
  OrthographicCamera,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  UnsignedByteType,
  UnsignedIntType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { LOGICAL_H, LOGICAL_W, type RenderLayer, type ViewRect } from '@/contracts';
import { dataTexture, unitQuad } from './gl';
import {
  ANN_STRIDE,
  MAX_ANN,
  MAX_STAMPS,
  MAX_TUBES,
  MAX_WOUNDS,
  MOUTH_BAYER,
  MOUTH_NOISE_H,
  MOUTH_NOISE_W,
  MOUTH_RAMPS,
  STAMP_STRIDE,
  TUBE_STRIDE,
  mouthNoiseTable,
  type MouthDrawList,
} from './mouthList';

/**
 * The Mouth on the GPU (Phase 3C, shared/RENDERING.md; Gate 3A §7: ≤ 2 ms). The locked prototype's per-pixel CPU raster
 * (`mouth/src/10_mouth_render_lib.js` tube / flesh / annulus / tooth / claw / barb / slime and the ring band, with its depth
 * buffer; `20_mouth_compose.js` depth seams) as three instanced programs:
 *  - TUBES: one oriented quad over each capsule; the fragment shader is the prototype's `tube` + `flesh` (noise tables as a
 *    texture, wet speculars, the rim through the flesh, the cold violet fill, wounds);
 *  - ANNULI: the throat's gullet rings, its glowing bottom and the lips, in their tilted planes;
 *  - STAMPS: ring-band discs, teeth, claws, barbs, gums and single pixels.
 * Two stages, so the expensive shading runs once per visible pixel (the braids overlap many times over):
 *  1. depth: every primitive writes only the prototype's z (+ toward the viewer) as gl_FragDepth, strict less test;
 *  2. shade: every primitive again, but a fragment is shaded only where its z is the one the depth stage kept.
 * Then a compose quad in the layer compositor's scene reads the result, darkens depth seams (a neighbour ≥ 5 px nearer) and
 * writes colour, emissive and the titan id — once for the back layer (the coils, the wrap's back half: behind the foe) and
 * once for the front layer (Gate 3A §3–4).
 */

/** A layer that carries the Mouth: the draw list and which half of it this layer shows. */
export interface MouthLayerFx {
  list: MouthDrawList;
  back: boolean;
}
export type RenderLayerMouth = RenderLayer & { mouth?: MouthLayerFx };

const Z_SCALE = 16384;

const HEAD = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
`;

/** Shared GLSL: view, palette pick, flesh, the two-stage depth gate. */
const COMMON = (prepass: boolean): string => /* glsl */ `
${prepass ? '#define PREPASS 1' : ''}
uniform vec2 uRes;
uniform vec2 uView;           // integer view origin (world px)
uniform vec3 uRamp[44];       // black 0 (7) · red 7 (10) · pale 17 (9) · bone 26 (9) · maw 35 (9); 0..255
uniform vec3 uLK;
uniform vec3 uLF;
uniform vec3 uLB;
uniform vec3 uHV;
uniform float uT;
uniform vec4 uClip0;          // C.x, C.y, u.x, u.y
uniform vec4 uClip1;          // w.x, w.y, RO, on (0 off, 1 test, 2 always inside)
uniform sampler2D uNoise;     // TM, TB, TF, TD (1024 × 32)
uniform vec4 uWounds[${MAX_WOUNDS}];
uniform int uNW;
uniform sampler2D uDepth;     // the depth stage (shade stage only)
const float BY[16] = float[16](${MOUTH_BAYER.map((v) => v.toFixed(6)).join(', ')});
const int R_BLACK = 0;
const int R_RED = 1;
const int R_PALE = 2;
const int R_BONE = 3;
const int R_MAW = 4;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oData;
int rampOff(int r) { return r == 0 ? 0 : r == 1 ? 7 : r == 2 ? 17 : r == 3 ? 26 : 35; }
int rampLen(int r) { return r == 0 ? 7 : r == 1 ? 10 : 9; }
float bay(ivec2 P) { return BY[(P.y & 3) * 4 + (P.x & 3)]; }
vec3 pick(int r, float l, ivec2 P) {
  int n = rampLen(r);
  int k = int(floor(l * float(n) + bay(P) * 0.7));
  k = clamp(k, 0, n - 1);
  return uRamp[rampOff(r) + k];
}
/** The pixel this fragment covers, in world px (integer). */
ivec2 worldPixel() {
  ivec2 S = ivec2(floor(gl_FragCoord.x), int(floor(uRes.y - gl_FragCoord.y)));
  return S + ivec2(uView);
}
bool inOpen(ivec2 P) {
  if (uClip1.w < 0.5 || uClip1.w > 1.5) return true;
  vec2 p = vec2(P) + 0.5 - uClip0.xy;
  vec2 u = uClip0.zw;
  vec2 w = uClip1.xy;
  float det = u.x * w.y - u.y * w.x;
  float s = (p.x * w.y - p.y * w.x) / det;
  float q = (u.x * p.y - u.y * p.x) / det;
  return s * s + q * q < uClip1.z * uClip1.z;
}
float depthOf(float z) { return 1.0 - clamp((z + ${Z_SCALE / 2}.0) / ${Z_SCALE}.0, 0.0, 1.0); }
/**
 * The two-stage gate, called once z is known: the depth stage writes it (and the caller returns), the shade stage keeps the
 * fragment only if it is the one the depth stage kept (else the caller discards).
 */
bool gate(float z) {
#ifdef PREPASS
  gl_FragDepth = depthOf(z);
  oColor = vec4(0.0);
  oData = vec4(0.0);
  return false;
#else
  float s = texelFetch(uDepth, ivec2(gl_FragCoord.xy), 0).r;
  return abs(s - depthOf(z)) < 2.0e-6;
#endif
}
#ifdef PREPASS
#define GATE(z) if (!gate(z)) return;
#else
#define GATE(z) if (!gate(z)) discard;
#endif
float woundAt(float sid, float u) {
  float r = 0.0;
  for (int i = 0; i < ${MAX_WOUNDS}; i++) {
    if (i >= uNW) break;
    vec4 w = uWounds[i];
    if (abs(w.x - sid) < 0.5 && abs(u - w.y) < w.z) {
      r = 1.0 - abs(u - w.y) / w.z;
      break;
    }
  }
  return r;
}
/** The prototype's flesh(n, u, v, sid, x, y, deep): wet black / raw red / pale sinew, rim through the edge, wet speculars. */
vec3 flesh(vec3 n, float u, float v, float sid, ivec2 P, float deep, bool warm) {
  int iu = int(mod(floor(u + sid * 137.3), 1024.0));
  int iv = clamp(int(floor((v + 1.0) * 0.5 * 31.0 + 0.5)), 0, 31);
  vec4 T = texelFetch(uNoise, ivec2(iu, iv), 0);
  vec3 nn = vec3(n.x, -n.y, n.z);
  float dif = max(0.0, dot(nn, uLK));
  float fil = max(0.0, dot(nn, uLF));
  float rim = pow(max(0.0, 1.0 - n.z), 2.8) * max(0.0, dot(vec3(n.x, -n.y, 0.0), vec3(uLB.xy, 0.0)) + 0.2);
  // a wound replaces the flesh: raw red gashes, darker round their rims
  float wd = uNW > 0 ? woundAt(sid, u) : 0.0;
  vec3 wc = vec3(floor(90.0 + wd * 80.0), 10.0, 14.0);
  if (wd > 0.55 && abs(v) < 0.6) wc = ((P.x + P.y) & 1) == 1 ? vec3(255.0, 96.0, 60.0) : vec3(200.0, 40.0, 30.0);
  // wet: a sharp highlight, streaked along the strand by its fibres
  float fibre = T.z;
  float spec = pow(max(0.0, dot(nn, uHV)), 36.0) * (0.5 + fibre * 0.8);
  // what the strand is made of: mostly wet black, raw red running through it, pale marbled sinew in places
  float m = T.x + (sid >= 100.0 ? -0.06 : (sid >= 30.0 && sid < 40.0) ? -0.1 : 0.0) + bay(P) * 0.08;
  float marble = T.y;
  int R = m < 0.53 ? R_BLACK : m < 0.7 ? R_RED : R_PALE;
  float l = 0.02 + 0.8 * pow(dif, 1.15) + 0.08 * fil - deep + (T.w - 0.5) * 0.12;
  if (R == R_BLACK && marble > 0.94) { R = R_RED; l = l * 0.7 + 0.06; }
  if (R == R_RED && marble > 0.965) R = R_PALE;
  // folds: transverse wrinkles across the strand
  l += sin(u * 0.55 + sin(v * 2.0) * 1.5 + sid) * 0.05;
  // the big coils are ropes of smaller strands: helical grooves and a highlight per sub-strand
  if (sid >= 100.0) {
    float st = sin(asin(clamp(v, -1.0, 1.0)) * 9.0 + u * 0.11 + sid);
    if (st > 0.9) l += 0.16;
    else if (st < -0.85) l *= 0.5;
  }
  vec3 c = pick(R, l, P);
  if (!warm && fil > 0.5 && dif < 0.15) c = floor(c * 0.55 + vec3(40.0, 26.0, 70.0) * 0.45);
  if (rim > 0.3) c = pick(R_RED, 0.7 + rim * 0.5, P);
  if (rim > 0.62) c = vec3(255.0, 170.0, 150.0);
  if (spec > 0.5) c = spec > 0.85 ? vec3(255.0, 244.0, 240.0) : vec3(226.0, 160.0, 162.0);
  return wd > 0.0 ? wc : c;
}
/** Write a shaded pixel (the prototype's put): colour 0..255, depth z (for the seams), emissive, back layer. */
void put(vec3 c, float z, bool em, bool back) {
  float d = 1.0 - depthOf(z);
  float q = floor(d * 65535.0 + 0.5);
  oColor = vec4(c / 255.0, 1.0);
  oData = vec4(floor(q / 256.0) / 255.0, mod(q, 256.0) / 255.0, em ? 1.0 : 0.0, back ? 1.0 : 0.5);
}
`;

const VERT_HEAD = /* glsl */ `${HEAD}
in vec3 position;
uniform vec2 uRes;
uniform vec2 uView;
vec4 clipOf(vec2 world) {
  vec2 p = world - uView;
  return vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}
`;

const TUBE_VERT = /* glsl */ `${VERT_HEAD}
in vec4 aA;   // x0 y0 z0 r0
in vec4 aB;   // x1 y1 z1 r1
in vec4 aC;   // u0 u1 sid deep
in vec4 aD;   // flags zbias
flat out vec4 vA;
flat out vec4 vB;
flat out vec4 vC;
flat out vec4 vD;
void main() {
  vA = aA; vB = aB; vC = aC; vD = aD;
  // an oriented quad over the capsule: from the start cap (or the uncapped .35 overhang) to the end, ± the larger radius
  vec2 d = aB.xy - aA.xy;
  float L = length(d);
  vec2 t = L > 1e-4 ? d / L : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  float rm = max(aA.w, aB.w) + 1.5;
  int fl = int(aD.x + 0.5);
  float s0 = (fl & 1) != 0 ? -aA.w - 1.5 : -0.35 * L - 1.5;
  float s1 = (fl & 2) != 0 ? L + aB.w + 1.5 : 1.35 * L + 1.5;
  gl_Position = clipOf(aA.xy + t * mix(s0, s1, position.x) + n * mix(-rm, rm, position.y));
}
`;

const TUBE_FRAG = (prepass: boolean): string => /* glsl */ `${HEAD}${COMMON(prepass)}
flat in vec4 vA;
flat in vec4 vB;
flat in vec4 vC;
flat in vec4 vD;
void main() {
  ivec2 P = worldPixel();
  int fl = int(vD.x + 0.5);
  vec3 p0 = vA.xyz;
  vec3 p1 = vB.xyz;
  // the prototype's raster box
  float rm = max(vA.w, vB.w);
  if (float(P.x) < floor(min(p0.x, p1.x) - rm - 1.0) || float(P.x) > ceil(max(p0.x, p1.x) + rm + 1.0) ||
      float(P.y) < floor(min(p0.y, p1.y) - rm - 1.0) || float(P.y) > ceil(max(p0.y, p1.y) + rm + 1.0)) discard;
  float dx = p1.x - p0.x, dy = p1.y - p0.y;
  float L2 = max(dx * dx + dy * dy, 1e-6);
  float L = sqrt(L2);
  float tx = dx / L, ty = dy / L;
  float px = float(P.x) + 0.5 - p0.x, py = float(P.y) + 0.5 - p0.y;
  float t = (px * dx + py * dy) / L2;
  bool c0 = (fl & 1) != 0, c1 = (fl & 2) != 0;
  if (t < 0.0) { if (!c0 && t < -0.35) discard; t = c0 ? 0.0 : t; }
  if (t > 1.0) { if (!c1 && t > 1.35) discard; t = c1 ? 1.0 : t; }
  float tt = clamp(t, 0.0, 1.0);
  float r = vA.w + (vB.w - vA.w) * tt;
  float ex = px - dx * t, ey = py - dy * t;
  float d2 = ex * ex + ey * ey;
  if (d2 > r * r) discard;
  if ((fl & 8) != 0 && !inOpen(P)) discard;
  float nz = sqrt(1.0 - d2 / (r * r));
  float z = p0.z + (p1.z - p0.z) * t + nz * r + vD.y;
  GATE(z)
  float side = (tx * ey - ty * ex) / r;
  vec3 c = flesh(vec3(ex / r, ey / r, nz), vC.x + (vC.y - vC.x) * t, side, vC.z, P, vC.w, (fl & 4) != 0);
  put(c, z, false, (fl & 16) != 0);
}
`;

const ANN_VERT = /* glsl */ `${VERT_HEAD}
in vec4 aA;   // cx cy cz r0
in vec4 aB;   // ux uy uz r1
in vec4 aC;   // wx wy wz kind
in vec4 aD;   // ax ay az k
in vec4 aE;   // gape rn rk flags
flat out vec4 vA;
flat out vec4 vB;
flat out vec4 vC;
flat out vec4 vD;
flat out vec4 vE;
void main() {
  vA = aA; vB = aB; vC = aC; vD = aD; vE = aE;
  float ext = aB.w + 2.0;
  vec2 lo = floor(aA.xy - ext);
  vec2 hi = ceil(aA.xy + ext) + 1.0;
  gl_Position = clipOf(mix(lo, hi, position.xy));
}
`;

const ANN_FRAG = (prepass: boolean): string => /* glsl */ `${HEAD}${COMMON(prepass)}
flat in vec4 vA;
flat in vec4 vB;
flat in vec4 vC;
flat in vec4 vD;
flat in vec4 vE;
void main() {
  ivec2 P = worldPixel();
  int fl = int(vE.w + 0.5);
  vec3 u = vB.xyz, w = vC.xyz, a = vD.xyz;
  float det = u.x * w.y - u.y * w.x;
  if (abs(det) < 0.05) discard;
  float px = float(P.x) + 0.5 - vA.x, py = float(P.y) + 0.5 - vA.y;
  float s = (px * w.y - py * w.x) / det;
  float q = (u.x * py - u.y * px) / det;
  float r = length(vec2(s, q));
  if (r < vA.w || r > vB.w) discard;
  if ((fl & 8) != 0 && !inOpen(P)) discard;
  float z = vA.z + s * u.z + q * w.z;
  float ang = atan(q, s);
  int kind = int(vC.w + 0.5);
  float k = vD.w;
  float rn = vE.y, rk = vE.z;
  // the lips sit on a fold: their depth swells across the collar
  float fl2 = (r - rn) / rk;
  if (kind == 2) z += sin(fl2 * 3.14159265) * 4.0;
  GATE(z)
  vec3 c;
  bool em = false;
  if (kind == 1) {
    // the bottom of the gullet: a red glow
    float g = 1.0 - r / rk;
    c = pick(R_MAW, 0.45 + 0.7 * g + sin(uT * 2.6) * 0.06, P);
    em = true;
  } else if (kind == 0) {
    float f = (r - rn) / (rk - rn + 1e-6);
    float fold = sin(ang * 8.0 + k * 1.3 + sin(ang * 3.0 + uT * 0.7) * 1.6);
    float l = 0.03 + 0.16 * (1.0 - k / 5.0) + fold * 0.06 + pow(f, 3.0) * 0.34;
    bool wet = fold > 0.86 && f > 0.55;
    c = wet ? vec3(220.0, 110.0, 110.0) : pick(k >= 2.0 ? R_MAW : R_RED, l, P);
  } else {
    // the lips: a thick collar of folded flesh
    float f = fl2;
    float fold = sin(ang * 19.0 + sin(ang * 3.0 + uT * 0.4) * 2.0);
    vec3 rad = u * cos(ang) + w * sin(ang);
    vec3 nr = normalize(rad * (f - 0.45) * 1.6 + a * 0.75);
    c = (fold > 0.7 && f < 0.4) ? pick(R_PALE, 0.62, P) : flesh(nr, ang * 30.0 + fold * 3.0, f * 2.0 - 1.0, 91.0, P, -0.04, false);
  }
  put(c, z, em, (fl & 16) != 0);
}
`;

const STAMP_VERT = /* glsl */ `${VERT_HEAD}
in vec4 aA;   // x0 y0 z0 w
in vec4 aB;   // x1 y1 z1 kind
in vec4 aC;   // params
in vec4 aD;   // r g b flags
flat out vec4 vA;
flat out vec4 vB;
flat out vec4 vC;
flat out vec4 vD;
void main() {
  vA = aA; vB = aB; vC = aC; vD = aD;
  int kind = int(aB.w + 0.5);
  vec4 b;
  if (kind == 0) b = vec4(aA.x, aA.y, aA.x + 1.0, aA.y + 1.0);
  else if (kind == 1 || kind == 4) { float e = ceil(aA.w); b = vec4(aA.x - e, aA.y - e, aA.x + e + 1.0, aA.y + e + 1.0); }
  else { float e = aA.w + 2.0; b = vec4(floor(min(aA.x, aB.x) - e), floor(min(aA.y, aB.y) - e), ceil(max(aA.x, aB.x) + e) + 1.0, ceil(max(aA.y, aB.y) + e) + 1.0); }
  gl_Position = clipOf(mix(b.xy, b.zw, position.xy));
}
`;

const STAMP_FRAG = (prepass: boolean): string => /* glsl */ `${HEAD}${COMMON(prepass)}
flat in vec4 vA;
flat in vec4 vB;
flat in vec4 vC;
flat in vec4 vD;
void main() {
  ivec2 P = worldPixel();
  int fl = int(vD.w + 0.5);
  if ((fl & 8) != 0 && !inOpen(P)) discard;
  int kind = int(vB.w + 0.5);
  bool back = (fl & 16) != 0;
  if (kind == 0) {
    GATE(vA.z)
    put(vD.xyz, vA.z, (fl & 32) != 0, back);
    return;
  }
  if (kind == 1 || kind == 4) {
    // a disc on an integer centre: the jaw-ring band (bone, ribbed, flesh at its claws) or a gum
    vec2 d = vec2(P) - vA.xy;
    if (kind == 4) {
      if (dot(d, d) > 4.5) discard;
      GATE(vA.z)
      put(d.y < 0.0 ? pick(R_RED, 0.55, P) : pick(R_RED, 0.25, P), vA.z, false, back);
      return;
    }
    float hd = length(d);
    float hw = vA.w;
    if (hd > hw) discard;
    float zr = vA.z + (hw - hd);
    GATE(zr)
    float lit = vC.x, rib = vC.y;
    vec3 c = (hd > hw - 0.8 && rib < 0.35) ? pick(R_RED, 0.3, P) : pick(R_BONE, lit + (d.y < 0.0 ? 0.14 : -0.06) - hd * 0.05 + rib * 0.08, P);
    put(c, zr, false, back);
    return;
  }
  // a tapered line: a tooth (bone, lit on one side) or a barb piece (red to bone)
  vec2 a2 = vA.xy, b2 = vB.xy;
  vec2 dv = b2 - a2;
  float L = max(1e-3, length(dv));
  vec2 dir = dv / L;
  vec2 pp = vec2(-dir.y, dir.x);
  vec2 rel = vec2(P) - a2;
  float along = dot(rel, dir);
  float f = clamp(along / L, 0.0, 1.0);
  if (along < -0.6 || along > L + 0.6) discard;
  float acr = dot(rel, pp);
  if (kind == 2) {
    float ww = vA.w * (1.0 - f * 0.85);
    if (abs(acr) > ww + 0.5) discard;
    float zt = mix(vA.z, vB.z, f) + (1.0 - f) * 1.5;
    GATE(zt)
    float l2 = acr < 0.5 ? 0.82 - f * 0.12 : 0.48 - f * 0.08;
    put(pick(R_BONE, l2, P), zt, false, back);
    return;
  }
  float F = mix(vC.x, vC.y, f);
  float ww = max(0.5, vA.w * (1.0 - F));
  if (abs(acr) > ww + 0.5) discard;
  float zb = mix(vA.z, vB.z, f);
  GATE(zb)
  float lit = acr < 0.0 ? 0.45 : 0.22;
  put(pick(F < 0.4 ? R_RED : R_BONE, lit + F * 0.32, P), zb, false, back);
}
`;

/** Compose into the layer compositor's MRT: depth seams, the side (back / front), emissive, titan id. */
const COMPOSE_VERT = /* glsl */ `${HEAD}
in vec3 position;
void main() { gl_Position = vec4(position.xy * 2.0 - 1.0, 0.0, 1.0); }
`;
const COMPOSE_FRAG = /* glsl */ `${HEAD}
uniform sampler2D uCol;
uniform sampler2D uData;
uniform float uBack;       // 1 = this is the back layer
uniform float uOutline;    // 1 = draw the prototype's own outline (off on the unified path: the shared finish pass does it)
uniform float uEmisGain;
uniform vec4 uId;          // titan flag, rank / 255, wet, 0
uniform vec2 uRes;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oEmis;
layout(location = 2) out vec4 oId;
float zAt(vec4 d) { return (d.r * 255.0 * 256.0 + d.g * 255.0) / 65535.0 * ${Z_SCALE}.0 - ${Z_SCALE / 2}.0; }
bool side(vec4 d) { return d.a > 0.0 && ((d.a > 0.75) == (uBack > 0.5)); }
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec4 d = texelFetch(uData, q, 0);
  ivec2 n[4] = ivec2[4](ivec2(1, 0), ivec2(0, 1), ivec2(-1, 0), ivec2(0, -1));
  ivec2 R = ivec2(uRes);
  if (!side(d)) {
    if (uOutline > 0.5 && d.a <= 0.0) {
      for (int i = 0; i < 4; i++) {
        ivec2 p = q + n[i];
        if (p.x < 0 || p.y < 0 || p.x >= R.x || p.y >= R.y) continue;
        if (side(texelFetch(uData, p, 0))) {
          oColor = vec4(4.0 / 255.0, 2.0 / 255.0, 6.0 / 255.0, 1.0);
          oEmis = vec4(0.0, 0.0, 0.0, 1.0);
          oId = vec4(0.0, 0.0, 0.0, 1.0);
          return;
        }
      }
    }
    discard;
  }
  vec3 c = texelFetch(uCol, q, 0).rgb * 255.0;
  bool em = d.b > 0.5;
  if (!em) {
    float z = zAt(d);
    for (int i = 0; i < 4; i++) {
      ivec2 p = q + n[i];
      if (p.x < 0 || p.y < 0 || p.x >= R.x || p.y >= R.y) continue;
      vec4 e = texelFetch(uData, p, 0);
      if (e.a > 0.0 && zAt(e) > z + 5.0) { c = floor(c * vec3(0.25, 0.2, 0.3)); break; }
    }
  }
  c /= 255.0;
  oColor = vec4(c, 1.0);
  oEmis = vec4(em ? c * uEmisGain : vec3(0.0), 1.0);
  oId = vec4(uId.r, uId.g, uId.b, 1.0);
}
`;

class Batch {
  readonly geo = new InstancedBufferGeometry();
  readonly depthMesh: Mesh;
  readonly shadeMesh: Mesh;
  private readonly attrs: InstancedBufferAttribute[];
  constructor(
    depthMat: RawShaderMaterial,
    shadeMat: RawShaderMaterial,
    names: string[],
    private readonly cap: number,
  ) {
    const q = unitQuad();
    this.geo.setAttribute('position', q.getAttribute('position'));
    this.geo.setIndex(q.getIndex());
    this.attrs = names.map((nm) => {
      const a = new InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(DynamicDrawUsage);
      this.geo.setAttribute(nm, a);
      return a;
    });
    this.geo.instanceCount = 0;
    this.depthMesh = new Mesh(this.geo, depthMat);
    this.shadeMesh = new Mesh(this.geo, shadeMat);
    this.depthMesh.frustumCulled = false;
    this.shadeMesh.frustumCulled = false;
  }
  /** Upload n instances from a flat array with `stride` floats per instance (4 per attribute, in order). */
  upload(src: Float32Array, n: number, stride: number): void {
    n = Math.min(n, this.cap);
    const k = this.attrs.length;
    for (let a = 0; a < k; a++) {
      const at = this.attrs[a]!;
      const dst = at.array as Float32Array;
      if (stride === k * 4) {
        // the list's layout is exactly the attributes' (vec4 after vec4): one strided copy per attribute
        for (let i = 0; i < n; i++) {
          const s = i * stride + a * 4;
          const d = i * 4;
          dst[d] = src[s]!;
          dst[d + 1] = src[s + 1]!;
          dst[d + 2] = src[s + 2]!;
          dst[d + 3] = src[s + 3]!;
        }
      }
      at.clearUpdateRanges();
      at.addUpdateRange(0, n * 4);
      at.needsUpdate = true;
    }
    this.geo.instanceCount = n;
    this.depthMesh.visible = n > 0;
    this.shadeMesh.visible = n > 0;
  }
  dispose(): void {
    this.geo.dispose();
  }
}

export class MouthPass {
  /** Stage 1 (depth only) and stage 2 (shaded colour + data) targets. */
  private readonly depthRT: WebGLRenderTarget;
  private readonly rt: WebGLRenderTarget;
  private readonly depthScene = new Scene();
  private readonly shadeScene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly uniforms: Record<string, { value: unknown }>;
  private readonly tubes: Batch;
  private readonly anns: Batch;
  private readonly stamps: Batch;
  private readonly mats: RawShaderMaterial[] = [];
  private lastVersion = -1;
  private lastVX = NaN;
  private lastVY = NaN;
  /** Instance counts of the last render. */
  stats = { tubes: 0, stamps: 0, anns: 0 };
  /** The two compose quads (back, front) for the compositor scene. */
  readonly composeBack: Mesh;
  readonly composeFront: Mesh;

  constructor(compositorScene: Scene, emisGain: { value: number }) {
    const depthTexture = new DepthTexture(LOGICAL_W, LOGICAL_H, UnsignedIntType);
    depthTexture.minFilter = NearestFilter;
    depthTexture.magFilter = NearestFilter;
    this.depthRT = new WebGLRenderTarget(LOGICAL_W, LOGICAL_H, {
      type: UnsignedByteType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      depthTexture,
    });
    this.rt = new WebGLRenderTarget(LOGICAL_W, LOGICAL_H, {
      type: UnsignedByteType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      count: 2,
    });
    const ramp = new Float32Array(44 * 3);
    let o = 0;
    for (const r of [MOUTH_RAMPS.black, MOUTH_RAMPS.red, MOUTH_RAMPS.pale, MOUTH_RAMPS.bone, MOUTH_RAMPS.maw])
      for (const c of r) {
        ramp[o++] = c[0];
        ramp[o++] = c[1];
        ramp[o++] = c[2];
      }
    const noise = dataTexture(mouthNoiseTable(), MOUTH_NOISE_W, MOUTH_NOISE_H, RGBAFormat, FloatType);
    this.uniforms = {
      uRes: { value: new Vector2(LOGICAL_W, LOGICAL_H) },
      uView: { value: new Vector2() },
      uRamp: { value: ramp },
      uLK: { value: new Vector3() },
      uLF: { value: new Vector3() },
      uLB: { value: new Vector3() },
      uHV: { value: new Vector3() },
      uT: { value: 0 },
      uClip0: { value: new Vector4() },
      uClip1: { value: new Vector4() },
      uNoise: { value: noise },
      uWounds: { value: new Float32Array(MAX_WOUNDS * 4) },
      uNW: { value: 0 },
      uDepth: { value: depthTexture },
    };
    const mk = (vs: string, fs: string, prepass: boolean): RawShaderMaterial => {
      const m = new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: vs,
        fragmentShader: fs,
        uniforms: this.uniforms,
        depthTest: prepass,
        depthWrite: prepass,
        depthFunc: LessDepth,
        blending: NoBlending,
        transparent: false,
        side: DoubleSide,
      });
      if (prepass) m.colorWrite = false;
      this.mats.push(m);
      return m;
    };
    this.tubes = new Batch(
      mk(TUBE_VERT, TUBE_FRAG(true), true),
      mk(TUBE_VERT, TUBE_FRAG(false), false),
      ['aA', 'aB', 'aC', 'aD'],
      MAX_TUBES,
    );
    this.anns = new Batch(
      mk(ANN_VERT, ANN_FRAG(true), true),
      mk(ANN_VERT, ANN_FRAG(false), false),
      ['aA', 'aB', 'aC', 'aD', 'aE'],
      MAX_ANN,
    );
    this.stamps = new Batch(
      mk(STAMP_VERT, STAMP_FRAG(true), true),
      mk(STAMP_VERT, STAMP_FRAG(false), false),
      ['aA', 'aB', 'aC', 'aD'],
      MAX_STAMPS,
    );
    // the prototype's order: tubes (coils, neck, funnel), then the throat and lips (annuli), then the stamps
    for (const [b, i] of [
      [this.tubes, 0],
      [this.anns, 1],
      [this.stamps, 2],
    ] as const) {
      b.depthMesh.renderOrder = i;
      b.shadeMesh.renderOrder = i;
      this.depthScene.add(b.depthMesh);
      this.shadeScene.add(b.shadeMesh);
    }

    const compose = (back: boolean): Mesh => {
      const m = new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: COMPOSE_VERT,
        fragmentShader: COMPOSE_FRAG,
        uniforms: {
          uCol: { value: this.rt.textures[0] },
          uData: { value: this.rt.textures[1] },
          uBack: { value: back ? 1 : 0 },
          uOutline: { value: 0 },
          uEmisGain: emisGain,
          uId: { value: new Vector4(1, 0, 1, 0) },
          uRes: { value: new Vector2(LOGICAL_W, LOGICAL_H) },
        },
        depthTest: false,
        depthWrite: false,
        blending: NoBlending,
        transparent: true,
        side: DoubleSide,
      });
      this.mats.push(m);
      const mesh = new Mesh(unitQuad(), m);
      mesh.frustumCulled = false;
      mesh.visible = false;
      compositorScene.add(mesh);
      return mesh;
    };
    this.composeBack = compose(true);
    this.composeFront = compose(false);
  }

  hide(): void {
    this.composeBack.visible = false;
    this.composeFront.visible = false;
  }

  /** Render the list into the Mouth's own targets (once per list version and view). */
  render(renderer: WebGLRenderer, L: MouthDrawList, view: ViewRect): void {
    if (L.version === this.lastVersion && view.x0 === this.lastVX && view.y0 === this.lastVY) return;
    this.lastVersion = L.version;
    this.lastVX = view.x0;
    this.lastVY = view.y0;
    const u = this.uniforms;
    (u.uView!.value as Vector2).set(view.x0, view.y0);
    u.uT!.value = L.t;
    // the prototype's lights (y-up): key, fill, back; the sky rig turns them 180° in the screen plane
    const s = L.sky ? -1 : 1;
    const nz = (x: number, y: number, z: number): [number, number, number] => {
      const l = Math.hypot(x, y, z);
      return [x / l, y / l, z / l];
    };
    const LK = nz(0.5 * s, -0.62 * s, 0.6);
    const LF = nz(-0.85 * s, 0.15 * s, 0.35);
    const LB = nz(0.75 * s, -0.25 * s, -0.6);
    const HV = nz(LK[0], LK[1], LK[2] + 1);
    (u.uLK!.value as Vector3).set(...LK);
    (u.uLF!.value as Vector3).set(...LF);
    (u.uLB!.value as Vector3).set(...LB);
    (u.uHV!.value as Vector3).set(...HV);
    const c = L.clip;
    (u.uClip0!.value as Vector4).set(c[0]!, c[1]!, c[2]!, c[3]!);
    (u.uClip1!.value as Vector4).set(c[4]!, c[5]!, c[6]!, c[7]!);
    (u.uWounds!.value as Float32Array).set(L.wounds);
    u.uNW!.value = L.nWounds;
    this.tubes.upload(L.tubes, L.nTubes, TUBE_STRIDE);
    this.anns.upload(L.anns, L.nAnn, ANN_STRIDE);
    this.stamps.upload(L.stamps, L.nStamps, STAMP_STRIDE);
    this.stats.tubes = L.nTubes;
    this.stats.anns = L.nAnn;
    this.stats.stamps = L.nStamps;
    const prevTarget = renderer.getRenderTarget();
    renderer.setClearColor(0x000000, 0);
    // 1. depth: the nearest z per pixel
    renderer.setRenderTarget(this.depthRT);
    renderer.clear(false, true, false);
    renderer.render(this.depthScene, this.camera);
    // 2. shade: only the fragment the depth stage kept
    renderer.setRenderTarget(this.rt);
    renderer.clear(true, false, false);
    renderer.render(this.shadeScene, this.camera);
    renderer.setRenderTarget(prevTarget);
  }

  /** Arm one compose quad (back or front) at render order `order`, with the titan id rank. */
  stage(back: boolean, order: number, ownOutline: boolean): void {
    const m = back ? this.composeBack : this.composeFront;
    m.visible = true;
    m.renderOrder = order;
    const u = (m.material as RawShaderMaterial).uniforms;
    u.uOutline!.value = ownOutline ? 1 : 0;
    (u.uId!.value as Vector4).set(1, Math.min(255, order) / 255, 1, 0);
  }

  dispose(): void {
    this.rt.dispose();
    this.depthRT.depthTexture?.dispose();
    this.depthRT.dispose();
    for (const m of this.mats) m.dispose();
    this.tubes.dispose();
    this.anns.dispose();
    this.stamps.dispose();
    (this.uniforms.uNoise!.value as { dispose(): void }).dispose();
  }
}

export const MOUTH_PASS_LIMITS = { MAX_TUBES, MAX_STAMPS, MAX_ANN };
