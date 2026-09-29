import type { Body } from './body';
import { CONN_NOW, CONN_STEADY } from './body';
import type { WorldCore } from './core';
import { DX, DY, edgeBond, edgeCells, breakEdge, isSurfaceCorner } from './cuts';
import { PK } from './particles';
import { T_FRACTURE, isImmune, localToWorldF } from './dmg';
import { RAMP_SHARD } from './debris';

const MAX_FRONTS = 160;
const cellsTmp = new Int32Array(2);
const pt = { x: 0, y: 0 };

/**
 * CRACK FRONTS: a front is a moving crack tip on the dual lattice carrying STRESS. Each step it picks the weakest of its
 * forward/left/right edges (bond strength + a turning penalty + noise, so cracks wander but keep heading), breaks it if its
 * stress exceeds what the material needs (bond × toughness), and pays for it in stress: tough materials (iron) arrest cracks,
 * brittle ones (glass, celadon) let them run. Fronts branch in brittle matter and stop when they reach the outline, at
 * which point the cut isolates a slab and connectivity releases it. This is what turns SEED_CRACK into a fissure network
 * that spreads over 1-3 s and finally shears whole pieces off.
 */
export function plantFront(
  body: Body,
  cx: number,
  cy: number,
  dir: number,
  stress: number,
  speed: number,
  gen: number,
): boolean {
  if (body.frontCount >= MAX_FRONTS) return false;
  const k = body.frontCount++;
  body.frontX[k] = cx;
  body.frontY[k] = cy;
  body.frontDir[k] = dir;
  body.frontStress[k] = stress;
  body.frontAcc[k] = 0;
  body.frontSpeed[k] = speed;
  body.frontLife[k] = 420;
  body.frontGen[k] = gen;
  return true;
}

/**
 * Plant a front at corner (cx, cy) heading along the interior edge that best matches the preferred direction (inX, inY):
 * a start on the outline usually has only one or two interior edges, and the front must leave along one of them.
 * Returns false if the corner has no interior edge at all.
 */
export function plantFrontToward(
  body: Body,
  cx: number,
  cy: number,
  inX: number,
  inY: number,
  stress: number,
  speed: number,
  gen: number,
): boolean {
  let best = -1;
  let bs = -Infinity;
  for (let d = 0; d < 4; d++) {
    const bond = edgeBond(body, cx, cy, d);
    if (bond < 0) continue;
    const s = DX[d]! * inX + DY[d]! * inY + (bond === 0 ? 0.3 : 0) + body.rng.next() * 0.35;
    if (s > bs) {
      bs = s;
      best = d;
    }
  }
  if (best < 0) return false;
  return plantFront(body, cx, cy, best, stress, speed, gen);
}

function removeFront(body: Body, k: number): void {
  const last = --body.frontCount;
  if (k !== last) {
    body.frontX[k] = body.frontX[last]!;
    body.frontY[k] = body.frontY[last]!;
    body.frontDir[k] = body.frontDir[last]!;
    body.frontStress[k] = body.frontStress[last]!;
    body.frontAcc[k] = body.frontAcc[last]!;
    body.frontSpeed[k] = body.frontSpeed[last]!;
    body.frontLife[k] = body.frontLife[last]!;
    body.frontGen[k] = body.frontGen[last]!;
  }
}

/** Average of a material property over the two cells an edge separates. */
function edgeTough(body: Body, cx: number, cy: number, d: number): number {
  if (!edgeCells(body, cx, cy, d, cellsTmp)) return 0.5;
  const mats = body.materials;
  const a = mats[body.map.material[cellsTmp[0]!]!]!;
  const b = mats[body.map.material[cellsTmp[1]!]!]!;
  return (a.toughness + b.toughness) * 0.5;
}

function edgeBrittle(body: Body, cx: number, cy: number, d: number): number {
  if (!edgeCells(body, cx, cy, d, cellsTmp)) return 0.5;
  const mats = body.materials;
  const a = mats[body.map.material[cellsTmp[0]!]!]!;
  const b = mats[body.map.material[cellsTmp[1]!]!]!;
  return (a.brittleness + b.brittleness) * 0.5;
}

