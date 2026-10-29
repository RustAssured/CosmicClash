import { MARK, ROSTER_BEATS, beat } from './cue';

/**
 * "WHAT'S LEFT": the edit. Every picture is a TAKE: a window of one real, deterministic AI-vs-AI fight (found by scan.ts,
 * looked at with preview.ts), shot by shoot.ts in the real game (or drawn by the software compositor as a stand-in), and
 * laid on the score's grid (cue.ts). Cards and counters are drawn over it by edit.ts.
 */
export type Key = string; // `${a}-${b}-${stage}-${seed}`

export interface Take {
  id: string;
  key: Key;
  /** Sim tick of the first frame. */
  t0: number;
  /** Sim ticks per output frame (60 fps): 1 = real time, 0.25 = ×0.25 slow motion. `[fromFrame, rate]`, piecewise. */
  rate?: [number, number][];
  /** Camera: the game's own (default), or held on a fighter / the pair's midpoint, `still` (no shake). */
  cam?: { follow: 0 | 1 | 'mid'; still?: boolean; dx?: number; dy?: number };
}

export interface Clip {
  /** Output seconds. */
  at: number;
  dur: number;
  take: Take;
  /** Which fighter's matter each counter shows (none = no counters on this clip). */
  counters?: { left?: 0 | 1; right?: 0 | 1 };
}

export type Card =
  | { k: 'whisper'; at: number; dur: number; lines: string[]; y?: number; scale?: number; typeCps?: number }
  | { k: 'slam'; at: number; dur: number; word: string; style: 'bone' | 'ember' | 'void'; sub?: string; y?: number; size?: number }
  | { k: 'ah'; at: number; dur: number }
  | { k: 'title'; at: number; dur: number }
  | { k: 'sting'; at: number; dur: number }
  | { k: 'countIn'; at: number; dur: number; slot: 0 | 1 };

const T = (id: string, key: Key, t0: number, more: Partial<Take> = {}): Take => ({ id, key, t0, ...more });

// ---- the roster: nine titans, nine ways to destroy matter --------------------------------------------------------------
const ROSTER: { take: Take; word: string; sub: string; slot: 0 | 1 }[] = [
  { take: T('r-planet', 'planet-asteroid-shearfield-21', 1420), word: 'GRAVITY', sub: '행성  PLANET', slot: 0 },
  { take: T('r-asteroid', 'planet-asteroid-shearfield-22', 3575), word: 'MOMENTUM', sub: '소행성  THE ASTEROID', slot: 1 },
  { take: T('r-nexus', 'colossus-nexus-mausoleum-21', 485), word: 'POSSESSION', sub: '넥서스  THE NEXUS', slot: 1 },
  { take: T('r-blackhole', 'blackhole-supernova-redgiant-21', 661), word: 'ABSENCE', sub: '블랙홀  BLACK HOLE', slot: 0 },
  { take: T('r-witness', 'lastone-remainder-rim-22', 410), word: 'TESTIMONY', sub: '목격자  THE WITNESS', slot: 0 },
  { take: T('r-cradle', 'nexus-cradle-quasar-22', 2141), word: 'GESTATION', sub: '태반체  THE CRADLE', slot: 1 },
  { take: T('r-supernova', 'supernova-planet-redgiant-21', 1590), word: 'SACRIFICE', sub: '초신성  SUPERNOVA', slot: 0 },
  { take: T('r-remainder', 'lastone-remainder-rim-21', 548), word: 'SURVIVAL', sub: '잔여체  THE REMAINDER', slot: 1 },
  { take: T('r-lastone', 'colossus-planet-mausoleum-22', 4515), word: 'PERCEPTION', sub: '마지막 하나  THE LAST ONE', slot: 0 },
];

// ---- the hunt montage: one real blow by 우리 on eight titans, a cut on every beat ------------------------------------------
const HUNT: [string, Key, number][] = [
  ['h-planet', 'uri-planet-rim-21', 3015],
  ['h-nexus', 'uri-nexus-quasar-21', 5070],
  ['h-blackhole', 'uri-blackhole-tussenruimte-22', 6401],
  ['h-supernova', 'uri-supernova-redgiant-22', 5106],
  ['h-remainder', 'uri-remainder-tussenruimte-21', 2982],
  ['h-colossus', 'uri-colossus-mausoleum-21', 1551],
  ['h-lastone', 'uri-lastone-rim-21', 7612],
  ['h-cradle', 'uri-cradle-nursery-21', 850],
];

