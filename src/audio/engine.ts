import {
  Rng,
  type AudioEngine,
  type AudioEvent,
  type AudioFighterScene,
  type AudioScene,
  type AudioVolumes,
  type SimEvent,
  type StageId,
  type TitanId,
} from '@/contracts';
import { generateImpulseResponse } from './dsp/ir';
import { clamp, clamp01, dbToGain, hardClipCurve, limiterCurve, volumeCurve } from './dsp/math';
import { designTruePeakFir } from '@/telemetry/loudness';
import {
  LIMITER_CEILING,
  LIMITER_LOOKAHEAD,
  LIMITER_PROCESSOR,
  LIMITER_RELEASE,
  limiterWorkletSource,
  type LimiterReport,
} from './worklets/limiter';
import { ScoreEngine } from './score/engine';
import { presentationEnergy } from './balance';
import {
  magnitude,
  playCueGeneric,
  playGuard,
  playImpact,
  playKo,
  playMatter,
  playShockwave,
  playTypeLayer,
  playUltimate,
} from './voices/sfx';
import { BELL, makeOut, noiseHit, tone } from './voices/synth';
import { boom, lowBell, swell, whoosh } from './voices/epic';
import type { TitanVoice, VoiceCtx } from './voices/types';
import { createTitanVoice } from './voices/index';
import { UI_TRIM, playUi } from './voices/ui';
import { cometEnter, cometWarn } from './voices/materials';

/** Length of the arena comet's warning riser (the Shearfield's CometSchedule.warn is 90 ticks = 1.5 s). */
const COMET_WARN_SEC = 1.5;

/** Time between an event reaching `handle()` and its first sample: schedules a little ahead so start times are exact. */
const LOOKAHEAD = 0.006;
/**
 * Level trims for the sounds that must READ over the ambience and score. Voices are authored at their natural relative
 * levels (a whoosh is quieter than a boom); measured on the OfflineAudioContext harness, the tells and menu blips came out
 * 15-25 dB under the fighters' own idle bed, i.e. inaudible in a match. Trimming per class keeps the voices readable as
 * code and puts the mix decisions in one table.
 */
export const MOVE_TRIM: Readonly<Record<string, number>> = {
  strike: 3,
  crush: 1.8,
  signature: 2,
  surge: 3,
  ultimate: 1.4,
  guard: 2,
};
export const SURGE_TRIM = 3;
/**
 * Per-titan cue trims. D34: the Witness's and the Asteroid's cues were small pings authored quietly (trim 3); they are booms and
 * cable snaps now, authored at full level like everyone else's, so no titan needs one.
 */
export const CUE_TRIM: Readonly<Partial<Record<TitanId, number>>> = {};

/** Concurrent one-shot cap (events, not nodes). Above it, low-priority sounds are dropped. */
const POLYPHONY = 28;
/** The cap on blows (prio 1) while the audio thread is behind real time; everything of prio 0 is dropped then. */
const OVERLOAD_POLYPHONY = 6;
/** Low-priority sounds (prio 0: cues, moves, matter) accepted from one `handle()` batch. */
const BATCH_LOW = 10;
/**
 * The load governor (`watchLoad`): the audio clock is compared with the wall clock over windows of at least LOAD_WINDOW_SEC; below
 * OVERLOAD_RATIO of real time the render thread is not keeping up (the output underruns: silence) and new sounds are shed for
 * OVERLOAD_HOLD_MS after the last bad window.
 */
const LOAD_WINDOW_SEC = 0.5;
const OVERLOAD_RATIO = 0.85;
const OVERLOAD_HOLD_MS = 1500;

/* ---- D6 mix constants (calibrated with tools/ui/audio-verify.ts --round: −20 LUFS integrated, ≤ −1 dBTP at default faders) ---- */
/** Output high-pass (Hz, 24 dB/oct): laptop speakers cannot play below it, so it would only eat limiter headroom (D27). */
export const OUTPUT_HIGHPASS_HZ = 50;
/**
 * Gain before the limiter (default faders). Phase 2 re-stage: the live orbit capture read −27 LUFS against −21.3 offline, so the
 * mix went up +3 dB here and the bed +2 dB (BED_LEVEL_DB): offline orbit −17.9 LUFS, the live one should land ≈ −24..−23.
 * (That −27 was the aftermath freeze, not the mix.) Gate C: with the D30 rebalance a fight carries ~3.5 heavy hits per round
 * and the live 3-minute fights read −16.4 / −15.2 LUFS, so the mix came down 3.5 dB (Lead). That alone moved the level 1.5 dB:
 * a repeated Planet cue (ring-capture, ~12 bells a second) made the loudest seconds of the fight and sat on the limiter.
 * With CUE_REPEAT and balance-free impact energy: offline orbit fight −20.4 LUFS, LRA 17.5, limiter idle 98.8 %.
 * D34 (the cataclysm pass): impacts carry far more weight than before (saturated drops, crunch, cavern tails), so the mix came
 * down to keep −20 LUFS integrated (measured over seven titan pairs, `tools/ui/audio-verify.ts --pairs`).
 */
export const CALIBRATION_DB = -1.6;
/**
 * Menu / UI sounds sit this far under the calibrated impacts (they were authored against the old, quieter master). D34: −9 → −6,
 * so the menu keeps its level when the calibration came down 3 dB under the heavier impacts.
 */
const UI_LEVEL_DB = -6;
/** Reverb returns: the impacts' space and the bed's. */
const IMPACT_REVERB = 0.75;
const BED_REVERB = 0.3;
/** Gentle bed glue: compresses only the loudest bed moments, 2:1, slow (the impacts never pass through it). */
export const BED_GLUE = { threshold: -18, knee: 10, ratio: 2, attack: 0.03, release: 0.35 } as const;
/** The score at neutral sits this many dB under its full, committed level. */
export const SCORE_NEUTRAL_DB = 8;
/** The whole bed sits this far under the impacts (dB): the floor a blow rises from. */
export const BED_LEVEL_DB = -3.5;
/**
 * Bed duck under heavy blows: gain depth (dB) and time held (s) from the lightest to the heaviest qualifying event. Telemetry
 * reads the duck through 400 ms momentary loudness. Phase 2: the live meter read the old 6.5–10 dB gains as a 12 dB median dip, so
 * they were halved toward 4–6.5 dB (offline orbit: 5.3 dB median, 300 ms).
 */
export const DUCK_DB: readonly [number, number] = [4, 6.5];
export const DUCK_SEC: readonly [number, number] = [0.35, 0.55];
/**
 * The KO hush (D34: "a hush, then a catastrophic boom and a long cosmic decay"): the whole bed (titan beds, score, its reverb)
 * falls this far (dB) and stays down this long (s), so the KO's boom lands into near-silence and its decay is heard alone.
 */
export const KO_HUSH_DB = 14;
export const KO_HUSH_SEC = 1.6;
/**
 * Laptop weight (D27, D34): a psychoacoustic bass stage on the whole mix. The band under WEIGHT.split Hz (4th order) goes through
 * a RECTIFYING saturator (`weightCurve`: even, so it passes no fundamental at all, only the 2nd, 4th… harmonics, in proportion to
 * the sub's own level); the harmonics between WEIGHT.lo and WEIGHT.hi are added back at WEIGHT.level. A 40 Hz drop a laptop
 * cannot play arrives with 80/160/240 Hz partials it can, and the ear hears the missing fundamental. Headphones keep the real sub.
 */
export const WEIGHT = { split: 100, drive: 3, lo: 120, hi: 800, level: 0.7 } as const;

/**
 * The laptop voicing of the whole mix (D27, D34), after the weight stage: a low shelf takes a little of the sub a laptop cannot
 * play anyway (headphones keep most of it), and a broad bump around 450 Hz lifts the band a small speaker DOES play — the
 * growl of every drop, the crunch, the rumble's upper edge. Measured with the laptop-speaker meter (dev/ui/audio-laptop.ts).
 */
export const LAPTOP_EQ = { shelfHz: 110, shelfDb: -5, bodyHz: 500, bodyDb: 7, bodyQ: 0.7 } as const;

