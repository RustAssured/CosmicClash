import { Rng, type StageInfo } from '@/contracts';
import { STAGE_INFO } from '../info';
import { addDustBank } from '../toolkit/bank';
import { REF_X0, REF_Y0, addHeroStars, atRef, screenOf } from '../toolkit/compose';
import { mixRgb, paletteRamps, rampAt, scale } from '../toolkit/color';
import { SceneryBase } from '../toolkit/base';
import type { KitLayer, SceneryKit } from '../toolkit/kit';
import { addNebula } from '../toolkit/nebula';
import { layerBounds, makeStarField } from '../toolkit/stars';
import type { PrepareStep, SceneryFrame, SceneryInit, SceneryLook } from '../types';
import type { InstancedBufferAttribute } from 'three';
import { type InstancedBufferGeometry } from 'three';

/**
 * FRACTURED ORBITAL MAUSOLEUM — solemn, sacred; the Witness's ground. A dying red-violet sun behind a broken orbital ring;
 * dead moons, one of them split; the truss arcs of a megastructure that once girdled a world; bone-white monoliths with the
 * last gold glyphs still glowing; cathedral fragments drifting in the fight plane; ruin shards crossing in front.
 *
 * Occupied space, reacting to the fight (≥ 3 reactive depth layers):
 *  - the ring and arcs ripple with shock rings and bend toward gravity wells (far, gently);
 *  - the monoliths' glyphs kindle with the fight's intensity, and they shiver under nearby blasts (mid);
 *  - cathedral fragments shift with every blow and wake, and SMALL ONES BREAK on large collisions: a big shockwave splits
 *    each fragment it reaches into two halves that drift apart and stay broken (near);
 *  - wake dust in the fight plane swirls behind moving bodies; ruin shards (foreground pass) are shoved by blasts.
 * Value: everything that crosses the fight band is dark (bone and slate low steps); light lives above and below it.
 */

const LOOK: SceneryLook = {
  // D34: lifted (it read muddy next to the original's stages); the fight band still compresses, more gently
  exposure: 1.3,
  contrast: 1.1,
  bloomThreshold: 0.95,
  bloomGain: 0.55,
  // low: the sun is large and its occluders (ring, monoliths) would cut flat shadow wedges across the sky
  godRayGain: 0.12,
  godRayGas: 0.06,
  godRayHalo: 90,
  godRayDecay: 0.972,
  vignette: 0.5,
  foreground: { color: [0.16, 0.08, 0.14], alpha: 1, density: 0.6, shards: 0.35 },
  spriteHalo: { strength: 0.32, radius: 10, desat: 0.4, rim: 0.55, rimReach: 1, lift: 0.16 },
  // the fight band stays dark: highlights there are compressed hard (both titans read on it)
  fightBand: { top: -150, bottom: 120, feather: 90, ceiling: 0.5, keep: 0.45 },
};

const SUN_PARALLAX = 0.04;
const SUN = { sx: 520, sy: 22 } as const;

/* Dead moons: discs with stepped terminator shading, craters and (one) a fracture. */
const MOONS_FRAGMENT = /* glsl */ `
uniform vec4 uMoon[3];     // x, y (layer px), radius, fractured (0/1)
uniform vec3 uAsh0;
uniform vec3 uAsh1;
uniform vec3 uRimC;
uniform vec2 uSunDir;      // screen-space direction toward the sun
uniform float uForceK;
void main() {
  vec2 sp = warpByForces(screenPx(), -uForceK);
  vec2 lp = sp + uView * uParallax;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 3; i++) {
    vec4 m = uMoon[i];
    vec2 d = (lp - m.xy) / m.z;
    float r2 = dot(d, d);
    if (r2 > 1.0) continue;
    vec3 n = vec3(d, sqrt(1.0 - r2));
    float lam = dot(n, normalize(vec3(uSunDir, 0.35)));
    float band = floor(clamp(lam, 0.0, 1.0) * 3.0 + 0.5) / 3.0;
    float crater = smoothstep(0.55, 0.75, vnoise(lp * 0.09 + float(i) * 13.0)) * 0.35;
    vec3 c = mix(uAsh0, uAsh1, band) * (1.0 - crater);
    c += uRimC * smoothstep(0.82, 1.0, sqrt(r2)) * clamp(lam + 0.3, 0.0, 1.0) * 0.6;
    if (m.w > 0.5) {
      // the split moon: a dark fracture line, and the wedge beyond it gone
      float f = abs(vnoise(vec2(lp.y * 0.05, 3.0)) - 0.5) * m.z * 0.3 - (lp.x - m.x - m.z * 0.18);
      if (f < -2.0 && d.y > -0.2) continue;
      if (abs(f) < 2.0) c *= 0.25;
    }
    acc = vec4(c, 1.0);
  }
  if (acc.a <= 0.0) discard;
  o = acc;
}
`;

