import { describe, expect, it } from 'vitest';
import { DEFAULT_LIGHTING, pa } from '@/contracts';
import { Overlay } from '../fx/overlay';
import type { SplineStyle } from '../fx/spline';
import { WitnessSoftPen, drawRigMembrane, type MembraneStyle } from './witnessDraw';
import { XpbdRig } from './xpbd';

const ST: MembraneStyle = {
  fill0: 0xff101010,
  fill1: 0xff202020,
  edge: 0xff606060,
  edgeHot: 0xffeeeeee,
  emissiveHot: 180,
};
const FIBRE: SplineStyle = {
  r0: 0.8,
  r1: 0.6,
  taperPow: 1,
  ramp: [0xff303030, 0xff707070, 0xffb0b0b0],
  rootShade: 0,
  contrast: 0.6,
  tipRamp: null,
  tipFrom: 1,
  tipEmissive: 0,
  jointEvery: 0,
  jointBulge: 0,
  outlineDark: 0,
  outlineLit: 0,
};

function fresh(): { ov: Overlay; sp: WitnessSoftPen } {
  const ov = new Overlay('t', 0, 200, 200, 'normal', true);
  const sp = new WitnessSoftPen(200, 200);
  sp.setLight(DEFAULT_LIGHTING.dir);
  ov.begin(100, 100);
  return { ov, sp };
}
const on = (ov: Overlay, x: number, y: number): boolean => pa(ov.get(x, y)) !== 0;

/** 4-connected components of the drawn pixels. */
function components(ov: Overlay): number {
  const seen = new Set<number>();
  let n = 0;
  for (let y = 0; y < 200; y++)
    for (let x = 0; x < 200; x++) {
      if (!on(ov, x, y) || seen.has(y * 200 + x)) continue;
      n++;
      const st = [[x, y]];
      seen.add(y * 200 + x);
      while (st.length) {
        const [cx, cy] = st.pop()!;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = cx! + dx!;
          const ny = cy! + dy!;
          if (nx < 0 || ny < 0 || nx >= 200 || ny >= 200 || seen.has(ny * 200 + nx) || !on(ov, nx, ny))
            continue;
          seen.add(ny * 200 + nx);
          st.push([nx, ny]);
        }
      }
    }
  return n;
}

