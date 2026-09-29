import { Rng, type StageInfo } from '@/contracts';
import { STAGE_INFO } from '../info';
import { AmbientLife } from '../toolkit/ambient';
import { addDustBank } from '../toolkit/bank';
import { REF_X0, REF_Y0, addHeroStars, atRef, screenOf, type HeroStar } from '../toolkit/compose';
import { mixRgb, paletteRamps, rampAt, scale, type Rgb } from '../toolkit/color';
import { SceneryBase } from '../toolkit/base';
import { SpriteBuilder, type SceneryKit } from '../toolkit/kit';
import { addNebula } from '../toolkit/nebula';
import { addStreams } from '../toolkit/streams';
import { layerBounds, makeStarField } from '../toolkit/stars';
import type { PrepareStep, SceneryFrame, SceneryInit, SceneryLook } from '../types';

/**
 * RED GIANT'S WAKE — a dying sun hangs just above the frame and exhales its shells: concentric planetary-nebula rings that
 * expand and cool from ember through rose and violet to teal, a turbulent tail of shed gas trailing away down-left, dark
 * charred dust lit orange from above, and a wind of embers streaming away from the star. Its glare throws long god rays.
 */

const LOOK: SceneryLook = {
  exposure: 1.0,
  contrast: 1.1,
  bloomThreshold: 1.1,
  bloomGain: 0.5,
  godRayGain: 0.32,
  godRayGas: 0.1,
  godRayHalo: 260,
  godRayDecay: 0.98,
  vignette: 0.6,
};

/** Design position of the star at the reference camera (screen px) and its radius. */
const STAR_X = 430;
const STAR_Y = -172;
const STAR_R = 240;
const STAR_PARALLAX = 0.05;
/** Where the tail of shed gas points (unit vector) and the fan the ember wind covers (radians, y down). */
const TAIL: readonly [number, number] = [-0.55, 0.835];

const STAR_FRAGMENT = /* glsl */ `
uniform vec3 uCen;        // centre x, y (layer px), radius
uniform vec3 uS0;
uniform vec3 uS1;
uniform vec3 uS2;
uniform vec3 uS3;
uniform vec3 uS4;
uniform vec3 uCorona;
uniform float uForceK;
uniform int uOct;

vec3 surf(float l) {
  if (l < 0.25) return mix(uS0, uS1, l / 0.25);
  if (l < 0.5) return mix(uS1, uS2, (l - 0.25) / 0.25);
  if (l < 0.75) return mix(uS2, uS3, (l - 0.5) / 0.25);
  return mix(uS3, uS4, clamp((l - 0.75) / 0.25, 0.0, 1.0));
}

void main() {
  vec2 sp = warpByForces(screenPx(), -uForceK);
  vec2 lp = sp + uView * uParallax;
  vec2 d = lp - uCen.xy;
  float R = uCen.z;
  float r = length(d) / R;
  float t = uFlow * 0.012;
  vec3 col = vec3(0.0);
  if (r < 1.0) {
    float mu = sqrt(max(1.0 - r * r, 0.0));
    // convection: big slow cells, foreshortened toward the limb
    vec2 g = d / R * 5.0 / max(mu, 0.3);
    float n = fbm(g + vec2(t, -t * 0.7), uOct);
    float n2 = fbm(g * 2.4 - vec2(t * 1.5, t), max(2, uOct - 1));
    float cell = smoothstep(0.3, 0.72, n);
    float spot = smoothstep(0.62, 0.45, fbm(g * 0.6 + vec2(4.0, t * 0.3), 3));
    float lum = (0.28 + 0.62 * pow(mu, 0.7)) * (0.72 + 0.4 * cell + 0.22 * (n2 - 0.5)) * (1.0 - 0.45 * spot);
    col = surf(clamp(lum, 0.0, 1.0));
  }
  // atmosphere: a hot rim just outside the limb, then a corona that thins out into the glow of the shells
  float rr = max(r - 1.0, 0.0);
  float ang = atan(d.y, d.x);
  float turb = fbm(vec2(ang * 3.0, rr * 4.0 - t * 3.0), 3);
  float rim = exp(-rr * 34.0) * (r >= 1.0 ? 1.0 : 0.0) * (0.7 + 0.5 * turb);
  float corona = (exp(-rr * 6.0) * 0.55 + exp(-rr * 2.4) * 0.12) * (0.75 + 0.5 * turb);
  col += uCorona * (rim * 1.0 + corona * (r >= 1.0 ? 1.0 : 0.6));
  col *= 1.0 + 0.35 * uIntensity;
  o = vec4(col, 1.0);
}
`;

