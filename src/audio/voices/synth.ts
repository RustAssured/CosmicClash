import { clamp } from '../dsp/math';
import type { VoiceCtx } from './types';

/**
 * Synthesis primitives shared by every voice. Each takes an output `Out` (a panned dry+reverb tap), a start time `t` and
 * musical parameters, builds a few nodes, schedules their envelopes and lets them end on their own. All envelopes are
 * exponential with a tiny linear attack (no clicks); `stop()` times leave a margin so tails are never truncated.
 */
export interface Out {
  /** Connect sources here. */
  input: AudioNode;
  /** Disconnect the whole tap. */
  close(): void;
}

const NEVER = 1e-4;
/** Shortest grain / guard gap between grains in `gravel` (seconds). */
const GRAIN_MIN = 0.0015;
const GRAIN_GAP = 0.0004;

/** A panned tap: input → panner → dry bus and (level `wet`) → reverb send. */
export function makeOut(c: VoiceCtx, pan: number, wet: number, gain = 1): Out {
  const ac = c.ac;
  const g = ac.createGain();
  g.gain.value = gain;
  const p = ac.createStereoPanner();
  p.pan.value = clamp(pan, -1, 1);
  g.connect(p);
  p.connect(c.dry);
  let w: GainNode | null = null;
  if (wet > 0.001) {
    w = ac.createGain();
    w.gain.value = wet;
    p.connect(w);
    w.connect(c.wet);
  }
  return {
    input: g,
    close(): void {
      g.disconnect();
      p.disconnect();
      w?.disconnect();
    },
  };
}

/** Close a tap when its longest source has finished. */
export function closeAfter(o: Out, src: AudioScheduledSourceNode | null): void {
  if (src) src.onended = () => o.close();
  else setTimeout(() => o.close(), 8000);
}

/** Exponential-decay gain envelope on a GainNode: 0 → peak over `a`, then to ~0 by `t + dur`. */
export function envelope(
  g: GainNode,
  t: number,
  peakGain: number,
  a: number,
  dur: number,
  curve: 'exp' | 'lin' = 'exp',
): void {
  const p = g.gain;
  // the attack must end strictly before the decay does: a ramp that ends after the one that follows it overlaps it, and
  // overlapping automation is undefined behaviour (see `gravel`)
  const att = Math.min(Math.max(0.001, a), Math.max(0.002, dur * 0.9));
  p.cancelScheduledValues(t);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(Math.max(NEVER, peakGain), t + att);
  if (curve === 'exp') p.exponentialRampToValueAtTime(NEVER, t + dur);
  else p.linearRampToValueAtTime(0, t + dur);
  p.setValueAtTime(0, t + dur + 0.005);
}

/** A source node for noise (white or brown) starting at a random point in the shared buffer. */
export function noiseSource(
  c: VoiceCtx,
  kind: 'white' | 'brown' = 'white',
  loop = false,
): AudioBufferSourceNode {
  const s = c.ac.createBufferSource();
  s.buffer = kind === 'white' ? c.noise : c.brown;
  s.loop = loop;
  return s;
}

const noiseOffset = (c: VoiceCtx, dur: number): number => c.rand() * Math.max(0, 2 - dur - 0.05);

/** A sine/triangle/saw/square tone with an optional exponential pitch glide and a decaying envelope. */
export function tone(
  c: VoiceCtx,
  o: Out,
  t: number,
  o1: {
    type?: OscillatorType;
    f0: number;
    f1?: number;
    dur: number;
    gain: number;
    attack?: number;
    detune?: number;
    glide?: number;
  },
): OscillatorNode {
  const ac = c.ac;
  const osc = ac.createOscillator();
  osc.type = o1.type ?? 'sine';
  osc.frequency.setValueAtTime(o1.f0, t);
  if (o1.f1 !== undefined && o1.f1 !== o1.f0)
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, o1.f1), t + (o1.glide ?? o1.dur));
  if (o1.detune) osc.detune.value = o1.detune;
  const g = ac.createGain();
  envelope(g, t, o1.gain, o1.attack ?? 0.004, o1.dur);
  osc.connect(g);
  g.connect(o.input);
  osc.start(t);
  osc.stop(t + o1.dur + 0.05);
  return osc;
}

/** Sub-bass impact: a sine that drops in pitch, plus a soft click. Never sent to the reverb (the caller's `Out` has wet 0). */
export function thump(
  c: VoiceCtx,
  o: Out,
  t: number,
  f0: number,
  f1: number,
  dur: number,
  gain: number,
): void {
  tone(c, o, t, { f0, f1, dur, gain, attack: 0.003, glide: dur * 0.6 });
  // a short filtered noise "knock" so the hit reads on small speakers that cannot reproduce the sub
  noiseHit(c, o, t, {
    dur: 0.05,
    gain: gain * 0.5,
    filter: { type: 'lowpass', f0: 900, f1: 200, q: 0.7 },
    attack: 0.001,
  });
}

