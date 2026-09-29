import { CellFlag, Rng, type DamageEvent, type DamageType, type GrowSpec } from '@/contracts';
import type { Body, WorldPoint } from './body';
import { refreshSurfaceRect } from './cells';
import type { WorldCore } from './core';
import { MODE_BURN, MODE_MECH, MODE_VAPOR, endSpray, sprayCell } from './debris';
import { killCell } from './cells';
import { cohesionBondScale } from './bodyinit';
import { lerpPx, noise2, hash2 } from './util';
import type { MatterWorldEx } from './world';

const pt: WorldPoint = { x: 0, y: 0 };
const F_CRACK = CellFlag.CRACKED;
const F_CHAR = CellFlag.CHARRED;
const F_SURF = CellFlag.SURFACE;

/** Σ mass of live cells (scan). */
export function cellMassOf(body: Body): number {
  const mat = body.map.material;
  const den = body.map.density;
  const md = body.matDensity;
  let m = 0;
  for (let i = 0; i < body.n; i++) {
    const k = mat[i]!;
    if (k !== 0) m += (md[k]! * den[i]!) / 128;
  }
  return m;
}

/** Clear every transient process on a body (fronts, fuses, harvest, blow) and its per-cell transient state. */
function clearTransients(body: Body): void {
  body.frontCount = 0;
  body.fuseCount = 0;
  body.harvest = 0;
  body.harvestUntil = -1;
  body.harvestFrom = -1;
  body.blow.tick = -1000;
  body.blow.energy = 0;
  body.tileAct.fill(0);
}

function finishRebuild(body: Body): void {
  refreshSurfaceRect(body, 0, 0, body.w - 1, body.h - 1);
  body.regionDirty.fill(1);
  body.tileVis.fill(1);
  body.visDirty = true;
  body.visAll = true;
  body.statsDirty = true;
  body.connDirty = 2;
  body.lastConnTick = -100;
}

/** Reset a body to pristine. Matter re-created from the snapshot is accounted as injected. */
export function restore(core: WorldCore, body: Body): void {
  const map = body.map;
  const s = body.snap;
  const before = cellMassOf(body);
  map.material.set(s.material);
  map.density.set(s.density);
  map.bondR.set(s.bondR);
  map.bondD.set(s.bondD);
  map.height.set(s.height);
  map.baseColor.set(s.baseColor);
  map.flags.set(s.flags);
  map.temperature.fill(0);
  map.infection.fill(0);
  map.detached.fill(0);
  map.emissive.fill(0);
  for (let i = 0; i < body.n; i++) map.integrity[i] = s.material[i] !== 0 ? 255 : 0;
  const after = cellMassOf(body);
  if (after > before) core.ledger.injected += after - before;
  else core.ledger.deleted += before - after;
  core.ledger.deleted += body.pool;
  body.pool = 0;
  body.massGained = 0;
  body.massLost = 0;
  clearTransients(body);
  finishRebuild(body);
}

/**
 * Between rounds: restore `fraction` of the MISSING matter as SCARS. Lost cells regrow from the surviving edge outward
 * (ragged front), coming back with reduced integrity, some cracked and charred and with partly severed bonds; damaged
 * cells recover part of their integrity; infection, fire and shrapnel are cleared. Deterministic given `seed`.
 */
