import { Rng, type StageInfo } from '@/contracts';
import { STAGE_INFO } from '../info';
import { AmbientLife } from '../toolkit/ambient';
import { addDustBank } from '../toolkit/bank';
import { REF_X0, REF_Y0, atRef, screenOf } from '../toolkit/compose';
import { mixRgb, paletteRamps, rampAt, scale, type Rgb } from '../toolkit/color';
import { SceneryBase } from '../toolkit/base';
import { addGalaxyDiscs, setDiscSpin, type GalaxyDisc } from '../toolkit/galaxy';
import { SpriteBuilder, type KitLayer, type SceneryKit } from '../toolkit/kit';
import { addNebula } from '../toolkit/nebula';
import { addStreams } from '../toolkit/streams';
import { layerBounds, makeStarField } from '../toolkit/stars';
import type { PrepareStep, SceneryFrame, SceneryInit, SceneryLook } from '../types';

/**
 * QUASAR VOID — almost nothing, and one thing of terrible power. The sky is near-black and empty but for a few cold stars, faint
 * lensed galaxies and the barest filaments of the cosmic web. From a blinding core just beyond the top-right corner a relativistic
 * jet is thrown across the frame: a hair-thin ice-blue beam with a violet sheath, knots of plasma racing outward along it, its
 * whole length writhing in a slow helix. The jet lights everything it passes.
 */

const LOOK: SceneryLook = {
  exposure: 1.0,
  contrast: 1.18,
  bloomThreshold: 0.85,
  bloomGain: 0.75,
  godRayGain: 0.1,
  godRayGas: 0.05,
  godRayHalo: 300,
  godRayDecay: 0.98,
  vignette: 0.7,
  // near-black sky: a fighter's dark body needs a lifted backlight rim and the halo can stay gentle
  spriteHalo: { strength: 0.24, radius: 9, desat: 0.3, rim: 0.45, rimReach: 1, lift: 0.2 },
};

const CORE_X = 596;
const CORE_Y = -58;
const CORE_PARALLAX = 0.05;
/** Unit direction of the jet, from the core down-left across the frame. */
const JET: readonly [number, number] = [-0.83, 0.56];

const JET_FRAGMENT = /* glsl */ `
uniform vec4 uJ;         // core x, y (layer px), jet direction x, y
uniform vec4 uJ2;        // half width at the core, spread per px, length, helix amplitude
uniform vec3 uCore;      // hot axis
uniform vec3 uSheath;    // ice-blue sheath
uniform vec3 uCocoon;    // violet cocoon
uniform float uForceK;
uniform float uGain;

void main() {
  vec2 sp = warpByForces(screenPx(), -uForceK);
  vec2 lp = sp + uView * uParallax;
  vec2 p = lp - uJ.xy;
  vec2 a = uJ.zw;
  vec2 nrm = vec2(-a.y, a.x);
  float u = dot(p, a);
  float v = dot(p, nrm);
  float t = uFlow;
  // the jet writhes: a slow helical kink that grows with distance, and a faster shimmer on top
  float wig = uJ2.w * (sin(u / 85.0 - t * 0.32) * smoothstep(40.0, 320.0, u) + 0.45 * sin(u / 26.0 - t * 0.85) * smoothstep(120.0, 520.0, u));
  v -= wig;
  float w = uJ2.x + max(u, 0.0) * uJ2.y;
  float axis = exp(-pow(v / w, 2.0));
  float sheath = exp(-pow(v / (w * 2.6), 2.0));
  float cocoon = exp(-pow(v / (w * 7.0), 2.0));
  // knots of plasma racing outward: brighter than the beam between them, each with its own strength
  float ph = u / 88.0 - t * 0.24;
  float cell = floor(ph);
  float kv = 0.35 + 0.65 * hash21(vec2(cell, 7.3));
  float knot = pow(0.5 + 0.5 * cos(6.2832 * ph), 4.0) * kv;
  float grain = fbm(vec2(u / 34.0 - t * 0.7, v / max(w, 1.0) * 0.6 + cell), 4);
  float along = smoothstep(-10.0, 80.0, u) * exp(-max(u - uJ2.z, 0.0) / 240.0) * (0.45 + 0.55 * exp(-max(u, 0.0) / 520.0));
  float I = axis * (0.35 + 1.5 * knot) * (0.55 + 0.9 * grain);
  vec3 col = uCore * I + uSheath * sheath * (0.16 + 0.5 * knot) * (0.6 + 0.6 * grain) + uCocoon * cocoon * 0.1 * (0.6 + 0.8 * grain);
  col *= along * uGain * (1.0 + 0.7 * uIntensity);
  col += impulseGlow(sp) * sheath * along * 0.3;
  o = vec4(col, 1.0);
}
`;

