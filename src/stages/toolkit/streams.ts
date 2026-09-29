import type { Rgb } from './color';
import type { KitLayer, LayerBlend, SceneryKit } from './kit';
import { Rng } from '@/contracts';

/**
 * Streams of particles that flow away from a point along a fan of directions and are reborn at the source: the wind of a dying
 * star, the plasma of a jet. Every particle's position is a PURE FUNCTION of the flow clock (`uFlow`, which runs faster in a hot
 * fight and swirls with impulses), so nothing is simulated, nothing allocates, and a frame is reproducible.
 */

export interface StreamOpts {
  parallax: number;
  /** Source position in layer coordinates. */
  origin: readonly [number, number];
  count: number;
  /** Fan of directions (radians, screen coordinates with y down) and the exponent shaping the density across the fan (1 = uniform, >1 = concentrated on the axis). */
  angle: readonly [number, number];
  axisBias?: number;
  /** Travel range from the source (px): particles are born at `distance[0]` and fade out at `distance[1]`. */
  distance: readonly [number, number];
  /** Flow speed in px per flow-second (each particle varies ±25 %). */
  speed: number;
  /** Half width (px) range and the streak length as a multiple of the half width. */
  size: readonly [number, number];
  stretch: number;
  /** Lateral wobble amplitude (px). */
  wobble: number;
  /** Colour at birth, mid life and death (linear HDR), and overall brightness. */
  colors: readonly [Rgb, Rgb, Rgb];
  brightness: number;
  /** Alpha of one particle before the soft profile. */
  alpha?: number;
  forceK?: number;
  twinkle?: number;
  seed: number;
  blend?: LayerBlend;
  /** Fraction of particles drawn on each quality tier is handled by the kit (additive layers thin out). */
}

const HEADER_VERT = /* glsl */ `
uniform float uParallax;
uniform float uForceK;
uniform vec2 uOrigin;
uniform vec2 uDist;        // min, max travel
uniform float uSpeed;
uniform float uStretch;
uniform float uWobble;
uniform float uTwinkle;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform float uBright;
uniform float uAlpha;
`;

const VERT = /* glsl */ `
float par = uParallax;
float L = uDist.y - uDist.x;
float life = fract(aE0.z + uFlow * uSpeed * aE1.w / L);
float rad = uDist.x + life * L;
vec2 dir = vec2(cos(aE0.x), sin(aE0.x));
vec2 nrm = vec2(-dir.y, dir.x);
float wob = sin(life * 9.0 * aE1.z + aE0.y * 6.28) * uWobble * (0.4 + life);
vec2 pos = uOrigin + dir * rad + nrm * (wob + aE0.y * 0.0);
vec2 c = pos - floor(uView * par + 0.5);
c = warpByForces(c, uForceK);
float size = aE1.x;
float lenPx = size * uStretch;
float ext = lenPx + size + 4.0;
if (c.x < -ext || c.y < -ext || c.x > uRes.x + ext || c.y > uRes.y + ext) {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vQ = vec2(0.0); vCol = vec4(0.0);
  return;
}
vec2 off = dir * (position.x * lenPx) + nrm * (position.y * size);
gl_Position = toNdc(c + off);
vQ = position.xy;
float env = smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.62, 1.0, life));
vec3 col = life < 0.5 ? mix(uC0, uC1, life * 2.0) : mix(uC1, uC2, (life - 0.5) * 2.0);
float tw = 1.0 + uTwinkle * sin(uTime * (1.0 + aE1.z * 3.0) + aE1.y * 71.0);
vCol = vec4(col * uBright * aE1.y * tw, uAlpha * env);
`;

const HEADER_FRAG = /* glsl */ `
uniform float uAlphaScale;
`;

const FRAG = /* glsl */ `
float r2 = dot(vQ, vQ);
if (r2 >= 1.0) discard;
float a = exp(-r2 * 2.6) * (1.0 - r2);
o = vec4(vCol.rgb, vCol.a * a * uAlphaScale);
`;

export function addStreams(kit: SceneryKit, name: string, o: StreamOpts): KitLayer {
  const rng = new Rng(o.seed);
  const n = o.count;
  const e0 = new Float32Array(n * 4);
  const e1 = new Float32Array(n * 4);
  const bias = o.axisBias ?? 1;
  const mid = (o.angle[0] + o.angle[1]) * 0.5;
  const half = (o.angle[1] - o.angle[0]) * 0.5;
  for (let i = 0; i < n; i++) {
    const u = rng.next() * 2 - 1;
    const ang = mid + Math.sign(u) * Math.pow(Math.abs(u), bias) * half;
    e0.set([ang, rng.next() * 2 - 1, rng.next(), 0], i * 4);
    const size = o.size[0] + (o.size[1] - o.size[0]) * Math.pow(rng.next(), 2);
    e1.set([size, 0.35 + 0.65 * Math.pow(rng.next(), 2), rng.range(0.6, 1.8), rng.range(0.75, 1.25)], i * 4);
  }
  return kit.addInstanced(name, {
    count: n,
    attributes: { aE0: e0, aE1: e1 },
    varyings: ['vec2 vQ', 'vec4 vCol'],
    vertex: VERT,
    fragment: FRAG,
    vertexHeader: HEADER_VERT,
    fragmentHeader: HEADER_FRAG,
    blend: o.blend ?? 'add',
    tierScale: true,
    compensate: 'uAlphaScale',
    uniforms: {
      uParallax: { value: o.parallax },
      uForceK: { value: o.forceK ?? 0.6 },
      uOrigin: { value: [...o.origin] },
      uDist: { value: [...o.distance] },
      uSpeed: { value: o.speed },
      uStretch: { value: o.stretch },
      uWobble: { value: o.wobble },
      uTwinkle: { value: o.twinkle ?? 0.1 },
      uC0: { value: [...o.colors[0]] },
      uC1: { value: [...o.colors[1]] },
      uC2: { value: [...o.colors[2]] },
      uBright: { value: o.brightness },
      uAlpha: { value: o.alpha ?? 1 },
      uAlphaScale: { value: 1 },
    },
  });
}
