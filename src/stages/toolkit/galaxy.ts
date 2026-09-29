import type { IUniform } from 'three';
import { Rng, hash32 } from '@/contracts';
import type { Rgb } from './color';
import type { KitLayer, SceneryKit } from './kit';

/**
 * Spiral / elliptical galaxies for the scenery, as two cooperating instanced layers sharing one projection so they always agree:
 *
 *  - `addGalaxyDiscs`: ANALYTIC discs — every instance is a quad whose fragment shader evaluates a bulge + exponential disk +
 *    logarithmic spiral arms (with dust lanes and star-forming knots) in the galaxy's own plane, tilted by its inclination and
 *    rotated by its position angle, with DIFFERENTIAL ROTATION driven by the scenery clock. Any number of galaxies, any size:
 *    cost is the area they cover, not the screen.
 *  - `addGalaxyStars`: a 3D particle field (tens of thousands of resolved stars, dust lanes and HII knots) distributed along the
 *    same arms, projected with the same tilt/rotation in the vertex shader (real 3D positions, so the near side is brighter and
 *    the disk thickness shows at high inclination).
 *
 * Conventions: the galaxy plane has x,y; inclination i tilts it about the x axis (0 = face-on, π/2 = edge-on); position angle
 * rotates the result on screen. Layer coordinates as everywhere in the kit (a layer with parallax p shows at layer − view·p).
 */

export interface GalaxyDisc {
  /** Centre in layer coordinates and radius (px) of the disk in its own plane. */
  x: number;
  y: number;
  radius: number;
  inclination: number;
  positionAngle: number;
  /** Spiral arm count (0 = smooth elliptical) and pitch (tan of the pitch angle; ≈ 0.25 tightly wound … 0.6 open). */
  arms: number;
  pitch: number;
  /** Linear HDR colours: bulge/core, disk & arms, star-forming knots. */
  core: Rgb;
  arm: Rgb;
  knot: Rgb;
  /** Overall brightness multiplier, dust-lane strength 0..1, knot strength 0..1, rotation speed multiplier. */
  brightness: number;
  dust: number;
  knots: number;
  spin: number;
  seed: number;
}

const GALAXY_COMMON = /* glsl */ `
uniform float uSpin;        // radians of rotation at unit angular speed (scenery clock × rate)
// Differential rotation: inner parts turn faster (flat-ish rotation curve in velocity, so ω ∝ 1/√r).
float galOmega(float rr) { return 1.0 / sqrt(rr + 0.15); }
`;

const DISC_VERT_HEAD = /* glsl */ `
uniform float uParallax;
uniform float uForceK;
${GALAXY_COMMON}
`;
const DISC_FRAG_HEAD = /* glsl */ `
uniform float uIntensity;
${GALAXY_COMMON}
`;

const DISC_VERT = /* glsl */ `
float par = uParallax;
vec2 c = aG0.xy - floor(uView * par + 0.5);
c = warpByForces(c, uForceK);
float R = aG0.z;
float ext = R * 1.75;
vec2 off = position.xy * ext;
if (c.x + ext < -8.0 || c.y + ext < -8.0 || c.x - ext > uRes.x + 8.0 || c.y - ext > uRes.y + 8.0) {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vLocal = vec2(0.0); vG1 = vec4(0.0); vCore = vec4(0.0); vArm = vec4(0.0); vKnot = vec4(0.0); vR = 1.0; vSeed = 0.0;
  return;
}
gl_Position = toNdc(c + off);
vLocal = off;
vG1 = aG1;
vCore = aG2;
vArm = aG3;
vKnot = aG4;
vR = R;
vSeed = aG0.w;
`;