export function heal(core: WorldCore, body: Body, fraction: number, seed: number): void {
  const map = body.map;
  const s = body.snap;
  const { w, h, n } = body;
  const rng = new Rng(seed ^ body.seed ^ 0x2545f491);
  const f = Math.max(0, Math.min(1, fraction));
  const before = cellMassOf(body);

  // 1. Missing pristine cells and their BFS distance from live matter through missing cells.
  const mat = map.material;
  const dist = new Int16Array(n).fill(-1);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  let missing = 0;
  for (let i = 0; i < n; i++) {
    if (s.material[i] !== 0 && mat[i] === 0) missing++;
  }
  for (let i = 0; i < n; i++) {
    if (mat[i] === 0) continue;
    // live cell: seed neighbours
    const x = i % w;
    const y = (i - x) / w;
    const tryN = (j: number): void => {
      if (s.material[j] !== 0 && mat[j] === 0 && dist[j] === -1) {
        dist[j] = 1;
        queue[qt++] = j;
      }
    };
    if (x > 0) tryN(i - 1);
    if (x < w - 1) tryN(i + 1);
    if (y > 0) tryN(i - w);
    if (y < h - 1) tryN(i + w);
  }
  while (qh < qt) {
    const c = queue[qh++]!;
    const x = c % w;
    const y = (c - x) / w;
    const d = dist[c]! + 1;
    const tryN = (j: number): void => {
      if (s.material[j] !== 0 && mat[j] === 0 && dist[j] === -1) {
        dist[j] = d;
        queue[qt++] = j;
      }
    };
    if (x > 0) tryN(c - 1);
    if (x < w - 1) tryN(c + 1);
    if (y > 0) tryN(c - w);
    if (y < h - 1) tryN(c + w);
  }
  const target = Math.round(f * missing);
  if (target > 0) {
    // 2. Priority = BFS distance + noise (ragged front); order ascending via packed float sort.
    const keys = new Float64Array(qt);
    for (let k = 0; k < qt; k++) {
      const c = queue[k]!;
      const pr = dist[c]! + rng.next() * 3.2 + noise2(c % w, (c / w) | 0, seed) * 2.5;
      keys[k] = Math.floor(pr * 32) * 65536 + c;
    }
    keys.sort();
    const count = Math.min(target, qt);
    for (let k = 0; k < count; k++) {
      const c = keys[k]! % 65536;
      const x = c % w;
      const y = (c - x) / w;
      mat[c] = s.material[c]!;
      map.density[c] = s.density[c]!;
      map.height[c] = s.height[c]!;
      map.baseColor[c] = s.baseColor[c]!;
      map.temperature[c] = 0;
      map.infection[c] = 0;
      // Scar: weaker, sometimes cracked/charred; the ragged front (early ones = older scar) is weaker still.
      const edgeness = 1 - k / Math.max(1, count);
      map.integrity[c] = Math.max(40, Math.round(105 + rng.next() * 65 - edgeness * 20));
      let fl = 0;
      if (rng.next() < 0.28) fl |= F_CRACK;
      if (rng.next() < 0.2) fl |= F_CHAR;
      map.flags[c] = fl;
      // Bonds to live neighbours: the snapshot bond scaled down, some left severed (visible scar cracks).
      const scar = 0.5 + 0.15 * rng.next();
      if (x < w - 1 && mat[c + 1] !== 0) map.bondR[c] = rng.next() < 0.14 ? 0 : Math.max(1, Math.round(s.bondR[c]! * scar));
      if (x > 0 && mat[c - 1] !== 0) map.bondR[c - 1] = rng.next() < 0.14 ? 0 : Math.max(1, Math.round(s.bondR[c - 1]! * scar));
      if (y < h - 1 && mat[c + w] !== 0) map.bondD[c] = rng.next() < 0.14 ? 0 : Math.max(1, Math.round(s.bondD[c]! * scar));
      if (y > 0 && mat[c - w] !== 0) map.bondD[c - w] = rng.next() < 0.14 ? 0 : Math.max(1, Math.round(s.bondD[c - w]! * scar));
    }
  }
  // 3. Existing damage recovers partially; transient processes end.
  for (let i = 0; i < n; i++) {
    if (mat[i] === 0) continue;
    const ig = map.integrity[i]!;
    if (ig < 255) map.integrity[i] = Math.min(255, Math.round(ig + (255 - ig) * f * 0.7));
    map.infection[i] = 0;
    map.temperature[i] = 0;
    // Compressed cells relax toward nominal density.
    const d = map.density[i]!;
    const sd = s.density[i]!;
    if (sd !== 0 && d !== sd) map.density[i] = Math.round(d + (sd - d) * f);
    map.flags[i] = map.flags[i]! & ~(CellFlag.BURNING | CellFlag.ASSIMILATED | CellFlag.SHRAPNEL | CellFlag.GLOWING);
    // Severed bonds between live cells recover with probability ~ fraction (as scars).
    const x = i % w;
    if (x < w - 1 && mat[i + 1] !== 0 && map.bondR[i] === 0 && s.bondR[i] !== 0 && rng.next() < f * 0.6) map.bondR[i] = Math.max(1, Math.round(s.bondR[i]! * 0.6));
    if (i + w < n && mat[i + w] !== 0 && map.bondD[i] === 0 && s.bondD[i] !== 0 && rng.next() < f * 0.6) map.bondD[i] = Math.max(1, Math.round(s.bondD[i]! * 0.6));
  }
  const after = cellMassOf(body);
  if (after > before) core.ledger.injected += after - before;
  else core.ledger.deleted += before - after;
  clearTransients(body);
  finishRebuild(body);
}

