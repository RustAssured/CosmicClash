import { describe, expect, it } from 'vitest';
import { createLoop, MIN_TIME_SCALE } from './loop';

/** A hand-cranked clock + rAF so the loop is driven deterministically. */
function harness(opts: { maxCatchUp?: number } = {}) {
  let t = 1000;
  let pending: ((n: number) => void) | null = null;
  let visibilityCb: ((v: boolean) => void) | null = null;
  const log = { ticks: 0, frames: [] as { alpha: number; dt: number }[] };
  const loop = createLoop({
    tick: () => {
      log.ticks++;
    },
    frame: (alpha, dt) => {
      log.frames.push({ alpha, dt });
    },
    now: () => t,
    requestFrame: (cb) => {
      pending = cb;
      return 1;
    },
    cancelFrame: () => {
      pending = null;
    },
    onVisibility: (cb) => {
      visibilityCb = cb;
      return () => {
        visibilityCb = null;
      };
    },
    maxCatchUp: opts.maxCatchUp,
  });
  /** Advance the wall clock by `ms` and fire one animation frame. */
  const advance = (ms: number): void => {
    t += ms;
    const cb = pending;
    pending = null;
    cb?.(t);
  };
  return { loop, log, advance, setVisible: (v: boolean) => visibilityCb?.(v), now: () => t };
}

describe('fixed-timestep loop', () => {
  it('runs one tick per 1/60 s and reports a fractional alpha for interpolation', () => {
    const h = harness();
    h.loop.start();
    h.advance(1000 / 60 + 4);
    expect(h.log.ticks).toBe(1);
    const a = h.log.frames.at(-1)!.alpha;
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
    expect(a).toBeCloseTo(4 / (1000 / 60), 5);
  });

  it('accumulates: sixty frames of ~16.667 ms give ~60 ticks', () => {
    const h = harness();
    h.loop.start();
    for (let i = 0; i < 60; i++) h.advance(1000 / 60);
    expect(h.log.ticks).toBeGreaterThanOrEqual(59);
    expect(h.log.ticks).toBeLessThanOrEqual(60);
  });

  it('is independent of the display rate (144 Hz display still yields 60 ticks/s)', () => {
    const h = harness();
    h.loop.start();
    for (let i = 0; i < 144; i++) h.advance(1000 / 144);
    expect(Math.abs(h.log.ticks - 60)).toBeLessThanOrEqual(1);
    for (const f of h.log.frames) {
      expect(f.alpha).toBeGreaterThanOrEqual(0);
      expect(f.alpha).toBeLessThan(1);
    }
  });

  it('caps catch-up at 5 ticks per frame and drops the remainder (no spiral of death)', () => {
    const h = harness();
    h.loop.start();
    h.advance(240); // 14.4 ticks of debt
    expect(h.log.ticks).toBe(5);
    expect(h.loop.stats.droppedFrames).toBe(1);
    h.advance(1000 / 60);
    // debt was dropped, so the next normal frame does not owe extra ticks
    expect(h.log.ticks).toBeLessThanOrEqual(7);
  });

  it('clamps stalls: a 10 s frame never produces more than the catch-up cap', () => {
    const h = harness();
    h.loop.start();
    h.advance(10_000);
    expect(h.log.ticks).toBeLessThanOrEqual(5);
  });

  it('time scale slows ticks per second (KO slow-mo) without changing tick size', () => {
    const h = harness();
    h.loop.start();
    h.loop.timeScale = 0.3;
    for (let i = 0; i < 100; i++) h.advance(1000 / 60);
    // 100 frames × 0.3 ≈ 30 ticks
    expect(h.log.ticks).toBeGreaterThanOrEqual(29);
    expect(h.log.ticks).toBeLessThanOrEqual(31);
  });

  it('clamps timeScale to [0.05, 1] and rejects NaN', () => {
    const h = harness();
    h.loop.timeScale = 0;
    expect(h.loop.timeScale).toBe(MIN_TIME_SCALE);
    h.loop.timeScale = 7;
    expect(h.loop.timeScale).toBe(1);
    h.loop.timeScale = NaN;
    expect(h.loop.timeScale).toBe(1);
  });

  it('pause freezes ticks but keeps rendering; resume does not burst', () => {
    const h = harness();
    h.loop.start();
    h.advance(1000 / 60);
    const before = h.log.ticks;
    h.loop.pause();
    for (let i = 0; i < 30; i++) h.advance(1000 / 60);
    expect(h.log.ticks).toBe(before);
    expect(h.log.frames.length).toBeGreaterThan(30);
    h.loop.resume();
    h.advance(1000 / 60);
    expect(h.log.ticks - before).toBeLessThanOrEqual(1);
  });

  it('a hidden tab pauses the clock and resumes without a burst', () => {
    const h = harness();
    h.loop.start();
    h.advance(1000 / 60);
    const before = h.log.ticks;
    h.setVisible(false);
    h.advance(5000);
    expect(h.log.ticks).toBe(before);
    h.setVisible(true);
    h.advance(1000 / 60);
    expect(h.log.ticks - before).toBeLessThanOrEqual(1);
  });

  it('stepTicks runs exactly n ticks and renders once at alpha 0 without a clock', () => {
    const h = harness();
    h.loop.stepTicks(37);
    expect(h.log.ticks).toBe(37);
    expect(h.log.frames).toHaveLength(1);
    expect(h.log.frames[0]).toEqual({ alpha: 0, dt: 0 });
    h.loop.stepTicks(3, false);
    expect(h.log.ticks).toBe(40);
    expect(h.log.frames).toHaveLength(1);
  });

  it('stop cancels the pending frame and start is idempotent', () => {
    const h = harness();
    h.loop.start();
    h.loop.start();
    h.advance(20);
    h.loop.stop();
    const n = h.log.frames.length;
    h.advance(20);
    expect(h.log.frames.length).toBe(n);
    expect(h.loop.running).toBe(false);
  });

  it('reports rolling stats', () => {
    const h = harness();
    h.loop.start();
    for (let i = 0; i < 240; i++) h.advance(1000 / 60);
    expect(h.loop.stats.ticksPerFrame).toBeGreaterThan(0.5);
    expect(h.loop.stats.ticksPerFrame).toBeLessThan(1.5);
    expect(h.loop.stats.msPerTick).toBeGreaterThanOrEqual(0);
    expect(h.loop.stats.msPerFrame).toBeGreaterThanOrEqual(0);
  });
});
