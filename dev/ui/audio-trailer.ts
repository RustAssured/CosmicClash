import { Rng, type SimEvent, type StageId, type TitanId } from '@/contracts';
import { createAudioEngine } from '@/audio/engine';
import { generateImpulseResponse } from '@/audio/dsp/ir';
import { boom, crackle, grind, lowBell, roar, rumble, saturator, swell, whoosh } from '@/audio/voices/epic';
import { BELL, gravel, makeOut, noiseHit } from '@/audio/voices/synth';
import { filamentSnap, resonance } from '@/audio/voices/materials';
import type { VoiceCtx } from '@/audio/voices/types';
import { FxState, buildAudioScene } from '@/app/fx';
import { KFilter, LoudnessAccumulator, TruePeakDetector, designTruePeakFir } from '@/telemetry/loudness';
import { LIMITER_LOOKAHEAD, LimiterCore } from '@/audio/worklets/limiter';
import { loadUriAsset } from '@/titans/uri/asset';
import uriBinUrl from '@/titans/uri/uri_rig.bin?url';
import { newMatch } from './audio-fight';

/**
 * The trailer's sound (docs/site/TRAILER.md): the game's own fight audio for every gameplay shot, rendered offline from the same
 * deterministic config as the picture and laid on the edit; the designed beats around it (the sub drone, the late-arriving
 * flash, the score building through the roster, the music dropping out for 우리's snap, the low wet sound of "SOMETHING FELT IT",
 * one impact into silence, the drone's tail under the logo); mastered for online video (about −16 LUFS integrated, true peak
 * ≤ −1 dBTP, ending on silence).
 *
 * Input: a cue sheet (press/trailer/cuesheet.json, written by the edit) or the built-in default from TRAILER.md v2.
 * Output: the master (and, on request, its three stems: game, score, design) as 16-bit WAVs, and a sync report (where each
 * gameplay shot's heavy hits land relative to its cut points).
 */

/** A shot's source: a real fight (rendered from its deterministic config) or a designed-only shot. */
export type ShotSource =
  | {
      kind: 'fight';
      titans: [TitanId, TitanId];
      stage?: StageId;
      seed: number;
      level?: number;
      /** Sim tick at the shot's in-point. Omit and give `align` to have the first heavy hit land on a chosen moment. */
      startTick?: number;
      /** Picture speed: 0.25 = four times slower. The fight's events are spread out to match (sync first; pitch stays). */
      slowmo?: number;
      /** Pick `startTick` so the first heavy hit (by `slot`, after `after` ticks) lands `at` seconds into the shot. */
      align?: { slot?: 0 | 1; after?: number; at?: number };
      /**
       * Variable speed, exactly as the picture was shot (press/work/clips/*.json `times`): the picture time (s) of each tick from
       * `startTick` on. Overrides `slowmo`. `offset` = how far into that clip the shot's in-point is (s).
       */
      times?: number[];
      offset?: number;
      /** Key moments of the edit: the sim tick and where it is on the picture (trailer time), checked against the render. */
      events?: { tick: number; at: number; what?: string }[];
    }
  | { kind: 'oracle' | 'edge' | 'black' | 'logo' | 'card' }
  /** WJ's teaser: its finished score (press/teaser/score.wav) from `from` to `to` (teaser seconds), laid sample-accurate. */
  | { kind: 'teaser'; from: number; to?: number };

export interface CueShot {
  id: string;
  /** Edit in / out points (seconds, trailer time). */
  in: number;
  out: number;
  source: ShotSource;
  /** Game-audio level for this shot (linear, default 1). */
  gain?: number;
  /** WJ's sound note (kept for the report). */
  sound?: string;
}

/** The designed beats, by trailer time (seconds). Any of them may be omitted. */
export interface TrailerBeats {
  /** Shot 1: the two lights touch (a tiny dark flash) … */
  flash?: number;
  /** … and the sound of it arrives late. */
  flashArrives?: number;
  /** The roster's cut points (a designed downbeat under each). */
  rosterCuts?: number[];
  /** The score: when it starts building, reaches full, ducks under 우리, drops for the snap, returns, and cuts out. */
  scoreIn?: number;
  scoreFull?: number;
  scoreUnder?: [number, number];
  snap?: number;
  scoreBack?: number;
  scoreOut?: number;
  /** "SOMETHING FELT IT": the low wet sound from `wet[0]` to `wet[1]`. */
  wet?: [number, number];
  /** The Mouth's lunge: pressure from `lunge[0]`, the impact at `lunge[1]`, silence from `lunge[2]`. */
  lunge?: [number, number, number];
  /** The drone's tail under the logo, fading to silence at `logo[1]`. */
  logo?: [number, number];
}

export interface CueSheet {
  name: string;
  duration: number;
  stage?: StageId;
  shots: CueShot[];
  beats: TrailerBeats;
}

const SR = 48000;
const TICK = 1 / 60;
const HEAVY = 400;
const TARGET_LUFS = -16;

/* ------------------------------------------------------------------------------------------------ *
 *  default cue sheets (TRAILER.md v2), used until the edit's own cuesheet.json exists
 * ------------------------------------------------------------------------------------------------ */
const fight = (
  titans: [TitanId, TitanId],
  seed: number,
  stage: StageId,
  slot: 0 | 1 = 0,
  at = 0.05,
  slowmo = 1,
  after = 600,
): ShotSource => ({ kind: 'fight', titans, seed, stage, slowmo, align: { slot, after, at } });

export const DEFAULT_60: CueSheet = {
  name: 'mix-60',
  duration: 60,
  stage: 'rim',
  shots: [
    { id: '1 distance', in: 0, out: 4, source: { kind: 'black' } },
    {
      id: '2 first impact',
      in: 4,
      out: 8,
      source: fight(['planet', 'supernova'], 31, 'redgiant', 0, 0.12, 0.5),
    },
    { id: '3a witness', in: 8, out: 10, source: fight(['lastone', 'planet'], 21, 'nursery') },
    { id: '3b planet', in: 10, out: 12, source: fight(['planet', 'asteroid'], 22, 'rim') },
    { id: '3c asteroid', in: 12, out: 14, source: fight(['asteroid', 'nexus'], 23, 'quasar') },
    { id: '3d nexus', in: 14, out: 16, source: fight(['nexus', 'blackhole'], 24, 'redgiant') },
    { id: '3e black hole', in: 16, out: 18, source: fight(['blackhole', 'supernova'], 25, 'quasar') },
    { id: '3f supernova', in: 18, out: 20, source: fight(['supernova', 'uri'], 26, 'nursery') },
    { id: '4 uri', in: 20, out: 29, source: fight(['uri', 'lastone'], 27, 'rim', 0, 0.4), gain: 0.9 },
    { id: '5a escalation', in: 30, out: 33, source: fight(['planet', 'lastone'], 41, 'redgiant') },
    { id: '5b', in: 33, out: 36, source: fight(['supernova', 'blackhole'], 42, 'quasar') },
    { id: '5c', in: 36, out: 38.5, source: fight(['uri', 'planet'], 43, 'rim') },
    { id: '5d', in: 38.5, out: 40.5, source: fight(['nexus', 'asteroid'], 44, 'nursery') },
    { id: '5e', in: 40.5, out: 42, source: fight(['lastone', 'uri'], 45, 'redgiant') },
    {
      id: '6 the turn',
      in: 42,
      out: 50,
      source: fight(['lastone', 'planet'], 46, 'rim', 0, 0.6, 0.35),
      gain: 0.35,
    },
    { id: '7 the mouth', in: 50, out: 54, source: { kind: 'oracle' } },
    { id: '8 logo', in: 54, out: 60, source: { kind: 'logo' } },
  ],
  beats: {
    flash: 2.2,
    flashArrives: 3.45,
    rosterCuts: [8, 10, 12, 14, 16, 18, 20],
    scoreIn: 7.6,
    scoreFull: 19.5,
    scoreUnder: [20, 28.4],
    snap: 29,
    scoreBack: 30,
    scoreOut: 42,
    wet: [42, 53],
    lunge: [51.9, 53.55, 54],
    logo: [54.6, 59.6],
  },
};

