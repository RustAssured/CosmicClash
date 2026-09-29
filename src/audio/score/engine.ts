import { Rng, type AudioScene, type StageId } from '@/contracts';
import { clamp, clamp01, midiToHz } from '../dsp/math';
import { STAGE_FEEL, STAGE_MUSIC, degreeToHz, fifthOf, type StageFeel, type StageMusic } from '../dsp/scales';
import { GLASS, makeOut, noiseHit, partials, thump, tone } from '../voices/synth';
import type { VoiceCtx } from '../voices/types';
import { CHORD_BARS, STEPS_PER_BAR, nextChord, planStep, stepSeconds } from './plan';

/**
 * The generative score. Nothing here is a sample or a loop: a slowly breathing drone bed (root, fifth, sub, shimmer)
 * whose notes come from the stage's mode, a drifting three-voice pad that glides between chords every few bars, and rhythm
 * layers (sub pulses, low membrane hits, airy percussion, a heartbeat) that a deterministic planner (`plan.ts`) adds as
 * the fight heats up. Everything is scheduled sample-accurately against the audio clock, a fraction of a second ahead.
 */
const LOOKAHEAD = 0.15;

interface Drone {
  root: OscillatorNode;
  fifth: [OscillatorNode, OscillatorNode];
  sub: OscillatorNode;
  shimmer: OscillatorNode;
  cluster: OscillatorNode;
  filter: BiquadFilterNode;
  clusterGain: GainNode;
  gain: GainNode;
  lfo: OscillatorNode;
}
interface PadVoice {
  oscs: [OscillatorNode, OscillatorNode];
}

export class ScoreEngine {
  private drone: Drone | null = null;
  private padVoices: PadVoice[] = [];
  private padGain: GainNode | null = null;
  private padFilter: BiquadFilterNode | null = null;
  private stage: StageId = 'nursery';
  private music: StageMusic = STAGE_MUSIC.nursery;
  private feel: StageFeel = STAGE_FEEL.nursery;
  private padWet: GainNode | null = null;
  private rng: Rng;
  private readonly seed: number;
  private step = 0;
  private nextTime = 0;
  private chord = 0;
  private intensity = 0;
  private lowIntegrity = 0;
  private phase: AudioScene['phase'] = 'menu';
  private timeScale = 1;
  private started = false;
  private lastUpdate = 0;
  private swellUntil = 0;

  constructor(
    private readonly ac: BaseAudioContext,
    private readonly out: AudioNode,
    private readonly c: VoiceCtx,
    seed = 1,
  ) {
    this.seed = seed;
    this.rng = new Rng(seed);
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  lifecycle
   * ------------------------------------------------------------------------------------------------ */
  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    const ac = this.ac;
    const t = ac.currentTime;
    // ---- drone ----
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.8;
    const gain = ac.createGain();
    gain.gain.value = 0;
    filter.connect(gain);
    gain.connect(this.out);
    const mk = (type: OscillatorType, g: number, detune = 0): OscillatorNode => {
      const o = ac.createOscillator();
      o.type = type;
      o.detune.value = detune;
      const og = ac.createGain();
      og.gain.value = g;
      o.connect(og);
      og.connect(filter);
      o.start(t);
      return o;
    };
    const root = mk('sawtooth', 0.35);
    const fifthA = mk('triangle', 0.32, -5);
    const fifthB = mk('triangle', 0.32, 5);
    const sub = mk('sine', 0.7);
    const shimmer = mk('sine', 0.05);
    // a minor-second cluster note that only sounds when a titan is close to death (the "tense drop")
    const cluster = ac.createOscillator();
    cluster.type = 'sawtooth';
    const clusterGain = ac.createGain();
    clusterGain.gain.value = 0;
    cluster.connect(clusterGain);
    clusterGain.connect(filter);
    cluster.start(t);
    // slow breathing of the drone filter
    const lfo = ac.createOscillator();
    lfo.frequency.value = 0.045;
    const lg = ac.createGain();
    lg.gain.value = 160;
    lfo.connect(lg);
    lg.connect(filter.frequency);
    lfo.start(t);
    this.drone = { root, fifth: [fifthA, fifthB], sub, shimmer, cluster, filter, clusterGain, gain, lfo };
    // ---- pad ----
    const padFilter = ac.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 900;
    padFilter.Q.value = 0.5;
    const padGain = ac.createGain();
    padGain.gain.value = 0;
    padFilter.connect(padGain);
    padGain.connect(this.out);
    const wet = ac.createGain();
    wet.gain.value = 0.6 * this.feel.space;
    padGain.connect(wet);
    wet.connect(this.c.wet);
    this.padWet = wet;
    for (let v = 0; v < 3; v++) {
      const oscs = [0, 1].map((k) => {
        const o = ac.createOscillator();
        o.type = 'triangle';
        o.detune.value = k === 0 ? -6 : 6;
        const og = ac.createGain();
        og.gain.value = 0.34;
        o.connect(og);
        og.connect(padFilter);
        o.start(t);
        return o;
      }) as [OscillatorNode, OscillatorNode];
      this.padVoices.push({ oscs });
    }
    this.padGain = padGain;
    this.padFilter = padFilter;
    this.setStageNotes(0, true);
    this.setChord(0, true);
  }

