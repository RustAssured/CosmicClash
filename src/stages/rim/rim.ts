import { Rng, type StageInfo } from '@/contracts';
import { STAGE_INFO } from '../info';
import { AmbientLife } from '../toolkit/ambient';
import { addDustBank } from '../toolkit/bank';
import { makeCloudSteps } from '../toolkit/clouds';
import { REF_X0, REF_Y0, addHeroStars, atRef, screenOf, type HeroStar } from '../toolkit/compose';
import { mixRgb, paletteRamps, rampAt, scale, type Rgb } from '../toolkit/color';
import { SceneryBase } from '../toolkit/base';
import {
  addGalaxyDiscs,
  addGalaxyStars,
  setDiscSpin,
  type GalaxyDisc,
} from '../toolkit/galaxy';
import { SpriteBuilder, type KitLayer, type SceneryKit } from '../toolkit/kit';
import { addNebula } from '../toolkit/nebula';
import { Noise2 } from '../toolkit/noise';
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
  godRayGain: 1.1,
  godRayGas: 0.1,
  godRayHalo: 260,
  godRayDecay: 0.976,
  vignette: 0.6,
};

/** Angular speed of the galaxy at unit ω, radians per scenery second. */
const SPIN = 0.011;
const GALAXY_PARALLAX = 0.06;

export class RimScenery extends SceneryBase {
  readonly id = 'rim' as const;
  readonly look: SceneryLook = { ...LOOK };
  protected readonly noiseSeed = 0x52494d;
  private info: StageInfo = STAGE_INFO.rim;
  private ambient: AmbientLife | null = null;
  private disc: KitLayer | null = null;
  private bgDiscs: KitLayer | null = null;
  private spinStars: ((t: number) => void) | null = null;
  private core: [number, number] = [0, 0];
  private view = { x0: REF_X0, y0: REF_Y0 };

  protected *build(kit: SceneryKit, _ctx: SceneryInit): Generator<PrepareStep, void, void> {
    const info = this.info;
    const arena = info.arena;
    const R = paletteRamps(info);
    const [VOID, TEAL, GOLD, CORE, ROSE, ICE, VIOLET] = [R[0]!, R[1]!, R[2]!, R[3]!, R[4]!, R[5]!, R[6]!];
    const noise = new Noise2(0x7a11);
    const rng = new Rng(0x91);

    /* ---- 1. sky: deep blue-black with a violet haze gathering behind the galaxy ---- */
    addNebula(kit, 'sky', {
      parallax: 0.02,
      scale: 300,
      warp: 1.2,
      octaves: 4,
      thresh: [0.2, 0.95],
      colA: scale(VOID[1]!, 0.55),
      colB: mixRgb(VOID[3]!, VIOLET[1]!, 0.4),
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
        count: 1500,
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
        radius: rng.range(5, 17),
        inclination: rng.range(0.2, 1.4),
        positionAngle: rng.range(0, Math.PI),
        arms: spiral ? 2 : 0,
        pitch: rng.range(0.28, 0.5),
        core: gold ? mixRgb(rampAt(CORE, 0.45), rampAt(GOLD, 0.7), 0.4) : rampAt(ICE, 0.6),
        arm: gold ? rampAt(GOLD, 0.55) : rampAt(TEAL, 0.72),
        knot: rampAt(ICE, 0.8),
        brightness: rng.range(0.05, 0.16),
        dust: 0.5,
        knots: 0.4,
        spin: rng.range(0.6, 1.4),
        seed: rng.next() * 10,
      });
    }
    this.bgDiscs = addGalaxyDiscs(kit, 'far-galaxies', 0.035, far, 0.05);
    yield 0.13;

