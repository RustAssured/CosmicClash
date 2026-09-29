import { CellFlag, MAX_BODY_DIM, type DamageResult } from '@/contracts';
import { ACT_HEAT, CONN_SOFT, CONN_STEADY, TILE, TILE_SHIFT, type Body, type WorldPoint } from './body';
import { killCell } from './cells';
import type { WorldCore } from './core';
import { MODE_BURN, MODE_VAPOR, RAMP_EMBER, sprayCell, spawnMassParticle } from './debris';
import { DF, T_THERMAL, coverageOf, finishDamage, recordBlow, resistOf, type DamageCtx } from './dmg';
import { PK } from './particles';
import { hash2, hashI } from './util';
import { GLOW_START } from './visual';
import { spawnBlast } from './blast';

/** Temperature units gained by a heatCapacity-1 cell per unit of energy: 1 energy takes a baseline rock cell (vaporize 1900) to vaporisation. */
export const HEAT_PER_ENERGY = 1900;
/** Self-heating of a burning cell per tick, as a fraction of its ignition temperature (fire is exothermic: it sustains and spreads). */
export const tuning = { burnHeat: 0.2 };
const COOL_BULK = 0.0035;
const COOL_SURF = 0.012;
const F_BURN = CellFlag.BURNING;
const F_CHAR = CellFlag.CHARRED;
const F_ASSIM = CellFlag.ASSIMILATED;
const F_SURF = CellFlag.SURFACE;
const F_GLOW = CellFlag.GLOWING;

const pt: WorldPoint = { x: 0, y: 0 };
const trans = new Float32Array(MAX_BODY_DIM + 2);
/** Share of a blow's energy concentrated on the cells nearest its centre so it always melts a pit (the rest heats the whole shape). */
const CORE_SHARE = 0.75;
/** A concentrated blow melts at most this many cells per unit of energy (a baseline cell costs ~1; ice and other easy matter more). */
const CORE_CELLS_PER_ENERGY = 1.6;
/** No matter is harder than this many energy per cell to melt away: a sustained blow always gets through (the damage floor). */
const CORE_COST_CAP = 2.4;
const CORE_BINS = 32;
const binNeed = new Float64Array(CORE_BINS);
const binCnt = new Int32Array(CORE_BINS);
const binDose = new Float32Array(CORE_BINS);
const dTneed = new Float32Array(MAX_BODY_DIM * MAX_BODY_DIM);
let flameBudget = 0;

/** Live heat tolerance multiplier: HEAT TOLERANCE attribute x fighter-owned heatScale. 5 => 1.0. */
export const heatTol = (b: Body): number => Math.max(0.3, b.heatScale) * (0.5 + 0.1 * b.attributes.heat);

/**
 * THERMAL — heat deposition. Each covered cell gains temperature ΔT = (energy share × HEAT_PER_ENERGY / heatCapacity) ×
 * resist / heat-tolerance (or `params.heat` temperature units at full weight if given). Atmosphere/ocean layers in front
 * (along the blow) soak a fraction of the heat (`heatAbsorb`) and shield what lies behind them unless PIERCE. Infected
 * (assimilated) matter heats 1.5x: fire kills lattice. Ignition, burning fronts, char/ash and vaporisation are then
 * handled by `stepThermal` (diffusion + reactions), and `params.shock` launches a blast ring that blows loosened matter off.
 */