/** Add `spec.cells` cells of `materialKey` outward from existing matter toward (nearX, nearY). Mass comes from the pool first. */
export function grow(core: WorldCore, body: Body, spec: GrowSpec): number {
  const mats = body.materials;
  let mid = -1;
  for (let i = 1; i < mats.length; i++) if (mats[i]!.key === spec.materialKey) mid = i;
  if (mid < 0 || spec.cells <= 0) return 0;
  const map = body.map;
  const { w, h } = body;
  const mat = map.material;
  const md = mats[mid]!;
  let tx: number;
  let ty: number;
  if (spec.nearX !== undefined && spec.nearY !== undefined) {
    body.worldToLocalF(spec.nearX, spec.nearY, pt);
    tx = pt.x;
    ty = pt.y;
  } else {
    tx = map.coreX + 0.5;
    ty = map.coreY + 0.5;
  }
  const coh = cohesionBondScale(body.attributes.cohesion);
  const seed = body.seed;
  let added = 0;
  let addedMass = 0;
  let passes = 0;
  const frontier = new Float64Array(body.n);
  while (added < spec.cells && passes++ < 60) {
    let fn = 0;
    for (let i = 0; i < body.n; i++) {
      if (mat[i] !== 0) continue;
      const x = i % w;
      const y = (i - x) / w;
      const adj = (x > 0 && mat[i - 1] !== 0) || (x < w - 1 && mat[i + 1] !== 0) || (y > 0 && mat[i - w] !== 0) || (y < h - 1 && mat[i + w] !== 0);
      if (!adj) continue;
      const dx = x + 0.5 - tx;
      const dy = y + 0.5 - ty;
      const score = dx * dx + dy * dy + noise2(x, y, seed + added) * 30;
      frontier[fn++] = Math.floor(score * 4) * 65536 + i;
    }
    if (fn === 0) break;
    const sub = frontier.subarray(0, fn);
    sub.sort();
    const take = Math.min(spec.cells - added, Math.max(1, Math.ceil(fn / 3)));
    for (let k = 0; k < take; k++) {
      const c = sub[k]! % 65536;
      const x = c % w;
      const y = (c - x) / w;
      if (mat[c] !== 0) continue;
      mat[c] = mid;
      map.density[c] = 128;
      map.integrity[c] = 255;
      map.temperature[c] = 0;
      map.infection[c] = 0;
      map.flags[c] = 0;
      // Height: mean of live neighbours, so the re-light reads plausibly.
      let hs = 0;
      let hn = 0;
      if (x > 0 && mat[c - 1] !== 0) {
        hs += map.height[c - 1]!;
        hn++;
      }
      if (x < w - 1 && mat[c + 1] !== 0) {
        hs += map.height[c + 1]!;
        hn++;
      }
      if (y > 0 && mat[c - w] !== 0) {
        hs += map.height[c - w]!;
        hn++;
      }
      if (y < h - 1 && mat[c + w] !== 0) {
        hs += map.height[c + w]!;
        hn++;
      }
      map.height[c] = hn > 0 ? Math.round(hs / hn) : 128;
      // Colour: a noisy pick along the material ramp.
      const r = md.ramp;
      const u = noise2(x, y, seed ^ 0x9d) * 0.6 + (map.height[c]! / 255) * 0.4;
      const ri = Math.min(r.length - 1, Math.floor(u * r.length));
      map.baseColor[c] = lerpPx(r[ri]!, r[Math.min(r.length - 1, ri + 1)]!, (hash2(x, y, seed) & 1) * 96);
      const bondBase = md.bond * coh;
      if (x > 0 && mat[c - 1] !== 0) map.bondR[c - 1] = clampB(Math.min(bondBase, mats[mat[c - 1]!]!.bond * coh) * (0.85 + 0.3 * noise2(c, 1, seed)));
      if (x < w - 1 && mat[c + 1] !== 0) map.bondR[c] = clampB(Math.min(bondBase, mats[mat[c + 1]!]!.bond * coh) * (0.85 + 0.3 * noise2(c, 2, seed)));
      if (y > 0 && mat[c - w] !== 0) map.bondD[c - w] = clampB(Math.min(bondBase, mats[mat[c - w]!]!.bond * coh) * (0.85 + 0.3 * noise2(c, 3, seed)));
      if (y < h - 1 && mat[c + w] !== 0) map.bondD[c] = clampB(Math.min(bondBase, mats[mat[c + w]!]!.bond * coh) * (0.85 + 0.3 * noise2(c, 4, seed)));
      added++;
      addedMass += body.cellMass(c);
    }
  }
  if (added > 0) {
    const fromPool = Math.min(body.pool, addedMass);
    body.pool -= fromPool;
    core.ledger.injected += addedMass - fromPool;
    finishRebuild(body);
    body.connDirty = 0;
  }
  return added;
}

