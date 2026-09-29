import type { DamageResult } from '@/contracts';
import { CONN_NOW, CONN_STEADY } from './body';
import type { Body, WorldPoint } from './body';
import type { Wave, WorldCore } from './core';
import { carveCrater, type CraterOpts, type CraterOut } from './crater';
import { plantFrontToward } from './cracks';
import { edgeBond } from './cuts';
import { PK } from './particles';
import { RAMP_DUST, spawnMassParticle } from './debris';
import { T_CRUSH, coverageOf, finishDamage, localToWorldF, recordBlow, type DamageCtx } from './dmg';
import { stepBlast } from './blast';

const opts: CraterOpts = {
  budget: 0,
  lipFrac: 0.26,
  aspect: 0.42,
  chunkProb: 0.22,
  speedMul: 0.7,
  compact: 0.25,
  craterR: 0,
  type: T_CRUSH,
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
const pt: WorldPoint = { x: 0, y: 0 };

/**
 * CRUSH — gravity/compression. A wide, shallow impact crater (mostly powder: crushed matter is pulverised), with part of the
 * removed mass PACKED into the surrounding cells (density rises, integrity falls — sustained crush keeps compacting and
 * weakening the same region), an expanding SHOCK RING that snaps bonds as it travels outward, and TECTONIC fault cracks that
 * run radially away from the crater along the weakest bonds (crust/mantle boundaries first) and keep propagating.
 */
export function applyCrush(ctx: DamageCtx, res: DamageResult): void {
  const { core, body } = ctx;
  const cov = coverageOf(ctx);
  const E = ctx.energy;
  opts.budget = E;
  opts.craterR = ctx.params.crater ?? 0;
  if (ctx.params.compress !== undefined && ctx.params.compress > 0) {
    const rl = Math.sqrt((2 * E * (1 - opts.lipFrac)) / (Math.PI * 0.45));
    opts.aspect = Math.max(0.3, Math.min(1.3, ctx.params.compress / Math.max(4, rl * 0.7)));
  } else opts.aspect = 0.42;
  if (E >= 0.5 && carveCrater(ctx, opts, out)) {
    const shock = ctx.params.shock ?? 1;
    spawnShock(core, body, out, E, ctx.sourceMass, shock);
    plantTectonics(ctx, out, E);
    recordBlow(ctx, 0.6);
    body.connDirty = CONN_NOW;
  } else recordBlow(ctx, 0.3);
  finishDamage(ctx, res, cov, 1.15);
}

function spawnShock(
  core: WorldCore,
  body: Body,
  cr: CraterOut,
  E: number,
  sourceMass: number,
  shock: number,
): void {
  for (const w of core.waves) {
    if (w.active) continue;
    w.active = true;
    w.bodyId = body.id;
    w.cx = cr.fx;
    w.cy = cr.fy;
    w.r = Math.max(2, cr.rl * 0.9);
    w.speed = 1.05 + Math.min(0.6, E / 4000);
    w.maxR = Math.max(18, Math.min(70, cr.rl * 3.2 + Math.sqrt(E) * 0.6)) * (0.8 + 0.2 * shock);
    w.power = Math.min(1.6, 0.55 + E / 1600) * shock;
    w.type = 0;
    localToWorldF(body, cr.fx, cr.fy, pt);
    w.wx = pt.x;
    w.wy = pt.y;
    w.sourceMass = sourceMass;
    return;
  }
}

/** Radial fault lines from the crater rim: crack fronts seeded where the crater edge meets live matter, heading outward. */
function plantTectonics(ctx: DamageCtx, cr: CraterOut, E: number): void {
  const { body } = ctx;
  const w = body.w;
  const w1 = w + 1;
  const mat = body.map.material;
  const rng = body.rng;
  const count = Math.max(2, Math.min(5, Math.round(E / 450)));
  const stress = Math.min(255, 90 + E * 0.09);
  // Fan of directions over the half-plane pointing into the body.
  const inAng = Math.atan2(-cr.ny, -cr.nx);
  for (let k = 0; k < count; k++) {
    const a = inAng + ((k + 0.5) / count - 0.5) * Math.PI * 0.95 + (rng.next() - 0.5) * 0.3;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // March from the centre until we leave the void of the crater and hit live matter: that is the crater edge.
    let ex = -1;
    let ey = -1;
    for (let d = 1; d < 90; d += 0.5) {
      const x = Math.floor(cr.fx + ca * d);
      const y = Math.floor(cr.fy + sa * d);
      if (x < 1 || y < 1 || x >= w - 1 || y >= body.h - 1) break;
      if (mat[y * w + x] !== 0) {
        ex = x;
        ey = y;
        break;
      }
    }
    if (ex < 0) continue;
    let corner = -1;
    for (let c = 0; c < 4 && corner < 0; c++) {
      const cx = ex + (c & 1);
      const cy = ey + (c >> 1);
      for (let d = 0; d < 4; d++)
        if (edgeBond(body, cx, cy, d) >= 0) {
          corner = cy * w1 + cx;
          break;
        }
    }
    if (corner < 0) continue;
    plantFrontToward(
      body,
      corner % w1,
      Math.floor(corner / w1),
      ca,
      sa,
      stress * (0.8 + 0.4 * rng.next()),
      0.42,
      0,
    );
  }
}

/** Advance every active shock ring: snap bonds along the annulus, roughen it, puff dust outward. */
export function stepWaves(core: WorldCore): void {
  for (let k = 0; k < core.waves.length; k++) {
    const wv = core.waves[k]!;
    if (!wv.active) continue;
    const body = core.bodyById[wv.bodyId];
    if (!body) {
      wv.active = false;
      continue;
    }
    wv.r += wv.speed;
    if (wv.r > wv.maxR) {
      wv.active = false;
      continue;
    }
    if (wv.type === 0) stepShock(core, body, wv);
    else stepBlast(core, body, wv);
  }
}

function stepShock(core: WorldCore, body: Body, wv: Wave): void {
  const map = body.map;
  const w = body.w;
  const rng = body.rng;
  const r = wv.r;
  const f = Math.pow(1 - r / wv.maxR, 1.3) * wv.power;
  const x0 = Math.max(0, Math.floor(wv.cx - r - 2));
  const x1 = Math.min(w - 1, Math.ceil(wv.cx + r + 2));
  const y0 = Math.max(0, Math.floor(wv.cy - r - 2));
  const y1 = Math.min(body.h - 1, Math.ceil(wv.cy + r + 2));
  let broke = 0;
  const lo = (r - 1.4) * (r - 1.4);
  const hi = (r + 1.4) * (r + 1.4);
  const rid = body.rampIds[(map.material[Math.floor(wv.cy) * w + Math.floor(wv.cx)] || 1) * 5 + RAMP_DUST]!;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - wv.cx;
      const dy = y + 0.5 - wv.cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < lo || d2 > hi) continue;
      const i = y * w + x;
      if (map.material[i] === 0) continue;
      // Loosen: severed bonds (ragged, random) and a little bruising.
      // The wave exploits WEAK bonds (grain seams, faults, layer boundaries): a tectonic pattern, not random noise.
      const bR = x < w - 1 ? map.bondR[i]! : 0;
      const bD = map.bondD[i]!;
      const wR = Math.max(0, 1 - bR / 150);
      const wD = Math.max(0, 1 - bD / 150);
      const pR = f * 0.9 * wR * wR;
      const pD = f * 0.9 * wD * wD;
      if (bR !== 0 && rng.next() < pR) {
        map.bondR[i] = 0;
        map.flags[i] = map.flags[i]! | 2;
        map.flags[i + 1] = map.flags[i + 1]! | 2;
        broke++;
        body.touchPoint(x, y);
        body.touchPoint(x + 1, y);
      }
      if (bD !== 0 && rng.next() < pD) {
        map.bondD[i] = 0;
        map.flags[i] = map.flags[i]! | 2;
        map.flags[i + w] = map.flags[i + w]! | 2;
        broke++;
        body.touchPoint(x, y);
        body.touchPoint(x, y + 1);
      }
      const it = map.integrity[i]! - f * 5;
      map.integrity[i] = it < 12 ? 12 : it;
      body.touchPoint(x, y);
      // A puff of dust outward on the surface cells.
      if ((map.flags[i]! & 32) !== 0 && rng.next() < 0.12 * f) {
        body.cellWorld(x, y, pt);
        let ox = pt.x - wv.wx;
        let oy = pt.y - wv.wy;
        const ol = Math.sqrt(ox * ox + oy * oy) + 1e-6;
        ox /= ol;
        oy /= ol;
        spawnMassParticle(core, PK.dust, rid, pt.x, pt.y, ox * 45, oy * 45, 0);
      }
    }
  }
  // A ring of light marks the shock front where it crosses live matter.
  for (let g = 0; g < 7; g++) {
    const a = rng.next() * Math.PI * 2;
    const gx = Math.floor(wv.cx + Math.cos(a) * r);
    const gy = Math.floor(wv.cy + Math.sin(a) * r);
    if (gx < 0 || gy < 0 || gx >= w || gy >= body.h || map.material[gy * w + gx] === 0) continue;
    localToWorldF(body, gx + 0.5, gy + 0.5, pt);
    core.particles.spawn(
      core,
      PK.glint,
      pt.x,
      pt.y,
      Math.cos(a) * body.transform.facing * 30,
      Math.sin(a) * 30,
      7 + rng.int(6),
      1,
      220,
      rid,
      0,
      3,
      0,
    );
  }
  if (broke > 0) {
    body.connDirty = Math.max(body.connDirty, CONN_STEADY);
    core.emitMatter('crack', wv.wx, wv.wy, 0, body.ownerSlot);
  }
}
