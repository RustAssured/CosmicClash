/**
 * The trailer's edit (docs/site/TRAILER.md shot list), 60 fps. `src.shot` + `at` (a tick) + `pre` (seconds of the render
 * before the first frame showing it), or `frame` (an absolute frame of the render); `seq`: made-in-code frames
 * (tools/press/trailer/art.ts); `card`: a black text card; `black`. `over`: overlay cards (seconds into the cut).
 * `mouth`: the oracle's frames (tools/press/trailer/mouth.ts) composited from `at` seconds into the cut.
 */
export type Src =
  | { shot: string; at: number; pre: number; frame?: undefined; events?: { tick: number; what: string }[] }
  | { shot: string; frame: number; at?: undefined; pre?: undefined; events?: { tick: number; what: string }[] }
  | { seq: string; from: number; kind?: string; note?: string }
  | { card: string }
  | { black: true }
  /** WJ's story teaser (press/trailer/story-teaser.mp4, S7's render of tools/teaser; score press/teaser/score.wav) from `from` s */
  | { teaser: true; from: number };

export interface Cut {
  shotNo: number;
  name: string;
  dur: number;
  src: Src;
  over?: { card: string; from: number; to: number }[];
  /** dy: game px the oracle's frame is lowered by (so only the coil and the top of the jaw rings clear the bottom edge) */
  mouth?: { seq: string; from: number; at: number; dy?: number; note?: string };
  sound: string;
}

const OPEN_NOTE = 'Black. One pixel of light, a second far away; they touch: a tiny flash (frame 196 of the sequence).';

