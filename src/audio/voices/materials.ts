import { clamp, clamp01 } from '../dsp/math';
import { bubbles, scrape } from './kit';
import {
  BELL,
  IRON,
  TINK,
  envelope,
  gravel,
  makeOut,
  noiseHit,
  partials,
  tone,
  type Out,
  type PartialSet,
} from './synth';
import type { VoiceCtx } from './types';
import { lowBell, roar, swell, whoosh } from './epic';

/**
 * The slice's MATERIAL voices (Phase 2): what the Witness and the Planet are made of, as sound. Built on the synth primitives
 * (same scheduling rules: every envelope up front, in time order). Each takes a `res` — the body's RESONANCE state — so damage
 * changes how it rings: a hollowed body rings lower, longer and more out of tune (`resonance()`).
 *
 * Witness (ceramic, stone, filament, sacred metal): ceramicFracture, stoneShear, filamentSnap, strainedMetal, wrongHarmonics.
 * Planet (rock, pressure, air, magma, moons): tectonicCrack, subPressure, atmosphericTear, magmaVent (moon impacts live in
 * planet.ts: a slam plus the orbital bell).
 * Arena (the Shearfield's comets, src/sim/hazards.ts): cometWarn, cometEnter.
 */

/** How a damaged body rings: pitch ×, decay ×, out-of-tune spread (0..1) and a "hollow" share (0..1) for cavity modes. */
export interface Resonance {
  pitch: number;
  decay: number;
  spread: number;
  hollow: number;
}

/** From remaining mass (0..1+) and how damaged the struck spot was (0..1): the less body, the lower, longer and wronger it rings. */
export function resonance(massFrac: number, onDamaged = 0): Resonance {
  const lost = clamp01(1 - massFrac);
  const local = clamp01(onDamaged);
  return {
    pitch: 1 - 0.28 * lost - 0.08 * local,
    decay: 1 + 1.3 * lost + 0.4 * local,
    spread: clamp01(0.15 + 0.7 * lost + 0.3 * local),
    hollow: clamp01(lost * 1.2 + local * 0.3),
  };
}

/** Partials that are NOT a harmonic series and drift further from it as `spread` grows: sacred bells made wrong. */
export function wrongSet(spread: number): PartialSet {
  const s = clamp01(spread);
  return {
    ratios: [1, 2.0 + 0.31 * s, 3.0 - 0.17 * s, 4.0 + 0.52 * s, 5.0 + 0.89 * s],
    amps: [1, 0.6, 0.45, 0.3, 0.2],
    decays: [1, 0.85, 0.7, 0.5, 0.35],
  };
}

/**
 * Ceramic fracture at the scale of a cathedral: two-four dark cracks, a fired-clay plate ringing LOW (a tink set on 180–300 Hz),
 * and a shower of shards low-passed under 2.4 kHz; louder and lower when hollowed. (It was a 4–7 kHz click and a 6.5 kHz shard
 * shower: china, not a colossus.)
 */
export function ceramicFracture(c: VoiceCtx, o: Out, t: number, mag: number, res: Resonance): void {
  const m = clamp01(mag);
  for (let i = 0; i < 2 + Math.round(m * 2); i++)
    noiseHit(c, o, t + i * (0.006 + c.rand() * 0.025), {
      dur: 0.03,
      gain: 0.45 + 0.4 * m,
      filter: { type: 'bandpass', f0: (1200 + c.rand() * 700) * res.pitch, q: 1.1 },
      filter2: { type: 'lowpass', f0: 2800 },
      attack: 0.0006,
    });
  partials(c, o, t + 0.003, (180 + 120 * c.rand()) * res.pitch, TINK, {
    decay: 0.35 * res.decay,
    gain: 0.08 + 0.08 * m,
    maxHz: 1500,
  });
  gravel(c, o, t + 0.01, {
    dur: 0.3 + 0.4 * m,
    grains: 10 + Math.round(m * 18),
    f: 1300 * res.pitch,
    spread: 1.6,
    gain: 0.32 + 0.3 * m,
    q: 1.6,
    lowpass: 2800,
  });
}

/** Stone shear: a slab the size of a mountain dragging over another — low grinding gravel and a band of noise sliding down. */
export function stoneShear(c: VoiceCtx, o: Out, t: number, mag: number, res: Resonance): void {
  const m = clamp01(mag);
  const dur = 0.45 + 0.55 * m;
  gravel(c, o, t, {
    dur,
    grains: 16 + Math.round(m * 22),
    f: 520 * res.pitch,
    spread: 2.2,
    gain: 0.2 + 0.2 * m,
    q: 1.2,
    lowpass: 1600,
  });
  scrape(c, o, t, {
    dur,
    f0: 800 * res.pitch,
    f1: 180 * res.pitch,
    q: 1.4,
    gain: 0.16 + 0.16 * m,
    rate: 8,
    depth: 0.6,
    attack: 0.04,
  });
}

