import { Rng, type StageInfo } from '@/contracts';
import { STAGE_INFO } from '../info';
import { AmbientLife } from '../toolkit/ambient';
import { addDustBank } from '../toolkit/bank';
import { REF_X0, REF_Y0, addHeroStars, atRef, screenOf, type HeroStar } from '../toolkit/compose';
import { mixRgb, paletteRamps, rampAt, scale, type Rgb } from '../toolkit/color';
import { SceneryBase } from '../toolkit/base';
import { addGalaxyDiscs, addGalaxyStars, setDiscSpin, type GalaxyDisc } from '../toolkit/galaxy';
import { SpriteBuilder, type KitLayer, type SceneryKit } from '../toolkit/kit';
import { addNebula } from '../toolkit/nebula';
import { layerBounds, makeStarField } from '../toolkit/stars';
import type { PrepareStep, SceneryFrame, SceneryInit, SceneryLook } from '../types';

/**
 * GALACTIC RIM — the fight happens at the outer edge of a vast spiral galaxy that turns, visibly and stately, behind the arena.
 * Back to front: deep blue-black sky with far galaxies · the great galaxy (analytic disc + 3D particle stars and dust lanes,
 * differentially rotating) · a dust band across the disk · foreground gas lit teal and gold · hero stars · a torn dust bank.
 */

const LOOK: SceneryLook = {
  exposure: 1.0,
  contrast: 1.1,
  bloomThreshold: 1.2,
  bloomGain: 0.4,
  godRayGain: 0.16,
  godRayGas: 0.1,
  godRayHalo: 200,
  godRayDecay: 0.976,
  vignette: 0.6,
};

/** Angular speed of the galaxy at unit ω, radians per scenery second. */
const SPIN = 0.011;
const GALAXY_PARALLAX = 0.06;
/** Design position of the galactic core at the reference camera (screen px). */
const CORE_X = 440;
const CORE_Y = 74;

export class RimScenery extends SceneryBase {
  readonly id = 'rim' as const;
  readonly look: SceneryLook = { ...LOOK };
  protected readonly noiseSeed = 0x52494d;
  private info: StageInfo = STAGE_INFO.rim;
  private ambient: AmbientLife | null = null;
  private disc: KitLayer | null = null;
  private bgDiscs: KitLayer | null = null;
  private spinStars: ((t: number) => void) | null = null;
  private core: [number, number] = atRef(CORE_X, CORE_Y, GALAXY_PARALLAX);
  private view = { x0: REF_X0, y0: REF_Y0 };

