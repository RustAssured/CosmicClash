/**
 * Rotation spike cost (src/matter/rotation.ts): building a rotated mask per (body, angle), the per-query hit-test costs against
 * the ordinary (unrotated) paths, the mask memory, and how many cells nearest rotation leaves undrawn at its worst angle.
 *   npx tsx tools/matter/rotbench.ts
 */
import { createMatterWorld } from '@/matter';
import type { Body } from '@/matter/body';
import { ANGLE_STEPS, buildRotMask, drawnCell, rotCellAt, rotCollect } from '@/matter/rotation';
import { ShapeQ } from '@/matter/shape';
import { bridge, celadonBody, layeredDisc } from '@/matter/testing/bodies';

function time(fn: () => void, reps: number): number {
  fn();
  let best = Infinity;
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    for (let i = 0; i < reps; i++) fn();
    best = Math.min(best, (performance.now() - t0) / reps);
  }
  return best;
}

const cases: [string, Body][] = [];
for (const [name, tb] of [
  ['arm-like bridge', bridge({ seed: 3, x: 400, y: 300 })],
  ['celadon r=30 (region)', celadonBody({ size: 30, seed: 3, x: 400, y: 300 })],
  ['layered disc r=55 (titan)', layeredDisc({ size: 55, seed: 3, x: 400, y: 300 })],
  ['layered disc r=100 (max map)', layeredDisc({ size: 100, seed: 3, x: 400, y: 300 })],
] as const) {
  const w = createMatterWorld(1);
  cases.push([name, w.core.bodyById[w.createBody(tb.spec).id]!]);
}

console.log(
  '| body | map | mask build ms (45°) | mask KB | cellAt ns (rot / plain) | collect r=20 µs (rot / plain) | undrawn cells, worst angle |',
);
console.log('|---|---|---:|---:|---:|---:|---:|');
const q = new ShapeQ();
for (const [name, b] of cases) {
  const step = ANGLE_STEPS / 8;
  const build = time(() => void buildRotMask(b, step), 5);
  const m = buildRotMask(b, step);
  const px = b.transform.x;
  const py = b.transform.y;
  let sink = 0;
  const N = 200000;
  const cellRot =
    (time(() => {
      for (let i = 0; i < N; i++) sink += rotCellAt(b, m, px - 20 + (i % 40), py - 20 + ((i / 40) % 40));
    }, 1) *
      1e6) /
    N;
  const cellPlain =
    (time(() => {
      for (let i = 0; i < N; i++) sink += b.cellAtWorld(px - 20 + (i % 40), py - 20 + ((i / 40) % 40));
    }, 1) *
      1e6) /
    N;
  q.set({ kind: 'point', x: px - 6, y: py + 4, r: 20 });
  const idx = new Int32Array(b.n);
  const wgt = new Float32Array(b.n);
  const stamp = new Uint32Array(b.n);
  let gen = 1;
  const colRot = time(() => void rotCollect(b, m, q, idx, wgt, stamp, ++gen), 200) * 1000;
  const colPlain = time(() => void b.collect(q, idx, wgt), 200) * 1000;
  let live = 0;
  for (let c = 0; c < b.n; c++) if (b.map.material[c] !== 0) live++;
  let worst = 0;
  for (let k = 0; k < ANGLE_STEPS; k += 4) {
    const mk = buildRotMask(b, k);
    const seen = new Uint8Array(b.n);
    let vis = 0;
    for (let v = 0; v < mk.h; v++)
      for (let u = 0; u < mk.w; u++) {
        const c = drawnCell(b, mk, u, v);
        if (c >= 0 && !seen[c]) {
          seen[c] = 1;
          vis++;
        }
      }
    worst = Math.max(worst, 1 - vis / live);
  }
  console.log(
    `| ${name} | ${b.w}x${b.h} | ${build.toFixed(2)} | ${((m.centre.length * 5) / 1024).toFixed(0)} | ` +
      `${cellRot.toFixed(1)} / ${cellPlain.toFixed(1)} | ${colRot.toFixed(1)} / ${colPlain.toFixed(1)} | ${(worst * 100).toFixed(0)}% |`,
  );
  void sink;
}
