import { clamp, clamp01 } from '../dsp/math';
import { envelope, noiseHit, noiseSource, partials, type Out, type PartialSet } from './synth';
import type { VoiceCtx } from './types';

/**
 * The cataclysm kit (D34: "more epic, cosmic and cataclysmic; drop the high-pitched sounds and whistles"). Building blocks for
 * sounds the size of moons and planets, on top of the primitives in synth.ts and under the same scheduling rules (every envelope
 * up front, in time order; nothing lands inside a pending ramp).
 *
 * Laptop speakers (D27) cannot play below ~150 Hz, and the output is high-passed at 50 Hz. "Huge" therefore has to be readable
 * in 80–250 Hz: every low body here goes through a SATURATOR (tanh), so a 40 Hz fundamental arrives with its 120/200/280 Hz
 * harmonics and the ear hears the fundamental that is not there (the missing-fundamental effect); on headphones the real sub is
 * still underneath. Nothing in this kit has a tonal body above ~1 kHz; air and grit are low-passed noise, never sine pings.
 *
 *  - `boom`      the tectonic drop: a pitch-dropping body, saturated, a knock and a dark transient (collapsing mass)
 *  - `rumble`    a long, dark, slowly heaving tail (the cavern after the blow)
 *  - `swell`     a reversed swell: pressure building INTO a hit, cut dead at its end
 *  - `whoosh`    a shockwave / mass passing: a low band of air sweeping down while it pans across
 *  - `roar`      a detuned cluster of low saws through a closing filter: beams, flares, gravity, the voice of a titan
 *  - `lowBell`   a struck colossal bell / plate / hull: inharmonic partials kept under ~1.6 kHz
 *  - `grind`     rock or metal dragging over itself (megastructures, chains, crust)
 *  - `crackle`   embers and fracture grit, low-passed (no hiss)
 *  - `hush`      the inhale of a KO: a falling swell that empties the space before the boom
 */

/** One tanh transfer curve per drive, shared by every saturator (a WaveShaper copies the curve it is given). */
const curves = new Map<number, Float32Array>();
export function saturationCurve(drive: number, n = 2048): Float32Array {
  const key = Math.round(drive * 10) / 10;
  let c = curves.get(key);
  if (!c) {
    c = new Float32Array(n);
    const norm = Math.tanh(key);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(key * x) / norm;
    }
    curves.set(key, c);
  }
  return c;
}

/** A saturator node (tanh at `drive`): the harmonics that make a sub audible on small speakers. */
export function saturator(c: VoiceCtx, drive: number): WaveShaperNode {
  const s = c.ac.createWaveShaper();
  s.curve = saturationCurve(drive) as Float32Array<ArrayBuffer>;
  return s;
}

export interface BoomOpts {
  /** Body pitch at the strike and where it falls to (Hz). */
  f0: number;
  f1: number;
  dur: number;
  gain: number;
  /** Saturation drive (1 = clean, 4 = heavily driven). */
  drive?: number;
  /** Level of the knock (the 80–250 Hz punch), the crunch (200–600 Hz) and the dark transient, relative to `gain`. */
  knock?: number;
  crunch?: number;
  click?: number;
}

/**
 * The tectonic drop: a sine and an octave triangle fall together from `f0` to `f1` (collapsing mass), through a saturator and a
 * low-pass that closes as it decays; a band of brown noise at 90–220 Hz is the knock; a short low-passed transient is the
 * contact. The saturator's harmonics carry the weight on laptops; on headphones the fundamental is still there.
 */
