import { MAX_BODY_DIM, CellFlag, type DamageResult } from '@/contracts';
import { CONN_STEADY } from './body';
import type { Body } from './body';
import type { WorldCore } from './core';
import { RAMP_GAS } from './debris';
import { T_TIDAL, coverageOf, finishDamage, hardness, recordBlow, type DamageCtx } from './dmg';
import { tearToStream } from './stream';

const F_SURF = CellFlag.SURFACE;
const MAX_CAND = MAX_BODY_DIM * MAX_BODY_DIM;
const cand = new Int32Array(MAX_CAND);
const candScore = new Float32Array(MAX_CAND);
const candCost = new Float32Array(MAX_CAND);
const order = new Int32Array(MAX_CAND);
const BUCKETS = 96;
const bucketCount = new Int32Array(BUCKETS + 1);
const MAX_PER_SLICE = 260;
/** Minimum energy to tear one cell off, whatever it is made of. */
const TEAR_COST_FLOOR = 0.4;

/**
 * TIDAL — a field pulling matter toward the attacker's focal point (originX, originY). Cells are torn off in order of how
 * easily the field beats their bonds, paying `energy` (per tick with CONTINUOUS) for each:
 *   ease = weight(falloff) · exposure to the source · pull / (hardness · hold · integrity / resist)
 * where `hold` is the cell's mean bond strength relative to the material (loose matter, gas and plasma go first),
 * exposure favours outline cells facing the source, and `horizon` (resist 0) can never be torn. Torn matter becomes
 * a stream particle that spaghettifies (velocity streak), spirals in and is CONSUMED at the sink, crediting its mass to
 * `sourceBodyId` (massGained / massLost in stats). Streams keep flying inside particles.step().
 */
