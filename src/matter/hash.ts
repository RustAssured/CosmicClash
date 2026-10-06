import type { Body } from './body';
import type { WorldCore } from './core';
import { hashBytes, mix32 } from './util';

/** Fold a float64 into the hash bit-exactly (via a shared buffer). */
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
function mixF(h: number, v: number): number {
  f64[0] = v;
  h = mix32(h, u32[0]!);
  return mix32(h, u32[1]!);
}

function hashBody(h: number, b: Body): number {
  const m = b.map;
  h = mix32(h, b.id);
  h = hashBytes(h, m.material);
  h = hashBytes(h, m.density);
  h = hashBytes(h, m.integrity);
  h = hashBytes(h, m.temperature);
  h = hashBytes(h, m.bondR);
  h = hashBytes(h, m.bondD);
  h = hashBytes(h, m.infection);
  h = hashBytes(h, m.flags);
  h = hashBytes(h, m.pixels);
  h = mixF(h, b.pool);
  h = mixF(h, b.massGained);
  h = mixF(h, b.massLost);
  h = mix32(h, b.frontCount);
  for (let k = 0; k < b.frontCount; k++) {
    h = mix32(h, b.frontX[k]! | (b.frontY[k]! << 16));
    h = mix32(h, b.frontDir[k]!);
    h = mixF(h, b.frontStress[k]!);
  }
  h = mix32(h, b.slowN | (b.slowPos << 16));
  for (let k = b.slowPos; k < b.slowN; k++) h = mix32(h, b.slowEdges[k]!);
  h = mix32(h, b.fuseCount);
  for (let k = 0; k < b.fuseCount; k++) {
    h = mix32(h, b.fuseCell[k]!);
    h = mix32(h, b.fuseTimer[k]!);
  }
  // Wounds and held slabs (slab tags live in map.detached).
  h = hashBytes(h, m.detached);
  const wb = b.wounds;
  h = mix32(h, wb.next | (wb.held << 8) | (wb.top << 16));
  for (let w = 0; w < wb.tick.length; w++) {
    h = mix32(h, wb.tick[w]!);
    h = mix32(h, wb.shear[w]!);
    h = mix32(h, wb.pending[w]!);
    h = mixF(h, wb.lx[w]!);
    h = mixF(h, wb.ly[w]!);
    h = mixF(h, wb.dx[w]!);
    h = mixF(h, wb.dy[w]!);
    h = mixF(h, wb.energy[w]!);
    h = mixF(h, wb.sourceMass[w]!);
    h = mixF(h, wb.speed[w]!);
    h = mixF(h, wb.mass[w]!);
    h = mix32(h, wb.grain[w]!);
  }
  for (let q = 0; q < wb.schedTick.length; q++) {
    if (wb.schedTick[q]! < 0) continue;
    h = mix32(h, wb.schedTick[q]!);
    h = mixF(h, wb.schedMass[q]!);
  }
  for (let s = 1; s < wb.state.length; s++) {
    if (wb.state[s] === 0) continue;
    h = mix32(h, s | (wb.state[s]! << 8) | (wb.woundOf[s]! << 16));
    h = mix32(h, wb.shearAt[s]!);
    h = mix32(h, wb.start[s]! | (wb.count[s]! << 16));
  }
  // Transient body state that steers later damage (last blow, magma fissures, debris immunity, tidal cadence).
  const bl = b.blow;
  h = mix32(h, bl.tick);
  h = mixF(h, bl.dirX);
  h = mixF(h, bl.dirY);
  h = mixF(h, bl.energy);
  h = mixF(h, bl.x);
  h = mixF(h, bl.y);
  h = mixF(h, bl.sourceMass);
  h = mixF(h, bl.radial);
  h = mix32(h, (b.magma ? 1 : 0) | (b.connDirty << 1));
  h = mix32(h, b.debrisImmuneUntil);
  h = mix32(h, b.debrisTick);
  h = mixF(h, b.debrisEnergy);
  h = mix32(h, b.lastTidalTick);
  h = mixF(h, b.tidalCarry);
  // The far face of a two-hemisphere body (shell.ts).
  const sh = b.shell;
  if (sh !== null) {
    h = mix32(h, sh.face | (sh.cells.length << 1));
    h = mix32(h, sh.swapLeft | (sh.swapRow << 8));
    h = mix32(h, sh.pk);
    h = mix32(h, sh.pr);
    h = mix32(h, sh.pd);
    h = hashBytes(h, sh.material);
    h = hashBytes(h, sh.density);
    h = hashBytes(h, sh.integrity);
    h = hashBytes(h, sh.temperature);
    h = hashBytes(h, sh.infection);
    h = hashBytes(h, sh.flags);
    h = hashBytes(h, sh.bondR);
    h = hashBytes(h, sh.bondD);
    h = mixF(h, sh.farMass);
  }
  const s = b.rng.getState();
  h = mix32(h, s[0]);
  h = mix32(h, s[1]);
  h = mix32(h, s[2]);
  h = mix32(h, s[3]);
  return h;
}