export interface NoiseOpts {
  dur: number;
  gain: number;
  kind?: 'white' | 'brown';
  attack?: number;
  filter?: { type: BiquadFilterType; f0: number; f1?: number; q?: number };
  /** Optional second filter in series (e.g. highpass under a bandpass). */
  filter2?: { type: BiquadFilterType; f0: number; q?: number };
}

/** A shaped burst of noise. Returns the source so callers can chain `closeAfter`. */
export function noiseHit(c: VoiceCtx, o: Out, t: number, n: NoiseOpts): AudioBufferSourceNode {
  const ac = c.ac;
  const src = noiseSource(c, n.kind ?? 'white');
  const g = ac.createGain();
  envelope(g, t, n.gain, n.attack ?? 0.002, n.dur);
  let node: AudioNode = src;
  if (n.filter) {
    const f = ac.createBiquadFilter();
    f.type = n.filter.type;
    f.Q.value = n.filter.q ?? 0.8;
    f.frequency.setValueAtTime(n.filter.f0, t);
    if (n.filter.f1 !== undefined)
      f.frequency.exponentialRampToValueAtTime(Math.max(20, n.filter.f1), t + n.dur);
    node.connect(f);
    node = f;
  }
  if (n.filter2) {
    const f2 = ac.createBiquadFilter();
    f2.type = n.filter2.type;
    f2.frequency.value = n.filter2.f0;
    f2.Q.value = n.filter2.q ?? 0.7;
    node.connect(f2);
    node = f2;
  }
  node.connect(g);
  g.connect(o.input);
  src.start(t, noiseOffset(c, n.dur));
  src.stop(t + n.dur + 0.05);
  return src;
}

export interface PartialSet {
  /** Frequency ratios relative to the fundamental. */
  ratios: readonly number[];
  /** Relative amplitudes and relative decay multipliers (1 = the base decay). */
  amps: readonly number[];
  decays: readonly number[];
}

/** Glassy / ceramic bell: inharmonic partials (roughly a struck glass bowl). */
export const GLASS: PartialSet = {
  ratios: [1, 2.32, 4.25, 6.63, 9.38],
  amps: [1, 0.55, 0.32, 0.18, 0.09],
  decays: [1, 0.7, 0.5, 0.35, 0.25],
};
/** Struck iron / nickel plate: lower, denser, slightly out of tune. */
export const IRON: PartialSet = {
  ratios: [1, 2.41, 4.52, 6.93, 9.7],
  amps: [1, 0.7, 0.45, 0.28, 0.16],
  decays: [1, 0.8, 0.6, 0.45, 0.3],
};
/** Ceramic "tink": a short bar mode set. */
export const TINK: PartialSet = {
  ratios: [1, 2.76, 5.4, 8.93],
  amps: [1, 0.6, 0.35, 0.2],
  decays: [1, 0.55, 0.3, 0.18],
};

/** Sum of decaying sine partials — bells, glass, plates. `shimmer` adds a detuned twin of the fundamental for beating. */
export function partials(
  c: VoiceCtx,
  o: Out,
  t: number,
  f: number,
  set: PartialSet,
  p: { decay: number; gain: number; attack?: number; shimmer?: number; maxHz?: number },
): AudioScheduledSourceNode | null {
  let last: AudioScheduledSourceNode | null = null;
  const maxHz = p.maxHz ?? 15000;
  for (let i = 0; i < set.ratios.length; i++) {
    const fi = f * set.ratios[i]!;
    if (fi > maxHz) break;
    const d = Math.max(0.03, p.decay * set.decays[i]!);
    last = tone(c, o, t, { f0: fi, dur: d, gain: p.gain * set.amps[i]!, attack: p.attack ?? 0.002 });
  }
  if (p.shimmer) {
    last = tone(c, o, t, { f0: f * 1.0042, dur: p.decay * 1.25, gain: p.gain * p.shimmer, attack: 0.01 });
    tone(c, o, t, { f0: f * 0.9958, dur: p.decay * 1.25, gain: p.gain * p.shimmer, attack: 0.01 });
  }
  return last;
}

/**
 * Granular gravel: ONE noise source through ONE bandpass and ONE gain whose automation is stepped in random short bursts
 * (and the filter centre hopped per grain) — the sound of many small rocks for the price of three nodes.
 *
 * The grains are laid out in time order and never overlap: each one's envelope ends before the next begins. That is not
 * tidiness, it is required. Overlapping `setValueAtTime` / ramp events on one AudioParam make Chromium's timeline evaluate
 * exponential ramps from the wrong start value, and the gain then explodes (peaks of 1e8 and beyond were measured with
 * ~30 overlapping grains); the burst went through the limiter as full-scale noise and the filters downstream went to NaN.
 */
