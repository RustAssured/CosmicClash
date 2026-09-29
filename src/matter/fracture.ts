import { CellFlag, type DamageResult } from '@/contracts';
import type { Body, WorldPoint } from './body';
import { plantFront } from './cracks';
import { RAMP_SHARD, MODE_MECH } from './debris';
import { cohesionBondScale } from './bodyinit';
import { defaultCutOptions, edgeBond, edgeCells, breakEdge, setEdgeBond, DX, DY, type CutFinder } from './cuts';
import {
  DF,
  T_FRACTURE,
  coverageOf,
  destroyCell,
  finishDamage,
  hardness,
  localToWorldF,
  outwardNormal,
  recordBlow,
  resistOf,
  type DamageCtx,
} from './dmg';
import { PK } from './particles';
import { K_LINE } from './shape';

/** Energy (baseline units) to sever one full-strength (255) bond. Seam bonds are cheaper: they are the weak paths. */
const K_E = 4.5;
const F_CRACK = CellFlag.CRACKED;

const pt: WorldPoint = { x: 0, y: 0 };
const nrm: WorldPoint = { x: 0, y: 0 };
const eC = new Int32Array(2);
const opts = defaultCutOptions();

interface CutStats {
  broken: number;
  spent: number;
  complete: boolean;
  tipCorner: number;
}
const cutStats: CutStats = { broken: 0, spent: 0, complete: true, tipCorner: -1 };

/**
 * FRACTURE — shear the target apart along its weakest bonds.
 *
 *  1. CUTS: a bond-weighted shortest path (Dijkstra on the dual lattice) is found between two points of the outline (or an
 *     interior end for a stab). Following weak grain seams and authored faults it yields clean, straight-ish shear lines;
 *     the bonds along it are severed, paid for out of the energy budget, and the cells beside the cut are ground (bruised,
 *     shedding dust and glints). Whatever the cuts isolate from the core detaches in the connectivity pass as a rigid chunk.
 *       - line shapes cut along the line's axis (Tendril Lash, Gaze); PIERCE additionally bores a channel through the cells
 *         on the axis;
 *       - blows (point/cone/ring/field) cut across the contact region, more and longer cuts with more energy.
 *  2. SEAM POP: brittle matter loosens grains near the surface of the contact (weak seams break stochastically).
 *  3. SEED_CRACK plants crack fronts that keep propagating for 1-3 s (see cracks.ts).
 */
export function applyFracture(ctx: DamageCtx, res: DamageResult): void {
  const { core, body } = ctx;
  const q = core.q;
  const n = ctx.n;
  const idx = core.covIdx;
  const wgt = core.covW;
  const mats = body.materials;
  const mat = body.map.material;
  let rs = 0;
  let bs = 0;
  for (let k = 0; k < n; k++) {
    const i = idx[k]!;
    const wt = wgt[k]!;
    rs += resistOf(body, i, T_FRACTURE) * wt;
    bs += mats[mat[i]!]!.brittleness * wt;
  }
  const rEff = rs / ctx.sumW;
  const brit = bs / ctx.sumW;
  const E = ctx.energy * rEff;
  const pierce = ctx.has(DF.PIERCE);
  const isLine = q.kind === K_LINE;
  const continuous = ctx.has(DF.CONTINUOUS);

  if (E >= 0.4) {
    let cutB: number;
    let chanB: number;
    let grindB: number;
    let seamB: number;
    if (isLine) {
      cutB = E * (pierce ? 0.3 : 0.55);
      chanB = E * (pierce ? 0.5 : 0.12);
      grindB = E * (pierce ? 0.2 : 0.33);
      seamB = 0;
    } else {
      cutB = E * 0.55;
      chanB = 0;
      grindB = E * 0.25;
      seamB = E * 0.2;
    }
    let tipCorner = -1;
    if (!continuous || (core.tick & 1) === 0) {
      if (isLine) tipCorner = lineCut(ctx, cutB, grindB, pierce);
      else tipCorner = blowCuts(ctx, E, cutB, grindB, brit);
    }
    if (chanB > 0) carveChannel(ctx, chanB, pierce);
    if (seamB > 0) seamPop(ctx, seamB, brit);
    if (ctx.has(DF.SEED_CRACK)) plantSeeds(ctx, E, brit);
    else if (tipCorner >= 0 && !cutStats.complete && E > 20) {
      // A cut that ran out of energy leaves a live crack tip.
      const dir = 0;
      plantFront(body, tipCorner % (body.w + 1), Math.floor(tipCorner / (body.w + 1)), dir, 25 + E * 0.05, 0.4 + 0.4 * brit, 1);
    }
    body.connDirty = 2;
  }
  recordBlow(ctx, isLine ? 0.08 : 0.16);
  finishDamage(ctx, res, coverageOf(ctx), 1);
}

