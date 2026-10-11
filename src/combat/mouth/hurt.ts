import type { DamageShape, OverlapResult } from '@/contracts';
import { shapeBounds, shapeContains, type Bounds } from '../shapes';
import type { MouthCore } from './core';
import { MOUTH_CONST as C, MOUTH_LIVE } from './tuning';

/**
 * The Mouth's hurtboxes (Gate 3A §2, D37): the analytic-fighter contract. The Mouth is not matter; it is hit as capsules:
 *  - head: one capsule along the funnel axis from the lips back `headBack` px, r = Rh (58): its far reach ≈ the prototype's
 *    1.35 Rh head radius;
 *  - neck: 23 capsules between the 24 neck samples, r = the braid radius (25 − 7f)·vol + `neckPad` (≈ 21–28 px);
 *  - coils: capsules along the visible coil spine, r = 40 (the prototype's coil hit radius), only where they reach into the arena.
 * `probe` answers an attacker's shape with a synthetic overlap (sampled area in px², centroid, nearest point), so the
 * attacker's `strike()` / deepest-bite rules work unchanged; `deepest` names the part the blow lands on (the capsule it
 * overlaps most deeply).
 */
export type MouthPart = 'head' | 'neck' | 'coil';
export interface Capsule {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  r: number;
  part: MouthPart;
  /** Neck: arc fraction 0..1 at the capsule's middle; coil: perimeter offset (px) from the anchor; head: 0. */
  at: number;
}

const MAX_CAPS = 40;

export class MouthHurt {
  readonly caps: Capsule[] = [];
  n = 0;
  /** Union box of the capsules (world px). */
  readonly box: Bounds = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private readonly sb: Bounds = { x0: 0, y0: 0, x1: 0, y1: 0 };
  /** The last `deepest` result. */
  readonly hit = { part: 'head' as MouthPart, at: 0, x: 0, y: 0, depth: -1 };

  constructor() {
    for (let i = 0; i < MAX_CAPS; i++)
      this.caps.push({ x0: 0, y0: 0, x1: 0, y1: 0, r: 0, part: 'head', at: 0 });
  }

  private add(x0: number, y0: number, x1: number, y1: number, r: number, part: MouthPart, at: number): void {
    if (this.n >= MAX_CAPS) return;
    const c = this.caps[this.n++]!;
    c.x0 = x0;
    c.y0 = y0;
    c.x1 = x1;
    c.y1 = y1;
    c.r = r;
    c.part = part;
    c.at = at;
    const b = this.box;
    b.x0 = Math.min(b.x0, x0 - r, x1 - r);
    b.y0 = Math.min(b.y0, y0 - r, y1 - r);
    b.x1 = Math.max(b.x1, x0 + r, x1 + r);
    b.y1 = Math.max(b.y1, y0 + r, y1 + r);
  }

  /** This tick's capsules, from the crane's state. Nothing is hittable once it is knocked out. */
  refresh(core: MouthCore): void {
    this.n = 0;
    const b = this.box;
    b.x0 = b.y0 = 1e9;
    b.x1 = b.y1 = -1e9;
    if (core.dmg.ko) return;
    const NS = C.neckSamples;
    const nk = core.neck;
    // head: along the funnel axis (from the sample three back toward the head), lips first
    const hx = core.hdX;
    const hy = core.hdY;
    const bq = (NS - 4) * 4;
    let ax = hx - nk[bq]!;
    let ay = hy - nk[bq + 1]!;
    const al = Math.hypot(ax, ay) || 1;
    ax /= al;
    ay /= al;
    const back = MOUTH_LIVE.headBack;
    this.add(hx, hy, hx - ax * back, hy - ay * back, C.Rh, 'head', 0);
    // neck: braid radius × volume (stretched → thinner)
    let L = 0;
    for (let i = 1; i < NS; i++)
      L += Math.hypot(nk[i * 4]! - nk[i * 4 - 4]!, nk[i * 4 + 1]! - nk[i * 4 - 3]!);
    const vol = Math.max(0.82, Math.min(1.22, Math.sqrt(250 / Math.max(120, L))));
    for (let i = 1; i < NS; i++) {
      const f = (i - 0.5) / (NS - 1);
      this.add(
        nk[i * 4 - 4]!,
        nk[i * 4 - 3]!,
        nk[i * 4]!,
        nk[i * 4 + 1]!,
        (25 - 7 * f) * vol + MOUTH_LIVE.neckPad,
        'neck',
        f,
      );
    }
    // coils: the spine's segments that reach into the arena (beyond the edge they are not hittable)
    const sp = core.coilSpine;
    const r = MOUTH_LIVE.coilR;
    const ax0 = core.ax0;
    const ay0 = core.ay0;
    const ax1 = core.ax0 + core.aw;
    const ay1 = core.ay0 + core.ah;
    const inside = (x: number, y: number): boolean =>
      x > ax0 - r && x < ax1 + r && y > ay0 - r && y < ay1 + r;
    const OFFS = [-330, -240, -150, -70, 0, 80, 160, 250, 340];
    for (let i = 0; i < 8; i++) {
      const x0 = sp[i * 2]!;
      const y0 = sp[i * 2 + 1]!;
      const x1 = sp[i * 2 + 2]!;
      const y1 = sp[i * 2 + 3]!;
      if (!inside(x0, y0) && !inside(x1, y1)) continue;
      this.add(x0, y0, x1, y1, r, 'coil', (OFFS[i]! + OFFS[i + 1]!) / 2);
    }
  }

