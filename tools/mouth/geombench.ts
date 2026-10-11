/**
 * CPU cost of the Mouth's layout (MouthGeom.build) per frame, headless:  npx tsx tools/mouth/geombench.ts [--frames=600]
 * Steps the crane through a bite every second and lays it out each frame; prints mean / p95 ms and the instance counts.
 */
import { MouthCore, type MouthStepOut } from '@/combat/mouth/core';
import { MouthGeom } from '@/combat/mouth/geom';

const frames = +(process.argv.find((a) => a.startsWith('--frames='))?.slice(9) ?? '600');
const SCREEN = { minX: 0, maxX: 640, minY: 0, maxY: 360, restY: 180, softWall: 0 };
let s = 7;
const core = new MouthCore({
  arena: SCREEN,
  rand: () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296,
});
core.oppX = 470;
core.oppY = 170;
core.grabCheck = () => true;
const out: MouthStepOut = { impact: null, coiling: false, ended: false };
const g = new MouthGeom();
const ms: number[] = [];
for (let f = 0; f < frames; f++) {
  if (f % 60 === 10) core.begin(f % 180 === 10 ? 'bite' : f % 180 === 70 ? 'sweep' : 'coil');
  core.slideIn = f % 400 < 100 ? 1 : 0;
  core.step(1 / 60, out);
  const t0 = performance.now();
  g.build(core, { sky: 1, tell: true });
  if (f > 60) ms.push(performance.now() - t0);
}
ms.sort((a, b) => a - b);
const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
console.log(
  `layout: mean ${mean.toFixed(3)} ms, p50 ${ms[ms.length >> 1]!.toFixed(3)}, p95 ${ms[Math.floor(ms.length * 0.95)]!.toFixed(3)}, max ${ms[ms.length - 1]!.toFixed(3)}; tubes ${g.list.nTubes}, stamps ${g.list.nStamps}`,
);
