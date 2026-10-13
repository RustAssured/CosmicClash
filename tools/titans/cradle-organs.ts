/**
 * FALSE BIRTH's pseudo-organs, one grown from each roster titan (as the game grows it from the foe's live matter), side by
 * side at ×4: the brief's "shaped partly by the victim it touched".
 *
 *   npx tsx tools/titans/cradle-organs.ts [--out=docs/gallery/cradle/gate4/pseudo-organs.png]
 */
import { DEFAULT_LIGHTING, type TitanId } from '@/contracts';
import { growPseudoOrgan } from '@/combat/behaviours/kit/cradle/falsebirth';
import { generateTitanBody, getTitanDef } from '@/titans';
import { ROSTER } from '@/titans/roster';
import { writeContactSheet, type SheetItem } from '../lead/png';

const args = process.argv.slice(2);
const out = (
  args.find((a) => a.startsWith('--out=')) ?? '--out=docs/gallery/cradle/gate4/pseudo-organs.png'
).slice(6);
const ORGAN_SIZE = 60;
const items: SheetItem[] = [];
for (const r of ROSTER) {
  if (r.id === 'cradle') continue;
  const g = generateTitanBody(getTitanDef(r.id as TitanId), 1234, DEFAULT_LIGHTING);
  const o = growPseudoOrgan(g.map, ORGAN_SIZE, 77);
  if (!o) continue;
  items.push({ pixels: o.pixels, w: o.w, h: o.h });
  console.log(`${r.id}: ${o.w}×${o.h}, ${o.cells} cells`);
}
writeContactSheet(out, items, items.length, 4, 6);
console.log(out);