export const DEFAULT_15: CueSheet = {
  name: 'mix-15',
  duration: 15,
  stage: 'rim',
  shots: [
    { id: '1 distance', in: 0, out: 2, source: { kind: 'black' } },
    {
      id: '2 first impact',
      in: 2,
      out: 4,
      source: fight(['planet', 'supernova'], 31, 'redgiant', 0, 0.1, 0.5),
    },
    { id: '3 uri', in: 4, out: 5.5, source: fight(['uri', 'lastone'], 27, 'rim') },
    { id: '3 witness', in: 5.5, out: 7, source: fight(['lastone', 'planet'], 21, 'nursery') },
    { id: '3 planet', in: 7, out: 8.5, source: fight(['planet', 'asteroid'], 22, 'rim') },
    {
      id: '6 the turn',
      in: 8.5,
      out: 11.5,
      source: fight(['lastone', 'planet'], 46, 'rim', 0, 0.4, 0.35),
      gain: 0.35,
    },
    { id: '7 the mouth', in: 11.5, out: 13, source: { kind: 'oracle' } },
    { id: '8 logo', in: 13, out: 15, source: { kind: 'logo' } },
  ],
  beats: {
    flash: 1.0,
    flashArrives: 1.75,
    rosterCuts: [4, 5.5, 7, 8.5],
    scoreIn: 2,
    scoreFull: 4,
    scoreOut: 8.5,
    wet: [8.5, 12.6],
    lunge: [11.6, 12.55, 13],
    logo: [13.2, 14.7],
  },
};

/** Accept the edit's sheet with a little tolerance (start/end for in/out; seconds as strings). */
export function normaliseSheet(raw: unknown, fallback: CueSheet): CueSheet {
  const r = raw as Omit<Partial<CueSheet>, 'shots'> & { shots?: Record<string, unknown>[] };
  if (!r || !Array.isArray(r.shots)) return fallback;
  // the edit's capture metadata (tools/press: { cfg: { a, b, stage, seed, ai }, t0, times }) is a fight source as it stands
  const asSource = (s: Record<string, unknown>): ShotSource => {
    const src = (s.source ?? s) as Record<string, unknown>;
    const cfg = src.cfg as
      { a?: TitanId; b?: TitanId; stage?: StageId; seed?: number; ai?: number } | undefined;
    if (cfg?.a && cfg.b)
      return {
        kind: 'fight',
        titans: [cfg.a, cfg.b],
        stage: cfg.stage,
        seed: Number(cfg.seed ?? 21),
        level: Number(cfg.ai ?? 4),
        startTick: src.t0 === undefined ? undefined : Number(src.t0),
        slowmo: src.slowmo === undefined ? undefined : Number(src.slowmo),
        times: Array.isArray(src.times) ? (src.times as number[]) : undefined,
        offset: src.offset === undefined ? undefined : Number(src.offset),
        events: Array.isArray(src.events)
          ? (src.events as { tick: number; at: number; what?: string }[])
          : undefined,
      };
    if (typeof src.kind === 'string') return src as unknown as ShotSource;
    return { kind: 'black' };
  };
  const shots: CueShot[] = r.shots.map((s, i) => ({
    id: String(s.id ?? s.name ?? i + 1),
    in: Number(s.in ?? s.start),
    out: Number(s.out ?? s.end),
    source: asSource(s),
    gain: s.gain === undefined ? undefined : Number(s.gain),
    sound: s.sound === undefined ? undefined : String(s.sound),
  }));
  const duration = Number(r.duration ?? Math.max(...shots.map((s) => s.out)));
  const raw2 = (r.beats ?? {}) as Record<string, unknown>;
  // the edit's own beat sheet (tools/press: picture times of flash, firstImpact, snap, wet, lunge, logo) → the designed beats
  const beats: TrailerBeats =
    typeof raw2.wet === 'number' || typeof raw2.lunge === 'number' || typeof raw2.firstImpact === 'number'
      ? editBeats(raw2 as Record<string, number>, shots, duration)
      : { ...fallback.beats, ...(raw2 as TrailerBeats) };
  return {
    name: String(r.name || fallback.name),
    duration,
    stage: (r.stage ?? fallback.stage) as StageId,
    shots,
    beats,
  };
}

/**
 * Designed beats from the edit's picture beats. The flash's sound arrives late but before the hard cut; the roster's
 * downbeats sit on its cuts (the game shots between the first impact and 우리 / the turn); the score cuts out where the shot
 * holding the wet sound begins; the lunge's impact lands ON the cut to black and is followed by silence until the logo.
 */
function editBeats(e: Record<string, number>, shots: CueShot[], duration: number): TrailerBeats {
  const game = shots.filter((s) => s.source.kind === 'fight');
  const first = e.firstImpact !== undefined ? game.find((s) => s.out > e.firstImpact!) : game[0];
  const wetShot = e.wet !== undefined ? shots.find((s) => s.in <= e.wet! && s.out > e.wet!) : undefined;
  const turnAt = wetShot?.in ?? e.wet;
  const firstCut = first?.in ?? 0;
  const rosterEnd = e.snap !== undefined ? e.snap : (turnAt ?? duration);
  const roster = game.filter(
    (s) =>
      s !== first && s.in > firstCut && s.in < rosterEnd && !/uri/.test(s.id) && s.in < (turnAt ?? duration),
  );
  const rosterCuts = roster.map((s) => s.in);
  const rosterLast = roster.length ? roster[roster.length - 1]!.out : firstCut + 4;
  const b: TrailerBeats = {
    rosterCuts,
    scoreIn: Math.max(0, (roster[0]?.in ?? firstCut + 2) - 0.4),
    scoreFull: rosterLast - 0.5,
    scoreOut: turnAt,
  };
  if (e.flash !== undefined) {
    b.flash = e.flash;
    b.flashArrives = Math.min(firstCut - 0.3, e.flash + 0.6);
  }
  if (e.snap !== undefined) {
    b.snap = e.snap;
    b.scoreUnder = [rosterLast, e.snap];
    b.scoreBack = shots.find((s) => s.source.kind === 'fight' && s.in >= e.snap! + 1)?.in ?? e.snap + 2;
  }
  if (e.wet !== undefined && e.lunge !== undefined) b.wet = [e.wet, e.lunge];
  if (e.lunge !== undefined) {
    const silence = e.lunge + 0.4;
    b.lunge = [e.lunge - 1.4, e.lunge, silence];
    const logo0 = Math.max((e.logo ?? e.lunge) + 0.4, silence + 0.25);
    b.logo = [logo0, duration - 0.4];
  }
  return b;
}

