import {
  DEFAULT_ARENA,
  STAGE_IDS,
  hueShiftRamp,
  toHex,
  type ArenaInfo,
  type StageId,
  type StageInfo,
  type StageLighting,
} from '@/contracts';

/**
 * Static stage data: arena, lighting and the curated dither palette of every stage.
 *
 * This file is deliberately free of `three`/DOM so titan generators, the sim and tests can import it
 * before any scenery exists. Palettes are built from hue-shifted ramps (`hueShiftRamp`): shadows drift toward
 * a cooler/deeper hue, highlights toward a warmer/lighter one, so a dithered gradient between two neighbouring
 * steps always reads as light passing through a colour rather than as grey mud.
 *
 * Palette design rule: every stage gets (a) a near-black "void" ramp for the sky, (b) two or three dominant
 * ramps for the gas/light, (c) a dark "dust" ramp so occluders have body, (d) a hot ramp for stars and (e) a
 * small accent ramp for contrast. 40–64 colours total (validated by `validateStageInfo`).
 */

interface RampSpec {
  /** Base hue 0..1, base saturation 0..1 and step count. */
  h: number;
  s: number;
  n: number;
  lMin: number;
  lMax: number;
  /**
   * Hue the shadows / highlights drift toward. Interpolated NUMERICALLY (then wrapped), so write -0.01 or 1.03 —
   * not 0.99 or 0.03 — when a ramp drifts across the red seam, or it would sweep through green and cyan.
   */
  shadow: number;
  light: number;
}

const ramp = (
  h: number,
  s: number,
  n: number,
  lMin: number,
  lMax: number,
  shadow: number,
  light: number,
): RampSpec => ({ h, s, n, lMin, lMax, shadow, light });

function buildPalette(specs: readonly RampSpec[]): string[] {
  const out: string[] = [];
  for (const r of specs) {
    for (const c of hueShiftRamp(r.h, r.s, r.n, {
      lMin: r.lMin,
      lMax: r.lMax,
      shadowHue: r.shadow,
      lightHue: r.light,
    })) {
      out.push(toHex(c));
    }
  }
  return out;
}

const unit = (x: number, y: number, z: number): [number, number, number] => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};

const arena = (): ArenaInfo => ({ ...DEFAULT_ARENA });

/* ---------------------------------------------------------------------------------------------- *
 *  1. STELLAR NURSERY — magenta / amber gas, plum dust pillars, teal ionisation, blue-white newborns
 * ---------------------------------------------------------------------------------------------- */
const nurseryLighting: StageLighting = {
  dir: unit(-0.55, -0.55, 0.63),
  color: '#ffb36b',
  ambient: '#3b1d4a',
  rim: '#ff5fb0',
  screenPos: [0.12, -0.08],
};
const nurseryRamps: readonly RampSpec[] = [
  ramp(0.7, 0.55, 7, 0.02, 0.25, 0.74, 0.79), // void: indigo → violet-black sky
  ramp(0.93, 0.36, 6, 0.045, 0.32, 0.85, 0.98), // plum dust
  ramp(0.9, 0.78, 9, 0.11, 0.78, 0.8, 0.965), // magenta emission
  ramp(0.085, 0.92, 9, 0.15, 0.86, -0.01, 0.135), // amber / orange
  ramp(0.135, 0.72, 4, 0.76, 0.97, 0.12, 0.17), // hot pale gold
  ramp(0.585, 0.85, 6, 0.3, 0.96, 0.65, 0.5), // newborn blue-white stars
  ramp(0.47, 0.62, 5, 0.1, 0.52, 0.57, 0.45), // teal ionisation
];

/* ---------------------------------------------------------------------------------------------- *
 *  2. GALACTIC RIM — teal & gold spiral arms, warm galactic core, cold outer dark
 * ---------------------------------------------------------------------------------------------- */
const rimLighting: StageLighting = {
  dir: unit(0.6, -0.35, 0.72),
  color: '#ffe2a8',
  ambient: '#0f2a3a',
  rim: '#5fd6c4',
  screenPos: [0.9, 0.3],
};
const rimRamps: readonly RampSpec[] = [
  ramp(0.57, 0.6, 7, 0.018, 0.26, 0.62, 0.6), // void: deep blue-black
  ramp(0.49, 0.62, 8, 0.09, 0.66, 0.56, 0.44), // teal arms
  ramp(0.115, 0.85, 8, 0.14, 0.84, 0.03, 0.15), // gold dust lanes
  ramp(0.14, 0.55, 5, 0.72, 0.97, 0.1, 0.18), // warm white core
  ramp(0.96, 0.4, 5, 0.06, 0.34, 0.88, 1.02), // rose-brown dust
  ramp(0.61, 0.8, 6, 0.32, 0.95, 0.66, 0.52), // ice stars
  ramp(0.78, 0.45, 4, 0.12, 0.4, 0.72, 0.85), // violet haze
];

/* ---------------------------------------------------------------------------------------------- *
 *  3. RED GIANT'S WAKE — ember red/orange shells, violet dark, teal planetary-nebula halo
 * ---------------------------------------------------------------------------------------------- */
