/**
 * Calibration table: for each archetype (uniform disc) and each damage type, how much MASS is removed from the body per unit
 * of energy after the effect has played out. Baseline (density 1, resist 1) is ~1 cell per energy. This is the numeric face of the
 * resist table: the rock-paper-scissors of the game emerges from it. Output is markdown (pasted into docs/DESTRUCTION.md).
 *   npx tsx tools/matter/calibrate.ts
 */
import { DamageFlag, DAMAGE_TYPES, type DamageEvent, type DamageType } from '@/contracts';
import { MATERIAL_ARCHETYPES, createMatterWorld } from '@/matter';
import { uniformDisc } from '@/matter/testing/bodies';

const KEYS = Object.keys(MATERIAL_ARCHETYPES).filter((k) => k !== 'horizon' && k !== 'ash' && k !== 'char');
const ENERGY = 500;

function eventFor(type: DamageType, cx: number, cy: number, facing: 1 | -1): DamageEvent {
  const x = cx - 44 * facing + 6 * facing;
  const base = {
    dirX: facing,
    dirY: 0.05,
    duration: 1,
    sourceMass: 6,
    sourceBodyId: 1,
    originX: cx + 300,
    originY: cy,
    flags: 0,
    params: {},
  };
  switch (type) {
    case 'FRACTURE':
      return {
        ...base,
        type,
        energy: ENERGY,
        shape: { kind: 'point', x, y: cy, r: 11 },
        flags: DamageFlag.SEED_CRACK,
        params: { crackSeeds: 3 },
      };
    case 'KINETIC':
      return { ...base, type, energy: ENERGY, shape: { kind: 'point', x, y: cy, r: 8 } };
    case 'CRUSH':
      return {
        ...base,
        type,
        energy: ENERGY,
        shape: { kind: 'point', x, y: cy, r: 14 },
        params: { compress: 10, shock: 1 },
      };
    case 'THERMAL':
      return { ...base, type, energy: ENERGY, shape: { kind: 'point', x, y: cy, r: 10 } };
    case 'TIDAL':
      return {
        ...base,
        type,
        energy: ENERGY / 40,
        flags: DamageFlag.CONTINUOUS,
        shape: { kind: 'field', x: cx, y: cy, r: 120, falloff: 1.2 },
        params: { pull: 1 },
      };
    default:
      return {
        ...base,
        type,
        energy: ENERGY,
        shape: { kind: 'point', x, y: cy, r: 11 },
        flags: DamageFlag.LATCH,
        params: { latch: 200 },
      };
  }
}

function measure(key: string, type: DamageType): { removed: number; chunks: number; extra: number } {
  const tb = uniformDisc(key, { seed: 3, x: 400, y: 290 });
  const world = createMatterWorld(1);
  const id = world.createBody(tb.spec).id;
  // a sink so tidal streams have somewhere to go
  world.setGravitySource(1, {
    x: 700,
    y: 290,
    strength: 300,
    radius: 500,
    consumeRadius: 14,
    creditBodyId: -1,
  });
  const m0 = world.stats(id).mass;
  const ticks = type === 'TIDAL' ? 40 : 1;
  for (let t = 0; t < ticks; t++) {
    world.applyDamage(id, eventFor(type, 400, 290, 1));
    world.tick();
  }
  for (let t = 0; t < 240; t++) world.tick();
  const s = world.stats(id);
  return {
    removed: m0 - s.mass,
    chunks: world.diagnostics().chunks,
    extra: type === 'ASSIMILATION' ? s.infectedCells : type === 'THERMAL' ? s.burningCells : 0,
  };
}

const spent = (t: DamageType): number => (t === 'TIDAL' ? ENERGY : ENERGY);
console.log(
  `Mass removed per unit energy (energy ${ENERGY}; 240 ticks after the blow; uniform disc of one archetype)\n`,
);
console.log('| archetype | ' + DAMAGE_TYPES.join(' | ') + ' |');
console.log('|---|' + DAMAGE_TYPES.map(() => '---:').join('|') + '|');
for (const key of KEYS) {
  const row = DAMAGE_TYPES.map((t) => {
    const r = measure(key, t);
    const v = r.removed / spent(t);
    return t === 'ASSIMILATION' ? `${r.extra} inf` : v.toFixed(2);
  });
  console.log(`| ${key} | ${row.join(' | ')} |`);
}
