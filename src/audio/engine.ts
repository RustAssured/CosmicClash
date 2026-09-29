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
import { clamp, clamp01, hardClipCurve, limiterCurve, volumeCurve } from './dsp/math';
import { ScoreEngine } from './score/engine';
import { createAsteroidVoice } from './voices/asteroid';
import { createGenericVoice } from './voices/generic';
import { createLastOneVoice } from './voices/lastone';
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
import { UI_TRIM, playUi } from './voices/ui';

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
const CUE_TRIM = 3;

/** Concurrent one-shot cap (events, not nodes). Above it, low-priority sounds are dropped. */
const POLYPHONY = 28;

export interface AudioEngineOptions {
  /** Use this context instead of creating one on `unlock()` (OfflineAudioContext for verification). */
  context?: BaseAudioContext;
  /** Seed for the deterministic variation stream and the generative score. */
  seed?: number;
  /**
   * TEST ONLY: skip the compressor and the safety limiter. Lets the verification page prove the limiter is doing real work
   * (the same event storm without it must exceed full scale). Never set in the shipped app.
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
  /** Peak |sample| seen since the last call, before the limiter and after it. */
  readPeak(): { pre: number; post: number };
  /** Reported output latency (base + output) in ms, if the browser exposes it. */
  latencyMs(): number;
  /** Resume the context on the next user gesture of any kind (click, key, touch, pointer, gamepad activity). */
  autoUnlock(target: EventTarget): () => void;
  readonly volumes: Readonly<AudioVolumes>;
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
  sfx: GainNode;
  sfxSend: GainNode;
  music: GainNode;
  musicSend: GainNode;
  master: GainNode;
  preAn: AnalyserNode;
  postAn: AnalyserNode;
}

class Engine implements AudioEngineExt {
  private ac: BaseAudioContext | null;
  private g: Graph | null = null;
  private sfxCtx: VoiceCtx | null = null;
  private musicCtx: VoiceCtx | null = null;
  private score: ScoreEngine | null = null;
  private readonly seed: number;
  private readonly voices = new Map<TitanId, TitanVoice>();
  private readonly ends: number[] = [];
  private scene: AudioScene | null = null;
  private slotTitan: [TitanId | null, TitanId | null] = [null, null];
  private vol: AudioVolumes = { master: 0.85, music: 0.7, sfx: 0.9 };
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
      if (!this.g) this.build(this.ac);
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

