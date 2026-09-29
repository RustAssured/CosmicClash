import { describe, expect, it } from 'vitest';
import { Rng } from '@/contracts';
import { FakeContext, FakeGain, WebAudioViolation, asBase, takeViolations } from '../testing/fakeContext';
import { GLASS, envelope, gravel, makeOut, noiseHit, partials, riser, thump, tone, whistlePass } from './synth';
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
  it('gravel lays its grains out in order without overlap, for any density and seed', () => {
    for (const grains of [1, 8, 30, 90, 300])
      for (let seed = 1; seed <= 25; seed++) {
        const { c, ctx } = voiceCtx(seed);
        const o = makeOut(c, 0, 0);
        expect(() => gravel(c, o, 0.05, { dur: 0.3, grains, f: 900, spread: 2.8, gain: 0.2 })).not.toThrow();
        expect(takeViolations(), `${grains} grains, seed ${seed}`).toEqual([]);
        const grain = ctx.nodes.filter((n): n is FakeGain => n instanceof FakeGain).find((n) => n.gain.events.length > 4);
        expect(grain).toBeDefined();
        const ev = grain!.gain.events;
        for (let i = 1; i < ev.length; i++) expect(ev[i]!.t).toBeGreaterThanOrEqual(ev[i - 1]!.t);
      }
  });
  it('every primitive schedules well-formed automation (attack shorter than duration, times in order)', () => {
    const { c } = voiceCtx(3);
    const o = makeOut(c, 0.2, 0.3);
    tone(c, o, 0.1, { f0: 300, f1: 100, dur: 0.05, gain: 0.2, attack: 0.5 }); // attack longer than the sound: must be clamped
    noiseHit(c, o, 0.1, { dur: 0.01, gain: 0.2, attack: 0.3, filter: { type: 'lowpass', f0: 2000, f1: 100 } });
    partials(c, o, 0.1, 500, GLASS, { decay: 0.4, gain: 0.1, shimmer: 0.3 });
    thump(c, o, 0.1, 80, 30, 0.5, 0.5);
    riser(c, o, 0.1, 1, 0.1, 300, 5000);
    whistlePass(c, 0.1, { f: 900, dur: 0.5, gain: 0.1, panFrom: -1, panTo: 1, wet: 0.3 });
    expect(takeViolations()).toEqual([]);
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