/* The broken orbital ring around the sun, and the truss arcs of the megastructure: slate, edge-lit, see-through between struts. */
const RINGS_FRAGMENT = /* glsl */ `
uniform vec4 uRing;        // cx, cy (layer px), radii a, b
uniform float uRingT;      // half thickness (px)
uniform vec4 uArc[2];      // cx, cy (layer px), radius, half thickness
uniform vec3 uSlate0;
uniform vec3 uSlate1;
uniform vec3 uRimC;
uniform float uForceK;
void main() {
  vec2 sp = warpByForces(screenPx(), -uForceK);
  vec2 lp = sp + uView * uParallax;
  vec4 acc = vec4(0.0);
  // megastructure arcs (behind the ring): two rails, diagonal struts, broken spans
  for (int i = 0; i < 2; i++) {
    vec4 a = uArc[i];
    vec2 d = lp - a.xy;
    float r = length(d);
    float off = r - a.z;
    if (abs(off) > a.w) continue;
    float along = atan(d.y, d.x) * a.z;
    if (vnoise(vec2(along / 160.0, float(i) * 9.0)) > 0.68) continue;
    bool rail = abs(off) > a.w - 3.0;
    float u = fract((along + off * 1.4) / 26.0);
    float v = fract((along - off * 1.4) / 26.0);
    bool strut = u < 0.1 || v < 0.1;
    if (!(rail || strut)) continue;
    float lit = smoothstep(-a.w, a.w, -off);
    acc = vec4(mix(uSlate0, uSlate1, 0.2 + 0.5 * lit) + uRimC * (rail && off < 0.0 ? 0.25 : 0.0), 1.0);
  }
  // the broken ring, slowly turning
  vec2 e = (lp - uRing.xy) / uRing.zw;
  float er = length(e);
  if (abs(er - 1.0) > 0.4) {
    if (acc.a <= 0.0) discard;
    o = acc;
    return;
  }
  float ang = atan(e.y, e.x) + uTime * 0.0035;
  float th = uRingT / uRing.w * (0.7 + 0.5 * vnoise(vec2(ang * 5.0, 1.3)));
  if (abs(er - 1.0) < th && vnoise(vec2(ang * 2.6, 4.1)) < 0.6) {
    float lit = smoothstep(0.2, -0.6, e.y);
    vec3 c = mix(uSlate0, uSlate1, 0.15 + 0.6 * lit);
    c += uRimC * smoothstep(th * 0.4, th, er - 1.0) * lit * 0.7;
    acc = vec4(c, 1.0);
  }
  if (acc.a <= 0.0) discard;
  o = acc;
}
`;