  /** Distance from (x, y) to capsule c's axis segment. */
  private static dist(c: Capsule, x: number, y: number): number {
    const dx = c.x1 - c.x0;
    const dy = c.y1 - c.y0;
    const l2 = dx * dx + dy * dy;
    const u = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - c.x0) * dx + (y - c.y0) * dy) / l2)) : 0;
    return Math.hypot(x - (c.x0 + dx * u), y - (c.y0 + dy * u));
  }

  /**
   * Overlap of a damage shape with the capsules, sampled on a grid (2 px, coarser for huge shapes: ≤ ~4000 samples). Fills
   * `out` like the matter world's overlap (cells = px²) and `hit` with the deepest capsule.
   */
  probe(shape: DamageShape, out: OverlapResult): OverlapResult {
    out.cells = 0;
    out.x = NaN;
    out.y = NaN;
    out.nearestX = NaN;
    out.nearestY = NaN;
    out.coverage = 0;
    const h = this.hit;
    h.depth = -1;
    if (this.n === 0) return out;
    const sb = shapeBounds(shape, this.sb);
    const b = this.box;
    const x0 = Math.max(sb.x0, b.x0);
    const y0 = Math.max(sb.y0, b.y0);
    const x1 = Math.min(sb.x1, b.x1);
    const y1 = Math.min(sb.y1, b.y1);
    if (x1 <= x0 || y1 <= y0) return out;
    const step = Math.max(2, Math.ceil(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4000)));
    const ox = shapeOriginX(shape);
    const oy = shapeOriginY(shape);
    let cnt = 0;
    let sx = 0;
    let sy = 0;
    let bestN = 1e18;
    let shapeCells = 0;
    for (let y = Math.floor(y0) + step * 0.5; y < y1; y += step)
      for (let x = Math.floor(x0) + step * 0.5; x < x1; x += step) {
        if (!shapeContains(shape, x, y)) continue;
        shapeCells++;
        let inAny = false;
        for (let i = 0; i < this.n; i++) {
          const c = this.caps[i]!;
          const d = MouthHurt.dist(c, x, y);
          if (d > c.r) continue;
          inAny = true;
          const depth = c.r - d;
          // the head and the neck are the targets; a coil only takes what nothing else does
          const w = c.part === 'coil' ? depth - 30 : depth;
          if (w > h.depth) {
            h.depth = w;
            h.part = c.part;
            h.at = c.at;
            h.x = x;
            h.y = y;
          }
        }
        if (!inAny) continue;
        cnt++;
        sx += x;
        sy += y;
        const dn = (x - ox) * (x - ox) + (y - oy) * (y - oy);
        if (dn < bestN) {
          bestN = dn;
          out.nearestX = x;
          out.nearestY = y;
        }
      }
    if (cnt === 0) return out;
    out.cells = cnt * step * step;
    out.x = sx / cnt;
    out.y = sy / cnt;
    out.coverage = shapeCells > 0 ? cnt / shapeCells : 0;
    return out;
  }
}

function shapeOriginX(s: DamageShape): number {
  return s.kind === 'line' ? s.x0 : s.x;
}
function shapeOriginY(s: DamageShape): number {
  return s.kind === 'line' ? s.y0 : s.y;
}
