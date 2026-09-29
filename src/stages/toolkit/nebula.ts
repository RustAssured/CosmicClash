import type { KitLayer, LayerBlend, SceneryKit } from './kit';

/**
 * Domain-warped fbm gas / dust layer drawn as a full-screen shader: the large, soft, slowly flowing structure of a
 * nebula. Particle clouds add the fine detail on top. Reacts to the fight: impulses swirl the domain (via the shared
 * force field) and tint it, and `uFlow` (which runs faster in a hot fight) drives the drift.
 */

export type Rgb = readonly [number, number, number];

export interface NebulaOpts {
  parallax: number;
  /** Layer px per noise unit: bigger = larger, smoother clouds. */
  scale: number;
  /** Domain-warp amount (noise units). */
  warp: number;
  octaves: number;
  /** Density thresholds: below x is empty, above y is fully dense. */
  thresh: readonly [number, number];
  /** Gas ramp (linear HDR): thin, thick, hot-core, and the colour of surfaces facing the light. */
  colA: Rgb;
  colB: Rgb;
  colC: Rgb;
  colD: Rgb;
  gain: number;
  /** Direction toward the light in noise space (unit-ish) and how strongly facing surfaces light up. */
  lightDir: readonly [number, number];
  litK: number;
  litStep?: number;
  flowSpeed: number;
  seed: readonly [number, number];
  /** 'emit' adds light; 'dust' occludes (normal blend, colour = lit dust, alpha = opacity). */
  mode: 'emit' | 'dust';
  /** Opacity multiplier in dust mode. */
  alpha?: number;
  /** Spatial concentration: centre (layer px) and radii; `maskMix` 0 = uniform, 1 = fully concentrated. */
  mask?: readonly [number, number, number, number];
  maskMix?: number;
  forceK?: number;
}

const FRAGMENT = /* glsl */ `
uniform float uScale;
uniform float uWarp;
uniform int uOct;
uniform vec2 uThresh;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform vec3 uColD;
uniform float uGain;
uniform vec2 uLightDir;
uniform float uLitK;
uniform float uLitStep;
uniform float uFlowSpeed;
uniform vec2 uSeed;
uniform float uAlpha;
uniform vec4 uMask;
uniform float uMaskMix;
uniform float uForceK;
uniform float uDust;

void main() {
  vec2 sp = warpByForces(screenPx(), -uForceK);
  vec2 lp = sp + uView * uParallax;
  vec2 wp = lp / uScale + uSeed;
  float t = uFlow * uFlowSpeed;
  vec2 q = vec2(fbm(wp * 0.7 + vec2(0.0, t * 0.35), 3), fbm(wp * 0.7 + vec2(5.2 - t * 0.25, 1.3), 3));
  vec2 w = wp + (q - 0.5) * uWarp;
  float d = fbm(w, uOct);
  vec2 m = (lp - uMask.xy) / uMask.zw;
  d *= mix(1.0, exp(-dot(m, m)), uMaskMix);
  float dl = fbm(w + uLightDir * uLitStep, uOct) * mix(1.0, exp(-dot(m, m)), uMaskMix);
  float dens = smoothstep(uThresh.x, uThresh.y, d);
  float lit = clamp((d - dl) * uLitK, 0.0, 1.0);
  vec3 base = mix(uColA, uColB, smoothstep(uThresh.x, 1.0, d));
  vec3 col = base + uColC * dens * dens + uColD * lit * dens;
  col += impulseGlow(sp) * dens * 0.6 * (1.0 - uDust * 0.7);
  if (uDust > 0.5) {
    o = vec4(col, clamp(dens * uAlpha, 0.0, 1.0));
  } else {
    o = vec4(col * dens * uGain, 1.0);
  }
}
`;

export function addNebula(kit: SceneryKit, name: string, opts: NebulaOpts): KitLayer {
  const blend: LayerBlend = opts.mode === 'emit' ? 'add' : 'normal';
  const mask = opts.mask ?? [0, 0, 1e6, 1e6];
  return kit.addFullscreen(name, FRAGMENT, blend, opts.parallax, {
    uScale: { value: opts.scale },
    uWarp: { value: opts.warp },
    uOct: { value: opts.octaves },
    uThresh: { value: [...opts.thresh] },
    uColA: { value: [...opts.colA] },
    uColB: { value: [...opts.colB] },
    uColC: { value: [...opts.colC] },
    uColD: { value: [...opts.colD] },
    uGain: { value: opts.gain },
    uLightDir: { value: [...opts.lightDir] },
    uLitK: { value: opts.litK },
    uLitStep: { value: opts.litStep ?? 0.12 },
    uFlowSpeed: { value: opts.flowSpeed },
    uSeed: { value: [...opts.seed] },
    uAlpha: { value: opts.alpha ?? 1 },
    uMask: { value: [...mask] },
    uMaskMix: { value: opts.maskMix ?? 0 },
    uForceK: { value: opts.forceK ?? 1 },
    uDust: { value: opts.mode === 'dust' ? 1 : 0 },
  });
}