const DISC_FRAG = /* glsl */ `
float ci = max(cos(vG1.x), 0.08);
float cp = cos(vG1.y);
float sp = sin(vG1.y);
vec2 q = vec2(vLocal.x * cp + vLocal.y * sp, -vLocal.x * sp + vLocal.y * cp);   // undo the position angle
vec2 pl = vec2(q.x, q.y / ci);                                                  // undo the inclination (plane coordinates)
float rr = length(pl) / vR;
if (rr > 1.7) discard;
float theta = atan(pl.y, pl.x) - uSpin * vArm.w * galOmega(rr);
float arms = vG1.z;
float bulge = exp(-rr * 11.0) * 1.6 + exp(-rr * 3.5) * 0.18;
vec3 col;
if (arms > 0.5) {
  float disk = exp(-rr * 3.1) * (1.0 - smoothstep(0.9, 1.6, rr));
  float phase = arms * (theta - log(rr + 0.06) / vG1.w);
  float spiral = pow(0.5 + 0.5 * cos(phase), 2.6);
  // dust lanes hug the concave (inner) edge of each arm, and dim what lies behind them
  float lane = pow(0.5 + 0.5 * cos(phase - 0.85), 5.0) * smoothstep(0.06, 0.32, rr) * (1.0 - smoothstep(0.8, 1.3, rr));
  float clump = vnoise(pl / vR * 9.0 + vSeed * 13.0);
  disk *= (0.16 + 0.95 * spiral) * (0.65 + 0.7 * clump);
  disk *= 1.0 - vKnot.w * 0.85 * lane;
  float kn = smoothstep(0.66, 0.86, vnoise(pl / vR * 26.0 + vSeed * 7.0)) * spiral * smoothstep(0.1, 0.35, rr) * (1.0 - smoothstep(0.7, 1.15, rr));
  col = vCore.rgb * bulge * (1.0 - vKnot.w * 0.35 * lane) + vArm.rgb * disk * 0.9 + vKnot.rgb * kn;
} else {
  // smooth elliptical: a de Vaucouleurs-ish profile, slightly mottled
  float e = exp(-pow(rr, 0.28) * 5.6) * 2.4;
  float mott = 0.85 + 0.3 * vnoise(pl / vR * 6.0 + vSeed * 5.0);
  col = mix(vArm.rgb, vCore.rgb, smoothstep(0.0, 0.5, exp(-rr * 6.0))) * e * mott;
}
o = vec4(col * vCore.w * (1.0 + 0.3 * uIntensity), 1.0);
`;

/** Analytic galaxy discs (additive). Rotation is driven through the layer's `uSpin` uniform: see `setDiscSpin`. */
export function addGalaxyDiscs(
  kit: SceneryKit,
  name: string,
  parallax: number,
  discs: readonly GalaxyDisc[],
  forceK = 0.1,
): KitLayer {
  const n = discs.length;
  const a0 = new Float32Array(n * 4);
  const a1 = new Float32Array(n * 4);
  const a2 = new Float32Array(n * 4);
  const a3 = new Float32Array(n * 4);
  const a4 = new Float32Array(n * 4);
  discs.forEach((g, i) => {
    a0.set([g.x, g.y, g.radius, g.seed], i * 4);
    a1.set([g.inclination, g.positionAngle, g.arms, Math.max(0.05, g.pitch)], i * 4);
    a2.set([g.core[0], g.core[1], g.core[2], g.brightness], i * 4);
    a3.set([g.arm[0], g.arm[1], g.arm[2], g.spin], i * 4);
    a4.set([g.knot[0] * g.knots, g.knot[1] * g.knots, g.knot[2] * g.knots, g.dust], i * 4);
  });
  return kit.addInstanced(name, {
    count: n,
    attributes: { aG0: a0, aG1: a1, aG2: a2, aG3: a3, aG4: a4 },
    varyings: ['vec2 vLocal', 'vec4 vG1', 'vec4 vCore', 'vec4 vArm', 'vec4 vKnot', 'float vR', 'float vSeed'],
    vertex: DISC_VERT,
    fragment: DISC_FRAG,
    vertexHeader: DISC_VERT_HEAD,
    fragmentHeader: DISC_FRAG_HEAD,
    blend: 'add',
    uniforms: {
      uParallax: { value: parallax },
      uForceK: { value: forceK },
      uSpin: { value: 0 },
    },
  });
}

