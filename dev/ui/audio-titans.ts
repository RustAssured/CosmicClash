import { Rng, type AudioEvent, type AudioScene, type TitanId } from '@/contracts';
import type { AudioEngineExt } from '@/audio/engine';
import { createTitanVoice } from '@/audio/voices/index';
import type { VoiceCtx } from '@/audio/voices/types';
import {
  bandLevelDb,
  bandShare,
  countPeaks,
  envelopeDb,
  peakFrequency,
  spectralCentroid,
} from '@/audio/dsp/analysis';
import {
  SR,
  hit,
  metric,
  minus,
  peak,
  render,
  renderLive,
  rms,
  scene,
  toDb,
  type EventMetric,
  type Rendered,
} from './audio-render';

/**
 * Per-titan verification: how each voice sits in the mix, what its character measures as, and whether the continuous voices do
 * what the design says (heavier black hole = lower drone, faster nexus pulse with more of the graph alive, the planet's wind
 * really fading when its atmosphere is stripped…). Numbers only: nobody has listened to these yet.
 */
export interface TitanCharacter {
  titan: TitanId;
  /** Spectral centroid above 300 Hz of a KINETIC hit onto this titan (the shared sub thump excluded): glass high, planet low. */
  hitCentroidHz: number;
  /** Share of that hit's power below 120 Hz. */
  hitSubShare: number;
  /**
   * The titan's BODY voice alone: what `onHitTaken` plays for a mid-sized KINETIC blow, with none of the shared impact layers
   * (the shared layers are the same for everyone and blur the comparison). Spectral centroid above 300 Hz.
   */
  bodyCentroidHz: number;
  /** The titan's continuous voice alone, raw: peak and RMS in dBFS, share of power below 120 Hz. */
  bedPeakDb: number;
  bedRmsDb: number;
  bedSubShare: number;
}

export interface TitanReport {
  /** Every audible event of the four newer titans, bed subtracted (same measures as the main event table). */
  events: EventMetric[];
  character: TitanCharacter[];
  blackHole: {
    /** Dominant pitch of the drone at massFrac 1.8 and 0.5 (heavier must be LOWER). */
    heavyHz: number;
    lightHz: number;
    /** Level (dB) of the 3-12 kHz band when it is nearly out of mass minus when it is healthy: the Hawking glitter. */
    sparkleDb: number;
  };
  nexus: {
    /** Pulse peaks per second in the sub band with a nearly dead graph and with a fully lit one. */
    beatsPerSecLow: number;
    beatsPerSecHigh: number;
  };
  supernova: {
    /** Roar level with a full tank and with almost no fuel. */
    bedFullDb: number;
    bedStarvedDb: number;
  };
  planet: {
    /** Wind-band level (400-3000 Hz) before and 3 s after two `atmosphere-strip` cues. */
    windBeforeDb: number;
    windAfterDb: number;
  };
}

const NEW_TITANS = ['nexus', 'blackhole', 'supernova', 'planet'] as const;
const ALL_TITANS: readonly TitanId[] = ['lastone', 'nexus', 'blackhole', 'supernova', 'planet', 'asteroid'];

type FighterScene = NonNullable<AudioScene['fighters']>[number];
type HitEvent = Extract<AudioEvent, { t: 'hit' }>;

/** A fight scene with both fighters the same titan, patched per fighter. */
const pairScene = (
  t: TitanId,
  patch: Partial<FighterScene> = {},
  o: Partial<AudioScene> = {},
): AudioScene => {
  const s = scene(o, t, t);
  for (const f of s.fighters!) Object.assign(f, patch);
  return s;
};

const bedOf = (
  t: TitanId,
  patch: Partial<FighterScene>,
  seconds: number,
  from?: (eng: AudioEngineExt, at: number) => void,
): Promise<Rendered> =>
  renderLive(
    seconds,
    (eng, at) => {
      eng.updateAt(pairScene(t, patch), 1 / 30, 0.05);
      from?.(eng, at);
    },
    { unsafeBypassLimiter: true },
  );

/** One-pole low-pass, in place (for isolating the sub band before counting beats). */
function lowpass(x: Float32Array, hz: number): Float32Array {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / SR);
  const y = new Float32Array(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += a * (x[i]! - s);
    y[i] = s;
  }
  return y;
}

