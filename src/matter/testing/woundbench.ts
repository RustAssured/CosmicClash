import {
  LOGICAL_H,
  LOGICAL_W,
  MS_PER_TICK,
  type DamageEvent,
  type DamageShape,
  type MaterialDef,
  type MatterMap,
  type ShapeTemplate,
  type TitanDef,
  type TitanId,
  type ViewRect,
} from '@/contracts';
import { localToWorldF } from '../dmg';
import { rasterParticles } from '../particles';
import { SLAB_HELD } from '../wound';
import type { MatterWorldEx } from '../world';

/**
 * Wound-sequencing bench (D1): one heavy blow of a real move on a real generated titan body, applied the way a Match does
 * it — the blow lands, the world ticks once (the IMPACT FRAME, wall 0 ms), stays frozen for the blow's hit-stop (the world is
 * not ticked during it), then runs — measured over the 1.5 s (90 frames, hit-stop included) after it, like
 * `tools/lead/pacing.ts`. Shared by `wound.test.ts` and `tools/matter/wounds.ts`. Pure: the titan registry is injected.
 */

export interface BlowSpec {
  name: string;
  target: TitanId;
  /** Move id (`<attacker>.<move>`); its forward variant is used. */
  move: string;
  /** Hitbox id within the move (default: the first). */
  hitbox?: string;
  hitstop: number;
}

/** The slice's heavy blows (both directions, both titans), with their authored hit-stop. */
export const SLICE_BLOWS: BlowSpec[] = [
  { name: 'planet.impact -> planet', target: 'planet', move: 'planet.impact', hitstop: 13 },
  { name: 'lastone.shatter -> planet', target: 'planet', move: 'lastone.shatter', hitstop: 12 },
  {
    name: 'lastone.lastlight shear -> planet',
    target: 'planet',
    move: 'lastone.lastlight',
    hitbox: 'shear',
    hitstop: 13,
  },
  { name: 'planet.impact -> lastone', target: 'lastone', move: 'planet.impact', hitstop: 13 },
  {
    name: 'planet.cataclysm quake -> lastone',
    target: 'lastone',
    move: 'planet.cataclysm',
    hitbox: 'quake',
    hitstop: 13,
  },
  { name: 'lastone.shatter -> lastone', target: 'lastone', move: 'lastone.shatter', hitstop: 12 },
];

export interface BenchDeps {
  createMatterWorld: (seed: number) => MatterWorldEx;
  generate: (id: TitanId) => { map: MatterMap; materials: MaterialDef[] };
  def: (id: TitanId) => TitanDef;
}

export interface BlowResult {
  /** Body mass lost over the window (fluids and gas included), and the SOLID part of it (what D1 is about). */
  loss: number;
  solidLoss: number;
  /** Fluid vented on the impact frame (D33: the gas / ocean a cutting blow crosses), kept out of the one-tick share. */
  ventLoss: number;
  /**
   * Largest one-tick body-mass loss, the impact-frame vent left out, / everything the blow took (whole mass: the shedding budget is
   * defined on the wound's mass, fluids included).
   */
  maxTickShare: number;
  /** Rigid-chunk share of the removed solid matter (fluids and gas excepted). */
  chunkShare: number;
  /**
   * Wall ms from the impact frame to the shear: the first tick a held slab of the blow's wound lets go (fluid slabs included:
   * they leave as gas / spray), else the first released chunk of >= 5 mass; -1 = none.
   */
  shearMs: number;
  /** Cracked cells beside hairline/broken bonds on the impact frame (the visible crack). */
  crackCells: number;
  /** Σ m·(v·d̂) of the wound's slabs at release over Σ m·speed (the wound momentum P_w); -1 = no slab. */
  momentum: number;
  /** Share of off-centre slabs (|r̂×d̂| > 0.25) whose spin has the lever arm's sense; -1 = none. */
  spinAgree: number;
  /** Wall ms until the matter FX particles (flash, sparks, dust, plumes) cover < 10 % of the wound box for 3 frames; -1 = never. */
  fxClearMs: number;
  /** Same over every matter screen layer at z in [10, 100) (the in-browser telemetry's rule; slabs draw at z 9). */
  allClearMs: number;
  /** |ledger error| at the end. */
  ledgerError: number;
  hash: number;
}

