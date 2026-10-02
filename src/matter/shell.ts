import { ACT_HEAT, ACT_INFECT, type Body } from './body';
import { flushSlowCuts } from './cracks';
import { runConnectivity } from './connectivity';
import type { WorldCore } from './core';
import { finishRebuild } from './lifecycle';
import { REGION_GRID } from '@/contracts';
import { clearWounds, finishReleases, flushWounds } from './wound';

/**
 * The Planet's two-hemisphere world (D26/D28, S3's design): the shell — every cell farther than `innerR` from the core centre —
 * exists twice, a near face (the live cells) and a far face (stored here). A committed half-turn swaps them EXACTLY; the core
 * (r ≤ innerR) is shared and never moves. Damage geography is "which face is toward you".
 *
 * The far face is stored in the coordinates it will be DRAWN at after the next half-turn, so a swap is a plain per-cell exchange
 * and two swaps are the identity, bit for bit. At definition the far face is the near face mirrored about the core column (a
 * half-turn about the vertical axis carries the point at x to −x): the same world, its other side.
 *
 * Mass: the far face is real matter. It is booked as created when the shell is defined, counted in the ledger's cell term and in
 * the body's stats (mass, cells, initial mass: the whole planet), so a swap never changes stats.mass. The regionGrid and
 * coreIntegrity describe the near face (what the camera sees) and the shared core.
 */
export class ShellFace {
  /** Shell cells (map indices) and the bond slots a swap exchanges (a bond whose either end is in the shell). */
  readonly cells: Int32Array;
  readonly bR: Int32Array;
  readonly bD: Int32Array;
  /** The shell radius it was defined with (-1: defined by a mask). */
  readonly innerR: number;
  /** 0 = the face the body was created with is toward the viewer, 1 = the other. */
  face = 0;
  /* far face, per shell cell (index k of `cells`) */
  readonly material: Uint8Array;
  readonly density: Uint8Array;
  readonly integrity: Uint8Array;
  readonly temperature: Float32Array;
  readonly infection: Uint8Array;
  readonly flags: Uint8Array;
  readonly height: Uint8Array;
  readonly baseColor: Uint32Array;
  readonly vein: Uint8Array;
  readonly bondR: Uint8Array;
  readonly bondD: Uint8Array;
  /* far face pristine snapshot (restore / regionPristine) */
  readonly sMaterial: Uint8Array;
  readonly sDensity: Uint8Array;
  readonly sHeight: Uint8Array;
  readonly sFlags: Uint8Array;
  readonly sBaseColor: Uint32Array;
  readonly sBondR: Uint8Array;
  readonly sBondD: Uint8Array;
  /** Live mass / cells of the far face, and its pristine mass / cells. */
  farMass = 0;
  farCells = 0;
  farInitialMass = 0;
  farInitialCells = 0;

  constructor(cells: Int32Array, bR: Int32Array, bD: Int32Array, innerR: number) {
    this.cells = cells;
    this.bR = bR;
    this.bD = bD;
    this.innerR = innerR;
    const n = cells.length;
    this.material = new Uint8Array(n);
    this.density = new Uint8Array(n);
    this.integrity = new Uint8Array(n);
    this.temperature = new Float32Array(n);
    this.infection = new Uint8Array(n);
    this.flags = new Uint8Array(n);
    this.height = new Uint8Array(n);
    this.baseColor = new Uint32Array(n);
    this.vein = new Uint8Array(n);
    this.bondR = new Uint8Array(bR.length);
    this.bondD = new Uint8Array(bD.length);
    this.sMaterial = new Uint8Array(n);
    this.sDensity = new Uint8Array(n);
    this.sHeight = new Uint8Array(n);
    this.sFlags = new Uint8Array(n);
    this.sBaseColor = new Uint32Array(n);
    this.sBondR = new Uint8Array(bR.length);
    this.sBondD = new Uint8Array(bD.length);
  }

  /** Recount the far face's live mass and cells. */
  recount(body: Body): void {
    const md = body.matDensity;
    let m = 0;
    let c = 0;
    for (let k = 0; k < this.cells.length; k++) {
      const mi = this.material[k]!;
      if (mi === 0) continue;
      c++;
      m += (md[mi]! * this.density[k]!) / 128;
    }
    this.farMass = m;
    this.farCells = c;
  }
}