  protected *build(kit: SceneryKit, _ctx: SceneryInit): Generator<PrepareStep, void, void> {
    const info = this.info;
    const arena = info.arena;
    const R = paletteRamps(info);
    // ramp order of STAGE_INFO.rim: void, teal, gold, warm white, rose dust, ice, violet, jade
    const [VOID, TEAL, GOLD, CORE, ICE, VIOLET, JADE] = [R[0]!, R[1]!, R[2]!, R[3]!, R[5]!, R[6]!, R[7]!];
    const rng = new Rng(0x91);

    /* ---- 1. sky: deep blue-black with a violet haze gathering behind the galaxy ---- */
    addNebula(kit, 'sky', {
      parallax: 0.02,
      scale: 300,
      warp: 1.2,
      octaves: 4,
      thresh: [0.2, 0.95],
      colA: scale(VOID[2]!, 0.6),
      colB: mixRgb(VOID[4]!, VIOLET[1]!, 0.3),
      colC: [0, 0, 0],
      colD: [0, 0, 0],
      gain: 1,
      lightDir: [0.7, -0.4],
      litK: 0,
      flowSpeed: 0.012,
      seed: [2.3, 6.1],
      mode: 'emit',
      forceK: 0.3,
    });
    yield 0.04;

    /* ---- 2. far stars ---- */
    let bd = layerBounds(arena, 0.03);
    kit.addSprites('stars-far', {
      buffer: makeStarField({
        count: 3200,
        bounds: bd,
        size: [0.55, 0.95],
        base: 0.3,
        boost: 1.7,
        tint: [0.92, 1, 1],
        seed: 111,
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
      seed: 0x52a1,
      parallax: ambParallax,
      cometColor: [0.62, 0.95, 0.9],
      flareColor: [1.0, 0.82, 0.5],
      comets: 2,
      cometPeriod: [15, 26],
      cometLife: 6.5,
      flares: 2,
      flarePeriod: [9, 16],
      region: {
        x0: -20 + REF_X0 * ambParallax,
        y0: 10 + REF_Y0 * ambParallax,
        x1: 660 + REF_X0 * ambParallax,
        y1: 240 + REF_Y0 * ambParallax,
      },
    });
    yield 0.09;

    /* ---- 4. far galaxies: a scatter of tiny discs at assorted angles ---- */
    const far: GalaxyDisc[] = [];
    bd = layerBounds(arena, 0.035);
    for (let i = 0; i < 34; i++) {
      const spiral = rng.chance(0.62);
      const gold = rng.chance(0.5);
      far.push({
        x: rng.range(bd.x0, bd.x1),
        y: rng.range(bd.y0, bd.y1),
        radius: i < 6 ? rng.range(20, 34) : rng.range(5, 17),
        inclination: rng.range(0.2, 1.4),
        positionAngle: rng.range(0, Math.PI),
        arms: spiral ? 2 : 0,
        pitch: rng.range(0.28, 0.5),
        core: gold ? mixRgb(rampAt(CORE, 0.45), rampAt(GOLD, 0.7), 0.4) : rampAt(ICE, 0.6),
        mid: gold ? rampAt(JADE, 0.5) : rampAt(TEAL, 0.7),
        arm: gold ? rampAt(GOLD, 0.55) : rampAt(TEAL, 0.72),
        knot: rampAt(ICE, 0.8),
        brightness: i < 6 ? rng.range(0.14, 0.24) : rng.range(0.06, 0.18),
        dust: 0.5,
        knots: 0.4,
        spin: rng.range(0.6, 1.4),
        seed: rng.next() * 10,
      });
    }
    this.bgDiscs = addGalaxyDiscs(kit, 'far-galaxies', 0.035, far, 0.05);
    yield 0.13;

    /* ---- 5. the great galaxy ---- */
    const [gx, gy] = this.core;
    const GAL_R = 500;
    const INC = 1.12;
    const PA = -0.32;
    const coreCol: Rgb = scale(mixRgb(rampAt(GOLD, 0.66), rampAt(GOLD, 0.86), 0.5), 1.0);
    const midCol: Rgb = mixRgb(rampAt(JADE, 0.6), rampAt(GOLD, 0.8), 0.3);
    const armCol: Rgb = mixRgb(rampAt(TEAL, 0.62), rampAt(ICE, 0.4), 0.25);
    const knotCol: Rgb = rampAt(GOLD, 0.92);
    const main: GalaxyDisc = {
      x: gx,
      y: gy,
      radius: GAL_R,
      inclination: INC,
      positionAngle: PA,
      arms: 2,
      pitch: 0.42,
      core: coreCol,
      mid: midCol,
      arm: armCol,
      knot: knotCol,
      brightness: 0.62,
      dust: 0.9,
      knots: 1.5,
      spin: 1,
      seed: 3.7,
    };
    this.disc = addGalaxyDiscs(kit, 'galaxy-disc', GALAXY_PARALLAX, [main], 0.06);
    yield 0.22;
    const g = addGalaxyStars(
      kit,
      'galaxy',
      GALAXY_PARALLAX,
      {
        seed: 4242,
        centre: [gx, gy],
        radius: GAL_R,
        inclination: INC,
        positionAngle: PA,
        arms: 2,
        pitch: 0.42,
        stars: 30000,
        dust: 700,
        knots: 260,
        bulge: 5200,
        thickness: 0.035,
        core: mixRgb(rampAt(GOLD, 0.7), rampAt(GOLD, 0.9), 0.5),
        inner: mixRgb(rampAt(JADE, 0.7), rampAt(GOLD, 0.9), 0.5),
        arm: rampAt(ICE, 0.6),
        outer: rampAt(TEAL, 0.62),
        knot: rampAt(GOLD, 0.95),
        dustColor: scale(VOID[0]!, 0.7),
        dustAlpha: 1.5,
        armFraction: 0.88,
        scatter: 0.55,
        brightness: 0.7,
        spin: SPIN,
      },
      0.06,
    );
    this.spinStars = (t: number): void => g.setSpin(t);
    yield 0.5;

    /* ---- 6. dust in front of the disk: dark rose-brown lanes, their edges lit gold by the galactic core ---- */
    const dustAt = atRef(230, 210, 0.3);
    addNebula(kit, 'dust-lane', {
      parallax: 0.3,
      scale: 150,
      warp: 2.6,
      octaves: 5,
      thresh: [0.5, 0.78],
      colA: scale(VOID[1]!, 1.0),
      colB: scale(VOID[2]!, 1.0),
      colC: [0, 0, 0],
      colD: scale(JADE[2]!, 1.0),
      gain: 1,
      lightDir: [0.75, -0.5],
      litK: 7,
      flowSpeed: 0.02,
      seed: [21.4, 3.3],
      mode: 'dust',
      alpha: 0.85,
      mask: [dustAt[0], dustAt[1], 300, 170],
      maskMix: 1,
      forceK: 0.6,
    });

    yield 0.7;

    /* ---- 8. hero stars ---- */
    const warm: Rgb = [1.0, 0.82, 0.5];
    const ice: Rgb = [0.78, 0.9, 1.0];
    const heroes: HeroStar[] = [
      { sx: 92, sy: 52, size: 60, core: 3.0, bright: 2.0, tint: warm, parallax: 0.16, rot: 0.2 },
      { sx: 262, sy: 30, size: 44, core: 2.2, bright: 1.7, tint: ice, parallax: 0.12, rot: 0.7 },
      { sx: 214, sy: 168, size: 50, core: 2.4, bright: 1.8, tint: ice, parallax: 0.22, rot: 0.4 },
      { sx: 604, sy: 214, size: 40, core: 2.0, bright: 1.4, tint: warm, parallax: 0.26, rot: 0.1 },
    ];
    addHeroStars(kit, 'hero', heroes);
    yield 0.78;

    /* ---- 9. the rim itself: two torn banks of dust, gold along their upper lips ---- */
    addDustBank(kit, 'bank-far', {
      parallax: 0.55,
      col: scale(VOID[2]!, 1.0),
      rim: scale(TEAL[5]!, 0.75),
      lip: 0.1,
      top: 0.86,
      slope: -0.24,
      roughness: 0.3,
      soft: 0.2,
      scale: [230, 70],
      speed: 0.012,
      alpha: 0.96,
      forceK: 0.9,
      rimK: 1,
    });
    addDustBank(kit, 'bank-near', {
      parallax: 0.9,
      col: scale(VOID[1]!, 1.0),
      rim: scale(JADE[3]!, 0.9),
      lip: 0.09,
      top: 0.94,
      slope: 0.16,
      roughness: 0.26,
      soft: 0.2,
      scale: [170, 50],
      speed: 0.018,
      alpha: 0.97,
      forceK: 1.1,
      rimK: 1,
    });
    bd = layerBounds(arena, 1.5);
    const mote = new SpriteBuilder();
    for (let i = 0; i < 80; i++) {
      const c = mixRgb(rampAt(GOLD, rng.range(0.4, 0.9)), rampAt(TEAL, rng.range(0.5, 0.9)), rng.next());
      const k = rng.range(0.3, 0.8) * 2.4;
      mote.push(
        rng.range(bd.x0, bd.x1),
        rng.range(bd.y0, bd.y1),
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
      buffer: mote.build(),
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
    this.spinStars?.(frame.timeSec);
    if (this.disc) setDiscSpin(this.disc, frame.timeSec, SPIN);
    if (this.bgDiscs) setDiscSpin(this.bgDiscs, frame.timeSec, SPIN * 0.5);
    this.view.x0 = frame.view.x0;
    this.view.y0 = frame.view.y0;
  }

  lightScreenPos(out: { x: number; y: number }): void {
    screenOf(this.core[0], this.core[1], GALAXY_PARALLAX, this.view, out);
  }

  protected override disposeExtras(): void {
    this.ambient = null;
    this.disc = null;
    this.bgDiscs = null;
    this.spinStars = null;
  }
}
