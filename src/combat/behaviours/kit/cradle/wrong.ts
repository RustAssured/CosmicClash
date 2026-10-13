import type { MatterBody, MatterMap, MatterWorld } from '@/contracts';
import type { CradleRig } from '@/titans/kit/cradle/paint';
import { atRank, transmute } from '@/titans/kit/cradle/grow';
import { bodyWorld, touch } from './gestate';

/**
 * DIFFERENTIATION FAILURE (Gate 5, the brief's "Weakness"): the Cradle survives because every part of it keeps telling its
 * neighbours what to become. As it is hurt those instructions fail, and it does not simply bleed, it DEVELOPS WRONG:
 *  - healthy (above 75 %): horrible but organised; nothing here runs;
 *  - damaged (75 → 35 %): proliferating. Every few seconds (faster as it falls) one wrong turn: membrane calcifies into bone,
 *    a stretch of rib swells into fluid sacs (sacs where the spokes were), knot muscle calcifies, bone goes vascular;
 *  - near death (below 35 %): runaway self-gestation. The knot proliferates (new tissue grows on it), sacs blister the disc, and
 *    the sail loses its rhythm;
 *  - at any health: a spoke knocked out is not left as a hole. Ten seconds later the tissue round it has tried to repair it and
 *    grown a calcified organ there instead (new bone grown into the wound, lumpy, wrong).
 *
 * Works on the Cradle's own bodies with its own materials (no free mass except the regrowth in its wounds). Deterministic.
 */

const ihash = (a: number, b: number, s: number): number => {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};

/** A spoke knocked out: when it regrows wrong (ticks), and done. */
interface SpokeWatch {
  /** Disc-map cells of the spoke as painted (bone). */
  cells: Int32Array;
  /** Midpoint of the spoke in the disc map (cells). */
  mx: number;
  my: number;
  at: number;
  done: boolean;
}

/** The ten seconds the tissue round a lost spoke spends trying to repair it (brief). */
const REPAIR_TICKS = 600;
/** A spoke with less than this share of its bone left is lost. */
const SPOKE_LOST = 0.5;

export class Differentiation {
  private spokes: SpokeWatch[] = [];
  private nextWrong = 0;
  /** Wrong turns taken so far, and organs regrown in lost spokes (instrumentation, hash). */
  turns = 0;
  organs = 0;
  /** 0 healthy, 1 proliferating, 2 runaway (the behaviour reads it: an erratic sail, a heavier knot). */
  stage = 0;

  /** Find each spoke's painted bone cells in the disc map (once, from the pristine disc). */
  prepare(R: CradleRig): void {
    const disc = R.regions.find((r) => r.kind === 'disc');
    this.spokes = [];
    if (!disc) return;
    const m = disc.map;
    const bone = R.ids.bone;
    for (const sp of R.spokes) {
      const ax = sp.ax - disc.ox;
      const ay = sp.ay - disc.oy;
      const bx = sp.bx - disc.ox;
      const by = sp.by - disc.oy;
      const vx = bx - ax;
      const vy = by - ay;
      const l2 = vx * vx + vy * vy || 1;
      const cells: number[] = [];
      for (let y = 0; y < m.h; y++)
        for (let x = 0; x < m.w; x++) {
          const i = y * m.w + x;
          if (m.material[i] !== bone) continue;
          const px = x + 0.5 - ax;
          const py = y + 0.5 - ay;
          let t = (px * vx + py * vy) / l2;
          t = t < 0.15 ? 0.15 : t > 1 ? 1 : t;
          if ((px - vx * t) ** 2 + (py - vy * t) ** 2 < 9) cells.push(i);
        }
      this.spokes.push({
        cells: Int32Array.from(cells),
        mx: ax + vx * 0.6,
        my: ay + vy * 0.6,
        at: -1,
        done: false,
      });
    }
  }

  reset(): void {
    for (const s of this.spokes) {
      s.at = -1;
      s.done = false;
    }
    this.nextWrong = 0;
    this.stage = 0;
  }

  /**
   * Every tick (cheap; it works every 30 ticks): the stage from health, lost spokes and their regrowth, the wrong turns.
   * Returns true when something visibly went wrong this tick (the behaviour cues the voice).
   */
  tick(
    now: number,
    health: number,
    world: MatterWorld,
    knot: MatterBody,
    disc: MatterBody | null,
    R: CradleRig,
    seed: number,
  ): boolean {
    if (now % 30 !== 11) return false;
    this.stage = health > 0.75 ? 0 : health > 0.35 ? 1 : 2;
    let any = false;
    // lost spokes: the repair goes wrong ten seconds later
    if (disc) {
      const m = disc.map;
      for (const s of this.spokes) {
        if (s.done || s.cells.length === 0) continue;
        if (s.at < 0) {
          let live = 0;
          for (let k = 0; k < s.cells.length; k++) if (m.material[s.cells[k]!] !== 0) live++;
          if (live / s.cells.length < SPOKE_LOST) s.at = now + REPAIR_TICKS;
        } else if (now >= s.at) {
          s.done = true;
          this.regrowSpoke(world, disc, s, R, seed + now);
          this.organs++;
          any = true;
        }
      }
    }
    if (this.stage === 0) return any;
    // the wrong turns come faster as it falls: every 6 s at 75 %, every 1.5 s near death
    if (now < this.nextWrong) return any;
    const gap = Math.round(70 + 200 * Math.max(0, (health - 0.05) / 0.7));
    this.nextWrong = now + gap;
    const r = ihash(now, 3, seed);
    const ids = R.ids;
    if (this.stage === 2 && r < 0.4) {
      this.proliferate(world, knot, R, seed + now);
    } else if (disc && r < 0.62) {
      // membrane becomes bone
      this.patch(disc.map, R, ids.membrane, ids.bone, 6 + ihash(now, 5, seed) * 5, seed + now, 0.1);
    } else if (disc && r < 0.8) {
      // sacs grow where the structural supports should be
      this.patch(disc.map, R, ids.bone, ids.sac, 5 + ihash(now, 6, seed) * 4, seed + now, 0.15);
    } else if (r < 0.92) {
      // muscle calcifies
      this.patch(knot.map, R, ids.muscle, ids.bone, 5 + ihash(now, 7, seed) * 3, seed + now, 0.05);
    } else if (disc) {
      // bone becomes vascular tissue
      this.patch(disc.map, R, ids.bone, ids.vessel, 3 + ihash(now, 8, seed) * 2, seed + now, 0.2);
    }
    this.turns++;
    return true;
  }