/* --------------------------------------------------------------------------------------------- *
 *  Cuts
 * --------------------------------------------------------------------------------------------- */

/** Cut along a line shape's axis. Returns the tip corner of the (possibly partial) cut, or -1. */
function lineCut(ctx: DamageCtx, cutB: number, grindB: number, pierce: boolean): number {
  const { core, body } = ctx;
  const q = core.q;
  const w = body.w;
  const mat = body.map.material;
  // Walk the line to find the first/last live cell along it.
  const stepLen = 0.7;
  const steps = Math.max(1, Math.ceil(q.len / stepLen));
  let first = -1;
  let firstCell = -1;
  let lastCell = -1;
  const maxDepth = ctx.params.penetration ?? (pierce ? 9999 : 34);
  for (let s = 0; s <= steps; s++) {
    const t = Math.min(q.len, s * stepLen);
    const ci = body.cellAtWorld(q.x + q.ux * t, q.y + q.uy * t);
    if (ci < 0 || mat[ci] === 0) continue;
    if (first < 0) {
      first = s;
      firstCell = ci;
    }
    if ((s - first) * stepLen > maxDepth) break;
    lastCell = ci;
  }
  if (first < 0 || lastCell === firstCell) return -1;
  const ex = firstCell % w;
  const ey = (firstCell - ex) / w;
  const xx = lastCell % w;
  const xy = (lastCell - xx) / w;
  const lux = q.ux * body.transform.facing;
  const luy = q.uy;
  const finder = core.cuts;
  let sC = finder.startCorner(body, ex, ey, lux, luy);
  if (sC < 0) sC = anyCorner(finder, body, ex, ey);
  let tC = finder.startCorner(body, xx, xy, -lux, -luy);
  if (tC < 0) tC = anyCorner(finder, body, xx, xy);
  if (sC < 0 || tC < 0 || sC === tC) return -1;
  const w1 = w + 1;
  const dist = Math.hypot((sC % w1) - (tC % w1), Math.floor(sC / w1) - Math.floor(tC / w1));
  opts.tx = tC % w1;
  opts.ty = Math.floor(tC / w1);
  opts.minSep = 0;
  opts.maxRange = dist * 1.5 + 14;
  opts.guideX = lux;
  opts.guideY = luy;
  opts.guideLat = 2.4;
  opts.bondK = 0.09;
  if (!finder.find(body, sC % w1, Math.floor(sC / w1), opts)) return -1;
  runCut(ctx, finder, cutB, grindB);
  return cutStats.tipCorner;
}

function anyCorner(finder: CutFinder, body: Body, x: number, y: number): number {
  const w1 = body.w + 1;
  for (let k = 0; k < 4; k++) {
    const cx = x + (k & 1);
    const cy = y + (k >> 1);
    for (let d = 0; d < 4; d++) if (edgeBond(body, cx, cy, d) >= 0) return cy * w1 + cx;
  }
  void finder;
  return -1;
}

