import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  type AudioScene,
  type MatchApi,
  type MatchConfig,
  type SimEvent,
  type StageId,
  type TitanId,
} from '@/contracts';
import { bandEnergies } from '@/audio/dsp/analysis';
import { laptopLufs } from './audio-laptop';
import { loadUriAsset } from '@/titans/uri/asset';
import uriBinUrl from '@/titans/uri/uri_rig.bin?url';
import { createAI } from '@/ai';
import { createAudioEngine } from '@/audio/engine';
import { createFighter } from '@/combat';
import { createMatterWorld } from '@/matter';
import { createAiSource, createMatch } from '@/sim';
import { getTitanDef } from '@/titans';
import { FxState, buildAudioScene } from '@/app/fx';
import { KFilter } from '@/telemetry/loudness';
import { measureRender, type RoundReport } from './audio-round';

/**
 * D6 calibration against REAL fight density: a real Match (AI vs AI, any two titans; by default the Witness vs the Planet, real fighters, real matter
 * world) is stepped inside an OfflineAudioContext render, and its SimEvent stream drives the real engine exactly the way the
 * app does — `handleAt` with every tick's events at that tick's time, `updateAt` with `buildAudioScene` and FxState's intensity.
 * KO slow motion stretches the ticks in audio time, as in play. When a match ends inside the window, the next one starts
 * (seed + 1). Measured with telemetry's definitions (`measureRender`); a heavy blow = a hit with energy ≥ 400, as telemetry.
 */
export interface FightReport extends RoundReport {
  seed: number;
  level: number;
  footwork: 'classic' | 'orbit';
  matches: number;
  hits: number;
  heavyHits: number;
  /** What the limiter worked on: seconds of ≥ 3 dB gain reduction, by the events handled in the 250 ms before it (key: t[:kind|id|type]). */
  limiterBy: Record<string, number>;
  /**
   * Where the integrated loudness comes from: the 10 loudest seconds, each keyed "<second>s <events in it and the 0.5 s
   * before, with counts>" (keys as limiterBy), valued by its share (%) of the output's K-weighted energy.
   */
  loudBy: Record<string, number>;
  titans: [TitanId, TitanId];
  stage: StageId;
  /**
   * Long-term spectral balance of the speaker output (Welch, whole render): the share of its power below 80 Hz, 80–250 Hz (the
   * laptop "weight" band), 250 Hz–2 kHz, 2–6 kHz and above 6 kHz.
   */
  bands: { sub: number; low: number; mid: number; high: number; air: number };
  /** Integrated loudness as a laptop speaker plays it (`laptopLufs`, D27). */
  laptopIntegrated: number;
  /** The speaker output as a 16-bit stereo WAV, base64 (only when asked for: `wav`). */
  wav?: string;
}

export interface FightOptions {
  seconds?: number;
  seed?: number;
  level?: number;
  footwork?: 'classic' | 'orbit';
  titans?: [TitanId, TitanId];
  stage?: StageId;
  /** Return the output as a WAV (base64) for listening. */
  wav?: boolean;
}

const SR = 48000;
const TICK = 1 / 60;
const HEAVY_ENERGY = 400;

/** A deterministic AI-vs-AI match (the same config always plays the same fight). */
export function newMatch(
  seed: number,
  level: number,
  footwork: 'classic' | 'orbit',
  titans: [TitanId, TitanId],
  stage: StageId,
): MatchApi {
  const cfg: MatchConfig = {
    seed,
    stage,
    mode: 'aivai',
    footwork,
    slots: [
      { titan: titans[0], controller: 'ai', aiLevel: level as 4 },
      { titan: titans[1], controller: 'ai', aiLevel: level as 4 },
    ],
  };
  const m = createMatch(cfg, {
    createWorld: createMatterWorld,
    createFighter,
    getTitanDef,
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  });
  m.setSources(
    createAiSource(m, 0, createAI(cfg.slots[0].aiLevel!, getTitanDef(titans[0]), seed * 7 + 1, { footwork })),
    createAiSource(m, 1, createAI(cfg.slots[1].aiLevel!, getTitanDef(titans[1]), seed * 7 + 2, { footwork })),
  );
  return m;
}

