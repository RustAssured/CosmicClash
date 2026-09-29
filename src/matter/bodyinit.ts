import { CellFlag, REGION_GRID } from '@/contracts';
import type { Body } from './body';
import { refreshSurfaceRect } from './cells';
import type { WorldCore } from './core';
import { buildRamps } from './debris';
import { hash2, noise2, valueNoise } from './util';
import { refreshVisuals } from './visual';

const F_SURF = CellFlag.SURFACE;

/** Grain (Voronoi plate) size in cells: the natural shard size of a shattered body. */
const GRAIN = 17;

/** Bond scale from the COHESION attribute: cohesion 6 = 1.0. */
export const cohesionBondScale = (cohesion: number): number => 0.5 + cohesion * (1 / 12);

interface Fault {
  px: number;
  py: number;
  ux: number;
  uy: number;
  t0: number;
  t1: number;
  wob: number;
}

/**
 * Initialise everything the generator does not provide: sanitised cell state, bonds (with grain seams, authored faults and
 * weaker layer boundaries), SURFACE flags, region/core bookkeeping, the pristine snapshot, particle ramps and the first
 * full visual refresh.
 */
export function initBody(core: WorldCore, body: Body): void {
  const map = body.map;
  const { w, h, n } = body;
  const mats = body.materials;
  const mat = map.material;

  // 1. Sanitise: void cells are fully zero; live cells get integrity 255 / nominal density if unset.
  let liveMinX = w;
  let liveMinY = h;
  let liveMaxX = -1;
  let liveMaxY = -1;
  for (let i = 0; i < n; i++) {
    if (mat[i] === 0 || mat[i]! >= mats.length) {
      mat[i] = 0;
      map.density[i] = 0;
      map.integrity[i] = 0;
      map.pixels[i] = 0;
      map.baseColor[i] = map.baseColor[i]!;
      continue;
    }
    if (map.integrity[i] === 0) map.integrity[i] = 255;
    if (map.density[i] === 0) map.density[i] = 128;
    map.temperature[i] = 0;
    map.infection[i] = 0;
    map.flags[i] = 0;
    map.detached[i] = 0;
    const x = i % w;
    const y = (i - x) / w;
    if (x < liveMinX) liveMinX = x;
    if (x > liveMaxX) liveMaxX = x;
    if (y < liveMinY) liveMinY = y;
    if (y > liveMaxY) liveMaxY = y;
  }
  body.liveX0 = Math.max(0, liveMinX);
  body.liveY0 = Math.max(0, liveMinY);
  body.liveX1 = Math.max(0, liveMaxX);
  body.liveY1 = Math.max(0, liveMaxY);

  // 2. Grains + faults -> bonds.
  const grain = computeGrains(body);
  const faults = makeFaults(body, liveMinX, liveMinY, liveMaxX, liveMaxY);
  initBonds(body, grain, faults);

  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      body.vein[y * w + x] = Math.round((0.3 + 1.5 * valueNoise(x / 5.5, y / 5.5, body.seed ^ 0x51)) * 64);

  // 3. Surface flags and the set of materials that occur on the pristine surface.
  refreshSurfaceRect(body, 0, 0, w - 1, h - 1);
  body.surfaceMat.fill(0);
  for (let i = 0; i < n; i++) if ((map.flags[i]! & F_SURF) !== 0) body.surfaceMat[mat[i]!] = 1;

  // 4. Core disc and region bookkeeping.
  const cr = Math.max(1, map.coreRadius);
  const disc: number[] = [];
  let corePristine = 0;
  for (
    let y = Math.max(0, Math.floor(map.coreY - cr));
    y <= Math.min(h - 1, Math.ceil(map.coreY + cr));
    y++
  ) {
    for (
      let x = Math.max(0, Math.floor(map.coreX - cr));
      x <= Math.min(w - 1, Math.ceil(map.coreX + cr));
      x++
    ) {
      const dx = x + 0.5 - (map.coreX + 0.5);
      const dy = y + 0.5 - (map.coreY + 0.5);
      if (dx * dx + dy * dy > cr * cr) continue;
      const i = y * w + x;
      disc.push(i);
      if (mat[i] !== 0) corePristine++;
    }
  }
  body.coreDiscIdx = Int32Array.from(disc);
  body.coreMask.fill(0);
  for (const c of disc) body.coreMask[c] = 1;
  body.corePristine = Math.max(1, corePristine);

  body.regionPristine.fill(0);
  let mass = 0;
  let cells = 0;
  for (let i = 0; i < n; i++) {
    if (mat[i] === 0) continue;
    const x = i % w;
    const y = (i - x) / w;
    body.regionPristine[body.regionOfY[y]! * REGION_GRID + body.regionOfX[x]!]!++;
    cells++;
    mass += body.cellMass(i);
  }
  map.initialMass = mass;
  map.mass = mass;
  map.initialCells = cells;
  map.liveCells = cells;
  core.ledger.created += mass;

  // 5. Pristine snapshot for restore()/heal().
  body.snap = {
    material: map.material.slice(),
    density: map.density.slice(),
    bondR: map.bondR.slice(),
    bondD: map.bondD.slice(),
    height: map.height.slice(),
    baseColor: map.baseColor.slice(),
    flags: map.flags.slice(),
    mass,
    cells,
  };

  // 6. Particle ramps, first visual refresh, stats.
  buildRamps(core, body);
  body.visAll = true;
  refreshVisuals(core, body);
  body.statsDirty = true;
  body.regionDirty.fill(1);
  body.refreshStats();
  body.connDirty = 0;
  body.connFull = true;
  body.lastConnTick = core.tick;
}

