import { CellFlag, type DamageResult } from '@/contracts';
import { CONN_NOW } from './body';
import type { Body, WorldPoint } from './body';
import { breakBondD, breakBondR } from './cells';
import { plantFrontToward, queueSlowEdge } from './cracks';
import { RAMP_SHARD, MODE_MECH } from './debris';
import { cohesionBondScale } from './bodyinit';
import { defaultCutOptions, edgeBond, edgeCells, setEdgeBond, DX, DY, type CutFinder } from './cuts';
import {
  DF,
  T_FRACTURE,
  coverageOf,
  destroyCell,
  finishDamage,
  hardness,
  isImmune,
  localToWorldF,
  outwardNormal,
  recordBlow,
  resistOf,
  type DamageCtx,
} from './dmg';
import { PK } from './particles';
import { findImpact, type Impact } from './impact';
import { K_LINE } from './shape';
import { carveCrater, type CraterOpts, type CraterOut } from './crater';

/** Energy (baseline units) to sever one full-strength (255) bond. Seam bonds are cheaper: they are the weak paths. */
const K_E = 3.6;
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
/** Energy this event spent severing bonds (summed over its cuts): what is left of the cut budget is gouged instead. */
let cutTotal = 0;

/** The chisel: energy that shearing could not use (tough matter, short cuts) still chips a pit out of the contact. */
const gougeOpts: CraterOpts = {
  budget: 0,
  lipFrac: 0.1,
  aspect: 0.55,
  chunkProb: 0.08,
  speedMul: 0.8,
  compact: 0,
  craterR: 0,
  type: T_FRACTURE,
  costCap: 1.8,
};
const gougeOut: CraterOut = {
  ok: false,
  fx: 0,
  fy: 0,
  nx: 0,
  ny: -1,
  rl: 0,
  rd: 0,
  removed: 0,
  chunks: 0,
  removedMass: 0,
  thr: 0,
};
/** Share of a blow's raw energy that always goes to the chisel (on top of unspent shear energy). */
const GOUGE_BASE = 0.5;
/** Corners along this event's cuts, remembered as places where SEED_CRACK fronts can start (on the surviving side). */
const seedCorners: number[] = [];

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
  // Raw energy pays for work (every cost below already divides by the cell's own resistance); the resistance-scaled energy
  // only SIZES the slab a blow tries to free (brittle matter shears off bigger pieces per energy than tough matter).
  const Eraw = ctx.energy;
  const E = Eraw * rEff;
  const pierce = ctx.has(DF.PIERCE);
  const isLine = q.kind === K_LINE;
  const continuous = ctx.has(DF.CONTINUOUS);

  seedCorners.length = 0;
  cutTotal = 0;
  if (E >= 0.4) {
    let cutB: number;
    let chanB: number;
    let grindB: number;
    let seamB: number;
    if (isLine) {
      cutB = Eraw * (pierce ? 0.3 : 0.45);
      chanB = Eraw * (pierce ? 0.5 : 0.1);
      grindB = Eraw * (pierce ? 0.2 : 0.25);
      seamB = 0;
    } else {
      cutB = Eraw * 0.5;
      chanB = 0;
      grindB = Eraw * 0.2;
      seamB = Eraw * 0.15;
    }
    let tipCorner = -1;
    // A short stab (limited penetration, no PIERCE) shears a slab off the surface like a blow; a beam or a piercing line cuts along its axis.
    const stab = isLine && !pierce && (ctx.params.penetration ?? 60) < 24;
    if (!continuous || (core.tick & 1) === 0) {
      if (isLine && !stab) tipCorner = lineCut(ctx, E, cutB, grindB, pierce);
      else tipCorner = blowCuts(ctx, E, cutB, grindB);
    }
    if (chanB > 0) carveChannel(ctx, chanB, pierce);
    if (seamB > 0) seamPop(ctx, seamB, brit);
    // The chisel is deferred a few ticks: connectivity first releases the slabs the cuts isolated (intact, as chunks), then the
    // chisel bites the contact that is left. Its budget = the base share + shear energy the cuts could not use (tough matter).
    // Brittle matter shears into slabs and wastes little on grinding; tough matter can only be chewed.
    if (!continuous)
      ctx.chisel = Math.max(0.05, 1 - 0.95 * brit) * (Eraw * GOUGE_BASE + Math.max(0, cutB - cutTotal));
    if (ctx.has(DF.SEED_CRACK)) plantSeeds(ctx, E, brit);
    else if (tipCorner >= 0 && !cutStats.complete && E > 20) {
      // A cut that ran out of energy leaves a live crack tip.
      // (heading: onward along the cut's last direction if it can, else any interior edge)
      plantFrontToward(
        body,
        tipCorner % (body.w + 1),
        Math.floor(tipCorner / (body.w + 1)),
        ctx.ldx,
        ctx.ldy,
        25 + E * 0.05,
        0.4 + 0.4 * brit,
        1,
      );
    }
    body.connDirty = CONN_NOW;
  }
  recordBlow(ctx, isLine ? 0.08 : 0.16);
  finishDamage(ctx, res, coverageOf(ctx), 1);
}