export function applyThermal(ctx: DamageCtx, res: DamageResult): void {
  const { core, body } = ctx;
  const map = body.map;
  const n = ctx.n;
  const idx = core.covIdx;
  const wgt = core.covW;
  const mats = body.materials;
  const tol = heatTol(body);
  const pierce = ctx.has(DF.PIERCE);
  const heatParam = ctx.params.heat;
  const w = body.w;
  // Concentrated core (energy-derived heat only): the cells nearest the centre get exactly the dose that vaporises them, in
  // descending order of shape weight, until CORE_SHARE of the energy (or the cell cap) is used. The remainder heats the whole
  // shape (ignition, glow, ablation) as before.
  let coreUsed = 0;
  binDose.fill(0);
  if (heatParam === undefined) {
    binNeed.fill(0);
    binCnt.fill(0);
    for (let k = 0; k < n; k++) {
      const i = idx[k]!;
      const md = mats[map.material[i]!]!;
      dTneed[k] = 0;
      if (md.vaporize <= 0) continue;
      const infected = map.infection[i]! > 60;
      const dTn = md.vaporize * tol * (infected ? 0.85 : 1) - map.temperature[i]!;
      if (dTn <= 0) continue;
      const r = Math.max(0.05, resistOf(body, i, T_THERMAL));
      const e = Math.min(
        CORE_COST_CAP,
        (dTn * md.heatCapacity * tol) / (HEAT_PER_ENERGY * (1 - md.heatAbsorb) * r * (infected ? 1.5 : 1)),
      );
      dTneed[k] = dTn;
      const b = Math.min(CORE_BINS - 1, Math.floor(wgt[k]! * CORE_BINS));
      binNeed[b] = binNeed[b]! + e;
      binCnt[b] = binCnt[b]! + 1;
    }
    let cum = 0;
    let cnt = 0;
    const eBudget = ctx.energy * CORE_SHARE;
    const cellCap = ctx.energy * CORE_CELLS_PER_ENERGY;
    for (let b = CORE_BINS - 1; b >= 0; b--) {
      const need = binNeed[b]!;
      if (need <= 0) continue;
      if (cum + need <= eBudget && cnt + binCnt[b]! <= cellCap) {
        binDose[b] = 1;
        cum += need;
        cnt += binCnt[b]!;
        continue;
      }
      const f = Math.max(0, Math.min((eBudget - cum) / need, (cellCap - cnt) / binCnt[b]!));
      binDose[b] = f;
      cum += f * need;
      break;
    }
    coreUsed = cum;
  }
  const perW = heatParam !== undefined ? heatParam : ((ctx.energy - coreUsed) / ctx.sumW) * HEAT_PER_ENERGY;
  const xDom = Math.abs(ctx.ldx) >= Math.abs(ctx.ldy);
  const asc = xDom ? ctx.ldx >= 0 : ctx.ldy >= 0;
  trans.fill(1);
  let minX = w;
  let minY = body.h;
  let maxX = -1;
  let maxY = -1;
  let removed = 0;
  const cover = coverageOf(ctx);
  for (let kk = 0; kk < n; kk++) {
    const k = asc ? kk : n - 1 - kk;
    const i = idx[k]!;
    const x = i % w;
    const y = (i - x) / w;
    const lane = xDom ? y : x;
    const tr = pierce ? 1 : trans[lane]!;
    const m = map.material[i]!;
    const md = mats[m]!;
    const absorb = md.heatAbsorb;
    let dT = (perW * wgt[k]! * tr * (1 - absorb) * resistOf(body, i, T_THERMAL)) / (md.heatCapacity * tol);
    if (map.infection[i]! > 60) dT *= 1.5;
    if (coreUsed > 0) {
      const dose = binDose[Math.min(CORE_BINS - 1, Math.floor(wgt[k]! * CORE_BINS))]!;
      if (dose > 0) dT += dose * dTneed[k]! * tr;
    }
    if (!pierce) trans[lane] = tr * (1 - absorb * 0.25);
    if (dT <= 0) continue;
    ctx.note(i, wgt[k]!);
    let T = map.temperature[i]! + dT;
    if (T > 30000) T = 30000;
    map.temperature[i] = T;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const vap = md.vaporize;
    if (vap > 0 && T >= vap * tol * (map.infection[i]! > 60 ? 0.85 : 1)) {
      vaporizeCell(core, body, i, ctx);
      removed++;
    }
  }
  if (maxX >= 0) {
    body.wakeRect(minX, minY, maxX, maxY, ACT_HEAT);
    body.touch(minX - 1, minY - 1, maxX + 1, maxY + 1);
  }
  if (removed > 0) body.connDirty = Math.max(body.connDirty, CONN_STEADY);
  const shock = ctx.params.shock ?? 0;
  if (shock > 0) {
    const cx = ctx.covCx;
    const cy = ctx.covCy;
    spawnBlast(core, body, cx, cy, Math.sqrt(core.q.area / Math.PI), shock, ctx.energy, ctx.sourceMass);
    recordBlow(ctx, 0.95);
  } else recordBlow(ctx, 0.6);
  finishDamage(ctx, res, cover, 0.6);
}

