import { Rng, type StageInfo } from '@/contracts';
import { STAGE_INFO } from '../info';
import { AmbientLife } from '../toolkit/ambient';
import { addDustBank } from '../toolkit/bank';
import { REF_X0, REF_Y0, atRef, screenOf } from '../toolkit/compose';
import { mixRgb, paletteRamps, rampAt, scale } from '../toolkit/color';
import { SceneryBase } from '../toolkit/base';
import { addGalaxyDiscs, addGalaxyStars, setDiscSpin, type GalaxyDisc } from '../toolkit/galaxy';
import { SpriteBuilder, type KitLayer, type SceneryKit } from '../toolkit/kit';
import { addNebula } from '../toolkit/nebula';
import { layerBounds, makeStarField } from '../toolkit/stars';
import type { PrepareStep, SceneryFrame, SceneryInit, SceneryLook } from '../types';

/**
 * TUSSENRUIMTE — the space between. Two galaxies stand far off at either edge of the frame, dim as breath on glass, turning so slowly
 * that only a long look shows it. Between them a thin bridge of stars and gas, torn from both in some ancient passage, arcs
 * across the dark; a single tight cluster hangs in it like a lantern. Everything is celadon and black, and almost nothing moves —
 * so when the fight does move it (shock rings bending the sparse stars, swirls in the haze), you can see it.
 */

const LOOK: SceneryLook = {
  exposure: 1.0,
  contrast: 1.12,
  bloomThreshold: 1.0,
  bloomGain: 0.45,
  godRayGain: 0.12,
  godRayGas: 0.04,
  godRayHalo: 280,
  godRayDecay: 0.98,
  vignette: 0.7,
  // celadon sprites on celadon-black: the dark halo carries most of the readability, so it is a touch stronger and the backlight lift modest
  spriteHalo: { strength: 0.3, radius: 10, desat: 0.4, rim: 0.5, rimReach: 1, lift: 0.16 },
};

const SPIN = 0.004;
const G_PARALLAX = 0.05;
/** Centre of the left galaxy (the stage light) at the reference camera. */
const LEFT_X = 6;
const LEFT_Y = 214;
/** Ends of the bridge at the reference camera, and how far its middle rises. */
const BRIDGE = { x0: -30, y0: 196, x1: 676, y1: 108, sag: 78 } as const;
const BRIDGE_PARALLAX = 0.11;

const BRIDGE_FRAGMENT = /* glsl */ `
uniform vec4 uB;        // start x, y, end x, y (layer px)
uniform vec2 uSag;      // rise of the middle (px), half width (px)
uniform vec3 uCa;       // thin gas
uniform vec3 uCb;       // dense gas
uniform vec3 uCc;       // warm knots
uniform float uForceK;

float bridge(vec2 lp, float t, out float along) {
  float s = clamp((lp.x - uB.x) / (uB.z - uB.x), 0.0, 1.0);
  along = s;
  float bow = 4.0 * s * (1.0 - s);
  float baseY = mix(uB.y, uB.w, s) - uSag.x * bow;
  float slope = (uB.w - uB.y) / (uB.z - uB.x) - uSag.x * 4.0 * (1.0 - 2.0 * s) / (uB.z - uB.x);
  float dv = (lp.y - baseY) / sqrt(1.0 + slope * slope);
  vec2 q = lp / 90.0;
  float warp = (fbm(q * 0.6 + vec2(t * 0.02, 2.0), 3) - 0.5) * uSag.y * 1.4;
  float w = uSag.y * (0.35 + 0.9 * bow);
  float band = exp(-pow((dv + warp) / w, 2.0));
  float n = fbm(vec2(lp.x / 70.0 - t * 0.03, lp.y / 40.0), 5);
  return band * smoothstep(0.3, 0.9, n) * smoothstep(0.0, 0.18, s) * smoothstep(1.0, 0.82, s);
}

void main() {
  vec2 sp = warpByForces(screenPx(), -uForceK);
  vec2 lp = sp + uView * uParallax;
  float t = uFlow;
  float along;
  float d = bridge(lp, t, along);
  float al2;
  float dl = bridge(lp + vec2(-8.0, 10.0), t, al2);
  float lit = clamp((d - dl) * 6.0, 0.0, 1.0);
  vec3 col = mix(uCa, uCb, smoothstep(0.1, 0.9, d)) * d + uCc * lit * d;
  col += impulseGlow(sp) * d * 0.3;
  o = vec4(col * (1.0 + 0.5 * uIntensity), 1.0);
}
`;