/* Bone monoliths with chipped tops, stone courses and the last gold glyphs (kindled by the fight). */
const MONOLITH_FRAGMENT = /* glsl */ `
uniform vec4 uSlab[8];     // x (layer px), top y, half width, tilt (px per px)
uniform int uNSlab;
uniform vec3 uBone0;
uniform vec3 uBone1;
uniform vec3 uGold;
uniform vec3 uRimC;
uniform float uSunSide;    // +1 the sun is to the right, -1 to the left
uniform float uForceK;
void main() {
  vec2 sp = warpByForces(screenPx(), -uForceK);
  vec2 lp = sp + uView * uParallax;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= uNSlab) break;
    vec4 s = uSlab[i];
    float dy = lp.y - s.y;
    float x = lp.x - (s.x + s.w * dy);
    float hw = s.z * (1.0 + 0.0012 * max(dy, 0.0));
    // cheap rejection first: the noise below is the expensive part
    if (abs(x) > hw || dy < -12.0) continue;
    float chip = (vnoise(vec2(lp.x * 0.12, float(i) * 7.1)) - 0.5) * 14.0 + (vnoise(vec2(lp.x * 0.5, float(i) * 3.3)) - 0.5) * 5.0;
    float top = dy - chip;
    if (top < 0.0) continue;
    float side = x / hw;
    float lit = smoothstep(0.5, 0.95, side * uSunSide);
    vec3 c = mix(uBone0, uBone1, 0.15 + 0.45 * lit);
    c *= 0.82 + 0.18 * step(0.5, fract(dy / 16.0 + 0.5 * step(0.5, fract(x / 40.0))));
    vec2 g = vec2(floor((x + hw) / 6.0), floor(dy / 20.0));
    float glyph = step(fract(dy / 20.0), 0.14) * step(fract((x + hw) / 6.0), 0.6) * step(abs(side), 0.62)
      * step(0.45, vnoise(g * 1.7 + float(i) * 5.0)) * step(30.0, dy);
    c = mix(c, uGold * (0.2 + 1.1 * uIntensity), glyph * 0.9);
    c += uRimC * smoothstep(4.0, 0.0, top) * 0.5;
    acc = vec4(c, 1.0);
  }
  if (acc.a <= 0.0) discard;
  o = acc;
}
`;

/* Cathedral fragments: arch windows, pillar drums, rose windows; drifting, turning, shoved by blows, broken by large collisions. */
const FRAG_HEADER_VERT = /* glsl */ `
uniform float uParallax;
uniform float uForceK;
`;
const FRAG_VERT = /* glsl */ `
float par = uParallax + aF1.w * 0.06;
vec2 c = aF0.xy - floor(uView * par + 0.5);
c += curl2(aF0.xy * 0.004 + uFlow * 0.01) * 6.0;
c = warpByForces(c, uForceK);
float size = aF0.z;
float ext = size * 2.4 + 4.0;
if (c.x < -ext || c.y < -ext || c.x > uRes.x + ext || c.y > uRes.y + ext) {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vQ = vec2(0.0); vP = vec4(0.0); vB = vec2(0.0);
  return;
}
float ang = aF1.x + uTime * aF1.y;
float cs = cos(ang);
float sn = sin(ang);
vec2 q = position.xy * 2.2;
vec2 off = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs) * size;
gl_Position = toNdc(camWarp(c, par) + off * camScale(par));
vQ = q;
vP = vec4(aF0.w, aF1.z, ang, 0.0);
float age = aBrk.x > 0.0 ? max(0.0, uTime - aBrk.x) : -1.0;
vB = vec2(age, aBrk.y);
`;
const FRAG_HEADER_FRAG = /* glsl */ `
uniform vec3 uBone0;
uniform vec3 uBone1;
uniform vec3 uGold;
uniform vec2 uSunDir;
uniform float uAlphaScale;
float shapeOf(float type, vec2 q) {
  if (type < 0.5) {
    // arch window: a slab with a pointed opening
    if (abs(q.x) > 0.7 || abs(q.y) > 0.95) return 0.0;
    float open = abs(q.x) < 0.34 * (1.0 - smoothstep(-0.05, -0.75, q.y)) && q.y < 0.62 ? 1.0 : 0.0;
    return 1.0 - open;
  }
  if (type < 1.5) {
    // pillar drum, fluted
    if (abs(q.x) > 0.36 || abs(q.y) > 0.92) return 0.0;
    return 0.75 + 0.25 * step(0.5, fract(q.x * 5.0));
  }
  // rose window: a ring with spokes
  float r = length(q);
  if (r > 0.9) return 0.0;
  if (r > 0.66) return 1.0;
  float a = atan(q.y, q.x);
  return abs(fract(a * 1.2732) - 0.5) < 0.1 || r < 0.14 ? 1.0 : 0.35;
}
`;
const FRAG_FRAG = /* glsl */ `
vec2 q = vQ;
float alpha = 1.0;
if (vB.x >= 0.0) {
  // broken: the two halves drift apart and turn a little, then stay
  float piece = q.x * vB.y >= 0.0 ? 1.0 : -1.0;
  float sep = min(vB.x * 0.22, 0.75);
  q -= vec2(piece * sep, -sep * 0.35 * piece);
  float tw = piece * sep * 0.5;
  q = vec2(q.x * cos(tw) - q.y * sin(tw), q.x * sin(tw) + q.y * cos(tw));
  alpha = 1.0 - 0.45 * smoothstep(0.0, 4.0, vB.x);
  // a raw edge where it split
  if (abs(q.x) < 0.06 + 0.04 * sin(q.y * 21.0 + vP.y * 9.0)) alpha = 0.0;
}
float s = shapeOf(vP.x, q);
if (s <= 0.0 || alpha <= 0.0) discard;
float lit = clamp(0.5 + 0.5 * dot(normalize(q + 1e-3), normalize(-uSunDir)), 0.0, 1.0);
vec3 c = mix(uBone0, uBone1, floor(lit * 3.0) / 3.0 * 0.6 + 0.1) * s;
if (vP.x > 1.5 && s < 0.5) c = uGold * 0.35;
o = vec4(c, alpha * uAlphaScale);
`;