    /* ---- 5. the great galaxy ---- */
    const [gx, gy] = atRef(486, 40, GALAXY_PARALLAX);
    this.core = [gx, gy];
    const GAL_R = 500;
    const INC = 1.0;
    const PA = -0.4;
    const coreCol: Rgb = mixRgb(rampAt(CORE, 0.5), rampAt(GOLD, 0.8), 0.25);
    const armCol: Rgb = mixRgb(rampAt(TEAL, 0.62), rampAt(ICE, 0.4), 0.25);
    const knotCol: Rgb = mixRgb(rampAt(GOLD, 0.85), rampAt(CORE, 0.6), 0.35);
    // a soft halo of unresolved light around the whole galaxy
    addNebula(kit, 'galaxy-halo', {
      parallax: GALAXY_PARALLAX,
      scale: 260,
      warp: 1.0,
      octaves: 3,
      thresh: [0.0, 1.0],
      colA: scale(TEAL[2]!, 0.35),
      colB: scale(GOLD[2]!, 0.45),
      colC: [0, 0, 0],
      colD: [0, 0, 0],
      gain: 0.55,
      lightDir: [0.7, -0.4],
      litK: 0,
      flowSpeed: 0.01,
      seed: [8.1, 1.4],
      mode: 'emit',
      mask: [gx, gy, 560, 340],
      maskMix: 1,
      forceK: 0.3,
    });
    const main: GalaxyDisc = {
      x: gx,
      y: gy,
      radius: GAL_R,
      inclination: INC,
      positionAngle: PA,
      arms: 2,
      pitch: 0.34,
      core: coreCol,
      arm: armCol,
      knot: knotCol,
      brightness: 0.7,
      dust: 0.9,
      knots: 0.8,
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
        pitch: 0.34,
        stars: 42000,
        dust: 1500,
        knots: 260,
        bulge: 5200,
        thickness: 0.035,
        core: mixRgb(rampAt(CORE, 0.6), rampAt(GOLD, 0.9), 0.3),
        inner: rampAt(GOLD, 0.85),
        arm: rampAt(ICE, 0.6),
        outer: rampAt(TEAL, 0.62),
        knot: rampAt(GOLD, 0.95),
        dustColor: scale(ROSE[1]!, 1.0),
        brightness: 0.85,
        spin: SPIN,
      },
      0.06,
    );
    this.spinStars = g.setSpin;
    yield 0.5;

    /* ---- 6. a band of dust across the disk, lit from the galactic core ---- */
    addNebula(kit, 'dust-band', {
      parallax: 0.3,
      scale: 150,
      warp: 2.6,
      octaves: 5,
      thresh: [0.52, 0.78],
      colA: scale(ROSE[0]!, 1.0),
      colB: scale(ROSE[1]!, 0.9),
      colC: [0, 0, 0],
      colD: scale(GOLD[4]!, 0.8),
      gain: 1,
      lightDir: [0.75, -0.5],
      litK: 6,
      flowSpeed: 0.02,
      seed: [21.4, 3.3],
      mode: 'dust',
      alpha: 0.55,
      forceK: 0.6,
    });
    yield 0.55;

    /* ---- 7. foreground gas lit by the nearby hot stars: teal and gold wisps ---- */
    bd = layerBounds(arena, 0.42);
    kit.addSprites('gas', {
      buffer: yield* makeCloudSteps({
        count: 2600,
        bounds: bd,
        noise,
        freq: 1 / 190,
        lo: 0.5,
        hi: 0.8,
        size: [8, 24],
        stretch: [1, 1.6],
        rotation: (x, y, r) => noise.noise(x / 240, y / 240) * 1.6 + (r.next() - 0.5) * 0.5,
        color: (x, y, d, u) => {
          const gold = 0.5 + 0.5 * Math.sin(x / 260 + y / 210);
          const c = mixRgb(rampAt(TEAL, 0.35 + 0.5 * d), rampAt(GOLD, 0.3 + 0.5 * d), gold * (u > 0.4 ? 0.9 : 0.25));
          const k = 0.3 + 0.7 * d;
          return [c[0] * k, c[1] * k, c[2] * k, 0.06 + 0.05 * d];
        },
        seed: 61,
      }),
      parallax: 0.42,
      spread: 0.05,
      blend: 'add',
      soft: 2.2,
      breakup: 0.65,
      drift: 5,
      driftFreq: 1 / 110,
      driftSpeed: 0.08,
      forceK: 0.75,
    });
    yield 0.75;

    /* ---- 8. hero stars ---- */
    const warm: Rgb = [1.0, 0.86, 0.6];
    const ice: Rgb = [0.78, 0.9, 1.0];
    const heroes: HeroStar[] = [
      { sx: 96, sy: 60, size: 120, core: 4.5, bright: 3.4, tint: ice, parallax: 0.16, rot: 0.2 },
      { sx: 380, sy: 24, size: 48, core: 2.4, bright: 1.8, tint: warm, parallax: 0.12, rot: 0.7 },
      { sx: 246, sy: 150, size: 56, core: 2.6, bright: 1.9, tint: ice, parallax: 0.22, rot: 0.4 },
      { sx: 596, sy: 200, size: 42, core: 2.0, bright: 1.4, tint: warm, parallax: 0.26, rot: 0.1 },
    ];
    addHeroStars(kit, 'hero', heroes);
    yield 0.82;

    /* ---- 9. the rim itself: a torn bank of dust with a gold lip, foreground motes ---- */
    addDustBank(kit, 'rim-bank', {
      parallax: 0.9,
      col: scale(ROSE[0]!, 1.1),
      rim: scale(GOLD[4]!, 0.7),
      top: 0.74,
      slope: -0.22,
      roughness: 0.3,
      soft: 0.26,
      scale: [170, 50],
      speed: 0.018,
      alpha: 0.94,
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