/** Cuts across the contact region of a blow. Returns the tip corner of the last cut (or -1). */
function blowCuts(ctx: DamageCtx, E: number, cutB: number, grindB: number, brit: number): number {
  const { core, body } = ctx;
  const q = core.q;
  const n = ctx.n;
  const idx = core.covIdx;
  const w = body.w;
  const flags = body.map.flags;
  const rng = body.rng;
  const finder = core.cuts;
  const w1 = w + 1;
  // Candidate start cells: covered SURFACE cells (the blow lands on the outline).
  let nSurf = 0;
  for (let k = 0; k < n; k++) if ((flags[idx[k]!]! & CellFlag.SURFACE) !== 0) nSurf++;
  if (nSurf === 0) return -1;
  const cuts = Math.max(1, Math.min(5, Math.round(1 + Math.sqrt(E) / 11)));
  const rShape = Math.sqrt(q.area / Math.PI);
  const minSep = Math.max(5, Math.min(26, rShape * 0.8));
  let tip = -1;
  let lastX = -100;
  let lastY = -100;
  let incomplete = false;
  cutStats.complete = true;
  for (let c = 0; c < cuts; c++) {
    // Pick a surface cell, preferring ones not close to a previous start.
    let cell = -1;
    for (let attempt = 0; attempt < 5; attempt++) {
      let pick = rng.int(nSurf);
      for (let k = 0; k < n; k++) {
        const i = idx[k]!;
        if ((flags[i]! & CellFlag.SURFACE) === 0) continue;
        if (pick-- === 0) {
          cell = i;
          break;
        }
      }
      const cx = cell % w;
      const cy = (cell - cx) / w;
      if (Math.abs(cx - lastX) + Math.abs(cy - lastY) >= 5 || attempt === 4) {
        lastX = cx;
        lastY = cy;
        break;
      }
    }
    if (cell < 0) continue;
    const x = cell % w;
    const y = (cell - x) / w;
    outwardNormal(body, x, y, 3, nrm);
    const inX = -nrm.x;
    const inY = -nrm.y;
    const sC = finder.startCorner(body, x, y, inX, inY);
    if (sC < 0) continue;
    // Guide: across the blow (perpendicular to its local direction), rotated a little per cut.
    const ang = Math.atan2(ctx.ldx, -ctx.ldy) + (rng.next() - 0.5) * 1.3; // perpendicular of (ldx, ldy)
    opts.tx = -1;
    opts.ty = -1;
    opts.minSep = minSep * (0.85 + 0.3 * rng.next());
    opts.maxRange = opts.minSep * 2.6 + 8;
    opts.guideX = Math.cos(ang);
    opts.guideY = Math.sin(ang);
    opts.guideLat = 0.32;
    opts.bondK = 0.09;
    if (!finder.find(body, sC % w1, Math.floor(sC / w1), opts)) continue;
    runCut(ctx, finder, cutB / cuts, grindB / cuts);
    tip = cutStats.tipCorner;
    if (!cutStats.complete) incomplete = true;
  }
  cutStats.complete = !incomplete;
  void brit;
  return tip;
}

/** Sever the bonds along `finder.path` until the budget is spent; grind the cells beside it. */
function runCut(ctx: DamageCtx, finder: CutFinder, budget: number, grindBudget: number): void {
  const { core, body } = ctx;
  const w1 = body.w + 1;
  const path = finder.path;
  const L = finder.pathLen;
  const coh = Math.max(0.2, body.cohesionScale);
  const mats = body.materials;
  const mat = body.map.material;
  const perEdgeGrind = grindBudget / Math.max(1, L - 1);
  let spent = 0;
  let broken = 0;
  let complete = true;
  let tip = path[L - 1]!;
  let minX = 1 << 20;
  let minY = 1 << 20;
  let maxX = -1;
  let maxY = -1;
  const rng = body.rng;
  for (let k = 0; k + 1 < L; k++) {
    const u = path[k]!;
    const v = path[k + 1]!;
    const ux = u % w1;
    const uy = (u - ux) / w1;
    const vx = v % w1;
    const d = vx > ux ? 0 : vx < ux ? 2 : v > u ? 1 : 3;
    const bond = edgeBond(body, ux, uy, d);
    if (bond < 0) continue;
    if (ux < minX) minX = ux;
    if (ux > maxX) maxX = ux;
    if (uy < minY) minY = uy;
    if (uy > maxY) maxY = uy;
    if (bond > 0) {
      edgeCells(body, ux, uy, d, eC);
      const a = eC[0]!;
      const b = eC[1]!;
      const r = (resistOf(body, a, T_FRACTURE) + resistOf(body, b, T_FRACTURE)) * 0.5;
      const cost = ((bond / 255) * K_E * coh) / Math.max(0.2, r);
      if (spent + cost > budget) {
        // Out of energy mid-edge: weaken it and stop. The crack tip stays where we are.
        const frac = Math.max(0, (budget - spent) / cost);
        setEdgeBond(body, ux, uy, d, Math.max(1, Math.round(bond * (1 - frac * 0.85))));
        spent = budget;
        complete = false;
        tip = u;
        break;
      }
      spent += cost;
      breakEdge(body, ux, uy, d);
      broken++;
      // Grind the two cells beside the cut and throw a glint or two.
      grindCell(ctx, a, perEdgeGrind);
      grindCell(ctx, b, perEdgeGrind);
      if (rng.next() < 0.22) {
        localToWorldF(body, ux + (DX[d]! * 0.5), uy + (DY[d]! * 0.5), pt);
        const m = mat[mat[a] !== 0 ? a : b]!;
        core.particles.spawn(
          core,
          PK.glint,
          pt.x,
          pt.y,
          (rng.next() - 0.5) * 30,
          (rng.next() - 0.5) * 30,
          8 + rng.int(9),
          1,
          255,
          body.rampIds[m * 4 + RAMP_SHARD]!,
          0,
          2.5,
          0,
        );
      }
    }
  }
  void mats;
  cutStats.broken = broken;
  cutStats.spent = spent;
  cutStats.complete = complete;
  cutStats.tipCorner = tip;
  if (maxX >= 0) body.touch(minX - 2, minY - 2, maxX + 2, maxY + 2);
  ctx.massTransferred += 0;
}

