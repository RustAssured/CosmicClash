import { describe, expect, it } from 'vitest';
import { Btn, MAX_FIGHTER_DY } from '@/contracts';
import { ORBIT, ZDEPTH, classifyOrbit, makeOrbitFrame, orbitFrame, zScale } from './orbit';
import { makeLab } from './testing/feelLab';

const frame = (x: number, y: number, vx: number, vy: number): ReturnType<typeof makeOrbitFrame> =>
  orbitFrame(x, y, vx, vy, 0, 0, 0, 0, makeOrbitFrame());

describe('orbital footwork: the readable states (unit)', () => {
  it('classifies closing, widening, circling, a collision course, drifting and a slingshot', () => {
    const mem = (): { prevVr: number; sling: number } => ({ prevVr: 0, sling: 0 });
    const top = 200;
    expect(classifyOrbit(frame(-300, 0, 80, 0), top, 150, mem())).toBe('closing');
    expect(classifyOrbit(frame(-300, 0, -80, 0), top, 150, mem())).toBe('widening');
    expect(classifyOrbit(frame(-300, 0, 0, 120), top, 150, mem())).toBe('orbit');
    expect(classifyOrbit(frame(-200, 0, 260, 0), top, 150, mem())).toBe('collision');
    expect(classifyOrbit(frame(-300, 0, 10, 10), top, 150, mem())).toBe('neutral');
    // swinging past the closest approach faster than top speed, then opening out: a slingshot
    const m = mem();
    expect(classifyOrbit(frame(-180, 30, 150, 160), top, 150, m)).not.toBe('slingshot');
    expect(classifyOrbit(frame(-150, 60, -60, 260), top, 150, m)).toBe('slingshot');
    // a slow pass is not one
    const slow = mem();
    classifyOrbit(frame(-180, 30, 40, 30), top, 150, slow);
    expect(classifyOrbit(frame(-150, 60, -30, 60), top, 150, slow)).not.toBe('slingshot');
  });

  it('the depth offset gives a ±12 % scale hint at most', () => {
    expect(zScale(0)).toBe(1);
    expect(zScale(ZDEPTH.max)).toBeCloseTo(1.12);
    expect(zScale(-10 * ZDEPTH.max)).toBeCloseTo(0.88);
  });
});

