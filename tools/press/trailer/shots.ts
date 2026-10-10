import type { PressCfg } from '../../../dev/press/press';

/**
 * The trailer's game shots (docs/site/TRAILER.md), found in the event log of long deterministic AI-vs-AI runs
 * (tools/press/scan.ts → press/work/scan.json) and LOOKED at in contact sheets (tools/press/preview.ts) before shooting.
 * Each is a window [t0, t1) of one fight; `rate` = sim ticks per output frame from a tick on (1 = real time, 0.25 = ×0.25
 * slow motion, by interpolation); the game's own KO slow motion multiplies in unless `ignoreNative`. `cam`: scripted camera
 * keys (smoothstepped between keys; unset fields follow the game camera).
 */
export interface GameShot {
  id: string;
  what: string;
  cfg: PressCfg;
  t0: number;
  t1: number;
  rate?: [number, number][];
  ignoreNative?: boolean;
  cam?: { tick: number; x?: number; y?: number; zoom?: number; dolly?: number; still?: boolean }[];
}

const c = (key: string): PressCfg => {
  const [a, b, stage, seed] = key.split('-') as [PressCfg['a'], PressCfg['b'], PressCfg['stage'], string];
  return { a, b, stage, seed: Number(seed), ai: 4 };
};

export const GAME_SHOTS: GameShot[] = [
  {
    id: 'first-impact',
    what: 'Shot 2: the Supernova blasts the Planet at full arena scale; the crust shears off in slow motion (×0.25 from the flash)',
    cfg: c('planet-supernova-quasar-22'),
    t0: 6560,
    t1: 6690,
    rate: [
      [6560, 1],
      [6600, 0.25],
    ],
    ignoreNative: true,
  },
  { id: 'r-witness', what: 'Roster: the Witness, eyes opening in its cracks (PERCEPTION)', cfg: c('asteroid-lastone-tussenruimte-22'), t0: 2900, t1: 3050 },
  { id: 'r-planet', what: 'Roster: the Planet draws the debris back in (GRAVITY)', cfg: c('planet-blackhole-rim-23'), t0: 1380, t1: 1540 },
  { id: 'r-asteroid', what: 'Roster: the Asteroid smashes in, shrapnel flying (MOMENTUM)', cfg: c('asteroid-uri-rim-23'), t0: 9620, t1: 9770 },
  { id: 'r-nexus', what: 'Roster: the Nexus latches its chain (POSSESSION)', cfg: c('blackhole-nexus-tussenruimte-21'), t0: 3380, t1: 3530 },
  { id: 'r-blackhole', what: "Roster: the Black Hole's tidal stream swallows the light (ABSENCE)", cfg: c('uri-blackhole-nursery-23'), t0: 7900, t1: 8020 },
  { id: 'r-supernova', what: 'Roster: the Supernova goes nova (SACRIFICE)', cfg: c('supernova-nexus-mausoleum-22'), t0: 4670, t1: 4790 },
  {
    id: 'uri-fist',
    what: '우리: load-up, the chain through the body, the fist landing on the Black Hole (×0.25 on contact), the loop holding',
    cfg: c('uri-blackhole-nursery-22'),
    t0: 8400,
    t1: 8620,
    rate: [
      [8400, 1],
      [8541, 0.25],
      [8560, 0.5],
      [8572, 1],
    ],
  },
  {
    id: 'uri-snap',
    what: "우리's loop snaps: everything it held flies apart (×0.25 through the snap)",
    cfg: c('uri-blackhole-nursery-22'),
    t0: 8800,
    t1: 8990,
    rate: [
      [8800, 1],
      [8896, 0.25],
      [8935, 0.5],
    ],
    ignoreNative: true,
  },
  { id: 'm-bh-ult', what: "Montage: the Black Hole's ultimate rings close on the Planet", cfg: c('planet-blackhole-rim-23'), t0: 2920, t1: 3060 },
  { id: 'm-witness-beams', what: "Montage: the Witness's beams through the Planet", cfg: c('lastone-planet-nursery-21'), t0: 5170, t1: 5300 },
  { id: 'm-sn-flare', what: 'Montage: Supernova flare against the Black Hole', cfg: c('supernova-blackhole-shearfield-21'), t0: 1150, t1: 1270 },
  { id: 'm-planet-core', what: 'Montage: the Planet carved down to its core (KO)', cfg: c('nexus-planet-shearfield-23'), t0: 8120, t1: 8230 },
  { id: 'm-uri-beams', what: "Montage: the Witness's gaze on 우리", cfg: c('uri-lastone-mausoleum-23'), t0: 3740, t1: 3830 },
  { id: 'm-planet-slab', what: "Montage: the Planet's crust slabs away", cfg: c('lastone-planet-nursery-21'), t0: 2410, t1: 2500 },
  { id: 'm-sn-collapse', what: 'Montage: the Supernova collapses', cfg: c('planet-supernova-quasar-21'), t0: 5310, t1: 5400 },
  { id: 'm-nexus-ko', what: 'Montage: the Nexus torn apart (KO)', cfg: c('blackhole-nexus-tussenruimte-22'), t0: 9000, t1: 9070 },
  { id: 'm-planet-ult', what: "Montage: the Planet's ultimate rings", cfg: c('planet-supernova-quasar-21'), t0: 8410, t1: 8480 },
  { id: 'm-sb-disk', what: 'Montage: a ring of light over the Shearfield', cfg: c('supernova-blackhole-shearfield-22'), t0: 1730, t1: 1800 },
  {
    id: 'turn',
    what: 'Shot 6–7: mid-fight in the Tussenruimte, everything slows (to ×0.25), the scenery dollies in (the stars slide to the edges); then the lunge',
    cfg: c('blackhole-nexus-tussenruimte-21'),
    t0: 5960,
    t1: 6150,
    rate: [
      [5960, 1],
      [5975, 0.7],
      [5985, 0.45],
      [5993, 0.3],
      [5999, 0.25],
    ],
    ignoreNative: true,
    cam: [
      { tick: 5960, dolly: 0, still: true },
      { tick: 6100, dolly: 1, still: true },
    ],
  },
];
