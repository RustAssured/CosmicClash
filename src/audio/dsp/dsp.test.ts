import { describe, expect, it } from 'vitest';
import { STAGE_IDS } from '@/contracts';
import {
  bandShare,
  decayTime,
  envelopeDb,
  fft,
  firstAbove,
  peak,
  rms,
  rt60,
  spectralCentroid,
} from './analysis';
import { generateImpulseResponse } from './ir';
import {
  centsToRatio,
  dbToGain,
  gainToDb,
  hardClipCurve,
  hash01,
  limiterCurve,
  midiToHz,
  volumeCurve,
} from './math';
import { MODES, STAGE_MUSIC, degreeToHz, degreeToMidi } from './scales';

const SR = 48000;
const sine = (f: number, n: number, sr = SR): Float32Array =>
  Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / sr));

describe('math', () => {
  it('converts dB, MIDI and cents', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 2);
    expect(gainToDb(dbToGain(-23))).toBeCloseTo(-23, 6);
    expect(midiToHz(69)).toBe(440);
    expect(midiToHz(57)).toBeCloseTo(220, 9);
    expect(centsToRatio(1200)).toBeCloseTo(2, 12);
  });
  it('volume curve is a monotonic squared taper on 0..1', () => {
    expect(volumeCurve(0)).toBe(0);
    expect(volumeCurve(1)).toBe(1);
    expect(volumeCurve(0.5)).toBe(0.25);
    expect(volumeCurve(2)).toBe(1);
    expect(volumeCurve(-1)).toBe(0);
  });
  it('hash01 is deterministic and roughly uniform', () => {
    expect(hash01(3, 4)).toBe(hash01(3, 4));
    expect(hash01(3, 4)).not.toBe(hash01(4, 3));
    let s = 0;
    for (let i = 0; i < 5000; i++) s += hash01(i, 7);
    expect(s / 5000).toBeGreaterThan(0.45);
    expect(s / 5000).toBeLessThan(0.55);
  });
});

describe('limiter curve (the "nothing ever clips" guarantee)', () => {
  const c = limiterCurve();
  it('never exceeds its ceiling anywhere, including the ±1 endpoints WaveShaper clamps to', () => {
    expect(peak(c)).toBeLessThanOrEqual(0.98 + 1e-6);
    expect(c[0]).toBeCloseTo(-c[c.length - 1]!, 6);
  });
  it('is odd-symmetric, monotonic, and transparent (unity gain) below the knee', () => {
    for (let i = 1; i < c.length; i++) expect(c[i]!).toBeGreaterThanOrEqual(c[i - 1]! - 1e-9);
    const mid = (c.length - 1) / 2;
    expect(c[mid]).toBeCloseTo(0, 9);
    const x = 0.5;
    expect(c[Math.round(((x + 1) / 2) * (c.length - 1))]).toBeCloseTo(0.5, 3);
    for (let i = 0; i < c.length; i++) expect(c[i]!).toBeCloseTo(-c[c.length - 1 - i]!, 6);
  });
  it('is continuous with unit slope at the knee (no audible kink)', () => {
    const n = c.length;
    const at = (x: number): number => c[Math.round(((x + 1) / 2) * (n - 1))]!;
    const d1 = (at(0.72) - at(0.72 - 0.01)) / 0.01;
    const d2 = (at(0.72 + 0.01) - at(0.72)) / 0.01;
    expect(d1).toBeCloseTo(1, 1);
    expect(d2).toBeGreaterThan(0.8);
  });
});

describe('scales and stage music', () => {
  it('maps degrees across octaves in both directions', () => {
    expect(degreeToMidi(40, 'lydian', 0)).toBe(40);
    expect(degreeToMidi(40, 'lydian', 3)).toBe(46); // the raised 4th
    expect(degreeToMidi(40, 'lydian', 7)).toBe(52);
    expect(degreeToMidi(40, 'lydian', -1)).toBe(40 - 12 + 11);
    expect(degreeToHz(57, 'pentatonic', 0)).toBeCloseTo(220, 9);
  });
  it('every mode starts on the root and rises within an octave', () => {
    for (const m of Object.values(MODES)) {
      expect(m[0]).toBe(0);
      for (let i = 1; i < m.length; i++) expect(m[i]!).toBeGreaterThan(m[i - 1]!);
      expect(m[m.length - 1]!).toBeLessThanOrEqual(12);
    }
  });
  it('every stage has a drone root in the sub range, a tempo and chord voicings that index its mode', () => {
    for (const id of STAGE_IDS) {
      const s = STAGE_MUSIC[id];
      expect(s.root).toBeGreaterThanOrEqual(24);
      expect(s.root).toBeLessThanOrEqual(48);
      expect(s.bpm).toBeGreaterThan(40);
      expect(s.bpm).toBeLessThan(90);
      expect(s.chords.length).toBeGreaterThan(2);
      for (const ch of s.chords) for (const d of ch) expect(d).toBeLessThan(MODES[s.mode].length + 1);
    }
  });
});

describe('hardClipCurve', () => {
  it('is the identity below the ceiling and flat above it', () => {
    const c = hardClipCurve(2049, 0.98);
    const at = (x: number): number => c[Math.round(((x + 1) / 2) * (c.length - 1))]!;
    expect(at(0)).toBeCloseTo(0, 6);
    expect(at(0.5)).toBeCloseTo(0.5, 3);
    expect(at(-0.9)).toBeCloseTo(-0.9, 3);
    expect(at(1)).toBeCloseTo(0.98, 6);
    expect(at(-1)).toBeCloseTo(-0.98, 6);
    expect(Math.max(...c)).toBeLessThanOrEqual(0.98 + 1e-6); // float32 storage of 0.98
  });
});