const TX = 700;
const TY = 300;
const WINDOW = 90;
const BOX_R = 26;

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

const fxPix = new Uint32Array(LOGICAL_W * LOGICAL_H);
const fxEmi = new Uint8Array(LOGICAL_W * LOGICAL_H);
const nearPix = new Uint32Array(LOGICAL_W * LOGICAL_H);
const nearEmi = new Uint8Array(LOGICAL_W * LOGICAL_H);

/**
 * Coverage of a box of half-size `r` around world (x, y) — the telemetry rule (pixels with alpha > 24 in the screen layers at
 * z in [10, 100)). `fxOnly`: count only the FX particles (flash disc, sparks, dust, plumes, gas, motes), not the rigid slabs
 * the wound sheds (they are the wound's matter, drawn in the same fight-plane layer).
 */
export function fxCoverage(world: MatterWorldEx, x: number, y: number, r: number, fxOnly = false): number {
  const view: ViewRect = {
    x0: Math.round(x - LOGICAL_W / 2),
    y0: Math.round(y - LOGICAL_H / 2),
    w: LOGICAL_W,
    h: LOGICAL_H,
  };
  const bufs: Uint32Array[] = [];
  if (fxOnly) {
    fxPix.fill(0);
    nearPix.fill(0);
    rasterParticles(world.core.particles, view, 0, fxPix, fxEmi, { a: 0, b: 0 }, nearPix, nearEmi, {
      a: 0,
      b: 0,
    });
    bufs.push(fxPix, nearPix);
  } else {
    for (const L of world.renderLayers(view, 0))
      if (L.visible && L.space === 'screen' && L.z >= 10 && L.z < 100) bufs.push(L.pixels);
  }
  const sx0 = Math.round(x - r - view.x0);
  const sy0 = Math.round(y - r - view.y0);
  let hit = 0;
  let total = 0;
  for (let j = 0; j < 2 * r; j++)
    for (let i = 0; i < 2 * r; i++) {
      total++;
      const sx = sx0 + i;
      const sy = sy0 + j;
      if (sx < 0 || sy < 0 || sx >= LOGICAL_W || sy >= LOGICAL_H) continue;
      for (const p of bufs)
        if (p[sy * LOGICAL_W + sx]! >>> 24 > 24) {
          hit++;
          break;
        }
    }
  return hit / total;
}

