import { HalfFloatType, LinearFilter, type WebGLRenderTarget } from 'three';
import { Rng, type StageInfo } from '@/contracts';
import { STAGE_INFO } from '../info';
import { AmbientLife } from '../toolkit/ambient';
import { makeBakeTarget, prepareBake } from '../toolkit/bake';
import { REF_X0, REF_Y0, atCol, atRef, addHeroStars, type HeroStar } from '../toolkit/compose';
import { makeCloudSteps } from '../toolkit/clouds';
import { mixRgb, paletteRamps, rampAt, scale, type Rgb } from '../toolkit/color';
import { SceneryBase } from '../toolkit/base';
import { SpriteBuilder, type SceneryKit } from '../toolkit/kit';
import { addNebula } from '../toolkit/nebula';
import { Noise2 } from '../toolkit/noise';
import { layerBounds, makeStarField } from '../toolkit/stars';
import type { PrepareStep, SceneryFrame, SceneryInit, SceneryLook } from '../types';
import {
  FIELD_BAKE,
  SHADE_BAKE,
  layoutPillars,
  pillarDistance,
  type Column,
  type PillarColors,
  type PillarLayout,
} from './pillars';

/**
 * STELLAR NURSERY — the showpiece. A wall of dust pillars rises into the glare of newborn suns. Back to front:
 * sky gradient · far stars · warped emission gas · soft particle nebula · newborn stars with diffraction spikes ·
 * hazy far pillars · dust lanes · the sculpted main pillars (dust + ionisation rim) · evaporating wisps ·
 * near dust · foreground motes. Everything reacts to the fight (shock rings ripple it, impulses swirl and warm it,
 * intensity brightens it) and the scenery clock follows the sim's time scale.
 */

const LOOK: SceneryLook = {
  exposure: 1.0,
  contrast: 1.08,
  bloomThreshold: 1.15,
  bloomGain: 0.42,
  godRayGain: 2.0,
  godRayGas: 0.2,
  godRayHalo: 230,
  godRayDecay: 0.978,
  vignette: 0.55,
  foreground: { color: [0.15, 0.054, 0.18], alpha: 1 }, // dark plum dust
};

/** The big luminous haze behind everything: intensity falls off from the newborn stars and is modulated by warped fbm. */
const GLOW_FRAGMENT = /* glsl */ `
uniform vec2 uLightPos;
uniform float uReach;
uniform float uNScale;
uniform float uGlowGain;
uniform vec3 uS0;
uniform vec3 uS1;
uniform vec3 uS2;
uniform vec3 uS3;
uniform vec3 uS4;
uniform vec3 uS5;
uniform float uForceK;
uniform int uOct;

vec3 glowRamp(float I) {
  if (I < 0.04) return mix(uS0, uS1, I / 0.04);
  if (I < 0.14) return mix(uS1, uS2, (I - 0.04) / 0.10);
  if (I < 0.32) return mix(uS2, uS3, (I - 0.14) / 0.18);
  if (I < 0.62) return mix(uS3, uS4, (I - 0.32) / 0.30);
  return mix(uS4, uS5, clamp((I - 0.62) / 0.5, 0.0, 1.0));
}

void main() {
  vec2 sp = warpByForces(screenPx(), -uForceK);
  vec2 lp = sp + uView * uParallax;
  vec2 wp = lp / uNScale;
  float t = uFlow * 0.03;
  vec2 q = vec2(fbm(wp * 0.6 + vec2(0.0, t * 0.3), 3), fbm(wp * 0.6 + vec2(5.2 - t * 0.2, 1.3), 3));
  float n = fbm(wp + (q - 0.5) * 2.4, uOct);
  float n2 = fbm(wp * 2.7 + q * 3.0 + vec2(3.7, 1.1), max(2, uOct - 1));
  float ridge = 1.0 - abs(2.0 * fbm(wp * 1.6 + q * 2.0 + vec2(9.1, 4.3), max(2, uOct - 1)) - 1.0);
  vec2 dv = (lp - uLightPos) * vec2(1.0, 1.25);
  float base = exp(-length(dv) / uReach);
  float I = base * (0.2 + 1.1 * n + 0.6 * (n2 - 0.5) + 0.55 * ridge * ridge * ridge) - 0.02;
  I *= 1.0 - 0.75 * smoothstep(0.5, 1.05, sp.y / uRes.y);        // the bottom of the frame falls into shadow
  I += 0.05 * length(impulseGlow(sp));
  o = vec4(glowRamp(max(I, 0.0)) * uGlowGain, 1.0);
}
`;

