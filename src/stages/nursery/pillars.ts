import { Rng } from '@/contracts';
import type { Rgb } from '../toolkit/color';
import type { LayerBounds } from '../toolkit/stars';

/**
 * Pillar layout + GPU sculpt for the Stellar Nursery: towering columns of dust (Pillars-of-Creation), each a chain of
 * round-cones smooth-unioned into an organic silhouette, eroded into wisps, lit from the stage key light with a
 * self-shadowed dome normal, fibrous streaks, and an ionisation rim glowing on the side that faces the newborn stars.
 */

export const MAX_SEGMENTS = 160;

export interface PillarLayout {
  /** Round-cone endpoints in LAYER coordinates: (x, y, radius, 0) each. */
  segA: Float32Array;
  segB: Float32Array;
  count: number;
  /** Tip positions (layer coords) and radii, for the particles that evaporate off the tops. */
  tips: { x: number; y: number; r: number; dirX: number; dirY: number }[];
  /** Points along the lit edge facing the light (layer coords) for rim sparkle particles. */
  litEdge: { x: number; y: number }[];
}

/** An art-directed pillar: where it stands and how tall, in LAYER coordinates. */
export interface Column {
  /** Centre x at the base and y of the crown. */
  x: number;
  top: number;
  /** Base radius (px). */
  r: number;
  /** Horizontal drift of the crown relative to the base (px, + = right). */
  lean: number;
  /** Fingers sprouting near the crown. */
  fingers: number;
}

export interface LayoutOpts {
  bounds: LayerBounds;
  seed: number;
  /** Hand-placed pillars (the composition at the reference camera). */
  columns: Column[];
  /** Random pillars filling the rest of the layer: approx spacing (px), crown-height range above the base and radius. */
  spacing: number;
  height: [number, number];
  radius: [number, number];
  fingers: [number, number];
  /** Unit direction TOWARD the light in the image plane (x right, y down). */
  lightDir: [number, number];
}