export const CUT_60: Cut[] = [
  {
    shotNo: 1,
    name: 'opening',
    dur: 4,
    src: { seq: 'opening', from: 0, kind: 'made-in-code', note: OPEN_NOTE },
    sound: 'Sub drone; the flash arrives LATE (light-travel delay): the picture flash is at 3.267 s, its sound after it',
  },
  {
    shotNo: 2,
    name: 'first-impact',
    dur: 4,
    src: { shot: 'first-impact', at: 6606, pre: 0.25, events: [{ tick: 6606, what: 'Supernova catastrophic blow on the Planet (the flash)' }] },
    over: [{ card: 'adeuk', from: 0.9, to: 3.8 }],
    sound: 'First impact, huge (hard cut on the flash)',
  },
  ...(
    [
      ['r-witness', 2973, 0.9, 'perception', 'The Witness: eyes open in its cracks, the gaze fires'],
      ['r-planet', 1446, 0.8, 'gravity', 'The Planet: gravity draws the debris back'],
      ['r-asteroid', 9692, 1.0, 'momentum', 'The Asteroid: catastrophic smash, shrapnel'],
      ['r-nexus', 3448, 0.9, 'possession', 'The Nexus: the chain latches'],
      ['r-blackhole', 7974, 1.0, 'absence', 'The Black Hole: the tidal swirl (a KO)'],
      ['r-supernova', 4724, 0.9, 'sacrifice', 'The Supernova: the nova'],
    ] as const
  ).map(
    ([shot, at, pre, word, what]): Cut => ({
      shotNo: 3,
      name: shot,
      dur: 2,
      src: { shot, at, pre, events: [{ tick: at, what }] },
      over: [{ card: `word-${word}`, from: 0.25, to: 1.9 }],
      sound: 'Score builds; cut on hits',
    }),
  ),
  { shotNo: 4, name: 'two-worlds', dur: 1.2, src: { card: 'two-worlds' }, sound: 'Score holds; a breath before 우리' },
  {
    shotNo: 4,
    name: 'uri-fist',
    dur: 4,
    src: { shot: 'uri-fist', at: 8549, pre: 2.2, events: [{ tick: 8549, what: "우리's fist lands on the Black Hole (catastrophic)" }] },
    sound: 'Load-up, the chain through the body, the fist landing, the loop flaring as it holds',
  },
  {
    shotNo: 4,
    name: 'uri-snap',
    dur: 4.8,
    src: { shot: 'uri-snap', at: 8902, pre: 1.6, events: [{ tick: 8902, what: "우리's loop snaps (break-apart, KO)" }] },
    over: [{ card: 'uri', from: 3.1, to: 4.8 }],
    sound: 'Drop the music for the snap. Silence, then debris',
  },
  ...(
    [
      ['m-bh-ult', 2980, 0.7, 1.7],
      ['m-witness-beams', 5221, 0.5, 1.3],
      ['m-sn-flare', 1203, 0.4, 1.3],
      ['card:no-health-bars', 0, 0, 0.9],
      ['m-planet-core', 8151, 0.3, 1.2],
      ['m-uri-beams', 3781, 0.4, 1.0],
      ['m-planet-slab', 2447, 0.3, 0.9],
      ['card:body-is-the-bar', 0, 0, 1.1],
      ['m-sn-collapse', 5344, 0.3, 0.8],
      ['m-nexus-ko', 9032, 0.2, 0.7],
      ['m-planet-ult', 8440, 0.3, 0.6],
      ['m-sb-disk', 1760, 0.2, 0.5],
    ] as const
  ).map(([shot, at, pre, dur]): Cut =>
    shot.startsWith('card:')
      ? { shotNo: 5, name: shot.slice(5), dur, src: { card: shot.slice(5) }, sound: 'Full score (card beat)' }
      : { shotNo: 5, name: shot, dur, src: { shot, at, pre, events: [{ tick: at, what: shot }] }, sound: 'Full score; cuts get faster' },
  ),
  {
    shotNo: 6,
    name: 'turn',
    dur: 8,
    src: { shot: 'turn', frame: 0 },
    mouth: { seq: 'mouth-turn', from: 60, at: 1.2, dy: 105, note: 'a coil slides in along the bottom edge (silhouette)' },
    over: [{ card: 'something-felt-it', from: 3.0, to: 7.4 }],
    sound: 'Score cuts out; a low wet sound (the coil enters at 1.2 s)',
  },
  {
    shotNo: 7,
    name: 'lunge',
    dur: 1.6,
    src: { shot: 'turn', frame: 480 },
    mouth: { seq: 'mouth-lunge', from: 0, at: 0, dy: 40, note: 'the feeding end comes over the edge and lunges; cut before it lands' },
    sound: 'One impact into silence (on the cut to black at the end of this shot)',
  },
  { shotNo: 7, name: 'black', dur: 2.4, src: { black: true }, sound: 'Silence after the impact' },
  { shotNo: 8, name: 'logo', dur: 6, src: { card: 'logo-card' }, sound: 'Tail of the drone' },
];

export const CUT_15: Cut[] = [
  { ...CUT_60[0]!, name: 'opening', dur: 2, src: { seq: 'opening', from: 120, kind: 'made-in-code', note: OPEN_NOTE } },
  { ...CUT_60[1]!, dur: 2, over: [{ card: 'adeuk', from: 0.6, to: 2 }] },
  {
    shotNo: 3,
    name: 'uri-fist',
    dur: 1.5,
    src: { shot: 'uri-fist', at: 8549, pre: 0.9, events: [{ tick: 8549, what: "우리's fist lands" }] },
    over: [{ card: 'uri', from: 0.2, to: 1.5 }],
    sound: 'Score builds; cut on the hit',
  },
  { ...CUT_60[2]!, dur: 1.5, over: [{ card: 'word-perception', from: 0.15, to: 1.5 }] },
  { ...CUT_60[3]!, dur: 1.5, over: [{ card: 'word-gravity', from: 0.15, to: 1.5 }] },
  {
    ...CUT_60.find((c) => c.name === 'turn')!,
    dur: 3,
    src: { shot: 'turn', frame: 300 },
    mouth: { seq: 'mouth-turn', from: 260, at: 0, dy: 105, note: 'the coil along the bottom edge (silhouette)' },
    over: [{ card: 'something-felt-it', from: 0.4, to: 2.9 }],
  },
  { ...CUT_60.find((c) => c.name === 'lunge')!, dur: 1.5, mouth: { seq: 'mouth-lunge', from: 6, at: 0, dy: 40, note: 'the lunge; cut before it lands' } },
  { ...CUT_60.find((c) => c.name === 'logo')!, dur: 2 },
];

