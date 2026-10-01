import { describe, expect, it } from 'vitest';
import { DEFAULT_LIGHTING } from '@/contracts';
import { paintWitness, WITNESS_MATERIALS } from '@/titans/art/lastone';
import { resolveMaterials } from '@/titans/materialTable';
import { buildWitnessRig, setWitnessHeading } from './witnessRig';
import { wrapAngle } from './xpbd';

const W = paintWitness(1234, DEFAULT_LIGHTING);
const MATS = resolveMaterials(WITNESS_MATERIALS);

describe('the Witness rig (v1 regions on XpbdRig)', () => {
  it('one rig body per rigid region; the interior layers are welded into the carapace; the eye is kinematic', () => {
    const wr = buildWitnessRig(W, MATS, 0, 0);
    const welded = W.regions.filter((r) => r.weld).length;
    expect(wr.rig.n).toBe(W.regions.length - welded);
    W.regions.forEach((r, i) => {
      if (r.weld) expect(wr.bodyOf[i]).toBe(wr.carapace);
    });
    expect(wr.rig.kinematic[wr.eye]).toBe(1);
    expect(wr.arms.map((a) => a.bodies.length)).toEqual(W.arms.map((a) => a.regions.length));
  });

  it('a turn: the eye locks in one tick, then carapace, mass and shrine; arms and halo lag; all settle within 1.2 s', () => {
    const wr = buildWitnessRig(W, MATS, 0, 0);
    const { rig } = wr;
    for (let t = 0; t < 10; t++) rig.step();
    const TURN = 0.5;
    const reached: Record<string, number> = {};
    const mark = (k: string, v: number, t: number): void => {
      if (reached[k] === undefined && v >= TURN / 2) reached[k] = t;
    };
    let settled = -1;
    let calm = 0;
    for (let t = 1; t <= 120; t++) {
      rig.setKinematic(wr.eye, 0, 0, TURN);
      setWitnessHeading(wr, TURN);
      rig.step();
      mark('eye', rig.a[wr.eye]!, t);
      mark('carapace', rig.a[wr.carapace]!, t);
      mark('shrine', rig.a[wr.shrine]!, t);
      mark('halo', Math.min(...wr.halo.map((b) => rig.a[b]!)), t);
      mark('arms', Math.min(...wr.arms.map((a) => rig.a[a.bodies[a.bodies.length - 1]!]!)), t);
      let ok = true;
      for (let i = 0; i < rig.n; i++)
        if (Math.abs(wrapAngle(rig.a[i]! - TURN)) > 0.03 || Math.abs(rig.w[i]!) > 0.12) ok = false;
      calm = ok ? calm + 1 : 0;
      if (calm === 6 && settled < 0) settled = t - 5;
    }
    expect(reached['eye']).toBe(1);
    expect(reached['carapace']!).toBeGreaterThanOrEqual(reached['eye']!);
    expect(reached['shrine']!).toBeGreaterThan(reached['carapace']!);
    expect(reached['halo']!).toBeGreaterThan(reached['carapace']!);
    // the arm tips' lag is clearly readable (≥ 0.3 s to half the turn) …
    expect(reached['arms']!).toBeGreaterThanOrEqual(18);
    expect(reached['arms']!).toBeGreaterThan(reached['shrine']!);
    // … and everything has settled within ~1.2 s
    expect(settled).toBeGreaterThan(0);
    expect(settled).toBeLessThanOrEqual(72);
  });

  it('is deterministic', () => {
    const run = (): number => {
      const wr = buildWitnessRig(W, MATS, 0, 0);
      for (let t = 0; t < 200; t++) {
        const a = Math.sin(t * 0.05) * 0.6;
        wr.rig.setKinematic(wr.eye, Math.sin(t * 0.03) * 20, 0, a);
        setWitnessHeading(wr, a);
        wr.rig.step();
      }
      return wr.rig.hash();
    };
    expect(run()).toBe(run());
  });
});
