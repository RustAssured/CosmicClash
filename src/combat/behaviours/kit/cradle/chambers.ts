import type { MatterMap } from '@/contracts';
import { transmute } from '@/titans/kit/cradle/grow';
import { touch } from './gestate';
import { DMath, sq } from '@/contracts/dmath';

/**
 * DEVELOPMENTAL CHAMBERS (Gate 3, brief: "damage ruptures membrane layers and exposes nested developmental chambers. Some
 * hold half-formed organs that clearly belong to no known species"). The Cradle's own wounds are watched: where a blow has
 * opened a hole in the disc or the knot, the tissue round the hole darkens into a chamber wall, and inside it, on the live
 * cells nearest the hole, something has been developing: a fluid sac with a dark mass in it, a cluster of bone nodules, a
 * knot of vessels, a lobe of core-dark tissue — chosen per wound, never twice the same in one place.
 *
 * Works on the Cradle's own maps (its own material table), comparing them with the pristine painted maps. Deterministic.
 */

export interface ChamberIds {
  membrane: number;
  vessel: number;
  collagen: number;
  muscle: number;
  bone: number;
  sac: number;
  lumen: number;
  core: number;
}

/** Wound grid (cells): one chamber per cell of this size, opened once. */
const GRID = 9;
/** A grid cell with at least this many lost cells is a wound. */
const MIN_LOST = 7;

const ihash = (a: number, b: number, s: number): number => {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};

export class Chambers {
  /** Opened grid cells per watched map (key: map → set of grid indices). */
  private readonly opened = new Map<MatterMap, Set<number>>();
  /** Chambers opened (instrumentation, hash). */
  count = 0;

