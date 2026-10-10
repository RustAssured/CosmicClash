import type { PressCfg } from '../../dev/press/press';

/**
 * The press kit's shot list, picked from press/work/scan.json → candidates → LOOKED at in press/work/preview-*.png.
 * Each shot is one deterministic window [t0, t1) of a real AI-vs-AI fight (seed, level 4), rendered once with its own sound;
 * the trailer, the vertical cut and the loops are all cut from these. `stills`: ticks saved as lossless 1080p frames.
 */
export interface Shot {
  name: string;
  what: string;
  cfg: PressCfg;
  t0: number;
  t1: number;
  stills: number[];
}

const c = (a: PressCfg['a'], b: PressCfg['b'], stage: PressCfg['stage'], seed: number): PressCfg => ({
  a,
  b,
  stage,
  seed,
  ai: 4,
});
const around = (t: number, offs = [-30, -12, -4, 0, 4, 10, 20, 35]): number[] => offs.map((o) => t + o);

export const SHOTS: Shot[] = [
  {
    name: 'witness-gaze',
    what: "The Witness opens its eyes: every broken plate a beam (vs the Asteroid, Tussenruimte)",
    cfg: c('asteroid', 'lastone', 'tussenruimte', 22),
    t0: 2830,
    t1: 3230,
    stills: around(2973, [-45, -30, -15, 0, 20, 45]),
  },
  {
    name: 'uri-break-apart',
    what: "우리's loop snaps under the Witness's gaze and everything it held flies apart (Mausoleum)",
    cfg: c('uri', 'lastone', 'mausoleum', 23),
    t0: 3600,
    t1: 3960,
    stills: around(3781),
  },
  {
    name: 'supernova-nova-ko',
    what: 'The Supernova goes nova over the Nexus: a screen-filling ring, then the KO (Mausoleum)',
    cfg: c('supernova', 'nexus', 'mausoleum', 22),
    t0: 4620,
    t1: 4900,
    stills: [4705, 4725, 4745, 4752, 4760, 4770, 4791, 4810],
  },
  {
    name: 'supernova-flare',
    what: 'Supernova flares against the Black Hole in the Shearfield',
    cfg: c('supernova', 'blackhole', 'shearfield', 21),
    t0: 1060,
    t1: 1400,
    stills: around(1203, [-60, -40, -20, 0, 15, 40, 80]),
  },
  {
    name: 'blackhole-well',
    what: "The Black Hole's well swallows the Nursery's light around 우리",
    cfg: c('uri', 'blackhole', 'nursery', 23),
    t0: 7840,
    t1: 8150,
    stills: around(7974, [-60, -20, 0, 10, 20, 40]),
  },
  {
    name: 'planet-ko',
    what: "The Nexus breaks the Planet's crust down to its core: KO in the Shearfield",
    cfg: c('nexus', 'planet', 'shearfield', 23),
    t0: 8020,
    t1: 8290,
    stills: around(8151, [-60, -20, 0, 6, 15, 40]),
  },
  {
    name: 'planet-slab',
    what: "The Witness's beams slab the Planet's crust away (Nursery)",
    cfg: c('lastone', 'planet', 'nursery', 21),
    t0: 2320,
    t1: 2660,
    stills: around(2447, [-60, -40, -20, 0, 15, 40]),
  },
  {
    name: 'blackhole-ultimate',
    what: "The Black Hole's ultimate rings close on the Planet at the Rim",
    cfg: c('planet', 'blackhole', 'rim', 23),
    t0: 2880,
    t1: 3140,
    stills: around(2980, [-60, -30, 0, 20, 40, 60]),
  },
  {
    name: 'supernova-collapse',
    what: 'The Supernova collapses into one last nova around the Planet (Quasar)',
    cfg: c('planet', 'supernova', 'quasar', 21),
    t0: 5240,
    t1: 5560,
    stills: around(5344, [-60, -40, -20, 0, 20, 40]),
  },
  {
    name: 'nexus-ko',
    what: 'The Black Hole tears the Nexus apart: KO in the Tussenruimte',
    cfg: c('blackhole', 'nexus', 'tussenruimte', 22),
    t0: 8880,
    t1: 9160,
    stills: around(9032, [-30, -20, 0, 6, 20, 40]),
  },
  {
    name: 'asteroid-impact',
    what: 'The Asteroid smashes into 우리 at the Rim',
    cfg: c('asteroid', 'uri', 'rim', 23),
    t0: 9570,
    t1: 9830,
    stills: around(9692, [-30, -10, 0, 8, 20, 40]),
  },
  {
    name: 'witness-planet',
    what: 'The Witness vs the Planet in the Nursery: beams through a world',
    cfg: c('lastone', 'planet', 'nursery', 21),
    t0: 5090,
    t1: 5380,
    stills: around(5221, [-40, -20, 0, 10, 25, 50]),
  },
];
