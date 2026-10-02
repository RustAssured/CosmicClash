import { clamp, clamp01 } from '../dsp/math';
import { bubbles, scrape } from './kit';
import {
  IRON,
  TINK,
  envelope,
  gravel,
  makeOut,
  noiseHit,
  partials,
  riser,
  tone,
  whistlePass,
  type Out,
  type PartialSet,
} from './synth';
import type { VoiceCtx } from './types';

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

/** Ceramic fracture: two-four hard clicks, a tink set, and a short shower of high shards; louder and lower when hollowed. */
export function ceramicFracture(c: VoiceCtx, o: Out, t: number, mag: number, res: Resonance): void {
  const m = clamp01(mag);
  for (let i = 0; i < 2 + Math.round(m * 2); i++)
    noiseHit(c, o, t + i * (0.004 + c.rand() * 0.02), {
      dur: 0.01,
      gain: 0.12 + 0.12 * m,
      filter: { type: 'highpass', f0: 4200 + c.rand() * 2500, q: 0.7 },
      attack: 0.0004,
    });
  partials(c, o, t + 0.003, (1600 + 900 * c.rand()) * res.pitch, TINK, {
    decay: 0.12 * res.decay,
    gain: 0.05 + 0.05 * m,
  });
  gravel(c, o, t + 0.01, {
    dur: 0.25 + 0.35 * m,
    grains: 10 + Math.round(m * 18),
    f: 6500 * res.pitch,
    spread: 1.4,
    gain: 0.07 + 0.08 * m,
    q: 2.6,
  });
}

/** Stone shear: a slab dragging over a slab — grinding gravel and a band of noise sliding down. */
export function stoneShear(c: VoiceCtx, o: Out, t: number, mag: number, res: Resonance): void {
  const m = clamp01(mag);
  const dur = 0.35 + 0.45 * m;
  gravel(c, o, t, {
    dur,
    grains: 16 + Math.round(m * 22),
    f: 900 * res.pitch,
    spread: 2.2,
    gain: 0.08 + 0.1 * m,
    q: 1.2,
    lowpass: 2600,
  });
  scrape(c, o, t, {
    dur,
    f0: 1400 * res.pitch,
    f1: 320 * res.pitch,
    q: 1.6,
    gain: 0.05 + 0.07 * m,
    rate: 11,
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
  src.buffer = ksBuffer(c, clamp(hz * res.pitch, 120, 2400));
  src.playbackRate.setValueAtTime(1.06, t);
  src.playbackRate.exponentialRampToValueAtTime(0.94, t + 0.25);
  const g = ac.createGain();
  envelope(g, t, 0.16 + 0.12 * m, 0.001, 0.7 * res.decay);
  src.connect(g);
  g.connect(o.input);
  src.start(t);
  src.stop(t + Math.min(0.9, 0.7 * res.decay) + 0.05);
  noiseHit(c, o, t, {
    dur: 0.008,
    gain: 0.25 + 0.15 * m,
    filter: { type: 'highpass', f0: 5000 },
    attack: 0.0003,
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
    maxHz: 9000,
  });
}

/** Tectonic crack: a snap through the crust, rubble, and a groan that leans down after it. */
export function tectonicCrack(c: VoiceCtx, o: Out, t: number, mag: number, res: Resonance): void {
  const m = clamp01(mag);
  noiseHit(c, o, t, {
    dur: 0.04,
    gain: 0.18 + 0.1 * m,
    filter: { type: 'highpass', f0: 1400 },
    attack: 0.0005,
  });
  gravel(c, o, t + 0.005, {
    dur: 0.4 + 0.4 * m,
    grains: 14 + Math.round(20 * m),
    f: 380 * res.pitch,
    spread: 2.2,
    gain: 0.12 + 0.08 * m,
    q: 1,
    lowpass: 900,
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

/** Atmospheric tear: air ripped away — a band of noise sweeping up with a flutter that speeds up, and a thin hiss after. */
export function atmosphericTear(c: VoiceCtx, o: Out, t: number, mag: number): void {
  const m = clamp01(mag);
  const dur = 0.6 + 0.6 * m;
  scrape(c, o, t, {
    dur,
    f0: 500,
    f1: 3600,
    q: 1.1,
    gain: 0.08 + 0.08 * m,
    rate: 14 + 10 * m,
    depth: 0.7,
    attack: 0.05,
  });
  noiseHit(c, o, t + dur * 0.6, {
    dur: 0.9,
    gain: 0.04 + 0.03 * m,
    filter: { type: 'highpass', f0: 4000, q: 0.6 },
    attack: 0.1,
  });
}

/** Magma vent: a deep roiling rumble, bubbling, and a hiss of steam that comes in bursts. */
export function magmaVent(c: VoiceCtx, o: Out, t: number, dur: number, mag: number): void {
  const m = clamp01(mag);
  noiseHit(c, o, t, {
    dur,
    gain: 0.1 + 0.08 * m,
    kind: 'brown',
    filter: { type: 'lowpass', f0: 420, f1: 180, q: 1 },
    attack: 0.15,
  });
  bubbles(c, o, t + 0.05, { dur: dur * 0.9, count: 10 + Math.round(16 * m), f: 140, gain: 0.05 + 0.04 * m });
  scrape(c, o, t + 0.1, {
    dur: dur * 0.8,
    f0: 3200,
    f1: 2200,
    q: 0.8,
    gain: 0.03 + 0.03 * m,
    rate: 5,
    depth: 0.9,
    attack: 0.08,
  });
}

/** Arena comet warning: a thin icy riser over the warning time with two high glints, from the side it will come in. */
export function cometWarn(c: VoiceCtx, t: number, pan: number, dur: number): void {
  const o = makeOut(c, clamp(pan, -1, 1) * 0.8, 0.35);
  riser(c, o, t, dur, 0.045, 1800, 5200);
  partials(c, o, t, 2900, TINK, { decay: 0.35, gain: 0.035 });
  partials(c, o, t + dur * 0.55, 3400, TINK, { decay: 0.3, gain: 0.045 });
}

/** Arena comet entry: a long airy pass across the field in its direction of travel over a low rumble of its mass. */
export function cometEnter(c: VoiceCtx, t: number, pan: number, dirX: number, speed: number): void {
  const k = clamp01((speed - 150) / 120);
  const p = clamp(pan, -1, 1);
  whistlePass(c, t, {
    f: 820 + 260 * k,
    dur: 1.3,
    gain: 0.06 + 0.03 * k,
    panFrom: p,
    panTo: clamp(p + Math.sign(dirX || 1) * 0.9, -1, 1),
    wet: 0.35,
  });
  noiseHit(c, makeOut(c, p * 0.5, 0.2), t, {
    dur: 1.1,
    gain: 0.08,
    kind: 'brown',
    filter: { type: 'lowpass', f0: 220, f1: 120, q: 0.9 },
    attack: 0.2,
  });
}