/* ------------------------------------------------------------------------------------------------ *
 *  gameplay shots: the real engine, the real fight
 * ------------------------------------------------------------------------------------------------ */
export interface ShotRender {
  id: string;
  left: Float32Array;
  right: Float32Array;
  startTick: number;
  /** Heavy hits (energy ≥ 400) in shot time (s from the in-point). */
  hits: number[];
  /** The edit's key moments: picture time vs. where the render plays that tick (trailer time). */
  events: { what: string; at: number; audioAt: number; errMs: number }[];
}

/** The first heavy hit by `slot` at or after tick `after` (a silent sim run; deterministic). */
function findHeavy(
  src: Extract<ShotSource, { kind: 'fight' }>,
  slot: 0 | 1 | undefined,
  after: number,
): number {
  // the strongest blow in the next 60 s by that slot (a heavy one as soon as it comes; otherwise the biggest there was)
  const m = newMatch(src.seed, src.level ?? 4, 'orbit', src.titans, src.stage ?? 'nursery');
  let best = after;
  let bestE = 0;
  for (let tick = 0; tick < after + 60 * 60; tick++) {
    if (m.phase === 'matchend') break;
    m.step();
    if (tick < after) continue;
    for (const e of m.events as readonly SimEvent[])
      if (e.t === 'hit' && (slot === undefined || e.attacker === slot)) {
        if (e.energy >= HEAVY) return tick;
        if (e.energy > bestE) {
          bestE = e.energy;
          best = tick;
        }
      }
  }
  return best;
}

async function renderShot(shot: CueShot, tail: number): Promise<ShotRender> {
  const src = shot.source as Extract<ShotSource, { kind: 'fight' }>;
  const slowmo = Math.min(1, Math.max(0.1, src.slowmo ?? 1));
  const dur = shot.out - shot.in;
  let startTick = src.startTick ?? 0;
  if (src.startTick === undefined && src.align) {
    const hit = findHeavy(src, src.align.slot, src.align.after ?? 600);
    startTick = Math.max(0, hit - Math.round((src.align.at ?? 0.15) * 60 * slowmo));
  }
  const PRE = 2; // seconds of audio before the in-point: beds and voices settle
  const preTicks = Math.min(startTick, Math.round(PRE * 60 * slowmo));
  const len = PRE + dur + tail;
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * len), SR);
  const eng = createAudioEngine({ context: ctx, seed: src.seed, unsafeBypassLimiter: true });
  await eng.unlock();
  eng.setVolumes({ music: 0 }); // the score is its own stem, continuous across the cuts
  const m = newMatch(src.seed, src.level ?? 4, 'orbit', src.titans, src.stage ?? 'nursery');
  const fx = new FxState();
  // fast-forward, silent, to the pre-roll
  for (let tick = 0; tick < startTick - preTicks && m.phase !== 'matchend'; tick++) {
    m.step();
    fx.tick(m.events, m);
  }
  // audio time of each tick: the pre-roll at the shot's own speed, then (with `times`) exactly the picture's clock
  const times = src.times;
  const clip0 = src.offset ?? 0;
  const timeOf = (tk: number): number | null => {
    if (!times || tk < startTick) return null;
    const k = tk - startTick;
    if (k < times.length) return PRE + times[k]! - clip0;
    const last = times.length - 1;
    const dt = last > 0 ? times[last]! - times[last - 1]! : TICK;
    return PRE + times[last]! + (k - last) * dt - clip0;
  };
  const offset = PRE - clip0 - preTicks * (TICK / slowmo); // audio time of the first pre-roll tick
  let tickAt = offset;
  let tick = startTick - preTicks;
  const hits: number[] = [];
  const checks: ShotRender['events'] = [];
  const step = (now: number): void => {
    while (tickAt <= now + TICK && m.phase !== 'matchend') {
      m.step();
      const ev = m.events as readonly SimEvent[];
      fx.tick(ev, m);
      for (const e of ev) if (e.t === 'hit' && e.energy >= 150 && tick >= startTick) hits.push(tickAt - PRE);
      for (const k of src.events ?? [])
        if (k.tick === tick) {
          const audioAt = shot.in + tickAt - PRE;
          checks.push({
            what: k.what ?? `tick ${k.tick}`,
            at: k.at,
            audioAt: +audioAt.toFixed(3),
            errMs: Math.round((audioAt - k.at) * 1000),
          });
        }
      if (ev.length && tickAt >= 0) eng.handleAt(ev, tickAt + 0.006);
      tick++;
      tickAt = timeOf(tick) ?? tickAt + TICK / Math.max(0.05, m.timeScale || 1) / slowmo;
    }
    const mid = (m.fighters[0].view.x + m.fighters[1].view.x) / 2;
    eng.updateAt(buildAudioScene(m, 'fight', fx.intensity(), mid), TICK, now + 0.15);
  };
  step(0);
  for (let t = TICK; t < len - TICK; t += TICK) {
    const at = t;
    void ctx.suspend(at).then(() => {
      step(at);
      void ctx.resume();
    });
  }
  const buf = await ctx.startRendering();
  const from = Math.floor(PRE * SR);
  return {
    id: shot.id,
    left: buf.getChannelData(0).slice(from),
    right: buf.getChannelData(1).slice(from),
    startTick,
    hits: hits.filter((h) => h >= -0.05 && h <= dur + 0.05).map((h) => +h.toFixed(3)),
    events: checks,
  };
}

/* ------------------------------------------------------------------------------------------------ *
 *  the score stem: the game's own adaptive score, driven by the trailer's arc
 * ------------------------------------------------------------------------------------------------ */
async function renderScore(sheet: CueSheet, intensityAt: (t: number) => number): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(SR * sheet.duration), SR);
  const eng = createAudioEngine({ context: ctx, seed: 12, unsafeBypassLimiter: true });
  await eng.unlock();
  eng.setVolumes({ music: 1, sfx: 0 });
  const drive = (t: number): void =>
    eng.updateAt(
      {
        phase: 'fight',
        stage: sheet.stage ?? 'rim',
        intensity: intensityAt(t),
        listenerX: 800,
        lowestIntegrity: 1 - 0.7 * intensityAt(t),
        timeScale: 1,
        fighters: null,
      },
      1 / 30,
      t + 0.2,
    );
  drive(0);
  for (let t = 1 / 30; t < sheet.duration - 1 / 30; t += 1 / 30) {
    const at = t;
    void ctx.suspend(at).then(() => {
      drive(at);
      void ctx.resume();
    });
  }
  return ctx.startRendering();
}