/**
 * Taut filament snap: a plucked string (Karplus–Strong, rendered once per pitch into a buffer) released with a pitch that
 * drops as the tension goes, over a sharp click. The Witness's filaments and severed arms.
 */
const ksCache = new WeakMap<BaseAudioContext, Map<number, AudioBuffer>>();
function ksBuffer(c: VoiceCtx, hz: number): AudioBuffer {
  const key = Math.round(hz / 10) * 10;
  let m = ksCache.get(c.ac);
  if (!m) {
    m = new Map();
    ksCache.set(c.ac, m);
  }
  let b = m.get(key);
  if (!b) {
    const sr = c.ac.sampleRate;
    const n = Math.ceil(sr * 0.9);
    b = c.ac.createBuffer(1, n, sr);
    const y = b.getChannelData(0);
    const L = Math.max(2, Math.round(sr / key));
    // deterministic excitation (an LCG on the key), a bright pluck; the loop filter's damping sets the ring
    let s = (key * 2654435761) >>> 0;
    for (let i = 0; i < L; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      y[i] = (s / 4294967296) * 2 - 1;
    }
    for (let i = L; i < n; i++) y[i] = 0.4985 * (y[i - L]! + y[i - L + 1]!);
    m.set(key, b);
  }
  return b;
}
export function filamentSnap(c: VoiceCtx, o: Out, t: number, hz: number, mag: number, res: Resonance): void {
  const m = clamp01(mag);
  const ac = c.ac;
  const src = ac.createBufferSource();
  // a cable the size of a ridge: the pluck is LOW (40–400 Hz), its bright excitation rounded off by a low-pass
  src.buffer = ksBuffer(c, clamp(hz * res.pitch, 40, 400));
  src.playbackRate.setValueAtTime(1.06, t);
  src.playbackRate.exponentialRampToValueAtTime(0.88, t + 0.35);
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1400;
  lp.Q.value = 0.6;
  const g = ac.createGain();
  envelope(g, t, 0.22 + 0.14 * m, 0.001, Math.min(0.88, 0.8 * res.decay));
  src.connect(lp);
  lp.connect(g);
  g.connect(o.input);
  src.start(t);
  src.stop(t + Math.min(0.9, 0.8 * res.decay) + 0.05);
  noiseHit(c, o, t, {
    dur: 0.03,
    gain: 0.22 + 0.12 * m,
    filter: { type: 'bandpass', f0: 1100, q: 1 },
    filter2: { type: 'lowpass', f0: 2200 },
    attack: 0.0005,
  });
}

/** Strained sacred metal: a bell set that sags out of tune under load, bowed by a narrow band of noise. */
export function strainedMetal(
  c: VoiceCtx,
  o: Out,
  t: number,
  dur: number,
  f: number,
  gain: number,
  res: Resonance,
): void {
  const set = res.spread > 0.4 ? wrongSet(res.spread) : IRON;
  for (let i = 0; i < 4; i++) {
    const fi = f * res.pitch * set.ratios[i]!;
    tone(c, o, t, {
      f0: fi,
      f1: fi * (0.985 - 0.01 * res.spread),
      dur: dur * set.decays[i]!,
      gain: gain * set.amps[i]!,
      attack: dur * 0.35,
      glide: dur,
    });
  }
  scrape(c, o, t, {
    dur,
    f0: f * 1.9,
    f1: f * 1.7,
    q: 9,
    gain: gain * 0.9,
    rate: 6 + 4 * res.spread,
    depth: 0.45,
    attack: dur * 0.4,
  });
}

/** Wrong harmonics: a sacred chord whose overtones are subtly, then badly, out of their series. */
export function wrongHarmonics(
  c: VoiceCtx,
  o: Out,
  t: number,
  f: number,
  gain: number,
  res: Resonance,
): void {
  partials(c, o, t, f * res.pitch, wrongSet(res.spread), {
    decay: 1.1 * res.decay,
    gain,
    shimmer: 0.25 + 0.3 * res.spread,
    maxHz: 1500,
  });
}

/** Tectonic crack: a snap through the crust, rubble, and a groan that leans down after it. */
export function tectonicCrack(c: VoiceCtx, o: Out, t: number, mag: number, res: Resonance): void {
  const m = clamp01(mag);
  noiseHit(c, o, t, {
    dur: 0.05,
    gain: 0.2 + 0.1 * m,
    filter: { type: 'bandpass', f0: 800, q: 0.9 },
    filter2: { type: 'lowpass', f0: 1800 },
    attack: 0.0006,
  });
  gravel(c, o, t + 0.005, {
    dur: 0.4 + 0.4 * m,
    grains: 14 + Math.round(20 * m),
    f: 420 * res.pitch,
    spread: 2.2,
    gain: 0.2 + 0.12 * m,
    q: 1,
    lowpass: 1300,
  });
  const ac = c.ac;
  const osc = ac.createOscillator();
  osc.type = 'sawtooth';
  const f0 = 92 * res.pitch;
  osc.frequency.setValueAtTime(f0, t + 0.02);
  osc.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + 0.9 + 0.6 * m);
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 260;
  lp.Q.value = 2;
  const g = ac.createGain();
  envelope(g, t + 0.02, 0.06 + 0.06 * m, 0.08, 0.9 + 0.6 * m);
  osc.connect(lp);
  lp.connect(g);
  g.connect(o.input);
  osc.start(t + 0.02);
  osc.stop(t + 1.6 + 0.6 * m);
}

