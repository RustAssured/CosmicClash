import {
  CellFlag,
  DamageFlag,
  type DamageEvent,
  type DamageParams,
  type DamageResult,
  type DamageType,
} from '@/contracts';
import type { Body, WorldPoint } from './body';
import { killCell } from './cells';
import type { WorldCore } from './core';
import { sprayCell } from './debris';

/** Index of each damage type in Body.resistTab (DAMAGE_TYPES order). */
export const T_FRACTURE = 0;
export const T_ASSIM = 1;
export const T_TIDAL = 2;
export const T_THERMAL = 3;
export const T_CRUSH = 4;
export const T_KINETIC = 5;
export const TYPE_INDEX: Record<DamageType, number> = {
  FRACTURE: T_FRACTURE,
  ASSIMILATION: T_ASSIM,
  TIDAL: T_TIDAL,
  THERMAL: T_THERMAL,
  CRUSH: T_CRUSH,
  KINETIC: T_KINETIC,
};

/** Energy -> impulse: momentum (mass·px/s) = MOMENTUM_K · sqrt(energy · sourceMass). */
export const MOMENTUM_K = 30;

const F_CRACK = CellFlag.CRACKED;
const F_BURN = CellFlag.BURNING;
const tmpPt: WorldPoint = { x: 0, y: 0 };

/**
 * One damage application (one tick's slice of an event) in flight. A single instance lives on the world and is reused:
 * damage models read the event through it and accumulate results into it.
 */
export class DamageCtx {
  core!: WorldCore;
  body!: Body;
  type = 0;
  /** Energy of THIS slice (already divided over `duration` unless CONTINUOUS). */
  energy = 0;
  /** World unit direction and its body-local mirror. */
  dirX = 1;
  dirY = 0;
  ldx = 1;
  ldy = 0;
  flags = 0;
  params: DamageParams = {};
  sourceMass = 1;
  sourceBodyId = -1;
  originX = 0;
  originY = 0;
  duration = 1;
  first = true;

  /** Covered live cells: core.covIdx / core.covW hold the first `n`. */
  n = 0;
  sumW = 0;
  /** Weighted covered centroid in body-local cell coordinates. */
  covCx = 0;
  covCy = 0;
  damagedW = 0;

  /* result accumulators */
  removed = 0;
  massRemoved = 0;
  massTransferred = 0;
  affX = 0;
  affY = 0;
  affW = 0;

  has(flag: number): boolean {
    return (this.flags & flag) !== 0;
  }
  /** Accumulate cell `i` (weight w) into the "affected cells" centroid used for the contact point. */
  note(i: number, w: number): void {
    const x = i % this.body.w;
    this.affX += (x + 0.5) * w;
    this.affY += ((i - x) / this.body.w + 0.5) * w;
    this.affW += w;
  }
}

/** Energy needed (baseline units) to destroy one cell of hardness H: density-scaled, floor for gases. */
export function hardness(body: Body, i: number): number {
  const d = (body.matDensity[body.map.material[i]!]! * body.map.density[i]!) / 128;
  return d < 0.09 ? 0.3 : Math.sqrt(d);
}

export const resistOf = (body: Body, i: number, type: number): number =>
  body.resistTab[body.map.material[i]! * 6 + type]!;

/** True if the cell was already weakened (drives `onDamagedFraction`). */
export function isDamaged(body: Body, i: number): boolean {
  const map = body.map;
  return map.integrity[i]! < 215 || (map.flags[i]! & (F_CRACK | F_BURN)) !== 0 || map.infection[i]! > 40;
}

/**
 * Start a damage application: load the event into the shared ctx, collect the covered live cells and measure how much of
 * them was already damaged. Returns null on a whiff (nothing touched).
 */
export function beginDamage(
  core: WorldCore,
  ctx: DamageCtx,
  body: Body,
  ev: DamageEvent,
  energy: number,
  first: boolean,
): DamageCtx | null {
  ctx.core = core;
  ctx.body = body;
  ctx.type = TYPE_INDEX[ev.type];
  ctx.energy = energy;
  const dl = Math.sqrt(ev.dirX * ev.dirX + ev.dirY * ev.dirY);
  ctx.dirX = dl > 1e-6 ? ev.dirX / dl : 1;
  ctx.dirY = dl > 1e-6 ? ev.dirY / dl : 0;
  ctx.ldx = ctx.dirX * body.transform.facing;
  ctx.ldy = ctx.dirY;
  ctx.flags = ev.flags;
  ctx.params = ev.params;
  ctx.sourceMass = ev.sourceMass;
  ctx.sourceBodyId = ev.sourceBodyId;
  ctx.originX = ev.originX;
  ctx.originY = ev.originY;
  ctx.duration = ev.duration;
  ctx.first = first;
  ctx.removed = 0;
  ctx.massRemoved = 0;
  ctx.massTransferred = 0;
  ctx.affX = 0;
  ctx.affY = 0;
  ctx.affW = 0;
  ctx.damagedW = 0;
  ctx.sumW = 0;
  ctx.covCx = 0;
  ctx.covCy = 0;
  body.revealCount = 0;

  core.q.set(ev.shape);
  const n = body.collect(core.q, core.covIdx, core.covW, ev.type === 'TIDAL');
  ctx.n = n;
  if (n === 0) return null;
  const idx = core.covIdx;
  const wgt = core.covW;
  const w = body.w;
  let sw = 0;
  let cx = 0;
  let cy = 0;
  let dw = 0;
  for (let k = 0; k < n; k++) {
    const i = idx[k]!;
    const wt = wgt[k]!;
    const x = i % w;
    sw += wt;
    cx += (x + 0.5) * wt;
    cy += ((i - x) / w + 0.5) * wt;
    if (isDamaged(body, i)) dw += wt;
  }
  ctx.sumW = sw;
  ctx.covCx = cx / sw;
  ctx.covCy = cy / sw;
  ctx.damagedW = dw;
  return ctx;
}