  /** Turn a round patch of `from` into `to` round a live `from` cell chosen by the seed. */
  private patch(
    m: MatterMap,
    R: CradleRig,
    from: number,
    to: number,
    r: number,
    seed: number,
    shift: number,
  ): void {
    // pick a live cell of the right tissue (a few deterministic probes)
    let cx = -1;
    let cy = -1;
    for (let k = 0; k < 40 && cx < 0; k++) {
      const x = Math.floor(ihash(k, 1, seed) * m.w);
      const y = Math.floor(ihash(k, 2, seed) * m.h);
      if (m.material[y * m.w + x] === from) {
        cx = x;
        cy = y;
      }
    }
    if (cx < 0) return;
    transmute(
      m,
      R.ramps,
      (mat, x, y) => {
        if (mat !== from) return 0;
        const a = Math.atan2(y - cy, x - cx);
        const rr = r * (0.8 + 0.25 * Math.sin(a * 3 + seed));
        return (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 < rr * rr ? to : 0;
      },
      seed,
      shift,
    );
  }

  /** The lost spoke regrows wrong: bone grown back into the wound as a lumpy calcified organ, with a sac in it. */
  private regrowSpoke(world: MatterWorld, disc: MatterBody, s: SpokeWatch, R: CradleRig, seed: number): void {
    const m = disc.map;
    const before = m.material.slice();
    // where the spoke's midpoint is in the world now (the disc turns and mirrors): grow toward it
    const w = { x: 0, y: 0 };
    bodyWorld(disc, s.mx, s.my, w);
    world.grow(disc.id, { cells: 120, materialKey: 'bone', nearX: w.x, nearY: w.y });
    // the new cells: knobbly, lit unevenly (calcified), a fluid sac in the middle of the growth
    const ramp = R.ramps[R.ids.bone]!;
    const sac = R.ramps[R.ids.sac]!;
    let x0 = m.w;
    let y0 = m.h;
    let x1 = 0;
    let y1 = 0;
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        if (before[i] !== 0 || m.material[i] === 0) continue;
        const knob = Math.sin(x * 1.1 + seed) * Math.sin(y * 0.9 - seed);
        const nearMid = (x + 0.5 - s.mx) ** 2 + (y + 0.5 - s.my) ** 2 < 6;
        const c = nearMid ? atRank(sac, 0.75, x, y, seed) : atRank(ramp, 0.35 + 0.35 * knob, x, y, seed);
        if (nearMid) m.material[i] = R.ids.sac;
        m.baseColor[i] = c;
        m.pixels[i] = c;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + 1);
        y1 = Math.max(y1, y + 1);
      }
    // and the bone left round the wound swells into nodules
    transmute(
      m,
      R.ramps,
      (mat, x, y) =>
        mat === R.ids.membrane &&
        (x + 0.5 - s.mx) ** 2 + (y + 0.5 - s.my) ** 2 < 30 &&
        ihash(x, y, seed) < 0.4
          ? R.ids.bone
          : 0,
      seed,
      0.2,
    );
    if (x1 > x0) touch(m, x0, y0, x1, y1);
  }

  /** Runaway self-gestation: the knot grows new tissue on itself, blistered with sacs. */
  private proliferate(world: MatterWorld, knot: MatterBody, R: CradleRig, seed: number): void {
    const m = knot.map;
    const before = m.material.slice();
    // somewhere on the knot's lower half
    const lx = m.coreX + (ihash(1, 1, seed) - 0.5) * 30;
    const ly = m.coreY + 6 + ihash(2, 2, seed) * 18;
    const w = { x: 0, y: 0 };
    bodyWorld(knot, lx, ly, w);
    world.grow(knot.id, {
      cells: 26,
      materialKey: ihash(3, 3, seed) < 0.3 ? 'sac' : 'muscle',
      nearX: w.x,
      nearY: w.y,
    });
    let x0 = m.w;
    let y0 = m.h;
    let x1 = 0;
    let y1 = 0;
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        if (before[i] !== 0 || m.material[i] === 0) continue;
        const ramp = R.ramps[m.material[i]!]!;
        const c = atRank(ramp, 0.25 + 0.45 * ihash(x >> 1, y >> 1, seed), x, y, seed);
        m.baseColor[i] = c;
        m.pixels[i] = c;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + 1);
        y1 = Math.max(y1, y + 1);
      }
    if (x1 > x0) touch(m, x0, y0, x1, y1);
  }

  hash(h: number): number {
    let x = Math.imul(h ^ (this.turns + 977 * this.organs + 31 * this.stage), 0x01000193);
    for (const s of this.spokes) x = Math.imul(x ^ (s.at + (s.done ? 1 << 24 : 0)), 0x01000193);
    return (Math.imul(x ^ this.nextWrong, 0x01000193) >>> 0) as number;
  }
}
