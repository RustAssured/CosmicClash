import { describe, expect, it } from 'vitest';
import { makeLab } from './testing/feelLab';

/**
 * WJ's bug (Gate C): in orbit footwork, swinging over and under an idle Planet made the Witness "explode" — every pass turned
 * the fighter round, the rig's turn-round (flipRig) mirrored each part inside the canonical frame, the XPBD solver blew the
 * structure apart, the region union bounds grew to thousands of px, the contact pushed the roots hundreds of px a tick, the
 * tethers snapped them back, and the flung regions met debris at absurd speeds and were severed. Fifteen seconds of over /
 * under passes (straight, then on the diagonal) must stay smooth, inside the arena, and cost no matter.
 */
const passes = (witness: boolean): void => {
  const lab = makeLab({ a: 'lastone', b: 'planet', witness, real: true, footwork: 'orbit', gap: 220 });
  const { a, f0, f1, m } = lab;
  const ar = m.arena;
  const mass0 = f0.view.bodyStats.massFrac;
  const regions0 = f0.regions.length;
  let fc = f0.facing;
  let turns = 0;
  let maxStep = 0;
  let outside = 0;
  // the body holds together: its live bounds (the union with every region for the Witness, ≈ 275 px) never blow up
  let span = 0;
  let p = [f0.px, f0.py, f1.px, f1.py];
  for (let t = 0; t < 900; t++) {
    // over, under, over… (200-tick holds), the second half on an analog diagonal
    const up = t % 400 < 200 ? -1 : 1;
    a.moveX = t < 450 ? 0 : -0.7 * up;
    a.moveY = t < 450 ? up : 0.7 * up;
    lab.step();
    if (f0.facing !== fc) {
      turns++;
      fc = f0.facing;
    }
    maxStep = Math.max(
      maxStep,
      Math.hypot(f0.px - p[0]!, f0.py - p[1]!),
      Math.hypot(f1.px - p[2]!, f1.py - p[3]!),
    );
    p = [f0.px, f0.py, f1.px, f1.py];
    const b = f0.liveBounds();
    span = Math.max(span, b.x1 - b.x0, b.y1 - b.y0);
    for (const f of [f0, f1])
      if (f.px < ar.minX || f.px > ar.maxX || f.py < ar.minY || f.py > ar.maxY) outside++;
  }
  // the passes really happened: the fighter turned round over and over
  expect(turns).toBeGreaterThanOrEqual(3);
  expect(maxStep).toBeLessThan(12);
  expect(outside).toBe(0);
  expect(span).toBeLessThan(450);
  // no blow landed, so no matter is lost and nothing is severed
  expect(lab.events.some((e) => e.t === 'hit')).toBe(false);
  expect(f0.view.bodyStats.massFrac).toBe(mass0);
  expect(f0.regions.length).toBe(regions0);
  expect(f0.view.integrityPct).toBe(100);
  expect(f1.view.integrityPct).toBe(100);
};

describe('passing over and under an idle foe (orbit footwork)', () => {
  it('the Witness: no teleports, stays in the arena, loses no matter', () => passes(true), 120_000);
  it('the Last One: no teleports, stays in the arena, loses no matter', () => passes(false), 120_000);
});