/* ------------------------------------------------------------------------------------------------ *
 *  the designed beats
 * ------------------------------------------------------------------------------------------------ */
function designCtx(ac: BaseAudioContext, dest: AudioNode, seed: number): VoiceCtx {
  const rng = new Rng(seed);
  const mk = (brown: boolean): AudioBuffer => {
    const b = ac.createBuffer(1, SR * 2, SR);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const x = rng.next() * 2 - 1;
      last = (last + 0.02 * x) / 1.02;
      d[i] = brown ? last * 3.5 : x;
    }
    return b;
  };
  const dry = ac.createGain();
  dry.connect(dest);
  const ir = generateImpulseResponse(SR, { decay: 4.6, seed: 5, brightStart: 0.25, brightEnd: 0.02 });
  const irb = ac.createBuffer(2, ir[0].length, SR);
  irb.copyToChannel(ir[0] as Float32Array<ArrayBuffer>, 0);
  irb.copyToChannel(ir[1] as Float32Array<ArrayBuffer>, 1);
  const conv = ac.createConvolver();
  conv.normalize = false;
  conv.buffer = irb;
  const hp = ac.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 80;
  const wet = ac.createGain();
  wet.gain.value = 0.8;
  wet.connect(hp);
  hp.connect(conv);
  conv.connect(dest);
  return {
    ac,
    dry,
    wet,
    noise: mk(false),
    brown: mk(true),
    rand: () => rng.next(),
    panOf: () => 0,
    take: () => true,
    release: () => undefined,
    timeScale: 1,
  };
}

/** The sub drone: detuned low saws (A1 D2 A2), saturated, under a breathing low-pass, and the wind of the void. */
function drone(c: VoiceCtx, level: [number, number][], end: number): void {
  const ac = c.ac;
  const g = ac.createGain();
  g.gain.value = 0;
  for (const [t, v] of level) g.gain.linearRampToValueAtTime(v, t);
  const p = ac.createStereoPanner();
  g.connect(p);
  p.connect(c.dry);
  const ws = ac.createGain();
  ws.gain.value = 0.3;
  p.connect(ws);
  ws.connect(c.wet);
  const sat = saturator(c, 2.2);
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 420;
  lp.Q.value = 0.9;
  const pre = ac.createGain();
  pre.gain.value = 0.22;
  pre.connect(sat);
  sat.connect(lp);
  lp.connect(g);
  const srcs: AudioScheduledSourceNode[] = [];
  for (const [f, cents] of [
    [55, -7],
    [55, 6],
    [73.42, -4],
    [73.42, 9],
    [110, 3],
  ] as const) {
    const o = ac.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    o.detune.value = cents;
    o.connect(pre);
    srcs.push(o);
  }
  const lfo = ac.createOscillator();
  lfo.frequency.value = 0.07;
  const lg = ac.createGain();
  lg.gain.value = 140;
  lfo.connect(lg);
  lg.connect(lp.frequency);
  srcs.push(lfo);
  const wind = ac.createBufferSource();
  wind.buffer = c.brown;
  wind.loop = true;
  const wbp = ac.createBiquadFilter();
  wbp.type = 'bandpass';
  wbp.frequency.value = 260;
  wbp.Q.value = 0.7;
  const wg = ac.createGain();
  wg.gain.value = 0.5;
  wind.connect(wbp);
  wbp.connect(wg);
  wg.connect(g);
  srcs.push(wind);
  for (const s of srcs) {
    s.start(0);
    s.stop(end);
  }
}

/** "SOMETHING FELT IT": a low wet sound — something vast and viscous moving at the edge of the world. */
function wetSound(c: VoiceCtx, from: number, to: number): void {
  const ac = c.ac;
  const dur = to - from;
  // the body: brown noise through a slow, resonant, wandering band (a throat, a gut)
  const src = ac.createBufferSource();
  src.buffer = c.brown;
  src.loop = true;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 4;
  bp.frequency.value = 110;
  const lfo = ac.createOscillator();
  lfo.frequency.value = 0.23;
  const lg = ac.createGain();
  lg.gain.value = 55;
  lfo.connect(lg);
  lg.connect(bp.frequency);
  const g = ac.createGain();
  g.gain.value = 0;
  g.gain.setValueAtTime(0, from);
  g.gain.linearRampToValueAtTime(0.3, from + dur * 0.6);
  g.gain.linearRampToValueAtTime(0.4, to - 0.4);
  g.gain.linearRampToValueAtTime(0, to);
  const o = makeOut(c, 0.3, 0.6);
  src.connect(bp);
  bp.connect(g);
  g.connect(o.input);
  src.start(from);
  src.stop(to + 0.05);
  lfo.start(from);
  lfo.stop(to + 0.05);
  // the wet movement: slow squelches (a resonant low-pass falling through the noise), here and there, and slow low blurps
  let t = from + 0.6;
  let side = -1;
  while (t < to - 0.8) {
    const so = makeOut(c, side * (0.3 + 0.5 * c.rand()), 0.7);
    const n = ac.createBufferSource();
    n.buffer = c.brown;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 7;
    f.frequency.setValueAtTime(260 + 120 * c.rand(), t);
    f.frequency.exponentialRampToValueAtTime(70, t + 0.7);
    const sg = ac.createGain();
    sg.gain.setValueAtTime(0, t);
    sg.gain.linearRampToValueAtTime(0.2 * Math.min(1, (t - from) / (dur * 0.5) + 0.3), t + 0.08);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    n.connect(f);
    f.connect(sg);
    sg.connect(so.input);
    n.start(t, c.rand() * 1.1);
    n.stop(t + 0.85);
    t += 0.7 + 0.9 * c.rand();
    side = -side;
  }
  // and the weight of it: a sub swell that never resolves
  swell(c, makeOut(c, 0, 0.2), from, { dur: dur - 0.2, gain: 0.04, f0: 60, f1: 260, sub: 0.08, subHz: 36 });
}

