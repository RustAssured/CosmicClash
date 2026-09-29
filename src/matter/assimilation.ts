import { CellFlag, type DamageResult } from '@/contracts';
import { ACT_INFECT, TILE, TILE_SHIFT, type Body, CONN_STEADY } from './body';
import type { WorldCore } from './core';
import { RAMP_INFECT } from './debris';
import { DF, T_ASSIM, coverageOf, finishDamage, recordBlow, resistOf, type DamageCtx } from './dmg';
import { tearToStream } from './stream';
import { hashI } from './util';

const F_ASSIM = CellFlag.ASSIMILATED;
const F_SURF = CellFlag.SURFACE;
const F_BURN = CellFlag.BURNING;

/** Infection needed to count as spreading, and to convert a cell into lattice. */
const SPREAD_MIN = 40;
const CONVERT_AT = 200;
/** Assimilation harvest config lasts this many ticks after the last ASSIMILATION event. */
const HARVEST_TICKS = 300;

/**
 * ASSIMILATION — chains latch in and convert matter into the attacker's crimson lattice.
 *   deposit: infection += latch × weight × assimilable × resist (latch defaults from the energy); LATCH roots the contact
 *            (cells convert immediately), otherwise the deposit is lighter;
 *   spread : `stepInfection` moves infection along intact bonds (never across cracks), rate ∝ the neighbour's `assimilable`;
 *            cells that reach 200 become ASSIMILATED (lattice look), and are weakened (bonds ×0.65, integrity ≤ 210);
 *   harvest: with `params.harvest` > 0 the converted lattice is TORN OUT and streams to (originX, originY), crediting mass to
 *            `sourceBodyId`. Fire burns infection out (thermal.ts): the Nexus' lattice is flammable and infected cells take
 *            1.5× heat — emergent, not special-cased.
 */
export function applyAssimilation(ctx: DamageCtx, res: DamageResult): void {
  const { core, body } = ctx;
  const map = body.map;
  const n = ctx.n;
  const idx = core.covIdx;
  const wgt = core.covW;
  const mats = body.materials;
  const latchFlag = ctx.has(DF.LATCH);
  const cover = coverageOf(ctx);
  const latch = ctx.params.latch ?? Math.max(40, Math.min(255, (ctx.energy / Math.max(1, n)) * 255 * 3));
  const scale = latchFlag ? 1 : 0.45;
  const harvest = ctx.params.harvest ?? 0;
  let minX = body.w;
  let minY = body.h;
  let maxX = -1;
  let maxY = -1;
  let torn = 0;
  const rng = body.rng;
  for (let k = 0; k < n; k++) {
    const i = idx[k]!;
    const m = map.material[i]!;
    const assim = mats[m]!.assimilable;
    if (assim <= 0) continue;
    const r = resistOf(body, i, T_ASSIM);
    // Chains hook into anything a little; how readily the infection then SPREADS is the material's `assimilable`.
    let d = latch * wgt[k]! * (0.5 + 0.5 * assim) * r * scale;
    if (d < 1) continue;
    ctx.note(i, wgt[k]!);
    const inf = Math.min(255, map.infection[i]! + d);
    map.infection[i] = inf;
    if (inf >= CONVERT_AT || (latchFlag && inf >= 100)) convert(body, i);
    const x = i % body.w;
    const y = (i - x) / body.w;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    // Immediate harvest tug on already-converted lattice inside the shape.
    if (
      harvest > 0 &&
      (map.flags[i]! & F_ASSIM) !== 0 &&
      (map.flags[i]! & F_SURF) !== 0 &&
      rng.next() < harvest * wgt[k]! * 0.5
    ) {
      const mass = tearToStream(
        core,
        body,
        i,
        ctx.originX,
        ctx.originY,
        ctx.sourceBodyId,
        640,
        body.rampIds[m * 5 + RAMP_INFECT]!,
        true,
      );
      ctx.removed++;
      ctx.massRemoved += mass;
      ctx.massTransferred += mass;
      torn++;
    }
    d = 0;
  }
  if (maxX >= 0) {
    body.wakeRect(minX, minY, maxX, maxY, ACT_INFECT);
    body.touch(minX - 1, minY - 1, maxX + 1, maxY + 1);
  }
  if (harvest > 0) {
    body.harvest = harvest;
    body.harvestFrom = ctx.sourceBodyId;
    body.harvestX = ctx.originX;
    body.harvestY = ctx.originY;
    body.harvestUntil = core.tick + HARVEST_TICKS;
  }
  if (torn > 0) body.connDirty = Math.max(body.connDirty, CONN_STEADY);
  recordBlow(ctx, 0);
  finishDamage(ctx, res, cover, 0.5);
}

/** A cell becomes lattice: flagged, weakened, and its bonds loosened so the Nexus can rip it out. */
function convert(body: Body, i: number): void {
  const map = body.map;
  if ((map.flags[i]! & F_ASSIM) !== 0) return;
  map.flags[i] = map.flags[i]! | F_ASSIM;
  const w = body.w;
  const x = i % w;
  const wk = (v: number): number => Math.max(1, Math.round(v * 0.65));
  if (x < w - 1 && map.bondR[i]! > 0) map.bondR[i] = wk(map.bondR[i]!);
  if (x > 0 && map.bondR[i - 1]! > 0) map.bondR[i - 1] = wk(map.bondR[i - 1]!);
  if (map.bondD[i]! > 0) map.bondD[i] = wk(map.bondD[i]!);
  if (i >= w && map.bondD[i - w]! > 0) map.bondD[i - w] = wk(map.bondD[i - w]!);
  if (map.integrity[i]! > 210) map.integrity[i] = 210;
}