export function gravel(
  c: VoiceCtx,
  o: Out,
  t: number,
  g0: {
    dur: number;
    grains: number;
    f: number;
    spread: number;
    gain: number;
    q?: number;
    decayShape?: number;
  },
): AudioBufferSourceNode {
  const ac = c.ac;
  const src = noiseSource(c, 'white');
  const f = ac.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = g0.q ?? 1.4;
  const gn = ac.createGain();
  gn.gain.setValueAtTime(0, t);
  const n = Math.max(1, g0.grains);
  const starts = new Float64Array(n);
  for (let i = 0; i < n; i++) starts[i] = t + Math.pow(c.rand(), 1 + (g0.decayShape ?? 1.6)) * g0.dur; // cluster early, thin out
  starts.sort();
  let clear = t; // the earliest time the next grain may start (previous grain's end + a guard)
  for (let i = 0; i < n; i++) {
    const u = i / Math.max(1, n - 1);
    const ts = Math.max(starts[i]!, clear);
    const next = i + 1 < n ? Math.max(starts[i + 1]!, ts + GRAIN_MIN) : ts + 0.05;
    const len = Math.min(0.004 + c.rand() * 0.016, next - ts - GRAIN_GAP);
    const amp = g0.gain * (0.35 + 0.65 * c.rand()) * (1 - u * 0.55);
    const hz = g0.f * Math.pow(2, (c.rand() - 0.5) * g0.spread);
    if (len < GRAIN_MIN || ts > t + g0.dur + 0.02) continue;
    f.frequency.setValueAtTime(hz, ts);
    gn.gain.setValueAtTime(0, ts);
    gn.gain.linearRampToValueAtTime(amp, ts + Math.min(0.0008, len * 0.4));
    gn.gain.exponentialRampToValueAtTime(NEVER, ts + len);
    clear = ts + len + GRAIN_GAP;
  }
  gn.gain.setValueAtTime(0, Math.max(clear, t + g0.dur) + 0.02);
  src.connect(f);
  f.connect(gn);
  gn.connect(o.input);
  src.start(t, noiseOffset(c, g0.dur));
  src.stop(Math.max(clear, t + g0.dur) + 0.08);
  return src;
}

/** Riser: filtered noise + a tone stack sweeping upward into a peak at `t + dur`, then cut. */
export function riser(
  c: VoiceCtx,
  o: Out,
  t: number,
  dur: number,
  gain: number,
  f0: number,
  f1: number,
): void {
  const ac = c.ac;
  const src = noiseSource(c, 'white');
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 2.2;
  bp.frequency.setValueAtTime(f0, t);
  bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + dur);
  g.gain.linearRampToValueAtTime(0, t + dur + 0.04);
  src.connect(bp);
  bp.connect(g);
  g.connect(o.input);
  src.start(t, noiseOffset(c, dur));
  src.stop(t + dur + 0.08);
}

/** Doppler-style whistle: a sine that falls in pitch as it passes while panning across the field. */
export function whistlePass(
  c: VoiceCtx,
  t: number,
  w: {
    f: number;
    dur: number;
    gain: number;
    panFrom: number;
    panTo: number;
    wet: number;
    approach?: number;
    recede?: number;
  },
): void {
  const ac = c.ac;
  const p = ac.createStereoPanner();
  p.pan.setValueAtTime(clamp(w.panFrom, -1, 1), t);
  p.pan.linearRampToValueAtTime(clamp(w.panTo, -1, 1), t + w.dur);
  p.connect(c.dry);
  if (w.wet > 0.001) {
    const wg = ac.createGain();
    wg.gain.value = w.wet;
    p.connect(wg);
    wg.connect(c.wet);
  }
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(w.gain, t + w.dur * 0.35);
  g.gain.linearRampToValueAtTime(0, t + w.dur);
  g.connect(p);

  const osc = ac.createOscillator();
  osc.type = 'sine';
  const a = w.approach ?? 1.35;
  const r = w.recede ?? 0.72;
  const n = 32;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // smooth step from the "approaching" pitch to the "receding" pitch, steepest at the pass-by
    const s = 0.5 + 0.5 * Math.tanh((i / (n - 1) - 0.5) * 6);
    curve[i] = w.f * (a + (r - a) * s);
  }
  osc.frequency.setValueCurveAtTime(curve, t, w.dur);
  osc.connect(g);

  // breath in the whistle
  const air = noiseSource(c, 'white');
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = w.f * 1.6;
  bp.Q.value = 6;
  const ag = ac.createGain();
  ag.gain.value = 0.25;
  air.connect(bp);
  bp.connect(ag);
  ag.connect(g);

  osc.start(t);
  osc.stop(t + w.dur + 0.05);
  air.start(t, noiseOffset(c, w.dur));
  air.stop(t + w.dur + 0.05);
  osc.onended = () => p.disconnect();
}

/** Random pick from an array using the voice RNG. */
export const pick = <T>(c: VoiceCtx, a: readonly T[]): T =>
  a[Math.min(a.length - 1, Math.floor(c.rand() * a.length))]!;
