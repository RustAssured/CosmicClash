import { hex, pb, pg, pr, type MaterialSpec, type MatterMap, type RenderLayer } from '@/contracts';
import { DMath } from '@/contracts/dmath';
import type { WitnessBody } from '@/titans/art/lastone';
import { BAY8, BodySkin, IdleClock, IdleRng, Pool, clampN, fcos, fsin, h2, ss } from '../fx/idle';
import type { Overlay } from '../fx/overlay';

/**
 * THE LAST ONE'S LIVING IDLE, render side (repo id `colossus`; idle handover specs/last-one.md, prototype
 * `colossus.src.html`). The motion that is hit (the breath, the body, the scythes, the halo, the chandelier, the witnessing's
 * clock) is sim state in colossusPose.ts; everything here only recolours, stepped once per sim tick from that tick's inputs.
 *  - The region atlas is recoloured in source space before the parts rotate (so 1-px glints survive the 3×3 vote):
 *    the carapace swells a rim on the in-breath, its seams part to show the channels, the lattice and the abyss (its inner
 *    eyes open for the witnessing), crack waves run the fracture network; the scythes carry vein signals and edge glints,
 *    their gold sparkles, their orb-eyes peek and all open to stare for the witnessing; the chandelier's spires swing (drawn
 *    only, WJ) and gold drips run down them; the halo arcs brighten while witnessing.
 *  - The great eye (the primary body, as a skin): saccades with overshoot, a glance at nothing; the pupil breathes a ring and
 *    goes to a pinpoint when it witnesses; no blink (WJ: "it just sees").
 *  - An overlay behind the atlas: the light ring completing from the sigil, the crosshair ticks, dust off the snapped spires.
 *  - The reticle and the line of sight (`drawReticle`) are a pure function of the sim's witnessing clock.
 * Every colour is a step along the Last One's own ladders (its painted colours and ramps, by luminance).
 */

export interface ColossusIdleInput {
  t: number;
  w: number;
  wit: number;
  b: number;
  ax: number;
  sAcc: number;
  ko: boolean;
  /** The foe relative to the eye's centre (px; x in the facing frame). */
  foeX: number;
  foeY: number;
}

const RING = 16;
const DT = IdleClock.DT;
const TAU = Math.PI * 2;
const FIGHT_FLAGS = 1 | 2 | 4 | 8 | 64;
const EM = 255;
const lum = (c: number): number => 0.3 * pr(c) + 0.59 * pg(c) + 0.11 * pb(c);

interface Orb {
  reg: number;
  arm: number;
  cx: number;
  cy: number;
  r: number;
  open: number;
  peekT0: number;
  peekDur: number;
  gx: number;
  gy: number;
}
interface Spire {
  y0: number;
  y1: number;
  bx: number;
  len: number;
  a: number;
  v: number;
  w: number;
  ph: number;
}
interface Dust {
  sp: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  c: number;
}

/** BFS distances over a region's live cells (65535 = unreached). */
function bfs(
  w: number,
  h: number,
  mat: Uint8Array,
  seed: (i: number) => boolean,
  pass: (i: number) => boolean,
  conn8: boolean,
  cap: number,
): Uint16Array {
  const n = w * h;
  const D = new Uint16Array(n).fill(65535);
  const q = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  for (let i = 0; i < n; i++)
    if (mat[i] && seed(i)) {
      D[i] = 0;
      q[qt++] = i;
    }
  while (qh < qt) {
    const j = q[qh++]!;
    const x = j % w;
    const y = (j - x) / w;
    const d = D[j]! + 1;
    if (d > cap) continue;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || (!conn8 && dx && dy)) continue;
        const X = x + dx;
        const Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const k = Y * w + X;
        if (!mat[k] || D[k]! <= d || !pass(k)) continue;
        D[k] = d;
        q[qt++] = k;
      }
  }
  return D;
}

export class ColossusIdle {
  private readonly W: WitnessBody;
  private readonly id: Record<string, number>;
  private readonly ramps: number[][] = [];
  private readonly lad: number[][] = [];
  private readonly rank: Map<number, number>[] = [];
  private ready = false;
  /* regions */
  readonly car: number;
  private readonly inter: number[] = [];
  readonly shrine: number;
  readonly halos: number[] = [];
  readonly arms: number[] = [];
  private readonly dv: Uint16Array;
  /** Carapace cells within 7 px of a seam (the most the reveal reaches), nearest first. */
  private readonly carL: Int32Array;
  private readonly net: Uint16Array[] = [];
  private readonly rimX: Int16Array;
  private readonly rimY: Int16Array;
  private readonly rimSrc: Int32Array;
  private readonly rimRing: Uint8Array;
  private readonly abE: Int16Array;
  private readonly abOpen: Float32Array;
  private readonly abPh: Float32Array;
  /* arms: per region (by index), arc length, edge, orb id and offset */
  private readonly armS = new Map<number, Float32Array>();
  private readonly armL = new Map<number, Int32Array>();
  private readonly armEdge = new Map<number, Uint8Array>();
  private readonly armOrb = new Map<number, Int16Array>();
  private readonly armOdx = new Map<number, Int8Array>();
  private readonly armOdy = new Map<number, Int8Array>();
  private readonly orbs: Orb[] = [];
  private readonly orbOrder: Int16Array;
  private orbLate = 0;
  /* the chandelier */
  private readonly collar: number;
  private readonly spOf: Int16Array;
  /** Shrine cells a drip or the witnessing can touch (the spires below the collar, the gold and lattice). */
  private readonly shrL: Int32Array;
  private readonly spires: Spire[] = [];
  private readonly snapped: number[] = [];
  /* the eye */
  private readonly ec: [number, number];
  private readonly ic: [number, number];
  private readonly pc: [number, number];
  private readonly rp: number;
  private readonly ri: number;
  private readonly rs: number;
  /* state */
  readonly clock = new IdleClock();
  private readonly ringIn: ColossusIdleInput[];
  private readonly ringA0: Float64Array;
  private readonly ringTick = new Int32Array(RING).fill(-1);
  private readonly lastIn: ColossusIdleInput;
  private readonly lastA0: Float64Array;
  private readonly rng: IdleRng;
  private readonly seed: number;
  private steps = 0;
  private T = 0;
  private witT0 = -1;
  private nextWave = 48;
  private nextVein = 72;
  private nextGlint = 120;
  private nextDrip = 90;
  private nextPeek = 150;
  private nextSac = 72;
  private readonly waves = new Pool<{ k: number; t0: number }>(8, () => ({ k: 0, t0: 0 }));
  private readonly drips = new Pool<{ sp: number; t0: number }>(10, () => ({ sp: 0, t0: 0 }));
  private readonly dust = new Pool<Dust>(80, () => ({
    sp: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    age: 0,
    life: 1,
    c: 0,
  }));
  private readonly armWave: Float32Array;
  private readonly armGlint: Float32Array;
  /* the eye's saccade */
  private gx = 0;
  private gy = 0;
  private sOn = false;
  private sT0 = 0;
  private sFx = 0;
  private sFy = 0;
  private sTx = 0;
  private sTy = 0;
  private lookA = 0;
  private lookUntil = -1;
  private k = 0;
  private readonly skin: BodySkin;
  private skinVer = -1;
  private dirty = true;