export function measureBlow(spec: BlowSpec, deps: BenchDeps): BlowResult {
  const attacker = spec.move.split('.')[0] as TitanId;
  const adef = deps.def(attacker);
  const tdef = deps.def(spec.target);
  const move = adef.moves.find((m) => m.id === spec.move);
  if (!move) throw new Error(`woundbench: no move ${spec.move}`);
  const hb = spec.hitbox
    ? move.variants.forward.hitboxes.find((h) => h.id === spec.hitbox)
    : move.variants.forward.hitboxes[0];
  if (!hb) throw new Error(`woundbench: no hitbox ${spec.hitbox ?? '(first)'} in ${spec.move}`);
  const world = deps.createMatterWorld(7);
  const g = deps.generate(spec.target);
  const body = world.createBody({
    kind: 'titan',
    ownerSlot: 1,
    map: g.map,
    materials: g.materials,
    attributes: tdef.attributes,
    seed: 3,
    transform: { x: TX, y: TY, anchorX: g.map.coreX, anchorY: g.map.coreY, facing: -1, lean: 0 },
  });
  const id = body.id;
  const core = world.core;
  const b = core.bodyById[id]!;
  const bounds = { x0: 0, y0: 0, x1: 0, y1: 0 };
  world.liveBounds(id, bounds);
  const ax = bounds.x0 - 55;
  const bal = (d: TitanDef): { power?: number; durability?: number } =>
    (d as unknown as { balance?: { power?: number; durability?: number } }).balance ?? {};
  const energy = (hb.damage.energy * (bal(adef).power ?? 1)) / (bal(tdef).durability ?? 1);
  const ev: DamageEvent = {
    type: hb.damage.type,
    shape: place(hb.shape, ax, TY),
    energy,
    dirX: 1,
    dirY: 0,
    duration: 1,
    sourceMass: adef.attributes.mass,
    sourceBodyId: -1,
    originX: ax,
    originY: TY,
    flags: hb.damage.flags & ~16,
    params: hb.damage.params,
    hitstop: spec.hitstop,
  };
  const fluidOrGas = (m: number): boolean =>
    m !== 0 &&
    (b.materials[m]!.fluid || b.materials[m]!.debris === 'gas' || b.materials[m]!.debris === 'liquid');
  const fluidMass = (): number => {
    let s = 0;
    for (let i = 0; i < b.n; i++) if (fluidOrGas(b.map.material[i]!)) s += b.cellMass(i);
    return s;
  };
  const led0 = world.ledger();
  const fluid0 = fluidMass();
  const m0 = world.stats(id).mass;
  const chunkIds = new Set<number>();
  for (let i = 0; i < core.chunks.hi; i++)
    if (core.chunks.list[i]!.alive) chunkIds.add(core.chunks.list[i]!.id);

  const res = world.applyDamage(id, ev);
  const cx = Number.isFinite(res.contactX) ? res.contactX : ax + 60;
  const cy = Number.isFinite(res.contactY) ? res.contactY : TY;
  let wound = -1;
  for (let w = 0; w < b.wounds.tick.length; w++) if (b.wounds.tick[w] === core.tick) wound = w;

  // The one-tick share is measured on the whole body mass, fluids included: matter's shedding budget (wound.ts SHED_PER_TICK)
  // is defined on the wound's whole held mass, whose fluids leave with their slabs. (Solid-only would flag a single slab
  // heavier than the budget, which goes alone by design.) The solid loss is reported beside it.
  const solid0 = m0 - fluid0;
  let last = m0;
  let maxTick = 0;
  let vent = 0;
  let shearMs = -1;
  let crackCells = 0;
  let pSum = 0;
  let pGot = 0;
  let spinN = 0;
  let spinOk = 0;
  let fxClearMs = -1;
  let clean = 0;
  let allClearMs = -1;
  let cleanAll = 0;
  const ticks = WINDOW - spec.hitstop;
  const wb = b.wounds;
  const heldBefore: number[] = [];
  for (let t = 0; t < ticks; t++) {
    // the wound's slabs still held before this tick: one of them letting go during it is the shear
    heldBefore.length = 0;
    if (wound >= 0)
      for (let s = 1; s < wb.state.length; s++)
        if (wb.state[s] === SLAB_HELD && wb.woundOf[s] === wound) heldBefore.push(s);
    world.tick();
    const wallMs = t === 0 ? 0 : (spec.hitstop + t) * MS_PER_TICK;
    const mass = world.stats(id).mass;
    // D33: the gas / ocean a cutting blow crosses vents as spray on the impact frame — never the wound's slabs, and D1 excepts
    // fluids — so it is left out of the largest one-tick loss (it stays in the total the blow took); fluid shed later with slabs still counts.
    if (t === 0) vent = Math.max(0, fluid0 - fluidMass());
    maxTick = Math.max(maxTick, last - mass - (t === 0 ? vent : 0));
    last = mass;
    if (t === 0) {
      const map = b.map;
      for (let i = 0; i < b.n; i++) {
        if (map.material[i] === 0 || (map.flags[i]! & 2) === 0) continue;
        const x = i % b.w;
        if (
          (x < b.w - 1 && map.material[i + 1] !== 0 && map.bondR[i]! <= 1) ||
          (i + b.w < b.n && map.material[i + b.w] !== 0 && map.bondD[i]! <= 1)
        )
          crackCells++;
      }
    }
    // The shear: the first tick a slab of the blow's wound lets go — whatever it is made of (an atmosphere / ocean slab leaves
    // as gas and spray, not as a chunk: D1 excepts fluids) — or, failing a tracked wound, the first slab-sized chunk.
    if (shearMs < 0 && heldBefore.some((s) => wb.state[s] !== SLAB_HELD)) shearMs = wallMs;
    // New chunks of this body: the wound's momentum carried by its slabs.
    for (let i = 0; i < core.chunks.hi; i++) {
      const c = core.chunks.list[i]!;
      if (!c.alive || c.origin !== id || chunkIds.has(c.id)) continue;
      chunkIds.add(c.id);
      if (shearMs < 0 && c.mass >= 5) shearMs = wallMs;
      if (wound >= 0 && c.fast) {
        const sp = b.wounds.speed[wound]!;
        const dx = b.wounds.dx[wound]!;
        const dy = b.wounds.dy[wound]!;
        pSum += c.mass * sp;
        pGot += c.mass * (c.vx * dx + c.vy * dy);
        const p = { x: 0, y: 0 };
        localToWorldF(b, b.wounds.lx[wound]!, b.wounds.ly[wound]!, p);
        let rx = c.x - p.x;
        let ry = c.y - p.y;
        const rl = Math.hypot(rx, ry) || 1;
        rx /= rl;
        ry /= rl;
        const vl = Math.hypot(c.vx, c.vy) || 1;
        const cross = (rx * c.vy - ry * c.vx) / vl;
        if (Math.abs(cross) > 0.25 && c.spin !== 0) {
          spinN++;
          if (Math.sign(c.spin) === Math.sign(-cross)) spinOk++;
        }
      }
    }
    // Telemetry rule: clear once coverage stays < 10 % for 3 frames (the clear time is the first of them). The impact frame is
    // also shown through the whole hit-stop.
    const clearAt = (n: number): number => (t === n - 1 ? 0 : (spec.hitstop + t - (n - 1)) * MS_PER_TICK);
    if (fxCoverage(world, cx, cy, BOX_R, true) < 0.1) {
      if (++clean >= 3 && fxClearMs < 0) fxClearMs = Math.max(0, clearAt(3));
    } else {
      clean = 0;
      fxClearMs = -1;
    }
    if (fxCoverage(world, cx, cy, BOX_R, false) < 0.1) {
      if (++cleanAll >= 3 && allClearMs < 0) allClearMs = Math.max(0, clearAt(3));
    } else {
      cleanAll = 0;
      allClearMs = -1;
    }
  }
  const led1 = world.ledger();
  const loss = m0 - world.stats(id).mass;
  const solidLoss = solid0 - (world.stats(id).mass - fluidMass());
  const chunks = led1.chunkMass - led0.chunkMass;
  const parts =
    led1.particleMass +
    led1.dissipated -
    led0.particleMass -
    led0.dissipated -
    Math.max(0, fluid0 - fluidMass());
  return {
    loss,
    solidLoss,
    ventLoss: vent,
    // (the vent is mass the blow took: it stays in the total; only the one-tick numerator leaves it out)
    maxTickShare: loss > 0 ? maxTick / loss : 0,
    chunkShare: chunks / Math.max(1e-6, chunks + Math.max(0, parts)),
    shearMs,
    crackCells,
    momentum: pSum > 0 ? pGot / pSum : -1,
    spinAgree: spinN > 0 ? spinOk / spinN : -1,
    fxClearMs,
    allClearMs,
    ledgerError: Math.abs(led1.error),
    hash: world.hash(),
  };
}
