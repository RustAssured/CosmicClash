import type { AudioEvent, AudioScene, StageId, TitanId } from '@/contracts';
import type { AudioEngineExt } from '@/audio/engine';
import { bandShare, decayTime, envelopeDb, firstAbove, spectralCentroid } from '@/audio/dsp/analysis';
import {
  SR,
  hit,
  metric,
  minus,
  nonFiniteSamples,
  peak,
  render,
  resetNonFinite,
  rms,
  scene,
  settle,
  toDb,
  type EventMetric,
  type Rendered,
} from './audio-render';
import { runStageVerification, type StageReport } from './audio-stages';
import { runTitanVerification, type TitanReport } from './audio-titans';

/**
 * Numeric verification of the REAL audio engine in a real browser: every scenario renders through an OfflineAudioContext
 * (the same graph and voices the game uses, just faster than real time), then the samples are measured. Run it from
 * dev/ui/audio.html?verify=1 (Playwright does, see e2e/ui-audio.spec.ts).
 *
 * What this can and cannot say: it proves the mix never exceeds full scale, that events make sound, how bright each titan's
 * voice is, how long the reverb tails are, and how soon after an event the first sample appears. It cannot say whether any of
 * it is BEAUTIFUL — only ears can.
 */
export interface VerifyReport {
  sampleRate: number;
  events: EventMetric[];
  /** NaN / ±Infinity samples across EVERY render above: must be 0. */
  nonFiniteSamples: number;
  fuzzRuns: number;
  /** Largest raw (limiter-bypassed) peak over the fuzz renders: a diverging voice shows up here as 1e3+. */
  fuzzWorstRawPeak: number;
  silenceRmsDb: number;
  /** The continuous fighter voices alone (no events, no music), raw. */
  bedPeakDb: number;
  bedRmsDb: number;
  stormPeak: number;
  stormPeakNoLimiter: number;
  stormRmsDb: number;
  stormEvents: number;
  heavyHitTailSec: number;
  latencyMs: number;
  scoreCalmRmsDb: number;
  scoreHotRmsDb: number;
  scoreHotLowBandShare: number;
  scoreCalmLowBandShare: number;
  /** RMS of (render A − render B) relative to the render, same seed: at most float noise (≤ −60 dB). */
  scoreRepeatDiffDb: number;
  /** Peak level (raw, after 2 s) of the calm menu score vs the full-intensity fight score. */
  scoreCalmPeakDb: number;
  scoreHotPeakDb: number;
  /** Spread of the 50 ms RMS envelope: rhythm layers make the hot score far more dynamic than the calm drone. */
  scoreCalmDynDb: number;
  scoreHotDynDb: number;
  /** Spectral centroid above 300 Hz (the shared sub-bass thump excluded): the glassy Last One being hit. */
  glassCentroidHz: number;
  /** Same measure for the Asteroid being hit: rock should sit well below glass. */
  rockCentroidHz: number;
  /** Per-titan character: hit centroid, sub-bass, the continuous bed, and the behaviours of each titan's bed. */
  titans: TitanReport | null;
  /** Per-stage score character (see audio-stages.ts). */
  stages: StageReport | null;
  gainMasterZeroPeak: number;
  gainHalfDb: number;
  uiPeakDb: number;
  uiMaxTailSec: number;
}

/** A worst-case event storm: everything at once, over `seconds`, from all six titans (their releases, cues, surges, ultimates). */
function storm(seconds: number, eng: AudioEngineExt): number {
  let n = 0;
  const types = ['FRACTURE', 'ASSIMILATION', 'TIDAL', 'THERMAL', 'CRUSH', 'KINETIC'] as const;
  const roster: TitanId[] = ['lastone', 'nexus', 'blackhole', 'supernova', 'planet', 'asteroid'];
  const cues = [
    'sever',
    'dark',
    'lost',
    'shed',
    'break',
    'boil',
    'strip',
    'collapse',
    'harvest',
    'swarm',
    'merge',
  ];
  for (let i = 0; i < 480; i++) {
    const t = 0.05 + (i / 480) * (seconds - 0.5);
    const titan = roster[i % 6]!;
    const evs: AudioEvent[] = [
      hit({
        type: types[i % 6]!,
        titan,
        energy: 6000 + (i % 5) * 700,
        heavy: i % 3 === 0,
        onDamaged: 0.8,
        attacker: (i % 2) as 0 | 1,
        target: ((i + 1) % 2) as 0 | 1,
        x: 200 + ((i * 97) % 1200),
      }),
      { t: 'shockwave', x: 800, y: 300, strength: 1, radius: 260, hue: 0.1 },
      { t: 'matter', kind: 'detach', x: 700, y: 300, mass: 900, slot: (i % 2) as 0 | 1 },
      {
        t: 'release',
        slot: (i % 2) as 0 | 1,
        titan,
        moveId: `${titan}.crush`,
        moveSlot: 'crush',
        x: 800,
        y: 300,
        power: 1,
      },
      {
        t: 'cue',
        slot: (i % 2) as 0 | 1,
        titan,
        id: `${titan}-${cues[i % cues.length]}`,
        x: 800,
        y: 300,
        amount: 1,
      },
      { t: 'surge', slot: (i % 2) as 0 | 1, titan, x: 800, y: 300, dirX: 1, dirY: 0 },
    ];
    if (i % 40 === 0)
      evs.push(
        { t: 'ko', slot: (i % 2) as 0 | 1, x: 800, y: 300 },
        { t: 'ultimate', slot: 0, titan: roster[(i / 40) % 6]!, phase: 'start', x: 800, y: 300 },
      );
    eng.handleAt(evs, t);
    n += evs.length;
  }
  return n;
}