const SHELLS_FRAGMENT = /* glsl */ `
uniform vec3 uCen;
uniform vec4 uShell;      // first radius, gap, expansion speed (px/s), width
uniform vec3 uK0;         // ember / orange
uniform vec3 uK1;         // rose-magenta
uniform vec3 uK2;         // violet
uniform vec3 uK3;         // teal
uniform float uForceK;
uniform float uGain;

void main() {
  vec2 sp = warpByForces(screenPx(), -uForceK);
  vec2 lp = sp + uView * uParallax;
  vec2 d = lp - uCen.xy;
  float dist = length(d);
  float t = uFlow;
  float ang = atan(d.y, d.x);
  // filaments: the radius is pushed about by warped noise, more so farther out
  vec2 q = d / 90.0;
  float w = (fbm(q * 0.9 + vec2(0.0, t * 0.01), 4) - 0.5) * (12.0 + dist * 0.04);
  float k = (dist + w - uShell.x - t * uShell.z) / uShell.y;
  float idx = floor(k + 0.5);
  float f = k - idx;
  float h = hash21(vec2(idx, 3.7));
  float width = uShell.w * mix(0.6, 1.5, h) / uShell.y;
  float ring = exp(-pow(f / width, 2.0));
  // clumps around each ring; some shells are broken arcs, some nearly complete
  float clump = fbm(vec2(ang * (2.0 + h * 3.0) + h * 40.0, idx * 5.3 + t * 0.004), 3);
  float cover = smoothstep(0.4 - 0.14 * h, 0.66, clump);
  float fine = 0.35 + 1.1 * smoothstep(0.3, 0.75, fbm(vec2(ang * dist / 16.0, idx * 3.1 + t * 0.01), 3));   // filaments along the ring
  // faint diffuse gas between the shells
  float between = (0.16 + 0.5 * fbm(q * 1.4 + vec2(7.0, 3.0), 4)) * 0.07;
  float I = ring * cover * fine * (0.5 + 0.9 * h) + between;
  I *= exp(-max(dist - 260.0, 0.0) / 520.0);
  float show = smoothstep(uShell.x * 0.75, uShell.x * 1.15, dist + w);
  // the shells cool as they travel: ember → rose → violet → teal
  vec3 c = uK0;
  c = mix(c, uK1, smoothstep(300.0, 390.0, dist));
  c = mix(c, uK2, smoothstep(390.0, 470.0, dist));
  c = mix(c, uK3, smoothstep(470.0, 560.0, dist));
  o = vec4(c * I * show * uGain * (1.0 + 0.4 * uIntensity), 1.0);
}
`;

