import type { Body } from './body';
import type { Chunk } from './chunks';
import type { WorldCore } from './core';
import { killCell } from './cells';
import { PK } from './particles';
import { lerpPx } from './util';
import { GLOW_START } from './visual';

/** Ramp kinds stored per material in Body.rampIds (index m*4 + kind). */
export const RAMP_DUST = 0;
export const RAMP_SHARD = 1;
export const RAMP_EMBER = 2;
export const RAMP_GAS = 3;
export const RAMP_INFECT = 4;

/** Why a cell is being turned into debris: decides which particles it becomes. */
export const MODE_MECH = 0;
export const MODE_BURN = 1;
export const MODE_VAPOR = 2;

/** Intern the per-material particle ramps (bright -> dark over a particle's life). Called once per body. */
export function buildRamps(core: WorldCore, body: Body): void {
  const P = core.particles;
  for (let m = 1; m < body.materials.length; m++) {
    const md = body.materials[m]!;
    const r = md.ramp;
    const L = r[r.length - 1]!;
    const M = r[r.length >> 1]!;
    const D = r[0]!;
    body.rampIds[m * 5 + RAMP_DUST] = P.internRamp([lerpPx(L, M, 110), M, lerpPx(M, D, 150)]);
    body.rampIds[m * 5 + RAMP_SHARD] = P.internRamp([lerpPx(L, 0xffffffff, 170), L, M, D]);
    const g = md.glowRamp;
    const ember: number[] = [];
    for (let k = g.length - 1; k >= 0 && ember.length < 7; k--) ember.push(g[k]!);
    body.rampIds[m * 5 + RAMP_EMBER] = P.internRamp(ember);
    body.rampIds[m * 5 + RAMP_GAS] = P.internRamp([lerpPx(M, L, 90), M, lerpPx(M, D, 100)]);
    body.rampIds[m * 5 + RAMP_INFECT] = P.internRamp([
      lerpPx(md.infect, 0xffffffff, 150),
      md.infect,
      lerpPx(md.infect, D, 140),
    ]);
  }
}

/* --------------------------------------------------------------------------------------------- *
 *  Mass-conserving particle spray: removed cells accumulate mass; a particle is spawned with some
 *  probability carrying everything accumulated so far, so big craters do not flood the pool.
 * --------------------------------------------------------------------------------------------- */

// [lifeMin, lifeSpan, sizeMin, sizeSpan, emissive, drag, jitter px/s]
const PART: Record<number, readonly number[]> = {
  [PK.dust]: [36, 60, 1, 1, 0, 1.3, 26],
  [PK.shard]: [26, 44, 1, 1, 40, 0.7, 34],
  [PK.ember]: [40, 90, 1, 2, 210, 0.6, 30],
  [PK.gas]: [60, 90, 2, 2, 0, 1.7, 16],
  [PK.ash]: [70, 130, 1, 1, 0, 1.4, 12],
  [PK.mote]: [50, 70, 2, 1, 0, 0.45, 22],
  [PK.spark]: [14, 26, 1, 1, 255, 0.4, 90],
  [PK.plasma]: [30, 50, 2, 2, 230, 0.8, 30],
};

export function spawnMassParticle(
  core: WorldCore,
  kind: number,
  rampId: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  mass: number,
): number {
  const p = PART[kind]!;
  const rng = core.rng;
  const a = rng.next() * Math.PI * 2;
  const j = rng.next() * p[6]!;
  return core.particles.spawn(
    core,
    kind,
    x,
    y,
    vx + Math.cos(a) * j,
    vy + Math.sin(a) * j,
    p[0]! + rng.next() * p[1]!,
    p[2]! + Math.floor(rng.next() * (p[3]! + 0.999)),
    p[4]!,
    rampId,
    1,
    p[5]!,
    mass,
  );
}

/** Flush the pending spray mass as one particle at the last recorded position. */
export function endSpray(core: WorldCore): void {
  if (core.sprayMass > 0) {
    spawnMassParticle(
      core,
      core.sprayKind,
      core.sprayRamp,
      core.sprayX,
      core.sprayY,
      core.sprayVx,
      core.sprayVy,
      core.sprayMass,
    );
    core.sprayMass = 0;
  }
}

/**
 * A cell of material `m` was destroyed at world (x, y) with velocity (vx, vy) and carried `mass`. Emit debris according
 * to the material's debris kind and the destruction `mode`. Mass is conserved (into particles, or dissipated).
 */