const CORE_FRAGMENT = /* glsl */ `
uniform vec3 uC;        // core x, y (layer px), unused
uniform vec3 uHot;
uniform vec3 uIce;
uniform vec2 uAxis;
uniform float uForceK;

void main() {
  vec2 sp = warpByForces(screenPx(), -uForceK);
  vec2 lp = sp + uView * uParallax;
  vec2 d = lp - uC.xy;
  float r = length(d);
  vec2 nrm = vec2(-uAxis.y, uAxis.x);
  float along = dot(d, uAxis);
  float across = dot(d, nrm);
  // a blinding point, its atmosphere and glare spikes along and across the jet
  float glow = exp(-r / 24.0) * 2.0;
  float spikeA = exp(-abs(across) / 3.5) * exp(-abs(along) / 190.0) * 0.9;
  float spikeB = exp(-abs(along) / 3.5) * exp(-abs(across) / 110.0) * 0.5;
  vec3 col = uHot * (glow + spikeA + spikeB) + uIce * (exp(-r / 60.0) * 0.35 + exp(-r / 130.0) * 0.1);
  col *= 1.0 + 0.6 * uIntensity;
  o = vec4(col, 1.0);
}
`;

const WEB_FRAGMENT = /* glsl */ `
uniform vec3 uCol0;
uniform vec3 uCol1;
uniform float uForceK;
uniform vec2 uSeed;

void main() {
  vec2 sp = warpByForces(screenPx(), -uForceK);
  vec2 lp = sp + uView * uParallax;
  float t = uFlow * 0.004;
  vec2 q = lp / 260.0 + uSeed;
  vec2 w = q + (vec2(fbm(q * 0.8 + t, 3), fbm(q * 0.8 + 5.2 - t, 3)) - 0.5) * 1.8;
  float ridge = 1.0 - abs(2.0 * fbm(w, 4) - 1.0);
  float web = pow(ridge, 14.0);
  float clump = smoothstep(0.35, 0.75, fbm(w * 2.3 + 11.0, 3));
  o = vec4(mix(uCol0, uCol1, clump) * web * (0.35 + 0.9 * clump), 1.0);
}
`;

export class QuasarScenery extends SceneryBase {
  readonly id = 'quasar' as const;
  readonly look: SceneryLook = { ...LOOK };
  protected readonly noiseSeed = 0x515541;
  private info: StageInfo = STAGE_INFO.quasar;
  private ambient: AmbientLife | null = null;
  private lensed: KitLayer | null = null;
  private core: [number, number] = atRef(CORE_X, CORE_Y, CORE_PARALLAX);
  private view = { x0: REF_X0, y0: REF_Y0 };

