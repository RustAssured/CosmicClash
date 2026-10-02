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

  it('is built to the scale spec (D28): ω ≤ 7 rad/s on the carapace, ≤ 4 on everything hanging off it, ζ ≥ 0.45', () => {
    const wr = buildWitnessRig(W, MATS, 0, 0);
    for (const d of wr.rig.drives) {
      const omega = 2 * Math.PI * d.hz;
      expect(omega).toBeLessThanOrEqual(d.b === wr.carapace ? 7 : 4);
      expect(d.zeta).toBeGreaterThanOrEqual(0.45);
    }
  });

  it('breathes slowly at idle: arm tips and halo arcs sway with periods of seconds, nothing above 2 Hz', () => {
    const wr = buildWitnessRig(W, MATS, 0, 0);
    const pts = [
      ...wr.arms.map((a) => a.chain[a.chain.length - 1]!),
      ...wr.halo.map((b) => ({ body: b, x: 0, y: -60 })),
    ];
    const sig: number[][] = pts.map(() => []);
    const p = { x: 0, y: 0 };
    for (let t = 0; t < 900; t++) {
      wr.rig.setKinematic(wr.eye, 0, 0, 0);
      setWitnessHeading(wr, 0, t);
      wr.rig.step();
      if (t < 300) continue;
      pts.forEach((q, i) => {
        wr.rig.worldPoint(q.body, q.x, q.y, p);
        sig[i]!.push(p.x + p.y * 0.7);
      });
    }
    for (const s of sig) {
      const n = s.length;
      const mean = s.reduce((a, b) => a + b, 0) / n;
      let tot = 0;
      let hi = 0;
      let best = 0;
      let dom = 0;
      for (let k = 1; k < n / 2; k++) {
        let re = 0;
        let im = 0;
        for (let i = 0; i < n; i++) {
          const v = (s[i]! - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
          re += v * Math.cos((2 * Math.PI * k * i) / n);
          im -= v * Math.sin((2 * Math.PI * k * i) / n);
        }
        const pw = re * re + im * im;
        tot += pw;
        if ((k * 60) / n > 2) hi += pw;
        if (pw > best) {
          best = pw;
          dom = (k * 60) / n;
        }
      }
      expect(dom).toBeLessThanOrEqual(0.4); // periods ≥ 2.5 s
      expect(hi / tot).toBeLessThan(0.01);
    }
  });

  it('a turn: the eye locks in one tick, then carapace, mass and shrine; arms and halo lag; all settle within 4 s', () => {
    const wr = buildWitnessRig(W, MATS, 0, 0);
    const { rig } = wr;
    for (let t = 0; t < 10; t++) rig.step();
    const TURN = 0.5;
    const reached: Record<string, number> = {};
    const ninety: Record<string, number> = {};
    const mark = (k: string, v: number, t: number): void => {
      if (reached[k] === undefined && v >= TURN / 2) reached[k] = t;
      if (ninety[k] === undefined && v >= TURN * 0.9) ninety[k] = t;
    };
    let settled = -1;
    let calm = 0;
    for (let t = 1; t <= 300; t++) {
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
    // colossal scale (D28): the carapace takes ≥ 0.5 s to complete the turn, the arm tips lag by over a second …
    expect(ninety['carapace']!).toBeGreaterThanOrEqual(30);
    expect(reached['arms']!).toBeGreaterThanOrEqual(60);
    expect(reached['arms']!).toBeGreaterThan(reached['shrine']!);
    // … and everything has settled within 4 s
    expect(settled).toBeGreaterThan(0);
    expect(settled).toBeLessThanOrEqual(240);
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