interface Fragment {
  x: number;
  y: number;
  size: number;
}

export class MausoleumScenery extends SceneryBase {
  readonly id = 'mausoleum' as const;
  readonly look: SceneryLook = { ...LOOK };
  protected readonly noiseSeed = 0x6d4155;
  private info: StageInfo = STAGE_INFO.mausoleum;
  private light: [number, number] = atRef(SUN.sx, SUN.sy, SUN_PARALLAX);
  private view = { x0: REF_X0, y0: REF_Y0 };
  private fragments: KitLayer | null = null;
  private frags: Fragment[] = [];
  private broken: Float32Array = new Float32Array(0);
  private readonly fragParallax = 0.62;

  protected *build(kit: SceneryKit, _ctx: SceneryInit): Generator<PrepareStep, void, void> {
    const arena = this.info.arena;
    const R = paletteRamps(this.info);
    // ramp order of STAGE_INFO.mausoleum: void, nebula, crimson, bone, slate, gold, ash, rose
    const [VOID, NEB, CRIM, BONE, SLATE, GOLD, ASH, ROSE] = [
      R[0]!,
      R[1]!,
      R[2]!,
      R[3]!,
      R[4]!,
      R[5]!,
      R[6]!,
      R[7]!,
    ];
    const rng = new Rng(0x4d41);
    const sunDir: [number, number] = [0.72, -0.69];

    /* ---- 1. the dark, with a red-violet nebula hanging high (kept out of the fight band) ---- */
    addNebula(kit, 'sky', {
      parallax: 0.02,
      scale: 340,
      warp: 1.2,
      octaves: 4,
      thresh: [0.3, 0.92],
      colA: scale(VOID[2]!, 0.9),
      colB: scale(NEB[2]!, 0.9),
      colC: scale(CRIM[3]!, 1.0),
      colD: scale(ROSE[2]!, 0.85),
      gain: 1.5,
      lightDir: [0.7, -0.7],
      litK: 0.6,
      flowSpeed: 0.006,
      seed: [3.1, 7.7],
      mode: 'emit',
      mask: [...atRef(470, 40, 0.02), 520, 150],
      maskMix: 0.75,
      forceK: 0.25,
    });
    kit.addSprites('stars-far', {
      buffer: makeStarField({
        count: 700,
        bounds: layerBounds(arena, 0.04),
        size: [0.55, 1.1],
        base: 0.3,
        boost: 1.5,
        tint: [1, 0.9, 0.95],
        tintWeights: [1, 2, 4, 5, 3, 1],
        seed: 611,
      }),
      parallax: 0.04,
      blend: 'add',
      soft: 4,
      snap: true,
      twinkle: 0.12,
      forceK: 0.5,
    });
    yield 0.1;

    /* ---- 2. the dying sun (the stage light) ---- */
    addHeroStars(kit, 'sun', [
      {
        sx: SUN.sx,
        sy: SUN.sy,
        size: 90,
        core: 7,
        bright: 1.5,
        tint: rampAt(ROSE, 0.85),
        parallax: SUN_PARALLAX,
        rot: 0.3,
      },
    ]);
    yield 0.15;

    /* ---- 3. dead moons ---- */
    const mp = 0.06;
    const m1 = atRef(120, 70, mp);
    const m2 = atRef(300, 26, mp);
    const m3 = atRef(612, 140, mp);
    kit.addFullscreen('moons', MOONS_FRAGMENT, 'normal', mp, {
      uMoon: {
        value: new Float32Array([m1[0], m1[1], 46, 1, m2[0], m2[1], 14, 0, m3[0], m3[1], 24, 0]),
      },
      uAsh0: { value: [...scale(ASH[0]!, 0.9)] },
      uAsh1: { value: [...scale(ASH[3]!, 0.9)] },
      uRimC: { value: [...scale(ROSE[2]!, 0.8)] },
      uSunDir: { value: sunDir },
      uForceK: { value: 0.2 },
    });
    yield 0.25;

    /* ---- 4. the broken orbital ring around the sun, and the megastructure's truss arcs ---- */
    const rp = 0.12;
    const rc = atRef(SUN.sx + 10, SUN.sy + 30, rp);
    const a1 = atRef(320, 900, rp);
    const a2 = atRef(-200, 720, rp);
    kit.addFullscreen('rings', RINGS_FRAGMENT, 'normal', rp, {
      uRing: { value: [rc[0], rc[1], 230, 64] },
      uRingT: { value: 6 },
      uArc: { value: new Float32Array([a1[0], a1[1], 760, 13, a2[0], a2[1], 690, 9]) },
      uSlate0: { value: [...scale(SLATE[0]!, 1.0)] },
      uSlate1: { value: [...scale(SLATE[3]!, 1.0)] },
      uRimC: { value: [...scale(ROSE[3]!, 0.9)] },
      uForceK: { value: 0.45 },
    });
    yield 0.35;

    /* ---- 5. mid nebula: crimson veins high and low, never across the band ---- */
    addNebula(kit, 'veins', {
      parallax: 0.22,
      scale: 170,
      warp: 1.6,
      octaves: 4,
      thresh: [0.48, 0.9],
      colA: scale(CRIM[1]!, 0.6),
      colB: scale(NEB[3]!, 0.75),
      colC: scale(ROSE[2]!, 0.9),
      colD: scale(GOLD[1]!, 0.5),
      gain: 1.3,
      lightDir: [0.7, -0.7],
      litK: 0.8,
      flowSpeed: 0.012,
      seed: [8.3, 1.9],
      mode: 'emit',
      mask: [...atRef(320, 30, 0.22), 640, 90],
      maskMix: 0.8,
      forceK: 0.9,
    });
    yield 0.45;

    /* ---- 6. monoliths: bone slabs rising from below, the last gold glyphs ---- */
    const mop = 0.42;
    const mb = layerBounds(arena, mop);
    const slabs: number[] = [];
    const slabXs = [0.06, 0.2, 0.37, 0.55, 0.71, 0.86, 0.97];
    for (const u of slabXs) {
      const x = mb.x0 + (mb.x1 - mb.x0) * u + rng.range(-20, 20);
      const top = atRef(0, rng.range(130, 215), mop)[1];
      slabs.push(x, top, rng.range(12, 24), rng.range(-0.05, 0.05));
    }
    while (slabs.length < 32) slabs.push(0, 1e6, 0, 0);
    kit.addFullscreen('monoliths', MONOLITH_FRAGMENT, 'normal', mop, {
      uSlab: { value: new Float32Array(slabs) },
      uNSlab: { value: slabXs.length },
      uBone0: { value: [...scale(BONE[0]!, 1.0)] },
      uBone1: { value: [...scale(BONE[3]!, 1.0)] },
      uGold: { value: [...scale(GOLD[2]!, 1.2)] },
      uRimC: { value: [...scale(ROSE[1]!, 0.9)] },
      uSunSide: { value: 1 },
      uForceK: { value: 0.7 },
    });
    yield 0.55;

    /* ---- 7. cathedral fragments drifting through the fight plane (they break on large collisions) ---- */
    const fp = this.fragParallax;
    const fb = layerBounds(arena, fp);
    const n = 26;
    const f0 = new Float32Array(n * 4);
    const f1 = new Float32Array(n * 4);
    const brk = new Float32Array(n * 4);
    this.frags = [];
    for (let i = 0; i < n; i++) {
      const x = rng.range(fb.x0, fb.x1);
      // two loose belts above and below the band, a few crossing it
      const u = rng.next();
      const sy = u < 0.45 ? rng.range(30, 120) : u < 0.9 ? rng.range(300, 350) : rng.range(140, 280);
      const y = atRef(0, sy, fp)[1];
      const size = rng.range(7, 15);
      f0.set([x, y, size, rng.int(3)], i * 4);
      f1.set([rng.range(0, 6.28), rng.range(-0.05, 0.05), rng.next(), rng.range(-1, 1)], i * 4);
      this.frags.push({ x, y, size });
    }
    this.broken = brk;
    this.fragments = kit.addInstanced('fragments', {
      count: n,
      attributes: { aF0: f0, aF1: f1, aBrk: brk },
      varyings: ['vec2 vQ', 'vec4 vP', 'vec2 vB'],
      vertex: FRAG_VERT,
      fragment: FRAG_FRAG,
      vertexHeader: FRAG_HEADER_VERT,
      fragmentHeader: FRAG_HEADER_FRAG,
      blend: 'normal',
      uniforms: {
        uParallax: { value: fp },
        uForceK: { value: 1.6 },
        uBone0: { value: [...scale(BONE[1]!, 0.9)] },
        uBone1: { value: [...scale(BONE[4]!, 0.9)] },
        uGold: { value: [...scale(GOLD[3]!, 1.0)] },
        uSunDir: { value: sunDir },
        uAlphaScale: { value: 1 },
      },
    });
    yield 0.7;

    /* ---- 8. the floor of the ruin: dark dust, a rose lip ---- */
    addDustBank(kit, 'floor', {
      parallax: 0.78,
      col: scale(VOID[1]!, 0.8),
      rim: scale(ROSE[1]!, 0.8),
      lip: 0.08,
      top: 0.9,
      slope: -0.06,
      roughness: 0.22,
      soft: 0.18,
      scale: [240, 70],
      speed: 0.01,
      alpha: 0.95,
      forceK: 1.2,
      rimK: 0.8,
    });
    // wake dust in the fight plane: faint, and very easily shoved — it shows every passing body and blast
    const wb = makeStarField({
      count: 260,
      bounds: layerBounds(arena, 0.95),
      size: [0.8, 1.6],
      base: 0.12,
      boost: 0.5,
      tint: mixRgb(rampAt(NEB, 0.5), rampAt(ASH, 0.6), 0.5),
      seed: 612,
    });
    kit.addSprites('wake-dust', {
      buffer: wb,
      parallax: 0.95,
      blend: 'add',
      soft: 2.5,
      drift: 5,
      driftFreq: 1 / 120,
      driftSpeed: 0.04,
      forceK: 2.4,
    });
  }

