import { describe, expect, it } from 'vitest';
import { TruePeakDetector, designTruePeakFir, toDb } from '@/telemetry/loudness';
import {
  LIMITER_CEILING,
  LIMITER_LOOKAHEAD,
  LIMITER_PROCESSOR,
  LIMITER_RELEASE,
  LimiterCore,
  limiterWorkletSource,
} from './limiter';

const SR = 48000;
const phases = (): number[][] => designTruePeakFir().map((p) => Array.from(p));
const core = (): LimiterCore =>
  new LimiterCore(2, SR, LIMITER_LOOKAHEAD, LIMITER_CEILING, LIMITER_RELEASE, phases());

/** Run stereo input through the core in 128-frame blocks (as the AudioWorklet does). */
function run(l: Float32Array, r: Float32Array, c = core()): [Float32Array, Float32Array] {
  const ol = new Float32Array(l.length);
  const or = new Float32Array(r.length);
  for (let i = 0; i < l.length; i += 128) {
    const n = Math.min(128, l.length - i);
    c.process(
      [l.subarray(i, i + n), r.subarray(i, i + n)],
      [ol.subarray(i, i + n), or.subarray(i, i + n)],
      n,
    );
  }
  return [ol, or];
}

const truePeakDb = (...ch: Float32Array[]): number => {
  let pk = 0;
  for (const x of ch) pk = Math.max(pk, new TruePeakDetector().push(x));
  return toDb(pk);
};

describe('LimiterCore (lookahead true-peak limiter, −1 dBTP)', () => {
  it('holds a full-scale sine and a hot noise burst at or under −1 dBTP', () => {
    const n = SR;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    let s = 1;
    for (let i = 0; i < n; i++) {
      s = (s * 16807) % 2147483647;
      l[i] = Math.sin((2 * Math.PI * 997 * i) / SR) * 1.4;
      r[i] = ((s / 2147483647) * 2 - 1) * (i > n / 2 ? 1.8 : 0.3);
    }
    const [ol, or] = run(l, r);
    expect(truePeakDb(ol, or)).toBeLessThanOrEqual(-1);
  });

  it('catches inter-sample peaks the sample values do not show (fs/4 sine at 45°)', () => {
    const n = SR / 2;
    const l = new Float32Array(n);
    for (let i = 0; i < n; i++) l[i] = 0.99 * Math.sin((Math.PI / 2) * i + Math.PI / 4);
    let samplePk = 0;
    for (const v of l) samplePk = Math.max(samplePk, Math.abs(v));
    expect(toDb(samplePk)).toBeLessThan(-1); // sample peaks look safe (−4 dB)…
    expect(truePeakDb(l)).toBeGreaterThan(-1); // …the true peak is not
    const [ol] = run(l, l.slice());
    expect(truePeakDb(ol)).toBeLessThanOrEqual(-1);
  });

  it('leaves a signal under the ceiling untouched (only delayed by its lookahead)', () => {
    const c = core();
    const n = 4096;
    const l = new Float32Array(n);
    for (let i = 0; i < n; i++) l[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const [ol] = run(l, l.slice(), c);
    const d = c.delayFrames;
    let err = 0;
    for (let i = d; i < n; i++) err = Math.max(err, Math.abs(ol[i]! - l[i - d]!));
    expect(err).toBeLessThan(1e-6);
    expect(c.takeMinGain()).toBe(1);
  });

  it('a lone full-scale transient is already turned down when it arrives (no overshoot), and recovers afterwards', () => {
    const n = SR / 2;
    const l = new Float32Array(n);
    for (let i = 0; i < n; i++) l[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / SR);
    for (let i = 10000; i < 10040; i++) l[i] = i % 2 ? 1 : -1;
    const c = core();
    const [ol] = run(l, l.slice(), c);
    let pk = 0;
    for (const v of ol) pk = Math.max(pk, Math.abs(v));
    expect(pk).toBeLessThanOrEqual(LIMITER_CEILING + 1e-6);
    expect(c.takeMinGain()).toBeLessThan(0.95);
    // 0.25 s later the gain is back near 1
    const d = c.delayFrames;
    const late = 10040 + Math.round(0.25 * SR);
    expect(Math.abs(ol[late + d]! / l[late]! - 1)).toBeLessThan(0.05);
  });

  it('the AudioWorklet module runs the very same code (sample for sample)', () => {
    const registered: Record<string, new (o: unknown) => { process(i: unknown, o: unknown): boolean }> = {};
    const fn = new Function(
      'AudioWorkletProcessor',
      'registerProcessor',
      'sampleRate',
      limiterWorkletSource(),
    ) as (a: unknown, b: unknown, c: number) => void;
    class Proc {
      port = { postMessage: (): void => undefined };
    }
    fn(Proc, (name: string, ctor: (typeof registered)[string]) => (registered[name] = ctor), SR);
    const Ctor = registered[LIMITER_PROCESSOR]!;
    const node = new Ctor({
      processorOptions: {
        channels: 2,
        lookahead: LIMITER_LOOKAHEAD,
        ceiling: LIMITER_CEILING,
        release: LIMITER_RELEASE,
        phases: phases(),
      },
    });
    const n = 128 * 40;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      l[i] = 1.3 * Math.sin(i * 0.05);
      r[i] = 0.9 * Math.sin(i * 0.031);
    }
    const [el, er] = run(l, r);
    const wl = new Float32Array(n);
    const wr = new Float32Array(n);
    for (let i = 0; i < n; i += 128)
      node.process(
        [[l.subarray(i, i + 128), r.subarray(i, i + 128)]],
        [[wl.subarray(i, i + 128), wr.subarray(i, i + 128)]],
      );
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(wl[i]! - el[i]!), Math.abs(wr[i]! - er[i]!));
    expect(diff).toBe(0);
  });
});
