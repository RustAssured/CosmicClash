import { describe, expect, it } from 'vitest';
import { Rng } from '@/contracts';
import {
  CHORD_BARS,
  STEPS_PER_BAR,
  nextChord,
  planStep,
  stepSeconds,
  type ScoreParams,
  type StepPlan,
} from './plan';

const bars = (p: ScoreParams, n: number, seed = 1): StepPlan[] => {
  const rng = new Rng(seed);
  return Array.from({ length: n * STEPS_PER_BAR }, (_, i) => planStep(i, p, rng));
};
const count = (plans: StepPlan[], k: 'sub' | 'taiko' | 'perc' | 'pulse'): number =>
  plans.filter((p) => p[k] > 0).length;
const fight = (intensity: number, lowIntegrity = 0): ScoreParams => ({
  intensity,
  lowIntegrity,
  phase: 'fight',
});

describe('score plan', () => {
  it('is deterministic per seed and differs across seeds at high intensity', () => {
    expect(bars(fight(0.9), 8, 3)).toEqual(bars(fight(0.9), 8, 3));
    expect(bars(fight(0.9), 8, 3)).not.toEqual(bars(fight(0.9), 8, 4));
  });
  it('a calm fight is only the drone: no rhythm layers at intensity 0', () => {
    const p = bars(fight(0), 8);
    for (const k of ['sub', 'taiko', 'perc', 'pulse'] as const) expect(count(p, k)).toBe(0);
  });
  it('rhythm layers fade in with intensity: sub first, then taiko, then airy percussion', () => {
    const low = bars(fight(0.2), 8);
    expect(count(low, 'sub')).toBeGreaterThan(0);
    expect(count(low, 'taiko')).toBe(0);
    expect(count(low, 'perc')).toBe(0);
    const mid = bars(fight(0.45), 8);
    expect(count(mid, 'taiko')).toBeGreaterThan(0);
    expect(count(mid, 'perc')).toBe(0);
    const hi = bars(fight(0.9), 8);
    expect(count(hi, 'perc')).toBeGreaterThan(0);
  });
  it('event density grows monotonically with intensity', () => {
    const density = (i: number): number => {
      const p = bars(fight(i), 32, 9);
      return count(p, 'sub') + count(p, 'taiko') + count(p, 'perc');
    };
    const d = [0, 0.2, 0.45, 0.7, 0.95].map(density);
    for (let i = 1; i < d.length; i++) expect(d[i]!).toBeGreaterThanOrEqual(d[i - 1]!);
    expect(d[4]!).toBeGreaterThan(d[1]! * 2);
  });
  it('every value stays within bounds', () => {
    for (const plan of bars(fight(1, 1), 16)) {
      for (const k of ['sub', 'taiko', 'perc', 'pulse'] as const) {
        expect(plan[k]).toBeGreaterThanOrEqual(0);
        expect(plan[k]).toBeLessThanOrEqual(1);
      }
      expect([0, 1, 2]).toContain(plan.taikoTune);
    }
  });
  it('the heartbeat appears only when integrity is low, and does so even in a lull', () => {
    expect(count(bars(fight(0.0, 0.2), 8), 'pulse')).toBe(0);
    expect(count(bars(fight(0.0, 0.9), 8), 'pulse')).toBeGreaterThan(0);
    const soft = bars(fight(0, 0.6), 4)
      .filter((p) => p.pulse > 0)
      .map((p) => p.pulse);
    const hard = bars(fight(0, 1), 4)
      .filter((p) => p.pulse > 0)
      .map((p) => p.pulse);
    expect(Math.max(...hard)).toBeGreaterThan(Math.max(...soft));
  });
  it('menus and results get only sparse bells, never rhythm; pause is silent', () => {
    const menu = bars({ intensity: 0.9, lowIntegrity: 1, phase: 'menu' }, 64);
    for (const k of ['sub', 'taiko', 'perc', 'pulse'] as const) expect(count(menu, k)).toBe(0);
    const bells = menu.filter((p) => p.bell >= 0);
    expect(bells.length).toBeGreaterThan(0);
    expect(bells.length).toBeLessThan(64 * 4 * 0.2);
    for (const b of bells) expect(b.bell).toBeLessThan(5);
    const paused = bars({ intensity: 1, lowIntegrity: 1, phase: 'pause' }, 8);
    expect(paused.every((p) => p.sub + p.taiko + p.perc + p.pulse === 0 && p.bell === -1)).toBe(true);
  });
  it('the downbeat carries the weight (bar starts with the biggest hits)', () => {
    const p = bars(fight(0.8), 16);
    const down = p.filter((_, i) => i % 16 === 0).reduce((a, x) => a + x.sub + x.taiko, 0);
    const off = p.filter((_, i) => i % 16 === 5).reduce((a, x) => a + x.sub + x.taiko, 0);
    expect(down).toBeGreaterThan(off);
  });
});

describe('tempo and chords', () => {
  it('tempo rises with intensity and slow-motion stretches time (clamped)', () => {
    const calm = stepSeconds(64, 0);
    const hot = stepSeconds(64, 1);
    expect(hot).toBeLessThan(calm);
    expect(calm / hot).toBeCloseTo(1.2 / 0.92, 3);
    expect(stepSeconds(64, 0.5, 0.3)).toBeCloseTo(stepSeconds(64, 0.5, 0.35), 9);
    expect(stepSeconds(64, 0.5, 0.5)).toBeGreaterThan(stepSeconds(64, 0.5, 1));
    // a bar at 64 BPM calm is ~4 beats ≈ 3.8-4 s
    expect(calm * STEPS_PER_BAR).toBeGreaterThan(3.5);
    expect(calm * STEPS_PER_BAR).toBeLessThan(4.6);
  });
  it('chord walk never repeats immediately and stays in range', () => {
    const rng = new Rng(5);
    let c = 0;
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const n = nextChord(c, 4, rng);
      expect(n).not.toBe(c);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(4);
      seen.add(n);
      c = n;
    }
    expect(seen.size).toBe(4);
    expect(nextChord(0, 1, rng)).toBe(0);
    expect(CHORD_BARS).toBeGreaterThan(0);
  });
});
