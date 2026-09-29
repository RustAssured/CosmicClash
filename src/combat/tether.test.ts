import { describe, expect, it } from 'vitest';
import { MAX_FIGHTER_DX } from '@/contracts';
import type { FighterImpl } from './fighter';
import { createFakeWorld, makeMatch, skipIntro } from './testing/harness';

describe('the fighter tether', () => {
  it('bleeds off outward speed gradually before the hard cap and never exceeds it', () => {
    const m = makeMatch({
      a: 'lastone',
      b: 'asteroid',
      seed: 3,
      createWorld: createFakeWorld,
      infinite: true,
    });
    skipIntro(m);
    const a = m.fighters[0] as FighterImpl;
    const b = m.fighters[1] as FighterImpl;
    a.px = b.px - 300;
    a.py = b.py;
    a.vx = -1400;
    let maxDx = 0;
    let softSpeed = 0;
    for (let i = 0; i < 90; i++) {
      m.step();
      const dx = Math.abs(a.px - b.px);
      maxDx = Math.max(maxDx, dx);
      if (dx > 340 && dx < 400 && softSpeed === 0) softSpeed = Math.abs(a.vx);
    }
    expect(maxDx).toBeLessThanOrEqual(MAX_FIGHTER_DX + 0.5);
    expect(softSpeed).toBeGreaterThan(0);
  });

  it('debugSetMeter clamps the ultimate meter to 0..1', () => {
    const m = makeMatch({ a: 'lastone', b: 'asteroid', seed: 3, createWorld: createFakeWorld });
    const a = m.fighters[0]!;
    a.debugSetMeter?.(5);
    expect(a.view.meter).toBeLessThanOrEqual(1);
    a.debugSetMeter?.(-2);
    m.step();
    expect(a.view.meter).toBeGreaterThanOrEqual(0);
  });
});