function designed(c: VoiceCtx, sheet: CueSheet): void {
  const b = sheet.beats;
  const end = sheet.duration;
  const sub = makeOut(c, 0, 0.15);
  const wide = makeOut(c, 0, 0.8);
  // the sub drone: alone at first, under everything, gone for the snap and the lunge's silence, its tail under the logo
  const lv: [number, number][] = [
    [0, 0],
    [1.2, 0.11],
    [(b.scoreFull ?? 8) - 0.5, 0.1],
    [b.scoreFull ?? 8, 0.07],
  ];
  if (b.snap !== undefined)
    lv.push([b.snap - 0.05, 0.07], [b.snap, 0], [b.snap + 1.4, 0], [b.snap + 2.2, 0.06]);
  if (b.wet) lv.push([b.wet[0], 0.09]);
  if (b.lunge) lv.push([b.lunge[1] - 0.05, 0.09], [b.lunge[1], 0]);
  if (b.logo) lv.push([b.logo[0], 0], [b.logo[0] + 1.2, 0.12], [b.logo[1] - 1.5, 0.08], [b.logo[1], 0]);
  else lv.push([end - 0.5, 0]);
  lv.sort((x, y) => x[0] - y[0]);
  drone(c, lv, end);
  // shot 1: two lights touch far away (a tiny, dark flash) … and the sound arrives late
  if (b.flash !== undefined) {
    const o = makeOut(c, 0.35, 0.9);
    noiseHit(c, o, b.flash, {
      dur: 0.18,
      gain: 0.05,
      filter: { type: 'lowpass', f0: 900, f1: 300 },
      attack: 0.003,
    });
  }
  if (b.flashArrives !== undefined) {
    const at = b.flashArrives;
    boom(c, makeOut(c, 0.3, 0.3), at, {
      f0: 84,
      f1: 30,
      dur: 2.4,
      gain: 0.32,
      drive: 3.2,
      crunch: 1.2,
      click: 0.1,
    });
    rumble(c, makeOut(c, 0.3, 0.9), at, { dur: 3.5, gain: 0.12, f0: 380, f1: 70, rate: 0.9 });
  }
  // the roster: a designed downbeat under each cut (the score's taiko lands with the picture)
  for (const t of b.rosterCuts ?? []) {
    boom(c, sub, t, { f0: 92, f1: 40, dur: 0.6, gain: 0.22, crunch: 1.2 });
    lowBell(c, wide, t, 73.42, BELL, { decay: 1.2, gain: 0.025 });
  }
  // 우리's loop snaps: the music is already gone; the cable lets go, then silence, then the debris of two worlds
  if (b.snap !== undefined) {
    const s = b.snap;
    const o = makeOut(c, 0, 0.5);
    filamentSnap(c, o, s, 55, 1, resonance(0.2, 1));
    boom(c, sub, s, { f0: 120, f1: 34, dur: 0.5, gain: 0.5, drive: 3.4 });
    grind(c, o, s, { dur: 0.35, gain: 0.14, f0: 500, f1: 120, rate: 22, metal: true, attack: 0.005 });
    const d = s + 0.9;
    crackle(c, wide, d, { dur: 2.2, count: 36, gain: 0.16, f: 800 });
    gravel(c, wide, d, {
      dur: 2,
      grains: 60,
      f: 420,
      spread: 2.6,
      gain: 0.2,
      decayShape: 1.1,
      lowpass: 1400,
    });
    rumble(c, makeOut(c, 0, 0.8), d, { dur: 2.6, gain: 0.12, f0: 420, f1: 80, rate: 1.2 });
  }
  if (b.wet) wetSound(c, b.wet[0], b.wet[1]);
  // the Mouth lunges over the edge: pressure, the rush of it, ONE impact, cut to black: silence
  if (b.lunge) {
    const [from, hit, silence] = b.lunge;
    swell(c, makeOut(c, -0.4, 0.4), from, {
      dur: hit - from,
      gain: 0.3,
      f0: 70,
      f1: 900,
      sub: 0.2,
      subHz: 34,
    });
    whoosh(c, Math.max(from, hit - 0.7), {
      dur: 0.7,
      gain: 0.3,
      panFrom: -0.8,
      panTo: 0.2,
      wet: 0.3,
      f0: 900,
      f1: 120,
      body: 1.3,
    });
    // the impact (its tail is cut at `silence` by the master's gate)
    boom(c, sub, hit, { f0: 110, f1: 30, dur: 1.2, gain: 0.95, drive: 3.6, knock: 1.1, crunch: 3 });
    roar(c, makeOut(c, 0, 0.3), hit, {
      f: 41,
      f1: 30,
      dur: silence - hit + 0.1,
      gain: 0.2,
      attack: 0.01,
      lp0: 1200,
      lp1: 300,
    });
  }
}

/* ------------------------------------------------------------------------------------------------ *
 *  mix and master
 * ------------------------------------------------------------------------------------------------ */
export interface TrailerReport {
  name: string;
  duration: number;
  integrated: number;
  truePeak: number;
  range: number;
  /** Peak gain reduction of the master limiter (dB). */
  limiterDb: number;
  /** Momentary loudness (LUFS) every 0.5 s. */
  momentary: number[];
  /** Silence at the end (s, below −60 dBFS). */
  endSilence: number;
  shots: {
    id: string;
    in: number;
    out: number;
    startTick?: number;
    hits: number[];
    nearestCutMs?: number;
    events?: ShotRender['events'];
  }[];
  wav: string;
  stems?: { game: string; score: string; design: string };
}

function lin(db: number): number {
  return Math.pow(10, db / 20);
}

/** The score's level over the trailer (dB, −120 = off): built, ducked, dropped and cut where the plan says. */
function scoreLevel(b: TrailerBeats, t: number): number {
  const ramp = (a: number, b2: number, x: number): number =>
    Math.min(1, Math.max(0, (x - a) / Math.max(0.01, b2 - a)));
  if (b.scoreIn === undefined || t < b.scoreIn) return -120;
  if (b.scoreOut !== undefined && t >= b.scoreOut) return -120;
  if (b.snap !== undefined && t >= b.snap - 0.08 && t < (b.scoreBack ?? b.snap + 1)) return -120;
  let db = -18 + 18 * ramp(b.scoreIn, b.scoreFull ?? b.scoreIn + 6, t);
  if (b.scoreUnder && t >= b.scoreUnder[0] && t < b.scoreUnder[1]) db = Math.min(db, -5);
  return db;
}

/** The score's intensity over the trailer: building through the roster, full in the escalation. */
function scoreIntensity(b: TrailerBeats, t: number): number {
  if (b.scoreIn === undefined || t < b.scoreIn) return 0.1;
  const full = b.scoreFull ?? b.scoreIn + 6;
  if (t < full) return 0.25 + 0.75 * ((t - b.scoreIn) / (full - b.scoreIn));
  return 1;
}

function toWav(l: Float32Array, r: Float32Array): string {
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
  dv.setUint32(24, SR, true);
  dv.setUint32(28, SR * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + i * 4, Math.max(-32768, Math.min(32767, Math.round(l[i]! * 32767))), true);
    dv.setInt16(46 + i * 4, Math.max(-32768, Math.min(32767, Math.round(r[i]! * 32767))), true);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
  return btoa(bin);
}

function measure(
  l: Float32Array,
  r: Float32Array,
): { integrated: number; truePeak: number; range: number; momentary: number[] } {
  const kf = [new KFilter(SR), new KFilter(SR)];
  const tp = [new TruePeakDetector(), new TruePeakDetector()];
  const acc = new LoudnessAccumulator();
  const block = SR / 10;
  for (let i = 0; i + block <= l.length; i += block)
    acc.push(
      (kf[0]!.sumSquares(l, i, i + block) + kf[1]!.sumSquares(r, i, i + block)) / block,
      Math.max(tp[0]!.push(l, i, i + block), tp[1]!.push(r, i, i + block)),
    );
  return {
    integrated: acc.integrated,
    truePeak: acc.truePeak,
    range: acc.range,
    // momentary loudness every 0.5 s (the shape of the mix: silences, builds, drops)
    momentary: acc.series.filter((_, i) => i % 5 === 4).map((s) => Math.round(Math.max(-70, s.momentary))),
  };
}