/** Settle every process in flight (held wound slabs, queued slow cuts, pending islands) so the shell holds no transient state. */
function settle(core: WorldCore, body: Body): void {
  flushSlowCuts(core, body);
  flushWounds(core, body);
  runConnectivity(core, body);
  finishReleases(core, body);
  clearWounds(body);
  // crack fronts and shrapnel fuses are short-lived and positional: a half-turn ends them
  body.frontCount = 0;
  body.fuseCount = 0;
}

/**
 * Define the shell of `body`: the cells farther than `shell` cells from the core centre (a number: the Planet passes magmaR),
 * or the cells where `shell[i] = 1` (a map-sized mask). The far face is the body's PRISTINE snapshot mirrored about the core
 * column (the other side of the world has not been hit). False if the body already has a shell or the shell is empty.
 */
export function defineShell(core: WorldCore, body: Body, shell: number | Uint8Array): boolean {
  if (body.shell !== null) return false;
  const map = body.map;
  const { w, h, n } = body;
  const inShell = new Uint8Array(n);
  let count = 0;
  let innerR = -1;
  if (typeof shell === 'number') {
    if (!(shell >= 0)) return false;
    innerR = shell;
    const cx = map.coreX + 0.5;
    const cy = map.coreY + 0.5;
    const r2 = shell * shell;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy > r2) {
          inShell[y * w + x] = 1;
          count++;
        }
      }
  } else {
    if (shell.length !== n) return false;
    for (let c = 0; c < n; c++)
      if (shell[c] === 1) {
        inShell[c] = 1;
        count++;
      }
  }
  if (count === 0) return false;
  const cells = new Int32Array(count);
  const r: number[] = [];
  const d: number[] = [];
  let k = 0;
  for (let c = 0; c < n; c++) {
    const x = c % w;
    if (inShell[c]) cells[k++] = c;
    if (x < w - 1 && (inShell[c] || inShell[c + 1])) r.push(c);
    if (c + w < n && (inShell[c] || inShell[c + w])) d.push(c);
  }
  const sh = new ShellFace(cells, Int32Array.from(r), Int32Array.from(d), innerR);
  // Mirror about the core column: cell x ↔ 2·coreX − x (cell centres x + 0.5 ↔ 2·cx − x − 0.5).
  const mirror = (c: number): number => {
    const x = c % w;
    const mx = 2 * map.coreX - x;
    if (mx < 0 || mx >= w) return c;
    const m = c - x + mx;
    return inShell[m] ? m : c;
  };
  const s = body.snap;
  for (let i = 0; i < count; i++) {
    const c = cells[i]!;
    const m = mirror(c);
    sh.material[i] = s.material[m]!;
    sh.density[i] = s.density[m]!;
    sh.integrity[i] = s.material[m] !== 0 ? 255 : 0;
    sh.flags[i] = s.flags[m]!;
    sh.height[i] = s.height[m]!;
    sh.baseColor[i] = s.baseColor[m]!;
    sh.vein[i] = body.vein[m]!;
    sh.sMaterial[i] = s.material[m]!;
    sh.sDensity[i] = s.density[m]!;
    sh.sHeight[i] = s.height[m]!;
    sh.sFlags[i] = s.flags[m]!;
    sh.sBaseColor[i] = s.baseColor[m]!;
  }
  // Bonds: the edge (x, x+1) mirrors to (mx − 1, mx), stored at bondR[y·w + mx − 1]; (y, y+1) at x mirrors to bondD at mx.
  for (let i = 0; i < sh.bR.length; i++) {
    const c = sh.bR[i]!;
    const x = c % w;
    const mx = 2 * map.coreX - x;
    const src = mx - 1 >= 0 && mx < w ? c - x + mx - 1 : c;
    sh.bondR[i] = s.bondR[src]!;
    sh.sBondR[i] = s.bondR[src]!;
  }
  for (let i = 0; i < sh.bD.length; i++) {
    const c = sh.bD[i]!;
    const x = c % w;
    const mx = 2 * map.coreX - x;
    const src = mx >= 0 && mx < w ? c - x + mx : c;
    sh.bondD[i] = s.bondD[src]!;
    sh.sBondD[i] = s.bondD[src]!;
  }
  sh.recount(body);
  const md = body.matDensity;
  let im = 0;
  let ic = 0;
  for (let i = 0; i < count; i++) {
    const mi = sh.sMaterial[i]!;
    if (mi === 0) continue;
    ic++;
    im += (md[mi]! * sh.sDensity[i]!) / 128;
  }
  sh.farInitialMass = im;
  sh.farInitialCells = ic;
  core.ledger.created += sh.farMass;
  body.shell = sh;
  body.statsDirty = true;
  return true;
}