  /**
   * Look for new wounds in `live` (the body's map now) against `pristine` (as painted, same size) and open chambers there.
   * Returns how many opened this call. Cheap enough every 15 ticks: one pass over the map.
   */
  watch(
    live: MatterMap,
    pristine: MatterMap,
    ramps: readonly (readonly number[])[],
    ids: ChamberIds,
    seed: number,
  ): number {
    const w = live.w;
    const h = live.h;
    if (pristine.w !== w || pristine.h !== h) return 0;
    let set = this.opened.get(live);
    if (!set) this.opened.set(live, (set = new Set()));
    const gw = Math.ceil(w / GRID);
    const gh = Math.ceil(h / GRID);
    const lost = new Uint16Array(gw * gh);
    const sx = new Float32Array(gw * gh);
    const sy = new Float32Array(gw * gh);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (pristine.material[i] === 0 || live.material[i] !== 0) continue;
        const g = Math.floor(y / GRID) * gw + Math.floor(x / GRID);
        lost[g]!++;
        sx[g] = sx[g]! + x + 0.5;
        sy[g] = sy[g]! + y + 0.5;
      }
    let opened = 0;
    for (let g = 0; g < lost.length; g++) {
      if (lost[g]! < MIN_LOST || set.has(g)) continue;
      // a wound that only nibbled the outline is not a chamber: it must have live tissue round it on several sides
      const cx = sx[g]! / lost[g]!;
      const cy = sy[g]! / lost[g]!;
      if (!this.enclosed(live, cx, cy)) continue;
      set.add(g);
      this.open(live, cx, cy, ramps, ids, seed + g * 131);
      opened++;
      this.count++;
    }
    return opened;
  }

  /** Live tissue on at least 5 of 8 directions within 12 px of the wound's centre. */
  private enclosed(m: MatterMap, cx: number, cy: number): boolean {
    let n = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      for (let d = 2; d <= 12; d++) {
        const x = Math.floor(cx + DMath.cos(a) * d);
        const y = Math.floor(cy + DMath.sin(a) * d);
        if (x < 0 || y < 0 || x >= m.w || y >= m.h) break;
        if (m.material[y * m.w + x] !== 0) {
          n++;
          break;
        }
      }
    }
    return n >= 5;
  }

  private open(
    m: MatterMap,
    cx: number,
    cy: number,
    ramps: readonly (readonly number[])[],
    ids: ChamberIds,
    seed: number,
  ): void {
    // the chamber wall: the live rim round the hole darkens into muscle (shadow in a cavity)
    const R = 9;
    transmute(
      m,
      ramps,
      (mat, x, y) => {
        const d = DMath.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d > R || mat === ids.core) return 0;
        return nearVoid(m, x, y) ? ids.muscle : 0;
      },
      seed,
      -0.35,
    );
    // what was developing in there: on the live cells nearest the hole, a small wrong organ
    const kind = Math.floor(ihash(1, 2, seed) * 4);
    // the organ's centre: the live cell nearest the hole's centre, pushed one step into the tissue
    let best = Infinity;
    let ox = cx;
    let oy = cy;
    for (let y = Math.floor(cy - R); y <= cy + R; y++)
      for (let x = Math.floor(cx - R); x <= cx + R; x++) {
        if (x < 0 || y < 0 || x >= m.w || y >= m.h || m.material[y * m.w + x] === 0) continue;
        const d = sq(x + 0.5 - cx) + sq(y + 0.5 - cy);
        if (d < best) {
          best = d;
          ox = x + 0.5;
          oy = y + 0.5;
        }
      }
    const dl = DMath.hypot(ox - cx, oy - cy) || 1;
    ox += ((ox - cx) / dl) * 2.5;
    oy += ((oy - cy) / dl) * 2.5;
    const r = 2.6 + ihash(3, 4, seed) * 2.2;
    const inside = (x: number, y: number, rr: number): boolean =>
      DMath.hypot(x + 0.5 - ox, y + 0.5 - oy) < rr;
    if (kind === 0) {
      // a fluid sac with a dark mass curled in it
      transmute(m, ramps, (mat, x, y) => (mat !== 0 && inside(x, y, r) ? ids.sac : 0), seed, 0.15);
      transmute(m, ramps, (mat, x, y) => (mat !== 0 && inside(x, y, r * 0.45) ? ids.core : 0), seed + 1, 0.2);
    } else if (kind === 1) {
      // bone nodules, clustered like teeth that belong to nothing
      for (let k = 0; k < 4; k++) {
        const a = ihash(k, 9, seed) * Math.PI * 2;
        const nx = ox + DMath.cos(a) * r * 0.7;
        const ny = oy + DMath.sin(a) * r * 0.7;
        transmute(
          m,
          ramps,
          (mat, x, y) => (mat !== 0 && DMath.hypot(x + 0.5 - nx, y + 0.5 - ny) < 1.6 ? ids.bone : 0),
          seed + k,
          0.25,
        );
      }
    } else if (kind === 2) {
      // a tangle of vessels with a pale cord through it
      transmute(
        m,
        ramps,
        (mat, x, y) =>
          mat !== 0 && inside(x, y, r)
            ? DMath.sin((x + y) * 1.3 + seed) > 0.2
              ? ids.vessel
              : ids.collagen
            : 0,
        seed,
        0.1,
      );
    } else {
      // a lobe of core-dark tissue with a cold glint (failing anatomy)
      transmute(m, ramps, (mat, x, y) => (mat !== 0 && inside(x, y, r) ? ids.core : 0), seed, 0.1);
      transmute(m, ramps, (mat, x, y) => (mat !== 0 && inside(x, y, 1.1) ? ids.lumen : 0), seed + 2, 0.4);
    }
    touch(m, Math.floor(cx - R - 1), Math.floor(cy - R - 1), Math.ceil(cx + R + 1), Math.ceil(cy + R + 1));
  }

  reset(): void {
    this.opened.clear();
  }

  hash(h: number): number {
    return Math.imul(h ^ (this.count * 2654435761), 0x01000193) >>> 0;
  }
}

/** A live cell with a void neighbour (8-connected). */
function nearVoid(m: MatterMap, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) return true;
      if (m.material[ny * m.w + nx] === 0) return true;
    }
  return false;
}