  private setStageNotes(when: number, immediate: boolean): void {
    const d = this.drone;
    if (!d) return;
    const m = this.music;
    const rootHz = midiToHz(m.root);
    const fifthHz = midiToHz(fifthOf(m));
    const notes: [OscillatorNode, number][] = [
      [d.root, rootHz],
      [d.fifth[0], fifthHz],
      [d.fifth[1], fifthHz],
      [d.sub, rootHz / 2],
      [d.shimmer, rootHz * 8],
      [d.cluster, rootHz * 1.0595 * 2],
    ];
    if (immediate) {
      // at creation: the pitch IS the value, from the first sample (a glide from the default 440 Hz would be audible)
      for (const [o, hz] of notes) o.frequency.value = hz;
      return;
    }
    const t = Math.max(when, this.ac.currentTime);
    for (const [o, hz] of notes) o.frequency.setTargetAtTime(hz, t, 1.2);
  }

  private setChord(index: number, immediate = false, when = this.ac.currentTime): void {
    if (!this.padGain) return;
    const m = this.music;
    const chord = m.chords[index % m.chords.length]!;
    this.padVoices.forEach((v, i) => {
      const hz = degreeToHz(m.root + this.feel.padOct, m.mode, chord[i % chord.length]!);
      for (const o of v.oscs) {
        if (immediate) o.frequency.value = hz;
        else o.frequency.setTargetAtTime(hz, Math.max(when, this.ac.currentTime), 1.8); // a slow glide between chords
      }
    });
    this.chord = index;
  }

  setStage(stage: StageId | null): void {
    const s = stage ?? 'nursery';
    if (s === this.stage && this.started) return;
    this.stage = s;
    this.music = STAGE_MUSIC[s];
    this.feel = STAGE_FEEL[s];
    this.rng = new Rng(this.seed * 31 + s.length * 7 + s.charCodeAt(0));
    this.chord = 0;
    // not started yet: the drone and pad are created ON this stage's notes and level, and nothing may be scheduled on top of
    // them at the same instant (a second setTargetAtTime at the instant of the first restarts from the oscillator's default
    // 440 Hz in Chromium and the whole score glides down into key over several seconds: measured)
    if (!this.started) {
      this.ensureStarted();
      return;
    }
    const now = this.ac.currentTime;
    this.padWet?.gain.setTargetAtTime(0.6 * this.feel.space, now, 0.8);
    this.cancelPitch(now);
    this.setStageNotes(now, false);
    this.setChord(0, false, now);
  }

