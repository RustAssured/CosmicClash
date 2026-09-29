import { describe, expect, it } from 'vitest';
import { QualityController, type Tier } from './quality';

interface Run {
  changes: { t: number; tier: Tier }[];
  tier: Tier;
  /** Clock value after the last fed frame, so runs can be chained without time going backwards. */
  end: number;
}

/** Feed `seconds` of frames at `frameMs` (gpu optional) starting at `t0`; returns the tier changes seen. */
function feed(
  c: QualityController,
  t0: number,
  seconds: number,
  frameMs: (t: number) => number,
  gpu?: (t: number) => number | null,
): Run {
  const changes: { t: number; tier: Tier }[] = [];
  let t = t0;
  const end = t0 + seconds * 1000;
  while (t < end) {
    const d = frameMs(t);
    t += d;
    const r = c.sample(t, d, gpu ? gpu(t) : null);
    if (r !== null) changes.push({ t, tier: r });
  }
  return { changes, tier: c.tier, end: t };
}

describe('QualityController', () => {
  it('starts at tier 1 by default and holds it while frames are on time (no probe before its delay)', () => {
    const c = new QualityController();
    expect(c.tier).toBe(1);
    const r = feed(c, 0, 12, () => 16.7);
    expect(r.changes).toEqual([]);
  });

  it('steps down after sustained misses, one tier at a time, never faster than one change per 3 s', () => {
    const c = new QualityController({ startTier: 2 });
    const r = feed(c, 0, 30, () => 40);
    expect(r.changes.map((x) => x.tier)).toEqual([1, 0]);
    for (let i = 1; i < r.changes.length; i++)
      expect(r.changes[i]!.t - r.changes[i - 1]!.t).toBeGreaterThanOrEqual(3000);
    expect(r.changes[0]!.t).toBeGreaterThanOrEqual(3000); // ≥ two bad windows
  });

  it('bottoms out at tier 0 and stays there under permanent trouble (the software-GL case: 0.5 s frames)', () => {
    const c = new QualityController({ startTier: 1 });
    const r = feed(c, 0, 120, () => 500);
    expect(c.tier).toBe(0);
    expect(r.changes.map((x) => x.tier)).toEqual([0]);
  });

  it('ignores isolated stutters: a single late frame per window does not step down', () => {
    const c = new QualityController({ startTier: 2 });
    let n = 0;
    const r = feed(c, 0, 60, () => (++n % 60 === 0 ? 45 : 16.7));
    expect(r.changes).toEqual([]);
  });

  it('a bad patch shorter than one window does not step down (hysteresis)', () => {
    const c = new QualityController({ startTier: 2 });
    const r = feed(c, 0, 40, (t) => (t > 10_000 && t < 11_100 ? 40 : 16.7));
    expect(r.changes).toEqual([]);
  });

  it('probes upward after a long quiet spell, then holds; a failed probe doubles the delay', () => {
    const c = new QualityController({ startTier: 0, upDelayMs: 10_000 });
    const good = (): number => 16.7;
    const r1 = feed(c, 0, 12, good);
    expect(r1.changes.map((x) => x.tier)).toEqual([1]);
    expect(r1.changes[0]!.t).toBeGreaterThanOrEqual(10_000);
    // the probe fails: the next tier is too heavy
    const bad = feed(c, r1.end, 30, () => 40);
    expect(bad.changes.map((x) => x.tier)).toEqual([0]);
    expect(c.snapshot().upDelayMs).toBe(20_000);
    // it does NOT retry after only 14 s of quiet (delay is now 20 s)
    const r3 = feed(c, bad.end, 14, good);
    expect(r3.changes).toEqual([]);
    const r4 = feed(c, r3.end, 12, good);
    expect(r4.changes.map((x) => x.tier)).toEqual([1]);
  });

  it('with a GPU timer it steps up only when the predicted next-tier cost fits the budget', () => {
    const heavy = new QualityController({ startTier: 1 });
    expect(
      feed(
        heavy,
        0,
        40,
        () => 16.7,
        () => 9,
      ).changes,
    ).toEqual([]); // 9 ms × 3.6 ≫ 14 ms
    const light = new QualityController({ startTier: 1 });
    const r = feed(
      light,
      0,
      40,
      () => 16.7,
      () => 2.5,
    ); // 2.5 × 3.6 = 9 ms ≤ 0.85 × 16.7
    expect(r.changes.map((x) => x.tier)).toEqual([2]);
    expect(r.changes[0]!.t).toBeLessThan(15_000); // faster than the blind probe
  });

  it('a hidden tab / stall (huge delta) is a disruption, never a miss', () => {
    const c = new QualityController({ startTier: 2 });
    feed(c, 0, 5, () => 16.7);
    c.sample(400_000, 300_000); // tab was hidden for five minutes
    const r = feed(c, 400_000, 20, () => 16.7);
    expect(r.changes).toEqual([]);
    expect(c.tier).toBe(2);
  });

  it('ignores samples during the warm-up after a change (the resize hitch does not cascade into another step down)', () => {
    const c = new QualityController({ startTier: 2 });
    const r = feed(c, 0, 12, (t) => (t < 4000 ? 40 : t < 4800 ? 120 : 16.7));
    expect(r.changes.map((x) => x.tier)).toEqual([1]);
  });

  it('never thrashes on an alternating workload (≤ 1 change per 3 s, and far fewer than windows)', () => {
    const c = new QualityController({ startTier: 1, upDelayMs: 6000 });
    // 4 s good, 4 s bad, repeat, for 4 minutes
    const r = feed(c, 0, 240, (t) => (Math.floor(t / 4000) % 2 === 0 ? 16.7 : 38));
    for (let i = 1; i < r.changes.length; i++)
      expect(r.changes[i]!.t - r.changes[i - 1]!.t).toBeGreaterThanOrEqual(3000);
    expect(r.changes.length).toBeLessThan(30);
  });

  it('respects min/max tier and rejects nonsense input', () => {
    const c = new QualityController({ startTier: 1, minTier: 1, maxTier: 1 });
    expect(feed(c, 0, 60, () => 60).changes).toEqual([]);
    expect(feed(new QualityController(), 0, 60, () => 8).tier).toBeLessThanOrEqual(2);
    const d = new QualityController();
    expect(d.sample(1000, NaN)).toBeNull();
    expect(d.sample(1000, -5)).toBeNull();
  });

  it('is deterministic', () => {
    const run = (): Tier[] =>
      feed(new QualityController({ startTier: 2 }), 0, 120, (t) => (t % 9000 < 4000 ? 16.7 : 36)).changes.map(
        (x) => x.tier,
      );
    expect(run()).toEqual(run());
  });

  it('a probe that survives is confirmed, restoring the base delay', () => {
    const c = new QualityController({ startTier: 0, maxTier: 1, upDelayMs: 5000 });
    const up = feed(c, 0, 10, () => 16.7);
    expect(up.changes.map((x) => x.tier)).toEqual([1]);
    const fail = feed(c, up.end, 8, () => 40); // one failed probe first: delay doubles
    expect(fail.changes.map((x) => x.tier)).toEqual([0]);
    expect(c.snapshot().upDelayMs).toBe(10_000);
    const up2 = feed(c, fail.end, 14, () => 16.7);
    expect(up2.changes.map((x) => x.tier)).toEqual([1]);
    const held = feed(c, up2.end, 12, () => 16.7);
    expect(held.changes).toEqual([]);
    c.confirmProbe(held.end);
    expect(c.snapshot().upDelayMs).toBe(5000);
  });
});