/** Local (float) cell coordinates -> world, using the same row-shear rule as space.ts (evaluated at the containing row). */
export function localToWorldF(body: Body, lx: number, ly: number, out: WorldPoint): void {
  const t = body.transform;
  out.x = t.x + (lx - t.anchorX) * t.facing + body.rowShift(Math.floor(ly));
  out.y = t.y + (ly - t.anchorY);
}

/** Record the blow so chunks that detach shortly afterwards inherit its impulse (see debris.detachVelocity). */
export function recordBlow(ctx: DamageCtx, radial: number): void {
  const b = ctx.body.blow;
  const core = ctx.core;
  if (ctx.affW > 0) localToWorldF(ctx.body, ctx.affX / ctx.affW, ctx.affY / ctx.affW, tmpPt);
  else localToWorldF(ctx.body, ctx.covCx, ctx.covCy, tmpPt);
  b.tick = core.tick;
  b.dirX = ctx.dirX;
  b.dirY = ctx.dirY;
  b.energy = Math.max(b.tick === core.tick ? b.energy * 0.5 : 0, ctx.energy);
  b.x = tmpPt.x;
  b.y = tmpPt.y;
  b.sourceMass = ctx.sourceMass;
  b.radial = radial;
}

/** Fill a DamageResult from the ctx after a model ran. */
export function finishDamage(
  ctx: DamageCtx,
  res: DamageResult,
  coverage: number,
  momentumScale: number,
): void {
  const body = ctx.body;
  res.cellsTouched = ctx.n;
  res.cellsRemoved += ctx.removed;
  res.massRemoved += ctx.massRemoved;
  res.massTransferred += ctx.massTransferred;
  if (ctx.affW > 0) localToWorldF(body, ctx.affX / ctx.affW, ctx.affY / ctx.affW, tmpPt);
  else localToWorldF(body, ctx.covCx, ctx.covCy, tmpPt);
  res.contactX = tmpPt.x;
  res.contactY = tmpPt.y;
  const p =
    MOMENTUM_K *
    Math.sqrt(ctx.energy * Math.max(0.3, ctx.sourceMass)) *
    Math.sqrt(Math.min(1, Math.max(0, coverage * 1.6))) *
    momentumScale;
  res.impulseX += ctx.dirX * p;
  res.impulseY += ctx.dirY * p;
  res.onDamagedFraction = ctx.sumW > 0 ? ctx.damagedW / ctx.sumW : 0;
  if (body.revealCount > 0) res.revealedInterior = true;
  body.revealCount = 0;
}

/**
 * Coverage 0..1: integrity-weighted covered cells relative to the shape's full area (how solidly the shape hit matter).
 */
export function coverageOf(ctx: DamageCtx): number {
  const { core, body } = ctx;
  const idx = core.covIdx;
  const integ = body.map.integrity;
  let s = 0;
  for (let k = 0; k < ctx.n; k++) s += integ[idx[k]!]!;
  return Math.min(1, s / (255 * Math.max(1, core.q.area)));
}

/**
 * Destroy cell `i` as debris: removes it, credits the ctx counters, and sprays particles carrying its mass moving with
 * world velocity (vx, vy). Returns the mass removed.
 */
export function destroyCell(ctx: DamageCtx, i: number, vx: number, vy: number, mode: number): number {
  const body = ctx.body;
  const w = body.w;
  const m = body.map.material[i]!;
  const x = i % w;
  const y = (i - x) / w;
  body.cellWorld(x, y, tmpPt);
  const mass = killCell(body, i);
  sprayCell(ctx.core, body, m, tmpPt.x, tmpPt.y, vx, vy, mass, mode);
  ctx.removed++;
  ctx.massRemoved += mass;
  return mass;
}

export const DF = DamageFlag;

/**
 * Outward surface normal (unit, body-local) at cell (x, y): the mean direction toward void within radius `r`. Returns
 * false (and leaves `out` = (0,-1)) if the cell is not near any void.
 */
export function outwardNormal(body: Body, x: number, y: number, r: number, out: WorldPoint): boolean {
  const { w, h } = body;
  const mat = body.map.material;
  let nx = 0;
  let ny = 0;
  for (let dy = -r; dy <= r; dy++) {
    const yy = y + dy;
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dy === 0) continue;
      const xx = x + dx;
      const isVoid = xx < 0 || yy < 0 || xx >= w || yy >= h || mat[yy * w + xx] === 0;
      if (!isVoid) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r) continue;
      const wt = 1 / (1 + d2 * 0.25);
      nx += dx * wt;
      ny += dy * wt;
    }
  }
  const l = Math.sqrt(nx * nx + ny * ny);
  if (l < 1e-6) {
    out.x = 0;
    out.y = -1;
    return false;
  }
  out.x = nx / l;
  out.y = ny / l;
  return true;
}