const swapU8 = (a: Uint8Array, i: number, b: Uint8Array, k: number): void => {
  const t = a[i]!;
  a[i] = b[k]!;
  b[k] = t;
};

/** Commit a half-turn: the far face comes toward the viewer, the near face goes round the back. False if no shell. */
export function swapShell(core: WorldCore, body: Body): boolean {
  const sh = body.shell;
  if (sh === null) return false;
  settle(core, body);
  const map = body.map;
  const s = body.snap;
  const cells = sh.cells;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k]!;
    swapU8(map.material, c, sh.material, k);
    swapU8(map.density, c, sh.density, k);
    swapU8(map.integrity, c, sh.integrity, k);
    swapU8(map.infection, c, sh.infection, k);
    swapU8(map.flags, c, sh.flags, k);
    swapU8(map.height, c, sh.height, k);
    swapU8(body.vein, c, sh.vein, k);
    swapU8(s.material, c, sh.sMaterial, k);
    swapU8(s.density, c, sh.sDensity, k);
    swapU8(s.height, c, sh.sHeight, k);
    swapU8(s.flags, c, sh.sFlags, k);
    const T = map.temperature[c]!;
    map.temperature[c] = sh.temperature[k]!;
    sh.temperature[k] = T;
    const bc = map.baseColor[c]!;
    map.baseColor[c] = sh.baseColor[k]!;
    sh.baseColor[k] = bc;
    const sc = s.baseColor[c]!;
    s.baseColor[c] = sh.sBaseColor[k]!;
    sh.sBaseColor[k] = sc;
    map.detached[c] = 0;
    map.emissive[c] = 0;
  }
  for (let k = 0; k < sh.bR.length; k++) {
    const c = sh.bR[k]!;
    swapU8(map.bondR, c, sh.bondR, k);
    swapU8(s.bondR, c, sh.sBondR, k);
  }
  for (let k = 0; k < sh.bD.length; k++) {
    const c = sh.bD[k]!;
    swapU8(map.bondD, c, sh.bondD, k);
    swapU8(s.bondD, c, sh.sBondD, k);
  }
  sh.face ^= 1;
  sh.recount(body);
  recountPristine(body);
  body.wakeRect(0, 0, body.w - 1, body.h - 1, ACT_HEAT | ACT_INFECT);
  finishRebuild(body);
  return true;
}

/** Between rounds: the far face returns to its pristine state too (restore() resets the near face). */
export function restoreShell(core: WorldCore, body: Body): void {
  const sh = body.shell;
  if (sh === null) return;
  const before = sh.farMass;
  sh.material.set(sh.sMaterial);
  sh.density.set(sh.sDensity);
  sh.height.set(sh.sHeight);
  sh.flags.set(sh.sFlags);
  sh.baseColor.set(sh.sBaseColor);
  sh.bondR.set(sh.sBondR);
  sh.bondD.set(sh.sBondD);
  sh.temperature.fill(0);
  sh.infection.fill(0);
  for (let k = 0; k < sh.cells.length; k++) sh.integrity[k] = sh.sMaterial[k] !== 0 ? 255 : 0;
  sh.recount(body);
  if (sh.farMass > before) core.ledger.injected += sh.farMass - before;
  else core.ledger.deleted += before - sh.farMass;
  body.statsDirty = true;
}

/** regionPristine (the regionGrid's denominator) follows the near face's pristine snapshot. */
function recountPristine(body: Body): void {
  const mat = body.snap.material;
  const w = body.w;
  body.regionPristine.fill(0);
  for (let i = 0; i < body.n; i++) {
    if (mat[i] === 0) continue;
    const x = i % w;
    const y = (i - x) / w;
    body.regionPristine[body.regionOfY[y]! * REGION_GRID + body.regionOfX[x]!]!++;
  }
}