const PLUME_FRAGMENT = /* glsl */ `
uniform vec4 uAxis;      // star x, y (layer px), tail direction x, y
uniform vec4 uPlume;     // half width at the head, spread per px, length, scale
uniform vec3 uP0;        // thin gas: violet
uniform vec3 uP1;        // dense gas: rose-ember
uniform vec3 uP2;        // lit surfaces
uniform vec2 uLightD;    // toward the star
uniform float uForceK;
uniform float uGain;

float plume(vec2 lp, float t) {
  vec2 p = lp - uAxis.xy;
  vec2 a = uAxis.zw;
  vec2 nrm = vec2(-a.y, a.x);
  float u = dot(p, a);
  float v = dot(p, nrm);
  vec2 q = vec2(u, v) / uPlume.w;
  float warp = (fbm(q * 0.45 + vec2(3.1 - t * 0.04, 1.7), 3) - 0.5) * uPlume.x * 1.6;
  float w = uPlume.x + max(u, 0.0) * uPlume.y;
  float across = exp(-pow((v + warp) / w, 2.0));
  float along = smoothstep(180.0, 420.0, u) * exp(-max(u - uPlume.z, 0.0) / 260.0);
  float n = fbm(q * vec2(1.0, 1.4) + vec2(-t * 0.05, 0.0) + (fbm(q * 0.8 + 9.0, 3) - 0.5) * 2.0, 5);
  return across * along * smoothstep(0.38, 0.85, n);
}

void main() {
  vec2 sp = warpByForces(screenPx(), -uForceK);
  vec2 lp = sp + uView * uParallax;
  float t = uFlow;
  float d = plume(lp, t);
  float dl = plume(lp + uLightD * 14.0, t);
  float lit = clamp((d - dl) * 7.0, 0.0, 1.0);
  vec3 col = mix(uP0, uP1, smoothstep(0.1, 0.9, d)) * d + uP2 * lit * d;
  col += impulseGlow(sp) * d * 0.5;
  o = vec4(col * uGain * (1.0 + 0.5 * uIntensity), 1.0);
}
`;

export class RedGiantScenery extends SceneryBase {
  readonly id = 'redgiant' as const;
  readonly look: SceneryLook = { ...LOOK };
  protected readonly noiseSeed = 0x524741;
  private info: StageInfo = STAGE_INFO.redgiant;
  private ambient: AmbientLife | null = null;
  private star: [number, number] = atRef(STAR_X, STAR_Y, STAR_PARALLAX);
  private view = { x0: REF_X0, y0: REF_Y0 };