/** Bruise a cell beside a cut; it dies (as dust/shards) if pushed to zero. */
function grindCell(ctx: DamageCtx, i: number, energy: number): void {
  const { body } = ctx;
  const map = body.map;
  if (map.material[i] === 0) return;
  const h = hardness(body, i);
  const loss = Math.min(150, (energy * 255) / (2 * h * Math.max(0.2, resistOf(body, i, T_FRACTURE))));
  const it = map.integrity[i]! - loss;
  ctx.note(i, 1);
  if (it <= 0) {
    const x = i % body.w;
    void x;
    destroyCell(ctx, i, (ctx.dirX + (body.rng.next() - 0.5)) * 20, (ctx.dirY + (body.rng.next() - 0.5)) * 20, MODE_MECH);
  } else {
    map.integrity[i] = it;
    map.flags[i] = map.flags[i]! | F_CRACK;
  }
}

/* --------------------------------------------------------------------------------------------- *
 *  Channel (PIERCE / wide lines): remove the cells on the axis, entry first, until the budget is spent.
 * --------------------------------------------------------------------------------------------- */

const tOrder = new Int32Array(4096);
function carveChannel(ctx: DamageCtx, budget: number, pierce: boolean): void {
  const { core, body } = ctx;
  const q = core.q;
  const idx = core.covIdx;
  const wgt = core.covW;
  const n = ctx.n;
  const map = body.map;
  const w = body.w;
  // Only the core of the beam (weight >= 0.8) is bored.
  const buckets = Math.min(4090, Math.ceil(q.len) + 2);
  const counts = new Int32Array(buckets + 1);
  let m = 0;
  const maxDepth = ctx.params.penetration ?? (pierce ? 9999 : 10);
  // Depth is measured from the first live cell along the axis.
  let tMin = Infinity;
  const tOf = (i: number): number => {
    const x = i % w;
    body.cellWorld(x, (i - x) / w, pt);
    return (pt.x - q.x) * q.ux + (pt.y - q.y) * q.uy;
  };
  for (let k = 0; k < n; k++) {
    if (wgt[k]! < 0.8) continue;
    const t = tOf(idx[k]!);
    if (t < tMin) tMin = t;
  }
  if (tMin === Infinity) return;
  for (let k = 0; k < n && m < tOrder.length; k++) {
    if (wgt[k]! < 0.8) continue;
    const t = tOf(idx[k]!) - tMin;
    if (t > maxDepth) continue;
    const b = Math.min(buckets - 1, Math.max(0, Math.floor(t)));
    counts[b + 1]!++;
    m++;
  }
  for (let b = 0; b < buckets; b++) counts[b + 1] = counts[b + 1]! + counts[b]!;
  const order = new Int32Array(m);
  const fill = counts.slice();
  for (let k = 0; k < n; k++) {
    if (wgt[k]! < 0.8) continue;
    const t = tOf(idx[k]!) - tMin;
    if (t > maxDepth) continue;
    const b = Math.min(buckets - 1, Math.max(0, Math.floor(t)));
    order[fill[b]!++] = idx[k]!;
  }
  let spent = 0;
  for (let j = 0; j < m; j++) {
    const i = order[j]!;
    if (map.material[i] === 0) continue;
    const cost = (hardness(body, i) * (map.integrity[i]! / 255)) / Math.max(0.2, resistOf(body, i, T_FRACTURE));
    ctx.note(i, 1);
    if (spent + cost > budget) {
      // Partial: bruise the first uncut cell with what is left, then stop.
      const left = Math.max(0, budget - spent);
      const loss = (left * 255 * Math.max(0.2, resistOf(body, i, T_FRACTURE))) / hardness(body, i);
      map.integrity[i] = Math.max(1, map.integrity[i]! - loss);
      break;
    }
    spent += cost;
    destroyCell(ctx, i, ctx.dirX * 46 + (body.rng.next() - 0.5) * 30, ctx.dirY * 46 + (body.rng.next() - 0.5) * 30, MODE_MECH);
  }
  body.touch(0, 0, body.w - 1, body.h - 1);
}