/**
 * Infection spreads along intact bonds; converted lattice is harvested if a harvest is active. Only tiles with spreading
 * infection are visited. Two-phase (accumulate, then apply) so the spread has no scan-order bias.
 */
export function stepInfection(core: WorldCore, body: Body): void {
  const nt = body.tilesX * body.tilesY;
  const act = body.tileAct;
  const list = body.tileList;
  let na = 0;
  for (let t = 0; t < nt; t++) if ((act[t]! & ACT_INFECT) !== 0) list[na++] = t;
  if (na === 0) return;
  const map = body.map;
  const w = body.w;
  const h = body.h;
  const mat = map.material;
  const inf = map.infection;
  const flags = map.flags;
  const mats = body.materials;
  const aux = body.aux;
  const vein8 = body.vein;
  const next = body.tileNext;
  next.fill(0, 0, nt);
  const tick = core.tick;
  const seed = body.seed;
  const harvesting = body.harvest > 0 && tick < body.harvestUntil;
  // Phase 1: accumulate transfers into aux (Float32, zero outside active work).
  for (let a = 0; a < na; a++) {
    const t = list[a]!;
    const tx = t % body.tilesX;
    const ty = (t / body.tilesX) | 0;
    const x0 = tx << TILE_SHIFT;
    const y0 = ty << TILE_SHIFT;
    const x1 = Math.min(w, x0 + TILE);
    const y1 = Math.min(h, y0 + TILE);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        const v = inf[i]!;
        if (v < SPREAD_MIN || mat[i] === 0) continue;
        const rnd = hashI(i, tick, seed);
        // four neighbours, gated by a per-cell/tick hash so fronts are ragged, not diamond-shaped
        for (let d = 0; d < 4; d++) {
          let nn: number;
          let bond: number;
          if (d === 0) {
            if (x >= w - 1) continue;
            nn = i + 1;
            bond = map.bondR[i]!;
          } else if (d === 1) {
            if (x <= 0) continue;
            nn = i - 1;
            bond = map.bondR[i - 1]!;
          } else if (d === 2) {
            if (y >= h - 1) continue;
            nn = i + w;
            bond = map.bondD[i]!;
          } else {
            if (y <= 0) continue;
            nn = i - w;
            bond = map.bondD[i - w]!;
          }
          if (bond === 0 || mat[nn] === 0) continue;
          const an = mats[mat[nn]!]!.assimilable;
          if (an <= 0 || inf[nn]! >= 255) continue;
          // Veins: low-frequency noise makes some directions spread several times faster than others (branching, not a disc).
          const vein = vein8[nn]! * (1 / 64);
          if (((rnd >>> (d * 5)) & 31) / 31 > (0.3 + 0.4 * an) * vein) continue;
          aux[nn] = aux[nn]! + (2 + v * 0.06) * (0.3 + 0.7 * an);
          next[(ny(nn, w) >> TILE_SHIFT) * body.tilesX + ((nn % w) >> TILE_SHIFT)] = 1;
        }
      }
    }
  }
  // Phase 2: apply to the active tiles and any tile that received matter; harvest converted lattice.
  let nb = 0;
  for (let t = 0; t < nt; t++) if (next[t] !== 0 || (act[t]! & ACT_INFECT) !== 0) list[nb++] = t;
  for (let a = 0; a < nb; a++) {
    const t = list[a]!;
    const tx = t % body.tilesX;
    const ty2 = (t / body.tilesX) | 0;
    const x0 = tx << TILE_SHIFT;
    const y0 = ty2 << TILE_SHIFT;
    const x1 = Math.min(w, x0 + TILE);
    const y1 = Math.min(h, y0 + TILE);
    let changed = false;
    let live = false;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        if (mat[i] === 0) {
          aux[i] = 0;
          continue;
        }
        const add = aux[i]!;
        if (add !== 0) {
          aux[i] = 0;
          const nv = Math.min(255, inf[i]! + add);
          if ((nv | 0) !== (inf[i]! | 0)) changed = true;
          inf[i] = nv;
        }
        const v = inf[i]!;
        if (v >= CONVERT_AT && (flags[i]! & F_ASSIM) === 0 && (flags[i]! & F_BURN) === 0) {
          convert(body, i);
          changed = true;
        }
        if (v >= SPREAD_MIN && v < 254) live = true;
        // Harvest: converted lattice on the outline is torn out toward the Nexus.
        if (harvesting && (flags[i]! & F_ASSIM) !== 0 && (flags[i]! & F_SURF) !== 0) {
          if ((hashI(i, tick, seed ^ 0x77) & 1023) / 1023 < body.harvest * 0.03) {
            tearToStream(
              core,
              body,
              i,
              body.harvestX,
              body.harvestY,
              body.harvestFrom,
              640,
              body.rampIds[mat[i]! * 5 + RAMP_INFECT]!,
              true,
            );
            body.connDirty = Math.max(body.connDirty, CONN_STEADY);
            changed = true;
          }
        }
      }
    }
    if (changed && ((t + tick) & 1) === 0) body.touch(x0, y0, x1 - 1, y1 - 1);
    if (live) next[t] = 1;
  }
  // Recompute activity: keep the bit only where spreading can continue.
  for (let t = 0; t < nt; t++) act[t] = (act[t]! & ~ACT_INFECT) | (next[t] !== 0 ? ACT_INFECT : 0);
}

const ny = (i: number, w: number): number => (i / w) | 0;