export function boom(c: VoiceCtx, o: Out, t: number, b: BoomOpts): OscillatorNode {
  const ac = c.ac;
  const drive = b.drive ?? 3;
  const mix = ac.createGain();
  // the sub and the growl sum to at most 0.9: keep the shaper's input inside ±1 (a WaveShaper clamps beyond it)
  envelope(mix, t, 0.9, 0.004, b.dur);
  const sh = saturator(c, drive);
  // the growl's filter closes as the mass settles: the drop is HEARD on a laptop (its harmonics fall from ~2 kHz to 600 Hz)
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.7;
  lp.frequency.setValueAtTime(2000, t);
  lp.frequency.exponentialRampToValueAtTime(560, t + b.dur * 0.7);
  const out = ac.createGain();
  out.gain.value = b.gain * 0.8;
  mix.connect(sh);
  sh.connect(lp);
  lp.connect(out);
  out.connect(o.input);
  // the fundamental (a sine: the real sub, for headphones) never sinks below ~32 Hz; the growl an octave above it is a saw, so
  // the saturator has partials to work with all the way up the laptop's range
  const glide = b.dur * 0.55;
  const body = ac.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(b.f0, t);
  body.frequency.exponentialRampToValueAtTime(Math.max(32, b.f1), t + glide);
  const oct = ac.createOscillator();
  oct.type = 'sawtooth';
  oct.frequency.setValueAtTime(b.f0 * 2, t);
  oct.frequency.exponentialRampToValueAtTime(Math.max(64, b.f1 * 2), t + glide * 0.8);
  const bg = ac.createGain();
  bg.gain.value = 0.45;
  const og = ac.createGain();
  og.gain.value = 0.45;
  body.connect(bg);
  bg.connect(mix);
  oct.connect(og);
  og.connect(mix);
  body.start(t);
  oct.start(t);
  body.stop(t + b.dur + 0.06);
  oct.stop(t + b.dur + 0.06);
  // the knock: what a laptop actually plays of the blow
  noiseHit(c, o, t, {
    dur: Math.min(0.36, 0.12 + b.dur * 0.2),
    gain: b.gain * (b.knock ?? 0.9),
    kind: 'brown',
    filter: { type: 'bandpass', f0: 360, f1: 140, q: 0.9 },
    attack: 0.002,
  });
  // the crunch of mass meeting mass: a short band of 250–900 Hz (the "body" a small speaker reads as size)
  noiseHit(c, o, t, {
    dur: Math.min(0.32, 0.1 + b.dur * 0.14),
    gain: b.gain * (b.crunch ?? 3.6),
    filter: { type: 'bandpass', f0: 900, f1: 300, q: 0.8 },
    filter2: { type: 'lowpass', f0: 1500, q: 0.6 },
    attack: 0.001,
  });
  // the contact: dark, no hiss
  noiseHit(c, o, t, {
    dur: 0.05,
    gain: b.gain * (b.click ?? 0.35),
    filter: { type: 'lowpass', f0: 1400, f1: 300, q: 0.7 },
    attack: 0.001,
  });
  return body;
}

/** A long, dark, slowly heaving tail: brown noise in a band that sinks from `f0` to `f1`, breathing at `rate` Hz. */
export function rumble(
  c: VoiceCtx,
  o: Out,
  t: number,
  r: { dur: number; gain: number; f0?: number; f1?: number; rate?: number; attack?: number },
): void {
  const ac = c.ac;
  const src = noiseSource(c, 'brown');
  const bp = ac.createBiquadFilter();
  bp.type = 'lowpass';
  bp.Q.value = 0.9;
  bp.frequency.setValueAtTime(r.f0 ?? 420, t);
  bp.frequency.exponentialRampToValueAtTime(Math.max(30, r.f1 ?? 110), t + r.dur);
  const env = ac.createGain();
  envelope(env, t, r.gain, r.attack ?? 0.06, r.dur);
  // the heave: amplitude modulation, never deeper than half
  const am = ac.createGain();
  am.gain.value = 0.75;
  const lfo = ac.createOscillator();
  lfo.frequency.value = r.rate ?? 1.7;
  const lg = ac.createGain();
  lg.gain.value = 0.25;
  lfo.connect(lg);
  lg.connect(am.gain);
  src.connect(bp);
  bp.connect(env);
  env.connect(am);
  am.connect(o.input);
  // a 2 s noise buffer, looped: a tail may outlast it
  src.loop = true;
  src.start(t, c.rand() * 1.5);
  src.stop(t + r.dur + 0.05);
  lfo.start(t);
  lfo.stop(t + r.dur + 0.05);
}