/** Remove a cell that vaporised: gas/spark plume tinted by the material. */
function vaporizeCell(core: WorldCore, body: Body, i: number, ctx: DamageCtx | null): void {
  const m = body.map.material[i]!;
  const md = body.materials[m]!;
  const x = i % body.w;
  const y = (i - x) / body.w;
  body.cellWorld(x, y, pt);
  const boil = md.debris === 'liquid' && md.heatAbsorb > 0;
  const mass = killCell(body, i);
  let ox = pt.x - body.transform.x;
  let oy = pt.y - body.transform.y;
  const ol = Math.sqrt(ox * ox + oy * oy) + 1e-6;
  ox /= ol;
  oy /= ol;
  sprayCell(core, body, m, pt.x, pt.y, ox * 40 + body.vx * 0.3, oy * 40 + body.vy * 0.3, mass, MODE_VAPOR);
  if (boil) core.emitMatter('boil', pt.x, pt.y, mass, body.ownerSlot);
  if (ctx) {
    ctx.removed++;
    ctx.massRemoved += mass;
  }
}

/** A cell burnt through: becomes its ash material (mass difference goes up as smoke/embers) or disappears as embers. */
function burnOut(core: WorldCore, body: Body, i: number): void {
  const map = body.map;
  const m = map.material[i]!;
  const md = body.materials[m]!;
  const x = i % body.w;
  const y = (i - x) / body.w;
  body.cellWorld(x, y, pt);
  if (md.ashId !== 0) {
    const before = body.cellMass(i);
    const ash = body.materials[md.ashId]!;
    map.material[i] = md.ashId;
    map.integrity[i] = 150;
    map.flags[i] = (map.flags[i]! & ~(F_BURN | F_ASSIM | F_GLOW)) | F_CHAR;
    map.infection[i] = 0;
    map.temperature[i] = map.temperature[i]! * 0.4;
    map.baseColor[i] = ash.ramp[Math.min(ash.ramp.length - 1, 1 + (hash2(x, y, body.seed) & 1))]!;
    const after = body.cellMass(i);
    // Ash bonds are weak: the burnt lattice crumbles at the next touch.
    const w = body.w;
    const cap = Math.max(1, Math.round(ash.bond * 0.6));
    if (x < w - 1 && map.bondR[i]! > cap) map.bondR[i] = cap;
    if (x > 0 && map.bondR[i - 1]! > cap) map.bondR[i - 1] = cap;
    if (map.bondD[i]! > cap) map.bondD[i] = cap;
    if (y > 0 && map.bondD[i - w]! > cap) map.bondD[i - w] = cap;
    const lost = before - after;
    if (lost > 0) sprayCell(core, body, m, pt.x, pt.y, 0, -14, lost, MODE_BURN);
    else if (lost < 0) core.ledger.injected += -lost;
    body.connDirty = Math.max(body.connDirty, 1);
    return;
  }
  const mass = killCell(body, i);
  sprayCell(core, body, m, pt.x, pt.y, (hash2(x, y, 3) & 63) - 32, -22, mass, MODE_BURN);
  body.connDirty = Math.max(body.connDirty, 1);
}

/**
 * One tick of the thermal world: explicit heat diffusion (red-black Gauss-Seidel over ACTIVE 16x16 tiles; every update is a
 * convex combination since 4k <= 1, so it can never overshoot or explode), radiative cooling, ignition, burning, char/ash
 * and vaporisation. Tiles with no heat go to sleep; hot tile borders wake their neighbours. Cost is proportional to the
 * burning area, not the body.
 */
