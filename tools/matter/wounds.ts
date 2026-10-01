/**
 * Wound sequencing check (D1): heavy blows of the slice titans on their real generated bodies, applied the way a Match does it
 * (see src/matter/testing/woundbench.ts). Per blow, over the 1.5 s after it (hit-stop included, like tools/lead/pacing.ts):
 *   loss            body mass lost
 *   max 1-tick      the largest one-tick body-mass loss as a share of `loss` (target <= 15 %)
 *   to chunks       share of removed solid matter routed to rigid chunks (fluids/gas excepted; target >= 60 %)
 *   shear ms        wall ms from the impact frame to the first slab (target 80-300)
 *   crack cells     cracked cells beside hairline/broken bonds on the impact frame (the crack is visible at once)
 *   momentum        Σ m·v·d̂ of the wound's slabs at release / P_w (target >= 60 %)
 *   spin            share of off-centre slabs whose spin follows the lever arm
 *   FX clear ms     wall ms until the matter FX particles cover < 10 % of the 52 px wound box (target <= 400)
 *   telemetry-rule clear ms  the same over every matter screen layer at z in [10, 100) (the in-browser telemetry's rule; the
 *                   shed slabs draw in `debris-mid` at z 9 and are not occluders)
 *   npx tsx tools/matter/wounds.ts
 */
import type { StageLighting, TitanId } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { SLICE_BLOWS, measureBlow } from '@/matter/testing/woundbench';
import { generateTitanBody, getTitanDef } from '@/titans';

const LIGHT: StageLighting = {
  dir: [-0.3, -0.6, 0.74],
  color: '#cfe6ff',
  ambient: '#0e1a3a',
  rim: '#7fc8ff',
  screenPos: [0.3, -0.1],
};

const deps = {
  createMatterWorld,
  generate: (id: TitanId) => generateTitanBody(getTitanDef(id), 3, LIGHT),
  def: getTitanDef,
};

const pct = (v: number): string => (v < 0 ? '-' : `${(v * 100).toFixed(0)}%`);
const ms = (v: number): string => (v < 0 ? '-' : v.toFixed(0));
console.log(
  '| blow | loss | max 1-tick | to chunks | shear ms | crack cells | momentum | spin | FX clear ms | telemetry-rule clear ms |',
);
console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const b of SLICE_BLOWS) {
  const r = measureBlow(b, deps);
  console.log(
    `| ${b.name} | ${r.loss.toFixed(0)} | ${pct(r.maxTickShare)} | ${pct(r.chunkShare)} | ${ms(r.shearMs)} | ` +
      `${r.crackCells} | ${pct(r.momentum)} | ${pct(r.spinAgree)} | ${ms(r.fxClearMs)} | ${ms(r.allClearMs)} |`,
  );
}