  protected override onUpdate(frame: SceneryFrame): void {
    this.view.x0 = frame.view.x0;
    this.view.y0 = frame.view.y0;
    this.breakFragments(frame);
  }

  /** Large collisions break the small structures they reach: a big shock ring splits every fragment inside it (once, for good). */
  private breakFragments(frame: SceneryFrame): void {
    const layer = this.fragments;
    if (!layer) return;
    const f = frame.forces;
    let changed = false;
    const p = this.fragParallax;
    const ox = Math.floor(frame.view.x0 * p + 0.5);
    const oy = Math.floor(frame.view.y0 * p + 0.5);
    for (let s = 0; s < f.nShock; s++) {
      const r = f.shock[s * 4 + 2]!;
      const disp = f.shock[s * 4 + 3]!;
      if (r < 60 || disp < 7) continue;
      const cx = f.shock[s * 4]!;
      const cy = f.shock[s * 4 + 1]!;
      for (let i = 0; i < this.frags.length; i++) {
        if (this.broken[i * 4]! > 0) continue;
        const g = this.frags[i]!;
        const d = Math.hypot(g.x - ox - cx, g.y - oy - cy);
        if (d < r + g.size * 2) {
          this.broken[i * 4] = Math.max(1e-3, frame.timeSec);
          this.broken[i * 4 + 1] = cx < g.x - ox ? 1 : -1;
          changed = true;
        }
      }
    }
    if (changed) {
      const attr = (layer.mesh.geometry as InstancedBufferGeometry).getAttribute(
        'aBrk',
      ) as InstancedBufferAttribute;
      attr.needsUpdate = true;
    }
  }

  lightScreenPos(out: { x: number; y: number }): void {
    screenOf(this.light[0], this.light[1], SUN_PARALLAX, this.view, out);
  }

  protected override disposeExtras(): void {
    this.fragments = null;
    this.frags = [];
  }
}