export async function runFightVerification(o: FightOptions = {}): Promise<FightReport> {
  const seconds = o.seconds ?? 60;
  const seed = o.seed ?? 21;
  const level = o.level ?? 4;
  const footwork = o.footwork ?? 'orbit';
  const titans: [TitanId, TitanId] = o.titans ?? ['lastone', 'planet'];
  const stage: StageId = o.stage ?? 'nursery';
  if (titans.includes('uri')) await loadUriAsset(uriBinUrl);
  const ctx = new OfflineAudioContext(4, Math.ceil(SR * seconds), SR);
  ctx.destination.channelCountMode = 'explicit';
  ctx.destination.channelInterpretation = 'discrete';
  const eng = createAudioEngine({ context: ctx, seed });
  await eng.unlock();
  const taps = eng.taps()!;
  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(4);
  taps.music.connect(split);
  split.connect(merge, 0, 2);
  split.connect(merge, 1, 3);
  merge.connect(ctx.destination);

  let m = newMatch(seed, level, footwork, titans, stage);
  let matches = 1;
  const fx = new FxState();
  let tickAt = 0; // audio time of the next tick
  let hits = 0;
  const heavy: number[] = [];
  const gr: { t: number; db: number }[] = [];
  const recent: { t: number; key: string }[] = [];
  const log: { t: number; key: string }[] = [];
  const limiterBy: Record<string, number> = {};
  const step = (now: number): void => {
    const db = eng.limiterReductionDb();
    gr.push({ t: now, db });
    if (db >= 3) {
      const keys = new Set(recent.filter((r) => r.t >= now - 0.25 && r.t <= now).map((r) => r.key));
      for (const k of keys.size ? keys : new Set(['(none)']))
        limiterBy[k] = +((limiterBy[k] ?? 0) + TICK).toFixed(3);
    }
    // run every tick due before the next step, each at its own audio time
    while (tickAt <= now + TICK) {
      if (m.phase === 'matchend') {
        m = newMatch(seed + matches, level, footwork, titans, stage);
        matches++;
        fx.reset();
      }
      m.step();
      const ev: readonly SimEvent[] = m.events;
      fx.tick(ev, m);
      for (const e of ev)
        if (e.t === 'hit') {
          hits++;
          if (e.energy >= HEAVY_ENERGY) heavy.push(tickAt);
        }
      for (const e of ev) {
        const sub = 'kind' in e ? e.kind : 'id' in e ? e.id : e.t === 'hit' ? e.type : '';
        if (e.t !== 'shake' && e.t !== 'zoom' && e.t !== 'roll' && e.t !== 'hitstop' && e.t !== 'feel') {
          const key = sub ? `${e.t}:${String(sub)}` : e.t;
          recent.push({ t: tickAt, key });
          log.push({ t: tickAt, key });
        }
      }
      while (recent.length && recent[0]!.t < tickAt - 1) recent.shift();
      if (ev.length) eng.handleAt(ev, tickAt + 0.006);
      tickAt += TICK / Math.max(0.05, m.timeScale || 1);
    }
    const phase: AudioScene['phase'] = m.phase === 'matchend' ? 'results' : 'fight';
    const mid = (m.fighters[0].view.x + m.fighters[1].view.x) / 2;
    eng.updateAt(buildAudioScene(m, phase, fx.intensity(), mid), TICK, now + 0.15);
  };
  step(0);
  for (let t = TICK; t < seconds - TICK; t += TICK) {
    const at = t;
    void ctx.suspend(at).then(() => {
      step(at);
      void ctx.resume();
    });
  }
  const buf = await ctx.startRendering();
  await new Promise((res) => setTimeout(res, 50));
  const r = measureRender(buf, seconds, heavy, gr, eng.limiterReductionDb());
  const loudBy = attribute(buf, log);
  return {
    ...r,
    seed,
    level,
    footwork,
    matches,
    hits,
    heavyHits: heavy.length,
    limiterBy,
    loudBy,
    titans,
    stage,
    bands: spectralBalance(buf),
    laptopIntegrated: laptopLufs(buf.getChannelData(0), buf.getChannelData(1), buf.sampleRate),
    wav: o.wav ? wavBase64(buf) : undefined,
  };
}

/** `FightReport.bands` of channels 1–2 (the speakers). */
function spectralBalance(buf: AudioBuffer): FightReport['bands'] {
  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  const mono = new Float32Array(l.length);
  for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (l[i]! + r[i]!);
  const [sub, low, mid, high, air] = bandEnergies(mono, buf.sampleRate, [20, 80, 250, 2000, 6000, 24000]);
  const f = (v: number | undefined): number => +(v ?? 0).toFixed(4);
  return { sub: f(sub), low: f(low), mid: f(mid), high: f(high), air: f(air) };
}

/** Channels 1–2 as a 16-bit PCM stereo WAV, base64 (for a listening file next to the numbers). */
function wavBase64(buf: AudioBuffer): string {
  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  const n = l.length;
  const bytes = new Uint8Array(44 + n * 4);
  const dv = new DataView(bytes.buffer);
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i);
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + n * 4, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 2, true);
  dv.setUint32(24, buf.sampleRate, true);
  dv.setUint32(28, buf.sampleRate * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, n * 4, true);
  const s16 = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + i * 4, s16(l[i]!), true);
    dv.setInt16(46 + i * 4, s16(r[i]!), true);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
  return btoa(bin);
}

/**
 * Where the integrated loudness comes from (see `FightReport.loudBy`): the share (%) of the output's K-weighted energy in
 * each second, for the 10 loudest seconds, with the events handled in that second and the 0.5 s before it.
 */
function attribute(buf: AudioBuffer, log: readonly { t: number; key: string }[]): Record<string, number> {
  const sec = buf.sampleRate;
  const kf = [new KFilter(sec), new KFilter(sec)];
  const ch = [buf.getChannelData(0), buf.getChannelData(1)];
  const e: number[] = [];
  for (let i = 0; i + sec <= buf.length; i += sec)
    e.push(kf[0]!.sumSquares(ch[0]!, i, i + sec) + kf[1]!.sumSquares(ch[1]!, i, i + sec));
  const total = e.reduce((a, b) => a + b, 0) || 1e-12;
  const out: Record<string, number> = {};
  for (const s of e
    .map((_, i) => i)
    .sort((a, b) => e[b]! - e[a]!)
    .slice(0, 10)) {
    const keys = new Map<string, number>();
    for (const l of log) if (l.t >= s - 0.5 && l.t < s + 1) keys.set(l.key, (keys.get(l.key) ?? 0) + 1);
    const what = [...keys.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => (n > 1 ? `${k}×${n}` : k))
      .join(' ');
    out[`${s}s ${what}`] = +((100 * e[s]!) / total).toFixed(1);
  }
  return out;
}
