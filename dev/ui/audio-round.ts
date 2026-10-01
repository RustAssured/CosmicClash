import type {
  AudioEvent,
  AudioFighterScene,
  AudioScene,
  DamageType,
  FighterState,
  TitanId,
} from '@/contracts';
import { createAudioEngine } from '@/audio/engine';
import { KFilter, LUFS_FLOOR, LoudnessAccumulator, TruePeakDetector } from '@/telemetry/loudness';

/**
 * D6 verification: one scripted ROUND of the slice matchup (the Witness vs the Planet) rendered through the REAL engine in an
 * OfflineAudioContext (driven every 1/30 s of audio time, like frames), then measured with the same BS.1770 / EBU R128 code
 * telemetry uses (`src/telemetry/loudness.ts`), with telemetry's own definitions:
 *  - integrated loudness, true peak and loudness range of the speaker output;
 *  - per heavy blow: the master's momentary (and short-term) peak in the 0.7 s after it minus the BED's median momentary in
 *    the 3 s before it, the bed's dip in the 0.7 s after it, and how long the bed stays ≥ 3 dB down (100 ms resolution).
 * The bed is tapped where telemetry taps it (`taps().music`: the whole bed after its duck) into channels 3–4 of the render.
 *
 * The round alternates neutral spacing with committed exchanges (heavy blows, a Planet cataclysm) and ends on a KO in
 * slow motion — the shape of a real 50–60 s round in the slice plan.
 */
export interface RoundReport {
  seconds: number;
  integrated: number;
  truePeak: number;
  range: number;
  bedIntegrated: number;
  impactOverBedDb: number[];
  impactOverBedShortDb: number[];
  duckDb: number[];
  duckMs: number[];
  /** Medians of the four lists above. */
  median: { over: number; overShort: number; duck: number; duckMs: number };
  /** Deepest gain reduction of the true-peak limiter over the round (dB). */
  limiterGrDb: number;
  /** Limiter gain reduction (dB) around each heavy blow (and the KO, last). */
  limiterGrAtHeavyDb: number[];
  nonFinite: number;
}

const SR = 48000;
const SECONDS = 60;
const STEP = 1 / 30;

interface Blow {
  t: number;
  attacker: 0 | 1;
  heavy: boolean;
  energy: number;
  type: DamageType;
}

/** The script: neutral spells (spacing, no contact) between committed exchanges, then a KO. */
function script(): { blows: Blow[]; cataclysm: number; ko: number } {
  const blows: Blow[] = [];
  const exchange = (from: number, pattern: [number, 0 | 1, boolean, number, DamageType][]): void => {
    for (const [dt, attacker, heavy, energy, type] of pattern)
      blows.push({ t: from + dt, attacker, heavy, energy, type });
  };
  // 0–9 s neutral
  exchange(9, [
    [0, 0, false, 900, 'FRACTURE'],
    [0.9, 1, false, 1100, 'CRUSH'],
    [2.0, 0, true, 3200, 'FRACTURE'],
    [3.4, 1, true, 4200, 'CRUSH'],
    [4.6, 0, false, 800, 'FRACTURE'],
  ]);
  // 15–24 s neutral
  exchange(24, [
    [0, 1, false, 1000, 'KINETIC'],
    [1.2, 0, true, 3600, 'FRACTURE'],
    [3.0, 1, true, 5200, 'CRUSH'],
  ]);
  // 29 s: the Planet's cataclysm (quake ring), then neutral to 40 s
  exchange(40, [
    [0, 0, false, 1000, 'FRACTURE'],
    [1.0, 0, true, 3000, 'FRACTURE'],
    [2.6, 1, true, 4800, 'CRUSH'],
    [4.4, 0, true, 6000, 'FRACTURE'],
  ]);
  return { blows, cataclysm: 29, ko: 44.4 };
}

const fighter = (titan: TitanId, x: number, state: FighterState, charge = 0): AudioFighterScene => ({
  titan,
  x,
  speed: state === 'idle' ? 20 : 180,
  massFrac: 1,
  charge,
  resource: 1,
  meter: 0.3,
  state,
});