/** Low mist along the bottom of the frame: fbm-edged, dark, with a faint warm scatter on its upper lip. */
const MIST_FRAGMENT = /* glsl */ `
uniform vec3 uMistCol;
uniform vec3 uMistRim;
uniform float uForceK;
void main() {
  vec2 sp = warpByForces(screenPx(), -uForceK);
  vec2 lp = sp + uView * uParallax;
  float t = uFlow * 0.02;
  float n = fbm(vec2(lp.x / 150.0 + t, lp.y / 46.0 - t * 0.4), 4);
  float y = sp.y / uRes.y;
  float edge = y + (n - 0.5) * 0.32 - 0.62;
  float a = smoothstep(0.0, 0.28, edge) * 0.9;
  float lip = smoothstep(0.0, 0.05, edge) * (1.0 - smoothstep(0.05, 0.16, edge));
  vec3 col = uMistCol + uMistRim * lip * (0.4 + 0.6 * n);
  o = vec4(col, a);
}
`;

export class NurseryScenery extends SceneryBase {
  readonly id = 'nursery' as const;
  readonly look: SceneryLook = { ...LOOK };
  protected readonly noiseSeed = 0x4e5572;
  private info: StageInfo = STAGE_INFO.nursery;
  private lightParallax = 0.09;
  private lightLayerX = atRef(78, -26, 0.09)[0];
  private lightLayerY = atRef(78, -26, 0.09)[1];
  private view = { x0: REF_X0, y0: REF_Y0 };
  private bakes: WebGLRenderTarget[] = [];
  private ambient: AmbientLife | null = null;

