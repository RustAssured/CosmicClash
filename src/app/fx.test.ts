import { describe, expect, it } from 'vitest';
import type { MatchApi, SimEvent } from '@/contracts';
import { createMatch } from '@/sim';
import { fakeDeps } from '@/sim/testing/fakes';
import { FxState, buildAudioScene } from './fx';

const mkMatch = (): MatchApi =>
  createMatch(
    {
      seed: 1,
      stage: 'nursery',
      mode: 'versus',
      slots: [
        { titan: 'lastone', controller: 'dummy' },
        { titan: 'asteroid', controller: 'dummy' },
      ],
    },
    fakeDeps(),
  );

describe('FxState', () => {
  it('spawns a shockwave that expands, fades and expires', () => {
    const fx = new FxState();
    const m = mkMatch();
    fx.tick([{ t: 'shockwave', x: 100, y: 50, strength: 0.8, radius: 200, hue: -1 }], m);
    const a = fx.sample(0);
    expect(a.shockwaves).toHaveLength(1);
    const r0 = a.shockwaves[0]!.radius;
    for (let i = 0; i < 20; i++) fx.tick([], m);
    const b = fx.sample(0);
    expect(b.shockwaves[0]!.radius).toBeGreaterThan(r0);
    expect(b.shockwaves[0]!.strength).toBeLessThan(0.8);
    for (let i = 0; i < 200; i++) fx.tick([], m);
    expect(fx.sample(0).shockwaves).toHaveLength(0);
    expect(fx.sample(0).impulses).toHaveLength(0);
  });

  it('flash and aberration decay; ko boosts both; intensity stays in 0..1', () => {
    const fx = new FxState();
    const m = mkMatch();
    fx.tick([{ t: 'ko', slot: 1, x: 0, y: 0 } as SimEvent], m);
    const a = fx.sample(0);
    expect(a.flash).toBeGreaterThan(0.5);
    expect(a.aberration).toBeGreaterThan(0.5);
    for (let i = 0; i < 120; i++) fx.tick([], m);
    const b = fx.sample(0);
    expect(b.flash).toBeLessThan(0.01);
    expect(b.intensity).toBeGreaterThanOrEqual(0);
    expect(b.intensity).toBeLessThanOrEqual(1);
  });

  it('never exceeds its ring budget and reports lensing from fighter views', () => {
    const fx = new FxState();
    const m = mkMatch();
    m.fighters[1].view.lensRadius = 40;
    m.fighters[1].view.lensStrength = 1;
    for (let i = 0; i < 40; i++)
      fx.tick([{ t: 'shockwave', x: i, y: 0, strength: 1, radius: 100, hue: -1 }], m);
    const s = fx.sample(0.5);
    expect(s.shockwaves.length).toBeLessThanOrEqual(10);
    expect(s.lenses).toHaveLength(1);
    expect(s.lenses[0]!.horizonR).toBe(40);
  });

  it('builds an audio scene', () => {
    const m = mkMatch();
    const sc = buildAudioScene(m, 'fight', 0.5, 320);
    expect(sc.fighters).toHaveLength(2);
    expect(sc.fighters![0].titan).toBe('lastone');
    expect(sc.lowestIntegrity).toBe(1);
  });
});