describe('orbital footwork in the fighter (footwork: orbit)', () => {
  /** Stick along the tangent around the foe (in the scaled plane), recomputed each tick. */
  const circle = (
    lab: ReturnType<typeof makeLab>,
    ticks: number,
  ): { swept: number; rMin: number; rMax: number } => {
    const { f0, f1, a, step } = lab;
    let prev = Math.atan2((f0.py - f1.py) * ORBIT.ey, f0.px - f1.px);
    let swept = 0;
    let rMin = 1e9;
    let rMax = 0;
    for (let k = 0; k < ticks; k++) {
      const dx = f0.px - f1.px;
      const dy = (f0.py - f1.py) * ORBIT.ey;
      const l = Math.hypot(dx, dy) || 1;
      a.moveX = -dy / l;
      a.moveY = dx / l;
      step();
      const ang = Math.atan2((f0.py - f1.py) * ORBIT.ey, f0.px - f1.px);
      let d = ang - prev;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      swept += d;
      prev = ang;
      const r = Math.hypot(f0.px - f1.px, (f0.py - f1.py) * ORBIT.ey);
      rMin = Math.min(rMin, r);
      rMax = Math.max(rMax, r);
    }
    return { swept, rMin, rMax };
  };

  it('holding the stick around the foe circles it on a flattened ellipse, reported as an orbit', () => {
    const lab = makeLab({ gap: 260, footwork: 'orbit' });
    let orbitTicks = 0;
    const r = circle(lab, 60);
    for (let k = 0; k < 120; k++) {
      circle(lab, 1);
      if (lab.f0.view.orbit === 'orbit') orbitTicks++;
    }
    expect(Math.abs(r.swept)).toBeGreaterThan(0.6);
    expect(orbitTicks).toBeGreaterThan(60);
    expect(r.rMax).toBeLessThanOrEqual(ORBIT.tetherMax + 1);
    // flattened: the vertical extent of the path is a fraction of the horizontal one
    expect(Math.abs(lab.f0.py - lab.f1.py)).toBeLessThanOrEqual(MAX_FIGHTER_DY + 1e-6);
  });

  it('momentum is kept with drag: a push keeps coasting after the stick is let go, with no rest altitude pulling it', () => {
    const lab = makeLab({ gap: 300, footwork: 'orbit' });
    const { f0, a, step } = lab;
    a.moveY = -1;
    step(20);
    const v = Math.hypot(f0.vx, f0.vy);
    a.moveY = 0;
    step(21);
    const ratio = Math.hypot(f0.vx, f0.vy) / v;
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.75);
    // no floor and no altitude spring: the body stays where momentum left it (gravity toward the foe aside)
    const y = f0.py;
    step(60);
    expect(f0.py).toBeLessThan(lab.m.arena.restY - 20);
    expect(Math.abs(f0.py - y)).toBeLessThan(40);
  });

  it('running away never breaks the radial tether nor the view height', () => {
    const lab = makeLab({ gap: 300, footwork: 'orbit' });
    const { f0, f1, a, b, step } = lab;
    a.moveX = -1;
    a.moveY = -1;
    b.moveX = 1;
    b.moveY = 1;
    let rMax = 0;
    let dyMax = 0;
    for (let k = 0; k < 300; k++) {
      step();
      rMax = Math.max(rMax, Math.hypot(f0.px - f1.px, (f0.py - f1.py) * ORBIT.ey));
      dyMax = Math.max(dyMax, Math.abs(f0.py - f1.py));
    }
    expect(rMax).toBeLessThanOrEqual(ORBIT.tetherMax + 1);
    expect(dyMax).toBeLessThanOrEqual(MAX_FIGHTER_DY + 1e-6);
  });

  it('contact is symmetric: a body rammed into another shares its momentum by mass, whichever slot it is', () => {
    const ram = (attackerSlot: 0 | 1): { va: number; vb: number } => {
      const lab = makeLab({ a: 'lastone', b: 'lastone', gap: 200, footwork: 'orbit' });
      const att = attackerSlot === 0 ? lab.f0 : lab.f1;
      const def = attackerSlot === 0 ? lab.f1 : lab.f0;
      att.vx = (def.px > att.px ? 1 : -1) * 600;
      for (let k = 0; k < 30; k++) lab.step();
      return { va: Math.abs(att.vx), vb: Math.abs(def.vx) };
    };
    const a = ram(0);
    const b = ram(1);
    // the defender was shoved, and the outcome does not depend on which slot rammed (D17 alternation)
    expect(a.vb).toBeGreaterThan(50);
    expect(Math.abs(a.vb - b.vb)).toBeLessThan(a.vb * 0.15);
  });

  it('attacks aim at the foe: with the foe above, the Shatter cone points up at it', () => {
    const lab = makeLab({ gap: 70, dy: -170, footwork: 'orbit' });
    lab.a.held = Btn.CRUSH;
    lab.step();
    lab.a.held = 0;
    const th = lab.f0.view.threats[0]!;
    expect(th.shape.kind).toBe('cone');
    if (th.shape.kind === 'cone') expect(th.shape.dirY).toBeLessThan(-0.5);
  });

  it('classic footwork reports no orbit state', () => {
    const lab = makeLab({ gap: 260 });
    lab.a.moveY = 1;
    lab.step(30);
    expect(lab.f0.view.orbit).toBe('neutral');
  });
});

describe('depth offset prototype (zdepth)', () => {
  it('a Surge dives off the plane, the spring always brings it back, and far apart in depth nothing collides or hits', () => {
    const lab = makeLab({ gap: 300, zdepth: true, footwork: 'orbit' });
    const { f0, a, step } = lab;
    a.moveY = 1;
    a.held = Btn.SURGE;
    step();
    a.held = 0;
    a.moveY = 0;
    let zMax = 0;
    for (let k = 0; k < 20; k++) {
      step();
      zMax = Math.max(zMax, f0.view.z);
    }
    expect(zMax).toBeGreaterThan(ZDEPTH.collide);
    expect(zMax).toBeLessThanOrEqual(ZDEPTH.max);
    step(100);
    expect(Math.abs(f0.view.z)).toBeLessThan(1);
  });

  it('while |Δz| exceeds the gate, a blow passes through', () => {
    const lab = makeLab({ gap: 150, zdepth: true });
    lab.f0.z = ZDEPTH.collide + 5;
    lab.step();
    lab.f0.z = ZDEPTH.collide + 5;
    lab.f0.vz = 0;
    const before = lab.f1.view.bodyStats.cells;
    lab.a.held = Btn.STRIKE;
    for (let k = 0; k < 20; k++) {
      lab.f0.z = ZDEPTH.collide + 5;
      lab.step();
      lab.a.held = 0;
    }
    expect(lab.events.some((e) => e.t === 'hit' && e.attacker === 0)).toBe(false);
    expect(lab.f1.view.bodyStats.cells).toBe(before);
  });
});