  protected *build(kit: SceneryKit, ctx: SceneryInit): Generator<PrepareStep, void, void> {
    const info = this.info;
    const arena = info.arena;
    // Everything is generated at full density; quality tiers thin the clouds at draw time (SceneryKit.setQuality).
    const q = 1;
    const R = paletteRamps(info);
    const [VOID, PLUM, MAG, COR, AMB, GOLD, STAR, TEAL] = [
      R[0]!,
      R[1]!,
      R[2]!,
      R[3]!,
      R[4]!,
      R[5]!,
      R[6]!,
      R[7]!,
    ];
    const noise = new Noise2(0x9a11);
    const [lx, ly, lz] = info.lighting.dir;
    const l2 = Math.hypot(lx, ly) || 1;
    const lightDir: [number, number] = [lx / l2, ly / l2];

    /* ---- 1. sky: deep indigo, a warm glow gathering toward the newborn stars ---- */
    addNebula(kit, 'sky', {
      parallax: 0.02,
      scale: 320,
      warp: 1.4,
      octaves: 4,
      thresh: [0.12, 0.9],
      colA: scale(VOID[1]!, 0.7),
      colB: mixRgb(VOID[3]!, PLUM[2]!, 0.35),
      colC: [0, 0, 0],
      colD: [0, 0, 0],
      gain: 1,
      lightDir: [-0.7, -0.7],
      litK: 0,
      flowSpeed: 0.02,
      seed: [3.1, 8.4],
      mode: 'emit',
      forceK: 0.3,
    });

    yield 0.04;

    /* ---- 2. far stars ---- */
    let bd = layerBounds(arena, 0.03);
    kit.addSprites('stars-far', {
      buffer: makeStarField({
        count: Math.round(1100 * q),
        bounds: bd,
        size: [0.55, 0.95],
        base: 0.32,
        boost: 1.8,
        seed: 11,
      }),
      parallax: 0.03,
      blend: 'add',
      soft: 4,
      snap: true,
      twinkle: 0.18,
      forceK: 0.05,
    });

    yield 0.07;

    /* ---- 2b. ambient life: comets and distant supernova flares (a pure function of the scenery clock) ---- */
    const ambParallax = 0.05;
    const ambient = new AmbientLife(kit, {
      seed: 0x4e57,
      parallax: ambParallax,
      cometColor: [0.7, 0.85, 1.0],
      flareColor: [1.0, 0.72, 0.85],
      comets: 2,
      cometPeriod: [16, 27],
      cometLife: 6.5,
      flares: 2,
      flarePeriod: [9, 17],
      region: {
        x0: -20 + REF_X0 * ambParallax,
        y0: 10 + REF_Y0 * ambParallax,
        x1: 660 + REF_X0 * ambParallax,
        y1: 230 + REF_Y0 * ambParallax,
      },
    });
    this.ambient = ambient;

    yield 0.09;

    /* ---- 3. the luminous haze: a gradient of ionised gas centred on the newborn stars ---- */
    const lightAt = atRef(78, -26, 0.09);
    const glowLayer = kit.addFullscreen('glow', GLOW_FRAGMENT, 'add', 0.09, {
      uLightPos: { value: [...lightAt] },
      uReach: { value: 360 },
      uNScale: { value: 210 },
      uGlowGain: { value: 1.0 },
      uS0: { value: [...scale(VOID[2]!, 0.8)] },
      uS1: { value: [...mixRgb(VOID[4]!, MAG[0]!, 0.5)] },
      uS2: { value: [...scale(MAG[3]!, 1.0)] },
      uS3: { value: [...scale(COR[2]!, 1.0)] },
      uS4: { value: [...scale(AMB[5]!, 1.05)] },
      uS5: { value: [1.5, 1.12, 0.78] },
      uForceK: { value: 0.5 },
      uOct: { value: 5 },
    });
    kit.onQuality((qt) => {
      glowLayer.uniforms.uOct!.value = 3 + qt;
    });
    const backlight = atRef(360, 190, 0.16);
    addNebula(kit, 'gas-mid', {
      parallax: 0.16,
      scale: 170,
      warp: 2.6,
      octaves: 5,
      thresh: [0.44, 0.88],
      colA: scale(MAG[1]!, 1.0),
      colB: scale(MAG[4]!, 0.6),
      colC: scale(AMB[3]!, 0.5),
      colD: scale(GOLD[1]!, 0.5),
      gain: 0.85,
      lightDir: [-0.75, -0.65],
      litK: 6,
      flowSpeed: 0.05,
      seed: [14.5, 5.9],
      mode: 'emit',
      mask: [backlight[0], backlight[1], 520, 330],
      maskMix: 0.6,
      forceK: 0.7,
    });

    yield 0.13;

    /* ---- 4. particle nebula: the fine, volumetric body of the gas ---- */
    bd = layerBounds(arena, 0.12);
    const warmZone = atRef(120, 30, 0.12);
    kit.addSprites('nebula-far', {
      buffer: yield* makeCloudSteps({
        count: Math.round(5500 * q),
        bounds: bd,
        noise,
        freq: 1 / 200,
        lo: 0.46,
        hi: 0.8,
        size: [8, 27],
        stretch: [1, 1.7],
        rotation: (x, y, rng) => noise.noise(x / 260, y / 260) * 1.6 + (rng.next() - 0.5) * 0.5,
        color: (x, y, d, u) => {
          const dl = Math.hypot(x - warmZone[0], y - warmZone[1]);
          const warm = Math.exp(-dl / 420);
          const c = mixRgb(rampAt(MAG, 0.25 + 0.55 * d), rampAt(AMB, 0.3 + 0.5 * d), warm * 0.85);
          const teal = u > 0.93 ? 0.6 : 0;
          const cc = mixRgb(c, TEAL[2]!, teal);
          const k = 0.35 + 0.65 * d;
          return [cc[0] * k, cc[1] * k, cc[2] * k, 0.085 + 0.06 * d];
        },
        seed: 21,
      }),
      parallax: 0.12,
      spread: 0.04,
      blend: 'add',
      soft: 2.2,
      breakup: 0.65,
      drift: 5,
      driftFreq: 1 / 100,
      driftSpeed: 0.09,
      forceK: 0.55,
    });

    yield 0.3;

    /* ---- 5. stars: field + hero stars with diffraction spikes ---- */
    bd = layerBounds(arena, 0.2);
    kit.addSprites('stars-mid', {
      buffer: makeStarField({
        count: Math.round(320 * q),
        bounds: bd,
        size: [0.9, 1.7],
        base: 0.55,
        boost: 2.6,
        seed: 12,
      }),
      parallax: 0.2,
      blend: 'add',
      soft: 3,
      snap: true,
      twinkle: 0.3,
      forceK: 0.15,
    });
    const white: Rgb = [1.0, 0.86, 0.66];
    const blueW: Rgb = [0.78, 0.86, 1.0];
    const heroes: HeroStar[] = [
      { sx: 78, sy: -26, size: 200, core: 6, bright: 5.5, tint: white, parallax: 0.09, rot: 0.1 },
      { sx: 122, sy: -4, size: 84, core: 3.4, bright: 2.8, tint: blueW, parallax: 0.09, rot: 0.5 },
      { sx: 44, sy: 12, size: 60, core: 2.6, bright: 2.0, tint: [1, 0.84, 0.66], parallax: 0.09, rot: 0.9 },
      { sx: 334, sy: 40, size: 66, core: 2.6, bright: 2.0, tint: blueW, parallax: 0.14, rot: 0.25 },
      { sx: 566, sy: 74, size: 50, core: 2.2, bright: 1.5, tint: blueW, parallax: 0.17, rot: 0.7 },
      { sx: 476, sy: 16, size: 40, core: 2.0, bright: 1.4, tint: white, parallax: 0.13, rot: 0.15 },
      { sx: 156, sy: 196, size: 30, core: 1.6, bright: 1.1, tint: blueW, parallax: 0.2, rot: 0.4 },
      { sx: 612, sy: 226, size: 30, core: 1.6, bright: 1.15, tint: white, parallax: 0.22, rot: 0.85 },
    ];
    this.lightParallax = heroes[0]!.parallax;
    const hp = atRef(heroes[0]!.sx, heroes[0]!.sy, heroes[0]!.parallax);
    this.lightLayerX = hp[0];
    this.lightLayerY = hp[1];
    addHeroStars(kit, 'hero', heroes);

    yield 0.36;

    /* ---- 6. the pillars ---- */
    const key = new Float32Array([lx, ly, lz]);
    const far: PillarColors = {
      body: [
        scale(VOID[1]!, 0.9),
        scale(VOID[3]!, 0.9),
        mixRgb(PLUM[2]!, VOID[4]!, 0.5),
        scale(MAG[2]!, 0.7),
      ],
      rimHot: scale(AMB[5]!, 1.0),
      rimMid: scale(MAG[5]!, 0.55),
      rimOuter: scale(MAG[3]!, 0.45),
      backRim: scale(STAR[2]!, 0.3),
      haze: 0.3,
      hazeCol: mixRgb(VOID[4]!, MAG[1]!, 0.5),
    };
    const near: PillarColors = {
      body: [
        scale(VOID[1]!, 1.0),
        scale(PLUM[2]!, 0.9),
        mixRgb(PLUM[4]!, AMB[1]!, 0.5),
        scale(AMB[3]!, 1.05),
      ],
      rimHot: [2.3, 1.5, 0.7],
      rimMid: scale(AMB[6]!, 1.3),
      rimOuter: scale(MAG[6]!, 0.95),
      backRim: scale(TEAL[3]!, 0.5),
      haze: 0,
      hazeCol: [0, 0, 0],
    };
    yield* this.bakePillars(kit, ctx, {
      name: 'pillars-far',
      parallax: 0.34,
      seed: 501,
      columns: [
        { ...atCol(340, 128, 0.34), r: 26, lean: 10, fingers: 1 },
        { ...atCol(96, 176, 0.34), r: 22, lean: -8, fingers: 1 },
      ],
      spacing: 280,
      height: [190, 290],
      radius: [22, 34],
      fingers: [0, 2],
      colors: far,
      key,
      lightDir,
      alpha: 0.9,
      glowGain: 0.9,
    });
    addNebula(kit, 'dust-lanes', {
      parallax: 0.44,
      scale: 130,
      warp: 2.8,
      octaves: 5,
      thresh: [0.5, 0.74],
      colA: scale(VOID[1]!, 1),
      colB: scale(PLUM[1]!, 0.8),
      colC: [0, 0, 0],
      colD: scale(AMB[4]!, 0.85),
      gain: 1,
      lightDir: [-0.75, -0.65],
      litK: 7,
      flowSpeed: 0.03,
      seed: [30.2, 9.1],
      mode: 'dust',
      alpha: 0.62,
      forceK: 0.8,
    });
    const pillars = yield* this.bakePillars(kit, ctx, {
      name: 'pillars',
      parallax: 0.58,
      seed: 733,
      columns: [
        { ...atCol(150, 56, 0.58), r: 46, lean: -22, fingers: 3 },
        { ...atCol(350, 216, 0.58), r: 30, lean: 14, fingers: 2 },
        { ...atCol(548, 96, 0.58), r: 44, lean: -10, fingers: 3 },
      ],
      spacing: 300,
      height: [330, 440],
      radius: [36, 52],
      fingers: [1, 3],
      colors: near,
      key,
      lightDir,
      alpha: 1,
      glowGain: 1,
    });

    yield 0.72;

    /* ---- 7. evaporating wisps off the crowns and lit edges, teal scatter on the shadow side ---- */
    const wb = new SpriteBuilder();
    const wrng = new Rng(77);
    const wisp = (x: number, y: number, size: number, c: Rgb, k: number, alpha: number): void => {
      if (pillarDistance(pillars, x, y) < 9) return; // gas evaporates OFF the dust (the smooth union inflates the GPU silhouette by ~8 px)
      wb.push(
        x,
        y,
        wrng.range(-1, 1),
        wrng.next(),
        size * wrng.range(0.8, 1.25),
        size * wrng.range(0.8, 1.25),
        wrng.range(0, 3),
        c[0] * k,
        c[1] * k,
        c[2] * k,
        alpha,
      );
    };
    for (const t of pillars.tips) {
      const n = Math.round((26 + t.r * 1.2) * q);
      for (let i = 0; i < n; i++) {
        const a = wrng.range(0, Math.PI * 2);
        const rr = wrng.range(0, 1) * (t.r * 2.6 + 44);
        const x = t.x + Math.cos(a) * rr + lightDir[0] * 12;
        const y = t.y + Math.sin(a) * rr * 0.8 - 8;
        const c = mixRgb(
          rampAt(AMB, wrng.range(0.35, 0.9)),
          rampAt(MAG, wrng.range(0.4, 0.85)),
          wrng.range(0, 0.6),
        );
        wisp(x, y, wrng.range(6, 16), c, wrng.range(0.5, 1.2) * 2.4, 0.17);
      }
      // ionised oxygen: a few cool teal puffs on the side away from the stars
      const nt = Math.round((3 + t.r * 0.15) * q);
      for (let i = 0; i < nt; i++) {
        const a = wrng.range(-0.9, 0.9) + (lightDir[0] < 0 ? 0 : Math.PI);
        const rr = t.r * wrng.range(0.9, 2.1) + 8;
        wisp(
          t.x + Math.cos(a) * rr,
          t.y + Math.sin(a) * rr * 0.7 - 4,
          wrng.range(3, 9),
          rampAt(TEAL, wrng.range(0.45, 0.9)),
          wrng.range(0.5, 1.0) * 1.6,
          0.13,
        );
      }
    }
    for (const e of pillars.litEdge) {
      const n = Math.round(6 * q);
      for (let i = 0; i < n; i++) {
        const c = mixRgb(rampAt(AMB, 0.7), rampAt(GOLD, 0.5), wrng.next());
        wisp(
          e.x + wrng.range(-10, 6),
          e.y + wrng.range(-14, 14),
          wrng.range(3, 8),
          c,
          wrng.range(0.5, 1.1) * 2.2,
          0.16,
        );
      }
    }
    kit.addSprites('wisps', {
      buffer: wb.build(),
      parallax: 0.58,
      spread: 0.02,
      blend: 'add',
      soft: 2,
      breakup: 0.7,
      drift: 7,
      driftFreq: 1 / 60,
      driftSpeed: 0.16,
      twinkle: 0.1,
      forceK: 0.95,
    });

    yield 0.85;

    /* ---- 8. near dust drifting past, and foreground motes ---- */
    bd = layerBounds(arena, 0.85);
    kit.addSprites('dust-near', {
      buffer: yield* makeCloudSteps({
        count: Math.round(90 * q),
        bounds: bd,
        noise,
        freq: 1 / 260,
        lo: 0.5,
        hi: 0.8,
        size: [30, 84],
        stretch: [1, 2.2],
        rotation: (x, y, rng) => noise.noise(x / 300, y / 300) * 1.5 + (rng.next() - 0.5) * 0.4,
        color: (_x, _y, _d, u) => {
          const c = mixRgb(VOID[1]!, PLUM[1]!, u);
          return [c[0], c[1], c[2], 0.34];
        },
        seed: 31,
      }),
      parallax: 0.85,
      spread: 0.05,
      blend: 'normal',
      soft: 1.8,
      breakup: 0.5,
      drift: 12,
      driftFreq: 1 / 180,
      driftSpeed: 0.05,
      forceK: 1.2,
    });
    /* a bank of dark mist along the bottom: the ground the fighters stand in, and where the pillars dissolve */
    kit.addFullscreen('mist', MIST_FRAGMENT, 'normal', 0.9, {
      uMistCol: { value: [...scale(VOID[2]!, 1.2)] },
      uMistRim: { value: [...scale(MAG[3]!, 0.55)] },
      uForceK: { value: 1.1 },
    });
    bd = layerBounds(arena, 1.55);
    const mrng = new Rng(91);
    kit.addSprites('motes', {
      buffer: yield* makeCloudSteps({
        count: Math.round(90 * q),
        bounds: bd,
        noise,
        freq: 1 / 80,
        lo: 0,
        hi: 0.05,
        size: [2.5, 8],
        color: () => {
          const c = mixRgb(
            rampAt(AMB, mrng.range(0.4, 0.85)),
            rampAt(MAG, mrng.range(0.5, 0.9)),
            mrng.range(0, 1),
          );
          const k = mrng.range(0.25, 0.7);
          return [c[0] * k * 2.6, c[1] * k * 2.6, c[2] * k * 2.6, 0.13];
        },
        seed: 41,
      }),
      parallax: 1.55,
      blend: 'add',
      soft: 1.4,
      drift: 12,
      driftFreq: 1 / 130,
      driftSpeed: 0.11,
      twinkle: 0.2,
      forceK: 1.5,
    });
  }