export async function runVerification(opts: { quick?: boolean } = {}): Promise<VerifyReport> {
  resetNonFinite();
  const events: EventMetric[] = [];
  const setupFor =
    (ev: AudioEvent[], s: AudioScene) =>
    (eng: AudioEngineExt): void => {
      eng.setVolumes({ music: 0 }); // measure the event, not the score underneath it
      eng.updateAt(s, 1 / 60, 0);
      if (ev.length) eng.handleAt(ev, 0.05);
    };
  /** Every fighter's continuous voice (idle hum, rolling rock) is on in a fight scene: measure events against that bed. */
  const beds = new Map<string, Rendered>();
  const bedFor = async (seconds: number, s: AudioScene): Promise<Rendered> => {
    const key = `${seconds}:${s.phase}:${s.fighters ? s.fighters.map((f) => f.titan).join() : '-'}`;
    let b = beds.get(key);
    if (!b) {
      b = await render(seconds, setupFor([], s), { unsafeBypassLimiter: true });
      beds.set(key, b);
    }
    return b;
  };
  const one = async (
    name: string,
    ev: AudioEvent[],
    seconds = 2.6,
    s: AudioScene = scene(),
  ): Promise<Float32Array> => {
    const bed = await bedFor(seconds, s);
    const withEv = await render(seconds, setupFor(ev, s), { unsafeBypassLimiter: true });
    const diff = minus(withEv.mono, bed.mono);
    events.push(metric(name, diff, 0.05));
    return diff;
  };
  const bedReport = await bedFor(2.6, scene());

  // --- baseline silence
  const empty = await render(1, () => undefined);
  const silenceRmsDb = toDb(rms(empty.mono));

  // --- individual events
  const lastHit = await one('hit FRACTURE lastone→lastone', [
    hit({ type: 'FRACTURE', target: 0, attacker: 0, titan: 'lastone' }),
  ]);
  const rockHit = await one('hit KINETIC asteroid→asteroid', [
    hit({ type: 'KINETIC', target: 1, attacker: 1, titan: 'asteroid' }),
  ]);
  await one('hit heavy CRUSH', [hit({ type: 'CRUSH', energy: 8000, heavy: true })], 6);
  await one('hit blocked', [hit({ blocked: 0.9 })]);
  await one('hit THERMAL', [hit({ type: 'THERMAL' })]);
  await one('hit TIDAL', [hit({ type: 'TIDAL' })]);
  await one('hit ASSIMILATION', [hit({ type: 'ASSIMILATION' })]);
  await one('hit tiny chip', [hit({ type: 'FRACTURE', energy: 90, cellsRemoved: 2, massRemoved: 0.4 })]);
  // every real move of the two shipped titans, in its real slot (windup `move` and active `release`). Some windups are silent
  // ON PURPOSE because another event carries them: sidestep/tumble ride `surge`, lastlight/kessler ride `ultimate`, the guards
  // ride `guard`, and the Gaze's windup is the sustained `charge` voice (measured separately below).
  const MOVES = [
    ['lastone', 'lash', 'strike'],
    ['lastone', 'lunge', 'strike'],
    ['lastone', 'shatter', 'crush'],
    ['lastone', 'gaze', 'signature'],
    ['asteroid', 'shoulder', 'strike'],
    ['asteroid', 'meteor', 'crush'],
    ['asteroid', 'swarm', 'signature'],
  ] as const;
  for (const [titan, m, moveSlot] of MOVES) {
    const moveId = `${titan}.${m}`;
    await one(`move ${moveId}`, [
      { t: 'move', slot: 0, titan, moveId, moveSlot, aim: 'forward', x: 700, y: 300 },
    ]);
    await one(`release ${moveId}`, [
      { t: 'release', slot: 0, titan, moveId, moveSlot, x: 700, y: 300, power: 0.8 },
    ]);
  }
  await one('charge lastone.gaze start+hold', [
    { t: 'charge', slot: 0, titan: 'lastone', moveId: 'lastone.gaze', frac: 0, phase: 'start' },
    { t: 'charge', slot: 0, titan: 'lastone', moveId: 'lastone.gaze', frac: 0.7, phase: 'hold' },
  ]);
  await one('surge lastone', [{ t: 'surge', slot: 0, titan: 'lastone', x: 700, y: 300, dirX: 1, dirY: 0 }]);
  await one('surge asteroid', [
    { t: 'surge', slot: 1, titan: 'asteroid', x: 900, y: 300, dirX: -1, dirY: 0 },
  ]);
  await one('guard lastone', [{ t: 'guard', slot: 0, x: 700, y: 300, type: 'FRACTURE', broke: false }]);
  await one('guard broke asteroid', [{ t: 'guard', slot: 1, x: 900, y: 300, type: 'KINETIC', broke: true }]);
  await one('shockwave', [{ t: 'shockwave', x: 800, y: 300, strength: 0.9, radius: 240, hue: 0.1 }], 4);
  await one('ko lastone', [{ t: 'ko', slot: 0, x: 700, y: 300 }], 5);
  await one('ko asteroid', [{ t: 'ko', slot: 1, x: 900, y: 300 }], 5);
  await one(
    'ultimate lastone start',
    [{ t: 'ultimate', slot: 0, titan: 'lastone', phase: 'start', x: 700, y: 300 }],
    6,
  );
  await one(
    'ultimate asteroid start',
    [{ t: 'ultimate', slot: 1, titan: 'asteroid', phase: 'start', x: 900, y: 300 }],
    6,
  );
  for (const kind of ['detach', 'ignite', 'crack', 'consume', 'impact'] as const)
    await one(`matter ${kind}`, [{ t: 'matter', kind, x: 800, y: 300, mass: 300, slot: 1 }]);
  await one('cue tendril-sever', [
    { t: 'cue', slot: 0, titan: 'lastone', id: 'tendril-sever', x: 700, y: 300, amount: 1 },
  ]);
  await one('cue fragment-lost', [
    { t: 'cue', slot: 1, titan: 'asteroid', id: 'fragment-lost', x: 900, y: 300, amount: 1 },
  ]);
  await one('round intro', [{ t: 'round', phase: 'intro', round: 1, winner: -1 }], 3);
  await one('round fight', [{ t: 'round', phase: 'fight', round: 1, winner: -1 }], 3);
  await one('round end', [{ t: 'round', phase: 'end', round: 1, winner: 0 }], 5);
  for (const id of [
    'move',
    'confirm',
    'back',
    'select',
    'error',
    'start',
    'pause',
    'unpause',
    'roundwin',
    'tick',
  ] as const)
    await one(
      `ui ${id}`,
      [{ t: 'ui', id }],
      id === 'start' || id === 'roundwin' ? 3.5 : 1.4,
      scene({ phase: 'menu', fighters: null }),
    );

  if (opts.quick) {
    const nan = Number.NaN;
    const ui0 = events.filter((e) => e.name.startsWith('ui '));
    return {
      sampleRate: SR,
      events,
      nonFiniteSamples: nonFiniteSamples(),
      fuzzRuns: 0,
      fuzzWorstRawPeak: nan,
      titans: null,
      stages: null,
      silenceRmsDb,
      bedPeakDb: toDb(bedReport.peak),
      bedRmsDb: toDb(rms(bedReport.mono)),
      stormPeak: nan,
      stormPeakNoLimiter: nan,
      stormRmsDb: nan,
      stormEvents: 0,
      heavyHitTailSec: nan,
      latencyMs: nan,
      scoreCalmRmsDb: nan,
      scoreHotRmsDb: nan,
      scoreHotLowBandShare: nan,
      scoreCalmLowBandShare: nan,
      scoreRepeatDiffDb: nan,
      scoreCalmPeakDb: nan,
      scoreHotPeakDb: nan,
      scoreCalmDynDb: nan,
      scoreHotDynDb: nan,
      glassCentroidHz: spectralCentroid(lastHit, SR, Math.floor(SR * 0.05), 8192, 300),
      rockCentroidHz: spectralCentroid(rockHit, SR, Math.floor(SR * 0.05), 8192, 300),
      gainMasterZeroPeak: nan,
      gainHalfDb: nan,
      uiPeakDb: Math.max(...ui0.map((e) => e.peakDb)),
      uiMaxTailSec: Math.max(...ui0.map((e) => e.tailSec)),
    };
  }

  // --- fuzz: many seeds, every titan pair, every damage type: nothing may ever diverge or go non-finite (raw, i.e. WITHOUT
  // the limiter, because the limiter would hide a diverging voice — and NaN in the chain would silence the game for good)
  const kinds = ['FRACTURE', 'ASSIMILATION', 'TIDAL', 'THERMAL', 'CRUSH', 'KINETIC'] as const;
  const roster: TitanId[] = ['lastone', 'asteroid', 'nexus', 'blackhole', 'supernova', 'planet'];
  let fuzzWorstRaw = 0;
  let fuzzRuns = 0;
  for (let seed = 1; seed <= 24; seed++) {
    const evs: AudioEvent[] = [];
    for (let i = 0; i < 12; i++) {
      const titan = roster[(seed + i) % roster.length]!;
      const other = roster[(seed * 3 + i) % roster.length]!;
      evs.push(
        hit({
          type: kinds[(seed + i) % 6]!,
          titan,
          energy: 300 + ((seed * 977 + i * 331) % 9000),
          heavy: (seed + i) % 3 === 0,
          onDamaged: (i % 4) / 3,
          target: (i % 2) as 0 | 1,
          attacker: ((i + 1) % 2) as 0 | 1,
        }),
        {
          t: 'release',
          slot: (i % 2) as 0 | 1,
          titan,
          moveId: `${titan}.strike`,
          moveSlot: 'strike',
          x: 700,
          y: 300,
          power: (i % 5) / 4,
        },
        { t: 'guard', slot: (i % 2) as 0 | 1, x: 800, y: 300, type: kinds[i % 6]!, broke: i % 3 === 0 },
        {
          t: 'matter',
          kind: (['detach', 'ignite', 'crack', 'consume', 'impact'] as const)[i % 5]!,
          x: 800,
          y: 300,
          mass: 50 + i * 90,
          slot: (i % 2) as 0 | 1,
        },
        { t: 'surge', slot: (i % 2) as 0 | 1, titan: other, x: 800, y: 300, dirX: 1, dirY: 0 },
      );
    }
    const r = await render(
      4,
      (eng) => {
        eng.setVolumes({ music: 0 });
        eng.updateAt(scene({}, roster[seed % 6]!, roster[(seed + 1) % 6]!), 1 / 60, 0);
        for (let i = 0; i < evs.length; i += 5)
          eng.handleAt(evs.slice(i, i + 5), 0.05 + (i / evs.length) * 3);
      },
      { unsafeBypassLimiter: true, seed },
    );
    fuzzWorstRaw = Math.max(fuzzWorstRaw, r.peak);
    fuzzRuns++;
  }

  // --- the limiter under a worst-case storm (and proof the storm would clip without it)
  let stormEvents = 0;
  const stormScene = scene({ intensity: 1, lowestIntegrity: 0.1 });
  const stormBuf = await render(6, (eng) => {
    settle(eng, stormScene, 6);
    stormEvents = storm(6, eng);
  });
  const rawBuf = await render(
    6,
    (eng) => {
      settle(eng, stormScene, 6);
      storm(6, eng);
    },
    { unsafeBypassLimiter: true },
  );

  // --- reverb tail of the heaviest blow (event alone: the fighters' idle bed would otherwise never let the envelope decay)
  const heavyBed = await bedFor(9, scene());
  const heavyWith = await render(
    9,
    setupFor(
      [
        hit({ type: 'CRUSH', energy: 9000, heavy: true }),
        { t: 'shockwave', x: 800, y: 300, strength: 1, radius: 300, hue: 0 },
      ],
      scene(),
    ),
    { unsafeBypassLimiter: true },
  );
  const heavyDiff = new Float32Array(heavyWith.mono.length);
  for (let i = 0; i < heavyDiff.length; i++) heavyDiff[i] = heavyWith.mono[i]! - heavyBed.mono[i]!;

  // --- latency: first audible sample after an event scheduled at t = 0.006 (the engine's own look-ahead)
  const lat = await render(0.5, (eng) => {
    eng.setVolumes({ music: 0 });
    eng.handleAt([hit({ type: 'FRACTURE', target: 0, attacker: 0, titan: 'lastone', energy: 2000 })], 0.006);
  });
  const first = firstAbove(lat.mono, 1e-3);

  // --- score
  const scoreAt = async (i: number, seed = 1): Promise<Rendered> =>
    render(
      10,
      (eng) => settle(eng, scene({ intensity: i, fighters: null, phase: i > 0 ? 'fight' : 'menu' }), 10),
      { seed },
    );
  const calm = await scoreAt(0);
  const hotA = await scoreAt(1);
  const hotB = await scoreAt(1);
  // two renders of the same seed differ by float noise only (Chromium's offline graph is not bit-exact between runs), so
  // compare the RMS of their difference against the signal instead of demanding identical samples
  const d = new Float32Array(hotA.mono.length);
  for (let i = 0; i < d.length; i++) d[i] = hotA.mono[i]! - hotB.mono[i]!;
  const scoreRepeatDiffDb = toDb(rms(d)) - toDb(rms(hotA.mono));
  // the pulse and taiko layers live below 200 Hz: they must carry a real share of the hot score's power
  const hotLowShare = bandShare(hotA.mono, SR, 20, 200, SR * 4, 32768);
  const calmLowShare = bandShare(calm.mono, SR, 20, 200, SR * 4, 32768);
  // rhythm layers show up as dynamics: the spread of the 50 ms RMS envelope (loudest − quietest window) and the peak level
  const dyn = (x: Float32Array): number => {
    const env = envelopeDb(x.subarray(SR * 2), Math.round(SR * 0.05)).filter((v) => v > -90);
    return Math.max(...env) - Math.min(...env);
  };

  // --- volume control (a fixed, unclipped test tone-like event; master scales linearly AFTER the dynamics)
  const gainProbe = (master: number) =>
    render(1.2, (eng) => {
      eng.setVolumes({ master, sfx: 1, music: 0 });
      eng.handleAt([hit({ type: 'KINETIC', energy: 400 })], 0.05);
    });
  const zero = await render(1.2, (eng) => {
    eng.setVolumes({ master: 0 });
    eng.updateAt(scene(), 1 / 60, 0);
    eng.handleAt([hit()], 0.5); // let the 20 ms volume smoothing settle first
  });
  const full = await gainProbe(1);
  const half = await gainProbe(0.5);

  const ui = events.filter((e) => e.name.startsWith('ui '));
  const titans = await runTitanVerification();
  const stages = await runStageVerification();
  return {
    sampleRate: SR,
    events,
    nonFiniteSamples: nonFiniteSamples(),
    fuzzRuns,
    fuzzWorstRawPeak: fuzzWorstRaw,
    titans,
    stages,
    silenceRmsDb,
    bedPeakDb: toDb(bedReport.peak),
    bedRmsDb: toDb(rms(bedReport.mono)),
    stormPeak: stormBuf.peak,
    stormPeakNoLimiter: rawBuf.peak,
    stormRmsDb: toDb(rms(stormBuf.mono)),
    stormEvents,
    heavyHitTailSec: decayTime(heavyDiff.subarray(Math.floor(SR * 0.05)), SR, 40, 20),
    latencyMs: first < 0 ? Infinity : (first / SR) * 1000,
    scoreCalmRmsDb: toDb(rms(calm.mono, SR * 2, SR * 10)),
    scoreHotRmsDb: toDb(rms(hotA.mono, SR * 2, SR * 10)),
    scoreHotLowBandShare: hotLowShare,
    scoreCalmLowBandShare: calmLowShare,
    scoreRepeatDiffDb,
    scoreCalmPeakDb: toDb(peak(calm.mono, SR * 2)),
    scoreHotPeakDb: toDb(peak(hotA.mono, SR * 2)),
    scoreCalmDynDb: dyn(calm.mono),
    scoreHotDynDb: dyn(hotA.mono),
    glassCentroidHz: spectralCentroid(lastHit, SR, Math.floor(SR * 0.05), 8192, 300),
    rockCentroidHz: spectralCentroid(rockHit, SR, Math.floor(SR * 0.05), 8192, 300),
    gainMasterZeroPeak: peak(zero.mono, Math.floor(SR * 0.4)),
    gainHalfDb: toDb(half.peak) - toDb(full.peak),
    uiPeakDb: Math.max(...ui.map((e) => e.peakDb)),
    uiMaxTailSec: Math.max(...ui.map((e) => e.tailSec)),
  };
}

export type { StageId };
