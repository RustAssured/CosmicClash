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
  h = mix32(h, b.fuseCount);
  for (let k = 0; k < b.fuseCount; k++) {
    h = mix32(h, b.fuseCell[k]!);
    h = mix32(h, b.fuseTimer[k]!);
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
  for (const b of core.bodyList) h = hashBody(h, b);
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
    h = mix32(h, c.w | (c.h << 12));
    h = hashBytes(h, c.pixels);
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
