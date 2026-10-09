import { describe, expect, it } from 'vitest';
import { Rng } from '@/contracts';
import {
  FakeBiquad,
  FakeContext,
  FakeGain,
  FakeOsc,
  WebAudioViolation,
  asBase,
  takeViolations,
} from '../testing/fakeContext';
import { GLASS, IRON, envelope, gravel, makeOut, noiseHit, partials, riser, thump, tone } from './synth';
import {
  boom,
  catastrophe,
  crackle,
  grind,
  hush,
  lowBell,
  roar,
  rumble,
  saturationCurve,
  swell,
  whoosh,
} from './epic';
import type { VoiceCtx } from './types';

function voiceCtx(seed: number): { c: VoiceCtx; ctx: FakeContext } {
  const ctx = new FakeContext();
  const ac = asBase(ctx);
  const rng = new Rng(seed);
  const c: VoiceCtx = {
    ac,
    noise: ctx.createBuffer(1, 88200, 44100) as unknown as AudioBuffer,
    brown: ctx.createBuffer(1, 88200, 44100) as unknown as AudioBuffer,
    rand: () => rng.next(),
    dry: ctx.createGain() as unknown as GainNode,
    wet: ctx.createGain() as unknown as GainNode,
    panOf: () => 0,
    take: () => true,
    release: () => undefined,
    timeScale: 1,
  };
  return { c, ctx };
}

