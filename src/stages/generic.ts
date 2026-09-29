import { Rng, type StageId, type StageInfo } from '@/contracts';
import { STAGE_INFO } from './info';
import type { SceneryFrame, SceneryInit, SceneryLook, StageScenery } from './types';
import { makeCloud } from './toolkit/clouds';
import { SceneryKit } from './toolkit/kit';
import { addNebula, type Rgb } from './toolkit/nebula';
import { Noise2 } from './toolkit/noise';
import { layerBounds, makeStarField } from './toolkit/stars';
import type { WebGLRenderTarget } from 'three';

/**
 * Data-driven fallback scenery for stages whose bespoke backdrops are still to come: deep parallax star fields, a
 * warped fbm nebula, particle puffs and dust lanes, all tinted per stage. Fully reactive to the fight. It is a
 * stand-in, not a showpiece — see `NurseryScenery` for the bar.
 */

interface GenericStyle {
  sky: Rgb;
  gasA: Rgb;
  gasB: Rgb;
  gasHot: Rgb;
  rim: Rgb;
  dust: Rgb;
  starTint: Rgb;
  /** Screen-space direction toward the stage light (unit-ish). */
  light: readonly [number, number];
  exposure: number;
}

const STYLES: Record<StageId, GenericStyle> = {
  nursery: {
    sky: [0.012, 0.008, 0.03],
    gasA: [0.16, 0.03, 0.14],
    gasB: [0.5, 0.1, 0.32],
    gasHot: [0.9, 0.5, 0.12],
    rim: [1.0, 0.55, 0.22],
    dust: [0.05, 0.02, 0.06],
    starTint: [1, 1, 1],
    light: [-0.7, -0.7],
    exposure: 1.1,
  },
  rim: {
    sky: [0.004, 0.012, 0.024],
    gasA: [0.02, 0.1, 0.13],
    gasB: [0.05, 0.36, 0.4],
    gasHot: [1.0, 0.72, 0.28],
    rim: [1.0, 0.85, 0.5],
    dust: [0.04, 0.03, 0.04],
    starTint: [0.9, 1, 1],
    light: [0.8, -0.3],
    exposure: 1.15,
  },
  redgiant: {
    sky: [0.014, 0.004, 0.014],
    gasA: [0.16, 0.02, 0.05],
    gasB: [0.6, 0.12, 0.05],
    gasHot: [1.0, 0.55, 0.15],
    rim: [1.0, 0.7, 0.3],
    dust: [0.05, 0.015, 0.03],
    starTint: [1, 0.9, 0.8],
    light: [0.1, -0.9],
    exposure: 1.1,
  },
  quasar: {
    sky: [0.002, 0.003, 0.01],
    gasA: [0.02, 0.03, 0.14],
    gasB: [0.12, 0.2, 0.7],
    gasHot: [0.6, 0.85, 1.4],
    rim: [0.75, 0.9, 1.2],
    dust: [0.01, 0.012, 0.03],
    starTint: [0.85, 0.95, 1.1],
    light: [0.7, -0.7],
    exposure: 1.2,
  },
  tussenruimte: {
    sky: [0.002, 0.004, 0.004],
    gasA: [0.018, 0.04, 0.03],
    gasB: [0.09, 0.2, 0.15],
    gasHot: [0.5, 0.75, 0.62],
    rim: [0.7, 0.9, 0.8],
    dust: [0.01, 0.02, 0.018],
    starTint: [0.9, 1, 0.95],
    light: [-0.9, 0.25],
    exposure: 1.2,
  },
};

const LOOK: SceneryLook = {
  exposure: 1.2,
  contrast: 1.06,
  bloomThreshold: 0.75,
  bloomGain: 0.5,
  godRayGain: 0.55,
  godRayGas: 0.5,
  godRayHalo: 90,
  godRayDecay: 0.965,
  vignette: 0.5,
};

export class GenericScenery implements StageScenery {
  readonly look: SceneryLook;
  private kit: SceneryKit | null = null;
  private info: StageInfo;
  private renderer: SceneryInit['renderer'] | null = null;

  constructor(readonly id: StageId) {
    this.info = STAGE_INFO[id];
    this.look = { ...LOOK, exposure: STYLES[id].exposure };
  }