/**
 * A reversed swell: pressure building INTO the moment at `t + dur` (where the hit lands) and cut dead there. A band of noise
 * whose level rises exponentially while its low-pass opens from `f0` to `f1` (never above ~1.2 kHz), over a sub that leans up.
 */
export function swell(
  c: VoiceCtx,
  o: Out,
  t: number,
  s: { dur: number; gain: number; f0?: number; f1?: number; sub?: number; subHz?: number },
): void {
  const ac = c.ac;
  const end = t + s.dur;
  const src = noiseSource(c, 'brown');
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 1.4;
  lp.frequency.setValueAtTime(s.f0 ?? 140, t);
  lp.frequency.exponentialRampToValueAtTime(clamp(s.f1 ?? 900, 60, 1400), end);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, s.gain), end);
  g.gain.linearRampToValueAtTime(0, end + 0.03);
  src.connect(lp);
  lp.connect(g);
  g.connect(o.input);
  src.loop = true;
  src.start(t, c.rand() * 1.2);
  src.stop(end + 0.08);
  if (s.sub) {
    const hz = s.subHz ?? 42;
    const osc = ac.createOscillator();
    osc.frequency.setValueAtTime(hz * 0.8, t);
    osc.frequency.exponentialRampToValueAtTime(hz * 1.25, end);
    const sh = saturator(c, 2);
    const sg = ac.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(Math.max(0.0002, s.sub), end);
    sg.gain.linearRampToValueAtTime(0, end + 0.03);
    osc.connect(sh);
    sh.connect(sg);
    sg.connect(o.input);
    osc.start(t);
    osc.stop(end + 0.08);
  }
}

/**
 * A shockwave / mass passing: a band of air sweeping DOWN from `f0` to `f1` (never above ~1.6 kHz) while it pans from `panFrom`
 * to `panTo`, with a brown-noise body under it. Replaces every Doppler whistle: the pass is heard as air and weight, not a tone.
 */
export function whoosh(
  c: VoiceCtx,
  t: number,
  w: {
    dur: number;
    gain: number;
    panFrom: number;
    panTo: number;
    wet: number;
    f0?: number;
    f1?: number;
    body?: number;
  },
): void {
  const ac = c.ac;
  const p = ac.createStereoPanner();
  p.pan.setValueAtTime(clamp(w.panFrom, -1, 1), t);
  p.pan.linearRampToValueAtTime(clamp(w.panTo, -1, 1), t + w.dur);
  p.connect(c.dry);
  let wg: GainNode | null = null;
  if (w.wet > 0.001) {
    wg = ac.createGain();
    wg.gain.value = w.wet;
    p.connect(wg);
    wg.connect(c.wet);
  }
  const o: Out = {
    input: p,
    close: () => {
      p.disconnect();
      wg?.disconnect();
    },
  };
  const air = noiseHit(c, o, t, {
    dur: w.dur,
    gain: w.gain,
    filter: { type: 'bandpass', f0: clamp(w.f0 ?? 900, 80, 1600), f1: Math.max(60, w.f1 ?? 160), q: 0.9 },
    filter2: { type: 'lowpass', f0: 1800, q: 0.5 },
    attack: w.dur * 0.45,
  });
  noiseHit(c, o, t, {
    dur: w.dur * 1.1,
    gain: w.gain * (w.body ?? 0.9),
    kind: 'brown',
    filter: { type: 'lowpass', f0: 320, f1: 110, q: 0.8 },
    attack: w.dur * 0.4,
  });
  air.onended = () => o.close();
}

/**
 * A roar: three detuned saws (and a sub an octave down) through a low-pass that sweeps `lp0` → `lp1` and a saturator, with a band
 * of brown noise riding it. The voice of beams, flares, gravity wells and the titans themselves. `f` is the fundamental (Hz).
 */
