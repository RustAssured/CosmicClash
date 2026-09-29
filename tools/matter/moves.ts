/**
 * Real-move damage check: every move of every implemented titan (forward aim, each hitbox landing once, CONTINUOUS ones for
 * their whole window, every `rehit` ticks, sweeping towards `sweepTo`) against every implemented titan's REAL generated body, reported as the percent of the target's initial
 * mass removed 300 ticks later. This is the end-to-end version of `calibrate.ts` (which uses uniform discs): use it after
 * touching titan data or the damage models to see whether fights will stall.
 *   npx tsx tools/matter/moves.ts
 * The attacker stands so that the hitbox origins sit ~55 px before the target's near edge (no lunge movement is simulated) and
 * the Guard shell / part interception of the combat layer is NOT applied: these are the raw matter results.
 */
import type { DamageEvent, DamageShape, ShapeTemplate, StageLighting, TitanId } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { IMPLEMENTED_TITANS, generateTitanBody, getTitanDef } from '@/titans';

const LIGHT: StageLighting = {
  dir: [-0.3, -0.6, 0.74],
  color: '#cfe6ff',
  ambient: '#0e1a3a',
  rim: '#7fc8ff',
  screenPos: [0.3, -0.1],
};
const CONTINUOUS = 16;

function place(s: ShapeTemplate, ax: number, ay: number): DamageShape {
  switch (s.kind) {
    case 'point':
      return { kind: 'point', x: ax + s.ox, y: ay + s.oy, r: s.r };
    case 'line':
      return { kind: 'line', x0: ax + s.ox0, y0: ay + s.oy0, x1: ax + s.ox1, y1: ay + s.oy1, width: s.width };
    case 'cone':
      return {
        kind: 'cone',
        x: ax + s.ox,
        y: ay + s.oy,
        dirX: Math.cos(s.angle),
        dirY: Math.sin(s.angle),
        range: s.range,
        halfAngle: s.halfAngle,
      };
    case 'ring':
      return { kind: 'ring', x: ax + s.ox, y: ay + s.oy, r0: s.r0, r1: s.r1 };
    default:
      return { kind: 'field', x: ax + s.ox, y: ay + s.oy, r: s.r, falloff: s.falloff };
  }
}

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

/** The hitbox shape `u` (0..1) of the way through its window: interpolates towards `sweepTo` where the shapes have the same kind. */
function sweep(a: ShapeTemplate, b: ShapeTemplate | undefined, u: number): ShapeTemplate {
  if (!b || b.kind !== a.kind) return a;
  switch (a.kind) {
    case 'point': {
      const p = b as typeof a;
      return { kind: 'point', ox: lerp(a.ox, p.ox, u), oy: lerp(a.oy, p.oy, u), r: lerp(a.r, p.r, u) };
    }
    case 'line': {
      const l = b as typeof a;
      return {
        kind: 'line',
        ox0: lerp(a.ox0, l.ox0, u),
        oy0: lerp(a.oy0, l.oy0, u),
        ox1: lerp(a.ox1, l.ox1, u),
        oy1: lerp(a.oy1, l.oy1, u),
        width: lerp(a.width, l.width, u),
      };
    }
    case 'cone': {
      const c = b as typeof a;
      return {
        kind: 'cone',
        ox: lerp(a.ox, c.ox, u),
        oy: lerp(a.oy, c.oy, u),
        angle: lerp(a.angle, c.angle, u),
        range: lerp(a.range, c.range, u),
        halfAngle: lerp(a.halfAngle, c.halfAngle, u),
      };
    }
    default:
      return a;
  }
}

function hit(target: TitanId, attacker: TitanId, moveIndex: number): { pct: number; energy: number } {
  const tdef = getTitanDef(target);
  const move = getTitanDef(attacker).moves[moveIndex]!;
  const world = createMatterWorld(7);
  const g = generateTitanBody(tdef, 3, LIGHT);
  const TX = 700;
  const TY = 300;
  const body = world.createBody({
    kind: 'titan',
    ownerSlot: 1,
    map: g.map,
    materials: g.materials,
    attributes: tdef.attributes,
    seed: 3,
    transform: { x: TX, y: TY, anchorX: g.map.coreX, anchorY: g.map.coreY, facing: -1, lean: 0 },
  });
  const m0 = world.stats(body.id).mass;
  const bounds = { x0: 0, y0: 0, x1: 0, y1: 0 };
  world.liveBounds(body.id, bounds);
  const ax = bounds.x0 - 55;
  const events: { tick: number; ev: DamageEvent }[] = [];
  let energy = 0;
  for (const h of move.variants.forward.hitboxes) {
    const d = h.damage;
    const continuous = (d.flags & CONTINUOUS) !== 0;
    const window = Math.max(1, h.to - h.from);
    const step = continuous ? Math.max(1, h.rehit ?? 1) : window;
    for (let k = 0; k < (continuous ? window : 1); k += step) {
      energy += d.energy;
      events.push({
        tick: h.from + k,
        ev: {
          type: d.type,
          shape: place(sweep(h.shape, h.sweepTo, k / window), ax, TY),
          energy: d.energy,
          dirX: 1,
          dirY: 0,
          duration: continuous ? 1 : d.duration,
          sourceMass: 6,
          sourceBodyId: -1,
          originX: ax,
          originY: TY,
          flags: d.flags,
          params: d.params,
        },
      });
    }
  }
  if (events.length === 0) return { pct: 0, energy: 0 };
  events.sort((a, b) => a.tick - b.tick);
  let next = 0;
  const last = events[events.length - 1]!.tick;
  for (let t = 0; t <= last; t++) {
    while (next < events.length && events[next]!.tick === t) world.applyDamage(body.id, events[next++]!.ev);
    world.tick();
  }
  for (let t = 0; t < 300; t++) world.tick();
  return { pct: (100 * (m0 - world.stats(body.id).mass)) / m0, energy };
}

console.log(
  'Raw matter result of each move (forward aim) on each titan, % of target mass removed after 300 ticks\n',
);
console.log(
  '| attacker move | nominal energy | ' + IMPLEMENTED_TITANS.map((t) => `-> ${t}`).join(' | ') + ' |',
);
console.log('|---|---:|' + IMPLEMENTED_TITANS.map(() => '---:').join('|') + '|');
for (const a of IMPLEMENTED_TITANS)
  getTitanDef(a).moves.forEach((mv, i) => {
    if (mv.slot === 'surge' || mv.slot === 'guard') return;
    const cells = IMPLEMENTED_TITANS.map((t) => hit(t, a, i));
    const energy = cells[0]!.energy;
    if (energy === 0) return;
    console.log(
      `| ${mv.id} (${mv.slot}) | ${energy} | ${cells.map((c) => c.pct.toFixed(1) + '%').join(' | ')} |`,
    );
  });