export function sprayCell(
  core: WorldCore,
  body: Body,
  m: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  mass: number,
  mode: number,
): void {
  const md = body.materials[m]!;
  const rng = core.rng;
  let kind: number;
  let rk: number;
  let prob: number;
  if (mode === MODE_BURN) {
    if (md.debris === 'none') {
      core.ledger.dissipated += mass;
      return;
    }
    if (rng.next() < 0.62) {
      kind = PK.ember;
      rk = RAMP_EMBER;
      prob = 0.4;
    } else {
      kind = PK.ash;
      rk = RAMP_DUST;
      prob = 0.4;
    }
  } else if (mode === MODE_VAPOR) {
    if (md.debris === 'none') {
      core.ledger.dissipated += mass;
      return;
    }
    kind = rng.next() < 0.14 ? PK.spark : PK.gas;
    rk = kind === PK.spark ? RAMP_EMBER : RAMP_GAS;
    prob = 0.34;
  } else {
    switch (md.debris) {
      case 'none':
        core.ledger.dissipated += mass;
        return;
      case 'shard':
        kind = PK.shard;
        rk = RAMP_SHARD;
        prob = 0.5;
        break;
      case 'ember':
        kind = PK.ember;
        rk = RAMP_EMBER;
        prob = 0.4;
        break;
      case 'gas':
        kind = PK.gas;
        rk = RAMP_GAS;
        prob = 0.3;
        break;
      case 'liquid':
        kind = PK.mote;
        rk = RAMP_GAS;
        prob = 0.4;
        break;
      case 'dust':
      case 'chunk':
      default:
        kind = PK.dust;
        rk = RAMP_DUST;
        prob = md.debris === 'chunk' ? 0.28 : 0.4;
        break;
    }
  }
  core.sprayMass += mass;
  core.sprayX = x;
  core.sprayY = y;
  core.sprayVx = vx;
  core.sprayVy = vy;
  core.sprayKind = kind;
  core.sprayRamp = body.rampIds[m * 5 + rk]!;
  if (mode === MODE_VAPOR && kind === PK.gas) core.sprayRamp = hotGasRamp(core);
  if (rng.next() < prob) {
    spawnMassParticle(core, kind, core.sprayRamp, x, y, vx, vy, core.sprayMass);
    core.sprayMass = 0;
  }
}

/* --------------------------------------------------------------------------------------------- *
 *  Chunk extraction
 * --------------------------------------------------------------------------------------------- */

/**
 * Turn `n` live cells (indices in `cells`, all distinct) into ONE rigid chunk: copies the displayed pixels into a
 * world-orientation sprite (mirroring + row shear applied so it appears exactly where the cells were), removes the cells
 * from the body and hands the mass to the chunk pool. Returns null when nothing could be extracted.
 */
export function extractChunk(
  core: WorldCore,
  body: Body,
  cells: Int32Array,
  n: number,
  vx: number,
  vy: number,
  spin: number,
  massScale = 1,
): Chunk | null {
  if (n <= 0) return null;
  const map = body.map;
  const t = body.transform;
  const w = body.w;
  const X = Math.round(t.x);
  const Y = Math.round(t.y);
  const f = t.facing;
  let minWX = 1 << 20;
  let minWY = 1 << 20;
  let maxWX = -(1 << 20);
  let maxWY = -(1 << 20);
  let lx0 = 1 << 20;
  let ly0 = 1 << 20;
  let lx1 = -1;
  let ly1 = -1;
  for (let k = 0; k < n; k++) {
    const c = cells[k]!;
    const i = c % w;
    const j = (c - i) / w;
    const wx = (f === 1 ? X + (i - t.anchorX) : X - (i - t.anchorX) - 1) + body.rowShift(j);
    const wy = Y + (j - t.anchorY);
    if (wx < minWX) minWX = wx;
    if (wx > maxWX) maxWX = wx;
    if (wy < minWY) minWY = wy;
    if (wy > maxWY) maxWY = wy;
    if (i < lx0) lx0 = i;
    if (i > lx1) lx1 = i;
    if (j < ly0) ly0 = j;
    if (j > ly1) ly1 = j;
  }
  const sw = maxWX - minWX + 1;
  const sh = maxWY - minWY + 1;
  const pix = new Uint32Array(sw * sh);
  let emi: Uint8Array | null = null;
  let mass = 0;
  let sx = 0;
  let sy = 0;
  let brit = 0;
  let heatSum = 0;
  let heatN = 0;
  for (let k = 0; k < n; k++) {
    const c = cells[k]!;
    const i = c % w;
    const j = (c - i) / w;
    const wx = (f === 1 ? X + (i - t.anchorX) : X - (i - t.anchorX) - 1) + body.rowShift(j);
    const wy = Y + (j - t.anchorY);
    const o = (wy - minWY) * sw + (wx - minWX);
    let col = map.pixels[c]!;
    if (col >>> 24 === 0) col = (map.baseColor[c]! | 0xff000000) >>> 0;
    pix[o] = col;
    const e = map.emissive[c]!;
    if (e > 0) {
      if (emi === null) emi = new Uint8Array(sw * sh);
      emi[o] = e;
    }
    const cm = body.cellMass(c);
    mass += cm;
    sx += (wx - minWX + 0.5) * cm;
    sy += (wy - minWY + 0.5) * cm;
    brit += body.materials[map.material[c]!]!.brittleness;
    const T = map.temperature[c]!;
    if (T > GLOW_START) {
      heatSum += T;
      heatN++;
    }
  }
  if (mass <= 0) mass = 1e-6;
  sx /= mass;
  sy /= mass;
  mass *= massScale;
  // Remove the cells (mass now belongs to the chunk).
  for (let k = 0; k < n; k++) killCell(body, cells[k]!);
  body.touch(lx0, ly0, lx1, ly1);
  const heat = heatN > 0 ? Math.min(255, (heatSum / heatN) * 0.28) : 0;
  const ch = core.chunks.add(
    core,
    pix,
    emi,
    sw,
    sh,
    sx,
    sy,
    minWX + sx,
    minWY + sy,
    vx,
    vy,
    spin,
    mass,
    body.id,
    brit / n,
    heat,
  );
  ch.grace = 30;
  return ch;
}