/** Deterministic pillar field across the given layer bounds. */
export function layoutPillars(o: LayoutOpts): PillarLayout {
  const rng = new Rng(o.seed);
  const segA = new Float32Array(MAX_SEGMENTS * 4);
  const segB = new Float32Array(MAX_SEGMENTS * 4);
  const tips: PillarLayout['tips'] = [];
  const litEdge: PillarLayout['litEdge'] = [];
  let n = 0;
  const push = (ax: number, ay: number, ra: number, bx: number, by: number, rb: number): void => {
    if (n >= MAX_SEGMENTS) return;
    segA.set([ax, ay, ra, 0], n * 4);
    segB.set([bx, by, rb, 0], n * 4);
    n++;
  };
  const { bounds: b } = o;
  const baseY = b.y1 + 40;
  const width = b.x1 - b.x0;
  const T = [0, 0.14, 0.3, 0.46, 0.62, 0.76, 0.88, 0.96, 1];
  const M = [1.25, 1.05, 0.86, 0.7, 0.66, 0.8, 0.92, 0.66, 0.3];
  // hand-placed columns first, then random fillers wherever the composition leaves a gap of more than `spacing`
  const defs: { x: number; H: number; r: number; lean: number; fingers: number }[] = o.columns.map((c) => ({
    x: c.x,
    H: baseY - c.top,
    r: c.r,
    lean: c.lean,
    fingers: c.fingers,
  }));
  const count = Math.max(0, Math.round(width / o.spacing));
  for (let i = 0; i < count; i++) {
    const cx = b.x0 + ((i + 0.5 + (rng.next() - 0.5) * 0.6) / count) * width;
    if (defs.some((d) => Math.abs(d.x - cx) < o.spacing * 0.75)) continue;
    defs.push({
      x: cx,
      H: rng.range(o.height[0], o.height[1]),
      r: rng.range(o.radius[0], o.radius[1]),
      lean: rng.range(-50, 50),
      fingers: rng.intRange(o.fingers[0], o.fingers[1]),
    });
  }
  for (const def of defs) {
    const cx = def.x;
    const H = def.H;
    const r0 = def.r;
    const lean = def.lean;
    const sway = rng.range(8, 26);
    const phase = rng.range(0, 6.28);
    const pts: { x: number; y: number; r: number }[] = [];
    for (let k = 0; k < T.length; k++) {
      const t = T[k]!;
      pts.push({
        x: cx + lean * t * t + sway * Math.sin(phase + t * 4.2),
        y: baseY - H * t,
        r: r0 * M[k]! * (1 - 0.3 * t) * (1 + 0.08 * Math.sin(phase * 3 + t * 9)),
      });
    }
    for (let k = 0; k < pts.length - 1; k++)
      push(pts[k]!.x, pts[k]!.y, pts[k]!.r, pts[k + 1]!.x, pts[k + 1]!.y, pts[k + 1]!.r);
    const tip = pts[pts.length - 1]!;
    tips.push({ x: tip.x, y: tip.y, r: tip.r, dirX: 0, dirY: -1 });
    // knobbly lobes budding off the flanks so the silhouette is a cauliflower, not a sausage
    const nb = rng.intRange(4, 7);
    for (let k = 0; k < nb; k++) {
      const pt = pts[rng.intRange(1, pts.length - 2)]!;
      const side = rng.chance(0.5) ? -1 : 1;
      const rr = rng.range(9, 20);
      const ox = pt.x + side * pt.r * rng.range(0.7, 1.05);
      const oy = pt.y + rng.range(-24, 24);
      push(ox, oy, rr, ox + side * rng.range(2, 10), oy - rng.range(6, 22), rr * 0.7);
    }
    // crown: a cluster of overlapping knobs so the top is a ragged dome, not a flat cut
    const nk = rng.intRange(3, 5);
    for (let k = 0; k < nk; k++) {
      const top = pts[pts.length - 3]!;
      const ox = top.x + rng.range(-1, 1) * top.r * 0.9;
      const oy = top.y - rng.range(0, 1.1) * top.r;
      const rr = rng.range(0.28, 0.55) * top.r;
      push(ox, oy, rr, ox + rng.range(-8, 8), oy - rng.range(4, 18), rr * 0.75);
    }
    // EGGs: dense globules being uncovered at the tips, a little way above the crown
    const ne = rng.intRange(1, 3);
    for (let k = 0; k < ne; k++) {
      const top = pts[pts.length - 1]!;
      const ex = top.x + rng.range(-1, 1) * top.r * 3.2 + (o.lightDir[0] < 0 ? -12 : 12);
      const ey = top.y - rng.range(0.4, 2.6) * top.r - 10;
      const er = rng.range(5, 11);
      push(ex, ey, er, ex + rng.range(-3, 3), ey - rng.range(1, 4), er * 0.9);
      tips.push({ x: ex, y: ey, r: er, dirX: 0, dirY: -1 });
    }
    // fingers: thinner, curling tendrils of dust sprouting near the crown
    const nf = def.fingers;
    for (let f = 0; f < nf; f++) {
      const from = pts[rng.intRange(3, 7)]!;
      const side = rng.chance(0.55) ? -1 : 1;
      const ang = side * rng.range(0.35, 1.05); // radians off vertical
      const len = rng.range(60, 150);
      const dx = Math.sin(ang);
      const dy = -Math.cos(ang);
      const m1x = from.x + dx * len * 0.5 + side * 6;
      const m1y = from.y + dy * len * 0.5;
      const m2x = from.x + dx * len + side * 18;
      const m2y = from.y + dy * len * 0.92 - 10;
      push(from.x, from.y, from.r * 0.5, m1x, m1y, from.r * 0.3);
      push(m1x, m1y, from.r * 0.3, m2x, m2y, from.r * 0.1);
      tips.push({ x: m2x, y: m2y, r: from.r * 0.14, dirX: dx, dirY: dy });
    }
    // lit-edge sample points: along the side of the spine that faces the light
    for (let k = 1; k < pts.length; k++) {
      const p = pts[k]!;
      const s = o.lightDir[0] < 0 ? -1 : 1;
      litEdge.push({ x: p.x + s * p.r * 0.92, y: p.y - p.r * 0.2 });
    }
  }
  return { segA, segB, count: n, tips, litEdge };
}

/**
 * Approximate signed distance (px) from a layer-space point to the pillar silhouette: negative inside. It is the CPU twin of
 * the un-eroded, un-warped union used on the GPU (plain min instead of the smooth-min), good enough to keep wisps outside the dust.
 */
export function pillarDistance(l: PillarLayout, x: number, y: number): number {
  let d = Infinity;
  for (let i = 0; i < l.count; i++) {
    const ax = l.segA[i * 4]!;
    const ay = l.segA[i * 4 + 1]!;
    const bx = l.segB[i * 4]!;
    const by = l.segB[i * 4 + 1]!;
    const px = x - ax;
    const py = y - ay;
    const bax = bx - ax;
    const bay = by - ay;
    const h = Math.min(1, Math.max(0, (px * bax + py * bay) / Math.max(1e-3, bax * bax + bay * bay)));
    const r = l.segA[i * 4 + 2]! + (l.segB[i * 4 + 2]! - l.segA[i * 4 + 2]!) * h;
    d = Math.min(d, Math.hypot(px - bax * h, py - bay * h) - r);
  }
  return d;
}