/**
 * Wire `from` → `to` through the laptop voicing (LAPTOP_EQ), and add the weight stage (WEIGHT) of `weightFrom` (default `from`)
 * in parallel. The engine weights the IMPACT bus only: the rectifier's harmonics of a single drop are octaves of it, but on a
 * chord (the score's drone and pad, a titan's choir) it would add sum and difference tones out of the stage's key. Exported so
 * the verification tools measure sounds through exactly what the engine does to them.
 */
export function laptopVoicing(
  ac: BaseAudioContext,
  from: AudioNode,
  to: AudioNode,
  weightFrom: AudioNode = from,
): void {
  const shelf = ac.createBiquadFilter();
  shelf.type = 'lowshelf';
  shelf.frequency.value = LAPTOP_EQ.shelfHz;
  shelf.gain.value = LAPTOP_EQ.shelfDb;
  const body = ac.createBiquadFilter();
  body.type = 'peaking';
  body.frequency.value = LAPTOP_EQ.bodyHz;
  body.Q.value = LAPTOP_EQ.bodyQ;
  body.gain.value = LAPTOP_EQ.bodyDb;
  from.connect(shelf);
  shelf.connect(body);
  body.connect(to);
  // the weight: the sub band (4th order), rectified, its harmonics (4th order above WEIGHT.lo: a 2nd harmonic under ~120 Hz is
  // as lost on a laptop as the fundamental) added back
  const split = ac.createBiquadFilter();
  const split2 = ac.createBiquadFilter();
  split.type = split2.type = 'lowpass';
  split.frequency.value = split2.frequency.value = WEIGHT.split;
  split.Q.value = 0.5412;
  split2.Q.value = 1.3066;
  const shape = ac.createWaveShaper();
  shape.curve = weightCurve(WEIGHT.drive) as Float32Array<ArrayBuffer>;
  const lo = ac.createBiquadFilter();
  const lo2 = ac.createBiquadFilter();
  lo.type = lo2.type = 'highpass';
  lo.frequency.value = lo2.frequency.value = WEIGHT.lo;
  lo.Q.value = 0.5412;
  lo2.Q.value = 1.3066;
  const hi = ac.createBiquadFilter();
  hi.type = 'lowpass';
  hi.frequency.value = WEIGHT.hi;
  hi.Q.value = Math.SQRT1_2;
  const level = ac.createGain();
  level.gain.value = WEIGHT.level;
  weightFrom.connect(split);
  split.connect(split2);
  split2.connect(shape);
  shape.connect(lo);
  lo.connect(lo2);
  lo2.connect(hi);
  hi.connect(level);
  level.connect(to);
}

/** The weight stage's transfer curve: |tanh(drive·x)| / tanh(drive), an even function (harmonics only, never the input itself). */
export function weightCurve(drive: number, n = 2049): Float32Array {
  const out = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) out[i] = Math.abs(Math.tanh(drive * ((i / (n - 1)) * 2 - 1))) / norm;
  return out;
}
/** Smallest blow that ducks the bed (the same line telemetry draws for a heavy hit). */
export const DUCK_MIN_ENERGY = 400;
/** The sim's heavy line (combat/fighter.ts: a blow of energy ≥ 700 is heavy whatever its slot). */
const HEAVY_BLOW = 700;
/** Shortest gap (s) between two sounds of the same cue from the same fighter (the sim may repeat a cue every tick). */
const CUE_REPEAT = 0.3;
/** Shortest gap (s) between two matter sounds of the same kind from the same fighter. */
export const MATTER_REPEAT = 0.15;
/** Shortest gap (s) between two LIGHT blows (presentation energy under DUCK_MIN_ENERGY) from the same attacker. */
export const LIGHT_HIT_REPEAT = 0.2;

/**
 * The automatic makeup gain (dB) a DynamicsCompressorNode applies (WebAudio spec: (1 / gain at 0 dBFS)^0.6). Approximates the
 * knee as the midpoint of its span, which is within a few tenths of a dB of Chromium for these settings.
 */
export function compressorMakeupDb(c: { threshold: number; knee: number; ratio: number }): number {
  const kneeEnd = c.threshold + c.knee;
  // output level for a 0 dBFS input: the linear segment to the threshold, half-slope through the knee, 1/ratio above it
  const atKneeEnd = c.threshold + c.knee * (0.5 + 0.5 / c.ratio);
  const out0 =
    kneeEnd >= 0
      ? c.threshold + (0 - c.threshold) * (0.5 + 0.5 / c.ratio)
      : atKneeEnd + (0 - kneeEnd) / c.ratio;
  return -out0 * 0.6;
}

/** A finite number, or `fallback`. */
const fin = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

/** Event fields the contract defines as 0..1 (some voices scale a duration or a gain by them unclamped). */
const UNIT_FIELDS: ReadonlySet<string> = new Set(['blocked', 'power', 'frac', 'strength', 'onDamaged']);

/**
 * `ev` with every non-finite number replaced (positions by the listener's x, everything else by 0) and the 0..1 fields clamped,
 * or `ev` itself when it is clean (the common case: no copy). The sim can hand over a NaN (a centroid of nothing, 0/0) or an
 * Infinity; a voice would throw on it half-way through a sound (an AudioParam rejects non-finite values), leaving whatever it
 * had started alone. An out-of-range 0..1 field did worse (found by the stress test): the generic release whoosh lasted
 * `0.2 + 0.1 × power` seconds, so a power of 1e9 left a noise source scheduled for three years.
 */
export function sanitizeEvent<T extends object>(ev: T, listenerX: number): T {
  let out: Record<string, unknown> | null = null;
  for (const k in ev) {
    const v = (ev as Record<string, unknown>)[k];
    if (typeof v !== 'number') continue;
    let w = v;
    if (!Number.isFinite(v)) w = k === 'x' ? listenerX : 0;
    else if (UNIT_FIELDS.has(k)) w = clamp01(v);
    if (w !== v) {
      out ??= { ...(ev as Record<string, unknown>) };
      out[k] = w;
    }
  }
  return (out ?? ev) as T;
}

/** `s` with every number finite and in its contract range (a copy only when something had to change). */
export function sanitizeScene(s: AudioScene): AudioScene {
  const ok = (v: number): boolean => Number.isFinite(v);
  const clean =
    ok(s.intensity) &&
    ok(s.listenerX) &&
    ok(s.lowestIntegrity) &&
    ok(s.timeScale) &&
    (s.fighters ?? []).every(
      (f) => ok(f.x) && ok(f.speed) && ok(f.massFrac) && ok(f.charge) && ok(f.resource) && ok(f.meter),
    );
  if (clean) return s;
  const lx = fin(s.listenerX);
  const f = (a: AudioFighterScene): AudioFighterScene => ({
    ...a,
    x: fin(a.x, lx),
    speed: fin(a.speed),
    massFrac: fin(a.massFrac, 1),
    charge: fin(a.charge),
    resource: fin(a.resource),
    meter: fin(a.meter),
  });
  return {
    ...s,
    intensity: fin(s.intensity),
    listenerX: lx,
    lowestIntegrity: fin(s.lowestIntegrity, 1),
    timeScale: fin(s.timeScale, 1),
    fighters: s.fighters ? [f(s.fighters[0]), f(s.fighters[1])] : s.fighters,
  };
}

/** Dev-only log (the guard's recoveries): silent in production builds and in plain Node. */
function devLog(...a: unknown[]): void {
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) console.warn('[audio]', ...a);
}

/**
 * The guard (see `Engine.watch`): how many consecutive meter reads of a dead output (the mix carries signal, the output is
 * silent) before the engine rebuilds its graph, and the shortest time (ms, wall clock) between two rebuilds.
 */
const DEAD_READS = 45;
const RECOVER_GAP_MS = 1500;