/* --------------------------------------------------------------------------------------------- *
 *  Seam pop and crack seeds
 * --------------------------------------------------------------------------------------------- */

/** Brittle matter loosens grains: weak seam bonds inside the shape break stochastically. */
function seamPop(ctx: DamageCtx, budget: number, brit: number): void {
  const { core, body } = ctx;
  const n = ctx.n;
  const idx = core.covIdx;
  const map = body.map;
  const mats = body.materials;
  const mat = map.material;
  const w = body.w;
  const cohInit = cohesionBondScale(body.attributes.cohesion);
  const rng = body.rng;
  const p = Math.min(0.55, (budget / Math.max(1, n)) * 2.2 * (0.25 + brit));
  if (p < 0.005) return;
  let spent = 0;
  for (let k = 0; k < n && spent < budget; k++) {
    const i = idx[k]!;
    const x = i % w;
    const A = mats[mat[i]!]!;
    for (let side = 0; side < 2; side++) {
      const b = side === 0 ? (x < w - 1 ? map.bondR[i]! : 0) : map.bondD[i]!;
      if (b === 0) continue;
      const j = side === 0 ? i + 1 : i + w;
      const B = mats[mat[j]!]!;
      const ref = Math.min(A.bond, B.bond) * cohInit;
      if (ref <= 0 || b >= ref * 0.8) continue; // only seams/faults, not the bulk bond
      const weakness = 1 - b / ref;
      if (rng.next() < p * (0.6 + weakness * 2)) {
        const cost = (b / 255) * K_E * 0.5;
        spent += cost;
        if (side === 0) map.bondR[i] = 0;
        else map.bondD[i] = 0;
        map.flags[i] = map.flags[i]! | F_CRACK;
        map.flags[j] = map.flags[j]! | F_CRACK;
        ctx.note(i, 0.5);
      }
    }
  }
  body.touch(0, 0, body.w - 1, body.h - 1);
}

/** SEED_CRACK: plant crack fronts around the contact; they propagate over the following seconds. */
function plantSeeds(ctx: DamageCtx, E: number, brit: number): void {
  const { core, body } = ctx;
  const n = ctx.n;
  const idx = core.covIdx;
  const w = body.w;
  const w1 = w + 1;
  const rng = body.rng;
  const seeds = ctx.params.crackSeeds ?? 3;
  const stress0 = ctx.params.crackStress ?? Math.min(230, 70 + E * 0.12);
  const speed = 0.45 + 0.75 * brit;
  const flags = body.map.flags;
  for (let s = 0; s < seeds; s++) {
    // Prefer covered surface cells (cracks start at the outline and run inward), else any covered cell.
    let cell = -1;
    for (let attempt = 0; attempt < 6 && cell < 0; attempt++) {
      const c = idx[rng.int(n)]!;
      if ((flags[c]! & CellFlag.SURFACE) !== 0 || attempt === 5) cell = c;
    }
    if (cell < 0) continue;
    const x = cell % w;
    const y = (cell - x) / w;
    outwardNormal(body, x, y, 3, nrm);
    const sC = core.cuts.startCorner(body, x, y, -nrm.x, -nrm.y);
    if (sC < 0) continue;
    // Initial heading: into the body, snapped to an axis.
    let dir: number;
    const ix = -nrm.x;
    const iy = -nrm.y;
    if (Math.abs(ix) > Math.abs(iy)) dir = ix > 0 ? 0 : 2;
    else dir = iy > 0 ? 1 : 3;
    if (rng.next() < 0.35) dir = (dir + (rng.next() < 0.5 ? 1 : 3)) & 3;
    plantFront(body, sC % w1, Math.floor(sC / w1), dir, stress0 * (0.75 + 0.5 * rng.next()), speed, 0);
  }
}