const clampB = (v: number): number => Math.max(1, Math.min(255, Math.round(v)));

/**
 * Debit `mass` from the body without producing matter: surface cells (core last) are burnt, blown or evaporated away as
 * pure VFX (the mass leaves the ledger as dissipated). Returns the number of cells removed.
 */
export function shed(core: WorldCore, body: Body, mass: number, style: 'burn' | 'blow' | 'evaporate'): number {
  const map = body.map;
  const { w, h } = body;
  const mat = map.material;
  const rng = body.rng;
  let removedMass = 0;
  let cells = 0;
  const coreR2 = (map.coreRadius + 1) * (map.coreRadius + 1);
  const list = new Int32Array(body.n);
  const mode = style === 'burn' ? MODE_BURN : style === 'evaporate' ? MODE_VAPOR : MODE_MECH;
  for (let pass = 0; pass < 40 && removedMass < mass; pass++) {
    let ln = 0;
    for (let i = 0; i < body.n; i++) {
      if (mat[i] === 0 || (map.flags[i]! & F_SURF) === 0) continue;
      const x = i % w;
      const y = (i - x) / w;
      const dx = x - map.coreX;
      const dy = y - map.coreY;
      if (dx * dx + dy * dy <= coreR2) continue;
      list[ln++] = i;
    }
    if (ln === 0) break;
    // Random order within the pass (partial Fisher-Yates driven by the body RNG).
    for (let k = ln - 1; k > 0; k--) {
      const j = rng.int(k + 1);
      const t = list[k]!;
      list[k] = list[j]!;
      list[j] = t;
    }
    for (let k = 0; k < ln && removedMass < mass; k++) {
      const i = list[k]!;
      const x = i % w;
      const y = (i - x) / w;
      const m = mat[i]!;
      body.cellWorld(x, y, pt);
      let ox = pt.x - body.transform.x;
      let oy = pt.y - body.transform.y;
      const ol = Math.sqrt(ox * ox + oy * oy) + 1e-6;
      ox /= ol;
      oy /= ol;
      const sp = style === 'blow' ? 70 + rng.next() * 90 : 18 + rng.next() * 30;
      const cm = killCell(body, i);
      core.ledger.dissipated += cm;
      removedMass += cm;
      cells++;
      sprayCell(core, body, m, pt.x, pt.y, ox * sp, oy * sp, 0, mode);
    }
    void h;
  }
  endSpray(core);
  if (cells > 0) {
    body.touch(0, 0, body.w - 1, body.h - 1);
    body.connDirty = 2;
  }
  return cells;
}

