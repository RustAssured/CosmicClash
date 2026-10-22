import {
  DataTexture,
  DoubleSide,
  GLSL3,
  Mesh,
  NearestFilter,
  RawShaderMaterial,
  RedFormat,
  UnsignedByteType,
  Vector2,
  Vector4,
  type Scene,
} from 'three';
import { unitQuad } from './gl';
import { LAYER_VERT } from './shaders';
import type { SignatureFx } from './signature';

/**
 * GPU half of the signature animation (signature.ts, docs/SIGNATURE.md): LAYER_FRAG's placement (facing, lean, anchor) gives
 * the destination cell; the cell's role says how it samples the body map. Same outputs (colour, emissive, id) and blending as
 * a plain layer, so the unified look (outline, seams, palette snap) treats it like any body.
 *
 * Tiers (quality.ts): 0 = the rigid spin only (one fetch, no lensed images); 1+ = the dissolved differential twist, the mirror
 * fallback behind the occluder and the lensed far side (≈ 6 texel fetches per body pixel: a 224 × 208 body is ≈ 0.3 M fetches).
 */
export const SIG_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec2 uRes;
uniform sampler2D uTex;      // RGBA8 body map, row 0 = top
uniform sampler2D uEmis;     // R8
uniform int uHasEmis;
uniform vec2 uSize;          // body w, h in cells
uniform vec4 uPlace;         // ax, ay, anchorX, anchorY
uniform vec2 uFL;            // facing (+1/-1), lean
uniform float uAlpha;
uniform float uEmisGain;
uniform vec4 uId;
uniform sampler2D uWet;
uniform int uHasWet;
uniform sampler2D uRole;     // R8 per cell: 0 still, 1 flow, 2 occluder, 3 lensed
uniform vec4 uFrame;         // cx, cy, cos tilt, sin tilt
uniform vec4 uPlane;         // squash, rIn, rOut, shearK
uniform vec4 uSpin;          // rigid angle, shear A angle (at rIn), shear B angle, weight of A
uniform vec4 uPulse;         // amp, phase (rate · t), wave, 0
uniform vec4 uDop;           // doppler, dir x, dir y, 0
uniform vec4 uStreak;        // amp, arms, wind, 0
uniform vec4 uLens;          // hole, lensRing, lensSpin, lensGain
uniform int uTier;

layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oEmis;
layout(location = 2) out vec4 oId;

const float BY[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);