export function stepThermal(core: WorldCore, body: Body): void {
  const nt = body.tilesX * body.tilesY;
  const act = body.tileAct;
  const list = body.tileList;
  let na = 0;
  for (let t = 0; t < nt; t++) if ((act[t]! & ACT_HEAT) !== 0) list[na++] = t;
  if (na === 0) return;
  body.tileNext.fill(0, 0, nt);
  for (let colour = 0; colour < 2; colour++) for (let a = 0; a < na; a++) diffuseTile(body, list[a]!, colour);
  flameBudget = 40;
  for (let a = 0; a < na; a++) reactTile(core, body, list[a]!);
  const next = body.tileNext;
  for (let a = 0; a < na; a++) act[list[a]!]! &= ~ACT_HEAT;
  for (let t = 0; t < nt; t++) if (next[t] !== 0) act[t] = act[t]! | ACT_HEAT;
}

function diffuseTile(body: Body, t: number, colour: number): void {
  const map = body.map;
  const w = body.w;
  const h = body.h;
  const mat = map.material;
  const temp = map.temperature;
  const cond = body.condTab;
  const tx = t % body.tilesX;
  const ty = (t / body.tilesX) | 0;
  const x0 = tx << TILE_SHIFT;
  const y0 = ty << TILE_SHIFT;
  const x1 = Math.min(w, x0 + TILE);
  const y1 = Math.min(h, y0 + TILE);
  for (let y = y0; y < y1; y++) {
    let x = x0 + ((x0 + y + colour) & 1);
    for (; x < x1; x += 2) {
      const i = y * w + x;
      const m = mat[i]!;
      if (m === 0) continue;
      const T = temp[i]!;
      const kc = cond[m]!;
      let acc = 0;
      if (x > 0) {
        const m2 = mat[i - 1]!;
        if (m2 !== 0) acc += (kc + cond[m2]!) * 0.5 * (temp[i - 1]! - T);
      }
      if (x < w - 1) {
        const m2 = mat[i + 1]!;
        if (m2 !== 0) acc += (kc + cond[m2]!) * 0.5 * (temp[i + 1]! - T);
      }
      if (y > 0) {
        const m2 = mat[i - w]!;
        if (m2 !== 0) acc += (kc + cond[m2]!) * 0.5 * (temp[i - w]! - T);
      }
      if (y < h - 1) {
        const m2 = mat[i + w]!;
        if (m2 !== 0) acc += (kc + cond[m2]!) * 0.5 * (temp[i + w]! - T);
      }
      temp[i] = T + acc;
    }
  }
}

