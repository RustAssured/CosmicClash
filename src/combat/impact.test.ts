import { describe, expect, it } from 'vitest';
import { HITSTOP_MAX_TICKS, type SimEvent } from '@/contracts';
import { IMPACT, makeImpactResult, resolveImpact } from './impact';
import { makeLab, probeHit } from './testing/feelLab';
import type { FakeWorld } from './testing/fakeWorld';

const R = 60;
const G = R / 1.55;
const hit = (cx: number, cy: number, jx = 2000, jy = 0): ReturnType<typeof makeImpactResult> =>
  resolveImpact(cx, cy, jx, jy, 0, 0, 5, G, R, makeImpactResult());

describe('impact model: a force at a point (unit)', () => {
  it('a centre hit translates and barely spins; an edge hit spins in the sense of the lever arm', () => {
    const c = hit(-R * 0.9, 0);
    expect(c.cls).toBe('centre');
    expect(Math.abs(c.dw)).toBeLessThan(0.05);
    expect(c.jx).toBeCloseTo(2000 * IMPACT.linear.centre);
    // pushing +x above the centre turns the body clockwise (+), below it counter-clockwise (−)
    const high = hit(-R * 0.6, -R * 0.4);
    const lowEdge = hit(-R * 0.6, R * 0.3);
    expect(high.cls).toBe('edge');
    expect(high.dw).toBeGreaterThan(0.1);
    expect(lowEdge.dw).toBeLessThan(-0.05);
    expect(high.jx).toBeLessThan(c.jx);
  });

  it('a glancing hit slides off (little momentum) and spins hardest; a low hit lifts and sweeps the base', () => {
    const glance = hit(-R * 0.3, -R * 0.8);
    const edge = hit(-R * 0.6, -R * 0.4);
    expect(glance.cls).toBe('glancing');
    expect(Math.abs(glance.dw)).toBeGreaterThan(Math.abs(edge.dw));
    expect(glance.jx).toBeLessThan(edge.jx);
    const low = hit(-R * 0.6, R * 0.45);
    expect(low.cls).toBe('low');
    expect(low.jy).toBeLessThan(0); // lifted
    expect(low.dw).toBeLessThan(0); // the base is swept forward, the top falls back toward the attacker
  });

  it('spin scales with the lever arm and is capped', () => {
    const a = hit(-R * 0.6, -R * 0.3);
    const b = hit(-R * 0.6, -R * 0.5);
    expect(Math.abs(b.dw)).toBeGreaterThan(Math.abs(a.dw));
    const huge = hit(-R * 0.6, -R * 0.5, 1e6, 0);
    expect(Math.abs(huge.dw)).toBeLessThanOrEqual(IMPACT.maxDeltaW + 1e-9);
  });
});

describe('impact model in the fighter', () => {
  it('centre, edge, glancing and low blows on the Planet look different: translation vs spin, sign and size', () => {
    const at = (ox: number, oy: number): ReturnType<typeof probeHit> =>
      probeHit(makeLab({ gap: 200 }), ox, oy);
    const centre = at(-40, 0);
    const edge = at(-35, -26);
    const glance = at(-25, -48);
    const low = at(-38, 34);
    expect([centre.cls, edge.cls, glance.cls, low.cls]).toEqual(['centre', 'edge', 'glancing', 'low']);
    expect(Math.abs(centre.dw)).toBeLessThan(0.1);
    expect(centre.dvx).toBeGreaterThan(edge.dvx);
    expect(edge.dvx).toBeGreaterThan(glance.dvx);
    expect(edge.dw).toBeGreaterThan(0.3);
    expect(glance.dw).toBeGreaterThan(edge.dw);
    expect(low.dw).toBeLessThan(-0.3);
    expect(low.dvy).toBeLessThan(0);
  });

  it('knockback is momentum: the struck body keeps the velocity (no separate ease-out), a heavier body gets less', () => {
    const light = probeHit(makeLab({ a: 'lastone', b: 'asteroid', gap: 170 }), -20, 0);
    const heavy = probeHit(makeLab({ a: 'lastone', b: 'planet', gap: 200 }), -40, 0);
    expect(light.dvx).toBeGreaterThan(heavy.dvx * 1.4);
    expect(heavy.dvx).toBeGreaterThan(100);
  });

  it('a heavy blow reaches the 8-tick hit-stop cap, tells the world through DamageEvent.hitstop, and announces its class', () => {
    const lab = makeLab({ gap: 200 });
    probeHit(lab, -40, 0, 1400, 760);
    // the blow was struck outside a step: its events are still on the match's bus
    const ev: readonly SimEvent[] = lab.m.events;
    const stop = ev.find((e) => e.t === 'hitstop');
    expect(stop && stop.t === 'hitstop' ? stop.ticks : 0).toBe(HITSTOP_MAX_TICKS);
    expect(HITSTOP_MAX_TICKS).toBe(8);
    const log = (lab.m.world as FakeWorld).damageLog;
    expect(log[log.length - 1]!.ev.hitstop).toBe(HITSTOP_MAX_TICKS);
    expect(ev.some((e) => e.t === 'cue' && e.id === 'hit-centre')).toBe(true);
  });

  it('the camera rolls with the spin a blow puts in (ω-driven): an edge hit rolls it, a centre hit does not', () => {
    const rollOf = (oy: number): number => {
      const lab = makeLab({ gap: 200 });
      probeHit(lab, -35, oy);
      const r = lab.m.events.find((e) => e.t === 'roll');
      return r && r.t === 'roll' ? r.radians : 0;
    };
    expect(Math.abs(rollOf(0))).toBeLessThan(1e-6);
    expect(rollOf(-26)).toBeGreaterThan(0.002);
  });
});
