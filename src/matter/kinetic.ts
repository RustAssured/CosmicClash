import { CellFlag, type DamageResult } from '@/contracts';
import { CONN_NOW } from './body';
import type { Body, WorldPoint } from './body';
import { breakAllBonds, killCell } from './cells';
import type { WorldCore } from './core';
import { carveCrater, type CraterOpts, type CraterOut } from './crater';
import { MODE_MECH, RAMP_SHARD, endSpray, sprayCell } from './debris';
import {
  DF,
  T_KINETIC,
  coverageOf,
  finishDamage,
  hardness,
  isImmune,
  localToWorldF,
  recordBlow,
  resistOf,
  type DamageCtx,
} from './dmg';
import { PK } from './particles';

const F_SHRAP = CellFlag.SHRAPNEL;
const pt: WorldPoint = { x: 0, y: 0 };

const opts: CraterOpts = {
  budget: 0,
  lipFrac: 0.14,
  aspect: 0,
  chunkProb: 0.55,
  speedMul: 1,
  compact: 0,
  craterR: 0,
  type: T_KINETIC,
  costCap: Infinity,
};
const out: CraterOut = {
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

/**
 * KINETIC — a ballistic impact. Carves a bowl-shaped CRATER whose size comes from the energy, the local hardness and the
 * material (iron deep and clean, regolith wide and soft), throws directional EJECTA (rigid chunks + dust, faster near the
 * centre, biased along the blow and out of the surface), loosens the rim, and with EMBED leaves SHRAPNEL that fractures
 * outward after `embedDelay` ticks (secondary chunks a moment after the hit).
 */
export function applyKinetic(ctx: DamageCtx, res: DamageResult): void {
  const { body } = ctx;
  const cov = coverageOf(ctx);
  // Raw energy: every cell's own cost already divides by its resistance (counting it in the budget too would square the matchup).
  opts.budget = ctx.energy;
  opts.craterR = ctx.params.crater ?? 0;
  opts.chunkProb = 0.72;
  if (opts.budget >= 0.5 && carveCrater(ctx, opts, out)) {
    const nEmbed = ctx.params.embed ?? (ctx.has(DF.EMBED) ? 3 : 0);
    if (nEmbed > 0) embedShrapnel(ctx, out, nEmbed, ctx.params.embedDelay ?? 48, opts.budget);
    recordBlow(ctx, 0.85);
    // Cells just beyond the crater floor got a shock: connectivity must re-check.
    body.connDirty = CONN_NOW;
  } else {
    recordBlow(ctx, 0.5);
  }
  finishDamage(ctx, res, cov, 1);
}

/** Plant `count` shrapnel fragments in the material past the crater floor along the direction of travel. */
export function embedShrapnel(
  ctx: DamageCtx,
  cr: CraterOut,
  count: number,
  delay: number,
  budget: number,
): void {
  const { body } = ctx;
  const map = body.map;
  const w = body.w;
  const rng = body.rng;
  // Travel direction in local space, into the body.
  let ix = ctx.ldx;
  let iy = ctx.ldy;
  if (ix * cr.nx + iy * cr.ny > 0) {
    // Blow direction points OUT of the surface (glancing/odd shapes): use the inward normal instead.
    ix = -cr.nx;
    iy = -cr.ny;
  }
  const il = Math.sqrt(ix * ix + iy * iy) || 1;
  ix /= il;
  iy /= il;
  const tx = -iy;
  const ty = ix;
  const eEach = Math.max(18, Math.min(170, (budget * 0.16) / Math.sqrt(count)));
  for (let s = 0; s < count && body.fuseCount < body.fuseCell.length; s++) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const depth = cr.rd * (0.9 + rng.next() * 0.9) + 1 + attempt * 0.7;
      const lat = (rng.next() - 0.5) * Math.max(2, cr.rl * 1.1);
      const x = Math.floor(cr.fx + ix * depth + tx * lat);
      const y = Math.floor(cr.fy + iy * depth + ty * lat);
      if (x < 0 || y < 0 || x >= w || y >= body.h) continue;
      const c = y * w + x;
      if (map.material[c] === 0 || (map.flags[c]! & F_SHRAP) !== 0 || isImmune(body, c, T_KINETIC)) continue;
      map.flags[c] = map.flags[c]! | F_SHRAP;
      const f = body.fuseCount++;
      body.fuseCell[f] = c;
      body.fuseTimer[f] = Math.max(2, Math.round(delay * (0.8 + 0.5 * rng.next())));
      body.fuseEnergy[f] = eEach;
      body.fuseDirX[f] = ix;
      body.fuseDirY[f] = iy;
      body.touch(x, y, x, y);
      break;
    }
  }
}

