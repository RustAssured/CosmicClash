/**
 * Per-hit matter of the Witness's FRACTURE hitboxes on the Planet (woundbench: one blow on the real generated body, 1.5 s):
 * total and solid mass taken, chunk share, shear. For Phase 4 balance (D33: FRACTURE bites the first solid matter).
 *   npx tsx tools/matter/fracplanet.ts
 */
import { DEFAULT_LIGHTING, type TitanId } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { measureBlow, type BlowSpec } from '@/matter/testing/woundbench';
import { generateTitanBody, getTitanDef } from '@/titans';

const witness = getTitanDef('colossus');
// the Witness's move ids are 'witness.*' (its def is the Last One's, re-skinned: witnessDef)
const def = (id: TitanId) => (id === 'lastone' || (id as string) === 'witness' ? witness : getTitanDef(id));
const deps = {
  createMatterWorld,
  generate: (id: TitanId) => generateTitanBody(getTitanDef(id), 3, DEFAULT_LIGHTING),
  def,
};
console.log('| Witness move / hitbox | energy (scaled) | mass taken | solid | to chunks | shear ms |');
console.log('|---|---:|---:|---:|---:|---:|');
for (const mv of witness.moves)
  for (const hb of mv.variants.forward.hitboxes) {
    if (hb.damage.type !== 'FRACTURE') continue;
    const spec: BlowSpec = {
      name: `${mv.id}/${hb.id}`,
      target: 'planet',
      move: mv.id,
      hitbox: hb.id,
      hitstop: 12,
    };
    let world: ReturnType<typeof createMatterWorld> | null = null;
    const solidMass = (): number => {
      const b = world!.core.bodyList[0]!;
      let s = 0;
      for (let i = 0; i < b.n; i++)
        if (b.map.material[i] !== 0 && b.matFluid[b.map.material[i]!] === 0) s += b.cellMass(i);
      return s;
    };
    let s0 = 0;
    const r = measureBlow(spec, {
      ...deps,
      createMatterWorld: (seed: number) => {
        world = createMatterWorld(seed);
        const cb = world.createBody.bind(world);
        world.createBody = (sp) => {
          const body = cb(sp);
          s0 = solidMass();
          return body;
        };
        return world;
      },
    }) as ReturnType<typeof measureBlow> & { solidLoss?: number };
    r.solidLoss = s0 - solidMass();
    const bal = (witness as unknown as { balance?: { power?: number } }).balance?.power ?? 1;
    const dur =
      (getTitanDef('planet') as unknown as { balance?: { durability?: number } }).balance?.durability ?? 1;
    console.log(
      `| ${spec.name} | ${((hb.damage.energy * bal) / dur).toFixed(0)} | ${r.loss.toFixed(0)} | ${(r as { solidLoss?: number }).solidLoss?.toFixed(0) ?? '–'} | ${(r.chunkShare * 100).toFixed(0)} % | ${r.shearMs.toFixed(0)} |`,
    );
  }
