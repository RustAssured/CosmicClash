/**
 * Calibration table: how much of a titan-sized body (a uniform disc of ONE archetype, radius 52 = ~8.5k cells, ~104 px across)
 * a typical landed blow removes, per damage type and material, after the effect has played out (240 ticks). Two blows:
 *   Strike ~300 energy  (the size of a Strike move, delivered the way the real moves deliver it: lash = 4 line hitboxes,
 *                        KINETIC = one wide point with a `crater` hint, ...)
 *   Crush  ~1500 energy (the size of a Crush move: Shatter Blow cone, Meteor Strike ram, ...)
 * Values are PERCENT OF THE BODY'S INITIAL MASS removed (ASSIMILATION: percent of cells infected after 4 s). Targets (Lead, round 2):
 *   Strike: matched type 3-8%, worst-matched 1-3%, never ~0;   Crush: matched 8-20%, worst-matched 3-8%.
 *   npx tsx tools/matter/calibrate.ts            (markdown for docs/DESTRUCTION.md)
 *   ONLY=rock,ironNickel TYPES=FRACTURE npx tsx tools/matter/calibrate.ts
 */
import { DamageFlag, DAMAGE_TYPES, type DamageEvent, type DamageType } from '@/contracts';
import { MATERIAL_ARCHETYPES, createMatterWorld } from '@/matter';
import { uniformDisc } from '@/matter/testing/bodies';

const R = 52;
const CX = 400;
const CY = 290;
const HIDDEN = new Set(['horizon', 'ash', 'char']);
const only = process.env.ONLY?.split(',');
const KEYS = Object.keys(MATERIAL_ARCHETYPES).filter((k) => !HIDDEN.has(k) && (!only || only.includes(k)));
const TYPE_LIST = (process.env.TYPES?.split(',') as DamageType[] | undefined) ?? [...DAMAGE_TYPES];

type Pattern = { tick: number; ev: DamageEvent }[];

const base = (energy: number) => ({
  energy,
  dirX: 1,
  dirY: 0,
  duration: 1,
  sourceMass: 6,
  sourceBodyId: 1,
  originX: CX + 300,
  originY: CY,
  flags: 0,
  params: {},
});
/** Left outline of the disc (the attacker stands on the left, hitting toward +x). */
const EDGE = CX - R;

/** The moves as the real titan data delivers them (see docs/TITANS.md hitbox tables). */
function pattern(type: DamageType, kind: 'strike' | 'crush', variant: number): Pattern {
  const strike = kind === 'strike';
  const E = strike ? 300 : 1500;
  const y = CY - 6;
  switch (type) {
    case 'FRACTURE':
      if (strike && variant === 0) {
        // Tendril Lash: four sweeping line hitboxes of 75, width 9, penetration 5.
        return [0, 1, 2, 3].map((k) => ({
          tick: k * 3,
          ev: {
            ...base(E / 4),
            type,
            shape: {
              kind: 'line',
              x0: EDGE - 62,
              y0: y - 10 + k * 5,
              x1: EDGE + 30,
              y1: y - 4 + k * 4,
              width: 9,
            },
            params: { penetration: 5, scatter: 0.8 },
          },
        }));
      }
      if (strike)
        // Charging Thrust: two lines of 150, width 12/10, penetration 8/10.
        return [0, 1].map((k) => ({
          tick: k * 5,
          ev: {
            ...base(E / 2),
            type,
            shape: { kind: 'line', x0: EDGE - 60, y0: y + k * 2, x1: EDGE + 34, y1: y + k * 2, width: 12 - 2 * k },
            params: { penetration: 8 + 2 * k, scatter: 1 + 0.1 * k },
          },
        }));
      // Shatter Blow: one cone, PIERCE | SEED_CRACK.
      return [
        {
          tick: 0,
          ev: {
            ...base(E),
            type,
            shape: { kind: 'cone', x: EDGE - 62, y, dirX: 1, dirY: 0, range: 92, halfAngle: 0.55 },
            flags: DamageFlag.PIERCE | DamageFlag.SEED_CRACK,
            params: { crackSeeds: 6, crackStress: 220, penetration: 14, scatter: 1.2 },
          },
        },
      ];
    case 'KINETIC':
      return [
        {
          tick: 0,
          ev: strike
            ? {
                ...base(E),
                type,
                shape: { kind: 'point', x: EDGE - 4, y, r: 27 },
                params: { crater: 6, penetration: 6, scatter: 1 },
              }
            : {
                ...base(E),
                type,
                shape: { kind: 'point', x: EDGE - 2, y, r: 36 },
                flags: DamageFlag.EMBED,
                params: { embed: 6, embedDelay: 40, crater: 20, penetration: 22, scatter: 1.3 },
              },
        },
      ];
    case 'CRUSH':
      return [
        {
          tick: 0,
          ev: {
            ...base(E),
            type,
            shape: { kind: 'point', x: EDGE - 2, y, r: strike ? 22 : 34 },
            params: { compress: strike ? 8 : 14, shock: 1 },
          },
        },
      ];
    case 'THERMAL':
      return [
        {
          tick: 0,
          ev: { ...base(E), type, shape: { kind: 'point', x: EDGE - 2, y, r: strike ? 20 : 30 } },
        },
      ];
    case 'TIDAL': {
      const dur = strike ? 30 : 60;
      return Array.from({ length: dur }, (_, t) => ({
        tick: t,
        ev: {
          ...base(E / dur),
          type,
          flags: DamageFlag.CONTINUOUS,
          shape: { kind: 'field', x: CX, y: CY, r: 120, falloff: 1.2 },
          params: { pull: 1 },
        } as DamageEvent,
      }));
    }
    default:
      return [
        {
          tick: 0,
          ev: {
            ...base(E),
            type,
            shape: { kind: 'point', x: EDGE - 2, y, r: strike ? 14 : 22 },
            flags: DamageFlag.LATCH,
            params: { latch: strike ? 200 : 255 },
          },
        },
      ];
  }
}