  constructor(W: WitnessBody, ids: Record<string, number>, materials: readonly MaterialSpec[], seed: number) {
    this.W = W;
    this.id = ids;
    this.seed = seed;
    this.rng = new IdleRng(seed);
    materials.forEach((m, i) => (this.ramps[i + 1] = m.visual.ramp.map((h) => (hex(h) | 0xff000000) >>> 0)));
    const R = W.regions;
    const I = ids;
    this.car = R.findIndex((r) => r.kind === 'carapace');
    for (const L of [1, 2, 3]) this.inter[L] = R.findIndex((r) => r.layer === L);
    this.shrine = R.findIndex((r) => r.kind === 'shrine');
    R.forEach((r, i) => {
      if (r.kind === 'halo') this.halos.push(i);
      if (r.kind === 'arm') this.arms.push(i);
    });
    // ---- the carapace: distance to the nearest seam; the fracture network from six sources; the breath's growth rims
    const CA = R[this.car]!.map;
    const isSeam = (i: number): boolean => CA.material[i] === I['vein'] || CA.material[i] === I['hairline'];
    this.dv = bfs(CA.w, CA.h, CA.material, isSeam, () => true, false, 12);
    const near: number[] = [];
    for (let i = 0; i < CA.material.length; i++) if (CA.material[i] && this.dv[i]! <= 7) near.push(i);
    near.sort((a, b) => this.dv[a]! - this.dv[b]! || a - b);
    this.carL = Int32Array.from(near);
    const seams: number[] = [];
    for (let i = 0; i < CA.material.length; i++) if (CA.material[i] && isSeam(i)) seams.push(i);
    for (let k = 0; k < 6 && seams.length; k++) {
      const src = seams[Math.floor(h2(k, 91) * seams.length)]!;
      this.net.push(bfs(CA.w, CA.h, CA.material, (i) => i === src, isSeam, true, 400));
    }
    {
      const r = R[this.car]!;
      const occ = (x: number, y: number): boolean =>
        x >= 0 && y >= 0 && x < CA.w && y < CA.h && CA.material[y * CA.w + x] !== 0;
      const rad = (x: number, y: number): number => DMath.hypot(r.ox + x + 0.5, r.oy + y + 0.5 - 2.7);
      const rx: number[] = [];
      const ry: number[] = [];
      const rs: number[] = [];
      const rr: number[] = [];
      const taken = new Set<number>();
      let front: { x: number; y: number; src: number }[] = [];
      for (let i = 0; i < CA.material.length; i++)
        if (CA.material[i]) front.push({ x: i % CA.w, y: Math.floor(i / CA.w), src: i });
      for (let ring = 1; ring <= 2; ring++) {
        const next: { x: number; y: number; src: number }[] = [];
        for (const v of front)
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const X = v.x + dx;
            const Y = v.y + dy;
            const key = (Y + 8) * 4096 + X + 8;
            if (occ(X, Y) || taken.has(key)) continue;
            const d = rad(X, Y);
            if (d < 27 || d <= rad(v.x, v.y)) continue;
            taken.add(key);
            next.push({ x: X, y: Y, src: v.src });
            // drawn only where the atlas has room (inside the region's own map)
            if (X >= 0 && Y >= 0 && X < CA.w && Y < CA.h) {
              rx.push(X);
              ry.push(Y);
              rs.push(v.src);
              rr.push(ring);
            }
          }
        front = next;
      }
      this.rimX = Int16Array.from(rx);
      this.rimY = Int16Array.from(ry);
      this.rimSrc = Int32Array.from(rs);
      this.rimRing = Uint8Array.from(rr);
    }
    // ---- the abyss's closed inner eyes
    const AB = this.inter[3]! >= 0 ? R[this.inter[3]!]!.map : null;
    this.abE = new Int16Array(AB ? AB.material.length : 0).fill(-1);
    const abPh: number[] = [];
    if (AB) {
      const seen = new Uint8Array(AB.material.length);
      const isE = (m: number): boolean => m === I['sclera'] || m === I['pupil'];
      for (let i = 0; i < AB.material.length; i++) {
        if (!isE(AB.material[i]!) || seen[i]) continue;
        const e = abPh.length;
        const q = [i];
        seen[i] = 1;
        while (q.length) {
          const j = q.pop()!;
          this.abE[j] = e;
          const x = j % AB.w;
          const y = (j - x) / AB.w;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const X = x + dx;
              const Y = y + dy;
              if (X < 0 || Y < 0 || X >= AB.w || Y >= AB.h) continue;
              const k = Y * AB.w + X;
              if (!seen[k] && isE(AB.material[k]!)) {
                seen[k] = 1;
                q.push(k);
              }
            }
        }
        abPh.push(this.rng.next() * 9);
      }
    }
    this.abPh = Float32Array.from(abPh);
    this.abOpen = new Float32Array(abPh.length);
    // ---- the scythes: arc length along the limb, edges, orb-eyes
    for (const ri of this.arms) {
      const r = R[ri]!;
      const m = r.map;
      const P = W.arms[r.arm]!.points;
      const segL: number[] = [];
      let tot = 0;
      for (let k = 0; k < P.length - 1; k++) {
        const l = DMath.hypot(P[k + 1]!.x - P[k]!.x, P[k + 1]!.y - P[k]!.y);
        segL.push(l);
        tot += l;
      }
      const n = m.w * m.h;
      const s = new Float32Array(n);
      const edge = new Uint8Array(n);
      const orb = new Int16Array(n).fill(-1);
      const odx = new Int8Array(n);
      const ody = new Int8Array(n);
      for (let y = 0; y < m.h; y++)
        for (let x = 0; x < m.w; x++) {
          const i = y * m.w + x;
          if (!m.material[i]) continue;
          const bx = r.ox + x + 0.5;
          const by = r.oy + y + 0.5;
          let best = 1e9;
          let bs = 0;
          let acc = 0;
          for (let k = 0; k < P.length - 1; k++) {
            const ax = P[k]!.x;
            const ay = P[k]!.y;
            const dx = P[k + 1]!.x - ax;
            const dy = P[k + 1]!.y - ay;
            const L2 = dx * dx + dy * dy || 1;
            const tt = clampN(((bx - ax) * dx + (by - ay) * dy) / L2, 0, 1);
            const d = DMath.hypot(ax + dx * tt - bx, ay + dy * tt - by);
            if (d < best) {
              best = d;
              bs = (acc + tt * segL[k]!) / (tot || 1);
            }
            acc += segL[k]!;
          }
          s[i] = bs;
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const X = x + dx;
            const Y = y + dy;
            if (X < 0 || Y < 0 || X >= m.w || Y >= m.h || !m.material[Y * m.w + X]) edge[i] = 1;
          }
        }
      const isO = (mm: number): boolean => mm === I['orb'] || mm === I['iris'] || mm === I['pupil'];
      const seen = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (!isO(m.material[i]!) || seen[i]) continue;
        const q = [i];
        const list: number[] = [];
        seen[i] = 1;
        while (q.length) {
          const j = q.pop()!;
          list.push(j);
          const x = j % m.w;
          const y = (j - x) / m.w;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const X = x + dx;
              const Y = y + dy;
              if (X < 0 || Y < 0 || X >= m.w || Y >= m.h) continue;
              const k = Y * m.w + X;
              if (!seen[k] && isO(m.material[k]!)) {
                seen[k] = 1;
                q.push(k);
              }
            }
        }
        if (list.length < 5) continue;
        let sx = 0;
        let sy = 0;
        for (const j of list) {
          sx += j % m.w;
          sy += Math.floor(j / m.w);
        }
        const cx = Math.round(sx / list.length);
        const cy = Math.round(sy / list.length);
        let rad = 0;
        for (const j of list) rad = Math.max(rad, Math.abs(Math.floor(j / m.w) - cy));
        const id = this.orbs.length;
        this.orbs.push({
          reg: ri,
          arm: r.arm,
          cx,
          cy,
          r: Math.max(1, rad),
          open: 0,
          peekT0: -1,
          peekDur: 0,
          gx: 0,
          gy: 0,
        });
        for (const j of list) {
          orb[j] = id;
          odx[j] = (j % m.w) - cx;
          ody[j] = Math.floor(j / m.w) - cy;
        }
      }
      const live: number[] = [];
      for (let i = 0; i < n; i++) {
        const mm = m.material[i]!;
        if (mm && (orb[i]! >= 0 || edge[i] || mm === I['vein'] || mm === I['gold'] || mm === I['lattice']))
          live.push(i);
      }
      this.armL.set(ri, Int32Array.from(live));
      this.armS.set(ri, s);
      this.armEdge.set(ri, edge);
      this.armOrb.set(ri, orb);
      this.armOdx.set(ri, odx);
      this.armOdy.set(ri, ody);
    }
    this.orbOrder = new Int16Array(this.orbs.length);
    // ---- the chandelier: the collar, then each spire as its own pendulum
    {
      const SH = R[this.shrine]!.map;
      const cnt = new Array<number>(SH.h).fill(0);
      for (let i = 0; i < SH.material.length; i++) if (SH.material[i]) cnt[Math.floor(i / SH.w)]!++;
      const mx = Math.max(...cnt);
      let top = 0;
      while (top < SH.h && cnt[top]! < mx * 0.15) top++;
      let col = top;
      while (col < SH.h && cnt[col]! > mx * 0.5) col++;
      this.collar = col + 1;
      this.spOf = new Int16Array(SH.material.length).fill(-1);
      const sl: number[] = [];
      for (let i = 0; i < SH.material.length; i++) {
        const mm = SH.material[i]!;
        if (mm && (Math.floor(i / SH.w) >= this.collar || mm === I['gold'] || mm === I['lattice']))
          sl.push(i);
      }
      this.shrL = Int32Array.from(sl);
      const seen = new Uint8Array(SH.material.length);
      for (let i = 0; i < SH.material.length; i++) {
        if (!SH.material[i] || seen[i] || Math.floor(i / SH.w) < this.collar) continue;
        const q = [i];
        const list: number[] = [];
        seen[i] = 1;
        while (q.length) {
          const j = q.pop()!;
          list.push(j);
          const x = j % SH.w;
          const y = (j - x) / SH.w;
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ] as const) {
            const X = x + dx;
            const Y = y + dy;
            if (X < 0 || Y < this.collar || X >= SH.w || Y >= SH.h) continue;
            const k = Y * SH.w + X;
            if (SH.material[k] && !seen[k]) {
              seen[k] = 1;
              q.push(k);
            }
          }
        }
        let y1 = -1;
        let bx = 0;
        for (const j of list) {
          const y = Math.floor(j / SH.w);
          if (y > y1) {
            y1 = y;
            bx = j % SH.w;
          }
        }
        const id = this.spires.length;
        this.spires.push({
          y0: this.collar,
          y1,
          bx,
          len: y1 - this.collar + 1,
          a: 0,
          v: 0,
          w: 2.2 + this.rng.next() * 1.6,
          ph: this.rng.next() * 9,
        });
        for (const j of list) this.spOf[j] = id;
      }
      const major = this.spires.map((s, i) => [s.len, i] as const).filter(([l]) => l > 8);
      major.sort((a, b) => a[0] - b[0]);
      for (const [, i] of major.slice(0, 2)) this.snapped.push(i);
    }
    // ---- the eye: centres and radii (body coordinate origin = the eye's centre)
    {
      const r = R[0]!;
      const E = r.map;
      let sx = 0;
      let sy = 0;
      let c = 0;
      let px = 0;
      let py = 0;
      let pc = 0;
      for (let y = 0; y < E.h; y++)
        for (let x = 0; x < E.w; x++) {
          const m = E.material[y * E.w + x];
          if (m === I['iris'] || m === I['pupil']) {
            sx += x + 0.5;
            sy += y + 0.5;
            c++;
          }
          if (m === I['pupil']) {
            px += x + 0.5;
            py += y + 0.5;
            pc++;
          }
        }
      this.ic = [c ? sx / c : -r.ox, c ? sy / c : -r.oy];
      this.pc = [pc ? px / pc : this.ic[0], pc ? py / pc : this.ic[1]];
      this.rp = Math.sqrt(pc / Math.PI);
      this.ec = [-r.ox, -r.oy];
      let ri = 0;
      let rs = 0;
      for (let y = 0; y < E.h; y++)
        for (let x = 0; x < E.w; x++) {
          const m = E.material[y * E.w + x];
          if (m === I['iris']) ri = Math.max(ri, DMath.hypot(x + 0.5 - this.ic[0], y + 0.5 - this.ic[1]));
          if (m === I['sclera']) rs = Math.max(rs, DMath.hypot(x + 0.5 - this.ec[0], y + 0.5 - this.ec[1]));
        }
      this.ri = ri + 1;
      this.rs = rs;
      this.skin = new BodySkin(E.w, E.h);
    }
    this.armWave = new Float32Array(W.arms.length).fill(-9);
    this.armGlint = new Float32Array(W.arms.length).fill(-9);
    this.build(R.map((r) => r.map));
    const mk = (): ColossusIdleInput => ({
      t: 0,
      w: 0,
      wit: -1,
      b: 0,
      ax: 0,
      sAcc: 0,
      ko: false,
      foeX: 100,
      foeY: 0,
    });
    this.ringIn = Array.from({ length: RING }, mk);
    this.lastIn = mk();
    this.ringA0 = new Float64Array(RING * W.arms.length);
    this.lastA0 = new Float64Array(W.arms.length);
  }

  /**
   * Ladders from the painted template (every region's `baseColor`) and the ramps, at construction: nothing here depends on
   * when the first frame is drawn (a live colour that is not on its ladder is placed by its luminance).
   */
  private build(maps: readonly MatterMap[]): void {
    const sets: Set<number>[] = [];
    for (const m of maps) {
      for (let i = 0; i < m.material.length; i++) {
        const mm = m.material[i]!;
        if (!mm || !m.baseColor[i]) continue;
        (sets[mm] ??= new Set()).add((m.baseColor[i]! | 0xff000000) >>> 0);
      }
    }
    for (let mm = 1; mm < this.ramps.length; mm++) {
      const s = (sets[mm] ??= new Set());
      for (const c of this.ramps[mm] ?? []) s.add(c);
      const L = [...s].sort((a, b) => lum(a) - lum(b));
      this.lad[mm] = L;
      const Rk = new Map<number, number>();
      L.forEach((c, k) => Rk.set(c, k));
      this.rank[mm] = Rk;
    }
    this.ready = true;
  }
  /** A colour's place on material m's ladder: exact, or by its luminance (the lit pixels shade the painted colours). */
  private rankOf(c: number, m: number): number {
    const L = this.lad[m];
    if (!L || !L.length) return -1;
    const r = this.rank[m]?.get(c >>> 0);
    if (r !== undefined) return r;
    const v = lum(c);
    let lo = 0;
    let hi = L.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lum(L[mid]!) < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  private stepC(c: number, m: number, k: number): number {
    const L = this.lad[m];
    const r = this.rankOf(c, m);
    if (!L || r < 0) return c;
    return L[clampN(r + k, 0, L.length - 1)]!;
  }
  private xl(c: number, m: number, m2: number, k: number): number {
    const L = this.lad[m];
    const L2 = this.lad[m2];
    const r = this.rankOf(c, m);
    if (!L || !L2 || r < 0) return c;
    const u = L.length > 1 ? r / (L.length - 1) : 0.5;
    return L2[clampN(Math.round(u * (L2.length - 1)) + k, 0, L2.length - 1)]!;
  }
  ladC(m: number, u: number): number {
    const L = this.lad[m] ?? this.ramps[m] ?? [0xffffffff];
    return L[clampN(Math.round(u * (L.length - 1)), 0, L.length - 1)]!;
  }

  reset(): void {
    this.clock.reset();
    this.rng.reseed(this.seed);
    this.ringTick.fill(-1);
    this.steps = 0;
    this.T = 0;
    this.witT0 = -1;
    this.nextWave = 48;
    this.nextVein = 72;
    this.nextGlint = 120;
    this.nextDrip = 90;
    this.nextPeek = 150;
    this.nextSac = 72;
    this.waves.clear();
    this.drips.clear();
    this.dust.clear();
    this.armWave.fill(-9);
    this.armGlint.fill(-9);
    for (const o of this.orbs) {
      o.open = 0;
      o.peekT0 = -1;
    }
    for (const s of this.spires) s.a = s.v = 0;
    this.abOpen.fill(0);
    this.gx = this.gy = 0;
    this.sOn = false;
    this.lookUntil = -1;
    this.k = 0;
    this.skinVer = -1;
    this.dirty = true;
  }

  record(tick: number, inp: ColossusIdleInput, a0: ArrayLike<number>): void {
    if (this.clock.last < 0) this.clock.last = tick - 1;
    const k = tick & (RING - 1);
    Object.assign(this.ringIn[k]!, inp);
    for (let i = 0; i < this.lastA0.length; i++) this.ringA0[k * this.lastA0.length + i] = a0[i] ?? 0;
    this.ringTick[k] = tick;
    Object.assign(this.lastIn, inp);
    for (let i = 0; i < this.lastA0.length; i++) this.lastA0[i] = a0[i] ?? 0;
  }
  private inputAt(tick: number): { inp: ColossusIdleInput; a0o: number } {
    const k = tick & (RING - 1);
    return this.ringTick[k] === tick
      ? { inp: this.ringIn[k]!, a0o: k * this.lastA0.length }
      : { inp: this.lastIn, a0o: -1 };
  }

  advance(tick: number): boolean {
    const n = this.clock.due(tick);
    for (let i = 0; i < n; i++) {
      const { inp, a0o } = this.inputAt(tick - n + 1 + i);
      this.step(inp, a0o);
    }
    if (n > 0) this.dirty = true;
    return n > 0;
  }

  /** Is the idle drawing anything (the atlas and the eye need recolouring)? */
  get active(): boolean {
    return this.lastIn.w > 0.01 || this.dust.n > 0;
  }

  private step(inp: ColossusIdleInput, a0o: number): void {
    const st = ++this.steps;
    const R = this.rng;
    this.T = inp.t;
    const t = inp.t;
    const W = inp.wit;
    const wit = W >= 0;
    const calm = inp.w > 0.9 && !inp.ko;
    if (wit && this.witT0 < 0) {
      // a new witnessing: the orb-eyes will close in a random ("wrong") order, one of them late
      this.witT0 = st;
      const ord = Array.from(this.orbs, (_, i) => i);
      for (let i = ord.length - 1; i > 0; i--) {
        const j = Math.floor(R.next() * (i + 1));
        [ord[i], ord[j]] = [ord[j]!, ord[i]!];
      }
      ord.forEach((o, pos) => (this.orbOrder[o] = pos));
      this.orbLate = Math.floor(R.next() * Math.max(1, this.orbs.length));
    }
    if (!wit) this.witT0 = -1;
    // ---- signals: crack waves, vein signals, glints, gold drips, dust ----
    if (st > this.nextWave && this.net.length) {
      const wv = this.waves.alloc();
      if (wv) {
        wv.k = Math.floor(R.next() * this.net.length);
        wv.t0 = t;
      }
      this.nextWave = st + 84 + Math.floor(R.next() * 132);
    }
    for (let i = this.waves.n - 1; i >= 0; i--) if (t - this.waves.items[i]!.t0 > 6) this.waves.kill(i);
    if (st > this.nextVein) {
      this.armWave[Math.floor(R.next() * this.armWave.length)] = t;
      this.nextVein = st + 54 + Math.floor(R.next() * 84);
    }
    if (st > this.nextGlint) {
      this.armGlint[Math.floor(R.next() * this.armGlint.length)] = t;
      this.nextGlint = st + 132 + Math.floor(R.next() * 150);
    }
    if (st > this.nextDrip && this.spires.length) {
      const d = this.drips.alloc();
      if (d) {
        d.sp = Math.floor(R.next() * this.spires.length);
        d.t0 = t;
      }
      this.nextDrip = st + 30 + Math.floor(R.next() * 72);
    }
    for (let i = this.drips.n - 1; i >= 0; i--) if (t - this.drips.items[i]!.t0 > 2.5) this.drips.kill(i);
    if (calm && R.next() < DT * 2.2) for (const sp of this.snapped) if (R.next() < 0.5) this.dustOne(sp);
    for (let i = this.dust.n - 1; i >= 0; i--) {
      const p = this.dust.items[i]!;
      p.age += DT;
      if (p.age >= p.life) {
        this.dust.kill(i);
        continue;
      }
      p.vx *= 1 - 0.8 * DT;
      p.vy *= 1 - 0.8 * DT;
      p.x += p.vx * DT;
      p.y += p.vy * DT;
    }
    // ---- the spires: a pendulum each (drawn only), kicked by the body and the chandelier ----
    for (const sp of this.spires) {
      for (let s = 0; s < 4; s++) {
        const tg = DMath.sin(t * (0.6 + sp.w * 0.1) + sp.ph) * 0.012;
        const acc = sp.w * sp.w * (tg - sp.a) - 2 * 0.1 * sp.w * sp.v + inp.ax * 0.004 - inp.sAcc * 0.4;
        sp.v += acc * (DT / 4);
        sp.a = clampN(sp.a + sp.v * (DT / 4), -0.12, 0.12);
      }
    }
    // ---- the great eye: saccades (5 frames, overshoot), the glance at nothing; the pupil ----
    let gaze = DMath.atan2(inp.foeY, inp.foeX);
    let far = clampN(DMath.hypot(inp.foeX, inp.foeY) / 120, 0.4, 1);
    if (st < this.lookUntil) {
      gaze = this.lookA;
      far = 1;
    }
    let wx = clampN(Math.round(fcos(gaze) * 4 * far), -4, 4);
    let wy = clampN(Math.round(fsin(gaze) * 3 * far), -3, 3);
    if (wit && W > 1.6 && W < 3.8) {
      wx = clampN(Math.round(fcos(gaze) * 3), -3, 3);
      wy = clampN(Math.round(fsin(gaze) * 2), -2, 2);
    }
    const forced = wit && W > 1.5 && W < 1.5 + DT * 1.5;
    if (!this.sOn && (st > this.nextSac || forced) && (wx !== this.gx || wy !== this.gy)) {
      this.sOn = true;
      this.sT0 = st;
      this.sFx = this.gx;
      this.sFy = this.gy;
      this.sTx = wx;
      this.sTy = wy;
      this.nextSac = st + 132 + Math.floor(R.next() * 210);
      if (!wit && R.next() < 0.18) {
        this.lookA = R.next() * TAU;
        this.lookUntil = st + 54;
      }
    }
    if (this.sOn) {
      const u = st - this.sT0;
      const dx = this.sTx - this.sFx;
      const dy = this.sTy - this.sFy;
      if (u < 1) {
        this.gx = Math.round(this.sFx + dx * 0.5);
        this.gy = Math.round(this.sFy + dy * 0.5);
      } else if (u < 5 && Math.abs(dx) + Math.abs(dy) >= 2) {
        this.gx = this.sTx + Math.sign(dx);
        this.gy = this.sTy + Math.sign(dy);
      } else {
        this.gx = this.sTx;
        this.gy = this.sTy;
        this.sOn = false;
      }
    }
    this.k = inp.b > 0.78 ? 1 : 0;
    if (wit) {
      if (W > 1.8 && W < 4.2) this.k = -Math.min(4, 1 + Math.floor((W - 1.8) * 16));
      else if (W >= 4.2 && W < 5.2) this.k = -Math.max(0, 4 - Math.floor((W - 4.2) * 5));
    }
    // ---- orb-eyes: dormant slits, a peek, all of them for the witnessing ----
    if (st > this.nextPeek && !wit && this.orbs.length && calm) {
      const o = this.orbs[Math.floor(R.next() * this.orbs.length)]!;
      o.peekT0 = t;
      o.peekDur = 1 + R.next() * 1.5;
      this.nextPeek = st + 108 + Math.floor(R.next() * 150);
    }
    for (let k = 0; k < this.orbs.length; k++) {
      const o = this.orbs[k]!;
      let tg = 0;
      if (o.peekT0 >= 0) {
        const u = t - o.peekT0;
        tg = u < o.peekDur ? 0.55 : 0;
        if (u > o.peekDur + 0.5) o.peekT0 = -1;
      }
      if (wit) {
        const close = 4.0 + this.orbOrder[k]! * 0.055 + (k === this.orbLate ? 1.4 : 0);
        if (W > 1.6 + (k % 7) * 0.012 && W < close) tg = 1;
      }
      tg *= inp.w;
      const sp = tg > o.open ? 9 : 4;
      o.open += clampN(tg - o.open, -sp * DT, sp * DT);
      const reg = this.W.regions[o.reg]!;
      const a0 = a0o >= 0 ? this.ringA0[a0o + o.arm]! : this.lastA0[o.arm]!;
      const a = DMath.atan2(inp.foeY - (reg.oy + o.cy), inp.foeX - (reg.ox + o.cx)) - a0;
      o.gx = Math.round(fcos(a));
      o.gy = Math.round(fsin(a) * 0.8);
    }
    for (let e = 0; e < this.abOpen.length; e++) {
      const tg = wit && W > 1.5 && W < 4.5 ? 1 : DMath.sin(t * 0.31 + this.abPh[e]!) > 0.93 ? 0.5 : 0;
      this.abOpen[e] = this.abOpen[e]! + clampN(tg * inp.w - this.abOpen[e]!, -DT * 2, DT * 3);
    }
  }

  private dustOne(sp: number): void {
    const R = this.rng;
    const p = this.dust.alloc();
    const vx = (R.next() - 0.5) * 6;
    const vy = 4 + R.next() * 10;
    const life = 1.6 + R.next() * 1.8;
    const u = 0.3 + R.next() * 0.6;
    if (!p) return;
    p.sp = sp;
    p.x = 0;
    p.y = 0;
    p.vx = vx;
    p.vy = vy;
    p.age = 0;
    p.life = life;
    p.c = this.ladC(this.id['bone']!, u);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  drawing
   * ---------------------------------------------------------------------------------------------- */

  /** Whether the idle can draw (the ladders exist; they are built at construction). */
  prepare(): boolean {
    return this.ready;
  }

  /**
   * Recolour region `ri`'s cells in the atlas (already holding the live map's pixels at `sx, sy`, row stride `stride`).
   * `src` is the live region map. Returns whether anything was drawn.
   */
  shadeRegion(
    ri: number,
    src: MatterMap,
    px: Uint32Array,
    em: Uint8Array,
    stride: number,
    sx: number,
    sy: number,
  ): void {
    const inp = this.lastIn;
    if (inp.w < 0.01) return;
    const I = this.id;
    const reg = this.W.regions[ri]!;
    const mat = src.material;
    const integ = src.integrity;
    const flags = src.flags;
    const ok = (i: number): boolean => mat[i] !== 0 && integ[i] === 255 && (flags[i]! & FIGHT_FLAGS) === 0;
    const T = this.T;
    const W = inp.wit;
    const wit = W >= 0;
    const at = (x: number, y: number): number => (sy + y) * stride + sx + x;
    if (reg.kind === 'carapace') this.shadeCarapace(src, px, em, at, ok);
    else if (reg.kind === 'arm') this.shadeArm(ri, src, px, em, at, ok);
    else if (reg.kind === 'shrine') this.shadeShrine(src, px, em, stride, sx, sy, ok);
    else if (reg.kind === 'halo' && wit && W > 0.6 && W < 4) {
      for (let i = 0; i < mat.length; i++) {
        if (!ok(i)) continue;
        const x = i % src.w;
        const j = at(x, (i - x) / src.w);
        px[j] = this.stepC(px[j]!, mat[i]!, 1);
        em[j] = Math.max(em[j]!, Math.round(0.06 * EM));
      }
    }
    void I;
    void T;
  }

  private shadeCarapace(
    src: MatterMap,
    px: Uint32Array,
    em: Uint8Array,
    at: (x: number, y: number) => number,
    ok: (i: number) => boolean,
  ): void {
    const inp = this.lastIn;
    const I = this.id;
    const W = inp.wit;
    const wit = W >= 0;
    const w = inp.w;
    const b = inp.b;
    const T = this.T;
    const reg = this.W.regions[this.car]!;
    const mat = src.material;
    // the rim swells on the in-breath (ring 2 only while witnessing), in whole pixels
    const grow = (wit && W > 1.2 && W < 4.5 ? 2 : b > 0.62 ? 1 : 0) * (w > 0.5 ? 1 : 0);
    for (let n = 0; n < this.rimX.length; n++) {
      if (this.rimRing[n]! > grow) continue;
      const s = this.rimSrc[n]!;
      if (!ok(s)) continue;
      const j = at(this.rimX[n]!, this.rimY[n]!);
      const c = px[at(s % src.w, Math.floor(s / src.w))]!;
      px[j] = this.stepC(c, mat[s]!, this.rimRing[n] === 1 ? -1 : -2);
    }
    // the seams part and show what is inside (channels, then gold, then the abyss)
    const reveal = wit
      ? W < 1.2
        ? 1.2 * b
        : W < 2.4
          ? 1.2 + ss(1.2, 2.4, W) * 5.3
          : W < 3.8
            ? 6.5
            : 6.5 * (1 - ss(3.8, 5.0, W))
      : 1.5 * b - 0.35;
    const rv = reveal * w;
    const R = this.W.regions;
    // only the cells near a seam can part (sorted by seam distance, the seams first): stop where the reveal does not reach
    for (let n = 0; n < this.carL.length; n++) {
      const i = this.carL[n]!;
      const dvn = this.dv[i]!;
      if (dvn > 0 && dvn >= rv) break;
      if (!ok(i)) continue;
      const x = i % src.w;
      const y = (i - x) / src.w;
      const m = mat[i]!;
      const j = at(x, y);
      const dv = this.dv[i]!;
      if (rv > 0 && dv < 255) {
        const bay = BAY8[((y & 7) << 3) | (x & 7)]!;
        if (dv + bay * 0.95 < rv) {
          const depth = rv - dv;
          const bx = reg.ox + x;
          const by = reg.oy + y;
          const order = depth > 4.2 ? [3, 2, 1] : depth > 2.4 ? [2, 1, 3] : [1, 2, 3];
          let c = 0;
          let L = 0;
          let ii = -1;
          for (const l of order) {
            const ri = this.inter[l]!;
            if (ri < 0) continue;
            const r = R[ri]!;
            const m2 = this.liveOf(ri);
            if (!m2) continue;
            const lx = bx - r.ox;
            const ly = by - r.oy;
            if (lx < 0 || ly < 0 || lx >= m2.w || ly >= m2.h) continue;
            const k = ly * m2.w + lx;
            if (!m2.material[k] || m2.integrity[k] === 0) continue;
            c = m2.pixels[k]!;
            L = l;
            ii = k;
            break;
          }
          if (c) {
            const m2 = this.interMat(L, ii);
            if (L === 1) {
              c = this.stepC(c, m2, 1);
              em[j] = Math.max(em[j]!, Math.round(0.22 * EM));
            } else if (L === 2) {
              if (fsin((x - y * 0.6) * 0.35 - T * 2.4) > 0.6) c = this.stepC(c, m2, 1);
              em[j] = Math.max(em[j]!, Math.round(0.06 * EM));
            } else if (L === 3) {
              const e = this.abE[ii] ?? -1;
              if (e >= 0 && m2 === I['pupil'] && this.abOpen[e]! > 0.4) {
                c = this.ladC(I['channel']!, this.abOpen[e]! > 0.8 ? 1 : 0.7);
                em[j] = Math.max(em[j]!, Math.round(0.5 * EM));
              }
            }
          } else
            c = depth > 2 ? this.ladC(I['abyss']!, h2(x, y) > 0.97 ? 1 : 0.1) : this.ladC(I['channel']!, 0.1);
          px[j] = c;
          continue;
        }
      }
      // crack waves run the fracture network; hairlines shimmer
      if (m === I['vein'] || m === I['hairline']) {
        let lit = 0;
        for (let q = 0; q < this.waves.n; q++) {
          const wv = this.waves.items[q]!;
          const d = this.net[wv.k]![i]!;
          if (d === 65535) continue;
          const f = (T - wv.t0) * 38 - d;
          if (f > -1 && f < 1.2) lit = 2;
          else if (f >= 1.2 && f < 7 && BAY8[((y & 7) << 3) | (x & 7)]! > (f - 1.2) / 6)
            lit = Math.max(lit, 1);
        }
        if (m === I['hairline'] && fsin(T * 0.8 + h2(i, 3) * 6) > 0.8) lit = Math.max(lit, 1);
        if (lit && w > 0.5) {
          px[j] = this.xl(px[j]!, m, I['channel']!, lit === 2 ? 1 : -1);
          em[j] = Math.max(em[j]!, Math.round((lit === 2 ? 0.35 : 0.1) * EM));
        }
      }
    }
  }

  private interMat(L: number, k: number): number {
    const ri = this.inter[L]!;
    return this.liveOf(ri)?.material[k] ?? 0;
  }
  /** The live map of region ri (null when severed): set by the behaviour. Destroyed interior cells show nothing new. */
  liveOf: (ri: number) => MatterMap | null = () => null;

  private shadeArm(
    ri: number,
    src: MatterMap,
    px: Uint32Array,
    em: Uint8Array,
    at: (x: number, y: number) => number,
    ok: (i: number) => boolean,
  ): void {
    const inp = this.lastIn;
    const I = this.id;
    const W = inp.wit;
    const T = this.T;
    const reg = this.W.regions[ri]!;
    const mat = src.material;
    const s = this.armS.get(ri)!;
    const edge = this.armEdge.get(ri)!;
    const orb = this.armOrb.get(ri)!;
    const ody = this.armOdy.get(ri)!;
    const wv = this.armWave[reg.arm]!;
    const gl = this.armGlint[reg.arm]!;
    const sparkle = Math.floor(T * 2.5);
    // a vein signal or an edge glint only while one runs down this arm
    const vf = (T - wv) * 0.75;
    const veinOn = vf > -0.03 && vf < 1.12;
    const gf = (T - gl) / 1.3;
    const glintOn = gf > -0.06 && gf < 1.06;
    // only the cells something can happen to (orb-eyes, veins, edges, gold and lattice)
    const list = this.armL.get(ri)!;
    for (let n = 0; n < list.length; n++) {
      const i = list[n]!;
      if (!ok(i)) continue;
      const x = i % src.w;
      const y = (i - x) / src.w;
      const m = mat[i]!;
      const j = at(x, y);
      const o = orb[i]!;
      if (o >= 0) {
        // the orb-eyes: a slit that opens; when open the iris looks at the foe and the orb lights
        const O = this.orbs[o]!;
        const dy = ody[i]!;
        const slit = Math.floor(0.5 + O.open * (O.r + 0.5));
        if (Math.abs(dy) > slit) {
          const u = Math.abs(dy) / (O.r + 1);
          px[j] =
            Math.abs(dy) === slit + 1
              ? this.ladC(I['bronze']!, 0.15)
              : this.ladC(I['shell']!, 0.55 - u * 0.4);
          em[j] = 0;
          continue;
        }
        if (O.open > 0.5 && (m === I['iris'] || m === I['pupil']) && (O.gx || O.gy)) {
          const X = x - O.gx;
          const Y = y - O.gy;
          const k = Y * src.w + X;
          if (X >= 0 && Y >= 0 && X < src.w && Y < src.h && orb[k] === o && ok(k)) px[j] = px[at(X, Y)]!;
        }
        if (O.open > 0.5 && m === I['orb']) {
          px[j] = this.stepC(px[j]!, m, W >= 0 ? 2 : 1);
          em[j] = Math.max(em[j]!, Math.round(0.18 * EM));
        }
        if (O.open <= 0.5 && dy === 0 && fsin(T * 1.3 + o * 2.1) > 0.97) {
          px[j] = this.ladC(I['hairline']!, 0.7);
          em[j] = Math.max(em[j]!, Math.round(0.4 * EM));
        }
        continue;
      }
      const si = s[i]!;
      if (m === I['vein'] && veinOn) {
        const f = (T - wv) * 0.75 - si;
        if (f > -0.03 && f < 0.03) {
          px[j] = this.xl(px[j]!, m, I['channel']!, 1);
          em[j] = Math.max(em[j]!, Math.round(0.3 * EM));
        } else if (f >= 0.03 && f < 0.12 && BAY8[((y & 7) << 3) | (x & 7)]! > (f - 0.03) / 0.09)
          px[j] = this.xl(px[j]!, m, I['channel']!, -1);
      }
      if (edge[i] && glintOn) {
        const f = (T - gl) / 1.3 - si;
        if (Math.abs(f) < 0.022) {
          px[j] = this.ladC(I['lattice']!, 0.9);
          em[j] = Math.max(em[j]!, Math.round(0.35 * EM));
        } else if (Math.abs(f) < 0.06) px[j] = this.stepC(px[j]!, m, 2);
      }
      if ((m === I['gold'] || m === I['lattice']) && h2(i * 7 + ri, sparkle) > 0.95)
        px[j] = this.stepC(px[j]!, m, 1);
    }
  }

  private shadeShrine(
    src: MatterMap,
    px: Uint32Array,
    em: Uint8Array,
    stride: number,
    sx: number,
    sy: number,
    ok: (i: number) => boolean,
  ): void {
    const inp = this.lastIn;
    const I = this.id;
    const W = inp.wit;
    const T = this.T;
    const mat = src.material;
    const w = inp.w;
    const sw = src.w;
    // the spires swing (drawn only, WJ): each spire's rows shift by whole pixels; rebuilt from a copy of its rows. Most
    // ticks no spire is a whole pixel out at its tip, and then nothing moves.
    let anyShift = false;
    for (const S of this.spires) if (Math.round(S.a * w * (S.y1 - S.y0)) !== 0) anyShift = true;
    const tmp = this.spTmp.length >= mat.length ? this.spTmp : (this.spTmp = new Uint32Array(mat.length));
    const tme = this.spTmpE.length >= mat.length ? this.spTmpE : (this.spTmpE = new Uint8Array(mat.length));
    for (let y = 0; y < src.h; y++)
      for (let x = 0; x < sw; x++) {
        tmp[y * sw + x] = px[(sy + y) * stride + sx + x]!;
        tme[y * sw + x] = em[(sy + y) * stride + sx + x]!;
      }
    if (anyShift) this.shear(src, px, em, tmp, tme, stride, sx, sy, w);
    // gold drips run down the spires; gold brightens while witnessing (only the cells that can change)
    const gold = W > 0.6 && W < 4;
    if (this.drips.n === 0 && !gold) return;
    for (const i of this.shrL) {
      if (!ok(i)) continue;
      const sp = this.spOf[i]!;
      const m = mat[i]!;
      if (sp < 0 && !(gold && (m === I['gold'] || m === I['lattice']))) continue;
      const y = Math.floor(i / sw);
      const x = sp >= 0 ? (i % sw) + Math.round(this.spires[sp]!.a * w * (y - this.spires[sp]!.y0)) : i % sw;
      if (x < 0 || x >= sw) continue;
      const j = (sy + y) * stride + sx + x;
      if (sp >= 0)
        for (let q = 0; q < this.drips.n; q++) {
          const d = this.drips.items[q]!;
          if (d.sp !== sp) continue;
          const front = (T - d.t0) * 22;
          if (Math.abs(y - this.spires[sp]!.y0 - front) < 1.5) {
            px[j] =
              m === I['gold'] || m === I['lattice']
                ? this.ladC(I['lattice']!, 0.8)
                : this.stepC(tmp[i]!, m, 2);
            em[j] = Math.max(em[j]!, Math.round(0.12 * EM));
          }
        }
      if (gold && (m === I['gold'] || m === I['lattice'])) px[j] = this.stepC(tmp[i]!, m, 1);
    }
  }

  private shear(
    src: MatterMap,
    px: Uint32Array,
    em: Uint8Array,
    tmp: Uint32Array,
    tme: Uint8Array,
    stride: number,
    sx: number,
    sy: number,
    w: number,
  ): void {
    const mat = src.material;
    const sw = src.w;
    for (let i = 0; i < mat.length; i++) {
      const sp = this.spOf[i]!;
      if (sp < 0 || !mat[i]) continue;
      const S = this.spires[sp]!;
      const y = Math.floor(i / sw);
      const shift = Math.round(S.a * w * (y - S.y0));
      if (shift === 0) continue;
      const x = i % sw;
      // the cell's own place empties unless another spire cell lands there
      const j0 = (sy + y) * stride + sx + x;
      if (this.spOf[i] === sp && px[j0] === tmp[i]) {
        px[j0] = 0;
        em[j0] = 0;
      }
    }
    for (let i = 0; i < mat.length; i++) {
      const sp = this.spOf[i]!;
      if (sp < 0 || !mat[i]) continue;
      const S = this.spires[sp]!;
      const y = Math.floor(i / sw);
      const x = i % sw;
      const X = x + Math.round(S.a * w * (y - S.y0));
      if (X < 0 || X >= sw) continue;
      const j = (sy + y) * stride + sx + X;
      px[j] = tmp[i]!;
      em[j] = tme[i]!;
    }
  }
  private spTmp = new Uint32Array(0);
  private spTmpE = new Uint8Array(0);

  /** The great eye, as a skin over the primary body: the gaze remaps the iris disc, the pupil scales. */
  presentEye(map: MatterMap, body: RenderLayer): void {
    if (!this.ready) return;
    const changed = this.dirty || map.version !== this.skinVer;
    if (changed) {
      this.dirty = false;
      this.skinVer = map.version;
      this.shadeEye(map);
    }
    this.skin.present(body, changed);
  }

  private shadeEye(map: MatterMap): void {
    const S = this.skin;
    S.copyFrom(map.pixels, map.emissive);
    const px = S.px;
    const em = S.emis;
    const inp = this.lastIn;
    const I = this.id;
    const W = inp.wit;
    const w = inp.w;
    const mat = map.material;
    const integ = map.integrity;
    const ok = (i: number): boolean => mat[i] !== 0 && integ[i] === 255;
    const src = map.pixels;
    const g0 = w > 0.5 ? this.gx : 0;
    const g1 = w > 0.5 ? this.gy : 0;
    const k = w > 0.5 ? this.k : 0;
    const ec = this.ec;
    const ic = this.ic;
    const pc = this.pc;
    const P = this.rp;
    const RI = this.ri;
    const Bn = 5;
    const E = map;
    const cell = (x: number, y: number): number => {
      const X = Math.floor(x);
      const Y = Math.floor(y);
      if (X < 0 || Y < 0 || X >= E.w || Y >= E.h) return -1;
      const i = Y * E.w + X;
      return mat[i] && ok(i) ? i : -1;
    };
    for (let y = 0; y < E.h; y++)
      for (let x = 0; x < E.w; x++) {
        const i = y * E.w + x;
        if (!ok(i)) continue;
        const qx = x + 0.5;
        const qy = y + 0.5;
        const de = Math.sqrt((qx - ec[0]) * (qx - ec[0]) + (qy - ec[1]) * (qy - ec[1]));
        if (de <= this.rs + 0.5) {
          if (g0 === 0 && g1 === 0 && k === 0) continue;
          const di = Math.sqrt((qx - ic[0] - g0) * (qx - ic[0] - g0) + (qy - ic[1] - g1) * (qy - ic[1] - g1));
          if (di <= RI) {
            let tx = qx - g0;
            let ty = qy - g1;
            if (k !== 0) {
              const dpx = tx - pc[0];
              const dpy = ty - pc[1];
              const d = Math.sqrt(dpx * dpx + dpy * dpy);
              const nP = P + k;
              if (d < P + Bn && d > 0.01) {
                const r2 = d <= nP ? d * (P / Math.max(1, nP)) * 0.85 : P + ((d - nP) * Bn) / (P + Bn - nP);
                tx = pc[0] + (dpx / d) * r2;
                ty = pc[1] + (dpy / d) * r2;
              }
            }
            const j = cell(tx, ty);
            if (j >= 0) px[i] = src[j]!;
          } else {
            const d0 = Math.sqrt((qx - ic[0]) * (qx - ic[0]) + (qy - ic[1]) * (qy - ic[1]));
            if (d0 <= RI) {
              // sclera uncovered by the shift: mirrored across the iris edge
              const r2 = RI + (RI - d0) + 1.2;
              const ux = (qx - ic[0]) / (d0 || 1);
              const uy = (qy - ic[1]) / (d0 || 1);
              const j = cell(ic[0] + ux * r2, ic[1] + uy * r2);
              px[i] = j >= 0 && mat[j] === I['sclera'] ? src[j]! : this.ladC(I['sclera']!, 0.5);
            }
          }
        } else if (W > 0.6 && W < 4.2 && (mat[i] === I['lattice'] || mat[i] === I['gold'])) {
          px[i] = this.stepC(src[i]!, mat[i]!, mat[i] === I['lattice'] ? 2 : 1);
          em[i] = Math.max(em[i]!, Math.round(0.15 * EM));
        }
      }
  }

  /**
   * The overlay behind the atlas (centred on the halo's centre, world): the light ring completing from the sigil, the
   * crosshair ticks, dust off the snapped spires. `hx, hy`: the halo centre (world); `shX, shY`: the shrine map's corner
   * (world) and `facing`.
   */
  drawBack(ov: Overlay, hx: number, hy: number, shX: number, shY: number, facing: number): void {
    const inp = this.lastIn;
    const I = this.id;
    const W = inp.wit;
    const ringP = W < 0.6 ? 0 : W < 1.5 ? ss(0.6, 1.5, W) : W < 3.8 ? 1 : 1 - ss(3.8, 4.8, W);
    if (ringP > 0) {
      for (const [rr, kk] of [
        [61.3, 0],
        [66.7, 1],
        [72, 2],
      ] as const) {
        const n = Math.ceil(rr * TAU * 1.3);
        const reach = ringP * Math.PI;
        for (let s = 0; s < n; s++) {
          const a = (s / n) * TAU - Math.PI / 2;
          const da = Math.abs(((a + Math.PI / 2 + Math.PI) % TAU) - Math.PI);
          if (da > reach) continue;
          const x = Math.round(hx + fcos(a) * rr);
          const y = Math.round(hy + fsin(a) * rr);
          if (W > 3.8 && BAY8[((y & 7) << 3) | (x & 7)]! > ringP) continue;
          const lead = reach - da < 0.12 && W < 1.6;
          ov.set(
            x,
            y,
            this.ladC(I['lattice']!, lead ? 1 : kk === 1 ? 0.7 : 0.45),
            Math.round((lead ? 0.5 : 0.12) * EM),
          );
        }
      }
      const len = Math.round(ss(1.0, 1.7, W) * (1 - ss(3.8, 4.6, W)) * 40);
      for (const [dx, dy] of [
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0],
      ] as const)
        for (let k = 0; k < len; k++) {
          if (!(k > len - 3 || (k & 1) === 0 || dy === -1)) continue;
          const rr = 42 + k;
          ov.set(
            hx + dx * rr,
            hy + dy * rr,
            this.ladC(I['lattice']!, k > len - 3 ? 1 : 0.55),
            Math.round(0.15 * EM),
          );
        }
    }
    for (let n = 0; n < this.dust.n; n++) {
      const p = this.dust.items[n]!;
      const S = this.spires[p.sp];
      if (!S) continue;
      const k = p.age / p.life;
      const x = Math.round(shX + (S.bx + p.x) * facing);
      const y = Math.round(shY + S.y1 + 1 + p.y);
      if (BAY8[((y & 7) << 3) | (x & 7)]! < k * k) continue;
      ov.set(x, y, p.c);
    }
  }

  /**
   * The reticle on the foe and the line of sight (a pure function of the sim's witnessing clock and the positions, so it can
   * be drawn on the sim tick's fx overlay).
   */
  drawReticle(fx: Overlay, W: number, ex: number, ey: number, ox: number, oy: number): void {
    if (W < 1.75 || W > 4.6 || !this.ready) return;
    const I = this.id;
    const u = W - 1.75;
    const rr = [30, 22, 16, 12][Math.min(3, Math.floor(u * 16))]!;
    const fade = W > 3.9 ? ss(3.9, 4.6, W) : 0;
    const col = this.ladC(I['lattice']!, u < 0.3 ? 1 : 0.75);
    const spin = u > 0.3 ? Math.floor((u - 0.3) * 4) * 0.08 : 0;
    const n = Math.ceil(rr * TAU * 1.2);
    const cx = Math.round(ox);
    const cy = Math.round(oy);
    for (let s = 0; s < n; s++) {
      const a = (s / n) * TAU + spin;
      if (Math.floor(((a - spin) / (Math.PI / 2)) * 6) % 6 === 5) continue;
      const x = Math.round(cx + fcos(a) * rr);
      const y = Math.round(cy + fsin(a) * rr);
      if (BAY8[((y & 7) << 3) | (x & 7)]! < fade) continue;
      fx.set(x, y, col, Math.round(0.3 * EM));
    }
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const)
      for (let k = rr - 4; k <= rr + 5; k++) {
        const x = cx + dx * k;
        const y = cy + dy * k;
        if (BAY8[((y & 7) << 3) | (x & 7)]! < fade) continue;
        fx.set(x, y, col, Math.round(0.25 * EM));
      }
    if (u < 0.5) {
      const dx = cx - ex;
      const dy = cy - ey;
      const L = Math.max(Math.abs(dx), Math.abs(dy));
      const c2 = this.ladC(I['channel']!, 0.8);
      for (let k = 30; k < L - rr; k += 2) {
        const x = Math.round(ex + (dx * k) / L);
        const y = Math.round(ey + (dy * k) / L);
        if (BAY8[((y & 7) << 3) | (x & 7)]! < u * 2) continue;
        fx.set(x, y, c2, Math.round(0.3 * EM));
      }
    }
  }
}