describe('analysis', () => {
  it('fft finds a pure tone bin and Parseval holds', () => {
    const n = 1024;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 64 * i) / n);
    let time = 0;
    for (let i = 0; i < n; i++) time += re[i]! * re[i]!;
    fft(re, im);
    let best = 0;
    let freq = 0;
    let energy = 0;
    for (let k = 0; k < n; k++) {
      const m = Math.hypot(re[k]!, im[k]!);
      energy += m * m;
      if (k < n / 2 && m > best) {
        best = m;
        freq = k;
      }
    }
    expect(freq).toBe(64);
    expect(energy / n).toBeCloseTo(time, 6);
  });
  it('spectral centroid tracks pitch and brightness', () => {
    const lo = spectralCentroid(sine(200, 8192), SR);
    const hi = spectralCentroid(sine(4000, 8192), SR);
    expect(lo).toBeGreaterThan(150);
    expect(lo).toBeLessThan(260);
    expect(hi).toBeGreaterThan(3600);
    expect(hi).toBeLessThan(4400);
    expect(spectralCentroid(new Float32Array(4096), SR)).toBe(0);
  });
  it('bandShare reports where the power lives', () => {
    const mix = Float32Array.from(
      { length: 16384 },
      (_, i) => Math.sin((2 * Math.PI * 100 * i) / SR) + 0.3 * Math.sin((2 * Math.PI * 5000 * i) / SR),
    );
    expect(bandShare(mix, SR, 20, 300)).toBeGreaterThan(0.9);
    expect(bandShare(mix, SR, 3000, 8000)).toBeLessThan(0.1);
    expect(bandShare(new Float32Array(4096), SR, 0, 1000)).toBe(0);
  });
  it('peak / rms / firstAbove', () => {
    const s = sine(100, 4800);
    expect(peak(s)).toBeCloseTo(1, 2);
    expect(rms(s)).toBeCloseTo(Math.SQRT1_2, 2);
    const x = new Float32Array(1000);
    x[321] = 0.4;
    expect(firstAbove(x, 0.1)).toBe(321);
    expect(firstAbove(new Float32Array(10), 0.1)).toBe(-1);
  });
  it('decayTime measures an exponential tail', () => {
    const n = SR * 4;
    const x = new Float32Array(n);
    const tau = (0.5 / Math.log(1000)) * 1; // −60 dB at 0.5 s
    for (let i = 0; i < n; i++) x[i] = Math.sin(i * 0.3) * Math.exp(-i / SR / tau);
    const t = decayTime(x, SR, 60);
    expect(t).toBeGreaterThan(0.4);
    expect(t).toBeLessThan(0.65);
    expect(envelopeDb(x, 4800).length).toBe(40);
  });
});

describe('impulse response (procedural, dark, long-tailed)', () => {
  const ir = generateImpulseResponse(SR, { decay: 3.2, seed: 5 });
  it('is stereo, decorrelated, deterministic per seed and different across seeds', () => {
    expect(ir.length).toBe(2);
    expect(ir[0].length).toBe(ir[1].length);
    let dot = 0;
    let a = 0;
    let b = 0;
    for (let i = 0; i < ir[0].length; i++) {
      dot += ir[0][i]! * ir[1][i]!;
      a += ir[0][i]! ** 2;
      b += ir[1][i]! ** 2;
    }
    expect(Math.abs(dot / Math.sqrt(a * b))).toBeLessThan(0.05);
    const same = generateImpulseResponse(SR, { decay: 3.2, seed: 5 });
    expect(same[0]).toEqual(ir[0]);
    const other = generateImpulseResponse(SR, { decay: 3.2, seed: 6 });
    expect(other[0]).not.toEqual(ir[0]);
  });
  it('has the requested RT60 (within 25%) and about 3+ seconds of audible tail', () => {
    const t = rt60(ir[0], SR);
    expect(t).toBeGreaterThan(3.2 * 0.75);
    expect(t).toBeLessThan(3.2 * 1.25);
    expect(ir[0].length / SR).toBeGreaterThan(3.2);
  });
  it('is dark: the tail is much less bright than the onset', () => {
    const early = spectralCentroid(ir[0], SR, Math.floor(SR * 0.03), 8192);
    const late = spectralCentroid(ir[0], SR, Math.floor(SR * 1.5), 8192);
    expect(late).toBeLessThan(early * 0.6);
    expect(late).toBeLessThan(1200);
  });
  it('has unit energy per channel and a pre-delay of silence', () => {
    let e = 0;
    for (let i = 0; i < ir[0].length; i++) e += ir[0][i]! ** 2;
    expect(e).toBeCloseTo(1, 1);
    expect(peak(ir[0], 0, Math.floor(SR * 0.01))).toBe(0);
  });
  it('a longer decay parameter gives a longer measured tail', () => {
    const short = rt60(generateImpulseResponse(SR, { decay: 1.2, seed: 2 })[0], SR);
    const long = rt60(generateImpulseResponse(SR, { decay: 4.5, seed: 2 })[0], SR);
    expect(long).toBeGreaterThan(short * 2.5);
  });
});