function reactTile(core: WorldCore, body: Body, t: number): void {
  const map = body.map;
  const w = body.w;
  const h = body.h;
  const mat = map.material;
  const temp = map.temperature;
  const flags = map.flags;
  const integ = map.integrity;
  const inf = map.infection;
  const mats = body.materials;
  const tol = heatTol(body);
  const tick = core.tick;
  const seed = body.seed;
  const tx = t % body.tilesX;
  const ty = (t / body.tilesX) | 0;
  const x0 = tx << TILE_SHIFT;
  const y0 = ty << TILE_SHIFT;
  const x1 = Math.min(w, x0 + TILE);
  const y1 = Math.min(h, y0 + TILE);
  let hot = false;
  let visual = false;
  let structural = false;
  let edgeHot = false;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      const m = mat[i]!;
      if (m === 0) continue;
      let T = temp[i]!;
      if (T === 0 && (flags[i]! & F_BURN) === 0) continue;
      const md = mats[m]!;
      let fl = flags[i]!;
      // radiative cooling (surface cells shed heat faster)
      T *= (fl & F_SURF) !== 0 ? 1 - COOL_SURF : 1 - COOL_BULK;
      if (T < 0.6) T = 0;
      const ign = md.ignition * tol;
      if ((fl & F_BURN) !== 0) {
        // Burning: self-heating keeps the front alive; fuel (integrity) is consumed.
        T += md.ignition * tuning.burnHeat * tol;
        const rnd = (hashI(i, tick, seed) & 1023) / 1023;
        let dmg = md.burnRate * (0.55 + 0.9 * rnd);
        if (inf[i]! > 60) dmg *= 1.6;
        const ig = integ[i]! - dmg;
        if (ig <= 0) {
          temp[i] = T;
          burnOut(core, body, i);
          structural = true;
          continue;
        }
        integ[i] = ig < 1 ? 1 : ig;
        if (ig < 130) fl |= F_CHAR;
        if (T < ign * 0.35) fl &= ~F_BURN;
        if (inf[i]! > 0) {
          const v = inf[i]! - 6;
          inf[i] = v > 0 ? v : 0;
          if (v < 200) fl &= ~F_ASSIM;
        }
        // Flames and embers off the burning surface.
        if (flameBudget > 0 && (fl & F_SURF) !== 0 && (rnd < 0.05 || md.flammableGas)) {
          flameBudget--;
          body.cellWorld(x, y, pt);
          let ox = pt.x - body.transform.x;
          let oy = pt.y - body.transform.y;
          const ol = Math.sqrt(ox * ox + oy * oy) + 1e-6;
          ox /= ol;
          oy /= ol;
          const rid = body.rampIds[m * 5 + RAMP_EMBER]!;
          if (md.flammableGas) spawnMassParticle(core, PK.plasma, rid, pt.x, pt.y, ox * 55, oy * 55, 0);
          else spawnMassParticle(core, PK.ember, rid, pt.x, pt.y, ox * 22, oy * 22 - 6, 0);
        }
        visual = true;
      } else if (ign > 0 && T >= ign && integ[i]! > 0) {
        fl |= F_BURN;
        structural = true;
        body.cellWorld(x, y, pt);
        core.emitMatter('ignite', pt.x, pt.y, body.cellMass(i), body.ownerSlot);
        if (md.flammableGas && flameBudget > 0) {
          flameBudget--;
          spawnMassParticle(
            core,
            PK.plasma,
            body.rampIds[m * 5 + RAMP_EMBER]!,
            pt.x,
            pt.y,
            (hashI(x, y, tick) & 63) - 32,
            (hashI(y, x, tick) & 63) - 32,
            0,
          );
        }
      }
      // Vaporise outright; hot-but-not-vaporised matter ABLATES (glowing melt sheds away): sustained heat destroys rock too.
      const vap = md.vaporize;
      if (vap > 0 && (fl & F_BURN) === 0) {
        const vt = vap * tol * (inf[i]! > 60 ? 0.85 : 1);
        if (T > vt * 0.5 && T < vt) {
          const ig2 = integ[i]! - 10 * (T / vt - 0.5);
          if (ig2 <= 0) {
            temp[i] = T;
            burnOut(core, body, i);
            body.connDirty = Math.max(body.connDirty, CONN_SOFT);
            structural = true;
            continue;
          }
          integ[i] = ig2 < 1 ? 1 : ig2;
          fl |= F_CHAR;
        }
      }
      if (vap > 0 && T >= vap * tol * (inf[i]! > 60 ? 0.85 : 1)) {
        temp[i] = T;
        vaporizeCell(core, body, i, null);
        body.connDirty = Math.max(body.connDirty, 1);
        structural = true;
        continue;
      }
      temp[i] = T;
      flags[i] = fl;
      if (T > 3 || (fl & F_BURN) !== 0) {
        hot = true;
        if (T > GLOW_START * 0.4 || (fl & F_BURN) !== 0) visual = true;
        if (x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1) edgeHot = true;
      }
    }
  }
  // Glow/flicker refresh at 30 Hz (alternating tiles so the cost is spread); structural changes refresh at once.
  if (structural || (visual && ((t + tick) & 1) === 0)) body.touch(x0, y0, x1 - 1, y1 - 1);
  if (hot) {
    body.tileNext[t] = 1;
    if (edgeHot) {
      // Wake the eight neighbours so heat can cross the tile border.
      const tw = body.tilesX;
      const th = body.tilesY;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = ty + dy;
        if (yy < 0 || yy >= th) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = tx + dx;
          if (xx < 0 || xx >= tw) continue;
          body.tileNext[yy * tw + xx] = 1;
        }
      }
    }
  }
}
