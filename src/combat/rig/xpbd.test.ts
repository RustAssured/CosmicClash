import { describe, expect, it } from 'vitest';
import { XpbdRig, angleIndex, massFromCells, wrapAngle, type BreakEvent, type MassProps } from './xpbd';

const mp = (mass: number, r: number, cx = 0, cy = 0): MassProps => ({
  mass,
  cx,
  cy,
  inertia: (mass * r * r) / 2,
  cells: Math.round(mass),
});

/**
 * A Witness-like rig: a kinematic eye (intent), the carapace pinned to it, the heavy shrine hanging below the carapace, and two
 * 2-segment arms. Drives hold every region at its rest angle relative to its parent; their frequencies set the motion order.
 */
function witnessRig(): {
  rig: XpbdRig;
  eye: number;
  carapace: number;
  shrine: number;
  arms: number[];
  tips: number[];
  driveCarapace: number;
} {
  const rig = new XpbdRig(16);
  const eye = rig.addBody(0, 0, 0, mp(3000, 30), { kinematic: true });
  const carapace = rig.addBody(0, 0, 0, mp(7000, 48, 0, 6));
  rig.addJoint({ a: carapace, b: eye, ax: 0, ay: 0, bx: 0, by: 0 });
  const driveCarapace = rig.addDrive({ a: eye, b: carapace, target: 0, hz: 4, zeta: 0.9 });
  const shrine = rig.addBody(0, 44, 0, mp(2600, 30, 0, 28));
  rig.addJoint({ a: shrine, b: carapace, ax: 0, ay: 0, bx: 0, by: 44 });
  rig.addDrive({ a: carapace, b: shrine, target: 0, hz: 1.6, zeta: 0.55 });
  const arms: number[] = [];
  const tips: number[] = [];
  for (const side of [-1, 1]) {
    const s0 = rig.addBody(side * 44, -6, 0, mp(500, 18, side * 20, 0));
    rig.addJoint({ a: s0, b: carapace, ax: 0, ay: 0, bx: side * 44, by: -6 });
    rig.addDrive({ a: carapace, b: s0, target: 0, hz: 1.3, zeta: 0.5 });
    const s1 = rig.addBody(side * 84, -6, 0, mp(300, 16, side * 18, 6));
    rig.addJoint({ a: s1, b: s0, ax: 0, ay: 0, bx: side * 40, by: 0 });
    rig.addDrive({ a: s0, b: s1, target: 0, hz: 1.1, zeta: 0.45 });
    rig.addLimit({ a: s0, b: s1, min: -0.8, max: 0.8 });
    arms.push(s0, s1);
    tips.push(s1);
  }
  return { rig, eye, carapace, shrine, arms, tips, driveCarapace };
}

describe('massFromCells', () => {
  it('a 10×10 square: mass, centre and inertia match the continuous plate', () => {
    const w = 16;
    const h = 16;
    const material = new Uint8Array(w * h);
    const density = new Uint8Array(w * h);
    for (let y = 3; y < 13; y++)
      for (let x = 2; x < 12; x++) {
        material[y * w + x] = 1;
        density[y * w + x] = 128;
      }
    const out = massFromCells({ w, h, material, density }, [0, 1], 2, 3, {} as MassProps);
    expect(out.mass).toBe(100);
    expect(out.cx).toBeCloseTo(5, 9);
    expect(out.cy).toBeCloseTo(5, 9);
    expect(out.inertia).toBeCloseTo((100 * (100 + 100)) / 12, 6);
  });

  it('destroying cells shifts the centre of mass and lowers the inertia; setMass keeps the frame in place', () => {
    const w = 20;
    const h = 10;
    const material = new Uint8Array(w * h).fill(1);
    const density = new Uint8Array(w * h).fill(128);
    const full = massFromCells({ w, h, material, density }, [0, 1], 0, 5, {} as MassProps);
    for (let y = 0; y < h; y++) for (let x = 12; x < w; x++) material[y * w + x] = 0;
    const cut = massFromCells({ w, h, material, density }, [0, 1], 0, 5, {} as MassProps);
    expect(cut.cx).toBeLessThan(full.cx - 3);
    expect(cut.inertia).toBeLessThan(full.inertia * 0.3);
    const rig = new XpbdRig(2);
    const b = rig.addBody(50, 60, 0.3, full);
    const f0 = { x: 0, y: 0, a: 0 };
    const f1 = { x: 0, y: 0, a: 0 };
    rig.frame(b, f0);
    rig.setMass(b, cut);
    rig.frame(b, f1);
    expect(f1.x).toBeCloseTo(f0.x, 9);
    expect(f1.y).toBeCloseTo(f0.y, 9);
  });
});

