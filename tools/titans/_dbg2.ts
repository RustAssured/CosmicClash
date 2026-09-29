import { makeMatch, skipIntro, run } from '@/combat/testing/harness';
const m = makeMatch();
skipIntro(m); run(m, 30);
for (const f of m.fighters) {
  const ls = f.renderLayers({ x0: 0, y0: 0, w: 640, h: 360 }, 1);
  console.log(f.def.id, ls.map((l) => `${l.id} z${l.z} vis=${l.visible} ${l.w}x${l.h} at ${l.x},${l.y} nz=${l.pixels.reduce((a, c) => a + (c >>> 24 !== 0 ? 1 : 0), 0)}`));
}
