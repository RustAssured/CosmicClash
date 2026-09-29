import { DEFAULT_LIGHTING, toHex } from '@/contracts';
import { getTitanDef, paintTitanMap } from '@/titans';
const def = getTitanDef('lastone');
const { map, rig } = paintTitanMap(def, 1234, DEFAULT_LIGHTING);
const r = rig as import('@/titans').LastOneRig;
const ex = Math.round(r.eye.x), ey = Math.round(r.eye.y);
let line = '';
for (let dx = -20; dx <= 20; dx += 2) {
  const i = ey * map.w + ex + dx;
  line += `${dx}:${map.material[i]}:${toHex(map.baseColor[i]!)} `;
}
console.log(line);
console.log('ids', JSON.stringify(r.ids));