  protected *build(kit: SceneryKit, _ctx: SceneryInit): Generator<PrepareStep, void, void> {
    const arena = this.info.arena;
    const R = paletteRamps(this.info);
    // ramp order of STAGE_INFO.redgiant: void, ember, orange, white-hot, umber, violet, teal, rose
    const [VOID, EMBER, ORANGE, HOT, UMBER, VIOLET, TEAL, ROSE] = [
      R[0]!,
      R[1]!,
      R[2]!,
      R[3]!,
      R[4]!,
      R[5]!,
      R[6]!,
      R[7]!,
    ];
    const rng = new Rng(0x2c1);
    const [sx, sy] = this.star;

    /* ---- 1. sky: violet-black, a faint warm glow toward the star ---- */
    addNebula(kit, 'sky', {
      parallax: 0.02,
      scale: 300,
      warp: 1.3,
      octaves: 4,
      thresh: [0.2, 0.95],
      colA: scale(VOID[2]!, 0.7),
      colB: mixRgb(VOID[4]!, VIOLET[1]!, 0.35),
      colC: [0, 0, 0],
      colD: [0, 0, 0],
      gain: 1,
      lightDir: [0.5, -0.8],
      litK: 0,
      flowSpeed: 0.012,
      seed: [4.1, 9.7],
      mode: 'emit',
      forceK: 0.3,
    });
    yield 0.04;

    /* ---- 2. far stars, faint and reddened by the dust between ---- */
    const bd = layerBounds(arena, 0.03);
    kit.addSprites('stars-far', {
      buffer: makeStarField({
        count: 1500,
        bounds: bd,
        size: [0.55, 0.95],
        base: 0.28,
        boost: 1.5,
        tint: [1.0, 0.9, 0.85],
        seed: 211,
      }),
      parallax: 0.03,
      blend: 'add',
      soft: 4,
      snap: true,
      twinkle: 0.16,
      forceK: 0.05,
    });
    yield 0.07;

    /* ---- 3. ambient life ---- */
    const ambParallax = 0.05;
    this.ambient = new AmbientLife(kit, {
      seed: 0x5a17,
      parallax: ambParallax,
      cometColor: [1.0, 0.72, 0.5],
      flareColor: [0.85, 0.7, 1.0],
      comets: 2,
      cometPeriod: [15, 25],
      cometLife: 6.5,
      flares: 2,
      flarePeriod: [10, 17],
      region: {
        x0: -20 + REF_X0 * ambParallax,
        y0: 40 + REF_Y0 * ambParallax,
        x1: 660 + REF_X0 * ambParallax,
        y1: 250 + REF_Y0 * ambParallax,
      },
    });
    yield 0.09;

    /* ---- 4. the dying sun ---- */
    const starLayer = kit.addFullscreen('star', STAR_FRAGMENT, 'add', STAR_PARALLAX, {
      uCen: { value: [sx, sy, STAR_R] },
      uS0: { value: [...scale(EMBER[3]!, 0.9)] },
      uS1: { value: [...scale(EMBER[6]!, 1.0)] },
      uS2: { value: [...scale(ORANGE[4]!, 1.05)] },
      uS3: { value: [...scale(ORANGE[5]!, 1.0)] },
      uS4: { value: [...scale(ORANGE[7]!, 1.1)] },
      uCorona: { value: [...mixRgb(rampAt(ORANGE, 0.6), rampAt(EMBER, 0.75), 0.4)] },
      uForceK: { value: 0.15 },
      uOct: { value: 4 },
    });
    kit.onQuality((q) => {
      starLayer.uniforms.uOct!.value = 2 + q;
    });
    yield 0.16;

    /* ---- 5. the shells ---- */
    kit.addFullscreen('shells', SHELLS_FRAGMENT, 'add', 0.08, {
      uCen: { value: [...atRef(STAR_X, STAR_Y, 0.08), 0] },
      uShell: { value: [292, 58, 3.2, 3.6] },
      uK0: { value: [...mixRgb(rampAt(ORANGE, 0.62), rampAt(EMBER, 0.85), 0.3)] },
      uK1: { value: [...rampAt(ROSE, 0.62)] },
      uK2: { value: [...rampAt(VIOLET, 0.62)] },
      uK3: { value: [...rampAt(TEAL, 0.6)] },
      uForceK: { value: 0.5 },
      uGain: { value: 1.6 },
    });
    yield 0.24;

    /* ---- 6. the wake: a tail of shed gas trailing away down-left ---- */
    const plumeAt = atRef(STAR_X, STAR_Y, 0.2);
    kit.addFullscreen('wake', PLUME_FRAGMENT, 'add', 0.2, {
      uAxis: { value: [plumeAt[0], plumeAt[1], TAIL[0], TAIL[1]] },
      uPlume: { value: [70, 0.3, 640, 120] },
      uP0: { value: [...scale(VIOLET[3]!, 0.8)] },
      uP1: { value: [...scale(ROSE[2]!, 0.95)] },
      uP2: { value: [...scale(ORANGE[4]!, 0.8)] },
      uLightD: { value: [-TAIL[0], -TAIL[1]] },
      uForceK: { value: 0.7 },
      uGain: { value: 0.5 },
    });
    yield 0.34;

    /* ---- 7. the ember wind: streams of hot fragments fanning away from the star at three depths ---- */
    const emberColors = (k: number): [Rgb, Rgb, Rgb] => [
      scale(rampAt(HOT, 0.5), k),
      scale(rampAt(ORANGE, 0.6), k),
      scale(rampAt(EMBER, 0.45), k * 0.6),
    ];
    const fan = [Math.atan2(TAIL[1], TAIL[0]) - 0.62, Math.atan2(TAIL[1], TAIL[0]) + 0.62] as const;
    const originFar = atRef(STAR_X, STAR_Y, 0.1);
    addStreams(kit, 'embers-far', {
      parallax: 0.1,
      origin: originFar,
      count: 900,
      angle: fan,
      axisBias: 1.3,
      distance: [260, 1000],
      speed: 20,
      size: [0.7, 1.4],
      stretch: 3.5,
      wobble: 8,
      colors: emberColors(0.8),
      brightness: 1,
      alpha: 0.7,
      seed: 5,
      forceK: 0.35,
    });
    const originMid = atRef(STAR_X, STAR_Y, 0.3);
    addStreams(kit, 'embers-mid', {
      parallax: 0.3,
      origin: originMid,
      count: 300,
      angle: fan,
      axisBias: 1.2,
      distance: [280, 1100],
      speed: 34,
      size: [1.2, 2.4],
      stretch: 3,
      wobble: 14,
      colors: emberColors(0.7),
      brightness: 1,
      alpha: 0.6,
      seed: 6,
      forceK: 0.6,
    });
    yield 0.5;

    /* ---- 8. charred dust drifting in front, its upper edges lit orange by the star ---- */
    const dustAt = atRef(190, 230, 0.45);
    addNebula(kit, 'dust', {
      parallax: 0.45,
      scale: 140,
      warp: 2.6,
      octaves: 5,
      thresh: [0.5, 0.76],
      colA: scale(UMBER[0]!, 1.0),
      colB: scale(UMBER[1]!, 0.9),
      colC: [0, 0, 0],
      colD: scale(ORANGE[4]!, 1.0),
      gain: 1,
      lightDir: [0.55, -0.83],
      litK: 7,
      flowSpeed: 0.02,
      seed: [31.4, 7.3],
      mode: 'dust',
      alpha: 0.86,
      mask: [dustAt[0], dustAt[1], 330, 150],
      maskMix: 1,
      forceK: 0.8,
    });
    yield 0.62;

    /* ---- 9. a few hard stars, then the foreground bank and motes ---- */
    const heroes: HeroStar[] = [
      { sx: 70, sy: 60, size: 60, core: 3, bright: 2.2, tint: [1.0, 0.86, 0.7], parallax: 0.14, rot: 0.3 },
      { sx: 560, sy: 226, size: 40, core: 2, bright: 1.5, tint: [0.85, 0.8, 1.0], parallax: 0.22, rot: 0.8 },
    ];
    addHeroStars(kit, 'hero', heroes);
    addDustBank(kit, 'bank', {
      parallax: 0.9,
      col: scale(UMBER[0]!, 0.9),
      rim: scale(ORANGE[5]!, 0.9),
      lip: 0.1,
      top: 0.9,
      slope: 0.14,
      roughness: 0.3,
      soft: 0.2,
      scale: [180, 52],
      speed: 0.018,
      alpha: 0.97,
      forceK: 1.1,
      rimK: 1,
    });
    const mb = new SpriteBuilder();
    const mbounds = layerBounds(arena, 1.5);
    for (let i = 0; i < 70; i++) {
      const c = mixRgb(rampAt(EMBER, rng.range(0.4, 0.9)), rampAt(ORANGE, rng.range(0.4, 0.9)), rng.next());
      const k = rng.range(0.3, 0.8) * 2.4;
      mb.push(
        rng.range(mbounds.x0, mbounds.x1),
        rng.range(mbounds.y0, mbounds.y1),
        0,
        rng.next(),
        rng.range(2.5, 7),
        rng.range(2.5, 7),
        0,
        c[0] * k,
        c[1] * k,
        c[2] * k,
        0.12,
      );
    }
    kit.addSprites('motes', {
      buffer: mb.build(),
      parallax: 1.5,
      blend: 'add',
      soft: 1.4,
      drift: 12,
      driftFreq: 1 / 130,
      driftSpeed: 0.1,
      twinkle: 0.2,
      forceK: 1.5,
    });
  }

  protected override onUpdate(frame: SceneryFrame): void {
    this.ambient?.update(frame.timeSec);
    this.view.x0 = frame.view.x0;
    this.view.y0 = frame.view.y0;
  }

  lightScreenPos(out: { x: number; y: number }): void {
    screenOf(this.star[0], this.star[1], STAR_PARALLAX, this.view, out);
  }

  protected override disposeExtras(): void {
    this.ambient = null;
  }
}