int roleAt(ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= int(uSize.x) || c.y >= int(uSize.y)) return -1;
  return int(texelFetch(uRole, c, 0).r * 255.0 + 0.5);
}
// sprite-local offset from the centre <-> flow plane (u along the tilted major axis, v unsquashed)
vec2 toPlane(vec2 d) {
  return vec2(d.x * uFrame.z + d.y * uFrame.w, (-d.x * uFrame.w + d.y * uFrame.z) / uPlane.x);
}
vec2 fromPlane(vec2 q) {
  float vs = q.y * uPlane.x;
  return vec2(q.x * uFrame.z - vs * uFrame.w, q.x * uFrame.w + vs * uFrame.z);
}
ivec2 cellOfNearest(vec2 q) { return ivec2(floor(uFrame.xy + fromPlane(q))); }
float ringOf(ivec2 c) { return length(toPlane(vec2(c) + 0.5 - uFrame.xy)); }
// the cell for plane point q, keeping its RING: in a squashed plane one screen row spans several plane units, so the nearest
// cell often belongs to the next ring out or in (fine painted rings turn to grain as they rotate); of the cell and its
// vertical neighbours take the one whose own plane radius is closest to q's
ivec2 cellOf(vec2 q) {
  ivec2 c = cellOfNearest(q);
  if (uTier == 0) return c;
  float r = length(q);
  float e = abs(ringOf(c) - r);
  ivec2 u = c + ivec2(0, -1);
  ivec2 d = c + ivec2(0, 1);
  float eu = abs(ringOf(u) - r);
  float ed = abs(ringOf(d) - r);
  if (eu < e && eu <= ed) return u;
  if (ed < e) return d;
  return c;
}
// where a flow point at plane position q (destination) came from: back along the spin and the twist, in along the pulse
vec2 flowSource(vec2 q, float shear) {
  float r = length(q);
  float a = atan(q.y, q.x);
  float rin = uPlane.y;
  float rr = max(r, rin);
  float f = pow(rin / rr, uPlane.w) - pow(rin / uPlane.z, uPlane.w);
  a -= uSpin.x + shear * max(f, 0.0);
  r *= 1.0 - uPulse.x * sin(uPulse.y - uPulse.z * r);
  return vec2(cos(a), sin(a)) * r;
}
// a flow cell to sample for plane point q: the cell itself, or its mirror across the plane's major axis when q is hidden
// behind the occluder (the painted map has no far side there); false = nothing to sample
bool flowCell(vec2 q, out ivec2 c) {
  c = cellOf(q);
  if (roleAt(c) == 1) return true;
  if (uTier == 0) return false;
  c = cellOf(vec2(q.x, -q.y));
  if (roleAt(c) == 1) return true;
  // both hidden (a painter may cover part of the near side too): the nearest visible angle on the same ring, so the ring's
  // light carries on round instead of leaving a hole that orbits
  float r = length(q);
  float a = atan(q.y, q.x);
  for (int k = 1; k <= 4; k++) {
    float o = float(k) * 0.3;
    c = cellOf(vec2(cos(a + o), sin(a + o)) * r);
    if (roleAt(c) == 1) return true;
    c = cellOf(vec2(cos(a - o), sin(a - o)) * r);
    if (roleAt(c) == 1) return true;
  }
  return false;
}
float dopGain(vec2 q) { return max(0.2, 1.0 + uDop.x * dot(q, uDop.yz) / uPlane.z); }