const redgiantLighting: StageLighting = {
  dir: unit(0.12, -0.85, 0.52),
  color: '#ff7a3c',
  ambient: '#2a0f18',
  rim: '#ffb35f',
  screenPos: [0.55, -0.12],
};
const redgiantRamps: readonly RampSpec[] = [
  ramp(0.79, 0.5, 7, 0.018, 0.24, 0.83, 0.86), // void: violet-black
  ramp(0.99, 0.85, 9, 0.11, 0.66, 0.92, 1.03), // ember red
  ramp(0.055, 0.92, 8, 0.2, 0.82, -0.01, 0.11), // orange
  ramp(0.12, 0.7, 4, 0.74, 0.97, 0.08, 0.16), // white-hot
  ramp(0.03, 0.4, 5, 0.045, 0.3, -0.06, 0.07), // charred umber dust
  ramp(0.76, 0.5, 6, 0.12, 0.5, 0.7, 0.88), // violet shells
  ramp(0.49, 0.6, 5, 0.12, 0.6, 0.58, 0.42), // teal halo
];

/* ---------------------------------------------------------------------------------------------- *
 *  4. QUASAR VOID — near-black sky, ice-blue/violet relativistic jets, a sliver of ember
 * ---------------------------------------------------------------------------------------------- */
const quasarLighting: StageLighting = {
  dir: unit(0.5, -0.6, 0.62),
  color: '#bfd8ff',
  ambient: '#050814',
  rim: '#7aa8ff',
  screenPos: [0.92, -0.15],
};
const quasarRamps: readonly RampSpec[] = [
  ramp(0.64, 0.6, 8, 0.008, 0.2, 0.68, 0.66), // void: blue-black
  ramp(0.59, 0.75, 8, 0.1, 0.68, 0.65, 0.53), // ice-blue jets
  ramp(0.77, 0.7, 7, 0.08, 0.6, 0.7, 0.85), // violet plasma
  ramp(0.5, 0.5, 5, 0.74, 0.98, 0.56, 0.44), // cyan-white cores
  ramp(0.7, 0.35, 5, 0.03, 0.26, 0.72, 0.76), // indigo dust
  ramp(0.09, 0.85, 5, 0.18, 0.7, 0.02, 0.12), // ember accretion
  ramp(0.9, 0.6, 4, 0.14, 0.5, 0.82, 0.96), // magenta fringe
];

/* ---------------------------------------------------------------------------------------------- *
 *  5. TUSSENRUIMTE — celadon & black; stillness between two galaxies
 * ---------------------------------------------------------------------------------------------- */
const tussenLighting: StageLighting = {
  dir: unit(-0.45, 0.12, 0.88),
  color: '#a8bdb2',
  ambient: '#070b0a',
  rim: '#d8efe4',
  screenPos: [-0.1, 0.6],
};
const tussenRamps: readonly RampSpec[] = [
  ramp(0.42, 0.3, 8, 0.008, 0.16, 0.5, 0.4), // void: green-black
  ramp(0.4, 0.28, 10, 0.07, 0.86, 0.47, 0.35), // celadon
  ramp(0.5, 0.22, 6, 0.08, 0.5, 0.56, 0.44), // cool grey-teal
  ramp(0.125, 0.4, 5, 0.6, 0.96, 0.16, 0.14), // pale warm stars
  ramp(0.72, 0.22, 5, 0.06, 0.4, 0.66, 0.78), // faint lavender dust
  ramp(0.33, 0.25, 4, 0.04, 0.3, 0.4, 0.28), // moss shadow
  ramp(0.98, 0.3, 3, 0.2, 0.58, 0.92, 1.04), // one warm rose accent
];

const paletteOf = (specs: readonly RampSpec[]): string[] => buildPalette(specs);

/**
 * Number of colours in each ramp of every palette, in palette order. The renderer uses it to dither ONLY between
 * neighbouring steps of one ramp (the way a pixel artist does) instead of guessing ramp boundaries.
 */
export const STAGE_RAMPS: Readonly<Record<StageId, readonly number[]>> = {
  nursery: nurseryRamps.map((r) => r.n),
  rim: rimRamps.map((r) => r.n),
  redgiant: redgiantRamps.map((r) => r.n),
  quasar: quasarRamps.map((r) => r.n),
  tussenruimte: tussenRamps.map((r) => r.n),
};

const mk = (
  id: StageId,
  name: string,
  nameKo: string,
  blurb: string,
  lighting: StageLighting,
  palette: string[],
): StageInfo => ({
  id,
  index: STAGE_IDS.indexOf(id),
  name,
  nameKo,
  blurb,
  arena: arena(),
  lighting,
  palette,
});

/** All five stages, complete and final. Other modules read `lighting` and `arena` from here. */
export const STAGE_INFO: Readonly<Record<StageId, StageInfo>> = {
  nursery: mk(
    'nursery',
    'Stellar Nursery',
    '별의 요람',
    'Dust pillars rise into the glare of newborn suns.',
    nurseryLighting,
    paletteOf(nurseryRamps),
  ),
  rim: mk(
    'rim',
    'Galactic Rim',
    '은하의 끝',
    'At the edge of a turning galaxy, the light of a billion stars.',
    rimLighting,
    paletteOf(rimRamps),
  ),
  redgiant: mk(
    'redgiant',
    "Red Giant's Wake",
    '붉은 거성의 잔영',
    'A dying sun exhales its shells into the dark.',
    redgiantLighting,
    paletteOf(redgiantRamps),
  ),
  quasar: mk(
    'quasar',
    'Quasar Void',
    '퀘이사 공허',
    'Relativistic jets scar the black.',
    quasarLighting,
    paletteOf(quasarRamps),
  ),
  tussenruimte: mk(
    'tussenruimte',
    'Tussenruimte',
    '틈',
    'Between two galaxies there is only stillness.',
    tussenLighting,
    paletteOf(tussenRamps),
  ),
};