/** Advance every front of `body` one tick. Cheap when idle (frontCount === 0). */
export function stepFronts(core: WorldCore, body: Body): void {
  if (body.frontCount === 0) return;
  const rng = body.rng;
  const coh = Math.max(0.2, body.cohesionScale);
  let k = 0;
  while (k < body.frontCount) {
    let alive = true;
    body.frontLife[k]!--;
    if (body.frontLife[k]! <= 0) alive = false;
    let acc = body.frontAcc[k]! + body.frontSpeed[k]!;
    let steps = 0;
    while (alive && acc >= 1 && steps < 3) {
      acc -= 1;
      steps++;
      let cx = body.frontX[k]!;
      let cy = body.frontY[k]!;
      const dir = body.frontDir[k]!;
      let stress = body.frontStress[k]!;
      // Candidates: forward, left, right. Pick the weakest (with noise and a turning penalty).
      let bestD = -1;
      let bestScore = Infinity;
      for (let t = 0; t < 3; t++) {
        const d = t === 0 ? dir : t === 1 ? (dir + 3) & 3 : (dir + 1) & 3;
        const bond = edgeBond(body, cx, cy, d);
        if (bond < 0) continue;
        // Existing cracks are a poor place to run (they are already open): prefer fresh weak bonds, fall back to old cracks.
        const score = (bond === 0 ? 55 : bond * 0.55) + (t === 0 ? 0 : 16) + rng.next() * 26;
        if (score < bestScore) {
          bestScore = score;
          bestD = d;
        }
      }
      if (bestD < 0) {
        alive = false;
        break;
      }
      const bond = edgeBond(body, cx, cy, bestD);
      if (
        bond > 0 &&
        edgeCells(body, cx, cy, bestD, cellsTmp) &&
        (isImmune(body, cellsTmp[0]!, T_FRACTURE) || isImmune(body, cellsTmp[1]!, T_FRACTURE))
      ) {
        alive = false; // a crack cannot enter immune matter
        break;
      }
      if (bond > 0) {
        const tough = edgeTough(body, cx, cy, bestD);
        const need = bond * coh * (0.26 + 0.5 * tough);
        if (stress < need) {
          // Arrested by tough matter; a little residual stress lets the crack creep once more after a pause.
          body.frontStress[k] = stress * 0.985;
          if (stress < 5) alive = false;
          break;
        }
        // Brittle matter lets a crack run (little stress lost per break); ductile/tough matter arrests it quickly.
        const brit0 = edgeBrittle(body, cx, cy, bestD);
        stress -= need * (0.36 * (1 - brit0) + 0.03) + 0.15;
        breakEdge(body, cx, cy, bestD);
        body.connDirty = Math.max(body.connDirty, CONN_STEADY);
        // Visual + stats invalidation around the tip, and a glint on brittle matter.
        body.touch(cx - 2, cy - 2, cx + 2, cy + 2);
        localToWorldF(body, cx, cy, pt);
        if (rng.next() < 0.28) {
          const ci = edgeCells(body, cx, cy, bestD, cellsTmp) ? cellsTmp[0]! : 0;
          const rid = body.rampIds[body.map.material[ci]! * 5 + RAMP_SHARD]!;
          core.particles.spawn(
            core,
            PK.glint,
            pt.x,
            pt.y,
            (rng.next() - 0.5) * 24,
            (rng.next() - 0.5) * 24,
            9 + rng.int(8),
            1,
            255,
            rid,
            0,
            2,
            0,
          );
        }
        core.emitMatter('crack', pt.x, pt.y, 0, body.ownerSlot);
        // Branching in brittle matter: a weaker child heads off sideways.
        const brit = edgeBrittle(body, cx, cy, bestD);
        if (
          stress > 30 &&
          rng.next() < 0.045 * brit * (body.frontGen[k]! < 3 ? 1 : 0.3) &&
          body.frontCount < MAX_FRONTS - 1
        ) {
          const cd = rng.next() < 0.5 ? (bestD + 1) & 3 : (bestD + 3) & 3;
          plantFront(
            body,
            cx + DX[bestD]!,
            cy + DY[bestD]!,
            cd,
            stress * 0.5,
            body.frontSpeed[k]! * 0.9,
            body.frontGen[k]! + 1,
          );
          stress *= 0.7;
        }
      }
      cx += DX[bestD]!;
      cy += DY[bestD]!;
      body.frontX[k] = cx;
      body.frontY[k] = cy;
      body.frontDir[k] = bestD;
      body.frontStress[k] = stress;
      if (stress < 3) alive = false;
      // Reached the outline after travelling: the cut is complete.
      if (isSurfaceCorner(body, cx, cy) && body.frontLife[k]! < 415) {
        alive = false;
        body.connDirty = CONN_NOW;
      }
    }
    body.frontAcc[k] = acc;
    if (!alive) removeFront(body, k);
    else k++;
  }
}

/**
 * SLOW CUTS. A FRACTURE cut is planned at once (the energy is spent at the blow) but its bonds are severed progressively from the
 * contact end, so the fissure visibly runs across the body over ~0.5-1.5 s (a glinting tip leads it) and the slab shears when the
 * last bond goes. `queueSlowEdge` appends to the body's queue; a full queue breaks the edge immediately.
 */
export function queueSlowEdge(body: Body, cx: number, cy: number, d: number): void {
  if (body.slowN >= body.slowEdges.length || cx > 1023 || cy > 1023) {
    breakEdge(body, cx, cy, d);
    return;
  }
  body.slowEdges[body.slowN++] = cx | (cy << 10) | (d << 20);
}

export function stepSlowCuts(core: WorldCore, body: Body): void {
  if (body.slowPos >= body.slowN) return;
  const rng = body.rng;
  const pending = body.slowN - body.slowPos;
  const rate = Math.max(2, Math.ceil(pending / 36));
  let n = 0;
  let broke = false;
  while (n < rate && body.slowPos < body.slowN) {
    const e = body.slowEdges[body.slowPos++]!;
    n++;
    const cx = e & 1023;
    const cy = (e >> 10) & 1023;
    const d = (e >> 20) & 3;
    if (edgeBond(body, cx, cy, d) <= 0) continue;
    breakEdge(body, cx, cy, d);
    broke = true;
    body.touch(cx - 2, cy - 2, cx + 2, cy + 2);
    localToWorldF(body, cx, cy, pt);
    if (rng.next() < 0.5) {
      const ci = edgeCells(body, cx, cy, d, cellsTmp) ? cellsTmp[0]! : 0;
      const rid = body.rampIds[(body.map.material[ci] || 1) * 5 + RAMP_SHARD]!;
      core.particles.spawn(
        core,
        PK.glint,
        pt.x,
        pt.y,
        (rng.next() - 0.5) * 30,
        (rng.next() - 0.5) * 30 - 6,
        8 + rng.int(8),
        1,
        255,
        rid,
        0,
        2,
        0,
      );
    }
    if ((body.slowPos & 3) === 0) core.emitMatter('crack', pt.x, pt.y, 0, body.ownerSlot);
  }
  if (broke) body.connDirty = Math.max(body.connDirty, CONN_STEADY);
  if (body.slowPos >= body.slowN) {
    body.slowPos = 0;
    body.slowN = 0;
    body.connDirty = CONN_NOW;
  }
}