function beatsPerSec(x: Float32Array, fromSec: number): number {
  const seg = lowpass(x.subarray(Math.floor(SR * fromSec)), 90);
  const win = Math.round(SR * 0.02);
  const env = envelopeDb(seg, win).map((db) => Math.pow(10, db / 20));
  let max = 0;
  for (const v of env) max = Math.max(max, v);
  const thr = 0.35 * max;
  return countPeaks(env, thr, 5) / (seg.length / SR); // ≥ 100 ms apart
}

/**
 * The titan's body voice alone: build a bare `VoiceCtx` over an OfflineAudioContext (dry only, no reverb, no shared layers) and call
 * the voice's own `onHitTaken` for a mid-sized KINETIC blow. Deterministic, and the only honest way to compare materials.
 */
async function voiceBody(t: TitanId): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(SR * 2.5), SR);
  const rng = new Rng(11);
  const noise = ctx.createBuffer(1, SR * 2, SR);
  const brown = ctx.createBuffer(1, SR * 2, SR);
  const w = noise.getChannelData(0);
  const b = brown.getChannelData(0);
  let last = 0;
  for (let i = 0; i < w.length; i++) {
    const x = rng.next() * 2 - 1;
    w[i] = x;
    last = (last + 0.02 * x) / 1.02;
    b[i] = last * 3.5;
  }
  const dry = ctx.createGain();
  dry.connect(ctx.destination);
  const wet = ctx.createGain();
  wet.gain.value = 0; // no reverb: it would smear every material into the same wash
  wet.connect(ctx.destination);
  const c: VoiceCtx = {
    ac: ctx,
    dry,
    wet,
    noise,
    brown,
    rand: () => rng.next(),
    panOf: () => 0,
    take: () => true,
    release: () => undefined,
    timeScale: 1,
  };
  const ev = hit({ type: 'KINETIC', titan: t, attacker: 0, target: 1, blocked: 0, onDamaged: 0 }) as HitEvent;
  createTitanVoice(t).onHitTaken?.(c, 0.05, ev, 0.5);
  const buf = await ctx.startRendering();
  return buf.getChannelData(0);
}

/** Just the voice-only body character of every titan (a couple of seconds): the tuning loop for materials. */
export interface BodyCharacter {
  titan: TitanId;
  centroidHz: number;
  peakDb: number;
  /** Level (dB) in 100-300, 300-1k, 1-2k, 2-4k, 4-8k and 8-12k Hz. */
  bandsDb: string;
}

export async function runBodyCharacter(): Promise<BodyCharacter[]> {
  const out: BodyCharacter[] = [];
  const from = Math.floor(SR * 0.05);
  const edges = [100, 300, 1000, 2000, 4000, 8000, 12000];
  for (const t of ALL_TITANS) {
    const body = await voiceBody(t);
    out.push({
      titan: t,
      centroidHz: Math.round(spectralCentroid(body, SR, from, 16384, 300)),
      peakDb: +toDb(peak(body)).toFixed(1),
      bandsDb: edges
        .slice(0, -1)
        .map((lo, i) => Math.round(bandLevelDb(body, SR, lo, edges[i + 1]!, from, 16384)))
        .join(' '),
    });
  }
  return out;
}