  init(ctx: SceneryInit): void {
    this.renderer = ctx.renderer;
    const kit = new SceneryKit(ctx, 0x600d + this.info.index);
    this.kit = kit;
    const st = STYLES[this.id];
    const arena = this.info.arena;
    const q = [0.4, 0.7, 1][ctx.quality]!;
    const noise = new Noise2(0x1234 + this.info.index * 77);
    const seed = this.info.index * 1000;

    // sky + large soft gas
    addNebula(kit, 'sky', {
      parallax: 0.03,
      scale: 260,
      warp: 1.6,
      octaves: 4,
      thresh: [0.25, 0.85],
      colA: st.sky,
      colB: st.gasA,
      colC: [0, 0, 0],
      colD: [0, 0, 0],
      gain: 1,
      lightDir: st.light,
      litK: 0,
      flowSpeed: 0.03,
      seed: [seed % 97, 13],
      mode: 'emit',
    });
    // stars, far
    let bd = layerBounds(arena, 0.04);
    kit.addSprites('stars-far', {
      buffer: makeStarField({ count: Math.round(900 * q), bounds: bd, size: [0.6, 1.0], base: 0.25, boost: 1.5, seed: seed + 1, tint: st.starTint }),
      parallax: 0.04,
      blend: 'add',
      soft: 4,
      snap: true,
      twinkle: 0.15,
      forceK: 0.1,
    });
    addNebula(kit, 'gas', {
      parallax: 0.09,
      scale: 170,
      warp: 2.4,
      octaves: 5,
      thresh: [0.42, 0.85],
      colA: st.gasA,
      colB: st.gasB,
      colC: st.gasHot,
      colD: st.rim,
      gain: 0.9,
      lightDir: st.light,
      litK: 5,
      flowSpeed: 0.05,
      seed: [3 + (seed % 31), 7],
      mode: 'emit',
    });
    bd = layerBounds(arena, 0.16);
    kit.addSprites('puffs', {
      buffer: makeCloud({
        count: Math.round(9000 * q),
        bounds: bd,
        noise,
        freq: 1 / 210,
        lo: 0.45,
        hi: 0.8,
        size: [10, 34],
        stretch: [1, 1.6],
        color: (_x, _y, d, u) => {
          const k = 0.3 + 0.7 * d;
          const hot = u > 0.86 ? 1 : 0;
          return [
            (st.gasB[0] * (1 - hot) + st.gasHot[0] * hot) * k,
            (st.gasB[1] * (1 - hot) + st.gasHot[1] * hot) * k,
            (st.gasB[2] * (1 - hot) + st.gasHot[2] * hot) * k,
            0.07,
          ];
        },
        seed: seed + 2,
      }),
      parallax: 0.16,
      spread: 0.05,
      blend: 'add',
      soft: 2.2,
      breakup: 0.6,
      drift: 5,
      driftFreq: 1 / 90,
      driftSpeed: 0.08,
      forceK: 0.5,
    });
    bd = layerBounds(arena, 0.22);
    kit.addSprites('stars-mid', {
      buffer: makeStarField({ count: Math.round(260 * q), bounds: bd, size: [0.9, 1.6], base: 0.5, boost: 2.5, seed: seed + 3, tint: st.starTint }),
      parallax: 0.22,
      blend: 'add',
      soft: 3,
      snap: true,
      twinkle: 0.25,
      forceK: 0.2,
    });
    addNebula(kit, 'dust', {
      parallax: 0.42,
      scale: 120,
      warp: 2.8,
      octaves: 5,
      thresh: [0.5, 0.78],
      colA: st.dust,
      colB: st.dust,
      colC: [0, 0, 0],
      colD: st.rim,
      gain: 1,
      lightDir: st.light,
      litK: 7,
      flowSpeed: 0.04,
      seed: [21 + (seed % 17), 4],
      mode: 'dust',
      alpha: 0.55,
      forceK: 0.8,
    });
    bd = layerBounds(arena, 1.5);
    const rng = new Rng(seed + 9);
    kit.addSprites('motes', {
      buffer: makeCloud({
        count: Math.round(70 * q),
        bounds: bd,
        noise,
        freq: 1 / 60,
        lo: 0.0,
        hi: 0.1,
        size: [3, 9],
        color: () => [st.rim[0] * 0.5, st.rim[1] * 0.5, st.rim[2] * 0.5, 0.06 + rng.next() * 0.06],
        seed: seed + 4,
      }),
      parallax: 1.5,
      blend: 'add',
      soft: 1.6,
      drift: 10,
      driftFreq: 1 / 140,
      driftSpeed: 0.1,
      forceK: 1.4,
    });
  }

  update(frame: SceneryFrame): void {
    this.kit?.update(frame);
  }

  render(target: WebGLRenderTarget): void {
    if (this.kit && this.renderer) this.kit.render(this.renderer, target);
  }

  lightScreenPos(out: { x: number; y: number }): void {
    const l = this.info.lighting.screenPos;
    out.x = l[0] * 640;
    out.y = l[1] * 360;
  }

  restore(): void {
    this.kit?.restore();
  }

  dispose(): void {
    this.kit?.dispose();
    this.kit = null;
  }
}
