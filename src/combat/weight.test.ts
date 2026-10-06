import { describe, expect, it } from 'vitest';
import { BLOW_HITSTOP_TICKS, BLOW_SHAKE_PX, HITSTOP_MAX_TICKS, type SimEvent } from '@/contracts';
import { makeFatShape } from './shapes';
import { makeLab } from './testing/feelLab';
import { MOVE_WEIGHTS, blowWeight, lighter } from './weight';

describe('blow weight (VFX_SPEC item 6, proposal 171)', () => {
  it('the table is the spec: 0.04 / 0.08 / 0.11 / 0.20–0.25 s and 3 / 6 / 10 / 14 px; only catastrophic passes 135 ms', () => {
    expect(BLOW_HITSTOP_TICKS).toEqual({ light: 2, medium: 5, heavy: 7, catastrophic: 14 });
    expect(BLOW_SHAKE_PX).toEqual({ light: 3, medium: 6, heavy: 10, catastrophic: 14 });
    expect(BLOW_HITSTOP_TICKS.heavy).toBeLessThanOrEqual(HITSTOP_MAX_TICKS);
    expect(BLOW_HITSTOP_TICKS.catastrophic * (1000 / 60)).toBeGreaterThanOrEqual(200);
    expect(BLOW_HITSTOP_TICKS.catastrophic * (1000 / 60)).toBeLessThanOrEqual(250);
  });

  it('the Witness and the Planet are mapped; others fall back by slot and energy; authored weights win', () => {
    expect(blowWeight('witness.sweep', null, 'crush', 100, false)).toBe('heavy');
    expect(blowWeight('witness.halo', null, 'strike', 900, false)).toBe('light');
    expect(blowWeight('planet.moonslam', null, 'strike', 900, false)).toBe('medium');
    expect(MOVE_WEIGHTS['planet.impact']).toBe('heavy');
    expect(blowWeight('x', null, 'strike', 100, false)).toBe('light');
    expect(blowWeight('x', null, 'crush', 600, false)).toBe('heavy');
    expect(blowWeight('x', null, 'ultimate', 60, false)).toBe('light'); // a barrage's small ticks
    expect(blowWeight('x', null, 'crush', 2000, true)).toBe('light'); // continuous
    const def = { id: 'x', extra: { weight: 'catastrophic' } } as never;
    expect(blowWeight('x', def, 'strike', 10, false)).toBe('catastrophic');
    expect(lighter('heavy')).toBe('medium');
    expect(lighter('light')).toBe('light');
  });

  it('the blow that KOs is catastrophic: 14-tick hit-stop past the 135 ms cap, 14 px shake, weight on the hit event', () => {
    const lab = makeLab({ gap: 200 });
    lab.step();
    // the blow lands on a body whose matter has just failed (the fake world's carve stops short of the KO mass, so the KO is
    // entered directly): the attacker's first sight of the KO is this blow
    (lab.f1 as unknown as { enterKo(): void }).enterKo();
    const sh = makeFatShape();
    sh.kind = 'point';
    sh.x = lab.f1.view.x - 40;
    sh.y = lab.f1.view.y;
    sh.r = 9;
    lab.f0.strike(
      sh,
      { type: 'KINETIC', energy: 1400, duration: 1, flags: 0, params: {} },
      700,
      0,
      0.5,
      10,
      'crush',
      'probe',
    );
    const ev: readonly SimEvent[] = lab.m.events;
    expect(lab.f1.view.ko).toBe(true);
    const stops = ev.filter((e) => e.t === 'hitstop').map((e) => (e.t === 'hitstop' ? e.ticks : 0));
    expect(Math.max(...stops)).toBe(BLOW_HITSTOP_TICKS.catastrophic);
    expect(ev.some((e) => e.t === 'shake' && e.amp === BLOW_SHAKE_PX.catastrophic)).toBe(true);
    expect(ev.some((e) => e.t === 'hit' && e.weight === 'catastrophic')).toBe(true);
    // (the match's clamp letting it past 8 ticks is covered in src/sim/match.test.ts)
  });
});