describe('Witness soft structure: membranes, fibres, arms', () => {
  // root a, free edge b → c
  const A = [60, 60];
  const B = [140, 70];
  const C = [90, 150];
  const restBC = Math.hypot(C[0]! - B[0]!, C[1]! - B[1]!);

  it('a membrane fills its triangle, dithered opaque, and nothing outside it', () => {
    const { ov, sp } = fresh();
    const n = sp.membrane(ov, A[0]!, A[1]!, B[0]!, B[1]!, C[0]!, C[1]!, restBC, 0, ST);
    expect(n).toBeGreaterThan(1500);
    const cx = Math.round((A[0]! + B[0]! + C[0]!) / 3);
    const cy = Math.round((A[1]! + B[1]! + C[1]!) / 3);
    expect(on(ov, cx, cy)).toBe(true);
    const colours = new Set<number>();
    for (let y = cy - 3; y <= cy + 3; y++) for (let x = cx - 3; x <= cx + 3; x++) colours.add(ov.get(x, y));
    expect(colours.has(ST.fill0) && colours.has(ST.fill1)).toBe(true);
    expect(on(ov, 30, 30)).toBe(false);
    expect(on(ov, 170, 170)).toBe(false);
  });

  it('a slack membrane sags away from its free edge; a stretched one is taut and its edge lights up', () => {
    const slack = fresh();
    const taut = fresh();
    slack.sp.membrane(slack.ov, A[0]!, A[1]!, B[0]!, B[1]!, C[0]!, C[1]!, restBC * 1.6, 0, ST);
    taut.sp.membrane(taut.ov, A[0]!, A[1]!, B[0]!, B[1]!, C[0]!, C[1]!, restBC * 0.8, 0, ST);
    // a point just inside the middle of the free edge
    const mx = (B[0]! + C[0]!) / 2;
    const my = (B[1]! + C[1]!) / 2;
    const ix = Math.round(mx + (A[0]! - mx) * 0.15);
    const iy = Math.round(my + (A[1]! - my) * 0.15);
    expect(on(slack.ov, ix, iy)).toBe(false);
    expect(on(taut.ov, ix, iy)).toBe(true);
    let hot = 0;
    for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) if (taut.ov.get(x, y) === ST.edgeHot) hot++;
    expect(hot).toBeGreaterThan(20);
  });

  it('tears: a partial tear opens a gap from the free edge; a full tear parts it into two flaps', () => {
    const whole = fresh();
    const half = fresh();
    const full = fresh();
    const n0 = whole.sp.membrane(whole.ov, A[0]!, A[1]!, B[0]!, B[1]!, C[0]!, C[1]!, restBC, 0, ST);
    const n1 = half.sp.membrane(half.ov, A[0]!, A[1]!, B[0]!, B[1]!, C[0]!, C[1]!, restBC, 0.5, ST);
    full.sp.membrane(full.ov, A[0]!, A[1]!, B[0]!, B[1]!, C[0]!, C[1]!, restBC, 1, ST);
    expect(n1).toBeLessThan(n0);
    expect(components(whole.ov)).toBe(1);
    expect(components(full.ov)).toBeGreaterThanOrEqual(2);
  });

  it('a fibre runs end to end and sags with slack; torn, it hangs as two halves with a gap between', () => {
    const intact = fresh();
    intact.sp.fibre(intact.ov, 50, 100, 150, 100, 130, 0, FIBRE);
    expect(on(intact.ov, 50, 100)).toBe(true);
    expect(on(intact.ov, 149, 100)).toBe(true);
    // slack: the middle hangs below the chord
    let lowest = 0;
    for (let y = 100; y < 200; y++) if (on(intact.ov, 100, y)) lowest = y;
    expect(lowest).toBeGreaterThan(104);
    const torn = fresh();
    torn.sp.fibre(torn.ov, 50, 100, 150, 100, 100, 1, FIBRE);
    let mid = 0;
    for (let y = 0; y < 200; y++) if (on(torn.ov, 100, y)) mid++;
    expect(mid).toBe(0);
    // both halves still hang from their ends
    expect(on(torn.ov, 50, 100) || on(torn.ov, 50, 101)).toBe(true);
    expect(on(torn.ov, 149, 100) || on(torn.ov, 149, 101)).toBe(true);
  });

  it('an arm passes through its joints, tapers, and carries its blade on the blade side', () => {
    const { ov, sp } = fresh();
    const xs = [40, 80, 115, 140];
    const ys = [60, 70, 100, 140];
    const spine: SplineStyle = { ...FIBRE, r0: 4, r1: 1, ramp: [0xff101010, 0xff303030, 0xff505050] };
    const blade: SplineStyle = { ...FIBRE, r0: 3, r1: 1, ramp: [0xff004000, 0xff008000] };
    sp.arm(ov, xs, ys, 4, spine, blade, 1, 7);
    for (let k = 0; k < 4; k++) expect(on(ov, Math.floor(xs[k]!), Math.floor(ys[k]!))).toBe(true);
    let bladePx = 0;
    for (let y = 0; y < 200; y++)
      for (let x = 0; x < 200; x++) if (blade.ramp.includes(ov.get(x, y))) bladePx++;
    expect(bladePx).toBeGreaterThan(40);
    // left of the direction of travel (+1): for this downward-right curve that is up and to the right of the spine
    let right = 0;
    let left = 0;
    for (let y = 0; y < 200; y++)
      for (let x = 0; x < 200; x++)
        if (blade.ramp.includes(ov.get(x, y))) {
          if (x - 0.8 * (y - 40) > 40) right++;
          else left++;
        }
    expect(right).toBeGreaterThan(left);
  });

  it('is driven by rig state: a membrane on rig bodies moves with them', () => {
    const rig = new XpbdRig(4);
    const root = rig.addBody(100, 100, 0, { mass: 100, cx: 0, cy: 0, inertia: 1000 }, { kinematic: true });
    const arm = rig.addBody(100, 100, 0, { mass: 50, cx: 20, cy: 0, inertia: 500 });
    rig.addJoint({ a: arm, b: root, ax: 0, ay: 0, bx: 0, by: 0 });
    const draw = (): number => {
      const { ov, sp } = fresh();
      drawRigMembrane(
        sp,
        ov,
        rig,
        { body: root, x: 0, y: 0 },
        { body: arm, x: 50, y: 0 },
        { body: root, x: 0, y: 40 },
        60,
        0,
        ST,
      );
      let sx = 0;
      let n = 0;
      for (let y = 0; y < 200; y++)
        for (let x = 0; x < 200; x++)
          if (on(ov, x, y)) {
            sx += x;
            n++;
          }
      return sx / n;
    };
    const before = draw();
    rig.applyImpulse(arm, 0, -3000, 140, 100);
    for (let t = 0; t < 10; t++) rig.step();
    const after = draw();
    expect(Math.abs(after - before)).toBeGreaterThan(1);
  });
});