describe('XpbdRig', () => {
  it('angle helpers wrap and quantise', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapAngle(-3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(angleIndex(0, 256)).toBe(0);
    expect(angleIndex(-1e-4, 256)).toBe(0);
    expect(angleIndex(Math.PI, 256)).toBe(128);
    expect(angleIndex(-Math.PI / 2, 256)).toBe(192);
  });

  it('is deterministic: identical inputs give bit-identical state', () => {
    const run = (): number => {
      const { rig, eye, arms } = witnessRig();
      for (let t = 0; t < 600; t++) {
        rig.setKinematic(eye, Math.sin(t * 0.05) * 30, 0, Math.sin(t * 0.03) * 0.6);
        if (t % 97 === 0) rig.applyImpulse(arms[1]!, 4e4, -2e4, 80, 0);
        rig.step();
      }
      return rig.hash();
    };
    expect(run()).toBe(run());
  });

  it('order of motion on a turn: the eye leads, then the carapace, then the mass, then the arms', () => {
    const { rig, eye, carapace, shrine, tips } = witnessRig();
    for (let t = 0; t < 30; t++) rig.step();
    const target = 0.5;
    // the turn: intent locks the eye in one tick
    rig.setKinematic(eye, 0, 0, target);
    const com = (): number => {
      // angle of the whole system's centre of mass about the eye (the mass shift)
      let mx = 0;
      let my = 0;
      let m = 0;
      for (let i = 1; i < rig.n; i++) {
        const mi = 1 / rig.invMass[i]!;
        mx += rig.x[i]! * mi;
        my += rig.y[i]! * mi;
        m += mi;
      }
      return Math.atan2(my / m, mx / m);
    };
    const com0 = com();
    const watch: [string, () => number][] = [
      ['eye', () => rig.a[eye]!],
      ['carapace', () => rig.a[carapace]!],
      ['mass', () => com() - com0],
      ['shrine', () => rig.a[shrine]!],
      ['arm tips', () => rig.a[tips[0]!]!],
    ];
    const reached: Record<string, number> = {};
    for (let t = 1; t <= 240; t++) {
      rig.step();
      for (const [name, f] of watch)
        if (reached[name] === undefined && f() >= target * 0.5) reached[name] = t;
    }
    expect(reached['eye']).toBe(1);
    expect(reached['carapace']!).toBeGreaterThan(reached['eye']!);
    expect(reached['mass']!).toBeGreaterThan(reached['carapace']!);
    expect(reached['arm tips']!).toBeGreaterThan(reached['mass']!);
    // and everything settles on the new heading
    for (let t = 0; t < 300; t++) rig.step();
    expect(rig.a[carapace]!).toBeCloseTo(target, 2);
    expect(rig.a[shrine]!).toBeCloseTo(target, 1);
    expect(rig.a[tips[0]!]!).toBeCloseTo(target, 1);
  });

  it('a lunge: the structure follows at once, the shrine drags behind (swings back), then settles', () => {
    const { rig, eye, carapace, shrine } = witnessRig();
    for (let t = 0; t < 10; t++) rig.step();
    let maxShrine = 0;
    for (let t = 0; t < 20; t++) {
      rig.setKinematic(eye, (t + 1) * 6, 0, 0);
      rig.step();
      maxShrine = Math.max(maxShrine, rig.a[shrine]!);
    }
    const f = { x: 0, y: 0, a: 0 };
    rig.frame(carapace, f);
    expect(f.x).toBeCloseTo(120, 0); // pinned to the eye: no lag in position
    // moving +x, a hanging mass swings back: its bottom trails, i.e. it rotates positive (y down: bottom swings to −x)
    expect(maxShrine).toBeGreaterThan(0.02);
    for (let t = 0; t < 400; t++) rig.step();
    expect(Math.abs(rig.a[shrine]!)).toBeLessThan(0.01);
  });

  it('violent kicks (hundreds of rad/s) stay bounded and the rig settles once they stop', () => {
    const { rig, eye, arms } = witnessRig();
    let seed = 99;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296 - 0.5;
    };
    let maxW = 0;
    for (let t = 0; t < 1500; t++) {
      if (t % 13 === 0) rig.applyImpulse(arms[((t / 13) % arms.length) | 0]!, rnd() * 4e5, rnd() * 4e5, 0, 0);
      rig.step();
      for (let i = 0; i < rig.n; i++) maxW = Math.max(maxW, Math.abs(rig.w[i]!));
    }
    expect(maxW).toBeLessThan(400);
    rig.setKinematic(eye, 0, 0, 0);
    for (let t = 0; t < 900; t++) rig.step();
    for (let i = 0; i < rig.n; i++) {
      expect(Math.abs(rig.w[i]!)).toBeLessThan(0.05);
      expect(Math.hypot(rig.vx[i]!, rig.vy[i]!)).toBeLessThan(1);
    }
  });

  it('stays stable under random kicks with a 25:1 mass ratio (no NaN, rigid joints hold within 0.5 px)', () => {
    const { rig, eye, arms } = witnessRig();
    let seed = 12345;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296 - 0.5;
    };
    const p = { x: 0, y: 0 };
    const q = { x: 0, y: 0 };
    let worst = 0;
    for (let t = 0; t < 3000; t++) {
      rig.setKinematic(eye, rnd() * 4 + Math.sin(t * 0.02) * 60, rnd() * 4, Math.sin(t * 0.011) * 0.7);
      if (t % 13 === 0) rig.applyImpulse(arms[((t / 13) % arms.length) | 0]!, rnd() * 4e4, rnd() * 4e4, 0, 0);
      rig.step();
      for (const j of rig.joints) {
        if (j.hz > 0 || j.b < 0) continue;
        rig.worldPoint(j.a, j.ax, j.ay, p);
        rig.worldPoint(j.b, j.bx, j.by, q);
        worst = Math.max(worst, Math.hypot(p.x - q.x, p.y - q.y));
      }
    }
    for (let i = 0; i < rig.n; i++) {
      expect(Number.isFinite(rig.x[i]!)).toBe(true);
      expect(Number.isFinite(rig.a[i]!)).toBe(true);
    }
    expect(worst).toBeLessThan(0.5);
  });

  it('a joint fails above its break force, once; a wounded joint (low health) fails under a smaller load', () => {
    const load = (
      health: number,
      impulse: number,
    ): { broke: boolean; events: BreakEvent[]; drift: number } => {
      const rig = new XpbdRig(4);
      const root = rig.addBody(0, 0, 0, mp(1000, 20), { kinematic: true });
      const arm = rig.addBody(40, 0, 0, mp(200, 12, 20, 0));
      const j = rig.addJoint({ a: arm, b: root, ax: 0, ay: 0, bx: 40, by: 0, breakForce: 2e7 });
      rig.setHealth(j, health);
      for (let t = 0; t < 5; t++) rig.step();
      rig.applyImpulse(arm, impulse, 0, 60, 0);
      for (let t = 0; t < 30; t++) rig.step();
      const events: BreakEvent[] = [];
      rig.drainBreaks(events);
      const f = { x: 0, y: 0, a: 0 };
      rig.frame(arm, f);
      return { broke: rig.joints[j]!.broken, events, drift: f.x - 40 };
    };
    const soft = load(1, 1e4);
    expect(soft.broke).toBe(false);
    expect(Math.abs(soft.drift)).toBeLessThan(0.5);
    const hard = load(1, 2e5);
    expect(hard.broke).toBe(true);
    expect(hard.events).toHaveLength(1);
    expect(hard.drift).toBeGreaterThan(20); // severed: the arm flies off
    const wounded = load(0.25, 3e4);
    const healthy = load(1, 3e4);
    expect(healthy.broke).toBe(false);
    expect(wounded.broke).toBe(true);
  });

  it('health 0 severs the joint immediately; angle limits hold', () => {
    const rig = new XpbdRig(4);
    const root = rig.addBody(0, 0, 0, mp(1000, 20), { kinematic: true });
    const arm = rig.addBody(40, 0, 0, mp(200, 12, 20, 0));
    const j = rig.addJoint({ a: arm, b: root, ax: 0, ay: 0, bx: 40, by: 0 });
    rig.addLimit({ a: root, b: arm, min: -0.3, max: 0.3 });
    for (let t = 0; t < 60; t++) {
      rig.applyImpulse(arm, 0, 3e3, 70, 0);
      rig.step();
      // joints are solved last (connection first), so a limit may be exceeded by a hair within a tick
      expect(rig.a[arm]!).toBeLessThan(0.3 + 0.02);
    }
    rig.setHealth(j, 0);
    expect(rig.joints[j]!.broken).toBe(true);
  });
});