/* --------------------------------------------------------------------------------------------- *
 *  Launch velocity for detached matter
 * --------------------------------------------------------------------------------------------- */

export interface Launch {
  vx: number;
  vy: number;
  spin: number;
}

/**
 * Velocity for a piece of body `body` (mass `mass`, centre of mass at world (cx, cy), radius `rad`) that just came loose.
 * If a blow hit the body in the last few ticks the piece inherits its impulse (directional pushes have the inward part
 * removed so slabs slide off rather than into their old body; radial blows scatter from the contact). Otherwise the piece
 * just drifts away from the body core (elastic release).
 */
export function detachVelocity(
  core: WorldCore,
  body: Body,
  cx: number,
  cy: number,
  mass: number,
  rad: number,
  out: Launch,
): void {
  const t = body.transform;
  const rng = core.rng;
  let nx = cx - t.x;
  let ny = cy - t.y;
  let nl = Math.sqrt(nx * nx + ny * ny);
  if (nl < 1e-3) {
    nx = 0;
    ny = -1;
    nl = 1;
  }
  nx /= nl;
  ny /= nl;
  const blow = body.blow;
  const age = core.tick - blow.tick;
  let dx = nx;
  let dy = ny;
  let speed = 16 + rng.next() * 26;
  let contactX = t.x;
  let contactY = t.y;
  if (age >= 0 && age <= 14 && blow.energy > 0) {
    const fresh = 1 - age / 16;
    const dOut = blow.dirX * nx + blow.dirY * ny;
    const vdx = blow.dirX - Math.min(0, dOut) * nx;
    const vdy = blow.dirY - Math.min(0, dOut) * ny;
    let rx = cx - blow.x;
    let ry = cy - blow.y;
    const rl = Math.sqrt(rx * rx + ry * ry) + 1e-6;
    rx /= rl;
    ry /= rl;
    const mix = blow.radial;
    let ux = (1 - mix) * vdx + mix * (rx * 0.85 + nx * 0.45);
    let uy = (1 - mix) * vdy + mix * (ry * 0.85 + ny * 0.45);
    const ul = Math.sqrt(ux * ux + uy * uy);
    if (ul > 1e-4) {
      ux /= ul;
      uy /= ul;
      dx = ux;
      dy = uy;
      const sm = Math.pow(Math.max(0.3, blow.sourceMass) / 5, 0.25);
      speed =
        190 * Math.sqrt(blow.energy / (mass + 25)) * sm * (0.55 + 0.45 * fresh) * (0.85 + rng.next() * 0.3);
      speed = Math.max(24, Math.min(430, speed));
      contactX = blow.x;
      contactY = blow.y;
    }
  }
  out.vx = dx * speed + body.vx * 0.5;
  out.vy = dy * speed + body.vy * 0.5;
  // Spin from the lever arm of the push about the piece's centre of mass, plus a little jitter.
  const lx = cx - contactX;
  const ly = cy - contactY;
  const cross = lx * dy - ly * dx;
  const arm = Math.sqrt(lx * lx + ly * ly) + 1;
  const s = (((cross / arm) * speed) / (rad + 5)) * 0.55 + rng.gauss() * 0.7;
  out.spin = Math.max(-9, Math.min(9, s));
}

const HOT_GAS = [0xffc8f0ff, 0xff3c96ff, 0xff28508c, 0xff3c3c46];
const hotGasIds = new WeakMap<object, number>();
/** Shared warm steam/smoke ramp for vaporised matter (white-orange, ember red, then soot grey). */
function hotGasRamp(core: WorldCore): number {
  let id = hotGasIds.get(core.particles);
  if (id === undefined) {
    id = core.particles.internRamp(HOT_GAS);
    hotGasIds.set(core.particles, id);
  }
  return id;
}