/** Count down shrapnel fuses; a due fragment bursts outward. Cheap when there are none. */
export function stepFuses(core: WorldCore, body: Body): void {
  if (body.fuseCount === 0) return;
  const map = body.map;
  let k = 0;
  while (k < body.fuseCount) {
    const c = body.fuseCell[k]!;
    // Fragment gone (its cell was destroyed or carried off with a chunk): drop the fuse.
    if (map.material[c] === 0 || (map.flags[c]! & F_SHRAP) === 0) {
      removeFuse(body, k);
      continue;
    }
    // Keep the glint alive: refresh the visual of this cell every few ticks.
    if ((core.tick & 3) === 0) body.touchCell(c);
    body.fuseTimer[k]!--;
    if (body.fuseTimer[k]! <= 0) {
      burst(core, body, c, body.fuseEnergy[k]!, body.fuseDirX[k]!, body.fuseDirY[k]!);
      removeFuse(body, k);
      continue;
    }
    k++;
  }
}

function removeFuse(body: Body, k: number): void {
  const last = --body.fuseCount;
  if (k !== last) {
    body.fuseCell[k] = body.fuseCell[last]!;
    body.fuseTimer[k] = body.fuseTimer[last]!;
    body.fuseEnergy[k] = body.fuseEnergy[last]!;
    body.fuseDirX[k] = body.fuseDirX[last]!;
    body.fuseDirY[k] = body.fuseDirY[last]!;
  }
}

/** A shrapnel fragment fractures outward: pulverises its own cells, breaks bonds in a radius (so chunks pop off), sparks. */
function burst(core: WorldCore, body: Body, c: number, energy: number, dirX: number, dirY: number): void {
  const map = body.map;
  const w = body.w;
  const mat = map.material;
  const rng = body.rng;
  const x0 = c % w;
  const y0 = (c - x0) / w;
  map.flags[c] = map.flags[c]! & ~F_SHRAP;
  const R = 3.2 + Math.sqrt(energy) * 0.62;
  const r2 = R * R;
  body.cellWorld(x0, y0, pt);
  const bx = pt.x;
  const by = pt.y;
  // The burst is a small radial blow for any chunks it frees.
  const blow = body.blow;
  blow.tick = core.tick;
  blow.dirX = dirX * body.transform.facing;
  blow.dirY = dirY;
  blow.energy = energy * 1.4;
  blow.x = bx;
  blow.y = by;
  blow.sourceMass = 2;
  blow.radial = 1;
  const yMin = Math.max(0, Math.floor(y0 - R));
  const yMax = Math.min(body.h - 1, Math.ceil(y0 + R));
  const xMin = Math.max(0, Math.floor(x0 - R));
  const xMax = Math.min(w - 1, Math.ceil(x0 + R));
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      const i = y * w + x;
      if (mat[i] === 0 || isImmune(body, i, T_KINETIC)) continue;
      const dx = x - x0;
      const dy = y - y0;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const t = 1 - Math.sqrt(d2) / R;
      const H = hardness(body, i);
      if (d2 <= 2.9) {
        // The fragment and its immediate surroundings are pulverised.
        const m = mat[i]!;
        body.cellWorld(x, y, pt);
        const mass = killCell(body, i);
        sprayCell(core, body, m, pt.x, pt.y, dx * 40, dy * 40, mass, MODE_MECH);
        core.ledger.dissipated += 0;
        continue;
      }
      // Bruise and break bonds with probability falling off from the centre.
      const loss = (energy * t * t * 255 * Math.max(0.3, resistOf(body, i, T_KINETIC))) / (R * R * 0.35 * H);
      const it = map.integrity[i]! - loss;
      if (it <= 0) {
        const m = mat[i]!;
        body.cellWorld(x, y, pt);
        const mass = killCell(body, i);
        sprayCell(core, body, m, pt.x, pt.y, dx * 30, dy * 30, mass, MODE_MECH);
        continue;
      }
      map.integrity[i] = it < 1 ? 1 : it;
      if (rng.next() < 0.95 * t) breakAllBonds(body, i);
    }
  }
  endSpray(core);
  // Sparks & glints.
  const nspark = 6 + Math.floor(Math.sqrt(energy) * 0.6);
  const mid = mat[c] !== 0 ? mat[c]! : 1;
  for (let k = 0; k < nspark; k++) {
    const a = rng.next() * Math.PI * 2;
    const sp = 40 + rng.next() * 140;
    core.particles.spawn(
      core,
      PK.spark,
      bx,
      by,
      Math.cos(a) * sp,
      Math.sin(a) * sp,
      10 + rng.int(14),
      1,
      255,
      body.rampIds[mid * 5 + RAMP_SHARD]!,
      0.5,
      1,
      0,
    );
  }
  body.touch(xMin, yMin, xMax, yMax);
  body.connDirty = CONN_NOW;
  localToWorldF(body, x0 + 0.5, y0 + 0.5, pt);
  core.emitMatter('crack', pt.x, pt.y, 0.5, body.ownerSlot);
}