export async function runTitanVerification(): Promise<TitanReport> {
  const events: EventMetric[] = [];

  // ---- events of the four newer titans, each against the same scene without it
  const beds = new Map<string, Rendered>();
  const bedFor = async (seconds: number, s: AudioScene): Promise<Rendered> => {
    const key = `${seconds}:${s.fighters!.map((f) => f.titan).join()}`;
    let b = beds.get(key);
    if (!b) {
      b = await render(seconds, (eng) => setup(eng, [], s), { unsafeBypassLimiter: true });
      beds.set(key, b);
    }
    return b;
  };
  const setup = (eng: AudioEngineExt, ev: AudioEvent[], s: AudioScene): void => {
    eng.setVolumes({ music: 0 });
    eng.updateAt(s, 1 / 60, 0);
    if (ev.length) eng.handleAt(ev, 0.05);
  };
  const one = async (name: string, ev: AudioEvent[], s: AudioScene, seconds = 2.4): Promise<void> => {
    const bed = await bedFor(seconds, s);
    const withEv = await render(seconds, (eng) => setup(eng, ev, s), { unsafeBypassLimiter: true });
    events.push(metric(name, minus(withEv.mono, bed.mono), 0.05));
  };
  const move = (
    titan: TitanId,
    moveSlot: 'strike' | 'crush' | 'surge' | 'signature' | 'ultimate' | 'guard',
  ): AudioEvent => ({
    t: 'move',
    slot: 0,
    titan,
    moveId: `${titan}.${moveSlot}`,
    moveSlot,
    aim: 'forward',
    x: 700,
    y: 300,
  });
  const release = (titan: TitanId, moveSlot: 'strike' | 'crush' | 'signature'): AudioEvent => ({
    t: 'release',
    slot: 0,
    titan,
    moveId: `${titan}.${moveSlot}`,
    moveSlot,
    x: 700,
    y: 300,
    power: 0.8,
  });
  const cue = (titan: TitanId, id: string, slot: 0 | 1 = 0): AudioEvent => ({
    t: 'cue',
    slot,
    titan,
    id,
    x: 700,
    y: 300,
    amount: 0.8,
  });
  const matter = (
    kind: 'detach' | 'ignite' | 'crack' | 'consume' | 'harvest' | 'impact' | 'evaporate' | 'boil',
  ): AudioEvent => ({
    t: 'matter',
    kind,
    x: 800,
    y: 300,
    mass: 300,
    slot: 0,
  });

  const dealt: Record<(typeof NEW_TITANS)[number], Partial<HitEvent>> = {
    nexus: { type: 'ASSIMILATION' },
    blackhole: { type: 'TIDAL' },
    supernova: { type: 'THERMAL' },
    planet: { type: 'CRUSH', heavy: true, energy: 6000 },
  };
  // the exact ids the titans emit (plus older keyword shapes, which must keep working)
  const cues: Record<(typeof NEW_TITANS)[number], string[]> = {
    nexus: ['node-dark', 'harvest', 'chain-latch', 'chain-sever', 'graph-harvest', 'node-merge'],
    blackhole: ['disk-shed', 'consume', 'hawking', 'mass-lost', 'disk-break', 'horizon-collapse'],
    supernova: ['layer-blow', 'fuel-burn', 'collapse', 'layer-shed', 'core-collapse', 'fuel-lost'],
    planet: ['crust-crack', 'moon-lost', 'atmo-strip', 'ocean-boil', 'atmosphere-strip', 'crust-break'],
  };
  const matters: Record<
    (typeof NEW_TITANS)[number],
    ('detach' | 'ignite' | 'crack' | 'consume' | 'harvest' | 'impact' | 'evaporate' | 'boil')[]
  > = {
    nexus: ['harvest', 'consume', 'detach'],
    blackhole: ['consume', 'evaporate'],
    supernova: ['ignite', 'evaporate'],
    planet: ['boil', 'crack', 'impact'],
  };
  for (const T of NEW_TITANS) {
    const own = scene({}, T, 'asteroid'); // the titan in slot 0, an Asteroid opposite
    const taken = scene({}, 'asteroid', T); // the titan in slot 1, taking the blow from slot 0
    await one(`${T} takes a hit`, [hit({ type: 'KINETIC', titan: T, attacker: 0, target: 1 })], taken);
    await one(
      `${T} takes a heavy hit`,
      [hit({ type: 'CRUSH', energy: 8000, heavy: true, titan: T, attacker: 0, target: 1 })],
      taken,
      3.5,
    );
    await one(
      `${T} takes a blocked hit`,
      [hit({ type: 'KINETIC', blocked: 0.9, titan: T, attacker: 0, target: 1 })],
      taken,
    );
    await one(`${T} lands a hit`, [hit({ ...dealt[T], titan: 'asteroid', attacker: 0, target: 1 })], own);
    for (const m of ['strike', 'crush', 'signature', 'ultimate'] as const)
      await one(`${T} windup ${m}`, [move(T, m)], own);
    for (const m of ['strike', 'crush', 'signature'] as const)
      await one(`${T} release ${m}`, [release(T, m)], own);
    await one(`${T} surge`, [{ t: 'surge', slot: 0, titan: T, x: 700, y: 300, dirX: 1, dirY: 0 }], own);
    await one(
      `${T} guard holds`,
      [{ t: 'guard', slot: 0, x: 700, y: 300, type: 'KINETIC', broke: false }],
      own,
    );
    await one(
      `${T} guard breaks`,
      [{ t: 'guard', slot: 0, x: 700, y: 300, type: 'KINETIC', broke: true }],
      own,
    );
    await one(`${T} ko`, [{ t: 'ko', slot: 0, x: 700, y: 300 }], own, 6);
    await one(
      `${T} ultimate start`,
      [{ t: 'ultimate', slot: 0, titan: T, phase: 'start', x: 700, y: 300 }],
      own,
      6,
    );
    for (const id of cues[T]) await one(`${T} cue ${id}`, [cue(T, id)], own);
    await one(`${T} cue unknown id`, [cue(T, 'never-heard-of-it')], own);
    for (const k of matters[T]) await one(`${T} matter ${k}`, [matter(k)], own);
  }

  // ---- character: a KINETIC hit onto each titan, both fighters the same titan so dealt and taken layers are its own
  const character: TitanCharacter[] = [];
  for (const T of ALL_TITANS) {
    const s = scene({}, T, T);
    const bed = await bedFor(2.4, s);
    const withEv = await render(
      2.4,
      (eng) => setup(eng, [hit({ type: 'KINETIC', titan: T, attacker: 0, target: 1 })], s),
      { unsafeBypassLimiter: true },
    );
    const d = minus(withEv.mono, bed.mono);
    const from = Math.floor(SR * 0.05);
    const live = await bedOf(T, {}, 5);
    const body = await voiceBody(T);
    character.push({
      bodyCentroidHz: spectralCentroid(body, SR, from, 16384, 300),
      titan: T,
      hitCentroidHz: spectralCentroid(d, SR, from, 8192, 300),
      hitSubShare: bandShare(d, SR, 20, 120, from, 16384),
      bedPeakDb: toDb(peak(live.mono.subarray(SR))),
      bedRmsDb: toDb(rms(live.mono, SR, live.mono.length)),
      bedSubShare: bandShare(live.mono, SR, 20, 120, SR, 65536),
    });
  }

  // ---- black hole: heavier = lower; nearly out of mass = Hawking glitter
  const heavy = await bedOf('blackhole', { massFrac: 1.8, resource: 0.5 }, 6);
  const light = await bedOf('blackhole', { massFrac: 0.5, resource: 0.5 }, 6);
  const thin = await bedOf('blackhole', { massFrac: 0.1, resource: 0.1 }, 6);
  const healthy = await bedOf('blackhole', { massFrac: 1, resource: 0.1 }, 6);
  const blackHole = {
    heavyHz: peakFrequency(heavy.mono, SR, 25, 130, SR * 2, 65536),
    lightHz: peakFrequency(light.mono, SR, 25, 130, SR * 2, 65536),
    sparkleDb:
      bandLevelDb(thin.mono, SR, 3000, 12000, SR * 2, 131072) -
      bandLevelDb(healthy.mono, SR, 3000, 12000, SR * 2, 131072),
  };

  // ---- nexus: pulse speeds up with the graph
  const dead = await bedOf('nexus', { resource: 0.05 }, 8);
  const lit = await bedOf('nexus', { resource: 0.95 }, 8);
  const nexus = { beatsPerSecLow: beatsPerSec(dead.mono, 1.5), beatsPerSecHigh: beatsPerSec(lit.mono, 1.5) };

  // ---- supernova: the roar follows the fuel
  const full = await bedOf('supernova', { resource: 1 }, 5);
  const starved = await bedOf('supernova', { resource: 0.03, speed: 0 }, 5);
  const supernova = {
    bedFullDb: toDb(rms(full.mono, SR, full.mono.length)),
    bedStarvedDb: toDb(rms(starved.mono, SR, starved.mono.length)),
  };

  // ---- planet: two atmosphere-strip cues, and the wind stays gone
  const stripped = await bedOf('planet', {}, 9, (eng, at) => {
    if (Math.abs(at - 3) < 1 / 60)
      eng.handleAt([cue('planet', 'atmosphere-strip'), cue('planet', 'atmosphere-strip', 1)], at + 0.01);
    if (Math.abs(at - 3.2) < 1 / 60)
      eng.handleAt([cue('planet', 'atmosphere-strip'), cue('planet', 'atmosphere-strip', 1)], at + 0.01);
  });
  const planet = {
    windBeforeDb: bandLevelDb(stripped.mono, SR, 400, 3000, SR * 1, 65536),
    windAfterDb: bandLevelDb(stripped.mono, SR, 400, 3000, SR * 7, 65536),
  };

  return { events, character, blackHole, nexus, supernova, planet };
}