/** Stable 32-bit hash of all simulation state: bodies, chunks, particles, ledger, gravity, RNG. */
export function hashWorld(core: WorldCore, extra: (h: number) => number): number {
  let h = 0x811c9dc5 | 0;
  h = mix32(h, core.tick);
  for (const b of core.bodyList) {
    h = hashBody(h, b);
    if (b.fieldHeld) h = mix32(h, 0x0f1e1d); // (only when set: every other body's hash is unchanged)
  }
  const cp = core.chunks;
  h = mix32(h, cp.count);
  for (let i = 0; i < cp.hi; i++) {
    const c = cp.list[i]!;
    if (!c.alive) continue;
    h = mix32(h, c.id);
    h = mixF(h, c.x);
    h = mixF(h, c.y);
    h = mixF(h, c.vx);
    h = mixF(h, c.vy);
    h = mixF(h, c.angle);
    h = mixF(h, c.spin);
    h = mixF(h, c.mass);
    h = mixF(h, c.heat);
    h = mixF(h, c.inertia);
    h = mix32(h, c.w | (c.h << 12));
    h = mix32(h, c.age);
    h = mix32(h, c.grace | (c.noHitUntil << 12) | (c.asleep ? 1 << 30 : 0) | (c.fast ? 1 << 29 : 0));
    h = mix32(h, c.origin + 1);
    h = mix32(h, c.mode | ((c.owner + 1) << 4) | ((c.credit + 1) << 8));
    h = mixF(h, c.phase);
    h = mixF(h, c.ring);
    h = mixF(h, c.temp);
    h = mixF(h, c.temp0);
    h = hashBytes(h, c.pixels.subarray(0, c.w * c.h));
  }
  // Gravity owners' capture rings (Tidal Draw).
  for (const o of core.orbits) {
    h = mix32(h, o.active ? 1 : 0);
    h = mixF(h, o.x);
    h = mixF(h, o.y);
    h = mixF(h, o.radius);
    h = mixF(h, o.omega);
    h = mixF(h, o.flatten);
  }
  // Shock rings / blast waves in flight.
  for (let k = 0; k < core.waves.length; k++) {
    const wv = core.waves[k]!;
    if (!wv.active) continue;
    h = mix32(h, k | (wv.type << 8) | ((wv.bodyId + 1) << 12));
    h = mixF(h, wv.cx);
    h = mixF(h, wv.cy);
    h = mixF(h, wv.r);
    h = mixF(h, wv.speed);
    h = mixF(h, wv.maxR);
    h = mixF(h, wv.power);
  }
  const pp = core.particles;
  h = mix32(h, pp.count);
  h = hashBytes(h, pp.x.subarray(0, pp.hi));
  h = hashBytes(h, pp.y.subarray(0, pp.hi));
  h = hashBytes(h, pp.vx.subarray(0, pp.hi));
  h = hashBytes(h, pp.vy.subarray(0, pp.hi));
  h = hashBytes(h, pp.life.subarray(0, pp.hi));
  h = hashBytes(h, pp.mass.subarray(0, pp.hi));
  h = mixF(h, pp.massLive);
  h = mixF(h, cp.massLive);
  const l = core.ledger;
  h = mixF(h, l.created);
  h = mixF(h, l.injected);
  h = mixF(h, l.deleted);
  h = mixF(h, l.dissipated);
  h = mixF(h, l.credited);
  for (const g of core.gravity) {
    h = mix32(h, g.active ? 1 : 0);
    h = mixF(h, g.x);
    h = mixF(h, g.y);
    h = mixF(h, g.strength);
  }
  const r = core.rng.getState();
  h = mix32(h, r[0]);
  h = mix32(h, r[1]);
  h = mix32(h, r[2]);
  h = mix32(h, r[3]);
  h = extra(h);
  return h >>> 0;
}