/**
 * The converged trailer's gameplay montage (WJ: cut gameplay in after "brace"): 우리 first (it answers "우리 / WE."), every
 * titan, a break-apart, escalating to the biggest flash, then a hard cut back to the teaser's "hunt".
 */
const M = (shot: string, at: number, pre: number, dur: number, what: string): Cut => ({
  shotNo: 0,
  name: shot,
  dur,
  src: { shot, at, pre, events: [{ tick: at, what }] },
  sound: 'Game sound under the montage; cut on the hit',
});
export const CUT_MONTAGE: Cut[] = [
  M('uri-fist', 8549, 1.6, 2.6, "우리's fist lands (×0.25 on contact)"),
  M('r-witness', 2973, 0.5, 1.3, "the Witness's gaze"),
  M('r-planet', 1446, 0.5, 1.1, 'the Planet draws the debris back'),
  M('r-asteroid', 9692, 0.5, 1.0, 'the Asteroid smashes in'),
  M('r-nexus', 3448, 0.5, 1.0, 'the Nexus chain latches'),
  M('r-blackhole', 7974, 0.5, 1.2, "the Black Hole's tidal swirl (KO)"),
  M('m-bh-ult', 2980, 0.4, 1.0, "the Black Hole's ultimate rings"),
  M('m-witness-beams', 5221, 0.3, 0.9, "the Witness's beams through the Planet"),
  M('uri-snap', 8902, 1.3, 3.0, "우리's loop snaps (break-apart)"),
  M('m-planet-core', 8151, 0.3, 0.9, 'the Planet carved to its core (KO)'),
  M('m-sn-flare', 1203, 0.3, 0.7, 'Supernova flare'),
  M('m-nexus-ko', 9032, 0.2, 0.6, 'the Nexus torn apart (KO)'),
  M('m-sb-disk', 1760, 0.2, 0.5, 'a ring of light'),
  M('m-planet-slab', 2447, 0.2, 0.5, "the Planet's crust slabs away"),
  M('r-supernova', 4724, 0.9, 1.4, 'the nova'),
  M('first-impact', 6606, 0.25, 2.0, 'the Supernova blasts the Planet (×0.25): the biggest flash'),
];
const T = (from: number, dur: number, name: string, sound: string): Cut => ({
  shotNo: 0,
  name,
  dur,
  src: { teaser: true, from },
  sound,
});
/** WJ's teaser 0–40 (cold → brace), the montage, the teaser 40–61.2 (hunt → logo). */
export const CUT_FINAL: Cut[] = [
  T(0, 40, 'teaser-cold-to-brace', "WJ's score, unchanged (teaser 0–40 s)"),
  ...CUT_MONTAGE,
  T(40, 21.2, 'teaser-hunt-to-logo', "WJ's score, unchanged (teaser 40–61.2 s)"),
];
/** 15 s social cut of the converged trailer: 우리 / WE. → four gameplay hits → the Edge words → the logo. */
export const CUT_FINAL_15: Cut[] = [
  T(37, 3, 'teaser-we', "WJ's score (teaser 37–40 s): 우리 / WE."),
  M('uri-fist', 8549, 0.8, 1.6, "우리's fist lands"),
  M('r-witness', 2973, 0.4, 1.0, "the Witness's gaze"),
  M('first-impact', 6606, 0.2, 1.6, 'the biggest flash'),
  M('uri-snap', 8902, 0.8, 1.8, "우리's loop snaps"),
  T(51, 3, 'teaser-edge', "WJ's score (teaser 51–54 s): HUNGER. DEVOURS. ENDS."),
  T(57, 3, 'teaser-logo', "WJ's score (teaser 57–60 s): the logo"),
];