  protected *build(kit: SceneryKit, _ctx: SceneryInit): Generator<PrepareStep, void, void> {
    const arena = this.info.arena;
    const R = paletteRamps(this.info);
    // ramp order of STAGE_INFO.quasar: void, ice-blue, violet, cyan-white, indigo dust, ember, magenta, electric indigo
    const [VOID, ICE, VIOLET, CYAN, DUST, EMBER, MAGENTA, INDIGO] = [
      R[0]!,
      R[1]!,
      R[2]!,
      R[3]!,
      R[4]!,
      R[5]!,
      R[6]!,
      R[7]!,
    ];
    const rng = new Rng(0x9c3);
    const [cx, cy] = this.core;

    /* ---- 1. the black: a whisper of blue, brightest toward the core ---- */
    addNebula(kit, 'sky', {
      parallax: 0.02,
      scale: 340,
      warp: 1.0,
      octaves: 3,
      thresh: [0.25, 0.95],
      colA: scale(VOID[2]!, 0.5),
      colB: scale(VOID[4]!, 0.7),
      colC: [0, 0, 0],
      colD: [0, 0, 0],
      gain: 1,
      lightDir: [0.6, -0.5],
      litK: 0,
      flowSpeed: 0.008,
      seed: [6.6, 2.1],
      mode: 'emit',
      forceK: 0.3,
    });
    yield 0.03;

    /* ---- 2. the cosmic web: the faintest filaments of matter ---- */
    kit.addFullscreen('web', WEB_FRAGMENT, 'add', 0.04, {
      uCol0: { value: [...scale(INDIGO[2]!, 0.45)] },
      uCol1: { value: [...scale(VIOLET[3]!, 0.5)] },
      uForceK: { value: 0.25 },
      uSeed: { value: [3.3, 8.8] },
    });
    yield 0.07;

    /* ---- 3. sparse cold stars ---- */
    const bd = layerBounds(arena, 0.03);
    kit.addSprites('stars-far', {
      buffer: makeStarField({
        count: 900,
        bounds: bd,
        size: [0.55, 0.95],
        base: 0.26,
        boost: 1.5,
        tint: [0.85, 0.93, 1.0],
        tintWeights: [6, 5, 3, 1, 0.5, 0.2],
        seed: 311,
      }),
      parallax: 0.03,
      blend: 'add',
      soft: 4,
      snap: true,
      twinkle: 0.2,
      forceK: 0.05,
    });
    yield 0.1;

    /* ---- 4. lensed galaxies: thin bright arcs of light bent around unseen mass ---- */
    const arcs: GalaxyDisc[] = [];
    const lb = layerBounds(arena, 0.04);
    for (let i = 0; i < 14; i++) {
      const spiral = rng.chance(0.5);
      arcs.push({
        x: rng.range(lb.x0, lb.x1),
        y: rng.range(lb.y0, lb.y1),
        radius: rng.range(8, 24),
        inclination: rng.range(1.0, 1.45),
        positionAngle: rng.range(0, Math.PI),
        arms: spiral ? 2 : 0,
        pitch: rng.range(0.3, 0.5),
        core: rampAt(CYAN, 0.6),
        mid: rampAt(ICE, 0.7),
        arm: rampAt(INDIGO, 0.7),
        knot: rampAt(CYAN, 0.9),
        brightness: rng.range(0.08, 0.22),
        dust: 0.3,
        knots: 0.4,
        spin: rng.range(0.5, 1.2),
        seed: rng.next() * 10,
      });
    }
    this.lensed = addGalaxyDiscs(kit, 'lensed', 0.04, arcs, 0.05);
    yield 0.14;

    /* ---- 5. ambient life ---- */
    const ambParallax = 0.05;
    this.ambient = new AmbientLife(kit, {
      seed: 0x7e21,
      parallax: ambParallax,
      cometColor: [0.7, 0.9, 1.0],
      flareColor: [0.75, 0.8, 1.0],
      comets: 1,
      cometPeriod: [24, 38],
      cometLife: 6.5,
      flares: 3,
      flarePeriod: [7, 14],
      region: {
        x0: -20 + REF_X0 * ambParallax,
        y0: 30 + REF_Y0 * ambParallax,
        x1: 560 + REF_X0 * ambParallax,
        y1: 260 + REF_Y0 * ambParallax,
      },
    });
    yield 0.16;

    /* ---- 6. the core, just beyond the corner ---- */
    kit.addFullscreen('core', CORE_FRAGMENT, 'add', CORE_PARALLAX, {
      uC: { value: [cx, cy, 0] },
      uHot: { value: [...scale(rampAt(CYAN, 0.75), 1.6)] },
      uIce: { value: [...scale(rampAt(ICE, 0.7), 1.0)] },
      uAxis: { value: [JET[0], JET[1]] },
      uForceK: { value: 0.15 },
    });
    yield 0.22;

    /* ---- 7. the jet, in two depths: a wide faint sheath far back and the razor beam in front ---- */
    const jetAt = atRef(CORE_X, CORE_Y, 0.1);
    kit.addFullscreen('jet-far', JET_FRAGMENT, 'add', 0.1, {
      uJ: { value: [jetAt[0], jetAt[1], JET[0], JET[1]] },
      uJ2: { value: [5, 0.014, 900, 26] },
      uCore: { value: [...scale(rampAt(ICE, 0.55), 0.7)] },
      uSheath: { value: [...scale(rampAt(INDIGO, 0.6), 0.8)] },
      uCocoon: { value: [...scale(rampAt(VIOLET, 0.55), 0.8)] },
      uForceK: { value: 0.35 },
      uGain: { value: 0.32 },
    });
    const beamAt = atRef(CORE_X, CORE_Y, 0.18);
    kit.addFullscreen('jet', JET_FRAGMENT, 'add', 0.18, {
      uJ: { value: [beamAt[0], beamAt[1], JET[0], JET[1]] },
      uJ2: { value: [1.9, 0.0045, 820, 14] },
      uCore: { value: [...scale(mixRgb(rampAt(CYAN, 0.7), rampAt(ICE, 0.8), 0.35), 1.7)] },
      uSheath: { value: [...scale(rampAt(ICE, 0.62), 1.0)] },
      uCocoon: { value: [...scale(rampAt(INDIGO, 0.55), 1.0)] },
      uForceK: { value: 0.55 },
      uGain: { value: 1.25 },
    });
    yield 0.4;

    /* ---- 8. plasma fleck streaming along the jet ---- */
    const jetAng = Math.atan2(JET[1], JET[0]);
    const plasma = (k: number): [Rgb, Rgb, Rgb] => [
      scale(rampAt(CYAN, 0.8), k),
      scale(rampAt(ICE, 0.7), k),
      scale(rampAt(INDIGO, 0.55), k * 0.6),
    ];
    addStreams(kit, 'plasma-far', {
      parallax: 0.18,
      origin: beamAt,
      count: 500,
      angle: [jetAng - 0.05, jetAng + 0.05],
      axisBias: 1.6,
      distance: [80, 900],
      speed: 90,
      size: [0.8, 1.6],
      stretch: 6,
      wobble: 3,
      colors: plasma(1.0),
      brightness: 1,
      alpha: 0.8,
      seed: 9,
      forceK: 0.55,
    });
    const nearAt = atRef(CORE_X, CORE_Y, 0.42);
    addStreams(kit, 'plasma-near', {
      parallax: 0.42,
      origin: nearAt,
      count: 90,
      angle: [jetAng - 0.09, jetAng + 0.09],
      axisBias: 1.4,
      distance: [100, 1000],
      speed: 130,
      size: [1.6, 3.0],
      stretch: 5,
      wobble: 6,
      colors: plasma(0.8),
      brightness: 1,
      alpha: 0.7,
      seed: 10,
      forceK: 0.8,
    });
    yield 0.55;

    /* ---- 9. dust the jet skims: a dark indigo bank along the bottom, its top edge kindled by the beam ---- */
    addDustBank(kit, 'bank', {
      parallax: 0.85,
      col: scale(DUST[0]!, 0.8),
      rim: scale(ICE[4]!, 0.7),
      lip: 0.09,
      top: 0.92,
      slope: -0.14,
      roughness: 0.26,
      soft: 0.18,
      scale: [200, 56],
      speed: 0.014,
      alpha: 0.96,
      forceK: 1.1,
      rimK: 1,
    });
    // a very few ember sparks: the last of the accretion disc thrown far out
    const sb = new SpriteBuilder();
    const sbounds = layerBounds(arena, 1.4);
    for (let i = 0; i < 26; i++) {
      const c = mixRgb(
        rampAt(EMBER, rng.range(0.55, 0.95)),
        rampAt(MAGENTA, rng.range(0.3, 0.8)),
        rng.next() * 0.4,
      );
      const k = rng.range(0.4, 0.9) * 2.4;
      sb.push(
        rng.range(sbounds.x0, sbounds.x1),
        rng.range(sbounds.y0, sbounds.y1),
        0,
        rng.next(),
        rng.range(2, 5),
        rng.range(2, 5),
        0,
        c[0] * k,
        c[1] * k,
        c[2] * k,
        0.14,
      );
    }
    kit.addSprites('sparks', {
      buffer: sb.build(),
      parallax: 1.4,
      blend: 'add',
      soft: 1.4,
      drift: 10,
      driftFreq: 1 / 140,
      driftSpeed: 0.08,
      twinkle: 0.25,
      forceK: 1.4,
    });
  }

  protected override onUpdate(frame: SceneryFrame): void {
    this.ambient?.update(frame.timeSec);
    if (this.lensed) setDiscSpin(this.lensed, frame.timeSec, 0.01);
    this.view.x0 = frame.view.x0;
    this.view.y0 = frame.view.y0;
  }

  lightScreenPos(out: { x: number; y: number }): void {
    screenOf(this.core[0], this.core[1], CORE_PARALLAX, this.view, out);
  }

  protected override disposeExtras(): void {
    this.ambient = null;
    this.lensed = null;
  }
}
