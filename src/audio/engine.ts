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
} from './worklets/limiter';
import { ScoreEngine } from './score/engine';
import {
  magnitude,
  playCueGeneric,
  playGuard,
  playImpact,
  playKo,
  playKoSub,
  playMatter,
  playShockwave,
  playTypeLayer,
  playUltimate,
} from './voices/sfx';
import { GLASS, makeOut, noiseHit, partials, riser, thump, tone, whistlePass } from './voices/synth';
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
const MOVE_TRIM: Readonly<Record<string, number>> = {
  strike: 3,
  crush: 1.8,
  signature: 2,
  surge: 3,
  ultimate: 1.4,
  guard: 2,
};
const SURGE_TRIM = 3;
/** The Last One's and the Asteroid's cues are small pings authored quietly; the four newer voices author their cues at full level. */
const CUE_TRIM: Readonly<Partial<Record<TitanId, number>>> = { lastone: 3, asteroid: 3 };

/** Concurrent one-shot cap (events, not nodes). Above it, low-priority sounds are dropped. */
const POLYPHONY = 28;

/* ---- D6 mix constants (calibrated with tools/ui/audio-verify.ts --round: −20 LUFS integrated, ≤ −1 dBTP at default faders) ---- */
/** Output high-pass (Hz, 24 dB/oct): laptop speakers cannot play below it, so it would only eat limiter headroom (D27). */
export const OUTPUT_HIGHPASS_HZ = 50;
/**
 * Gain before the limiter (default faders). Phase 2 re-stage: the live orbit capture read −27 LUFS against −21.3 offline, so the
 * mix went up +3 dB here and the bed +2 dB (BED_LEVEL_DB): offline orbit −17.9 LUFS, the live one should land ≈ −24..−23.
 */
export const CALIBRATION_DB = 4.3;
/** Menu / UI sounds sit this far under the calibrated impacts (they were authored against the old, quieter master). */
const UI_LEVEL_DB = -9;
/** Reverb returns: the impacts' space and the bed's. */
const IMPACT_REVERB = 0.75;
const BED_REVERB = 0.3;
/** Gentle bed glue: compresses only the loudest bed moments, 2:1, slow (the impacts never pass through it). */
export const BED_GLUE = { threshold: -18, knee: 10, ratio: 2, attack: 0.03, release: 0.35 } as const;
/** The score at neutral sits this many dB under its full, committed level. */
export const SCORE_NEUTRAL_DB = 8;
/** The whole bed sits this far under the impacts (dB): the floor a blow rises from. */
export const BED_LEVEL_DB = -2.5;
/**
 * Bed duck under heavy blows: gain depth (dB) and time held (s) from the lightest to the heaviest qualifying event. Telemetry
 * reads the duck through 400 ms momentary loudness. Phase 2: the live meter read the old 6.5–10 dB gains as a 12 dB median dip, so
 * they were halved toward 4–6.5 dB (offline orbit: 5.3 dB median, 300 ms).
 */
export const DUCK_DB: readonly [number, number] = [4, 6.5];
export const DUCK_SEC: readonly [number, number] = [0.35, 0.55];
/** Smallest blow that ducks the bed (the same line telemetry draws for a heavy hit). */
export const DUCK_MIN_ENERGY = 400;

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
}

