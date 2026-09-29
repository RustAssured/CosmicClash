/** Prints the archetype tables as markdown (pasted into docs/DESTRUCTION.md).  npx tsx tools/matter/tables.ts */
import { DAMAGE_TYPES } from '@/contracts';
import { MATERIAL_ARCHETYPES } from '@/matter';

console.log('### Resist matrix (multiplier on incoming energy; 0 = immune, 1 = baseline)\n');
console.log('| archetype | ' + DAMAGE_TYPES.map((t) => t.slice(0, 5)).join(' | ') + ' |');
console.log('|---|' + DAMAGE_TYPES.map(() => '---:').join('|') + '|');
for (const [k, m] of Object.entries(MATERIAL_ARCHETYPES))
  console.log(`| ${k} | ${DAMAGE_TYPES.map((t) => m.resist[t]).join(' | ')} |`);
console.log('\n### Physics\n');
console.log(
  '| archetype | density | bond | tough | brittle | heatCap | cond | ignition | burn | vaporize | absorb | assim | debris | ash | fluid |',
);
console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|');
for (const [k, m] of Object.entries(MATERIAL_ARCHETYPES))
  console.log(
    `| ${k} | ${m.density} | ${m.bond} | ${m.toughness} | ${m.brittleness} | ${m.heatCapacity} | ${m.conductivity} | ${m.ignition || '-'} | ${m.burnRate || '-'} | ${m.vaporize || '-'} | ${m.heatAbsorb || '-'} | ${m.assimilable} | ${m.debris} | ${m.ashTo || '-'} | ${m.fluid ? 'yes' : '-'} |`,
  );