/** Sub pressure: a swelling low weight (its body in the 80–160 Hz band so a laptop carries it) before something gives. */
export function subPressure(c: VoiceCtx, t: number, pan: number, dur: number, gain: number): void {
  const o = makeOut(c, pan * 0.3, 0);
  tone(c, o, t, { f0: 52, f1: 46, dur, gain: gain * 0.6, attack: dur * 0.7 });
  tone(c, o, t, { type: 'triangle', f0: 104, f1: 92, dur, gain: gain * 0.5, attack: dur * 0.7 });
  noiseHit(c, o, t, {
    dur,
    gain: gain * 0.7,
    kind: 'brown',
    filter: { type: 'bandpass', f0: 90, f1: 150, q: 1.2 },
    attack: dur * 0.75,
  });
}

/**
 * Atmospheric tear: a world's air ripped away into space — a roar of wind that rises and is gone, with a heaving flutter, and a
 * low exhale after it. (It was a 0.5→3.6 kHz sweep and a 4 kHz hiss.)
 */
export function atmosphericTear(c: VoiceCtx, o: Out, t: number, mag: number): void {
  const m = clamp01(mag);
  const dur = 0.7 + 0.7 * m;
  scrape(c, o, t, {
    dur,
    f0: 180,
    f1: 900,
    q: 0.9,
    gain: 0.1 + 0.1 * m,
    rate: 6 + 5 * m,
    depth: 0.6,
    attack: 0.08,
  });
  noiseHit(c, o, t + dur * 0.6, {
    dur: 1.2,
    gain: 0.08 + 0.05 * m,
    kind: 'brown',
    filter: { type: 'lowpass', f0: 600, f1: 120, q: 0.7 },
    attack: 0.12,
  });
}

/** Magma vent: a deep roiling rumble, slow heavy blurps of molten rock, and a low exhale of gas in bursts. */
export function magmaVent(c: VoiceCtx, o: Out, t: number, dur: number, mag: number): void {
  const m = clamp01(mag);
  noiseHit(c, o, t, {
    dur,
    gain: 0.12 + 0.08 * m,
    kind: 'brown',
    filter: { type: 'lowpass', f0: 360, f1: 140, q: 1 },
    attack: 0.15,
  });
  bubbles(c, o, t + 0.05, { dur: dur * 0.9, count: 6 + Math.round(10 * m), f: 60, gain: 0.07 + 0.04 * m });
  scrape(c, o, t + 0.1, {
    dur: dur * 0.8,
    f0: 520,
    f1: 260,
    q: 0.8,
    gain: 0.06 + 0.04 * m,
    rate: 3,
    depth: 0.9,
    attack: 0.08,
    kind: 'brown',
  });
}

/**
 * Arena comet warning: something enormous is coming, from the side it will come in — a low pressure swell over the warning time
 * and a far, dark bell tolling twice. (It was a thin 1.8→5.2 kHz riser with two 3 kHz glints.)
 */
export function cometWarn(c: VoiceCtx, t: number, pan: number, dur: number): void {
  const o = makeOut(c, clamp(pan, -1, 1) * 0.8, 0.5);
  swell(c, o, t, { dur, gain: 0.12, f0: 80, f1: 600, sub: 0.05, subHz: 38 });
  lowBell(c, o, t, 98, BELL, { decay: 1.2, gain: 0.05 });
  lowBell(c, o, t + dur * 0.55, 98, BELL, { decay: 1, gain: 0.065 });
}

/** Arena comet entry: a long roaring pass across the field in its direction of travel over the rumble of its mass. */
export function cometEnter(c: VoiceCtx, t: number, pan: number, dirX: number, speed: number): void {
  const k = clamp01((speed - 150) / 120);
  const p = clamp(pan, -1, 1);
  whoosh(c, t, {
    dur: 1.3,
    gain: 0.12 + 0.06 * k,
    panFrom: p,
    panTo: clamp(p + Math.sign(dirX || 1) * 0.9, -1, 1),
    wet: 0.45,
    f0: 700 + 300 * k,
    f1: 120,
    body: 1.1,
  });
  roar(c, makeOut(c, p * 0.5, 0.3), t, {
    f: 46,
    f1: 34,
    dur: 1.4,
    gain: 0.07,
    attack: 0.5,
    lp0: 400,
    lp1: 160,
  });
}