/** Gain to −16 LUFS, then the game's own true-peak limiter (−1.2 dBTP ceiling, so the file stays ≤ −1 dBTP). */
function master(l: Float32Array, r: Float32Array): { l: Float32Array; r: Float32Array; gr: number } {
  let gain = lin(TARGET_LUFS - measure(l, r).integrated);
  let out = { l, r, gr: 0 };
  for (let pass = 0; pass < 3; pass++) {
    const lim = new LimiterCore(
      2,
      SR,
      LIMITER_LOOKAHEAD,
      lin(-1.3),
      0.15,
      designTruePeakFir().map((p) => Array.from(p)),
    );
    const n = l.length;
    const pad = lim.delayFrames;
    const inL = new Float32Array(n + pad);
    const inR = new Float32Array(n + pad);
    for (let i = 0; i < n; i++) {
      inL[i] = l[i]! * gain;
      inR[i] = r[i]! * gain;
    }
    const oL = new Float32Array(n + pad);
    const oR = new Float32Array(n + pad);
    lim.process([inL, inR], [oL, oR], n + pad);
    out = {
      l: oL.subarray(pad),
      r: oR.subarray(pad),
      gr: -20 * Math.log10(Math.max(1e-6, lim.takeMinGain())),
    };
    const got = measure(out.l, out.r).integrated;
    if (Math.abs(got - TARGET_LUFS) < 0.2) break;
    gain *= lin(TARGET_LUFS - got);
  }
  return out;
}

export async function renderTrailer(
  rawSheet: unknown,
  fallback: CueSheet,
  stems = false,
): Promise<TrailerReport> {
  if (JSON.stringify(rawSheet ?? fallback).includes('"uri"')) await loadUriAsset(uriBinUrl);
  const sheet = normaliseSheet(rawSheet, fallback);
  const b = sheet.beats;
  const N = Math.ceil(SR * sheet.duration);
  // 1. the gameplay shots
  const shots: TrailerReport['shots'] = [];
  const renders: { shot: CueShot; r: ShotRender }[] = [];
  for (const shot of sheet.shots) {
    if (shot.source.kind !== 'fight') {
      shots.push({ id: shot.id, in: shot.in, out: shot.out, hits: [] });
      continue;
    }
    const r = await renderShot(shot, 0.8);
    renders.push({ shot, r });
    const cuts = sheet.shots.flatMap((s) => [s.in, s.out]);
    const abs = r.hits.map((h) => shot.in + h);
    const near = abs.length
      ? Math.min(...abs.map((h) => Math.min(...cuts.map((c) => Math.abs(h - c))))) * 1000
      : undefined;
    shots.push({
      id: shot.id,
      in: shot.in,
      out: shot.out,
      startTick: r.startTick,
      hits: r.hits,
      nearestCutMs: near === undefined ? undefined : Math.round(near),
      events: r.events,
    });
  }
  // 2. the score
  const score = await renderScore(sheet, (t) => scoreIntensity(b, t));
  // 3. the mix: game, score and design buses (rendered side by side so they can also be written as stems)
  const ctx = new OfflineAudioContext(6, N, SR);
  ctx.destination.channelCountMode = 'explicit';
  ctx.destination.channelInterpretation = 'discrete';
  const merge = ctx.createChannelMerger(6);
  merge.connect(ctx.destination);
  const bus = (ch: number): GainNode => {
    const g = ctx.createGain();
    const sp = ctx.createChannelSplitter(2);
    g.connect(sp);
    sp.connect(merge, 0, ch);
    sp.connect(merge, 1, ch + 1);
    return g;
  };
  const game = bus(0);
  const scoreBus = bus(2);
  const design = bus(4);
  for (const { shot, r } of renders) {
    const buf = ctx.createBuffer(2, r.left.length, SR);
    buf.copyToChannel(r.left as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(r.right as Float32Array<ArrayBuffer>, 1);
    const s = ctx.createBufferSource();
    s.buffer = buf;
    const g = ctx.createGain();
    // under "SOMETHING FELT IT" the fight goes on far away: the game sits low under the wet sound
    const lvl = shot.gain ?? (b.scoreOut !== undefined && b.wet && shot.in >= b.scoreOut - 0.01 ? 0.4 : 1);
    // a hard cut in, and the tail rings under the next shot for a moment — except into a silence the plan asks for
    const next = sheet.shots.find((x) => Math.abs(x.in - shot.out) < 0.01);
    const intoSilence =
      !next ||
      next.source.kind !== 'fight' ||
      (b.snap !== undefined && Math.abs(shot.out - b.snap) < 1.2) ||
      (b.scoreOut !== undefined && Math.abs(shot.out - b.scoreOut) < 0.05 && next.source.kind !== 'fight');
    const ring = intoSilence ? 0.06 : 0.35;
    g.gain.setValueAtTime(0, shot.in);
    g.gain.linearRampToValueAtTime(lvl, shot.in + 0.004);
    g.gain.setValueAtTime(lvl, shot.out);
    g.gain.linearRampToValueAtTime(0, shot.out + ring);
    s.connect(g);
    g.connect(game);
    s.start(shot.in);
    s.stop(Math.min(sheet.duration, shot.out + ring + 0.05));
  }
  // the snap empties the game bus too: silence, then only the debris
  if (b.snap !== undefined) {
    game.gain.setValueAtTime(1, b.snap - 0.08);
    game.gain.linearRampToValueAtTime(0, b.snap + 0.02);
    game.gain.setValueAtTime(0, (b.scoreBack ?? b.snap + 1) - 0.01);
    game.gain.linearRampToValueAtTime(1, b.scoreBack ?? b.snap + 1);
  }
  const ss = ctx.createBufferSource();
  ss.buffer = score;
  const sg = ctx.createGain();
  sg.gain.value = 0;
  for (let t = 0; t < sheet.duration; t += 0.02)
    sg.gain.linearRampToValueAtTime(lin(scoreLevel(b, t)) * 1.4, t);
  ss.connect(sg);
  sg.connect(scoreBus);
  ss.start(0);
  designed(designCtx(ctx, design, 7), sheet);
  // the lunge's silence: after the impact, everything stops (design and game alike) until the logo's drone
  if (b.lunge) {
    for (const g of [design, game]) {
      g.gain.setValueAtTime(1, b.lunge[2] - 0.05);
      g.gain.linearRampToValueAtTime(0, b.lunge[2]);
      if (b.logo && g === design) {
        g.gain.setValueAtTime(0, b.logo[0] - 0.01);
        g.gain.linearRampToValueAtTime(1, b.logo[0]);
      }
    }
  }
  const out = await ctx.startRendering();
  const ch = [0, 1, 2, 3, 4, 5].map((i) => out.getChannelData(i));
  const L = new Float32Array(N);
  const R = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    L[i] = ch[0]![i]! + ch[2]![i]! + ch[4]![i]!;
    R[i] = ch[1]![i]! + ch[3]![i]! + ch[5]![i]!;
  }
  // end on silence: fade over 0.6 s to digital zero, and hold the last 0.4 s at zero
  const fade = Math.floor(SR * 1);
  for (let i = N - fade; i < N; i++) {
    const k = Math.max(0, Math.min(1, (N - 0.4 * SR - i) / (0.6 * SR)));
    L[i] = L[i]! * k;
    R[i] = R[i]! * k;
  }
  const mm = master(L, R);
  const m = measure(mm.l, mm.r);
  let endSilence = 0;
  for (let i = N - 1; i >= 0 && Math.max(Math.abs(mm.l[i]!), Math.abs(mm.r[i]!)) < 0.001; i--) endSilence++;
  const g = lin(TARGET_LUFS - measure(L, R).integrated);
  const stem = (a: Float32Array, c2: Float32Array): string =>
    toWav(
      a.map((v) => v * g),
      c2.map((v) => v * g),
    );
  return {
    name: sheet.name,
    duration: sheet.duration,
    integrated: +m.integrated.toFixed(1),
    truePeak: +m.truePeak.toFixed(2),
    range: +m.range.toFixed(1),
    limiterDb: +mm.gr.toFixed(1),
    momentary: m.momentary,
    endSilence: +(endSilence / SR).toFixed(2),
    shots,
    wav: toWav(mm.l, mm.r),
    stems: stems
      ? { game: stem(ch[0]!, ch[1]!), score: stem(ch[2]!, ch[3]!), design: stem(ch[4]!, ch[5]!) }
      : undefined,
  };
}