/* ---------------------------------------------------------------------------------------------- *
 *  Resolved stars: a 3D particle galaxy
 * ---------------------------------------------------------------------------------------------- */

export interface GalaxyStarsOpts {
  seed: number;
  centre: [number, number];
  radius: number;
  inclination: number;
  positionAngle: number;
  arms: number;
  pitch: number;
  /** Counts of resolved stars, dust puffs, star-forming knots and bulge stars. */
  stars: number;
  dust: number;
  knots: number;
  bulge: number;
  /** Half-thickness of the disk as a fraction of the radius. */
  thickness: number;
  core: Rgb;
  inner: Rgb;
  arm: Rgb;
  outer: Rgb;
  knot: Rgb;
  dustColor: Rgb;
  brightness: number;
  spin: number;
}

const STARS_VERT_HEAD = /* glsl */ `
uniform float uParallax;
uniform float uForceK;
uniform vec2 uCentre;
uniform float uRadius;
uniform float uInc;
uniform float uPA;
uniform float uTwinkle;
${GALAXY_COMMON}
`;
const STARS_FRAG_HEAD = /* glsl */ `
uniform float uSoft;
uniform float uAlphaScale;
`;

const STARS_VERT = /* glsl */ `
float par = uParallax;
float r = aS0.x;                     // 0..1.6 normalised radius
float th0 = aS0.y;
float z = aS0.z;                     // height above the plane, normalised
float rr = r + 0.0001;
float th = th0 + uSpin * galOmega(rr);
vec3 p = vec3(cos(th) * r, sin(th) * r, z) * uRadius;
float ci = cos(uInc);
float si = sin(uInc);
vec3 q = vec3(p.x, p.y * ci - p.z * si, p.y * si + p.z * ci);
float cp = cos(uPA);
float sp = sin(uPA);
vec2 sc = vec2(q.x * cp - q.y * sp, q.x * sp + q.y * cp);
vec2 c = uCentre + sc - floor(uView * par + 0.5);
c = warpByForces(c, uForceK);
float depth = q.z / uRadius;         // toward the viewer: brighter, a touch larger
float size = aS1.x * (1.0 + 0.2 * depth);
if (c.x < -size - 4.0 || c.y < -size - 4.0 || c.x > uRes.x + size + 4.0 || c.y > uRes.y + size + 4.0) {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vQ = vec2(0.0); vCol = vec4(0.0);
  return;
}
gl_Position = toNdc(c + position.xy * size);
vQ = position.xy;
float tw = 1.0 + uTwinkle * sin(uTime * (1.0 + aS1.w * 2.5) + aS1.w * 71.0);
vCol = vec4(aS2.rgb * (1.0 + 0.25 * depth) * tw, aS2.a);
`;

const STARS_FRAG = /* glsl */ `
float r2 = dot(vQ, vQ);
if (r2 >= 1.0) discard;
float a = exp(-r2 * uSoft) * (1.0 - r2);
o = vec4(vCol.rgb, vCol.a * a * uAlphaScale);
`;

const gauss = (rng: Rng): number => rng.gauss();

/**
 * Generate the resolved-star attributes of one galaxy. Stars follow logarithmic spiral arms (70 %) plus a smooth disk (30 %);
 * knots hug the arms; dust puffs sit on the concave edge; the bulge is a flattened Plummer-like cloud.
 */