/** Jittered-grid Voronoi plates with a low-frequency warp so seams are organic, not gridded. Returns grain id per cell. */
function computeGrains(body: Body): Uint16Array {
  const { w, h } = body;
  const seed = body.seed;
  const grain = new Uint16Array(body.n);
  const gx = Math.ceil(w / GRAIN) + 3;
  const gy = Math.ceil(h / GRAIN) + 3;
  const sx = new Float32Array(gx * gy);
  const sy = new Float32Array(gx * gy);
  for (let j = 0; j < gy; j++)
    for (let i = 0; i < gx; i++) {
      sx[j * gx + i] = (i - 1 + 0.5 + (noise2(i, j, seed ^ 0x11) - 0.5) * 0.85) * GRAIN;
      sy[j * gx + i] = (j - 1 + 0.5 + (noise2(i, j, seed ^ 0x77) - 0.5) * 0.85) * GRAIN;
    }
  const mat = body.map.material;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = y * w + x;
      if (mat[c] === 0) continue;
      // Warp so plate boundaries wander.
      const qx = x + (valueNoise(x / 13, y / 13, seed ^ 0x31) - 0.5) * 9;
      const qy = y + (valueNoise(x / 13, y / 13, seed ^ 0x53) - 0.5) * 9;
      const gi = Math.floor(qx / GRAIN) + 1;
      const gj = Math.floor(qy / GRAIN) + 1;
      let best = 0;
      let bd = Infinity;
      for (let jj = gj - 1; jj <= gj + 1; jj++) {
        if (jj < 0 || jj >= gy) continue;
        for (let ii = gi - 1; ii <= gi + 1; ii++) {
          if (ii < 0 || ii >= gx) continue;
          const k = jj * gx + ii;
          const dx = qx - sx[k]!;
          const dy = qy - sy[k]!;
          const d = dx * dx + dy * dy;
          if (d < bd) {
            bd = d;
            best = k;
          }
        }
      }
      grain[c] = best + 1;
    }
  }
  return grain;
}

/** 2-3 authored fault segments: long straight-ish weak lines through the body that FRACTURE prefers to shear along. */
function makeFaults(body: Body, x0: number, y0: number, x1: number, y1: number): Fault[] {
  const out: Fault[] = [];
  if (x1 < x0) return out;
  const seed = body.seed;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const span = Math.max(x1 - x0, y1 - y0);
  const count = 2 + (hash2(seed, 5, 9) & 1);
  for (let k = 0; k < count; k++) {
    const ang = noise2(k, 3, seed) * Math.PI;
    const off = (noise2(k, 4, seed) - 0.5) * span * 0.55;
    const along = (noise2(k, 8, seed) - 0.5) * span * 0.3;
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    out.push({
      px: cx + -uy * off + ux * along,
      py: cy + ux * off + uy * along,
      ux,
      uy,
      t0: -span * (0.22 + 0.2 * noise2(k, 6, seed)),
      t1: span * (0.22 + 0.2 * noise2(k, 7, seed)),
      wob: k * 17 + 3,
    });
  }
  return out;
}

/** Signed perpendicular distance of (x,y) to fault `f`, with a wobble so faults are not ruler-straight. */
function faultSide(f: Fault, x: number, y: number, seed: number): number {
  const rx = x - f.px;
  const ry = y - f.py;
  const t = rx * f.ux + ry * f.uy;
  const perp = -rx * f.uy + ry * f.ux;
  return perp + (valueNoise(t / 8, f.wob, seed) - 0.5) * 5;
}

function crossesFault(f: Fault, ax: number, ay: number, bx: number, by: number, seed: number): boolean {
  const t = ((ax + bx) * 0.5 - f.px) * f.ux + ((ay + by) * 0.5 - f.py) * f.uy;
  if (t < f.t0 || t > f.t1) return false;
  return faultSide(f, ax, ay, seed) * faultSide(f, bx, by, seed) < 0;
}

function initBonds(body: Body, grain: Uint16Array, faults: Fault[]): void {
  const map = body.map;
  const { w, h } = body;
  const mats = body.materials;
  const mat = map.material;
  const coh = cohesionBondScale(body.attributes.cohesion);
  const seed = body.seed;
  const bondFor = (
    a: number,
    b: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    salt: number,
  ): number => {
    const ma = mat[a]!;
    const mb = mat[b]!;
    const A = mats[ma]!;
    const B = mats[mb]!;
    let v = Math.min(A.bond, B.bond);
    if (ma !== mb) v *= 0.62; // layer boundaries are weak: damage REVEALS the layers
    const brit = (A.brittleness + B.brittleness) * 0.5;
    if (grain[a] !== grain[b]) v *= 1 - 0.52 * (0.35 + 0.65 * brit);
    for (let k = 0; k < faults.length; k++) if (crossesFault(faults[k]!, ax, ay, bx, by, seed)) v *= 0.42;
    v *= 0.86 + 0.28 * noise2(a, salt, seed);
    v *= coh;
    v = Math.round(v);
    return v < 1 ? 1 : v > 255 ? 255 : v;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mat[i] === 0) {
        map.bondR[i] = 0;
        map.bondD[i] = 0;
        continue;
      }
      map.bondR[i] = x < w - 1 && mat[i + 1] !== 0 ? bondFor(i, i + 1, x, y, x + 1, y, 1) : 0;
      map.bondD[i] = y < h - 1 && mat[i + w] !== 0 ? bondFor(i, i + w, x, y, x, y + 1, 2) : 0;
    }
  }
}