/* ------------------------------------------------------------------------------------------------ *
 *  trailer-final: WJ's teaser (its finished score, a fixed master) around a gameplay montage
 * ------------------------------------------------------------------------------------------------ */
export interface FinalReport extends Omit<TrailerReport, 'stems'> {
  /** Gains applied (dB): to WJ's score (uniform), to the montage before the master, and the master's own. */
  gains: { score: number; montage: number; master: number };
  /** Integrated loudness (LUFS) of the montage and of WJ's score sections, after the master. */
  montageLufs: number;
  teaserLufs: number;
}

/**
 * press/trailer/cuesheet-final*.json: `teaser` shots take press/teaser/score.wav's own samples (from → from + length,
 * sample-accurate: the welds and the cards stay on their frames); game shots take the game's audio (renderShot); the montage is
 * glued by the game's own score (dark, full intensity) and the designed hand-offs:
 *  - IN: the teaser's last seconds ring on under the first game shot while a pressure swell rolls from the cut into the first
 *    blow (beats.uriFist / the first shot's first event), which lands with a drop;
 *  - the snap (beats.snap): everything drops out, the cable lets go, silence, the debris of two worlds, until the next cut;
 *  - OUT: the last game shot is cut dead (a 0.1 s ring) into the teaser's own near-silence (the hunt).
 * WJ's score only ever gets one uniform gain; the montage is matched to its loud sections; one master gain and the game's
 * true-peak limiter make about −16 LUFS, ≤ −1 dBTP.
 */