export function makeGalaxyStars(o: GalaxyStarsOpts): {
  stars: { s0: Float32Array; s1: Float32Array; s2: Float32Array; count: number };
  dust: { s0: Float32Array; s1: Float32Array; s2: Float32Array; count: number };
} {
  const rng = new Rng(o.seed);
  const tanP = Math.max(0.05, o.pitch);
  const rd = 0.33; // disk scale length (fraction of radius)
  const armAngle = (k: number, r: number): number =>
    (k * Math.PI * 2) / Math.max(1, o.arms) + Math.log(r + 0.06) / tanP;
  const total = o.stars + o.knots + o.bulge;
  const s0 = new Float32Array(total * 4);
  const s1 = new Float32Array(total * 4);
  const s2 = new Float32Array(total * 4);
  let n = 0;
  const put = (
    r: number,
    th: number,
    z: number,
    size: number,
    rot: number,
    tw: number,
    c: Rgb,
    k: number,
    a: number,
  ): void => {
    s0.set([r, th, z, 0], n * 4);
    s1.set([size, rot, 0, tw], n * 4);
    s2.set([c[0] * k, c[1] * k, c[2] * k, a], n * 4);
    n++;
  };
  const radial = (): number => {
    // exponential disk truncated at ~1.5 R
    const u = rng.next();
    return Math.min(1.5, -rd * Math.log(1 - u * 0.985));
  };
  const lerpRgb = (a: Rgb, b: Rgb, t: number): [number, number, number] => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  for (let i = 0; i < o.stars; i++) {
    const r = radial();
    const inArm = o.arms > 0 && rng.next() < 0.7;
    const scatter = 0.09 + 0.16 * r;
    const th = inArm ? armAngle(rng.int(o.arms), r) + gauss(rng) * scatter : rng.next() * Math.PI * 2;
    const z = gauss(rng) * o.thickness * (0.5 + r * 0.8);
    const t = Math.min(1, r / 0.9);
    const col =
      t < 0.3
        ? lerpRgb(o.core, o.inner, t / 0.3)
        : t < 0.65
          ? lerpRgb(o.inner, o.arm, (t - 0.3) / 0.35)
          : lerpRgb(o.arm, o.outer, (t - 0.65) / 0.35);
    // brightness: a heavy tail of bright stars, blue-shifted in the arms
    const k =
      o.brightness *
      (0.22 + 1.6 * Math.pow(rng.next(), 7)) *
      (inArm ? 1.25 : 0.9) *
      (1 - 0.35 * Math.min(1, r));
    put(r, th, z, rng.range(0.55, 1.15) * (1 + 0.6 * Math.pow(rng.next(), 6)), 0, rng.next(), col, k, 1);
  }
  for (let i = 0; i < o.knots; i++) {
    const r = 0.16 + rng.next() * 0.72;
    const th = armAngle(rng.int(Math.max(1, o.arms)), r) + gauss(rng) * 0.05;
    put(
      r,
      th,
      gauss(rng) * o.thickness * 0.4,
      rng.range(1.6, 3.4),
      0,
      rng.next(),
      o.knot,
      o.brightness * rng.range(0.7, 1.7),
      1,
    );
  }
  for (let i = 0; i < o.bulge; i++) {
    // Plummer-like: r = a / sqrt(u^(-2/3) - 1)
    const u = Math.max(1e-3, rng.next());
    const r = Math.min(0.6, 0.11 / Math.sqrt(Math.pow(u, -2 / 3) - 1 + 1e-6));
    const th = rng.next() * Math.PI * 2;
    const z = gauss(rng) * 0.09 * (1 + r);
    put(
      r,
      th,
      z,
      rng.range(0.6, 1.25),
      0,
      rng.next(),
      lerpRgb(o.core, o.inner, Math.min(1, r * 2.5)),
      o.brightness * (0.3 + 1.3 * Math.pow(rng.next(), 5)),
      1,
    );
  }
  // dust: puffs on the inner edge of each arm, drawn dark
  const d0 = new Float32Array(o.dust * 4);
  const d1 = new Float32Array(o.dust * 4);
  const d2 = new Float32Array(o.dust * 4);
  for (let i = 0; i < o.dust; i++) {
    const r = 0.1 + Math.pow(rng.next(), 0.85) * 0.85;
    const th = armAngle(rng.int(Math.max(1, o.arms)), r) - 0.16 + gauss(rng) * 0.045 * (1 + r);
    d0.set([r, th, gauss(rng) * o.thickness * 0.3, 0], i * 4);
    d1.set([rng.range(5, 15) * (1 + r), 0, 0, rng.next()], i * 4);
    d2.set([o.dustColor[0], o.dustColor[1], o.dustColor[2], rng.range(0.05, 0.13)], i * 4);
  }
  return {
    stars: { s0: s0.subarray(0, n * 4), s1: s1.subarray(0, n * 4), s2: s2.subarray(0, n * 4), count: n },
    dust: { s0: d0, s1: d1, s2: d2, count: o.dust },
  };
}