/** Delay (ticks) before the deferred chisel runs: past the CONN_NOW pass that frees the slabs. */
export const CHISEL_DELAY = 3;

/** The deferred chisel of a FRACTURE blow (world.ts runs it from the job queue): chips a pit out of what the cuts left at the contact. */
export function chisel(ctx: DamageCtx, budget: number): void {
  if (budget < 4) return;
  gougeOpts.budget = budget;
  carveCrater(ctx, gougeOpts, gougeOut);
}

/* --------------------------------------------------------------------------------------------- *
 *  Cuts
 * --------------------------------------------------------------------------------------------- */

/** Slab area (cells) a blow of effective energy `E` tries to free with `cuts` cuts. */
const slabArea = (E: number, cuts: number): number => Math.max(50, Math.min(2200, (E * 1.25) / cuts));

/** Cut along a line shape's axis. Returns the tip corner of the (possibly partial) cut, or -1. */
function lineCut(ctx: DamageCtx, E: number, cutB: number, grindB: number, pierce: boolean): number {
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
  let lastInterior = false;
  const maxDepth = ctx.params.penetration ?? (pierce ? 9999 : 60);
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
    // Is the next sample void? Then this is where the line leaves the body.
    const t2 = Math.min(q.len, (s + 1) * stepLen);
    const nc = body.cellAtWorld(q.x + q.ux * t2, q.y + q.uy * t2);
    lastInterior = s < steps && nc >= 0 && mat[nc] !== 0;
  }
  if (first < 0 || lastCell === firstCell) return -1;
  const ex = firstCell % w;
  const ey = (firstCell - ex) / w;
  const xx = lastCell % w;
  const xy = (lastCell - xx) / w;
  const lux = q.ux * body.transform.facing;
  const luy = q.uy;
  const finder = core.cuts;
  const w1 = w + 1;
  let sC = finder.startCorner(body, ex, ey, lux, luy);
  if (sC < 0) sC = anyCorner(body, ex, ey);
  let tC = lastInterior ? anyCorner(body, xx, xy) : finder.startCorner(body, xx, xy, -lux, -luy);
  if (tC < 0) tC = anyCorner(body, xx, xy);
  if (sC < 0 || tC < 0 || sC === tC) return -1;
  const sx = sC % w1;
  const sy = Math.floor(sC / w1);
  const tx = tC % w1;
  const ty = Math.floor(tC / w1);
  const chord = Math.hypot(tx - sx, ty - sy);
  const A = slabArea(E, 1);
  const h = Math.max(4, Math.min(36, Math.sqrt(A) * 0.55));
  const cTarget = (1.5 * A) / h;
  cutStats.complete = true;
  if (!lastInterior && chord < cTarget * 1.3) {
    // A shallow chord (the lash skims the outline): dive under it so a real slab is isolated.
    let inx = body.map.coreX + 0.5 - (sx + tx) * 0.5;
    let iny = body.map.coreY + 0.5 - (sy + ty) * 0.5;
    const il = Math.hypot(inx, iny) || 1;
    inx /= il;
    iny /= il;
    return uCutVia(ctx, sC, tC, (sx + tx) * 0.5 + inx * h, (sy + ty) * 0.5 + iny * h, cutB, grindB);
  }
  opts.tx = tx;
  opts.ty = ty;
  opts.minSep = 0;
  opts.maxRange = chord * 1.5 + 14;
  opts.guideX = lux;
  opts.guideY = luy;
  opts.guideLat = 2.4;
  opts.bondK = 0.09;
  if (!finder.find(body, sx, sy, opts)) return -1;
  runCut(ctx, finder, cutB, grindB);
  return cutStats.tipCorner;
}