/** The IR is deterministic per (sample rate, seed) and takes a noticeable moment to synthesise: build it once. */
const irCache = new Map<string, ReturnType<typeof generateImpulseResponse>>();
function cachedImpulseResponse(sr: number, seed: number): ReturnType<typeof generateImpulseResponse> {
  const key = `${sr}:${seed}`;
  let ir = irCache.get(key);
  if (!ir) {
    ir = generateImpulseResponse(sr, { decay: 3.4, seed });
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
  private readonly bypass: boolean;
  private readonly trims = new Map<number, VoiceCtx>();

  constructor(o: AudioEngineOptions) {
    this.ac = o.context ?? null;
    this.seed = o.seed ?? 7;
    this.bypass = !!o.unsafeBypassLimiter;
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
    mix.connect(hp1);
    hp1.connect(hp2);
    // unsafeBypassLimiter (tests only) measures the mix as it ENTERS the limiter (calibrated), with no limiter and no clip
    hp2.connect(calib);
    let limiter: AudioNode;
    if (this.bypass) {
      limiter = ac.createGain();
    } else if (worklet) {
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
      node.port.onmessage = (e: MessageEvent<number>): void => {
        if (e.data < this.limiterMinGain) this.limiterMinGain = e.data;
      };
      limiter = node;
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
    // own (ducked with it). Both sends are high-passed so sub-bass never muddies a tail.
    const ir = cachedImpulseResponse(sr, this.seed);
    const buf = ac.createBuffer(2, ir[0].length, sr);
    buf.copyToChannel(ir[0] as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(ir[1] as Float32Array<ArrayBuffer>, 1);
    const reverb = (ret: number, into: AudioNode): GainNode => {
      const send = ac.createGain();
      const hp = ac.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 140;
      const conv = ac.createConvolver();
      conv.normalize = false;
      conv.buffer = buf;
      const out = ac.createGain();
      out.gain.value = ret;
      send.connect(hp);
      hp.connect(conv);
      conv.connect(out);
      out.connect(into);
      return send;
    };

    // impacts
    const sfx = ac.createGain();
    sfx.gain.value = volumeCurve(this.vol.sfx);
    sfx.connect(mix);
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
    const lx = this.scene?.listenerX ?? 0;
    return clamp((x - lx) / 520, -1, 1) * 0.85;
  }

  /** Polyphony gate: drop low-priority sounds when too many are still sounding. */
  private take(prio: number): boolean {
    const t = this.now;
    for (let i = this.ends.length - 1; i >= 0; i--) if (this.ends[i]! < t) this.ends.splice(i, 1);
    if (this.ends.length >= POLYPHONY && prio < 2) return false;
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
    if (!c || !this.g) return;
    this.now = when;
    for (const ev of events) {
      try {
        this.dispatch(c, ev, when);
      } catch {
        /* a single misbehaving voice must never take the frame (or the game) down */
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
          whistlePass(tc, t, {
            f: 700,
            dur: 0.3,
            gain: 0.06,
            panFrom: c.panOf(ev.x) - 0.3,
            panTo: c.panOf(ev.x) + 0.3,
            wet: 0.2,
          });
        return;
      }
      case 'hit': {
        if (!c.take(1)) return;
        const mag = magnitude(ev.energy, ev.heavy);
        const pan = c.panOf(ev.x);
        playImpact(c, t, ev, mag, pan);
        playTypeLayer(c, t, ev.type, mag, pan, 1 - 0.7 * clamp01(ev.blocked));
        const atk = this.voiceFor(this.titanOf(ev.attacker));
        atk.onHitDealt?.(c, t, ev, mag);
        const tgt = this.voiceFor(this.titanOf(ev.target, ev.titan));
        tgt.onHitTaken?.(c, t, ev, mag);
        // the bed gets out of the way of a heavy blow (sidechain-style): this is what lets an impact stand 10+ dB over it
        // every blow telemetry calls heavy (energy ≥ 400; continuous beam/field slices are flagged heavy but carry ~10–100)
        if (ev.energy >= DUCK_MIN_ENERGY)
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
        this.duck(t, 1);
        const v = this.voiceFor(this.titanOf(ev.slot));
        if (v.onKo) {
          playKoSub(c, t, c.panOf(ev.x));
          v.onKo(c, t, ev);
        } else playKo(c, t, ev, c.panOf(ev.x));
        return;
      }
      case 'matter': {
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
          partials(c, makeOut(c, 0, 0.4), t, 660, GLASS, { decay: 0.3, gain: 0.08 });
        }
        return;
      }
      case 'cue': {
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
    noiseHit(c, makeOut(c, c.panOf(ev.x), 0.2), t, {
      dur: 0.16,
      gain: 0.07,
      filter: { type: 'bandpass', f0: 700, f1: 1800, q: 1 },
      attack: 0.05,
    });
  }

  private roundSound(c: VoiceCtx, t: number, ev: Extract<SimEvent, { t: 'round' }>): void {
    this.score?.roundEvent(ev.phase, t);
    const o = makeOut(c, 0, 0.6);
    switch (ev.phase) {
      case 'intro':
        thump(c, makeOut(c, 0, 0), t, 66, 28, 1.2, 0.5);
        break;
      case 'fight':
        riser(c, o, t, 0.25, 0.08, 800, 5000);
        thump(c, makeOut(c, 0, 0), t + 0.25, 78, 30, 0.9, 0.6);
        partials(c, o, t + 0.25, 587.33, GLASS, { decay: 0.9, gain: 0.08, shimmer: 0.3 });
        break;
      case 'timeover':
        tone(c, o, t, { f0: 196, f1: 174, dur: 1.4, gain: 0.14, type: 'triangle', attack: 0.05 });
        break;
      case 'end':
      case 'match':
        for (const [i, f] of [587.33, 739.99, 880, 1174.66].entries())
          partials(c, o, t + 0.15 + i * 0.1, f, GLASS, {
            decay: ev.phase === 'match' ? 2.4 : 1.4,
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
   * (DUCK_DB) and the time it stays down (DUCK_SEC). A deeper event inside a duck re-ducks; a lighter one leaves it alone.
   */
  private duck(t: number, k: number): void {
    const g = this.g;
    if (!g) return;
    const depth = DUCK_DB[0] + (DUCK_DB[1] - DUCK_DB[0]) * clamp01(k);
    const sec = DUCK_SEC[0] + (DUCK_SEC[1] - DUCK_SEC[0]) * clamp01(k);
    if (t < this.duckUntil - 0.02 && depth <= this.duckDepth) {
      // already down at least this far: only stretch the hold if this one would end later
      if (t + sec <= this.duckUntil) return;
    }
    this.duckUntil = t + sec;
    this.duckDepth = depth;
    const p = g.duck.gain;
    p.cancelScheduledValues(t);
    // down in ~10 ms, held, then back with a 120 ms time constant (the hold ends early enough that the ≥ 3 dB-down time is `sec`)
    p.setTargetAtTime(dbToGain(-depth), t, 0.01);
    p.setTargetAtTime(1, t + Math.max(0.05, sec - 0.06), 0.12);
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
    this.updateAt(scene, dtSec, this.ac.currentTime + 0.15);
  }

  updateAt(scene: AudioScene, dtSec: number, horizon: number): void {
    const c = this.sfxCtx;
    if (!c || !this.g || !this.score) return;
    this.scene = scene;
    this.timeScale = clamp(scene.timeScale, 0.3, 1);
    this.now = this.ac!.currentTime;
    const fighting = scene.phase === 'fight' || scene.phase === 'attract' || scene.phase === 'pause';
    for (const slot of [0, 1] as const) {
      const f: AudioFighterScene | undefined = scene.fighters?.[slot];
      const prev = this.slotTitan[slot];
      if (fighting && f) {
        if (prev && prev !== f.titan) this.voiceFor(prev).stop?.(slot);
        this.slotTitan[slot] = f.titan;
        // continuous voices are the titans' BED (ducked under heavy blows), not impacts
        this.voiceFor(f.titan).update?.(this.bedCtx ?? c, f, slot, dtSec);
      } else if (prev) {
        this.voiceFor(prev).stop?.(slot);
      }
    }
    this.score.update(scene, dtSec);
    this.score.scheduleUntil(horizon);
    this.breathe(scene, fighting, dtSec);
    // meter the master
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
    this.commit += (want - this.commit) * (1 - Math.exp(-Math.max(0, dtSec) / tau));
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
    this.peakPre = Math.max(this.peakPre, a);
    this.peakPost = Math.max(this.peakPost, b);
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
function playImpactWhoosh(c: VoiceCtx, t: number, pan: number, power: number): void {
  const o = makeOut(c, pan, 0.25);
  noiseHit(c, o, t, {
    dur: 0.16 + 0.1 * power,
    gain: 0.1 + 0.08 * power,
    filter: { type: 'bandpass', f0: 500, f1: 2200, q: 0.9 },
    attack: 0.02,
  });
  thump(c, makeOut(c, pan * 0.3, 0), t, 90, 40, 0.2, 0.15 + 0.2 * power);
}

export type { StageId };