const workletReady = new WeakMap<BaseAudioContext, Promise<boolean>>();
/** Load the limiter AudioWorklet module once per context. Resolves false where AudioWorklet is unavailable. */
function loadLimiter(ac: BaseAudioContext): Promise<boolean> {
  let p = workletReady.get(ac);
  if (!p) {
    const aw = (ac as { audioWorklet?: AudioWorklet }).audioWorklet;
    if (!aw || typeof AudioWorkletNode === 'undefined' || typeof Blob === 'undefined')
      p = Promise.resolve(false);
    else {
      const url = URL.createObjectURL(new Blob([limiterWorkletSource()], { type: 'text/javascript' }));
      p = aw
        .addModule(url)
        .then(() => true)
        .catch(() => false)
        .finally(() => URL.revokeObjectURL(url));
    }
    workletReady.set(ac, p);
  }
  return p;
}
export interface AudioEngineOptions {
  /** Use this context instead of creating one on `unlock()` (OfflineAudioContext for verification). */
  context?: BaseAudioContext;
  /** Seed for the deterministic variation stream and the generative score. */
  seed?: number;
  /**
   * TEST ONLY: skip the true-peak limiter and the safety clip (the calibrated mix goes straight out). Lets the verification page
   * measure what enters the limiter and prove it does real work (the same event storm without it must exceed full scale).
   * Never set in the shipped app.
   */
  unsafeBypassLimiter?: boolean;
  /**
   * Run the load governor (shed new sounds while the audio clock falls behind the wall clock). Default: on for a real-time
   * `AudioContext`, off for an OfflineAudioContext (it renders as fast as it can) and for test fakes.
   */
  governor?: boolean;
  /** Wall clock in ms (default `performance.now`): tests drive the governor with it. */
  wallClock?: () => number;
}

/** Diagnostics and offline hooks on top of the contract `AudioEngine`. */
export interface AudioEngineExt extends AudioEngine {
  readonly context: BaseAudioContext | null;
  /** Fire events as if `when` (context time, s) were "now": for offline rendering and tests. */
  handleAt(events: readonly AudioEvent[], when: number): void;
  /** Advance continuous voices and pre-schedule the score up to `horizon` seconds of context time. */
  updateAt(scene: AudioScene, dtSec: number, horizon: number): void;
  /** Reported output latency (base + output) in ms, if the browser exposes it. */
  latencyMs(): number;
  /** Resume the context on the next user gesture of any kind (click, key, touch, pointer, gamepad activity). */
  autoUnlock(target: EventTarget): () => void;
  readonly volumes: Readonly<AudioVolumes>;
  /**
   * Measurement taps (telemetry / recording; never in the signal path): `output` is exactly what reaches the speakers,
   * `music` the whole BED bus after its duck (titan beds + score + bed reverb), `sfx` the impact bus. Null until the graph exists.
   */
  taps(): { output: AudioNode; music: AudioNode; sfx: AudioNode } | null;
  /** Deepest true-peak limiter gain reduction (dB) since the last call (diagnostics). */
  limiterReductionDb(): number;
  /** How many times the guard rebuilt the graph after finding the output poisoned (NaN) or dead (diagnostics). */
  readonly recoveryCount: number;
  /** The audio clock's speed over the last load window, 1 = real time (diagnostics; 1 when the governor is off). */
  readonly renderSpeed: number;
}

/** The IR is deterministic per (sample rate, seed) and takes a noticeable moment to synthesise: build it once. */
const irCache = new Map<string, ReturnType<typeof generateImpulseResponse>>();
function cachedImpulseResponse(sr: number, seed: number): ReturnType<typeof generateImpulseResponse> {
  const key = `${sr}:${seed}`;
  let ir = irCache.get(key);
  if (!ir) {
    // a cavern, not a hall (D34): longer, and dark from its first reflections (brightStart 0.55 → 0.3)
    ir = generateImpulseResponse(sr, { decay: 4.2, seed, brightStart: 0.3, brightEnd: 0.025 });
    if (irCache.size > 4) irCache.clear();
    irCache.set(key, ir);
  }
  return ir;
}

export function createAudioEngine(opts: AudioEngineOptions = {}): AudioEngineExt {
  return new Engine(opts);
}

interface Graph {
  ac: BaseAudioContext;
  /** The IMPACT bus (one-shot voices, after the sfx fader) and its reverb send. */
  sfx: GainNode;
  sfxSend: GainNode;
  /** The music fader (inside the bed) and the score's reverb send. */
  music: GainNode;
  musicSend: GainNode;
  master: GainNode;
  /** The last node before `ac.destination`. */
  out: AudioNode;
  preAn: AnalyserNode;
  postAn: AnalyserNode;
  /** UI sounds (sfx fader). */
  ui: GainNode;
  /** The titans' continuous beds (sfx fader), into the bed bus. */
  bedSfx: GainNode;
  /** The bed's duck: the WHOLE bed (beds + score + its reverb) after the glue. */
  duck: GainNode;
  /** The score's swell gain (thin at neutral, full on commitment), before the music fader. */
  scoreIn: GainNode;
  /** The worklet limiter, if in use (a rebuild stops listening to the old one's reports). */
  limiter: AudioWorkletNode | null;
  /**
   * The bus-level nodes a rebuild disconnects: every way into the old graph's stateful filters and out of it (to the speakers and
   * to the analysers, which Chromium pulls even when nothing else does).
   */
  teardown: AudioNode[];
}

class Engine implements AudioEngineExt {
  private ac: BaseAudioContext | null;
  private g: Graph | null = null;
  private sfxCtx: VoiceCtx | null = null;
  private uiCtx: VoiceCtx | null = null;
  private bedCtx: VoiceCtx | null = null;
  private musicCtx: VoiceCtx | null = null;
  private building: Promise<void> | null = null;
  /** Smallest limiter gain reported since the last limiterReductionDb() (1 = untouched). */
  private limiterMinGain = 1;
  private duckDepth = 0;
  /** The score's commitment drive 0..1 (smoothed): neutral = thin, committed = full. */
  private commit = 0;
  private score: ScoreEngine | null = null;
  private readonly seed: number;
  private readonly voices = new Map<TitanId, TitanVoice>();
  private readonly ends: number[] = [];
  private scene: AudioScene | null = null;
  private slotTitan: [TitanId | null, TitanId | null] = [null, null];
  /** The app's settings defaults (8 / 7 / 8 of 10), so offline verification measures what the player hears. */
  private vol: AudioVolumes = { master: 0.8, music: 0.7, sfx: 0.8 };
  private timeScale = 1;
  private now = 0;
  private preBuf: Float32Array | null = null;
  private postBuf: Float32Array | null = null;
  private peakPre = 0;
  private peakPost = 0;
  private resumeAt = 0;
  private duckUntil = 0;
  /** When each (slot, cue id) last sounded. */
  private readonly cueAt = new Map<string, number>();
  private readonly bypass: boolean;
  private readonly trims = new Map<number, VoiceCtx>();
  /* the guard (`watch`, `recover`) */
  /** The limiter module loaded on this context (AudioWorklet available). */
  private worklet = false;
  /** The worklet limiter threw once: rebuild with the WaveShaper limiter from then on. */
  private workletBroken = false;
  /** Consecutive meter reads with signal in the mix and none at the output. */
  private deadReads = 0;
  /** No rebuild before this wall-clock time (ms). */
  private recoverAt = 0;
  private recoveries = 0;
  /** Voice exceptions seen (only the first few are logged). */
  private thrown = 0;
  /* the load governor (`watchLoad`) */
  private readonly governorOpt: boolean | undefined;
  private readonly wall: () => number;
  private loadWall = -1;
  private loadAudio = 0;
  private speed = 1;
  private overloadUntil = -1;
  /** Prio-0 sounds accepted in the current `handleAt` batch. */
  private batchLow = 0;