  /** Bake one pillar field (dust + rim glow) into textures and add its two layers to the kit. */
  private *bakePillars(
    kit: SceneryKit,
    ctx: SceneryInit,
    o: {
      name: string;
      parallax: number;
      seed: number;
      columns: Column[];
      spacing: number;
      height: [number, number];
      radius: [number, number];
      fingers: [number, number];
      colors: PillarColors;
      key: Float32Array;
      lightDir: [number, number];
      alpha: number;
      glowGain: number;
    },
  ): Generator<PrepareStep, PillarLayout, void> {
    const bounds = layerBounds(this.info.arena, o.parallax, 70);
    const layout = layoutPillars({
      bounds,
      seed: o.seed,
      columns: o.columns,
      spacing: o.spacing,
      height: o.height,
      radius: o.radius,
      fingers: o.fingers,
      lightDir: o.lightDir,
    });
    yield 0; // layout done
    const w = Math.ceil(bounds.x1 - bounds.x0);
    const h = Math.ceil(bounds.y1 - bounds.y0);
    const field = makeBakeTarget(w, h, { type: HalfFloatType });
    const out = makeBakeTarget(w, h, { count: 2, linear: false });
    const renderer = ctx.renderer;
    const noiseU = kit.uniforms.uNoise;
    const seed2: [number, number] = [(o.seed % 97) * 0.37, (o.seed % 53) * 0.61];
    const fieldJob = prepareBake(renderer, field, FIELD_BAKE, {
      uNoise: noiseU,
      uOrigin: { value: [bounds.x0, bounds.y0] },
      uNSeg: { value: layout.count },
      uSegA: { value: layout.segA },
      uSegB: { value: layout.segB },
      uBlend: { value: 30 },
      uWarp: { value: 16 },
      uErode: { value: 13 },
      uSeed: { value: seed2 },
      uView: kit.uniforms.uView,
      uRes: kit.uniforms.uRes,
      uTime: kit.uniforms.uTime,
      uFlow: kit.uniforms.uFlow,
      uIntensity: kit.uniforms.uIntensity,
      uShock: kit.uniforms.uShock,
      uNShock: kit.uniforms.uNShock,
      uImp: kit.uniforms.uImp,
      uImp2: kit.uniforms.uImp2,
      uNImp: kit.uniforms.uNImp,
    });
    const c = o.colors;
    field.rt.texture.minFilter = LinearFilter; // the shade pass samples the field bilinearly
    const shadeJob = prepareBake(
      renderer,
      out,
      SHADE_BAKE,
      {
        uNoise: noiseU,
        uField: { value: field.rt.texture },
        uL: { value: [...o.key] },
        uCol0: { value: [...c.body[0]] },
        uCol1: { value: [...c.body[1]] },
        uCol2: { value: [...c.body[2]] },
        uCol3: { value: [...c.body[3]] },
        uRimHot: { value: [...c.rimHot] },
        uRimMid: { value: [...c.rimMid] },
        uRimOuter: { value: [...c.rimOuter] },
        uBackRim: { value: [...c.backRim] },
        uBump: { value: 3.4 },
        uRimW: { value: 1.15 },
        uGlowW: { value: 8 },
        uHaze: { value: c.haze },
        uHazeCol: { value: [...c.hazeCol] },
        uFade: { value: 170 },
        uFadeY: { value: 330 + REF_Y0 * o.parallax - bounds.y0 },
        uView: kit.uniforms.uView,
        uRes: kit.uniforms.uRes,
        uTime: kit.uniforms.uTime,
        uFlow: kit.uniforms.uFlow,
        uIntensity: kit.uniforms.uIntensity,
        uShock: kit.uniforms.uShock,
        uNShock: kit.uniforms.uNShock,
        uImp: kit.uniforms.uImp,
        uImp2: kit.uniforms.uImp2,
        uNImp: kit.uniforms.uNImp,
      },
      { multi: true },
    );
    // Both programs compile off-thread while the game keeps running (where the browser supports it), then the two draws run.
    yield Promise.all([fieldJob.ready, shadeJob.ready]);
    fieldJob.run();
    yield 0; // signed-distance field baked
    shadeJob.run();
    yield 0; // lighting baked
    field.rt.dispose();
    this.bakes.push(out.rt);
    const rect: [number, number, number, number] = [bounds.x0, bounds.y0, w, h];
    kit.addQuad(`${o.name}-dust`, {
      rect,
      parallax: o.parallax,
      blend: 'normal',
      map: out.rt.textures[0]!,
      forceK: 0.9,
      pad: 40,
      extra: { uGain: { value: 1 }, uAlpha: { value: o.alpha } },
      fragment: /* glsl */ `
uniform float uGain;
uniform float uAlpha;
void main() {
  vec4 t = sampleMap(vScreen);
  if (t.a < 0.004) discard;
  vec3 c = pow(t.rgb, vec3(2.2)) * uGain;
  c += impulseGlow(vScreen) * 0.24 * (0.3 + t.a);
  o = vec4(c, t.a * uAlpha);
}`,
    });
    kit.addQuad(`${o.name}-glow`, {
      rect,
      parallax: o.parallax,
      blend: 'add',
      map: out.rt.textures[1]!,
      forceK: 0.9,
      pad: 40,
      extra: { uGain: { value: o.glowGain } },
      fragment: /* glsl */ `
uniform float uGain;
void main() {
  vec4 t = sampleMap(vScreen);
  vec3 c = pow(t.rgb, vec3(2.2)) * 4.0 * uGain * (1.0 + 0.4 * uIntensity);
  c *= 1.0 + length(impulseGlow(vScreen)) * 0.9;
  o = vec4(c, 1.0);
}`,
    });
    return layout;
  }

  protected override onUpdate(frame: SceneryFrame): void {
    this.ambient?.update(frame.timeSec);
    this.view.x0 = frame.view.x0;
    this.view.y0 = frame.view.y0;
  }

  lightScreenPos(out: { x: number; y: number }): void {
    out.x = this.lightLayerX - this.view.x0 * this.lightParallax;
    out.y = this.lightLayerY - this.view.y0 * this.lightParallax;
  }

  protected override disposeExtras(): void {
    this.ambient = null;
    for (const t of this.bakes) t.dispose();
    this.bakes = [];
  }
}