export async function renderFinal(raw: unknown, scoreUrl: string): Promise<FinalReport> {
  await loadUriAsset(uriBinUrl);
  const empty: CueSheet = { name: 'mix-final', duration: 0, shots: [], beats: {} };
  const sheet = normaliseSheet(raw, empty);
  const e = ((raw as { beats?: Record<string, number> }).beats ?? {}) as Record<string, number>;
  const N = Math.ceil(SR * sheet.duration);
  const games = sheet.shots.filter((s) => s.source.kind === 'fight');
  const mIn = e.montageIn ?? games[0]?.in ?? 0;
  const mOut = e.montageOut ?? games[games.length - 1]?.out ?? sheet.duration;
  // 1. WJ's score
  const decodeCtx = new OfflineAudioContext(2, SR, SR);
  const score = await decodeCtx.decodeAudioData(await (await fetch(scoreUrl)).arrayBuffer());
  // 2. the game shots
  const shots: TrailerReport['shots'] = [];
  const renders: { shot: CueShot; r: ShotRender }[] = [];
  for (const shot of games) {
    const r = await renderShot(shot, 0.6);
    renders.push({ shot, r });
    shots.push({
      id: shot.id,
      in: shot.in,
      out: shot.out,
      startTick: r.startTick,
      hits: r.hits,
      events: r.events,
    });
  }
  const firstBlow =
    e.uriFist ?? (games[0]?.source as { events?: { at: number }[] } | undefined)?.events?.[0]?.at ?? mIn + 1;
  const after = (t: number): number => games.find((s) => s.in > t + 0.2)?.in ?? mOut;
  // 3. the montage's score: the game's own, dark and full
  const span: CueSheet = { name: 'm', duration: sheet.duration, stage: 'redgiant', shots: [], beats: {} };
  const mscore = await renderScore(span, (t) => (t < mIn ? 0.6 : 1));
  // 4. the mix: teaser bus (0/1) and montage bus (2/3)
  const ctx = new OfflineAudioContext(4, N, SR);
  ctx.destination.channelCountMode = 'explicit';
  ctx.destination.channelInterpretation = 'discrete';
  const merge = ctx.createChannelMerger(4);
  merge.connect(ctx.destination);
  const bus = (ch: number): GainNode => {
    const g = ctx.createGain();
    const sp = ctx.createChannelSplitter(2);
    g.connect(sp);
    sp.connect(merge, 0, ch);
    sp.connect(merge, 1, ch + 1);
    return g;
  };
  const teaserBus = bus(0);
  const montage = bus(2);
  const game = ctx.createGain();
  game.connect(montage);
  for (const shot of sheet.shots) {
    if (shot.source.kind !== 'teaser') continue;
    const from = shot.source.from;
    const len = shot.out - shot.in;
    const next = sheet.shots.find((x) => Math.abs(x.in - shot.out) < 0.01);
    // into the montage the teaser rings on under the first shot (its own reverb, the clench's tail)
    const ring = next && next.source.kind === 'fight' ? 1.2 : 0.012;
    const s = ctx.createBufferSource();
    s.buffer = score;
    const g = ctx.createGain();
    g.gain.setValueAtTime(shot.in === 0 ? 1 : 0, shot.in);
    if (shot.in > 0) g.gain.linearRampToValueAtTime(1, shot.in + 0.008);
    g.gain.setValueAtTime(1, shot.out);
    g.gain.linearRampToValueAtTime(0, shot.out + ring);
    s.connect(g);
    g.connect(teaserBus);
    s.start(shot.in, from, Math.min(len + ring, score.duration - from));
  }
  for (const { shot, r } of renders) {
    const buf = ctx.createBuffer(2, r.left.length, SR);
    buf.copyToChannel(r.left as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(r.right as Float32Array<ArrayBuffer>, 1);
    const s = ctx.createBufferSource();
    s.buffer = buf;
    const g = ctx.createGain();
    const next = sheet.shots.find((x) => Math.abs(x.in - shot.out) < 0.01);
    const ring = !next || next.source.kind !== 'fight' ? 0.1 : 0.25;
    g.gain.setValueAtTime(0, shot.in);
    g.gain.linearRampToValueAtTime(shot.gain ?? 1, shot.in + 0.004);
    g.gain.setValueAtTime(shot.gain ?? 1, shot.out);
    g.gain.linearRampToValueAtTime(0, shot.out + ring);
    s.connect(g);
    g.connect(game);
    s.start(shot.in);
    s.stop(Math.min(sheet.duration, shot.out + ring + 0.05));
  }
  // the montage's score: in under the swell, out for the snap, cut dead with the montage
  const ss = ctx.createBufferSource();
  ss.buffer = mscore;
  const sg = ctx.createGain();
  sg.gain.value = 0;
  sg.gain.setValueAtTime(0, mIn);
  sg.gain.linearRampToValueAtTime(0.35, firstBlow);
  sg.gain.linearRampToValueAtTime(0.6, firstBlow + 2);
  if (e.snap !== undefined && e.snap > mIn && e.snap < mOut) {
    sg.gain.setValueAtTime(0.6, e.snap - 0.08);
    sg.gain.linearRampToValueAtTime(0, e.snap);
    sg.gain.setValueAtTime(0, after(e.snap) - 0.01);
    sg.gain.linearRampToValueAtTime(0.7, after(e.snap));
    game.gain.setValueAtTime(1, e.snap - 0.08);
    game.gain.linearRampToValueAtTime(0, e.snap + 0.02);
    game.gain.setValueAtTime(0, after(e.snap) - 0.01);
    game.gain.linearRampToValueAtTime(1, after(e.snap));
  }
  sg.gain.setValueAtTime(0.7, mOut - 0.02);
  sg.gain.linearRampToValueAtTime(0, mOut);
  ss.connect(sg);
  sg.connect(montage);
  ss.start(0);
  // the designed hand-offs
  const c = designCtx(ctx, montage, 9);
  swell(c, makeOut(c, 0, 0.3), mIn, {
    dur: Math.max(0.3, firstBlow - mIn),
    gain: 0.3,
    f0: 60,
    f1: 900,
    sub: 0.2,
    subHz: 36,
  });
  boom(c, makeOut(c, 0, 0.2), firstBlow, { f0: 96, f1: 30, dur: 1.6, gain: 0.7, drive: 3.4, crunch: 2.4 });
  rumble(c, makeOut(c, 0, 0.8), firstBlow, { dur: 2.5, gain: 0.12, f0: 450, f1: 90 });
  if (e.snap !== undefined && e.snap > mIn && e.snap < mOut) {
    const o = makeOut(c, 0, 0.5);
    filamentSnap(c, o, e.snap, 55, 1, resonance(0.2, 1));
    boom(c, makeOut(c, 0, 0.15), e.snap, { f0: 120, f1: 34, dur: 0.5, gain: 0.5, drive: 3.4 });
    const d = e.snap + 0.85;
    const wide = makeOut(c, 0, 0.8);
    const until = after(e.snap);
    if (until - d > 0.3) {
      crackle(c, wide, d, { dur: until - d + 0.6, count: 24, gain: 0.16, f: 800 });
      gravel(c, wide, d, { dur: until - d + 0.5, grains: 40, f: 420, spread: 2.6, gain: 0.2, lowpass: 1400 });
    }
  }
  // the montage ends on the cut: nothing of it (score, design, tails) passes into the teaser's silence
  montage.gain.setValueAtTime(1, mOut + 0.06);
  montage.gain.linearRampToValueAtTime(0, mOut + 0.1);
  const out = await ctx.startRendering();
  const tL = out.getChannelData(0);
  const tR = out.getChannelData(1);
  const mL = out.getChannelData(2);
  const mR = out.getChannelData(3);
  // 5. loudness: WJ's score gets one gain (true peak under the ceiling); the montage matches its loud sections
  const span2 = (a: Float32Array, from: number, to: number): Float32Array =>
    a.subarray(Math.floor(from * SR), Math.min(a.length, Math.floor(to * SR)));
  const tMeas = measure(tL, tR);
  const scoreDb = Math.min(0, -1.3 - tMeas.truePeak);
  // the reference: the teaser's own loudest sections (its brace and its edge), about 3 s short-term at their peak
  const tSeries = tMeas.momentary.filter((v) => v > -70).sort((a, b) => b - a);
  const teaserLoud = tSeries[Math.floor(tSeries.length * 0.1)] ?? -12;
  const mMeas = measure(span2(mL, mIn, mOut), span2(mR, mIn, mOut));
  const mSeries = mMeas.momentary.filter((v) => v > -70).sort((a, b) => b - a);
  const montageLoud = mSeries[Math.floor(mSeries.length * 0.1)] ?? mMeas.integrated;
  const montageDb = teaserLoud + scoreDb - montageLoud;
  const L = new Float32Array(N);
  const R = new Float32Array(N);
  const gs = lin(scoreDb);
  const gm = lin(montageDb);
  for (let i = 0; i < N; i++) {
    L[i] = tL[i]! * gs + mL[i]! * gm;
    R[i] = tR[i]! * gs + mR[i]! * gm;
  }
  const fade = Math.floor(SR * 0.6);
  for (let i = N - fade; i < N; i++) {
    const k = Math.max(0, Math.min(1, (N - 0.2 * SR - i) / (0.4 * SR)));
    L[i] = L[i]! * k;
    R[i] = R[i]! * k;
  }
  const pre = measure(L, R).integrated;
  const mm = master(L, R);
  const masterDb = TARGET_LUFS - pre;
  const m = measure(mm.l, mm.r);
  let endSilence = 0;
  for (let i = N - 1; i >= 0 && Math.max(Math.abs(mm.l[i]!), Math.abs(mm.r[i]!)) < 0.001; i--) endSilence++;
  const tm = (a: number, b2: number): number => measure(span2(mm.l, a, b2), span2(mm.r, a, b2)).integrated;
  const teaserParts = sheet.shots.filter((s) => s.source.kind === 'teaser');
  return {
    name: sheet.name,
    duration: sheet.duration,
    integrated: +m.integrated.toFixed(1),
    truePeak: +m.truePeak.toFixed(2),
    range: +m.range.toFixed(1),
    limiterDb: +mm.gr.toFixed(1),
    momentary: m.momentary,
    endSilence: +(endSilence / SR).toFixed(2),
    shots,
    wav: toWav(mm.l, mm.r),
    gains: { score: +scoreDb.toFixed(1), montage: +montageDb.toFixed(1), master: +masterDb.toFixed(1) },
    montageLufs: +tm(mIn, mOut).toFixed(1),
    teaserLufs: +(teaserParts.length ? tm(teaserParts[0]!.in, teaserParts[0]!.out) : -70).toFixed(1),
  };
}
