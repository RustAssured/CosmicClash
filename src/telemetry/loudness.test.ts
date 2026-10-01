import { describe, expect, it } from 'vitest';
import {
  KFilter,
  LoudnessAccumulator,
  TruePeakDetector,
  designTruePeakFir,
  kWeighting,
  toDb,
} from './loudness';
import { METER_PROCESSOR, METER_WORKLET_SOURCE } from './meterWorklet';

const FS = 48000;

/** Feed `seconds` of a stereo signal through K-weighting into an accumulator in 100 ms sub-blocks. */
function measure(gen: (i: number, ch: number) => number, seconds: number): LoudnessAccumulator {
  const acc = new LoudnessAccumulator();
  const kf = [new KFilter(FS), new KFilter(FS)];
  const tp = [new TruePeakDetector(), new TruePeakDetector()];
  const block = FS / 10;
  const buf = new Float64Array(block);
  for (let b = 0; b < seconds * 10; b++) {
    let ms = 0;
    let peak = 0;
    for (let ch = 0; ch < 2; ch++) {
      for (let i = 0; i < block; i++) buf[i] = gen(b * block + i, ch);
      ms += kf[ch]!.sumSquares(buf) / block;
      peak = Math.max(peak, tp[ch]!.push(buf));
    }
    acc.push(ms, peak);
  }
  return acc;
}

const sine =
  (amp: number, hz: number, phase = 0) =>
  (i: number) =>
    amp * Math.sin((2 * Math.PI * hz * i) / FS + phase);

describe('BS.1770 loudness', () => {
  it('K-weighting matches the standard 48 kHz coefficients', () => {
    const [s, h] = kWeighting(48000);
    // ITU-R BS.1770-4 Table 1 / Table 2
    expect(s.b0).toBeCloseTo(1.53512485958697, 9);
    expect(s.b1).toBeCloseTo(-2.69169618940638, 9);
    expect(s.b2).toBeCloseTo(1.19839281085285, 9);
    expect(s.a1).toBeCloseTo(-1.69065929318241, 9);
    expect(s.a2).toBeCloseTo(0.73248077421585, 9);
    expect(h.a1).toBeCloseTo(-1.99004745483398, 9);
    expect(h.a2).toBeCloseTo(0.99007225036621, 9);
  });

  it('EBU Tech 3341 case 1: stereo 1 kHz sine at −23 dBFS reads −23.0 LUFS (M, S, I)', () => {
    const a = measure(sine(Math.pow(10, -23 / 20), 1000), 20);
    expect(a.integrated).toBeCloseTo(-23, 1);
    expect(a.momentary).toBeCloseTo(-23, 1);
    expect(a.shortTerm).toBeCloseTo(-23, 1);
  });

  it('EBU Tech 3341 case 3: gating ignores the silence-level passages (−36/−23/−36 dBFS → −23 LUFS)', () => {
    const lo = Math.pow(10, -36 / 20);
    const hi = Math.pow(10, -23 / 20);
    const gen = (i: number): number => {
      const t = i / FS;
      const amp = t < 10 ? lo : t < 70 ? hi : lo;
      return amp * Math.sin((2 * Math.PI * 1000 * i) / FS);
    };
    const a = measure(gen, 80);
    expect(a.integrated).toBeCloseTo(-23, 1);
  });

  it('EBU Tech 3342 case 1: −20 then −30 dBFS (10 s each) gives LRA ≈ 10 LU', () => {
    const gen = (i: number): number =>
      Math.pow(10, (i / FS < 20 ? -20 : -30) / 20) * Math.sin((2 * Math.PI * 1000 * i) / FS);
    const a = measure(gen, 40);
    expect(a.range).toBeGreaterThan(9);
    expect(a.range).toBeLessThan(11);
  });

  it('true peak finds the inter-sample peak a sample-peak meter misses (fs/4 sine at 45°)', () => {
    // samples land at ±0.707·A; the real waveform reaches A
    const amp = 0.5;
    const a = measure(sine(amp, FS / 4, Math.PI / 4), 2);
    expect(a.truePeak).toBeGreaterThan(toDb(amp) - 0.3);
    expect(a.truePeak).toBeLessThan(toDb(amp) + 0.3);
    expect(toDb(amp * Math.SQRT1_2)).toBeLessThan(a.truePeak - 2.5);
  });

  it('every interpolation phase has unity DC gain', () => {
    for (const ph of designTruePeakFir()) expect(ph.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 12);
  });
});

describe('meter worklet', () => {
  /** Run the worklet source in Node with stand-ins for the AudioWorkletGlobalScope. */
  function loadWorklet(): new (o: unknown) => {
    process(i: Float32Array[][]): boolean;
    port: { postMessage(m: unknown): void };
  } {
    let ctor: unknown = null;
    class Proc {
      port = { postMessage: (_m: unknown): void => undefined };
    }
    const register = (name: string, c: unknown): void => {
      expect(name).toBe(METER_PROCESSOR);
      ctor = c;
    };
    new Function('AudioWorkletProcessor', 'registerProcessor', METER_WORKLET_SOURCE)(Proc, register);
    return ctor as never;
  }

  it('posts exactly what the pure K-filter + true-peak detector compute', () => {
    const Ctor = loadWorklet();
    const k = kWeighting(FS).map((q) => [q.b0, q.b1, q.b2, q.a1, q.a2]);
    const phases = designTruePeakFir().map((p) => Array.from(p));
    const blockFrames = FS / 10;
    const node = new Ctor({ processorOptions: { k, phases, blockFrames } });
    const posted: { ms: number; tp: number }[] = [];
    node.port.postMessage = (m: unknown): void => void posted.push(m as { ms: number; tp: number });

    const gen = (i: number, ch: number): number =>
      0.3 * Math.sin((2 * Math.PI * (ch ? 220 : 3150) * i) / FS) + 0.05 * Math.sin(i * 0.37 + ch);
    const total = blockFrames * 3;
    for (let off = 0; off < total; off += 128) {
      const l = new Float32Array(128);
      const r = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        l[i] = gen(off + i, 0);
        r[i] = gen(off + i, 1);
      }
      node.process([[l, r]]);
    }
    // reference, fed the same float32-rounded samples in one go per block
    const kf = [new KFilter(FS), new KFilter(FS)];
    const tp = [new TruePeakDetector(), new TruePeakDetector()];
    for (let b = 0; b < 3; b++) {
      let ms = 0;
      let peak = 0;
      for (let ch = 0; ch < 2; ch++) {
        const x = new Float32Array(blockFrames);
        for (let i = 0; i < blockFrames; i++) x[i] = gen(b * blockFrames + i, ch);
        ms += kf[ch]!.sumSquares(x) / blockFrames;
        peak = Math.max(peak, tp[ch]!.push(x));
      }
      expect(posted[b]!.ms).toBeCloseTo(ms, 12);
      expect(posted[b]!.tp).toBeCloseTo(peak, 12);
    }
  });
});
