/**
 * Offline motion test for the Witness (v1 regions + XpbdRig): a Sweeping-Architecture-like turn. The eye (the intent) loads
 * back a little, then locks onto the new heading in ONE tick and lunges; the carapace follows, the shrine shifts the mass,
 * the arms, spires and halo arcs lag behind and settle. Rigid regions are drawn at their rig poses with nearest-neighbour
 * rotation (fine offline; the game will sample the shared rotated masks of D27), membranes and fibres on top.
 *   npx tsx tools/titans/witness-motion.ts [--out=docs/gallery/wip]
 * Writes witness-motion-turn.png (12 frames, 2×) and prints the order of motion and the settle time.
 */
import { DEFAULT_LIGHTING } from '@/contracts';
import { paintWitness, WITNESS_MATERIALS } from '@/titans/art/lastone';
import { resolveMaterials } from '@/titans/materialTable';
import { buildWitnessRig, setWitnessHeading } from '@/combat/rig/witnessRig';
import { wrapAngle } from '@/combat/rig/xpbd';
import { writeContactSheet, type SheetItem } from '../lead/png';
import { compose, type Pose } from './witness-lib';

const args = process.argv.slice(2);
const outDir = (args.find((a) => a.startsWith('--out=')) ?? '--out=docs/gallery/wip').slice(6);
const lighting = DEFAULT_LIGHTING;
const W = paintWitness(1234, lighting);
const WR = buildWitnessRig(W, resolveMaterials(WITNESS_MATERIALS), 0, 0);
const { rig } = WR;

/** The intent: rest, load (turn back a little), commit (lock the new heading in one tick, lunge), hold. */
const TURN = 0.5;
const COMMIT = 14;
function intent(t: number): { x: number; a: number } {
  if (t < 8) return { x: 0, a: 0 };
  if (t < COMMIT) return { x: -(t - 7) * 0.8, a: -0.12 * ((t - 7) / 6) };
  return { x: Math.min(18, (t - COMMIT + 1) * 3), a: TURN };
}

const FRAMES = [6, 13, 16, 20, 26, 34, 44, 56, 72, 92, 120, 160];
const frames: SheetItem[] = [];
const win = { x0: -150, y0: -112, w: 320, h: 240, lighting, soft: true };
const fr = { x: 0, y: 0, a: 0 };
const poses: Pose[] = W.regions.map(() => ({ x: 0, y: 0, a: 0 }));

// order-of-motion probes: each reaches half of the turn after the commit
const half = TURN * 0.5;
const firstTick: Record<string, number> = {};
const ninety: Record<string, number> = {};
const mark = (name: string, v: number, t: number): void => {
  if (firstTick[name] === undefined && v >= half) firstTick[name] = t - COMMIT;
  if (ninety[name] === undefined && v >= TURN * 0.9) ninety[name] = t - COMMIT;
};
const comAngle = (): number => {
  let mx = 0;
  let my = 0;
  let m = 0;
  for (let i = 0; i < rig.n; i++) {
    if (rig.kinematic[i]) continue;
    const mi = 1 / rig.invMass[i]!;
    mx += (rig.x[i]! - rig.x[WR.eye]!) * mi;
    my += (rig.y[i]! - rig.y[WR.eye]!) * mi;
    m += mi;
  }
  return Math.atan2(my / m, mx / m);
};
const com0 = comAngle();
let settled = -1;
let calm = 0;
for (let t = 0; t <= 330; t++) {
  const it = intent(t);
  rig.setKinematic(WR.eye, it.x, 0, it.a);
  setWitnessHeading(WR, it.a);
  rig.step();
  if (t >= COMMIT) {
    mark('eye', rig.a[WR.eye]!, t);
    mark('carapace', rig.a[WR.carapace]!, t);
    mark('mass shift', wrapAngle(comAngle() - com0), t);
    mark('shrine', rig.a[WR.shrine]!, t);
    mark('halo (slowest arc)', Math.min(...WR.halo.map((b) => rig.a[b]!)), t);
    mark('arm tips (slowest)', Math.min(...WR.arms.map((a) => rig.a[a.bodies[a.bodies.length - 1]!]!)), t);
    // settled: every body within 0.03 rad of the heading and nearly still, for 6 ticks running
    let ok = true;
    for (let i = 0; i < rig.n; i++)
      if (Math.abs(wrapAngle(rig.a[i]! - TURN)) > 0.03 || Math.abs(rig.w[i]!) > 0.12) ok = false;
    calm = ok ? calm + 1 : 0;
    if (calm === 6 && settled < 0) settled = t - 5 - COMMIT;
  }
  if (FRAMES.includes(t)) {
    for (let i = 0; i < W.regions.length; i++) {
      rig.frame(WR.bodyOf[i]!, fr);
      poses[i] = { x: fr.x, y: fr.y, a: fr.a };
    }
    frames.push(compose(W, poses, win));
  }
}
writeContactSheet(`${outDir}/witness-motion-turn.png`, frames, 6, 2, 4);
console.log(
  `frames at ticks ${FRAMES.join(', ')} (commit at ${COMMIT}); ticks after the commit to reach half the turn:`,
);
for (const [k, v] of Object.entries(firstTick))
  console.log(`  ${k.padEnd(20)} half ${v} ticks, 90 % ${ninety[k] ?? '-'} ticks`);
if (settled < 0)
  for (let i = 0; i < rig.n; i++)
    console.log(
      `  body ${i}: angle error ${wrapAngle(rig.a[i]! - TURN).toFixed(3)} rad, ω ${rig.w[i]!.toFixed(3)} rad/s`,
    );
console.log(
  `settled (all regions within 0.03 rad, still) ${settled} ticks = ${(settled / 60).toFixed(2)} s after the commit`,
);