/** Shuffle instance order so that a prefix (quality-tier thinning) is an unbiased subsample. */
function shuffled(
  a: { s0: Float32Array; s1: Float32Array; s2: Float32Array; count: number },
  seed: number,
): void {
  const rng = new Rng(seed);
  const swap = (arr: Float32Array, i: number, j: number): void => {
    for (let k = 0; k < 4; k++) {
      const t = arr[i * 4 + k]!;
      arr[i * 4 + k] = arr[j * 4 + k]!;
      arr[j * 4 + k] = t;
    }
  };
  for (let i = a.count - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    swap(a.s0, i, j);
    swap(a.s1, i, j);
    swap(a.s2, i, j);
  }
}

/**
 * Add the resolved-star layers of a galaxy (stars additive, then dust as dark alpha). Returns both layers; keep the returned
 * `spin` updater and call it every frame with the scenery clock so stars and analytic discs rotate together.
 */
export function addGalaxyStars(
  kit: SceneryKit,
  name: string,
  parallax: number,
  o: GalaxyStarsOpts,
  forceK = 0.1,
): { stars: KitLayer; dust: KitLayer; setSpin(timeSec: number): void } {
  const g = makeGalaxyStars(o);
  shuffled(g.stars, hash32(o.seed, 1));
  const uniforms = (soft: number): Record<string, IUniform> => ({
    uParallax: { value: parallax },
    uForceK: { value: forceK },
    uSpin: { value: 0 },
    uCentre: { value: [o.centre[0], o.centre[1]] },
    uRadius: { value: o.radius },
    uInc: { value: o.inclination },
    uPA: { value: o.positionAngle },
    uTwinkle: { value: 0.12 },
    uSoft: { value: soft },
    uAlphaScale: { value: 1 },
  });
  const common = {
    varyings: ['vec2 vQ', 'vec4 vCol'],
    vertex: STARS_VERT,
    fragment: STARS_FRAG,
    vertexHeader: STARS_VERT_HEAD,
    fragmentHeader: STARS_FRAG_HEAD,
  };
  const stars = kit.addInstanced(`${name}-stars`, {
    ...common,
    count: g.stars.count,
    attributes: { aS0: g.stars.s0, aS1: g.stars.s1, aS2: g.stars.s2 },
    blend: 'add',
    uniforms: uniforms(3.2),
    tierScale: true,
    compensate: 'uAlphaScale',
  });
  const dust = kit.addInstanced(`${name}-dust`, {
    ...common,
    count: g.dust.count,
    attributes: { aS0: g.dust.s0, aS1: g.dust.s1, aS2: g.dust.s2 },
    blend: 'normal',
    uniforms: uniforms(1.6),
  });
  return {
    stars,
    dust,
    setSpin(t: number) {
      const v = t * o.spin;
      (stars.uniforms.uSpin as { value: number }).value = v;
      (dust.uniforms.uSpin as { value: number }).value = v;
    },
  };
}

/** Advance the analytic discs' rotation from the scenery clock (same spin convention as the stars). */
export function setDiscSpin(disc: KitLayer, timeSec: number, rate: number): void {
  (disc.uniforms.uSpin as { value: number }).value = timeSec * rate;
}