/**
 * Harness: carve a body down to `massFrac` of its initial mass with a deterministic sequence of realistic damage:
 * blows from outside toward the core, the damage type chosen from the material at each site, sites biased outward so
 * the core is left for last. Debris is flung, fissures propagate, fires burn for a moment (the world is stepped briefly so
 * the scars are believable rather than a bare silhouette).
 */
export function carve(world: MatterWorldEx, body: Body, massFrac: number, seed: number): void {
  const rng = new Rng(seed ^ body.seed ^ 0x6a09e667);
  const map = body.map;
  const w = body.w;
  const target = massFrac * map.initialMass;
  const mats = body.materials;
  const t = body.transform;
  const coreW: WorldPoint = { x: 0, y: 0 };
  body.cellWorld(map.coreX, map.coreY, coreW);
  let stall = 0;
  let lastMass = cellMassOf(body);
  const guardCoreR = map.coreRadius * (massFrac > 0.15 ? 2.2 : 1.2);
  for (let iter = 0; iter < 90 && lastMass > target * 1.03 && stall < 8; iter++) {
    // Choose a site: sample surface cells, prefer those far from the core.
    let best = -1;
    let bestScore = -Infinity;
    for (let s = 0; s < 40; s++) {
      const i = rng.int(body.n);
      if (map.material[i] === 0 || (map.flags[i]! & F_SURF) === 0) continue;
      const x = i % w;
      const y = (i - x) / w;
      const dx = x - map.coreX;
      const dy = y - map.coreY;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < guardCoreR) continue;
      const score = d * (0.75 + 0.5 * rng.next());
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) {
      stall++;
      continue;
    }
    const x = best % w;
    const y = (best - x) / w;
    body.cellWorld(x, y, pt);
    const md = mats[map.material[best]!]!;
    // Direction: from outside toward the core.
    let dx = coreW.x - pt.x;
    let dy = coreW.y - pt.y;
    const dl = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= dl;
    dy /= dl;
    let type: DamageType;
    const r = rng.next();
    if (md.brittleness > 0.7) type = r < 0.5 ? 'FRACTURE' : r < 0.8 ? 'KINETIC' : 'CRUSH';
    else if (md.ignition > 0) type = r < 0.35 ? 'THERMAL' : r < 0.65 ? 'FRACTURE' : 'KINETIC';
    else type = r < 0.4 ? 'KINETIC' : r < 0.7 ? 'FRACTURE' : 'CRUSH';
    const remaining = lastMass - target;
    const energy = Math.max(60, Math.min(900, remaining * 0.32)) * (0.7 + 0.5 * rng.next());
    const rad = Math.max(4, Math.min(16, Math.sqrt(energy) * 0.55));
    const ev: DamageEvent = {
      type,
      shape: { kind: 'point', x: pt.x - dx * rad * 0.35, y: pt.y - dy * rad * 0.35, r: rad },
      energy,
      dirX: dx,
      dirY: dy,
      duration: 1,
      sourceMass: 5,
      sourceBodyId: -1,
      originX: pt.x - dx * 30,
      originY: pt.y - dy * 30,
      flags: type === 'FRACTURE' && rng.next() < 0.35 ? 2 : 0,
      params: type === 'THERMAL' ? { heat: undefined, shock: 0 } : {},
    };
    world.applyDamage(body.id, ev);
    world.settleBody(body.id);
    const m = cellMassOf(body);
    stall = m >= lastMass - 1e-6 ? stall + 1 : 0;
    lastMass = m;
    // Let cracks creep / detach a little between blows.
    for (let k = 0; k < 6; k++) world.tick();
  }
  // Settle: fissures finish, chunks drift apart.
  for (let k = 0; k < 40; k++) world.tick();
  void t;
}