export function roar(
  c: VoiceCtx,
  o: Out,
  t: number,
  r: {
    f: number;
    f1?: number;
    dur: number;
    gain: number;
    attack?: number;
    lp0?: number;
    lp1?: number;
    detune?: number;
    noise?: number;
  },
): void {
  const ac = c.ac;
  const mix = ac.createGain();
  mix.gain.value = 0.3;
  const sh = saturator(c, 1.8);
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 1.1;
  lp.frequency.setValueAtTime(clamp(r.lp0 ?? 300, 40, 1400), t);
  lp.frequency.exponentialRampToValueAtTime(clamp(r.lp1 ?? 700, 40, 1400), t + r.dur);
  const env = ac.createGain();
  envelope(env, t, r.gain, r.attack ?? r.dur * 0.3, r.dur);
  mix.connect(sh);
  sh.connect(lp);
  lp.connect(env);
  env.connect(o.input);
  const det = r.detune ?? 9;
  const f1 = r.f1 ?? r.f;
  for (const [ratio, cents, type] of [
    [1, -det, 'sawtooth'],
    [1, det, 'sawtooth'],
    [1.5, 0, 'sawtooth'],
    [0.5, 0, 'sine'],
  ] as const) {
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(r.f * ratio, t);
    if (f1 !== r.f) osc.frequency.exponentialRampToValueAtTime(Math.max(16, f1 * ratio), t + r.dur);
    osc.detune.value = cents;
    osc.connect(mix);
    osc.start(t);
    osc.stop(t + r.dur + 0.05);
  }
  if ((r.noise ?? 0.6) > 0)
    noiseHit(c, o, t, {
      dur: r.dur,
      gain: r.gain * (r.noise ?? 0.6),
      kind: 'brown',
      filter: {
        type: 'bandpass',
        f0: clamp(r.lp0 ?? 300, 60, 1200),
        f1: clamp(r.lp1 ?? 700, 60, 1200),
        q: 0.7,
      },
      attack: r.attack ?? r.dur * 0.3,
    });
}

/** A struck colossal bell, plate or hull: `set`'s partials on `f` (keep `f` low), none above `maxHz` (default 1.6 kHz). */
export function lowBell(
  c: VoiceCtx,
  o: Out,
  t: number,
  f: number,
  set: PartialSet,
  p: { decay: number; gain: number; shimmer?: number; maxHz?: number },
): AudioScheduledSourceNode | null {
  return partials(c, o, t, f, set, { ...p, attack: 0.003, maxHz: p.maxHz ?? 1600 });
}

/**
 * Rock or metal dragging over itself: brown (rock) or white (metal) noise in a band that drifts `f0` → `f1` (both kept low),
 * chopped by a slow ratchet at `rate` Hz. Megastructures grinding, chains hauled, crust shearing.
 */
export function grind(
  c: VoiceCtx,
  o: Out,
  t: number,
  g: { dur: number; gain: number; f0: number; f1: number; rate: number; metal?: boolean; attack?: number },
): void {
  const ac = c.ac;
  const src = noiseSource(c, g.metal ? 'white' : 'brown');
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = g.metal ? 3 : 1.2;
  bp.frequency.setValueAtTime(clamp(g.f0, 40, 1200), t);
  bp.frequency.exponentialRampToValueAtTime(clamp(g.f1, 40, 1200), t + g.dur);
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1500;
  lp.Q.value = 0.5;
  const env = ac.createGain();
  // a narrow band of white noise carries a tiny share of its power: make up for it, so `gain` means about the same for metal
  // and rock (the band's share of the spectrum, ~bandwidth / 24 kHz, at the band's mean centre)
  const centre = Math.sqrt(clamp(g.f0, 40, 1200) * clamp(g.f1, 40, 1200));
  const makeup = g.metal ? clamp(Math.sqrt(24000 / (centre / 3)) / 6, 1, 5) : 1;
  envelope(env, t, g.gain * makeup, g.attack ?? g.dur * 0.25, g.dur);
  const am = ac.createGain();
  am.gain.value = 0.55;
  const lfo = ac.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = g.rate;
  const lg = ac.createGain();
  lg.gain.value = 0.45;
  const lfoLp = ac.createBiquadFilter(); // a soft square: clunks, not clicks
  lfoLp.type = 'lowpass';
  lfoLp.frequency.value = Math.max(20, g.rate * 6);
  lfo.connect(lfoLp);
  lfoLp.connect(lg);
  lg.connect(am.gain);
  src.connect(bp);
  bp.connect(lp);
  lp.connect(env);
  env.connect(am);
  am.connect(o.input);
  src.loop = true;
  src.start(t, c.rand() * 1.2);
  src.stop(t + g.dur + 0.05);
  lfo.start(t);
  lfo.stop(t + g.dur + 0.05);
}