/* ------------------------------------------------------------------------------------------------ *
 *  Shaders (bodies for runBake)
 * ------------------------------------------------------------------------------------------------ */

/** Pass A: signed distance field of the eroded pillar silhouette + fibre and billow noise. */
export const FIELD_BAKE = /* glsl */ `
uniform vec2 uOrigin;
uniform int uNSeg;
uniform vec4 uSegA[${MAX_SEGMENTS}];
uniform vec4 uSegB[${MAX_SEGMENTS}];
uniform float uBlend;
uniform float uWarp;
uniform float uErode;
uniform vec2 uSeed;

float roundCone(vec2 p, vec2 a, vec2 b, float ra, float rb) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-3), 0.0, 1.0);
  return length(pa - ba * h) - mix(ra, rb, h);
}
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

void main() {
  vec2 p = bakePx() + uOrigin;
  vec2 wq = vec2(fbm(p * 0.011 + uSeed, 4), fbm(p * 0.011 + uSeed + vec2(7.7, 3.1), 4)) - 0.5;
  vec2 q = p + wq * uWarp;
  float d = 1e4;
  for (int i = 0; i < uNSeg; i++) {
    // cheap reject: a segment whose bounding circle is far outside the current surface cannot change it
    vec2 mid = 0.5 * (uSegA[i].xy + uSegB[i].xy);
    float reach = 0.5 * length(uSegB[i].xy - uSegA[i].xy) + max(uSegA[i].z, uSegB[i].z);
    if (length(q - mid) - reach > d + uBlend) continue;
    d = smin(d, roundCone(q, uSegA[i].xy, uSegB[i].xy, uSegA[i].z, uSegB[i].z), uBlend);
  }
  float bil = fbm(p * 0.032 + uSeed * 1.7, 5);
  float mid = fbm(p * 0.085 + uSeed * 0.9, 4);
  float fine = vnoise(p * 0.23 + uSeed);
  // cauliflower silhouette: erosion at three scales, stronger where the dust is already thin
  float thin = smoothstep(-40.0, 0.0, d);
  d += (bil - 0.5) * uErode + (mid - 0.5) * uErode * 0.5 + (fine - 0.5) * (1.0 + 3.0 * thin);
  float fib = fbm(vec2(p.x * 0.09, p.y * 0.017) + wq * 3.0 + uSeed * 2.3, 5);
  o0 = vec4(d, fib, bil, 1.0);
}
`;