export function applyTidal(ctx: DamageCtx, res: DamageResult): void {
  const { core, body } = ctx;
  const map = body.map;
  const w = body.w;
  const n = ctx.n;
  const idx = core.covIdx;
  const wgt = core.covW;
  const pull = ctx.params.pull ?? 1;
  const coh = Math.max(0.2, body.cohesionScale);
  // Direction toward the sink in local space (from the covered centroid).
  body.worldToLocalF(ctx.originX, ctx.originY, pt2);
  let sdx = pt2.x - ctx.covCx;
  let sdy = pt2.y - ctx.covCy;
  const sdl = Math.sqrt(sdx * sdx + sdy * sdy) + 1e-6;
  sdx /= sdl;
  sdy /= sdl;
  const cover = coverageOf(ctx);

  // 1. Candidates: outline cells and loose (low-bond) matter.
  let nc = 0;
  for (let k = 0; k < n; k++) {
    const i = idx[k]!;
    const m = map.material[i]!;
    const r = body.resistTab[m * 6 + T_TIDAL]!;
    if (r < 0.02) continue;
    const x = i % w;
    const bR = x < w - 1 ? map.bondR[i]! : 0;
    const bL = x > 0 ? map.bondR[i - 1]! : 0;
    const bD = map.bondD[i]!;
    const bU = i >= w ? map.bondD[i - w]! : 0;
    const bsum = bR + bL + bD + bU;
    const ref = Math.max(1, body.materials[m]!.bond) * 4;
    const surf = (map.flags[i]! & F_SURF) !== 0;
    const holdFrac = Math.min(1, bsum / ref);
    if (!surf && body.materials[m]!.bond > 60) continue; // interior solids are held by their neighbours
    // Exposure: does the outline here face the source?
    let expose = 0.6;
    if (surf) {
      let nx = 0;
      let ny = 0;
      if (x === 0 || map.material[i - 1] === 0) nx -= 1;
      if (x === w - 1 || map.material[i + 1] === 0) nx += 1;
      if (i < w || map.material[i - w] === 0) ny -= 1;
      if (i + w >= body.n || map.material[i + w] === 0) ny += 1;
      const nl = Math.sqrt(nx * nx + ny * ny);
      expose = nl > 0 ? 0.25 + 0.75 * Math.max(0, (nx * sdx + ny * sdy) / nl) : 0.5;
    }
    // Floor: even the airiest gas costs something to strip (a Strike must not vaporise a whole star's corona).
    const cost = Math.max(
      TEAR_COST_FLOOR,
      (1.5 * hardness(body, i) * (0.25 + 0.75 * holdFrac) * (map.integrity[i]! / 255) * coh) / r,
    );
    cand[nc] = i;
    candCost[nc] = cost;
    candScore[nc] = (wgt[k]! * expose * pull) / Math.max(0.02, cost);
    nc++;
  }
  if (nc === 0) {
    finishDamage(ctx, res, cover, 0.3);
    return;
  }
  // 2. Order by ease (bucketed, descending).
  let smax = 1e-6;
  for (let k = 0; k < nc; k++) if (candScore[k]! > smax) smax = candScore[k]!;
  bucketCount.fill(0);
  for (let k = 0; k < nc; k++)
    bucketCount[Math.min(BUCKETS - 1, Math.floor((1 - candScore[k]! / smax) * (BUCKETS - 1))) + 1]!++;
  for (let b = 0; b < BUCKETS; b++) bucketCount[b + 1] = bucketCount[b + 1]! + bucketCount[b]!;
  for (let k = 0; k < nc; k++) {
    const b = Math.min(BUCKETS - 1, Math.floor((1 - candScore[k]! / smax) * (BUCKETS - 1)));
    order[bucketCount[b]!++] = k;
  }
  // 3. Peel until the energy budget runs out.
  let budget = ctx.energy;
  let tx0 = w;
  let ty0 = body.h;
  let tx1 = -1;
  let ty1 = -1;
  let torn = 0;
  const homing = 520 + 380 * Math.min(2, pull);
  for (let j = 0; j < nc && torn < MAX_PER_SLICE; j++) {
    const k = order[j]!;
    const c = candCost[k]!;
    const i = cand[k]!;
    if (c > budget) {
      // Not enough to tear it away: stretch it (integrity loss) and stop.
      const loss = (budget / Math.max(0.05, c)) * map.integrity[i]! * 0.6;
      map.integrity[i] = Math.max(1, map.integrity[i]! - loss);
      ctx.note(i, 0.5);
      break;
    }
    budget -= c;
    const m = map.material[i]!;
    {
      const x = i % w;
      const y = (i - x) / w;
      if (x < tx0) tx0 = x;
      if (x > tx1) tx1 = x;
      if (y < ty0) ty0 = y;
      if (y > ty1) ty1 = y;
    }
    ctx.note(i, 1);
    const mass = tearToStream(
      core,
      body,
      i,
      ctx.originX,
      ctx.originY,
      ctx.sourceBodyId,
      homing,
      body.rampIds[m * 5 + RAMP_GAS]!,
      false,
    );
    ctx.removed++;
    ctx.massRemoved += mass;
    ctx.massTransferred += mass;
    torn++;
  }
  if (torn > 0) {
    // Point the recorded blow at the sink: chunks freed by the peeling fall toward it.
    ctx.dirX = ctx.originX - core.q.centreX();
    ctx.dirY = ctx.originY - core.q.centreY();
    const dl = Math.sqrt(ctx.dirX * ctx.dirX + ctx.dirY * ctx.dirY) || 1;
    ctx.dirX /= dl;
    ctx.dirY /= dl;
    recordBlow(ctx, 0);
    body.touch(tx0 - 1, ty0 - 1, tx1 + 1, ty1 + 1);
    body.connDirty = Math.max(body.connDirty, CONN_STEADY);
  }
  finishDamage(ctx, res, cover, 0.25);
}

const pt2 = { x: 0, y: 0 };
export type { Body, WorldCore };