/** Embers, fracture grit and debris: sparse low-passed grains (no hiss), `count` of them over `dur`. */
export function crackle(
  c: VoiceCtx,
  o: Out,
  t: number,
  k: { dur: number; count: number; gain: number; f?: number },
): void {
  const f = k.f ?? 900;
  for (let i = 0; i < k.count; i++) {
    const at = t + Math.pow(c.rand(), 1.3) * k.dur;
    noiseHit(c, o, at, {
      dur: 0.012 + 0.03 * c.rand(),
      gain: k.gain * (0.4 + 0.6 * c.rand()) * (1 - (0.5 * (at - t)) / Math.max(0.01, k.dur)),
      filter: { type: 'bandpass', f0: f * (0.6 + 0.8 * c.rand()), q: 1.4 },
      filter2: { type: 'lowpass', f0: 2200, q: 0.5 },
      attack: 0.001,
    });
  }
}

/**
 * The inhale before a catastrophe (a KO, a break-apart): the space empties. A low band of air FALLS and fades over `dur` while
 * a sub drops away under it; the boom that follows lands into near-silence (the engine ducks the bed at the same moment).
 */
export function hush(c: VoiceCtx, o: Out, t: number, dur: number, gain: number): void {
  noiseHit(c, o, t, {
    dur,
    gain,
    kind: 'brown',
    filter: { type: 'lowpass', f0: 700, f1: 90, q: 1.2 },
    attack: dur * 0.2,
  });
  const ac = c.ac;
  const osc = ac.createOscillator();
  osc.frequency.setValueAtTime(70, t);
  osc.frequency.exponentialRampToValueAtTime(30, t + dur);
  const g = ac.createGain();
  envelope(g, t, gain * 0.6, dur * 0.15, dur);
  const sh = saturator(c, 2);
  osc.connect(sh);
  sh.connect(g);
  g.connect(o.input);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

/**
 * A catastrophe (KO, break-apart, a world coming apart): the hush, then at `t + pre` the drop, a second deeper drop on its
 * heels, and a long cosmic decay. `size` 0..1 scales the length; `o` is the wet tap for the tail, `sub` the dry one.
 */
export function catastrophe(
  c: VoiceCtx,
  sub: Out,
  o: Out,
  t: number,
  k: { pre?: number; size?: number; gain?: number; f0?: number },
): number {
  const pre = k.pre ?? 0.32;
  const size = clamp01(k.size ?? 1);
  const g = k.gain ?? 1;
  const at = t + pre;
  if (pre > 0.05) hush(c, o, t, pre + 0.02, 0.18 * g);
  const f0 = k.f0 ?? 62;
  boom(c, sub, at, {
    f0: f0 * 1.6,
    f1: f0 * 0.55,
    dur: 1.6 + 1.4 * size,
    gain: 0.75 * g,
    drive: 3.4,
    knock: 1,
  });
  boom(c, sub, at + 0.09, {
    f0,
    f1: f0 * 0.5,
    dur: 2.2 + 1.6 * size,
    gain: 0.4 * g,
    drive: 2.8,
    knock: 0.5,
  });
  rumble(c, o, at, { dur: 3.5 + 3 * size, gain: 0.3 * g, f0: 650, f1: 110, rate: 1.1, attack: 0.04 });
  return at;
}