function anyCorner(body: Body, x: number, y: number): number {
  const w1 = body.w + 1;
  for (let k = 0; k < 4; k++) {
    const cx = x + (k & 1);
    const cy = y + (k >> 1);
    for (let d = 0; d < 4; d++) if (edgeBond(body, cx, cy, d) >= 0) return cy * w1 + cx;
  }
  return -1;
}

/** Nearest live SURFACE cell to local point (px, py) within `rad`; -1 if none. */
function nearestSurfaceCell(body: Body, px: number, py: number, rad: number): number {
  const { w, h } = body;
  const map = body.map;
  let best = -1;
  let bd = Infinity;
  for (let y = Math.max(0, Math.floor(py - rad)); y <= Math.min(h - 1, Math.ceil(py + rad)); y++) {
    for (let x = Math.max(0, Math.floor(px - rad)); x <= Math.min(w - 1, Math.ceil(px + rad)); x++) {
      const i = y * w + x;
      if (map.material[i] === 0 || (map.flags[i]! & CellFlag.SURFACE) === 0) continue;
      const d = (x + 0.5 - px) * (x + 0.5 - px) + (y + 0.5 - py) * (y + 0.5 - py);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
  }
  return best;
}

/** Nearest live cell to local (px, py) within `rad`; -1 if none. */
function nearestLiveCell(body: Body, px: number, py: number, rad: number): number {
  const { w, h } = body;
  const map = body.map;
  let best = -1;
  let bd = Infinity;
  for (let y = Math.max(0, Math.floor(py - rad)); y <= Math.min(h - 1, Math.ceil(py + rad)); y++) {
    for (let x = Math.max(0, Math.floor(px - rad)); x <= Math.min(w - 1, Math.ceil(px + rad)); x++) {
      const i = y * w + x;
      if (map.material[i] === 0) continue;
      const d = (x + 0.5 - px) * (x + 0.5 - px) + (y + 0.5 - py) * (y + 0.5 - py);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
  }
  return best;
}

/**
 * A U-shaped cut: outline corner S -> interior waypoint (wx, wy) -> outline corner T. The two legs follow the weakest bonds
 * (seams, faults), and together they isolate the slab between the U and the outline. Returns the tip corner.
 */
function uCutVia(
  ctx: DamageCtx,
  sC: number,
  tC: number,
  wx: number,
  wy: number,
  cutB: number,
  grindB: number,
): number {
  const { core, body } = ctx;
  const finder = core.cuts;
  const w1 = body.w + 1;
  const wc = nearestLiveCell(body, wx, wy, 4);
  if (wc < 0) return -1;
  const wCorner = anyCorner(body, wc % body.w, Math.floor(wc / body.w));
  if (wCorner < 0) return -1;
  const sx = sC % w1;
  const sy = Math.floor(sC / w1);
  const tx = tC % w1;
  const ty = Math.floor(tC / w1);
  const mx = wCorner % w1;
  const my = Math.floor(wCorner / w1);
  const l1 = Math.hypot(mx - sx, my - sy);
  const l2 = Math.hypot(tx - mx, ty - my);
  const legs: [number, number, number, number, number][] = [
    [sx, sy, mx, my, l1],
    [mx, my, tx, ty, l2],
  ];
  let tip = -1;
  let incomplete = false;
  for (let k = 0; k < 2; k++) {
    const [ax, ay, bx, by, len] = legs[k]!;
    if (k === 1 && incomplete) break;
    opts.tx = bx;
    opts.ty = by;
    opts.minSep = 0;
    opts.maxRange = len * 1.8 + 12;
    const gl = Math.max(1e-6, len);
    opts.guideX = (bx - ax) / gl;
    opts.guideY = (by - ay) / gl;
    opts.guideLat = 0.22;
    opts.bondK = 0.09;
    if (!finder.find(body, ax, ay, opts)) {
      incomplete = true;
      continue;
    }
    runCut(ctx, finder, cutB * (len / Math.max(1, l1 + l2)), grindB * (len / Math.max(1, l1 + l2)));
    tip = cutStats.tipCorner;
    if (!cutStats.complete) incomplete = true;
  }
  cutStats.complete = !incomplete;
  return tip;
}

const imp: Impact = { fx: 0, fy: 0, nx: 0, ny: -1, hasNormal: false };

/** Cuts across the contact region of a blow: U-cuts that isolate slabs sized by the energy. Returns the last tip corner. */
function blowCuts(ctx: DamageCtx, E: number, cutB: number, grindB: number): number {
  const { core, body } = ctx;
  const rng = body.rng;
  if (!findImpact(ctx, imp)) return -1;
  const w = body.w;
  const mat = body.map.material;
  const cuts = Math.max(1, Math.min(3, Math.round(E / 380) + 1));
  const inX = -imp.nx;
  const inY = -imp.ny;
  // Depth available along the inward normal.
  let avail = 0;
  for (; avail < 90; avail++) {
    const x = Math.floor(imp.fx + inX * (avail + 1));
    const y = Math.floor(imp.fy + inY * (avail + 1));
    if (x < 0 || y < 0 || x >= w || y >= body.h || mat[y * w + x] === 0) break;
  }
  const A = slabArea(E, cuts);
  let h = Math.max(4, Math.min(36, Math.sqrt(A) * 0.55));
  h = Math.min(h, avail * 0.72);
  if (h < 3) return -1;
  const chord = (1.5 * A) / h;
  const tX = -inY;
  const tY = inX;
  // Tangential swipe direction (which way the slab slides): sign of the blow's tangential component.
  const swipe = ctx.ldx * tX + ctx.ldy * tY;
  let tip = -1;
  let incomplete = false;
  for (let c = 0; c < cuts; c++) {
    const half = Math.max(5, Math.min(52, chord * 0.5)) * (c === 0 ? 1 : 0.8);
    const shift =
      (c === 0 ? 0 : (c % 2 === 0 ? 1 : -1) * half * 0.9) +
      swipe * half * 0.35 +
      (rng.next() - 0.5) * half * 0.3;
    const depth = h * (c === 0 ? 1 : 0.85);
    const ps = nearestSurfaceCell(
      body,
      imp.fx + tX * (shift - half) - inX * 1.5,
      imp.fy + tY * (shift - half) - inY * 1.5,
      14,
    );
    const pe = nearestSurfaceCell(
      body,
      imp.fx + tX * (shift + half) - inX * 1.5,
      imp.fy + tY * (shift + half) - inY * 1.5,
      14,
    );
    if (ps < 0 || pe < 0 || ps === pe) continue;
    const sxc = ps % w;
    const syc = (ps - sxc) / w;
    const exc = pe % w;
    const eyc = (pe - exc) / w;
    let sC = core.cuts.startCorner(body, sxc, syc, inX, inY);
    if (sC < 0) sC = anyCorner(body, sxc, syc);
    let tC = core.cuts.startCorner(body, exc, eyc, inX, inY);
    if (tC < 0) tC = anyCorner(body, exc, eyc);
    if (sC < 0 || tC < 0 || sC === tC) continue;
    const t = uCutVia(
      ctx,
      sC,
      tC,
      imp.fx + tX * shift + inX * depth,
      imp.fy + tY * shift + inY * depth,
      cutB / cuts,
      grindB / cuts,
    );
    if (t >= 0) tip = t;
    if (!cutStats.complete) incomplete = true;
  }
  cutStats.complete = !incomplete;
  return tip;
}

/** Sever the bonds along `finder.path` until the budget is spent; grind the cells beside it. */
function runCut(ctx: DamageCtx, finder: CutFinder, budget: number, grindBudget: number): void {
  const { core, body } = ctx;
  const w1 = body.w + 1;
  const path = finder.path;
  const L = finder.pathLen;
  const coh = Math.max(0.2, body.cohesionScale);
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
      if (isImmune(body, a, T_FRACTURE) || isImmune(body, b, T_FRACTURE)) {
        // Immune matter cannot be cut: the crack stops at its edge.
        complete = false;
        tip = u;
        break;
      }
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
      queueSlowEdge(body, ux, uy, d);
      broken++;
      // Grind the two cells beside the cut and throw a glint or two.
      grindCell(ctx, a, perEdgeGrind);
      grindCell(ctx, b, perEdgeGrind);
      if (rng.next() < 0.22) {
        localToWorldF(body, ux + DX[d]! * 0.5, uy + DY[d]! * 0.5, pt);
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
          body.rampIds[m * 5 + RAMP_SHARD]!,
          0,
          2.5,
          0,
        );
      }
    }
  }
  if (L > 2) {
    seedCorners.push(path[L >> 1]!);
    seedCorners.push(path[Math.max(0, (L >> 1) - (L >> 2))]!);
  }
  cutTotal += spent;
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
  if (map.material[i] === 0 || isImmune(body, i, T_FRACTURE)) return;
  const h = hardness(body, i);
  const loss = Math.min(150, (energy * 255) / (2 * h * Math.max(0.2, resistOf(body, i, T_FRACTURE))));
  const it = map.integrity[i]! - loss;
  ctx.note(i, 1);
  if (it <= 0) {
    destroyCell(
      ctx,
      i,
      (ctx.dirX + (body.rng.next() - 0.5)) * 20,
      (ctx.dirY + (body.rng.next() - 0.5)) * 20,
      MODE_MECH,
    );
  } else {
    map.integrity[i] = it < 1 ? 1 : it; // Uint8 truncates: never let a live cell round down to 0
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
    if (wgt[k]! < 0.8 || isImmune(body, idx[k]!, T_FRACTURE)) continue;
    const t = tOf(idx[k]!);
    if (t < tMin) tMin = t;
  }
  if (tMin === Infinity) return;
  for (let k = 0; k < n && m < tOrder.length; k++) {
    if (wgt[k]! < 0.8 || isImmune(body, idx[k]!, T_FRACTURE)) continue;
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
    if (wgt[k]! < 0.8 || isImmune(body, idx[k]!, T_FRACTURE)) continue;
    const t = tOf(idx[k]!) - tMin;
    if (t > maxDepth) continue;
    const b = Math.min(buckets - 1, Math.max(0, Math.floor(t)));
    order[fill[b]!++] = idx[k]!;
  }
  let spent = 0;
  let bx0 = w;
  let by0 = body.h;
  let bx1 = -1;
  let by1 = -1;
  for (let j = 0; j < m; j++) {
    const i = order[j]!;
    if (map.material[i] === 0) continue;
    {
      const x = i % w;
      const y = (i - x) / w;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
    const cost =
      (hardness(body, i) * (map.integrity[i]! / 255)) / Math.max(0.2, resistOf(body, i, T_FRACTURE));
    ctx.note(i, 1);
    if (spent + cost > budget) {
      // Partial: bruise the first uncut cell with what is left, then stop.
      const left = Math.max(0, budget - spent);
      const loss = (left * 255 * Math.max(0.2, resistOf(body, i, T_FRACTURE))) / hardness(body, i);
      map.integrity[i] = Math.max(1, map.integrity[i]! - loss);
      break;
    }
    spent += cost;
    destroyCell(
      ctx,
      i,
      ctx.dirX * 46 + (body.rng.next() - 0.5) * 30,
      ctx.dirY * 46 + (body.rng.next() - 0.5) * 30,
      MODE_MECH,
    );
  }
  if (bx1 >= 0) body.touch(bx0 - 1, by0 - 1, bx1 + 1, by1 + 1);
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
  let sx0 = w;
  let sy0 = body.h;
  let sx1 = -1;
  let sy1 = -1;
  for (let k = 0; k < n && spent < budget; k++) {
    const i = idx[k]!;
    if (isImmune(body, i, T_FRACTURE)) continue;
    const x = i % w;
    const A = mats[mat[i]!]!;
    for (let side = 0; side < 2; side++) {
      const b = side === 0 ? (x < w - 1 ? map.bondR[i]! : 0) : map.bondD[i]!;
      if (b === 0) continue;
      const j = side === 0 ? i + 1 : i + w;
      if (isImmune(body, j, T_FRACTURE)) continue;
      const B = mats[mat[j]!]!;
      const ref = Math.min(A.bond, B.bond) * cohInit;
      if (ref <= 0 || b >= ref * 0.8) continue; // only seams/faults, not the bulk bond
      const weakness = 1 - b / ref;
      if (rng.next() < p * (0.6 + weakness * 2)) {
        const cost = (b / 255) * K_E * 0.5;
        spent += cost;
        if (side === 0) breakBondR(body, i);
        else breakBondD(body, i);
        ctx.note(i, 0.5);
        const y = (i - x) / w;
        if (x < sx0) sx0 = x;
        if (x > sx1) sx1 = x;
        if (y < sy0) sy0 = y;
        if (y > sy1) sy1 = y;
      }
    }
  }
  if (sx1 >= 0) body.touch(sx0 - 1, sy0 - 1, sx1 + 2, sy1 + 2);
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
  // Covered outline cells are where cracks start and run inward; with none (deep hit) any covered cell will do.
  let nSurf = 0;
  for (let k = 0; k < n; k++) if ((flags[idx[k]!]! & CellFlag.SURFACE) !== 0) nSurf++;
  for (let s = 0; s < seeds; s++) {
    // First choice: points along this event's own cuts, running toward the core through the surviving body.
    if (seedCorners.length > 0) {
      const c = seedCorners[rng.int(seedCorners.length)]!;
      const cx = c % w1;
      const cy = Math.floor(c / w1);
      let ix = body.map.coreX + 0.5 - cx;
      let iy = body.map.coreY + 0.5 - cy;
      const il = Math.hypot(ix, iy) || 1;
      ix = ix / il + (rng.next() - 0.5) * 0.8;
      iy = iy / il + (rng.next() - 0.5) * 0.8;
      if (plantFrontToward(body, cx, cy, ix, iy, stress0 * (0.75 + 0.5 * rng.next()), speed, 0)) continue;
    }
    let cell = -1;
    if (nSurf > 0) {
      let pick = rng.int(nSurf);
      for (let k = 0; k < n; k++) {
        const c = idx[k]!;
        if ((flags[c]! & CellFlag.SURFACE) === 0) continue;
        if (pick-- === 0) {
          cell = c;
          break;
        }
      }
    } else cell = idx[rng.int(n)]!;
    if (cell < 0) continue;
    const x = cell % w;
    const y = (cell - x) / w;
    outwardNormal(body, x, y, 3, nrm);
    let sC = core.cuts.startCorner(body, x, y, -nrm.x, -nrm.y);
    if (sC < 0) sC = anyCorner(body, x, y);
    if (sC < 0) continue;
    plantFrontToward(
      body,
      sC % w1,
      Math.floor(sC / w1),
      -nrm.x,
      -nrm.y,
      stress0 * (0.75 + 0.5 * rng.next()),
      speed,
      0,
    );
  }
}