  constructor(o: AudioEngineOptions) {
    this.ac = o.context ?? null;
    this.seed = o.seed ?? 7;
    this.bypass = !!o.unsafeBypassLimiter;
    this.governorOpt = o.governor;
    this.wall =
      o.wallClock ?? ((): number => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    // The reverb IR (≈ 40–50 ms of JS at 48 kHz) needs no AudioContext: synthesise it in idle time now, so the unlock (the first
    // user gesture, which may land during a fight) only pays for the context and the graph.
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (!o.context && idle) idle(() => void cachedImpulseResponse(48000, this.seed), { timeout: 4000 });
  }

  get ready(): boolean {
    return this.g !== null && this.ac !== null && this.ac.state === 'running';
  }

  get context(): BaseAudioContext | null {
    return this.ac;
  }

  get volumes(): Readonly<AudioVolumes> {
    return this.vol;
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  context + graph
   * ------------------------------------------------------------------------------------------------ */
  async unlock(): Promise<void> {
    try {
      if (!this.ac) {
        const Ctor: typeof AudioContext | undefined =
          typeof AudioContext !== 'undefined'
            ? AudioContext
            : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ac = new Ctor({ latencyHint: 'interactive' });
      }
      if (!this.g) {
        const ac = this.ac;
        this.building ??= loadLimiter(ac).then((ok) => {
          if (!this.g && this.ac === ac) this.build(ac, ok);
        });
        await this.building;
      }
      if (this.ac.state === 'suspended' && 'resume' in this.ac) await (this.ac as AudioContext).resume();
    } catch {
      /* no WebAudio (or blocked): the game stays silent but playable */
    }
  }

  autoUnlock(target: EventTarget): () => void {
    const fn = (): void => void this.unlock();
    const types = ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'click'];
    for (const t of types) target.addEventListener(t, fn, { passive: true });
    return () => {
      for (const t of types) target.removeEventListener(t, fn);
    };
  }

  private build(ac: BaseAudioContext, worklet: boolean): void {
    const sr = ac.sampleRate;
    /*
     * Signal path (D6, tuned for LAPTOP SPEAKERS — D27):
     *
     *   impact voices ─► IMPACT bus (sfx fader) ─────────────────────────────────────────────┐
     *       └ sends ─► space reverb ─► return ──────────────────────────────────────────────┤
     *   ui sounds ─► UI bus (sfx fader) ─────────────────────────────────────────────────────┤
     *   titan beds ─► (sfx fader) ┐                                                         ├► mix ─► HP 50 Hz (24 dB/oct)
     *   score ─► (music fader) ───┼► BED bus ─► gentle glue ─► DUCK ──────────────────────────┘     ─► calibration gain
     *   bed sends ─► bed reverb ──┘                                                                 ─► MASTER
     *                                                                                               ─► TRUE-PEAK LIMITER ─► safety clip
     *
     * Impacts never pass through a compressor: their level above the bed is what the player hears as weight. Only the bed
     * is glued (gently) and ducked 4–8 dB for 300–600 ms under heavy blows. The output's sub-bass is high-passed (laptop
     * speakers cannot play it, it only eats headroom); weight is carried by the 80–250 Hz knock (`thump`). The limiter is a
     * lookahead true-peak brick wall at −1 dBTP (AudioWorklet), the LAST gain stage: the master fader sits before it, so the
     * fader is a plain linear scale for everything under the ceiling and nothing can ever pass the ceiling (with a fader after
     * the limiter, the default 8/10 would cap every peak at −5 dBTP and squeeze the round's range).
     */
    const mix = ac.createGain();
    const hp1 = ac.createBiquadFilter();
    const hp2 = ac.createBiquadFilter();
    hp1.type = hp2.type = 'highpass';
    hp1.frequency.value = hp2.frequency.value = OUTPUT_HIGHPASS_HZ;
    // two cascaded 2nd-order sections = a 4th-order Butterworth
    hp1.Q.value = 0.5412;
    hp2.Q.value = 1.3066;
    const calib = ac.createGain();
    calib.gain.value = dbToGain(CALIBRATION_DB);
    const master = ac.createGain();
    master.gain.value = volumeCurve(this.vol.master);
    const clip = ac.createWaveShaper();
    clip.curve = hardClipCurve(2049, LIMITER_CEILING) as Float32Array<ArrayBuffer>;
    const preAn = ac.createAnalyser();
    preAn.fftSize = 2048;
    const postAn = ac.createAnalyser();
    postAn.fftSize = 2048;
    mix.connect(preAn);
    // (the laptop voicing and weight, LAPTOP_EQ and WEIGHT, sit between `mix` and the output high-pass: wired below, once the
    // impact bus exists)
    hp1.connect(hp2);
    // unsafeBypassLimiter (tests only) measures the mix as it ENTERS the limiter (calibrated), with no limiter and no clip
    hp2.connect(calib);
    let limiter: AudioNode;
    let workletNode: AudioWorkletNode | null = null;
    this.worklet = worklet;
    if (this.bypass) {
      limiter = ac.createGain();
    } else if (worklet && !this.workletBroken) {
      const node = new AudioWorkletNode(ac, LIMITER_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: {
          channels: 2,
          lookahead: LIMITER_LOOKAHEAD,
          ceiling: LIMITER_CEILING,
          release: LIMITER_RELEASE,
          phases: designTruePeakFir().map((p) => Array.from(p)),
        },
      });
      node.port.onmessage = (e: MessageEvent<LimiterReport>): void => {
        const r = e.data;
        if (r.minGain < this.limiterMinGain) this.limiterMinGain = r.minGain;
        // the limiter silenced non-finite samples: something upstream blew up (a poisoned filter stays NaN for good)
        if (r.bad > 0) this.recover(`limiter saw ${r.bad} non-finite samples`);
      };
      // a worklet that throws outputs silence for the rest of the context's life: fall back to the WaveShaper limiter
      node.onprocessorerror = (): void => {
        this.workletBroken = true;
        this.recover('limiter worklet error');
      };
      limiter = workletNode = node;
    } else {
      // no AudioWorklet (unit tests' fake context, very old browsers): a 4× oversampled soft clip to the same ceiling
      const soft = ac.createWaveShaper();
      soft.curve = limiterCurve(4097, 0.6, LIMITER_CEILING) as Float32Array<ArrayBuffer>;
      soft.oversample = '4x';
      limiter = soft;
    }
    calib.connect(master);
    master.connect(limiter);
    if (this.bypass) {
      limiter.connect(postAn);
      limiter.connect(ac.destination);
    } else {
      limiter.connect(clip);
      clip.connect(postAn);
      clip.connect(ac.destination);
    }

    // reverbs: one long dark IR shared by two convolvers — the impacts' space (not ducked: tails are the weight) and the bed's
    // own (ducked with it). Both sends are high-passed so the deep sub never muddies a tail (but the 90–250 Hz weight does reach
    // the cavern), and low-passed so no tail ever hisses.
    const ir = cachedImpulseResponse(sr, this.seed);
    const buf = ac.createBuffer(2, ir[0].length, sr);
    buf.copyToChannel(ir[0] as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(ir[1] as Float32Array<ArrayBuffer>, 1);
    const reverb = (ret: number, into: AudioNode): GainNode => {
      const send = ac.createGain();
      const hp = ac.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 90;
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3200;
      lp.Q.value = 0.5;
      const conv = ac.createConvolver();
      conv.normalize = false;
      conv.buffer = buf;
      const out = ac.createGain();
      out.gain.value = ret;
      send.connect(hp);
      hp.connect(lp);
      lp.connect(conv);
      conv.connect(out);
      out.connect(into);
      return send;
    };

    // impacts
    const sfx = ac.createGain();
    sfx.gain.value = volumeCurve(this.vol.sfx);
    sfx.connect(mix);
    laptopVoicing(ac, mix, hp1, sfx);
    const sfxWet = reverb(IMPACT_REVERB, mix);
    // ui
    const ui = ac.createGain();
    ui.gain.value = volumeCurve(this.vol.sfx);
    const uiLevel = ac.createGain();
    uiLevel.gain.value = dbToGain(UI_LEVEL_DB);
    ui.connect(uiLevel);
    uiLevel.connect(mix);
    const uiWet = ac.createGain();
    uiWet.connect(sfxWet);
    // bed: titan beds + score + the bed's reverb → glue → duck
    const bedIn = ac.createGain();
    bedIn.gain.value = dbToGain(BED_LEVEL_DB);
    const glue = ac.createDynamicsCompressor();
    glue.threshold.value = BED_GLUE.threshold;
    glue.knee.value = BED_GLUE.knee;
    glue.ratio.value = BED_GLUE.ratio;
    glue.attack.value = BED_GLUE.attack;
    glue.release.value = BED_GLUE.release;
    // the compressor adds automatic makeup gain (WebAudio spec); take it back so the glue only ever shapes, never lifts
    const glueTrim = ac.createGain();
    glueTrim.gain.value = dbToGain(-compressorMakeupDb(BED_GLUE));
    const duck = ac.createGain();
    bedIn.connect(glue);
    glue.connect(glueTrim);
    glueTrim.connect(duck);
    duck.connect(mix);
    const bedWet = reverb(BED_REVERB, bedIn);
    const bedSfx = ac.createGain();
    bedSfx.gain.value = volumeCurve(this.vol.sfx);
    bedSfx.connect(bedIn);
    const music = ac.createGain();
    music.gain.value = volumeCurve(this.vol.music);
    music.connect(bedIn);
    const musicWet = ac.createGain();
    musicWet.gain.value = 0.7;
    musicWet.connect(bedWet);
    // the score's own swell (thin at neutral, full on commitment) sits before the music fader
    const scoreIn = ac.createGain();
    scoreIn.gain.value = dbToGain(-SCORE_NEUTRAL_DB);
    scoreIn.connect(music);

    this.g = {
      ac,
      sfx,
      sfxSend: sfxWet,
      music,
      musicSend: musicWet,
      master,
      out: this.bypass ? limiter : clip,
      preAn,
      postAn,
      ui,
      bedSfx,
      duck,
      scoreIn,
      limiter: workletNode,
      teardown: [
        sfx,
        sfxWet,
        ui,
        uiLevel,
        uiWet,
        bedSfx,
        bedIn,
        music,
        musicWet,
        scoreIn,
        duck,
        mix,
        hp2,
        calib,
        master,
        limiter,
        clip,
        preAn,
        postAn,
      ],
    };

    // shared noise (white + brown), generated deterministically
    const N = sr * 2;
    const white = ac.createBuffer(1, N, sr);
    const brown = ac.createBuffer(1, N, sr);
    const w = white.getChannelData(0);
    const b = brown.getChannelData(0);
    const nr = new Rng(this.seed * 977 + 3);
    let last = 0;
    for (let i = 0; i < N; i++) {
      const x = nr.next() * 2 - 1;
      w[i] = x;
      last = (last + 0.02 * x) / 1.02;
      b[i] = last * 3.5;
    }
    const voiceRng = new Rng(this.seed * 131 + 9);
    const base = { ac, noise: white, brown, rand: (): number => voiceRng.next() };
    const pan = (x: number): number => this.panOf(x);
    const timeScale = (): number => this.timeScale;
    const ctx = (dry: AudioNode, wet: AudioNode, gated: boolean): VoiceCtx => ({
      ...base,
      dry,
      wet,
      panOf: pan,
      take: gated ? (prio: number): boolean => this.take(prio) : (): boolean => true,
      release: (): void => undefined,
      get timeScale(): number {
        return timeScale();
      },
    });
    this.sfxCtx = ctx(sfx, sfxWet, true);
    this.uiCtx = ctx(ui, uiWet, true);
    this.bedCtx = ctx(bedSfx, bedWet, true);
    this.musicCtx = ctx(scoreIn, musicWet, false);
    this.score = new ScoreEngine(ac, scoreIn, this.musicCtx, this.seed);
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  helpers
   * ------------------------------------------------------------------------------------------------ */
  private panOf(x: number): number {
    const d = (x - (this.scene?.listenerX ?? 0)) / 520;
    return Number.isFinite(d) ? clamp(d, -1, 1) * 0.85 : 0;
  }

  /** Polyphony gate: drop low-priority sounds when too many are still sounding. */
  private take(prio: number): boolean {
    const t = this.now;
    for (let i = this.ends.length - 1; i >= 0; i--) if (this.ends[i]! < t) this.ends.splice(i, 1);
    // the audio thread is behind real time (`watchLoad`): every new sound makes it worse, and a late audio thread is silence.
    // Only the critical sounds (KO, ultimate, rounds: prio 2) and a trickle of blows get in until it has caught up
    if (this.isOverloaded() && (prio < 1 || (prio < 2 && this.ends.length >= OVERLOAD_POLYPHONY)))
      return false;
    // one frame's batch (an ultimate lands with its cues, matter and moves at once) gets a bounded share of the low-priority
    // sounds: the burst is built in one go, before the governor could see the audio thread fall behind
    if (prio < 1 && this.batchLow >= BATCH_LOW) return false;
    if (this.ends.length >= POLYPHONY && prio < 2) return false;
    if (prio < 1) this.batchLow++;
    if (this.ends.length >= POLYPHONY * 2) return false;
    this.ends.push(t + 0.8); // an accepted sound counts against the cap for a typical tail
    return true;
  }

  private voiceFor(id: TitanId): TitanVoice {
    let v = this.voices.get(id);
    if (!v) {
      // every roster titan has its own voice file; an id this build has never heard of gets an empty voice (all handlers are
      // optional), which falls through to the shared titan-neutral sounds: it still sounds like a fight
      v = createTitanVoice(id);
      this.voices.set(id, v);
    }
    return v;
  }

  /**
   * A `VoiceCtx` whose dry and reverb-send taps are scaled by `gain` (cached per value: a handful of extra gain nodes), on the
   * impact bus or (`ui`) the UI bus.
   */
  private trimmed(gain: number, bus: 'impact' | 'ui' = 'impact'): VoiceCtx {
    const base = bus === 'ui' ? this.uiCtx! : this.sfxCtx!;
    const key = Math.round(gain * 20) / 20;
    if (key === 1) return base;
    const id = bus === 'ui' ? -key : key;
    let c = this.trims.get(id);
    if (!c) {
      const g = this.g!;
      const dry = g.ac.createGain();
      dry.gain.value = key;
      dry.connect(base.dry);
      const wet = g.ac.createGain();
      wet.gain.value = key;
      wet.connect(base.wet);
      c = Object.create(base, { dry: { value: dry }, wet: { value: wet } }) as VoiceCtx;
      this.trims.set(id, c);
    }
    return c;
  }

  private titanOf(slot: 0 | 1 | -1, fallback?: TitanId): TitanId {
    if (slot >= 0)
      return (
        this.scene?.fighters?.[slot as 0 | 1]?.titan ?? this.slotTitan[slot as 0 | 1] ?? fallback ?? 'lastone'
      );
    return fallback ?? 'lastone';
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  events
   * ------------------------------------------------------------------------------------------------ */
  handle(events: readonly AudioEvent[]): void {
    if (events.length === 0 || !this.ready || !this.ac) return;
    this.handleAt(events, this.ac.currentTime + LOOKAHEAD);
  }

  handleAt(events: readonly AudioEvent[], when: number): void {
    const c = this.sfxCtx;
    if (!c || !this.g || !Number.isFinite(when)) return;
    this.now = when;
    this.batchLow = 0;
    const lx = fin(this.scene?.listenerX ?? 0);
    for (const ev of events) {
      try {
        this.dispatch(c, sanitizeEvent(ev, lx), when);
      } catch (e) {
        /* a single misbehaving voice must never take the frame (or the game) down */
        if (this.thrown++ < 5) devLog(`a voice threw on '${ev.t}'`, e);
      }
    }
  }

  private dispatch(c: VoiceCtx, ev: AudioEvent, t: number): void {
    switch (ev.t) {
      case 'ui':
        if (c.take(1)) playUi(this.trimmed(UI_TRIM[ev.id], 'ui'), t, ev.id);
        if (ev.id === 'roundwin') this.score?.roundEvent('end', t);
        return;
      case 'move': {
        if (!c.take(0)) return;
        this.slotTitan[ev.slot] = ev.titan;
        const v = this.voiceFor(ev.titan);
        const tc = this.trimmed(MOVE_TRIM[ev.moveSlot] ?? 2);
        if (v.onMove) v.onMove(tc, t, ev);
        else this.genericMove(tc, t, ev);
        return;
      }
      case 'charge': {
        this.voiceFor(ev.titan).onCharge?.(c, t, ev);
        return;
      }
      case 'release': {
        if (!c.take(1)) return;
        const v = this.voiceFor(ev.titan);
        if (v.onRelease) v.onRelease(c, t, ev);
        else playImpactWhoosh(c, t, c.panOf(ev.x), ev.power);
        return;
      }
      case 'surge': {
        if (!c.take(0)) return;
        const v = this.voiceFor(ev.titan);
        const tc = this.trimmed(SURGE_TRIM);
        if (v.onSurge) v.onSurge(tc, t, ev);
        else
          whoosh(tc, t, {
            dur: 0.35,
            gain: 0.08,
            panFrom: c.panOf(ev.x) - 0.3,
            panTo: c.panOf(ev.x) + 0.3,
            wet: 0.25,
          });
        return;
      }
      case 'hit': {
        // the mix follows the MOVE, not the balance knobs: the attacker's balance.power comes out of the energy, and a blow
        // flagged heavy only because power pushed it over the sim's 700 line is not heavy here
        const atkTitan = this.titanOf(ev.attacker);
        const energy = presentationEnergy(ev.energy, atkTitan);
        // a LIGHT blow (under the heavy line telemetry and the duck use) is one slice of a beam, a field or a flurry: the sim emits
        // one every 5 ticks for continuous damage, all flagged heavy when the move is an ultimate or a crush. Voiced at that rate
        // with the heavy chain (≈ 200 nodes and 15 source-seconds each) it took the audio thread to 7–30 % of real time on the
        // target laptop (measured: a 3 s beam muted the game for 8 s). One light blow per attacker per LIGHT_HIT_REPEAT, never
        // with the heavy chain.
        const light = energy < DUCK_MIN_ENERGY;
        if (light) {
          const key = `h${ev.attacker}`;
          if (t < (this.cueAt.get(key) ?? -1) + LIGHT_HIT_REPEAT) return;
          this.cueAt.set(key, t);
        }
        if (!c.take(1)) return;
        const hv =
          ev.heavy && (light || (ev.energy >= HEAVY_BLOW && energy < HEAVY_BLOW))
            ? { ...ev, heavy: false }
            : ev;
        const mag = magnitude(energy, hv.heavy);
        const pan = c.panOf(ev.x);
        playImpact(c, t, hv, mag, pan);
        // D34 contrast: the material layers of a light blow sit lower (up to −7 dB), so a dense exchange of jabs never reads as
        // loud as one catastrophe (the loudness range of a fight survives a faster pace)
        const lc = this.trimmed(0.45 + 0.55 * Math.pow(mag, 1.5));
        playTypeLayer(lc, t, ev.type, mag, pan, 1 - 0.7 * clamp01(ev.blocked));
        const atk = this.voiceFor(atkTitan);
        atk.onHitDealt?.(lc, t, hv, mag);
        const tgt = this.voiceFor(this.titanOf(ev.target, ev.titan));
        tgt.onHitTaken?.(lc, t, hv, mag);
        // the bed gets out of the way of a heavy blow (sidechain-style): this is what lets an impact stand 10+ dB over it
        // every blow telemetry calls heavy (energy ≥ 400; continuous beam/field slices are flagged heavy but carry ~10–100)
        if (energy >= DUCK_MIN_ENERGY)
          this.duck(t, clamp01((mag - 0.3) / 0.6) * (1 - 0.7 * clamp01(ev.blocked)));
        return;
      }
      case 'guard': {
        if (!c.take(1)) return;
        const v = this.voiceFor(this.titanOf(ev.slot));
        if (v.onGuard) v.onGuard(c, t, ev);
        else playGuard(c, t, ev, c.panOf(ev.x));
        return;
      }
      case 'shockwave':
        if (c.take(1)) playShockwave(c, t, ev.strength, ev.radius, c.panOf(ev.x));
        // the big rings are the cataclysms: the Planet's quake and moon slams, a nova, a KO
        if (ev.strength >= 0.8 && ev.radius >= 220) this.duck(t, clamp01((ev.radius - 220) / 160));
        return;
      case 'ko': {
        // the hush: the bed empties out, the titan's catastrophe (its own, or the shared one) lands into the silence
        this.duck(t, 1, KO_HUSH_DB, KO_HUSH_SEC);
        const v = this.voiceFor(this.titanOf(ev.slot));
        if (v.onKo) v.onKo(c, t, ev);
        else playKo(c, t, ev, c.panOf(ev.x));
        return;
      }
      case 'matter': {
        // a shattering body emits dozens of detach / impact events a second; one sound per kind and fighter per MATTER_REPEAT
        // (they are the rubble of a blow, not blows: a wall of them filled every gap and flattened the fight's loudness range)
        const mkey = `m${ev.slot}:${ev.kind}`;
        if (t < (this.cueAt.get(mkey) ?? -1) + MATTER_REPEAT) return;
        this.cueAt.set(mkey, t);
        if (!c.take(0)) return;
        const owner = ev.slot >= 0 ? this.voiceFor(this.titanOf(ev.slot)) : null;
        if (!owner?.onMatter?.(c, t, ev)) playMatter(c, t, ev, c.panOf(ev.x));
        return;
      }
      case 'ultimate': {
        const v = this.voiceFor(ev.titan);
        if (v.onUltimate) v.onUltimate(c, t, ev);
        else playUltimate(c, t, ev, c.panOf(ev.x));
        return;
      }
      case 'round':
        this.roundSound(c, t, ev);
        return;
      case 'resource': {
        if (ev.kind === 'break' && c.take(0)) {
          lowBell(c, makeOut(c, 0, 0.4), t, 164.81, BELL, { decay: 0.6, gain: 0.08 });
        }
        return;
      }
      case 'cue': {
        // a cue the sim repeats tick after tick (Gate C: the Planet's ring-capture 12 times in one second, stacking bells into
        // the loudest moments of the fight) sounds once per CUE_REPEAT. The fighter's `hit-centre / hit-edge / hit-glancing`
        // cues annotate the physics of a blow the `hit` event already voices: silent here
        if (ev.id.startsWith('hit-')) return;
        const key = `${ev.slot}:${ev.id}`;
        if (t < (this.cueAt.get(key) ?? -1) + CUE_REPEAT) return;
        this.cueAt.set(key, t);
        if (!c.take(0)) return;
        const v = this.voiceFor(ev.titan);
        const tc = this.trimmed(CUE_TRIM[ev.titan] ?? 1);
        if (v.onCue) v.onCue(tc, t, ev);
        else playCueGeneric(tc, t, ev.amount, c.panOf(ev.x));
        return;
      }
      case 'hazard': {
        if (ev.kind === 'comet-retire' || !c.take(0)) return;
        if (ev.kind === 'comet-warn') cometWarn(c, t, c.panOf(ev.x), COMET_WARN_SEC);
        else cometEnter(c, t, c.panOf(ev.x), ev.vx, Math.hypot(ev.vx, ev.vy));
        return;
      }
      case 'timescale':
        this.timeScale = clamp(ev.scale, 0.3, 1);
        return;
      default:
        return; // shake / zoom / roll / flash / rumble: presentation only
    }
  }

  private genericMove(c: VoiceCtx, t: number, ev: Extract<SimEvent, { t: 'move' }>): void {
    swell(c, makeOut(c, c.panOf(ev.x), 0.2), t, { dur: 0.22, gain: 0.08, f0: 120, f1: 600 });
  }

  private roundSound(c: VoiceCtx, t: number, ev: Extract<SimEvent, { t: 'round' }>): void {
    this.score?.roundEvent(ev.phase, t);
    const o = makeOut(c, 0, 0.6);
    const sub = makeOut(c, 0, 0.1);
    switch (ev.phase) {
      case 'intro':
        boom(c, sub, t, { f0: 66, f1: 28, dur: 1.4, gain: 0.5 });
        break;
      case 'fight':
        // the bell of the arena: pressure gathers, the ground drops, a great bronze bell answers
        swell(c, o, t, { dur: 0.3, gain: 0.12, f0: 100, f1: 800, sub: 0.06 });
        boom(c, sub, t + 0.3, { f0: 82, f1: 30, dur: 1.1, gain: 0.6, drive: 2.8 });
        lowBell(c, o, t + 0.3, 73.42, BELL, { decay: 2.2, gain: 0.12, shimmer: 0.3 });
        break;
      case 'timeover':
        tone(c, o, t, { f0: 98, f1: 87, dur: 1.6, gain: 0.16, type: 'triangle', attack: 0.05 });
        break;
      case 'end':
      case 'match':
        // a low open chord of bronze (D2 A2 D3 F♯3), long
        for (const [i, f] of [73.42, 110, 146.83, 185].entries())
          lowBell(c, o, t + 0.15 + i * 0.12, f, BELL, {
            decay: ev.phase === 'match' ? 3.2 : 2,
            gain: 0.12,
            shimmer: 0.3,
          });
        break;
      default:
        break;
    }
  }

  /**
   * Sidechain-style duck of the WHOLE bed (titan beds, score, the bed's reverb) under a heavy event: `k` 0..1 picks the depth
   * (DUCK_DB) and the time it stays down (DUCK_SEC), unless a depth and hold are given (the KO hush). A deeper event inside a
   * duck re-ducks; a lighter one leaves it alone.
   */
  private duck(t: number, k: number, depthDb?: number, holdSec?: number): void {
    const g = this.g;
    if (!g) return;
    const depth = clamp(depthDb ?? DUCK_DB[0] + (DUCK_DB[1] - DUCK_DB[0]) * clamp01(k), 0, 40);
    const sec = clamp(holdSec ?? DUCK_SEC[0] + (DUCK_SEC[1] - DUCK_SEC[0]) * clamp01(k), 0.05, 4);
    if (!Number.isFinite(t)) return;
    if (t < this.duckUntil - 0.02 && depth <= this.duckDepth) {
      // already down at least this far: only stretch the hold if this one would end later
      if (t + sec <= this.duckUntil) return;
    }
    // down in ~10 ms, held, then back with a 120 ms time constant (the hold ends early enough that the ≥ 3 dB-down time is `sec`);
    // the KO hush falls a little softer (40 ms) and comes back slowly (0.5 s), under the decay. Every value is computed (and
    // finite) BEFORE the cancel: a throw between the cancel and the restore would leave the bed down until the next heavy blow.
    const hushed = depthDb !== undefined;
    const down = dbToGain(-depth);
    const back = t + Math.max(0.05, sec - 0.06);
    const p = g.duck.gain;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(down, t, hushed ? 0.04 : 0.01);
    p.setTargetAtTime(1, back, hushed ? 0.5 : 0.12);
    this.duckUntil = t + sec;
    this.duckDepth = depth;
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  continuous state
   * ------------------------------------------------------------------------------------------------ */
  update(scene: AudioScene, dtSec: number): void {
    if (!this.g || !this.ac) return;
    // browsers that refuse to resume from a gamepad press resume on the first real gesture: keep trying, politely
    if (this.ac.state !== 'running' && 'resume' in this.ac && this.ac.currentTime >= 0) {
      const wall = typeof performance !== 'undefined' ? performance.now() : 0;
      if (wall > this.resumeAt) {
        this.resumeAt = wall + 1000;
        void (this.ac as AudioContext).resume().catch(() => undefined);
      }
    }
    if (!this.ready) {
      this.scene = scene;
      return;
    }
    this.watchLoad();
    this.updateAt(scene, dtSec, this.ac.currentTime + 0.15);
  }

  private governed(): boolean {
    const ac = this.ac;
    if (!ac) return false;
    return this.governorOpt ?? (typeof AudioContext !== 'undefined' && ac instanceof AudioContext);
  }

  /**
   * THE LOAD GOVERNOR. On the target laptop (Ryzen 5 5500U, Edge) the heavy moves built more audio graph than the audio thread
   * can render in real time: measured in Edge with this engine, a beam ultimate's slices ran the audio clock at 7–33 % of real
   * time and an ultimate's burst of cues at ~40 %; a late audio thread is an output that underruns, i.e. SILENCE, and every
   * tail scheduled in audio time then lasts 3–10× longer in wall time (a 3 s beam muted the game for ~8 s: "comes back later").
   * The audio clock is compared with the wall clock once per LOAD_WINDOW_SEC; while it runs slow, `take` sheds new sounds so it
   * can catch up. Windows longer than 3 s (a hidden tab, a debugger) and a suspended context are not measured.
   */
  private watchLoad(): void {
    const ac = this.ac;
    // (the first second of a fresh context is its output device starting up, not load)
    if (!ac || !this.governed() || ac.state !== 'running' || ac.currentTime < 1) {
      this.loadWall = -1;
      return;
    }
    const wall = this.wall();
    if (this.loadWall < 0) {
      this.loadWall = wall;
      this.loadAudio = ac.currentTime;
      return;
    }
    const dw = (wall - this.loadWall) / 1000;
    if (dw < LOAD_WINDOW_SEC) return;
    const da = ac.currentTime - this.loadAudio;
    this.loadWall = wall;
    this.loadAudio = ac.currentTime;
    if (dw > 3) return;
    this.speed = da / dw;
    if (this.speed < OVERLOAD_RATIO) {
      if (!this.isOverloaded())
        devLog(
          `load governor: the audio thread runs at ${Math.round(this.speed * 100)} % of real time; shedding new sounds`,
        );
      this.overloadUntil = wall + OVERLOAD_HOLD_MS;
    }
  }

  private isOverloaded(): boolean {
    return this.overloadUntil >= 0 && this.wall() < this.overloadUntil;
  }

  get renderSpeed(): number {
    return this.governed() ? this.speed : 1;
  }

  updateAt(sceneIn: AudioScene, dtIn: number, horizon: number): void {
    const c = this.sfxCtx;
    if (!c || !this.g || !this.score) return;
    // the game's numbers are not trusted: a NaN here used to stick in the score's and the bed's smoothing for good
    const scene = sanitizeScene(sceneIn);
    const dtSec = clamp(dtIn, 0, 1);
    this.scene = scene;
    this.timeScale = clamp(scene.timeScale, 0.3, 1);
    this.now = this.ac!.currentTime;
    const fighting = scene.phase === 'fight' || scene.phase === 'attract' || scene.phase === 'pause';
    for (const slot of [0, 1] as const) {
      const f: AudioFighterScene | undefined = scene.fighters?.[slot];
      const prev = this.slotTitan[slot];
      try {
        if (fighting && f) {
          if (prev && prev !== f.titan) this.voiceFor(prev).stop?.(slot);
          this.slotTitan[slot] = f.titan;
          // continuous voices are the titans' BED (ducked under heavy blows), not impacts
          this.voiceFor(f.titan).update?.(this.bedCtx ?? c, f, slot, dtSec);
        } else if (prev) {
          this.voiceFor(prev).stop?.(slot);
        }
      } catch (e) {
        // one titan's bed must not stop the score, the breathing and the guard below (nor throw into the game's frame)
        if (this.thrown++ < 5) devLog(`a continuous voice threw (slot ${slot})`, e);
      }
    }
    try {
      this.score.update(scene, dtSec);
      this.score.scheduleUntil(horizon);
    } catch (e) {
      if (this.thrown++ < 5) devLog('the score threw', e);
    }
    this.breathe(scene, fighting, dtSec);
    // meter the master, and guard it
    this.sample();
  }

  /**
   * The score breathes with the round (D6): thin at neutral (SCORE_NEUTRAL_DB down), swelling as a fighter COMMITS (winding
   * up, charging, striking) or the fight heats up. Rises in ~0.25 s, falls back over ~1.2 s. setTarget only: it is retargeted
   * every frame.
   */
  private breathe(scene: AudioScene, fighting: boolean, dtSec: number): void {
    const g = this.g;
    if (!g) return;
    let want = 0;
    if (fighting && scene.phase !== 'pause') {
      for (const f of scene.fighters ?? []) {
        const s = f.state;
        const k =
          s === 'charge' ? 0.4 + 0.4 * clamp01(f.charge) : s === 'startup' || s === 'active' ? 0.3 : 0;
        want = Math.max(want, k);
      }
      const i = clamp01((scene.intensity - 0.25) / 0.6);
      want = Math.max(want, i * i * (3 - 2 * i));
    } else if (!fighting) want = 1; // menus and results: the score is the whole show
    const tau = want > this.commit ? 0.6 : 2;
    this.commit = clamp01(this.commit + (want - this.commit) * (1 - Math.exp(-Math.max(0, dtSec) / tau)));
    g.scoreIn.gain.setTargetAtTime(dbToGain(-SCORE_NEUTRAL_DB * (1 - this.commit)), g.ac.currentTime, 0.08);
  }

  private sample(): void {
    const g = this.g;
    if (!g) return;
    this.preBuf ??= new Float32Array(g.preAn.fftSize);
    this.postBuf ??= new Float32Array(g.postAn.fftSize);
    g.preAn.getFloatTimeDomainData(this.preBuf as Float32Array<ArrayBuffer>);
    g.postAn.getFloatTimeDomainData(this.postBuf as Float32Array<ArrayBuffer>);
    let a = 0;
    let b = 0;
    for (let i = 0; i < this.preBuf.length; i++) {
      a = Math.max(a, Math.abs(this.preBuf[i]!));
      b = Math.max(b, Math.abs(this.postBuf[i]!));
    }
    // (Math.max carries a NaN through: a non-finite sample anywhere in either window shows up here at no extra cost)
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      this.recover('non-finite samples on the master');
      return;
    }
    this.peakPre = Math.max(this.peakPre, a);
    this.peakPost = Math.max(this.peakPost, b);
    this.watch(a, b);
  }

  /**
   * THE GUARD, run on every meter read (once a frame, on the analysers' existing 2048-sample windows: no per-sample work beyond
   * the peak scan above). Three failure modes ended in "the sound disappears after a big move, and comes back later, or never":
   *  1. a NaN / Infinity sample reached a stateful node: in Chromium one non-finite sample leaves a BiquadFilterNode's state NaN
   *     FOREVER (measured in Edge: every sample after it is NaN) and a ConvolverNode's for its whole impulse response; the master's
   *     high-pass, laptop EQ and weight filters are biquads, so the whole game went mute for good (`sample()` and the limiter's
   *     report catch it);
   *  2. the output is silent while the mix carries signal (a dead limiter worklet, a stuck gain): `deadReads`;
   *  3. the bed's duck left down (a restore that never came): restored here once its hold is long over.
   * 1 and 2 rebuild the whole graph on the same context (`recover`); the voices start over on the new buses.
   */
  private watch(pre: number, post: number): void {
    const g = this.g;
    if (!g) return;
    if (!this.bypass && this.vol.master > 0.05 && pre > 1e-3 && post < 1e-6) {
      if (++this.deadReads >= DEAD_READS) this.recover('silent output under a live mix');
    } else this.deadReads = 0;
    const t = g.ac.currentTime;
    if (t > this.duckUntil + 1 && g.duck.gain.value < 0.7) {
      devLog('the bed duck was left down: restored');
      g.duck.gain.cancelScheduledValues(t);
      g.duck.gain.setTargetAtTime(1, t, 0.1);
      this.duckUntil = t;
      this.duckDepth = 0;
    }
  }

  /**
   * Rebuild the graph on the same context: everything stateful (the master's filters, the reverbs, the glue, the limiter, the
   * duck) starts fresh and silent, the continuous voices and the score start over on the new buses, and the old graph is cut off
   * from the speakers and the analysers (its one-shots finish into nothing). At most once per RECOVER_GAP_MS.
   */
  private recover(why: string): void {
    const ac = this.ac;
    const old = this.g;
    if (!ac || !old) return;
    const wall = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (wall < this.recoverAt) return;
    this.recoverAt = wall + RECOVER_GAP_MS;
    this.recoveries++;
    devLog(`guard: ${why}; rebuilding the audio graph (recovery #${this.recoveries})`);
    for (const v of this.voices.values()) {
      try {
        v.stop?.('all');
      } catch {
        /* a voice that cannot stop is dropped with its old buses anyway */
      }
    }
    this.voices.clear();
    this.score?.dispose();
    this.score = null;
    if (old.limiter) old.limiter.port.onmessage = null;
    for (const n of old.teardown) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.g = null;
    this.trims.clear();
    this.ends.length = 0;
    this.duckUntil = 0;
    this.duckDepth = 0;
    this.deadReads = 0;
    this.preBuf = this.postBuf = null;
    // (the continuous voices and the new score pick up on the next update(), on the scene's stage)
    this.build(ac, this.worklet);
  }

  /** How many times the guard has rebuilt the graph (diagnostics, tests). */
  get recoveryCount(): number {
    return this.recoveries;
  }

  readPeak(): { pre: number; post: number } {
    this.sample();
    const r = { pre: this.peakPre, post: this.peakPost };
    this.peakPre = 0;
    this.peakPost = 0;
    return r;
  }

  setVolumes(v: Partial<AudioVolumes>): void {
    this.vol = {
      master: clamp01(v.master ?? this.vol.master),
      music: clamp01(v.music ?? this.vol.music),
      sfx: clamp01(v.sfx ?? this.vol.sfx),
    };
    const g = this.g;
    if (!g) return;
    const t = g.ac.currentTime;
    g.master.gain.setTargetAtTime(volumeCurve(this.vol.master), t, 0.02);
    g.music.gain.setTargetAtTime(volumeCurve(this.vol.music), t, 0.02);
    for (const n of [g.sfx, g.ui, g.bedSfx]) n.gain.setTargetAtTime(volumeCurve(this.vol.sfx), t, 0.02);
  }

  taps(): { output: AudioNode; music: AudioNode; sfx: AudioNode } | null {
    const g = this.g;
    // `music` is the WHOLE bed after its duck (titan beds + score + bed reverb): what an impact has to rise above
    return g ? { output: g.out, music: g.duck, sfx: g.sfx } : null;
  }

  /** Deepest limiter gain reduction (dB, ≥ 0) since the last call; 0 when the worklet limiter is not in use. */
  limiterReductionDb(): number {
    const g = this.limiterMinGain;
    this.limiterMinGain = 1;
    return g < 1 ? -20 * Math.log10(Math.max(1e-6, g)) : 0;
  }

  latencyMs(): number {
    const ac = this.ac as (AudioContext & { outputLatency?: number }) | null;
    if (!ac) return 0;
    return ((ac.baseLatency ?? 0) + (ac.outputLatency ?? 0)) * 1000;
  }

  dispose(): void {
    for (const v of this.voices.values()) v.stop?.('all');
    this.score?.dispose();
    this.score = null;
    const ac = this.ac;
    this.g = null;
    this.building = null;
    this.trims.clear();
    if (ac && 'close' in ac && ac.state !== 'closed')
      void (ac as AudioContext).close().catch(() => undefined);
    this.ac = null;
  }
}

/** Titan-neutral "move goes live" whoosh for titans with no release handler. */
function playImpactWhoosh(c: VoiceCtx, t: number, pan: number, powerIn: number): void {
  const power = clamp01(powerIn);
  const o = makeOut(c, pan, 0.25);
  noiseHit(c, o, t, {
    dur: 0.2 + 0.1 * power,
    gain: 0.12 + 0.08 * power,
    filter: { type: 'bandpass', f0: 900, f1: 180, q: 0.9 },
    attack: 0.02,
  });
  boom(c, makeOut(c, pan * 0.3, 0), t, { f0: 90, f1: 40, dur: 0.3, gain: 0.15 + 0.2 * power });
}

export type { StageId };
