import { describe, expect, it } from 'vitest';
import { Btn, CANCEL_WINDOW_FRACTION, type SimEvent } from '@/contracts';
import { makeLab, measureCommand } from './testing/feelLab';

const hitBy0 = (ev: SimEvent[]): Extract<SimEvent, { t: 'hit' }> | undefined =>
  ev.find((e): e is Extract<SimEvent, { t: 'hit' }> => e.t === 'hit' && e.attacker === 0);

describe('heavy moves: load → commit → recover (SLICE_PLAN §6)', () => {
  for (const [who, foe, id] of [
    ['lastone', 'planet', 'lastone.shatter'],
    ['planet', 'lastone', 'planet.impact'],
  ] as const) {
    it(`${id}: anticipation 0.3–0.6 s, total 1.0–2.0 s, the whole body loads back then commits along the attack axis`, () => {
      const r = measureCommand(makeLab({ a: who, b: foe, gap: 300 }), 'crush', 140);
      expect(r.anticipation).toBeGreaterThanOrEqual(18);
      expect(r.anticipation).toBeLessThanOrEqual(36);
      expect(r.total).toBeGreaterThanOrEqual(60);
      expect(r.total).toBeLessThanOrEqual(120);
      // load: the root draws back a visible distance before the blow; commit: it travels well past where it started
      expect(r.back).toBeLessThanOrEqual(-12);
      expect(r.fwd).toBeGreaterThanOrEqual(80);
    });

    it(`${id}: connects from normal spacing (230 px) on the real matter world, with a short hit-stop`, () => {
      const lab = makeLab({ a: who, b: foe, gap: 230, real: true });
      lab.a.held = Btn.CRUSH;
      lab.step();
      lab.a.held = 0;
      lab.step(70);
      const hit = hitBy0(lab.events);
      expect(hit, `${id} landed`).toBeDefined();
      expect(hit!.heavy).toBe(true);
      const stop = lab.events.find((e) => e.t === 'hitstop');
      expect(stop && stop.t === 'hitstop' ? stop.ticks : 99).toBeLessThanOrEqual(8);
    }, 30_000);
  }

  it('the recovery visibly re-balances: the Shatter lean swings back past upright before it settles', () => {
    const lab = makeLab({ gap: 400 });
    const f = lab.f0;
    lab.a.held = Btn.CRUSH;
    lab.step();
    lab.a.held = 0;
    let maxFwd = 0;
    let backAfter = 0;
    for (let i = 0; i < 100; i++) {
      lab.step();
      const l = f.body.transform.lean * f.facing;
      if (f.mv.phase === 'active') maxFwd = Math.max(maxFwd, l);
      if (f.mv.phase === 'recovery') backAfter = Math.min(backAfter, l);
    }
    expect(maxFwd).toBeGreaterThanOrEqual(8);
    expect(backAfter).toBeLessThanOrEqual(-2);
  });

  it('a heavy windup is feintable into Guard or Surge during its first 40 %, not after', () => {
    const lab = makeLab({ gap: 300 });
    lab.a.held = Btn.CRUSH;
    lab.step();
    lab.a.held = 0;
    const window = Math.floor(lab.f0.mv.startup * CANCEL_WINDOW_FRACTION);
    lab.step(window - 2);
    expect(lab.f0.view.cancellable).toBe(true);
    lab.a.held = Btn.GUARD;
    lab.step();
    expect(lab.f0.view.state).toBe('guard');
  });
});