void main() {
  ivec2 P = ivec2(floor(gl_FragCoord.x), int(floor(uRes.y - gl_FragCoord.y)));
  // LAYER_FRAG's placement (layerMap.ts::sourceCell), unchanged
  float ly = float(P.y) - uPlace.y + uPlace.w;
  float num = uFL.y * (uPlace.w - ly);
  float den = max(1.0, uPlace.w);
  float shift = floor(num / den + 0.5);
  if ((shift - 0.5) * den > num) shift -= 1.0;
  else if ((shift + 0.5) * den <= num) shift += 1.0;
  float d0 = float(P.x) - uPlace.x - shift;
  float lx = uFL.x > 0.0 ? d0 + uPlace.z : uPlace.z - 1.0 - d0;
  if (lx < 0.0 || ly < 0.0) discard;
  ivec2 cell = ivec2(int(lx), int(ly));
  if (cell.x >= int(uSize.x) || cell.y >= int(uSize.y)) discard;

  int role = roleAt(cell);
  ivec2 src = cell;
  vec3 tint = vec3(1.0);
  bool occ = false;
  vec2 d = vec2(cell) + 0.5 - uFrame.xy;
  if (role == 1) {
    vec2 q = toPlane(d);
    // two bounded twists dissolved by a screen-locked Bayer threshold (pixel art: no blended ghosts)
    float th = (BY[(P.y & 3) * 4 + (P.x & 3)] + 0.5) / 16.0;
    float shear = uTier == 0 ? 0.0 : th < uSpin.w ? uSpin.y : uSpin.z;
    vec2 qs = flowSource(q, shear);
    ivec2 c;
    if (flowCell(qs, c)) {
      src = c;
      float arm = 1.0 + uStreak.x * cos(uStreak.y * atan(qs.y, qs.x) - uStreak.z * length(qs));
      tint = vec3(arm * dopGain(q) / dopGain(toPlane(vec2(c) + 0.5 - uFrame.xy)));
    } else occ = true;
  } else if (role == 3 && uTier > 0) {
    // the far side of the flow, bent round the occluder: the arc's own cells stream round the centre (screen circle) at the
    // flow's spin × lensSpin, wrapping within their half (over the top, under the bottom). On screen the far side runs
    // opposite to the near side, so the image at angle θ came from θ + w. A hole in the arc streams with it.
    vec4 own = texelFetch(uTex, cell, 0);
    if (own.a <= 0.0) discard;
    float rho = length(d);
    float th = atan(d.y, d.x);
    float base = d.y < 0.0 ? -3.14159265 : 0.0;
    float ts = base + mod(th - base + uSpin.x * uLens.z, 3.14159265);
    ivec2 c = ivec2(floor(uFrame.xy + vec2(cos(ts), sin(ts)) * rho));
    // past the arc's tapered ends there is nothing to stream in: the cell keeps its own light
    if (roleAt(c) != 3) c = cell;
    vec4 s = texelFetch(uTex, c, 0);
    if (s.a <= 0.0) discard;
    vec3 col = min(s.rgb * uLens.w, vec3(1.0));
    float e = uId.a > 0.5 ? 1.0 : uHasEmis == 1 ? texelFetch(uEmis, c, 0).r : 0.0;
    float al = s.a * uAlpha;
    oColor = vec4(col, al);
    oEmis = vec4(col * e * uEmisGain, al);
    float wet = uHasWet == 1 ? texelFetch(uWet, c, 0).r : uId.b;
    oId = vec4(uId.r, uId.g, wet * uId.r, al);
    return;
  }
  vec4 c = texelFetch(uTex, src, 0);
  // the flow left this pixel empty: over the occluder that is the occluder, elsewhere nothing
  if ((occ || c.a <= 0.0) && role == 1) {
    if (length(d) >= uLens.x) discard;
    src = ivec2(floor(uFrame.xy));
    c = texelFetch(uTex, src, 0);
    tint = vec3(1.0);
  }
  if (c.a <= 0.0) discard;
  // hue-preserving relight: what would clip bleeds toward white instead of skewing the hue (orange overdriven turns green)
  vec3 rgb = c.rgb * tint;
  float mx = max(rgb.r, max(rgb.g, rgb.b));
  if (mx > 1.0) rgb = mix(rgb / mx, vec3(1.0), min(0.5, (mx - 1.0) * 0.5));
  float e = uId.a > 0.5 ? 1.0 : uHasEmis == 1 ? texelFetch(uEmis, src, 0).r : 0.0;
  float a = c.a * uAlpha;
  oColor = vec4(rgb, a);
  oEmis = vec4(rgb * e * uEmisGain, a);
  float wet = uHasWet == 1 ? texelFetch(uWet, src, 0).r : uId.b;
  oId = vec4(uId.r, uId.g, wet * uId.r, a);
}
`;

export interface SigSlot {
  mesh: Mesh;
  material: RawShaderMaterial;
  rect: Vector4;
  size: Vector2;
  place: Vector4;
  fl: Vector2;
}

/** Signature slots (one per signed body in a frame) and the role textures, in the layer compositor's scene. */
export class SignaturePass {
  static readonly MAX = 4;
  readonly slots: SigSlot[] = [];
  private readonly roles = new Map<string, { src: Uint8Array; version: number; tex: DataTexture }>();

  constructor(
    scene: Scene,
    res: Vector2,
    emisGain: { value: number },
    configure: (m: RawShaderMaterial) => void,
  ) {
    for (let i = 0; i < SignaturePass.MAX; i++) {
      const rect = new Vector4();
      const size = new Vector2();
      const place = new Vector4();
      const fl = new Vector2(1, 0);
      const material = new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: LAYER_VERT,
        fragmentShader: SIG_FRAG,
        uniforms: {
          uRes: { value: res },
          uRect: { value: rect },
          uTex: { value: null },
          uEmis: { value: null },
          uHasEmis: { value: 0 },
          uSize: { value: size },
          uPlace: { value: place },
          uFL: { value: fl },
          uAlpha: { value: 1 },
          uEmisGain: emisGain,
          uId: { value: new Vector4() },
          uWet: { value: null },
          uHasWet: { value: 0 },
          uRole: { value: null },
          uFrame: { value: new Vector4() },
          uPlane: { value: new Vector4() },
          uSpin: { value: new Vector4() },
          uPulse: { value: new Vector4() },
          uDop: { value: new Vector4() },
          uStreak: { value: new Vector4() },
          uLens: { value: new Vector4() },
          uTier: { value: 1 },
        },
        depthTest: false,
        depthWrite: false,
        transparent: true,
        side: DoubleSide,
      });
      configure(material);
      const mesh = new Mesh(unitQuad(), material);
      mesh.frustumCulled = false;
      mesh.visible = false;
      scene.add(mesh);
      this.slots.push({ mesh, material, rect, size, place, fl });
    }
  }

  hide(): void {
    for (const s of this.slots) s.mesh.visible = false;
  }

  /** Write `fx` into slot `s`'s signature uniforms (the compositor sets the plain-layer ones). */
  apply(s: SigSlot, id: string, fx: SignatureFx, w: number, h: number, tier: number): void {
    const u = s.material.uniforms;
    u.uRole!.value = this.roleTex(id, fx, w, h);
    (u.uFrame!.value as Vector4).set(fx.cx, fx.cy, Math.cos(fx.tilt), Math.sin(fx.tilt));
    (u.uPlane!.value as Vector4).set(fx.squash, fx.rIn, fx.rOut, fx.shearK);
    // the twist: rigid spin, and two sawtooth shears half a period apart, each weighted by a triangle (0 at its reset)
    const ph = fx.shearPeriod > 0 ? fx.t / fx.shearPeriod : 0;
    const pa = ph - Math.floor(ph);
    const pb = pa < 0.5 ? pa + 0.5 : pa - 0.5;
    const span = fx.shearRate * fx.shearPeriod;
    // a sharpened triangle: one twist alone most of the time, a short dissolve around each reset (an even mix of two different
    // twists reads as speckle)
    const tri = 1 - Math.abs(2 * pa - 1);
    const k = Math.min(1, Math.max(0, (tri - 0.3) / 0.4));
    (u.uSpin!.value as Vector4).set(fx.spin, span * pa, span * pb, k * k * (3 - 2 * k));
    (u.uPulse!.value as Vector4).set(fx.pulseAmp, fx.pulseRate * fx.t, fx.pulseWave, 0);
    (u.uDop!.value as Vector4).set(fx.doppler, fx.dopplerX, fx.dopplerY, 0);
    (u.uStreak!.value as Vector4).set(fx.streak, fx.streakArms, fx.streakWind, 0);
    (u.uLens!.value as Vector4).set(fx.hole, fx.lensRing, fx.lensSpin, fx.lensGain);
    u.uTier!.value = tier;
  }

  /** The role texture of layer `id` (one per body layer; a new match's array replaces the old texture). */
  private roleTex(id: string, fx: SignatureFx, w: number, h: number): DataTexture {
    let e = this.roles.get(id);
    if (e && e.src === fx.roles && e.version === fx.rolesVersion) return e.tex;
    if (!e || e.src !== fx.roles || e.tex.image.width !== w || e.tex.image.height !== h) {
      e?.tex.dispose();
      const tex = new DataTexture(fx.roles, w, h, RedFormat, UnsignedByteType);
      tex.minFilter = NearestFilter;
      tex.magFilter = NearestFilter;
      tex.generateMipmaps = false;
      tex.unpackAlignment = 1;
      e = { src: fx.roles, version: fx.rolesVersion, tex };
      this.roles.set(id, e);
    }
    e.version = fx.rolesVersion;
    e.tex.needsUpdate = true;
    return e.tex;
  }

  dispose(): void {
    for (const s of this.slots) s.material.dispose();
    for (const e of this.roles.values()) e.tex.dispose();
    this.roles.clear();
  }
}