describe('automation hygiene (Chromium diverges on overlapping ramps: gain 1e8, then NaN downstream)', () => {
  it('the strict fake rejects an event landing inside an existing ramp', () => {
    const ctx = new FakeContext();
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(1, 0.001);
    g.gain.exponentialRampToValueAtTime(1e-4, 0.02);
    expect(() => g.gain.setValueAtTime(0, 0.01)).toThrow(WebAudioViolation);
    expect(takeViolations()).toHaveLength(1);
    // an event AT a ramp's end, or after it, is fine
    expect(() => g.gain.setValueAtTime(0, 0.02)).not.toThrow();
    expect(() => g.gain.setValueAtTime(0, 0.5)).not.toThrow();
  });
  it('the strict fake rejects a retarget at the same instant with a different time constant (Chromium restarts it from 440 Hz)', () => {
    const ctx = new FakeContext();
    const o = ctx.createOscillator();
    o.frequency.setTargetAtTime(55, 0, 0.001);
    expect(() => o.frequency.setTargetAtTime(55, 0, 1.2)).toThrow(WebAudioViolation);
    expect(takeViolations()).toHaveLength(1);
    // the same target and time constant twice (a per-frame call landing in one audio quantum) is harmless; so is a later instant
    expect(() => o.frequency.setTargetAtTime(55, 0, 0.001)).not.toThrow();
    expect(() => o.frequency.setTargetAtTime(110, 0.05, 1.2)).not.toThrow();
    // cancelling from a time removes only the events from then on
    o.frequency.cancelScheduledValues(0.05);
    expect(o.frequency.events.every((e) => e.t < 0.05)).toBe(true);
    expect(o.frequency.events.length).toBeGreaterThan(0);
  });
  it('gravel lays its grains out in order without overlap, for any density and seed', () => {
    for (const grains of [1, 8, 30, 90, 300])
      for (let seed = 1; seed <= 25; seed++) {
        const { c, ctx } = voiceCtx(seed);
        const o = makeOut(c, 0, 0);
        expect(() => gravel(c, o, 0.05, { dur: 0.3, grains, f: 900, spread: 2.8, gain: 0.2 })).not.toThrow();
        expect(takeViolations(), `${grains} grains, seed ${seed}`).toEqual([]);
        const grain = ctx.nodes
          .filter((n): n is FakeGain => n instanceof FakeGain)
          .find((n) => n.gain.events.length > 4);
        expect(grain).toBeDefined();
        const ev = grain!.gain.events;
        for (let i = 1; i < ev.length; i++) expect(ev[i]!.t).toBeGreaterThanOrEqual(ev[i - 1]!.t);
      }
  });
  it('every primitive schedules well-formed automation (attack shorter than duration, times in order)', () => {
    const { c } = voiceCtx(3);
    const o = makeOut(c, 0.2, 0.3);
    tone(c, o, 0.1, { f0: 300, f1: 100, dur: 0.05, gain: 0.2, attack: 0.5 }); // attack longer than the sound: must be clamped
    noiseHit(c, o, 0.1, {
      dur: 0.01,
      gain: 0.2,
      attack: 0.3,
      filter: { type: 'lowpass', f0: 2000, f1: 100 },
    });
    partials(c, o, 0.1, 500, GLASS, { decay: 0.4, gain: 0.1, shimmer: 0.3 });
    thump(c, o, 0.1, 80, 30, 0.5, 0.5);
    riser(c, o, 0.1, 1, 0.1, 300, 5000);
    expect(takeViolations()).toEqual([]);
  });
  it('the cataclysm kit schedules well-formed automation, and nothing it plays is a tone above ~1.6 kHz (D34: no whistles)', () => {
    const { c, ctx } = voiceCtx(4);
    const o = makeOut(c, -0.2, 0.4);
    boom(c, o, 0.1, { f0: 110, f1: 30, dur: 1.2, gain: 0.8 });
    rumble(c, o, 0.1, { dur: 4, gain: 0.2 });
    swell(c, o, 0.1, { dur: 1, gain: 0.2, f1: 5000, sub: 0.1 }); // asked for 5 kHz: clamped
    whoosh(c, 0.1, { dur: 0.6, gain: 0.1, panFrom: -1, panTo: 1, wet: 0.3, f0: 4000 });
    roar(c, o, 0.1, { f: 55, f1: 41, dur: 1.5, gain: 0.1, lp0: 3000, lp1: 200 });
    lowBell(c, o, 0.1, 400, IRON, { decay: 1, gain: 0.1 });
    grind(c, o, 0.1, { dur: 0.6, gain: 0.1, f0: 3000, f1: 100, rate: 9, metal: true });
    crackle(c, o, 0.1, { dur: 1, count: 20, gain: 0.1 });
    hush(c, o, 0.1, 0.4, 0.2);
    const at = catastrophe(c, o, o, 1, { size: 1 });
    expect(at).toBeGreaterThan(1.2);
    expect(takeViolations()).toEqual([]);
    for (const n of ctx.nodes) {
      if (n instanceof FakeOsc && n.frequency.value >= 25)
        for (const e of n.frequency.events)
          expect(e.v, 'an oscillator above 1.6 kHz').toBeLessThanOrEqual(1600);
      if (n instanceof FakeBiquad && n.type !== 'lowpass')
        for (const e of n.frequency.events)
          expect(e.v, `a ${n.type} filter above 1.6 kHz`).toBeLessThanOrEqual(1600);
    }
  });
  it('the saturator is odd, monotonic and bounded (harmonics, never clipping past full scale)', () => {
    for (const drive of [1, 2.4, 6]) {
      const k = saturationCurve(drive);
      const n = k.length;
      expect(k[0]).toBeCloseTo(-1, 5);
      expect(k[n - 1]).toBeCloseTo(1, 5);
      for (let i = 1; i < n; i++) expect(k[i]!).toBeGreaterThan(k[i - 1]!);
      for (let i = 0; i < n; i++) expect(k[i]!).toBeCloseTo(-k[n - 1 - i]!, 5);
    }
    // a harder drive lifts quiet input more (more harmonics at the same level)
    expect(saturationCurve(6)[1500]!).toBeGreaterThan(saturationCurve(1)[1500]!);
  });
  it('envelope keeps the attack strictly inside the duration', () => {
    const ctx = new FakeContext();
    const g = ctx.createGain();
    envelope(g as unknown as GainNode, 1, 0.5, 2, 0.1);
    const t = g.gain.events.map((e) => e.t);
    expect(t).toEqual([...t].sort((a, b) => a - b));
    const lin = g.gain.events.find((e) => e.type === 'lin')!;
    const exp = g.gain.events.find((e) => e.type === 'exp')!;
    expect(lin.t).toBeLessThan(exp.t);
  });
});