/** Pass B: light the sculpt. MRT: o0 = dust (gamma rgb + opacity), o1 = additive rim glow (gamma rgb / 4). */
export const SHADE_BAKE = /* glsl */ `
uniform sampler2D uField;
uniform vec3 uL;             // unit vector toward the light (x right, y DOWN, z toward viewer)
uniform vec3 uCol0;          // dust body ramp, dark → lit
uniform vec3 uCol1;
uniform vec3 uCol2;
uniform vec3 uCol3;
uniform vec3 uRimHot;
uniform vec3 uRimMid;
uniform vec3 uRimOuter;
uniform vec3 uBackRim;
uniform float uBump;
uniform float uRimW;
uniform float uGlowW;
uniform float uHaze;         // 0..1 aerial perspective: blend dust toward uHazeCol (far pillars)
uniform vec3 uHazeCol;
uniform float uFade;         // px over which pillars fade into the dust sea below (layer bottom)
uniform float uFadeY;

vec4 F(vec2 p) {
  vec2 c = clamp(floor(p), vec2(0.0), uBakeSize - 1.0);
  return texelFetch(uField, ivec2(int(c.x), int(uBakeSize.y) - 1 - int(c.y)), 0);
}

void main() {
  vec2 p = bakePx();
  vec4 f = F(p);
  float d = f.r;
  float fib = f.g;
  float bil = f.b;

  // Normals. A pillar is a column, so shade it as a CYLINDER: scan sideways to both edges to find where across the
  // column this pixel sits (u = -1 left edge … +1 right edge). That gives a clean rounded gradient across the whole
  // width instead of the flat plateau a distance-field gradient leaves in the interior. The distance-field gradient
  // still supplies the crowns, undercuts and the small bumps near edges.
  float dl = 120.0;
  float dr = 120.0;
  for (int i = 1; i <= 40; i++) {
    float x = float(i) * 3.0;
    if (dl > 119.0 && F(p + vec2(-x, 0.0)).r > 0.0) dl = x;
    if (dr > 119.0 && F(p + vec2(x, 0.0)).r > 0.0) dr = x;
  }
  float u = clamp((dl - dr) / max(dl + dr, 1.0), -1.0, 1.0);
  vec3 nc = vec3(u, 0.0, sqrt(max(0.0, 1.0 - u * u)));
  vec2 g14 = vec2(F(p + vec2(14.0, 0.0)).r - F(p - vec2(14.0, 0.0)).r, F(p + vec2(0.0, 14.0)).r - F(p - vec2(0.0, 14.0)).r) / 28.0;
  vec2 g3 = vec2(F(p + vec2(3.0, 0.0)).r - F(p - vec2(3.0, 0.0)).r, F(p + vec2(0.0, 3.0)).r - F(p - vec2(0.0, 3.0)).r) / 6.0;
  vec2 bump = vec2(F(p + vec2(1.0, 0.0)).g - F(p - vec2(1.0, 0.0)).g, F(p + vec2(0.0, 1.0)).g - F(p - vec2(0.0, 1.0)).g) * uBump;
  vec3 nd = normalize(vec3(g14 * 2.4, 1.0));
  vec3 n = normalize(nc * 0.75 + nd * 0.5 + vec3(g3 * 0.35 * smoothstep(-14.0, 0.0, d) + bump, 0.0));
  // The newborn stars sit far off to the side: a grazing light, so surfaces facing the viewer stay dark and only
  // flanks that turn toward the stars catch fire.
  vec3 Lg = normalize(vec3(uL.xy, uL.z * 0.32));
  float dif = dot(n, Lg);
  float lam = clamp((dif + 0.15) / 1.15, 0.0, 1.0);

  // self shadow: march toward the light across the height field (height = depth inside the silhouette)
  vec2 ld = normalize(uL.xy + 1e-4);
  float slope = uL.z / max(length(uL.xy), 1e-3);
  float h0 = max(0.0, -d) * 0.7;
  float sh = 1.0;
  for (int i = 1; i <= 12; i++) {
    float s = float(i) * 5.0;
    float hq = max(0.0, -F(p + ld * s).r) * 0.7;
    sh -= smoothstep(0.0, 8.0, hq - (h0 + s * slope)) * 0.11;
  }
  sh = clamp(sh, 0.12, 1.0);
  float lit = clamp(lam * sh * (0.7 + 0.5 * bil) + (fib - 0.5) * 0.35 * lam, 0.0, 1.0);

  lit = pow(lit, 1.35);
  vec3 col = lit < 0.34 ? mix(uCol0, uCol1, lit / 0.34)
           : lit < 0.68 ? mix(uCol1, uCol2, (lit - 0.34) / 0.34)
                        : mix(uCol2, uCol3, clamp((lit - 0.68) / 0.32, 0.0, 1.0));
  col *= 0.6 + 0.9 * fib;                                    // fibrous streaks
  col *= mix(1.0, 0.72, smoothstep(0.0, 44.0, -d));          // thick interiors soak up light
  col = mix(col, uHazeCol, uHaze);

  // fade into the dark dust sea at the base of the layer
  float fadeK = smoothstep(uFadeY - uFade, uFadeY, p.y);
  col *= 1.0 - 0.75 * fadeK;

  // ionisation rim: strongest on edges facing the light, with an outer glow and a faint back-scatter on the far side
  vec2 nrm = g3 / max(length(g3), 1e-3);
  float fac = dot(nrm, ld);
  float facing = smoothstep(-0.2, 0.85, fac);
  float band = exp(-abs(d) / uRimW);
  float outer = d > 0.0 ? exp(-d / uGlowW) : 0.0;
  float wisp = 1.0 + 0.9 * smoothstep(0.45, 0.8, bil);
  vec3 glow = (uRimHot * band * 1.0 + uRimMid * (band * 0.5 + outer * 0.32) + uRimOuter * outer * 0.4) * facing * wisp;
  glow += uBackRim * band * smoothstep(0.15, -0.9, fac) * 0.4;
  glow *= 1.0 - fadeK;

  float edge = 0.55 + 3.2 * smoothstep(0.55, 0.85, bil);
  float alpha = smoothstep(edge, -edge, d);
  o0 = vec4(pow(max(col, 0.0), vec3(1.0 / 2.2)), alpha);
  o1 = vec4(pow(clamp(glow / 4.0, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}
`;

export interface PillarColors {
  /** Dust body ramp, dark → lit (linear HDR). */
  body: [Rgb, Rgb, Rgb, Rgb];
  rimHot: Rgb;
  rimMid: Rgb;
  rimOuter: Rgb;
  backRim: Rgb;
  haze: number;
  hazeCol: Rgb;
}