function measure(key: string, type: DamageType, kind: 'strike' | 'crush', variant = 0): number {
  const tb = uniformDisc(key, { size: R, seed: 3, x: CX, y: CY });
  const world = createMatterWorld(1);
  const id = world.createBody(tb.spec).id;
  // A sink so tidal streams have somewhere to go.
  world.setGravitySource(1, { x: CX + 300, y: CY, strength: 300, radius: 500, consumeRadius: 14, creditBodyId: -1 });
  const m0 = world.stats(id).mass;
  const c0 = world.stats(id).cells;
  const pat = pattern(type, kind, variant);
  const last = pat[pat.length - 1]!.tick;
  let pi = 0;
  for (let t = 0; t <= last; t++) {
    while (pi < pat.length && pat[pi]!.tick === t) world.applyDamage(id, pat[pi++]!.ev);
    world.tick();
  }
  const settle = type === 'ASSIMILATION' ? 240 : 240;
  for (let t = 0; t < settle; t++) world.tick();
  const s = world.stats(id);
  return type === 'ASSIMILATION' ? (100 * s.infectedCells) / c0 : (100 * (m0 - s.mass)) / m0;
}

function table(kind: 'strike' | 'crush'): void {
  const cols: { label: string; type: DamageType; variant: number }[] = [];
  for (const t of TYPE_LIST) {
    if (t === 'FRACTURE' && kind === 'strike') {
      cols.push({ label: 'FRACTURE lash', type: t, variant: 0 });
      cols.push({ label: 'FRACTURE thrust', type: t, variant: 1 });
    } else cols.push({ label: t, type: t, variant: 0 });
  }
  console.log(`| archetype | ${cols.map((c) => c.label).join(' | ')} |`);
  console.log(`|---|${cols.map(() => '---:').join('|')}|`);
  for (const key of KEYS) {
    const row = cols.map((c) => measure(key, c.type, kind, c.variant).toFixed(1));
    console.log(`| ${key} | ${row.join(' | ')} |`);
  }
}

console.log(
  `Percent of a ${R * 2}-px uniform disc removed by ONE landed blow (240 ticks after; ASSIMILATION = % cells infected)\n`,
);
console.log('Strike (300 energy)\n');
table('strike');
console.log('\nCrush (1500 energy)\n');
table('crush');