function build(): { clips: Clip[]; cards: Card[] } {
  const clips: Clip[] = [];
  const cards: Card[] = [];
  const clip = (at: number, end: number, take: Take, counters?: Clip['counters']): void =>
    void clips.push({ at, dur: +(end - at).toFixed(4), take, counters });

  // I. REFUSAL: 우리 alone, slow; the blast it swallows; its answer
  const uriAlone = T('i-alone', 'uri-supernova-redgiant-21', 180, { rate: [[0, 0.5]], cam: { follow: 0, still: true } });
  clip(2.0, 7.0, uriAlone, { left: 0 });
  cards.push({ k: 'countIn', at: 2.4, dur: 1.6, slot: 0 });
  cards.push({ k: 'whisper', at: 2.8, dur: 2.0, lines: ['TWO WORLDS DIED.'], y: 150, scale: 2 });
  cards.push({ k: 'whisper', at: 4.9, dur: 2.0, lines: ['THIS IS WHAT THEY LEFT.'], y: 150, scale: 2 });
  // the nova: real time to the blast, then ×0.25 while the loop swallows it
  clip(7.0, 9.6, T('i-blast', 'uri-supernova-redgiant-21', 1560, { rate: [[0, 1], [13, 0.25]] }), { left: 0 });
  cards.push({ k: 'whisper', at: 7.5, dur: 2.0, lines: ['IT REFUSES TO FALL APART.'], y: 40, scale: 2, typeCps: 30 });
  clip(9.6, MARK.ah, T('i-answer', 'uri-cradle-nursery-21', 850 - 24));
  cards.push({ k: 'ah', at: MARK.ah, dur: MARK.roster - MARK.ah });

  // II. ROSTER
  let b = 3;
  for (const [i, r] of ROSTER.entries()) {
    const at = beat(b);
    b += ROSTER_BEATS[i]!;
    const end = beat(b);
    clip(at, end, r.take, r.slot === 0 ? { left: 0, right: 1 } : { left: 1, right: 0 });
    cards.push({ k: 'slam', at, dur: Math.min(end - at, 1.6), word: r.word, style: 'bone', sub: r.sub });
  }

  // III. THE RULE
  clip(MARK.rule, beat(34), T('x-loosen', 'remainder-cradle-nursery-22', 1625), { left: 0, right: 1 });
  clip(beat(34), MARK.body, T('x-uri', 'uri-blackhole-tussenruimte-21', 2925 - 100), { left: 0, right: 1 });
  cards.push({ k: 'slam', at: MARK.rule, dur: beat(34) - MARK.rule, word: 'NO HEALTH BARS.', style: 'ember', size: 4 });
  clip(MARK.body, beat(42), T('x-carved', 'uri-planet-nursery-22', 6909 - 170), { left: 0, right: 1 });
  cards.push({ k: 'slam', at: MARK.body, dur: beat(42) - MARK.body, word: 'YOUR BODY', style: 'ember', size: 4 });
  // the loop snaps: the Last One's beams rake 우리 to pieces; the snap itself in ×0.25, held into the silence
  const snapTick = 3151;
  const snapFrames = Math.round((MARK.snap - beat(42)) * 60);
  clip(
    beat(42),
    MARK.hunt,
    T('x-snap', 'uri-colossus-mausoleum-22', snapTick - snapFrames, { rate: [[0, 1], [snapFrames, 0.25]] }),
    { left: 0, right: 1 },
  );
  cards.push({ k: 'slam', at: beat(42), dur: MARK.snap - beat(42), word: 'IS THE BAR.', style: 'ember', size: 4 });

  // IV. THE HUNT
  clip(MARK.hunt, MARK.through, T('h-rise', 'uri-colossus-mausoleum-22', 3215, { rate: [[0, 0.75]] }), { left: 0 });
  cards.push({ k: 'whisper', at: MARK.hunt + 0.3, dur: 1.6, lines: ['IT IS LOOKING FOR AN EYE'], y: 60, scale: 2 });
  cards.push({ k: 'whisper', at: MARK.hunt + 2.0, dur: 1.9, lines: ['IT IS LOOKING FOR AN EYE', 'AND A MOUTH.'], y: 60, scale: 2 });
  for (const [i, [id, key, hit]] of HUNT.entries())
    clip(beat(57 + i), beat(58 + i), T(id, key, hit - 22), { left: 0, right: 1 });
  cards.push({ k: 'slam', at: MARK.through, dur: MARK.fist - MARK.through, word: 'IT WILL GO THROUGH YOU', style: 'void', size: 3 });
  // the last blow: the wind-up, cut one frame before it lands
  clip(MARK.fist, MARK.black, T('h-fist', 'uri-asteroid-shearfield-22', 6300 - 80));
  cards.push({ k: 'slam', at: MARK.fist, dur: MARK.black - MARK.fist, word: 'TO GET THERE.', style: 'void', size: 3 });

  // V. TITLE + the sting
  cards.push({ k: 'title', at: MARK.title, dur: MARK.sting - MARK.title });
  clip(MARK.sting, MARK.end, T('s-mouth', 'uri-mouth-mausoleum-21', 690, { rate: [[0, 0.5]] }));
  cards.push({ k: 'sting', at: MARK.sting, dur: MARK.end - MARK.sting });
  return { clips, cards };
}

export const EDL = build();

/** Every take, once, with how many output frames the edit uses from it. */
export function takesNeeded(): { take: Take; frames: number }[] {
  const m = new Map<string, { take: Take; frames: number }>();
  for (const c of EDL.clips) {
    const f = Math.round(c.dur * 60);
    const cur = m.get(c.take.id);
    if (!cur || cur.frames < f) m.set(c.take.id, { take: c.take, frames: f });
  }
  return [...m.values()];
}