  private build(ac: BaseAudioContext): void {
    const sr = ac.sampleRate;
    // Signal path:  buses → mix → high-pass → compressor → soft limiter (4×) → MASTER → hard clip → speakers.
    // The master volume sits AFTER the dynamics on purpose. Before them, a compressor at ratio 5 flattens the level differences
    // the player asked for (measured: master at ½ changed a hit's peak by only −1.3 dB); after them, master is a plain
    // linear scale of an already-safe signal, and because it is ≤ 1 it can never push the limiter's output past its ceiling.
    const mix = ac.createGain();
    const master = ac.createGain();
    master.gain.value = volumeCurve(this.vol.master);
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 22;
    hp.Q.value = 0.5;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    const shaper = ac.createWaveShaper();
    shaper.curve = limiterCurve() as Float32Array<ArrayBuffer>;
    shaper.oversample = '4x';
    const clip = ac.createWaveShaper();
    clip.curve = hardClipCurve() as Float32Array<ArrayBuffer>;
    const preAn = ac.createAnalyser();
    preAn.fftSize = 2048;
    const postAn = ac.createAnalyser();
    postAn.fftSize = 2048;
    mix.connect(preAn);
    mix.connect(hp);
    if (this.bypass) {
      hp.connect(master);
      master.connect(postAn);
      master.connect(ac.destination);
    } else {
      hp.connect(comp);
      comp.connect(shaper);
      shaper.connect(master);
      master.connect(clip);
      clip.connect(postAn);
      clip.connect(ac.destination);
    }

    // reverb: one long, dark convolver shared by both buses; the send is high-passed so sub-bass never muddies the tail
    const ir = cachedImpulseResponse(sr, this.seed);
    const buf = ac.createBuffer(2, ir[0].length, sr);
    buf.copyToChannel(ir[0] as Float32Array<ArrayBuffer>, 0);
    buf.copyToChannel(ir[1] as Float32Array<ArrayBuffer>, 1);
    const conv = ac.createConvolver();
    conv.normalize = false;
    conv.buffer = buf;
    const sendHp = ac.createBiquadFilter();
    sendHp.type = 'highpass';
    sendHp.frequency.value = 140;
    const wetOut = ac.createGain();
    wetOut.gain.value = 0.55;
    sendHp.connect(conv);
    conv.connect(wetOut);
    wetOut.connect(mix);

    const sfx = ac.createGain();
    sfx.gain.value = volumeCurve(this.vol.sfx);
    sfx.connect(mix);
    const sfxWet = ac.createGain();
    sfxWet.gain.value = 1;
    sfxWet.connect(sendHp);
    const music = ac.createGain();
    music.gain.value = volumeCurve(this.vol.music);
    music.connect(mix);
    const musicWet = ac.createGain();
    musicWet.gain.value = 0.7;
    musicWet.connect(sendHp);

    this.g = { ac, sfx, sfxSend: sfxWet, music, musicSend: musicWet, master, preAn, postAn };

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
    this.sfxCtx = {
      ...base,
      dry: sfx,
      wet: sfxWet,
      panOf: pan,
      take: (prio: number): boolean => this.take(prio),
      release: (): void => undefined,
      get timeScale(): number {
        return timeScale();
      },
    };
    this.musicCtx = {
      ...base,
      dry: music,
      wet: musicWet,
      panOf: pan,
      take: (): boolean => true,
      release: (): void => undefined,
      get timeScale(): number {
        return timeScale();
      },
    };
    this.score = new ScoreEngine(ac, music, this.musicCtx, this.seed);
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
      v =
        id === 'lastone'
          ? createLastOneVoice()
          : id === 'asteroid'
            ? createAsteroidVoice()
            : createGenericVoice(id);
      this.voices.set(id, v);
    }
    return v;
  }

  /** A `VoiceCtx` whose dry and reverb-send taps are scaled by `gain` (cached per value: a handful of extra gain nodes). */
  private trimmed(gain: number): VoiceCtx {
    const base = this.sfxCtx!;
    const key = Math.round(gain * 20) / 20;
    if (key === 1) return base;
    let c = this.trims.get(key);
    if (!c) {
      const g = this.g!;
      const dry = g.ac.createGain();
      dry.gain.value = key;
      dry.connect(g.sfx);
      const wet = g.ac.createGain();
      wet.gain.value = key;
      wet.connect(g.sfxSend);
      c = Object.create(base, { dry: { value: dry }, wet: { value: wet } }) as VoiceCtx;
      this.trims.set(key, c);
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
        if (c.take(1)) playUi(this.trimmed(UI_TRIM[ev.id]), t, ev.id);
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
        this.duck(t, 0.05 + 0.1 * mag, 0.08 + 0.14 * mag);
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
        return;
      case 'hitstop':
        this.duck(t, 0.55, (ev.ticks / 60) * 0.9);
        return;
      case 'ko': {
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
        const tc = this.trimmed(CUE_TRIM);
        if (v.onCue) v.onCue(tc, t, ev);
        else playCueGeneric(tc, t, ev.amount, c.panOf(ev.x));
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

  /** Duck the music bus for a hit / hit-stop and let it swell back: impacts feel louder without raising the master. */
  private duck(t: number, depth: number, sec: number): void {
    const g = this.g;
    if (!g) return;
    const base = volumeCurve(this.vol.music);
    const p = g.music.gain;
    if (t < this.duckUntil - 0.02) return; // already ducked: don't stack
    this.duckUntil = t + sec;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(base * (1 - depth), t, 0.006);
    p.setTargetAtTime(base, t + sec, 0.12);
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
        this.voiceFor(f.titan).update?.(c, f, slot, dtSec);
      } else if (prev) {
        this.voiceFor(prev).stop?.(slot);
      }
    }
    this.score.update(scene, dtSec);
    this.score.scheduleUntil(horizon);
    // meter the master
    this.sample();
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
    g.sfx.gain.setTargetAtTime(volumeCurve(this.vol.sfx), t, 0.02);
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