  /** Forget every pitch change queued from `t` on (the old stage's chords, planned a little ahead) before a new stage's are set. */
  private cancelPitch(t: number): void {
    const d = this.drone;
    if (!d) return;
    for (const o of [d.root, d.fifth[0], d.fifth[1], d.sub, d.shimmer, d.cluster])
      o.frequency.cancelScheduledValues(t);
    for (const v of this.padVoices) for (const o of v.oscs) o.frequency.cancelScheduledValues(t);
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  per-frame
   * ------------------------------------------------------------------------------------------------ */
  update(scene: AudioScene, dt: number): void {
    // the stage first: the drone must start in the stage's own key, not glide there from the default's
    if (scene.stage && scene.stage !== this.stage) this.setStage(scene.stage);
    this.ensureStarted();
    const ac = this.ac;
    const now = ac.currentTime;
    this.phase = scene.phase;
    this.timeScale = clamp(scene.timeScale, 0.3, 1);
    // smooth intensity up quickly, down slowly: a fight should stay tense for a moment after the last exchange
    const target = scene.phase === 'fight' || scene.phase === 'attract' ? clamp01(scene.intensity) : 0;
    const k = target > this.intensity ? 1 - Math.exp(-dt / 0.35) : 1 - Math.exp(-dt / 2.2);
    this.intensity += (target - this.intensity) * k;
    // tension ramps in below ~32% integrity and is full at ~10% (lowestIntegrity is the weaker titan's 0..1 integrity)
    this.lowIntegrity =
      scene.phase === 'fight' || scene.phase === 'attract'
        ? clamp01((0.32 - scene.lowestIntegrity) / 0.22)
        : 0;
    this.applyMix(now);
    this.scheduleUntil(now + LOOKAHEAD);
    this.lastUpdate = now;
  }

  private applyMix(now: number): void {
    const d = this.drone;
    if (!d || !this.padGain || !this.padFilter) return;
    const I = this.intensity;
    const menu = this.phase === 'menu' || this.phase === 'results';
    const paused = this.phase === 'pause';
    const swell = now < this.swellUntil ? 1 : 0;
    const f = this.feel;
    const droneG = (menu ? 0.085 : 0.1 - 0.025 * I) * (paused ? 0.5 : 1) * f.body;
    const padG = (menu ? 0.035 : 0.04 + 0.03 * I + 0.03 * swell) * (paused ? 0.5 : 1) * f.pad;
    d.gain.gain.setTargetAtTime(droneG, now, 0.5);
    this.padGain.gain.setTargetAtTime(padG, now, 0.6);
    // tension: the whole score darkens/thins and the cluster note creeps in as integrity falls
    const tense = Math.max(this.lowIntegrity, f.tension);
    const ts = 0.35 + 0.65 * this.timeScale; // slow-motion pulls pitch down like a tape slowing
    d.filter.frequency.setTargetAtTime((300 + 900 * I) * (1 - 0.35 * tense) * ts * f.dark, now, 0.4);
    d.clusterGain.gain.setTargetAtTime(0.25 * tense, now, 0.8);
    for (const o of [d.root, d.fifth[0], d.fifth[1], d.sub, d.shimmer, d.cluster])
      o.detune.setTargetAtTime(1200 * Math.log2(ts) - 25 * tense, now, 0.15);
    this.padFilter.frequency.setTargetAtTime((700 + 1800 * I) * ts * f.dark, now, 0.5);
    for (const v of this.padVoices) {
      v.oscs[0].detune.setTargetAtTime(-6 + 1200 * Math.log2(ts) - 40 * tense, now, 0.3);
      v.oscs[1].detune.setTargetAtTime(6 + 1200 * Math.log2(ts) - 40 * tense, now, 0.3);
    }
  }

  /** Schedule every step whose time falls before `horizon`. Public so offline renders can pre-schedule a whole clip. */
  scheduleUntil(horizon: number): void {
    if (!this.started) this.ensureStarted();
    const now = this.ac.currentTime;
    if (this.nextTime < now) this.nextTime = now + 0.02;
    while (this.nextTime < horizon) {
      this.scheduleStep(this.step, this.nextTime);
      this.nextTime += stepSeconds(this.music.bpm, this.intensity, this.timeScale);
      this.step++;
    }
  }

  private scheduleStep(step: number, t: number): void {
    if (step > 0 && step % (STEPS_PER_BAR * CHORD_BARS) === 0)
      this.setChord(nextChord(this.chord, this.music.chords.length, this.rng), false, t);
    const plan = planStep(
      step,
      {
        intensity: this.intensity,
        lowIntegrity: this.lowIntegrity,
        phase: this.phase,
        density: this.feel.density,
        motes: this.feel.motes,
      },
      this.rng,
    );
    const pan = (this.rng.next() - 0.5) * 0.3;
    if (plan.sub > 0) {
      // `this.c` is the MUSIC voice context (its dry/wet are the music bus and send), so these voices sit in the music mix
      const o = makeOut(this.c, 0, 0);
      thump(
        this.c,
        o,
        t,
        midiToHz(this.music.root + 12) * 1.0,
        midiToHz(this.music.root - 12) * 1.0,
        0.42,
        0.34 * plan.sub,
      );
    }
    if (plan.taiko > 0) this.taiko(t, plan.taiko, plan.taikoTune, pan);
    if (plan.perc > 0) this.perc(t, plan.perc, pan * 2);
    if (plan.pulse > 0) this.heartbeat(t, plan.pulse);
    if (plan.bell >= 0) this.bell(t, plan.bell);
  }

  private taiko(t: number, v: number, tune: 0 | 1 | 2, pan: number): void {
    // tuned to the stage's key: root, fifth, octave (D2 A2 D3 on the Nursery), never a note the drone is not playing
    const m = this.music;
    const f = midiToHz([m.root, fifthOf(m), m.root + 12][tune]!); // the fifth is the one the drone plays
    const o = makeOut(this.c, pan, 0.5);
    tone(this.c, o, t, { f0: f * 1.9, f1: f, dur: 0.55, gain: 0.3 * v, attack: 0.002, glide: 0.09 });
    tone(this.c, o, t, {
      f0: f,
      f1: f * 0.5, // an octave drop: the body of the drum stays on the same note
      dur: 0.3,
      gain: 0.12 * v,
      type: 'triangle',
      attack: 0.002,
    });
    noiseHit(this.c, o, t, {
      dur: 0.09,
      gain: 0.16 * v,
      filter: { type: 'bandpass', f0: 260, q: 1.1 },
      attack: 0.001,
    });
  }

  private perc(t: number, v: number, pan: number): void {
    const o = makeOut(this.c, clamp(pan, -1, 1), 0.3);
    noiseHit(this.c, o, t, {
      dur: 0.05 + this.rng.next() * 0.05,
      gain: 0.07 * v,
      filter: { type: 'highpass', f0: 5500 + this.rng.next() * 3000, q: 0.8 },
      attack: 0.001,
    });
  }

  private heartbeat(t: number, v: number): void {
    const o = makeOut(this.c, 0, 0.1);
    thump(this.c, o, t, midiToHz(this.music.root + 12), midiToHz(this.music.root), 0.24, 0.45 * v);
  }

  private bell(t: number, degree: number): void {
    // a note of the stage's own scale (not a fixed pentatonic: it would leave the key on the whole-tone and Phrygian stages)
    const hz = degreeToHz(this.music.root + 36, this.music.mode, degree);
    const o = makeOut(this.c, (this.rng.next() - 0.5) * 1.2, Math.min(0.95, 0.7 * this.feel.space));
    partials(this.c, o, t, hz, GLASS, { decay: 2.2, gain: 0.05, shimmer: 0.3 });
  }

  /* ------------------------------------------------------------------------------------------------ *
   *  round transitions
   * ------------------------------------------------------------------------------------------------ */
  /** A KO is a hush: the score closes down. A round/match end resolves into an open, bright chord. */
  roundEvent(phase: 'intro' | 'fight' | 'ko' | 'timeover' | 'end' | 'match', t: number): void {
    this.ensureStarted();
    const d = this.drone;
    if (!d || !this.padFilter) return;
    if (phase === 'ko' || phase === 'timeover') {
      d.filter.frequency.cancelScheduledValues(t);
      d.filter.frequency.setTargetAtTime(160, t, 0.12);
      this.swellUntil = 0;
    } else if (phase === 'end' || phase === 'match') {
      this.swellUntil = t + (phase === 'match' ? 6 : 3.5);
      this.setChord(0, false, t);
      // resolve: an open fifth + octave + the third bloom over the pad, and the tension drains away
      const o = makeOut(this.c, 0, 0.9);
      for (const [i, deg] of [0, 2, 4, 7].entries())
        tone(this.c, o, t, {
          f0: degreeToHz(this.music.root + 24, this.music.mode, deg),
          dur: phase === 'match' ? 5.5 : 3.4,
          gain: 0.05,
          attack: 1.4,
          detune: (i - 1.5) * 4,
        });
      thump(
        this.c,
        makeOut(this.c, 0, 0),
        t,
        midiToHz(this.music.root + 12),
        midiToHz(this.music.root - 12),
        1.4,
        0.35,
      );
    } else if (phase === 'intro') {
      const o = makeOut(this.c, 0, 0.7);
      tone(this.c, o, t, {
        f0: midiToHz(this.music.root + 12),
        f1: midiToHz(this.music.root + 24),
        dur: 1.8,
        gain: 0.08,
        attack: 1.5,
        type: 'triangle',
      });
    }
  }

  reseed(seed: number): void {
    this.rng = new Rng(seed);
    this.step = 0;
    this.chord = 0;
  }

  dispose(): void {
    const stop = (o: OscillatorNode | undefined): void => {
      try {
        o?.stop();
      } catch {
        /* already stopped */
      }
    };
    const d = this.drone;
    if (d) {
      for (const o of [d.root, d.fifth[0], d.fifth[1], d.sub, d.shimmer, d.cluster, d.lfo]) stop(o);
      d.gain.disconnect();
    }
    for (const v of this.padVoices) for (const o of v.oscs) stop(o);
    this.padGain?.disconnect();
    this.drone = null;
    this.padVoices = [];
    this.started = false;
  }

  /** Seconds of score scheduled ahead of the audio clock (diagnostics). */
  get scheduledAhead(): number {
    return this.nextTime - this.ac.currentTime;
  }
  get bpm(): number {
    return this.music.bpm;
  }
  get lastUpdateTime(): number {
    return this.lastUpdate;
  }
}