export class TussenruimteScenery extends SceneryBase {
  readonly id = 'tussenruimte' as const;
  readonly look: SceneryLook = { ...LOOK };
  protected readonly noiseSeed = 0x545553;
  private info: StageInfo = STAGE_INFO.tussenruimte;
  private ambient: AmbientLife | null = null;
  private discs: KitLayer | null = null;
  private farDiscs: KitLayer | null = null;
  private spinLeft: ((t: number) => void) | null = null;
  private spinRight: ((t: number) => void) | null = null;
  private light: [number, number] = atRef(LEFT_X, LEFT_Y, G_PARALLAX);
  private view = { x0: REF_X0, y0: REF_Y0 };

  protected *build(kit: SceneryKit, _ctx: SceneryInit): Generator<PrepareStep, void, void> {
    const arena = this.info.arena;
    const R = paletteRamps(this.info);
    // ramp order of STAGE_INFO.tussenruimte: void, celadon, grey-teal, pale warm, lavender, moss, rose, sage
    const [VOID, CELADON, TEAL, WARM, LAV, MOSS, ROSE, SAGE] = [
      R[0]!,
      R[1]!,
      R[2]!,
      R[3]!,
      R[4]!,
      R[5]!,
      R[6]!,
      R[7]!,
    ];
    const rng = new Rng(0x7e5);

    /* ---- 1. the dark: green-black, with the barest lift toward the left galaxy ---- */
    addNebula(kit, 'sky', {
      parallax: 0.02,
      scale: 380,
      warp: 1.0,
      octaves: 3,
      thresh: [0.25, 0.95],
      colA: scale(VOID[2]!, 0.55),
      colB: scale(VOID[4]!, 0.7),
      colC: [0, 0, 0],
      colD: [0, 0, 0],
      gain: 1,
      lightDir: [-0.7, 0.2],
      litK: 0,
      flowSpeed: 0.004,
      seed: [1.7, 4.2],
      mode: 'emit',
      forceK: 0.25,
    });
    yield 0.03;

    /* ---- 2. a sparse field of pale, warm, ancient stars: the forceK is high so a shockwave visibly bends this stillness ---- */
    const bd = layerBounds(arena, 0.04);
    kit.addSprites('stars-far', {
      buffer: makeStarField({
        count: 520,
        bounds: bd,
        size: [0.55, 1.0],
        base: 0.3,
        boost: 1.4,
        tint: [0.95, 1.0, 0.96],
        tintWeights: [2, 3, 5, 4, 2, 0.5],
        seed: 411,
      }),
      parallax: 0.04,
      blend: 'add',
      soft: 4,
      snap: true,
      twinkle: 0.1,
      forceK: 0.6,
    });
    const bd2 = layerBounds(arena, 0.14);
    kit.addSprites('stars-mid', {
      buffer: makeStarField({
        count: 130,
        bounds: bd2,
        size: [0.9, 1.5],
        base: 0.5,
        boost: 2.0,
        tint: [1.0, 0.98, 0.9],
        tintWeights: [1, 2, 5, 5, 2, 0.5],
        seed: 412,
      }),
      parallax: 0.14,
      blend: 'add',
      soft: 3,
      snap: true,
      twinkle: 0.15,
      forceK: 0.9,
    });
    yield 0.08;

    /* ---- 3. ambient life, sparingly ---- */
    const ambParallax = 0.05;
    this.ambient = new AmbientLife(kit, {
      seed: 0x1de5,
      parallax: ambParallax,
      cometColor: [0.75, 0.95, 0.85],
      flareColor: [0.95, 0.95, 0.8],
      comets: 1,
      cometPeriod: [34, 52],
      cometLife: 8,
      flares: 1,
      flarePeriod: [16, 24],
      region: {
        x0: 40 + REF_X0 * ambParallax,
        y0: 20 + REF_Y0 * ambParallax,
        x1: 600 + REF_X0 * ambParallax,
        y1: 220 + REF_Y0 * ambParallax,
      },
    });
    yield 0.1;

    /* ---- 4. far galaxies: specks ---- */
    const far: GalaxyDisc[] = [];
    const fb = layerBounds(arena, 0.035);
    for (let i = 0; i < 16; i++) {
      far.push({
        x: rng.range(fb.x0, fb.x1),
        y: rng.range(fb.y0, fb.y1),
        radius: rng.range(4, 12),
        inclination: rng.range(0.3, 1.4),
        positionAngle: rng.range(0, Math.PI),
        arms: rng.chance(0.5) ? 2 : 0,
        pitch: rng.range(0.3, 0.5),
        core: rampAt(WARM, 0.5),
        mid: rampAt(SAGE, 0.5),
        arm: rampAt(CELADON, 0.55),
        knot: rampAt(WARM, 0.7),
        brightness: rng.range(0.05, 0.13),
        dust: 0.3,
        knots: 0.3,
        spin: rng.range(0.5, 1.2),
        seed: rng.next() * 10,
      });
    }
    this.farDiscs = addGalaxyDiscs(kit, 'far-galaxies', 0.035, far, 0.05);
    yield 0.14;

    /* ---- 5. the two galaxies, at the edges of the frame ---- */
    const [lx, ly] = this.light;
    const [rx, ry] = atRef(626, 122, G_PARALLAX);
    const left: GalaxyDisc = {
      x: lx,
      y: ly,
      radius: 300,
      inclination: 0.62,
      positionAngle: 0.5,
      arms: 2,
      pitch: 0.36,
      core: rampAt(WARM, 0.35),
      mid: rampAt(SAGE, 0.5),
      arm: rampAt(CELADON, 0.5),
      knot: rampAt(SAGE, 0.85),
      brightness: 0.95,
      dust: 0.8,
      knots: 1.0,
      spin: 1,
      seed: 2.1,
    };
    const right: GalaxyDisc = {
      x: rx,
      y: ry,
      radius: 250,
      inclination: 1.3,
      positionAngle: -0.28,
      arms: 2,
      pitch: 0.4,
      core: rampAt(WARM, 0.3),
      mid: rampAt(TEAL, 0.6),
      arm: rampAt(CELADON, 0.42),
      knot: rampAt(SAGE, 0.8),
      brightness: 0.6,
      dust: 0.95,
      knots: 0.8,
      spin: 0.8,
      seed: 5.6,
    };
    this.discs = addGalaxyDiscs(kit, 'galaxies', G_PARALLAX, [left, right], 0.05);
    yield 0.22;
    const starsOf = (
      name: string,
      d: GalaxyDisc,
      seed: number,
      stars: number,
      spin: number,
    ): ((t: number) => void) => {
      const g = addGalaxyStars(
        kit,
        name,
        G_PARALLAX,
        {
          seed,
          centre: [d.x, d.y],
          radius: d.radius,
          inclination: d.inclination,
          positionAngle: d.positionAngle,
          arms: d.arms,
          pitch: d.pitch,
          stars,
          dust: 260,
          knots: 60,
          bulge: 1400,
          thickness: 0.03,
          core: rampAt(WARM, 0.5),
          inner: mixRgb(rampAt(SAGE, 0.7), rampAt(WARM, 0.5), 0.4),
          arm: rampAt(CELADON, 0.6),
          outer: rampAt(CELADON, 0.42),
          knot: rampAt(SAGE, 0.95),
          dustColor: scale(VOID[0]!, 0.7),
          dustAlpha: 1.6,
          armFraction: 0.85,
          scatter: 0.6,
          brightness: 0.9,
          spin,
        },
        0.05,
      );
      return (t: number): void => g.setSpin(t);
    };
    this.spinLeft = starsOf('left', left, 71, 9000, SPIN);
    this.spinRight = starsOf('right', right, 72, 7000, SPIN * 0.8);
    yield 0.45;

    /* ---- 6. the bridge: gas ---- */
    const bA = atRef(BRIDGE.x0, BRIDGE.y0, BRIDGE_PARALLAX);
    const bB = atRef(BRIDGE.x1, BRIDGE.y1, BRIDGE_PARALLAX);
    kit.addFullscreen('bridge-gas', BRIDGE_FRAGMENT, 'add', BRIDGE_PARALLAX, {
      uB: { value: [bA[0], bA[1], bB[0], bB[1]] },
      uSag: { value: [BRIDGE.sag, 30] },
      uCa: { value: [...scale(CELADON[3]!, 0.4)] },
      uCb: { value: [...scale(CELADON[5]!, 0.5)] },
      uCc: { value: [...scale(SAGE[2]!, 0.5)] },
      uForceK: { value: 0.6 },
    });
    yield 0.55;

    /* ---- 7. the bridge: stars, torn from both galaxies, and the lantern cluster ---- */
    const sb = new SpriteBuilder();
    const bowAt = (s: number): [number, number, number] => {
      const bow = 4 * s * (1 - s);
      const x = BRIDGE.x0 + (BRIDGE.x1 - BRIDGE.x0) * s;
      const y = BRIDGE.y0 + (BRIDGE.y1 - BRIDGE.y0) * s - BRIDGE.sag * bow;
      return [x, y, bow];
    };
    for (let i = 0; i < 1100; i++) {
      const s = 0.06 + rng.next() * 0.88;
      const [x, y, bow] = bowAt(s);
      const spread = 8 + 26 * bow;
      const c = mixRgb(
        rampAt(CELADON, rng.range(0.5, 0.85)),
        rampAt(WARM, rng.range(0.3, 0.7)),
        rng.next() < 0.3 ? 0.55 : 0,
      );
      const k = 0.4 + 1.5 * Math.pow(rng.next(), 5);
      const [px, py] = atRef(
        x + rng.gauss() * spread * 0.9,
        y + rng.gauss() * spread * 0.55,
        BRIDGE_PARALLAX,
      );
      sb.push(px, py, 0, rng.next(), 0.75, 0.75, 0, c[0] * k * 1.7, c[1] * k * 1.7, c[2] * k * 1.7, 1);
    }
    kit.addSprites('bridge-stars', {
      buffer: sb.build(),
      parallax: BRIDGE_PARALLAX,
      blend: 'add',
      soft: 3.4,
      snap: true,
      twinkle: 0.14,
      forceK: 0.7,
    });
    // the lantern: a tight globular cluster hanging in the bridge, its members resolved
    const lc = bowAt(0.56);
    const cb = new SpriteBuilder();
    for (let i = 0; i < 700; i++) {
      const u = Math.max(1e-3, rng.next());
      const r = Math.min(46, 9 / Math.sqrt(Math.pow(u, -2 / 3) - 1 + 1e-6));
      const a = rng.range(0, Math.PI * 2);
      const c = mixRgb(
        rampAt(WARM, rng.range(0.25, 0.6)),
        rampAt(SAGE, rng.range(0.4, 0.8)),
        rng.next() * 0.5,
      );
      const k = (0.35 + 1.6 * Math.pow(rng.next(), 5)) * (1.2 - Math.min(1, r / 60));
      const [px, py] = atRef(lc[0] + Math.cos(a) * r, lc[1] - 16 + Math.sin(a) * r * 0.92, 0.09);
      cb.push(px, py, 0, rng.next(), 0.75, 0.75, 0, c[0] * k * 1.8, c[1] * k * 1.8, c[2] * k * 1.8, 1);
    }
    kit.addSprites('cluster', {
      buffer: cb.build(),
      parallax: 0.09,
      blend: 'add',
      soft: 3.2,
      snap: true,
      twinkle: 0.1,
      forceK: 0.6,
    });
    yield 0.75;

    /* ---- 8. a veil of cold dust low in the frame, barely there ---- */
    addDustBank(kit, 'veil', {
      parallax: 0.7,
      col: scale(MOSS[0]!, 0.7),
      rim: scale(CELADON[5]!, 0.9),
      lip: 0.14,
      top: 0.93,
      slope: 0.1,
      roughness: 0.26,
      soft: 0.2,
      scale: [220, 60],
      speed: 0.008,
      alpha: 0.9,
      forceK: 1.0,
      rimK: 1,
    });
    // the one warm accent: a scatter of faint rose-tinted motes far in the foreground
    const mb = new SpriteBuilder();
    const mbounds = layerBounds(arena, 1.3);
    for (let i = 0; i < 26; i++) {
      const c = mixRgb(rampAt(ROSE, rng.range(0.4, 0.9)), rampAt(LAV, rng.range(0.4, 0.9)), rng.next() * 0.5);
      const k = rng.range(0.4, 0.9) * 2.0;
      mb.push(
        rng.range(mbounds.x0, mbounds.x1),
        rng.range(mbounds.y0, mbounds.y1),
        0,
        rng.next(),
        rng.range(2, 5),
        rng.range(2, 5),
        0,
        c[0] * k,
        c[1] * k,
        c[2] * k,
        0.1,
      );
    }
    kit.addSprites('motes', {
      buffer: mb.build(),
      parallax: 1.3,
      blend: 'add',
      soft: 1.4,
      drift: 8,
      driftFreq: 1 / 150,
      driftSpeed: 0.05,
      twinkle: 0.15,
      forceK: 1.6,
    });
  }

  protected override onUpdate(frame: SceneryFrame): void {
    this.ambient?.update(frame.timeSec);
    this.spinLeft?.(frame.timeSec);
    this.spinRight?.(frame.timeSec);
    if (this.discs) setDiscSpin(this.discs, frame.timeSec, SPIN);
    if (this.farDiscs) setDiscSpin(this.farDiscs, frame.timeSec, SPIN * 0.5);
    this.view.x0 = frame.view.x0;
    this.view.y0 = frame.view.y0;
  }

  lightScreenPos(out: { x: number; y: number }): void {
    screenOf(this.light[0], this.light[1], G_PARALLAX, this.view, out);
  }

  protected override disposeExtras(): void {
    this.ambient = null;
    this.discs = null;
    this.farDiscs = null;
    this.spinLeft = null;
    this.spinRight = null;
  }
}