export async function runRoundVerification(): Promise<RoundReport> {
  const ctx = new OfflineAudioContext(4, Math.ceil(SR * SECONDS), SR);
  ctx.destination.channelCountMode = 'explicit';
  ctx.destination.channelInterpretation = 'discrete';
  const eng = createAudioEngine({ context: ctx, seed: 11 });
  await eng.unlock();
  // the bed tap into channels 3–4 (the engine's own output fills 1–2)
  const taps = eng.taps()!;
  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(4);
  taps.music.connect(split);
  split.connect(merge, 0, 2);
  split.connect(merge, 1, 3);
  merge.connect(ctx.destination);

  const { blows, cataclysm, ko } = script();
  const titans: [TitanId, TitanId] = ['lastone', 'planet'];
  let heat = 0;
  let last = 0;
  let timeScale = 1;
  const gr: { t: number; db: number }[] = [];
  const drive = (t: number): void => {
    gr.push({ t, db: eng.limiterReductionDb() });
    const evs: AudioEvent[] = [];
    // heat → intensity the way FxState makes it (rises on blows, decays ~0.985 per tick)
    heat *= Math.pow(0.985, (t - last) * 60);
    last = t;
    if (t < STEP) evs.push({ t: 'round', phase: 'fight', round: 1, winner: -1 });
    let st: [FighterState, FighterState] = ['move', 'move'];
    const charge: [number, number] = [0, 0];
    for (const b of blows) {
      // a committed blow: wind-up 0.45 s before (startup), active on contact
      if (t >= b.t - 0.45 && t < b.t) {
        st[b.attacker] = b.heavy ? 'charge' : 'startup';
        charge[b.attacker] = b.heavy ? (t - (b.t - 0.45)) / 0.45 : 0;
      }
      if (t >= b.t && t < b.t + 0.15) st[b.attacker] = 'active';
      if (t >= b.t && t - STEP < b.t) {
        const target = (1 - b.attacker) as 0 | 1;
        const x = 760 + 80 * target;
        if (b.heavy)
          evs.push({
            t: 'release',
            slot: b.attacker,
            titan: titans[b.attacker],
            moveId: `${titans[b.attacker]}.crush`,
            moveSlot: 'crush',
            x,
            y: 300,
            power: 1,
          });
        evs.push({
          t: 'hit',
          attacker: b.attacker,
          target,
          titan: titans[target],
          x,
          y: 300,
          dirX: b.attacker === 0 ? 1 : -1,
          dirY: 0,
          type: b.type,
          energy: b.energy,
          cellsRemoved: Math.round(b.energy / 30),
          massRemoved: Math.round(b.energy / 80),
          blocked: 0,
          heavy: b.heavy,
          onDamaged: 0.3,
        });
        if (b.energy >= 600)
          evs.push({
            t: 'shockwave',
            x,
            y: 300,
            strength: Math.min(1, b.energy / 3200),
            radius: 50 + b.energy * 0.09,
            hue: 0.1,
          });
        if (b.heavy) {
          evs.push({ t: 'hitstop', ticks: 8 });
          evs.push({ t: 'matter', kind: 'detach', x, y: 300, mass: 180, slot: target });
        }
        heat += Math.min(1.5, b.energy / 1500);
      }
    }
    if (t >= cataclysm && t - STEP < cataclysm) {
      evs.push(
        { t: 'ultimate', slot: 1, titan: 'planet', phase: 'start', x: 840, y: 300 },
        { t: 'shockwave', x: 760, y: 300, strength: 1, radius: 300, hue: 0.08 },
        { t: 'cue', slot: 1, titan: 'planet', id: 'crust-crack', x: 840, y: 300, amount: 1 },
      );
      heat += 2;
    }
    if (t >= ko && t - STEP < ko) {
      evs.push(
        { t: 'flash', amount: 0.7, x: 840, y: 300 },
        { t: 'shockwave', x: 840, y: 300, strength: 1, radius: 240, hue: 0.1 },
        { t: 'ko', slot: 1, x: 840, y: 300 },
        { t: 'timescale', scale: 0.3, ticks: 60 },
      );
      heat += 3;
      timeScale = 0.3;
    }
    if (t >= ko + 3.3) timeScale = 1;
    if (t >= ko + 4 && t - STEP < ko + 4) evs.push({ t: 'round', phase: 'end', round: 1, winner: 0 });
    if (t > ko) st = ['victory', 'ko'];
    const intensity = Math.min(1, 0.12 + heat * 0.18 + (t > 30 ? 0.15 : 0));
    const scene: AudioScene = {
      phase: t > ko + 4 ? 'results' : 'fight',
      stage: 'nursery',
      intensity,
      listenerX: 800,
      lowestIntegrity: t > 30 ? 0.4 : 0.9,
      timeScale,
      fighters: [fighter('lastone', 720, st[0], charge[0]), fighter('planet', 880, st[1], charge[1])],
    };
    if (evs.length) eng.handleAt(evs, t + 0.006);
    eng.updateAt(scene, STEP, t + 0.15);
  };
  drive(0);
  for (let t = STEP; t < SECONDS - STEP; t += STEP) {
    const at = t;
    void ctx.suspend(at).then(() => {
      drive(at);
      void ctx.resume();
    });
  }
  const buf = await ctx.startRendering();
  // the limiter reports through its message port: let the last messages land
  await new Promise((res) => setTimeout(res, 50));
  const limiterGrDb = +eng.limiterReductionDb().toFixed(1);

  // measure: 100 ms blocks, telemetry's accumulator
  const block = SR / 10;
  const master = new LoudnessAccumulator();
  const bed = new LoudnessAccumulator();
  const kf = [0, 1, 2, 3].map(() => new KFilter(SR));
  const tp = [0, 1].map(() => new TruePeakDetector());
  const ch = [0, 1, 2, 3].map((c) => buf.getChannelData(c));
  let nonFinite = 0;
  for (const x of ch) for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i]!)) nonFinite++;
  for (let i = 0; i + block <= buf.length; i += block) {
    const ms = (kf[0]!.sumSquares(ch[0]!, i, i + block) + kf[1]!.sumSquares(ch[1]!, i, i + block)) / block;
    const pk = Math.max(tp[0]!.push(ch[0]!, i, i + block), tp[1]!.push(ch[1]!, i, i + block));
    master.push(ms, pk);
    const bms = (kf[2]!.sumSquares(ch[2]!, i, i + block) + kf[3]!.sumSquares(ch[3]!, i, i + block)) / block;
    bed.push(bms, 0);
  }
  const series = (a: LoudnessAccumulator, from: number, to: number, k: 'momentary' | 'shortTerm'): number[] =>
    a.series.filter((s) => s.t - 0.1 >= from && s.t - 0.1 <= to).map((s) => s[k]);
  const median = (a: number[]): number => {
    const s = a.filter((x) => x > LUFS_FLOOR).sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)]! : LUFS_FLOOR;
  };
  const over: number[] = [];
  const overS: number[] = [];
  const duck: number[] = [];
  const duckMs: number[] = [];
  const grAt: number[] = [];
  const heavyTimes = [...blows.filter((b) => b.heavy).map((b) => b.t), ko];
  for (const t of heavyTimes) {
    const before = median(series(bed, t - 3, t - 0.15, 'momentary'));
    const peak = Math.max(...series(master, t, t + 0.7, 'momentary'));
    const peakS = Math.max(...series(master, t, t + 0.7, 'shortTerm'));
    const bedAfter = series(bed, t, t + 0.7, 'momentary');
    over.push(+(peak - before).toFixed(1));
    overS.push(+(peakS - before).toFixed(1));
    duck.push(+(before - Math.min(...bedAfter)).toFixed(1));
    duckMs.push(bedAfter.filter((m) => before - m >= 3).length * 100);
    // the worklet reports through its port: its reading lands a step or two late
    grAt.push(+Math.max(0, ...gr.filter((g) => g.t >= t && g.t <= t + 0.9).map((g) => g.db)).toFixed(1));
  }
  const med = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
  return {
    seconds: SECONDS,
    integrated: +master.integrated.toFixed(1),
    truePeak: +master.truePeak.toFixed(2),
    range: +master.range.toFixed(1),
    bedIntegrated: +bed.integrated.toFixed(1),
    impactOverBedDb: over,
    impactOverBedShortDb: overS,
    duckDb: duck,
    duckMs,
    median: { over: med(over), overShort: med(overS), duck: med(duck), duckMs: med(duckMs) },
    limiterGrDb,
    limiterGrAtHeavyDb: grAt,
    nonFinite,
  };
}
