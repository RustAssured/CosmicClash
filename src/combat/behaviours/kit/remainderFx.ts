import { type AimDir, type MaterialSpec, type MatterMap, type RenderLayer, type ViewRect } from '@/contracts';
import { DMath } from '@/contracts/dmath';
import { Overlay } from '../../fx/overlay';
import { BodySpaceLayer, clampN, fcos, fsin, h2, ss } from '../../fx/idle';
import type { RemainderAct } from './remainderIdle';

/**
 * THE REMAINDER'S MOVES, DRAWN (presentation only, from what its behaviour recorded on the tick). Every button reads as a
 * different act, and none of them moves the shell: the violence comes out of the vortex.
 *
 *  - SNAP: the eye cocks (narrows), a whip of ichor and violet cracks out to the aim, overshoots, and recoils with a wave
 *    running down it, dragging the foe's own colours back into the eye.
 *  - INHALE: the tell (the vortex spins up and darkens, the eye widens, streaks of dust stream in from the front), then the
 *    intake (dense streaks) and the bite: two bone mandibles slam shut at the rim with a flash.
 *  - FOLD: the body twists down into its own eye (the idle's collapse), a tear of light is left where it was, and it
 *    unfolds out of a second tear.
 *  - COMPACTION: matter spirals into a slug growing in the eye; release: a muzzle ring at the rim (the slug itself is real
 *    matter), or, aimed down, seams of new bone flash along the front of the shell.
 *  - LOOSENING: light cracks run from the eye across the shell, debris streams in from all round, and the wound snaps shut
 *    with a ring of light.
 *  - HOLD SHUT and CANNIBAL are the idle's (the plates, the crumbling); the swallowed blows and the bites flash here.
 *
 * `act` is what the moves ask of the idle this frame (spin, darkness, the eye, the fold, the loosening, the plates).
 */

export interface RemainderMoveView {
  id: string;
  phase: string;
  phaseTick: number;
  moveTick: number;
  startup: number;
  active: number;
  recovery: number;
  charge: number;
  aim: AimDir;
  facing: 1 | -1;
  snapHitAt: number;
  snapHitX: number;
  snapHitY: number;
  foldFromX: number;
  foldFromY: number;
  foldAt: number;
  foldToAt: number;
  slugAt: number;
  slugPips: number;
  platesAt: number;
  absorbAt: number;
  absorbX: number;
  absorbY: number;
  shutAt: number;
  biteAt: number;
  cannibalAt: number;
  cannibal: boolean;
  guard: boolean;
  /** Tick the guard last went up or down. */
  guardAt: number;
  foeColors: Uint32Array;
  foeColorsN: number;
}

const SNAP = 'remainder.snap';
const INHALE = 'remainder.inhale';
const FOLD = 'remainder.fold';
const COMPACTION = 'remainder.compaction';
const LOOSENING = 'remainder.loosening';
/** Where the hitboxes put the whip's tip and the jaw (px from the eye, facing right): tools/titans/author/remainder.ts. */
const TIP: Record<AimDir, [number, number]> = { up: [156, -88], forward: [164, -4], down: [156, 80] };
const JAW_Y: Record<AimDir, number> = { up: -44, forward: 0, down: 44 };
const RIM = 58;

const packHex = (hex: string): number => {
  const v = parseInt(hex.slice(1), 16);
  return (0xff000000 | ((v & 255) << 16) | (v & 0xff00) | ((v >> 16) & 255)) >>> 0;
};

export class RemainderFx {
  private readonly front: BodySpaceLayer;
  private readonly world = new Overlay('remainder-fx-world', 2, 360, 360, 'normal', true);
  private readonly cx: number;
  private readonly cy: number;
  private readonly R: number;
  private readonly pal: Record<'ichor' | 'vortex' | 'spark' | 'bone' | 'crust' | 'core', Uint32Array>;
  /** Loosening's cracks: polylines from the eye to the rim (map cells), fixed per fighter. */
  private readonly cracks: Float32Array[] = [];
  private readonly seed: number;

  constructor(map: MatterMap, materials: readonly MaterialSpec[], seed: number) {
    this.seed = seed;
    this.cx = map.coreX + 0.5;
    this.cy = map.coreY + 0.5;
    this.R = Math.min(map.w, map.h) * 0.48;
    const big = Math.max(map.w, map.h);
    this.front = new BodySpaceLayer('remainder-fx', 2, big * 2 + 64, big * 2 + 64, map.coreX, map.coreY);
    const ramp = (key: string, fb: string): Uint32Array =>
      Uint32Array.from((materials.find((m) => m.key === key)?.visual.ramp ?? [fb, fb]).map(packHex));
    this.pal = {
      ichor: ramp('ichor', '#8dc155'),
      vortex: ramp('vortex', '#713480'),
      spark: ramp('spark', '#e598e2'),
      bone: ramp('bone', '#cdc7a0'),
      crust: ramp('crust', '#403531'),
      core: ramp('core', '#150824'),
    };
    // the cracks: jagged polylines from near the eye out to the rim, evenly round with jitter
    const N = 9;
    for (let k = 0; k < N; k++) {
      const pts: number[] = [];
      let a = ((k + h2(seed, k) * 0.6) / N) * Math.PI * 2;
      for (let s = 0; s <= 12; s++) {
        const r = 14 + (this.R - 10) * (s / 12);
        a += (h2(seed + k * 13, s) - 0.5) * 0.28;
        pts.push(this.cx + fcos(a) * r, this.cy + fsin(a) * r * 1.15);
      }
      this.cracks.push(Float32Array.from(pts));
    }
  }

  /* ---------------------------------------------------------------------------------------------- what the moves ask */

  act(v: RemainderMoveView, tick: number): RemainderAct {
    const a: RemainderAct = {
      spin: 1,
      inflow: 1,
      dark: 0,
      loosen: 0,
      shut: 0,
      fold: 0,
      twist: 0,
      pupil: 1,
      glow: 0,
      flash: 0,
      shake: 0,
      busy: v.id !== '' || v.guard || tick - v.absorbAt < 10 || tick - v.foldToAt < 16,
    };
    const S = Math.max(1, v.startup);
    const A = Math.max(1, v.active);
    const Rc = Math.max(1, v.recovery);
    const su = v.phase === 'startup' || v.phase === 'charge' ? clampN(v.phaseTick / S, 0, 1) : 0;
    const ac = v.phase === 'active' ? clampN(v.phaseTick / A, 0, 1) : 0;
    const rc = v.phase === 'recovery' ? clampN(v.phaseTick / Rc, 0, 1) : 0;
    if (v.id === SNAP) {
      if (v.phase === 'startup') a.pupil = 1 - 0.55 * su;
      else if (v.phase === 'active') {
        a.pupil = 0.35;
        a.flash = 0.5 * (1 - ac);
        a.spin = 1.8;
      } else if (v.phase === 'recovery') {
        a.inflow = 1 + 2 * (1 - rc);
        a.pupil = 0.45 + 0.55 * rc + (tick - v.snapHitAt < Rc && rc > 0.75 ? 0.6 : 0);
        a.glow = tick - v.snapHitAt < Rc && rc > 0.75 ? 1 : 0;
      }
    } else if (v.id === INHALE) {
      if (v.phase === 'startup') {
        a.spin = 1 + 3.2 * su;
        a.inflow = 1 + 1.8 * su;
        a.dark = su;
        a.pupil = 1 + 0.7 * su;
        a.shake = su > 0.55 ? 1 : 0;
      } else if (v.phase === 'active') {
        const bit = v.phaseTick >= 7;
        a.spin = 4.2;
        a.inflow = 3.2;
        a.dark = 1;
        a.pupil = bit ? 0.25 : 1.8;
        a.flash = bit ? 1 - (v.phaseTick - 7) / 6 : 0;
        a.shake = bit ? 2 : 1;
      } else if (v.phase === 'recovery') {
        a.spin = 1 + 3 * (1 - rc) * (1 - rc);
        a.dark = 1 - rc;
        a.pupil = 0.4 + 0.6 * rc;
      }
    } else if (v.id === FOLD) {
      // collapse over the startup and the first active ticks, gone, then unfold over the recovery
      const into = v.phase === 'startup' ? su * 0.6 : v.phase === 'active' ? 0.6 + 0.4 * ss(0, 0.25, ac) : 0;
      a.fold = v.phase === 'recovery' ? 1 - ss(0, 1, rc) : into;
      a.twist = a.fold * a.fold * 5;
      a.spin = 3;
      a.pupil = 1.6;
      a.glow = 1;
    } else if (v.id === COMPACTION) {
      if (v.phase === 'startup' || v.phase === 'charge') {
        const c = Math.max(v.charge, su * 0.3);
        a.spin = 1 + 2.5 * c;
        a.inflow = 1 + 2.5 * c;
        a.pupil = 0.6 - 0.3 * c;
        a.glow = c;
        a.shake = c > 0.55 ? 1 : 0;
      } else if (v.phase === 'active') {
        a.flash = 1 - ac;
        a.pupil = 1.5;
        a.shake = 2;
      } else a.pupil = 0.7 + 0.3 * rc;
    } else if (v.id === LOOSENING) {
      if (v.phase === 'startup') {
        a.loosen = 0.7 * su * su;
        a.spin = 1 + 3 * su;
        a.inflow = 1 + 2 * su;
        a.pupil = 1 + 1.4 * su;
        a.glow = su;
        a.shake = 1;
      } else if (v.phase === 'active' && v.phaseTick < 140) {
        a.loosen = 0.7 + 0.3 * ss(0, 20, v.phaseTick);
        a.spin = 4.5 + 1.2 * fsin(tick * 0.4);
        a.inflow = 3.5;
        a.pupil = 2.4 + 0.3 * fsin(tick * 0.9);
        a.glow = 1;
        a.shake = (tick >> 2) & 1 ? 2 : 1;
        a.flash = h2(this.seed, tick >> 3) > 0.85 ? 0.5 : 0;
      } else if (v.phase === 'active') {
        a.shut = 1;
        a.pupil = 0;
        a.flash = 1 - (v.phaseTick - 140) / 10;
        a.shake = 3;
      } else if (v.phase === 'recovery') {
        a.shut = 1 - rc;
        a.pupil = rc;
        a.spin = 0.4 + 0.6 * rc;
      }
    }
    // Hold Shut: the iris of bone closes over the wound in 6 ticks and opens again in 6 when it lets go
    const g = clampN((tick - v.guardAt) / 6, 0, 1);
    const shut = v.guard ? g : tick - v.guardAt < 6 ? 1 - g : 0;
    if (shut > 0) {
      a.shut = Math.max(a.shut, shut);
      a.spin *= 1 - 0.85 * shut;
      a.pupil = Math.min(a.pupil, 1 - shut);
      a.busy = true;
    }
    if (v.cannibal) {
      a.spin *= 1.45;
      a.shake = Math.max(a.shake, h2(this.seed + 9, tick >> 3) > 0.7 ? 1 : 0);
    }
    if (tick - v.absorbAt < 6) a.flash = Math.max(a.flash, 0.6);
    return a;
  }

  /* ---------------------------------------------------------------------------------------------- drawing */

  render(
    body: RenderLayer,
    map: MatterMap,
    v: RemainderMoveView,
    tick: number,
    view: ViewRect,
    out: RenderLayer[],
  ): void {
    const L = this.front;
    L.begin(body);
    const W = this.world;
    W.limitToView(view, 64);
    W.begin(v.foldFromX, v.foldFromY);
    if (v.id === SNAP) this.drawSnap(v, tick);
    if (v.id === INHALE) this.drawInhale(v, tick);
    if (v.id === COMPACTION) this.drawCompaction(v, tick);
    if (v.id === LOOSENING) this.drawLoosening(v, tick);
    if (tick - v.slugAt < 10) this.drawMuzzle(v, tick);
    if (tick - v.slugAt < 30 && v.aim !== 'down') this.drawSlugTrail(v, tick - v.slugAt, body);
    if (tick - v.platesAt < 24) this.drawPlates(tick - v.platesAt);
    if (tick - v.absorbAt < 10) this.drawAbsorb(v, tick - v.absorbAt);
    if (tick - v.cannibalAt < 36) this.drawCrumbs(v, tick - v.cannibalAt);
    if (v.id === FOLD && v.phase === 'recovery')
      this.drawTear(this.cx, this.cy, 1 - v.phaseTick / Math.max(1, v.recovery), true);
    // the tear left where it folded away (world space: the body has moved on)
    if (tick - v.foldAt < 22) this.drawWorldTear(v, tick - v.foldAt);
    if (tick - v.shutAt < 16) this.drawShutRing(tick - v.shutAt);
    L.end();
    W.end();
    void map;
    out.push(L.layer, W.layer);
  }

  /** A thick line in body space: `w` cells wide, palette index chosen by `col(s)` along it (s 0..1). */
  private stroke(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    w: number,
    P: Uint32Array,
    k: number,
    e = 0,
  ): void {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    const r = w / 2;
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const y = y0 + ((y1 - y0) * i) / n;
      for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++)
        for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++)
          if (dx * dx + dy * dy <= r * r + 0.25)
            this.front.putPal(
              Math.floor(x + dx),
              Math.floor(y + dy),
              P,
              Math.max(0, Math.min(P.length - 1, k)),
              e,
            );
    }
  }

  private disc(x: number, y: number, r: number, P: Uint32Array, k: number, e = 0): void {
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++)
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++)
        if (dx * dx + dy * dy <= r * r)
          this.front.putPal(
            Math.floor(x + dx),
            Math.floor(y + dy),
            P,
            Math.max(0, Math.min(P.length - 1, k)),
            e,
          );
  }

  /** SNAP: the whip out and back, with the stolen colours riding it home. */
  private drawSnap(v: RemainderMoveView, tick: number): void {
    const [tx, ty] = TIP[v.aim];
    const S = Math.max(1, v.startup);
    const A = Math.max(1, v.active);
    const Rc = Math.max(1, v.recovery);
    const { ichor, vortex, spark } = this.pal;
    if (v.phase === 'startup') {
      // the bud: a knot of light gathering at the rim, aimed
      const u = v.phaseTick / S;
      const ax = this.cx + (tx / 166) * RIM;
      const ay = this.cy + (ty / 166) * RIM;
      this.disc(ax, ay, 1.5 + 3 * u, spark, spark.length - 1, 120);
      return;
    }
    // reach: out fast with an overshoot (active), then back in with a wave down its length (recovery)
    let ext: number;
    let wave = 0;
    if (v.phase === 'active') ext = Math.min(1.12, (v.phaseTick + 1) / A) * 1.0;
    else {
      const p = v.phaseTick / Rc;
      ext = 1.12 - 0.12 * ss(0, 0.15, p) - ss(0.15, 1, p);
      ext = Math.max(0, ext);
      wave = (1 - p) * 9;
    }
    if (ext <= 0.01) return;
    const N = 36;
    let px = this.cx;
    let py = this.cy;
    const nx = -ty / 220;
    const ny = tx / 220;
    for (let i = 1; i <= N; i++) {
      const s = i / N;
      const along = s * ext;
      const wob = wave * fsin(s * 9 - tick * 1.1) * s * (1 - s * 0.4);
      const x = this.cx + tx * along + nx * wob;
      const y = this.cy + ty * along + ny * wob;
      const w = 9 - 6.5 * s;
      this.stroke(px, py, x, y, w + 2, vortex, 1, 20);
      this.stroke(px, py, x, y, w, vortex, vortex.length - 2, 40);
      this.stroke(px, py, x, y, Math.max(1, w - 2.5), ichor, ichor.length - 1 - Math.floor(s * 2), 140);
      px = x;
      py = y;
    }
    if (v.phase === 'active') {
      // the crack at the tip
      const k = v.phaseTick;
      for (let r = 0; r < 4; r++) {
        const a = (r / 4) * Math.PI * 2 + k;
        this.stroke(
          px,
          py,
          px + fcos(a) * (5 + k * 3),
          py + fsin(a) * (5 + k * 3),
          1,
          spark,
          spark.length - 1,
          200,
        );
      }
      this.disc(px, py, 3, spark, spark.length - 1, 220);
    } else if (tick - v.snapHitAt < Rc + 4 && v.foeColorsN) {
      // what it tore off rides the whip home: bits in the foe's own colours, clustered at the tip
      for (let i = 0; i < 10; i++) {
        const c = v.foeColors[i % v.foeColorsN]!;
        const j = (h2(i, this.seed) - 0.5) * 8;
        const k = (h2(this.seed, i) - 0.5) * 8;
        const bx = Math.floor(px + j);
        const by = Math.floor(py + k);
        this.front.put(bx, by, c, 30);
        this.front.put(bx + 1, by, c, 30);
        this.front.put(bx, by + 1, c, 30);
      }
    }
  }

  /** INHALE: the dust streaming in (the tell, then the intake) and the bone mandibles biting shut. */
  private drawInhale(v: RemainderMoveView, tick: number): void {
    const S = Math.max(1, v.startup);
    const u = v.phase === 'startup' ? v.phaseTick / S : v.phase === 'active' ? 1 : 0;
    const { bone, crust, spark } = this.pal;
    const aimA = v.aim === 'up' ? -0.6 : v.aim === 'down' ? 0.6 : 0;
    if (u > 0) {
      // the intake: a cone of matter rushing at the eye, each streak a bright head with a fading tail
      const n = Math.round(16 + 40 * u);
      for (let i = 0; i < n; i++) {
        const life = 0.45 + 0.3 * h2(this.seed + i, 1);
        const p = (tick / 60 / life + h2(this.seed + i, 2)) % 1;
        const a = aimA + (h2(this.seed + i, 3) - 0.5) * (1.1 - 0.3 * u);
        const r = 260 * (1 - p * p) + RIM;
        const len = 8 + 34 * u * p;
        const P = i & 1 ? bone : crust;
        for (let q = 0; q < 4; q++) {
          const r0 = r + (len * q) / 4;
          const r1 = r + (len * (q + 1)) / 4;
          this.stroke(
            this.cx + fcos(a) * r0,
            this.cy + fsin(a) * r0,
            this.cx + fcos(a) * r1,
            this.cy + fsin(a) * r1,
            q === 0 && u > 0.5 ? 2 : 1,
            P,
            P.length - 1 - q,
            q === 0 ? 60 : 0,
          );
        }
      }
    }
    if (v.phase === 'active' && v.phaseTick >= 6) {
      // the bite: two great curved mandibles of bone sweep in from above and below the aim and slam together, teeth first
      const k = clampN((v.phaseTick - 6) / 3, 0, 1);
      const jy = this.cy + JAW_Y[v.aim];
      const jx = this.cx + RIM + 30;
      for (const side of [-1, 1]) {
        const open = (1 - k) * 70;
        for (let s2 = 0; s2 <= 24; s2++) {
          const q = s2 / 24;
          const x = jx - 34 + 62 * q;
          const curve = 18 * Math.sqrt(Math.max(0, q * (1 - q)));
          const y = jy + side * (open * (1 - q * 0.6) + curve + 2);
          const r = 6.5 - 4.5 * q;
          this.disc(x, y, r + 1, crust, 0, 0);
          this.disc(x, y, r, bone, bone.length - 2 - Math.floor(q * 2) - (side > 0 ? 1 : 0), 20);
          // teeth along the inner edge
          if (s2 % 4 === 2)
            this.stroke(x, y - side * r, x + 2, y - side * (r + 5), 2, bone, bone.length - 1, 30);
        }
      }
      if (k >= 1 && v.phaseTick < 12) {
        const f = 1 - (v.phaseTick - 9) / 3;
        for (let r = 0; r < 8; r++) {
          const a = (r / 8) * Math.PI * 2;
          this.stroke(
            jx + 18,
            jy,
            jx + 18 + fcos(a) * 14 * f,
            jy + fsin(a) * 14 * f,
            1,
            spark,
            spark.length - 1,
            220,
          );
        }
      }
    }
  }

  /** COMPACTION: the slug growing in the eye, sparks spiralling into it. */
  private drawCompaction(v: RemainderMoveView, tick: number): void {
    if (v.phase !== 'startup' && v.phase !== 'charge') return;
    const c = Math.max(v.charge, 0.15);
    const { bone, crust, ichor, spark } = this.pal;
    const r = 5 + 10 * c;
    // compression rings closing in on the eye, faster as the charge builds
    for (let q = 0; q < 3; q++) {
      const p = (tick / (26 - 14 * c) + q / 3) % 1;
      const rr = r + 4 + 46 * (1 - p);
      const n2 = Math.round(rr * 2.2);
      for (let i = 0; i < n2; i++) {
        if ((i + q) % 4 === 0) continue;
        const a = (i / n2) * Math.PI * 2;
        const P = p > 0.55 ? spark : ichor;
        for (let th = 0; th < (p > 0.55 ? 2 : 1); th++)
          this.front.putPal(
            Math.floor(this.cx + fcos(a) * (rr - th)),
            Math.floor(this.cy + fsin(a) * (rr - th)),
            P,
            P.length - 1,
            Math.round(60 + 160 * p),
          );
      }
    }
    // sparks and grit spiralling in (more with the charge)
    const n = Math.round(6 + 22 * c);
    for (let i = 0; i < n; i++) {
      const p = (tick / 40 + h2(this.seed + i, 5)) % 1;
      const a = h2(this.seed + i, 6) * Math.PI * 2 + p * 7;
      const rr = (70 - 60 * p) * (1 + 0.3 * h2(i, 7));
      const P = i % 3 ? ichor : bone;
      this.front.putPal(
        Math.floor(this.cx + fcos(a) * rr),
        Math.floor(this.cy + fsin(a) * rr),
        P,
        P.length - 1,
        90,
      );
    }
    // the slug: dense, dark-rimmed, lit from above, with a crackle of ichor round it at full charge
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++)
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > r) continue;
        const rim = d > r - 1.2;
        const lit = rim ? 0 : clampN(0.55 - (dx + dy) / (2.4 * r), 0, 1);
        // compacted rubble: lumps of crust in bone, glowing at the seams as it is squeezed
        const n = h2(dx + 50, dy + 50);
        const seam = n > 0.58 && n < 0.63;
        const P = seam ? spark : n > 0.63 ? crust : bone;
        this.front.putPal(
          Math.floor(this.cx + dx),
          Math.floor(this.cy + dy),
          P,
          seam ? P.length - 1 : Math.floor(lit * (P.length - 1)),
          seam ? Math.round(160 * c) : 0,
        );
      }
    if (c > 0.6)
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + tick * 0.5;
        this.front.putPal(
          Math.floor(this.cx + fcos(a) * (r + 2)),
          Math.floor(this.cy + fsin(a) * (r + 2)),
          spark,
          spark.length - 1,
          200,
        );
      }
  }

  /** The slug leaving: a ring of light at the rim along the aim. */
  private drawMuzzle(v: RemainderMoveView, tick: number): void {
    const k = tick - v.slugAt;
    const up = v.aim === 'up';
    const mx = this.cx + (up ? 0.72 : 1) * (RIM + 8);
    const my = this.cy + (up ? -0.7 : 0) * (RIM + 8);
    const r = 4 + k * 3;
    const { spark, bone } = this.pal;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const P = i & 1 ? spark : bone;
      this.front.putPal(
        Math.floor(mx + fcos(a) * r * 0.6),
        Math.floor(my + fsin(a) * r),
        P,
        P.length - 1,
        160 - k * 14,
      );
    }
  }

  /** The slug's flight: a comet streak of light along its path (in body space, from the muzzle; it flies straight). */
  private drawSlugTrail(v: RemainderMoveView, k: number, body: RenderLayer): void {
    const up = v.aim === 'up';
    const dx = up ? 0.72 : 1;
    const dy = up ? -0.7 : 0;
    const head = 70 + (560 * (0.85 + 0.15 * v.slugPips) * k) / 60;
    const { ichor, spark } = this.pal;
    const tail = 70;
    for (let s2 = 0; s2 < tail; s2++) {
      const d = head - s2;
      if (d < 70) break;
      const w = 1 + (s2 < 10 ? 2 : s2 < 30 ? 1 : 0);
      const P = s2 < 12 ? spark : ichor;
      const x = this.cx + dx * d;
      const y = this.cy + dy * d + (h2(s2, k) - 0.5) * (s2 / 20);
      if ((s2 > 30 && (s2 + k) % 3 === 0) || s2 > 30 + (30 - k)) continue;
      this.stroke(x, y, x, y + 0.01, w, P, P.length - 1 - (s2 >> 4), Math.max(0, 200 - s2 * 3));
    }
    void body;
  }

  /** Compaction aimed down: seams of new bone flash along the front of the shell. */
  private drawPlates(k: number): void {
    const { bone, spark } = this.pal;
    // plates of compacted bone slam onto the front of the shell, white-hot seams cooling between them
    const f = 1 - k / 24;
    const grow = clampN(k / 4, 0, 1);
    for (let i = 0; i < 6; i++) {
      const a0 = -1.0 + (i / 6) * 2.0;
      const a1 = a0 + 0.3;
      const r0 = this.R * 0.66;
      const r1 = r0 + (8 + 4 * (i & 1)) * grow;
      for (let a = a0; a < a1; a += 0.02)
        this.stroke(
          this.cx + fcos(a) * r0,
          this.cy + fsin(a) * r0,
          this.cx + fcos(a) * r1,
          this.cy + fsin(a) * r1,
          1,
          bone,
          bone.length - 2 - ((a - a0) / 0.3 > 0.7 ? 2 : 0),
          0,
        );
      this.stroke(
        this.cx + fcos(a1 + 0.02) * r0,
        this.cy + fsin(a1 + 0.02) * r0,
        this.cx + fcos(a1 + 0.02) * (r1 + 2),
        this.cy + fsin(a1 + 0.02) * (r1 + 2),
        1,
        spark,
        spark.length - 1,
        Math.round(220 * f),
      );
    }
  }

  /** Hold Shut swallows a blow: sparks where it landed, sucked inward. */
  private drawAbsorb(v: RemainderMoveView, k: number): void {
    const { spark, bone } = this.pal;
    const x = this.cx + v.absorbX;
    const y = this.cy + v.absorbY;
    for (let i = 0; i < 10; i++) {
      const a = h2(this.seed + i, v.absorbAt) * Math.PI * 2;
      const r = (10 - k) * 1.6 * h2(i, v.absorbAt + 1);
      const P = i & 1 ? spark : bone;
      this.front.putPal(
        Math.floor(x + fcos(a) * r - (v.absorbX * k) / 20),
        Math.floor(y + fsin(a) * r - (v.absorbY * k) / 20),
        P,
        P.length - 1,
        180,
      );
    }
  }

  /** Cannibal: a bite of shell crumbling and spiralling into the eye. */
  private drawCrumbs(v: RemainderMoveView, k: number): void {
    const { bone, crust } = this.pal;
    const a0 = ((v.cannibalAt * 0.6180339887) % 1) * Math.PI * 2;
    const p = k / 36;
    for (let i = 0; i < 12; i++) {
      const a = a0 + (h2(i, 3) - 0.5) * 0.5 + p * p * 4;
      const r = this.R * 0.84 * (1 - p * p) * (0.9 + 0.2 * h2(i, 4));
      const P = i & 1 ? bone : crust;
      this.front.putPal(
        Math.floor(this.cx + fcos(a) * r),
        Math.floor(this.cy + fsin(a) * r),
        P,
        P.length - 1 - (i % 3),
        0,
      );
    }
  }

  /** LOOSENING: light cracks running from the eye across the whole shell, debris streaming in from everywhere. */
  private drawLoosening(v: RemainderMoveView, tick: number): void {
    const S = Math.max(1, v.startup);
    const open = v.phase === 'startup' ? v.phaseTick / S : v.phase === 'active' && v.phaseTick < 140 ? 1 : 0;
    if (open <= 0) return;
    const { ichor, spark, bone, crust } = this.pal;
    for (let k = 0; k < this.cracks.length; k++) {
      const c = this.cracks[k]!;
      // a crack runs outward as it opens, and flickers
      const reach = Math.floor((c.length / 2 - 1) * clampN(open * 1.4 - k * 0.04, 0, 1));
      const hot = h2(k + this.seed, tick >> 1) > 0.25;
      for (let s = 0; s < reach; s++) {
        const P = hot ? (s & 1 ? spark : ichor) : ichor;
        this.stroke(
          c[s * 2]!,
          c[s * 2 + 1]!,
          c[s * 2 + 2]!,
          c[s * 2 + 3]!,
          1,
          P,
          P.length - 1 - (s > reach - 2 ? 0 : 1),
          hot ? 200 : 90,
        );
      }
    }
    // debris and dust dragged in from all round
    const n = Math.round(50 * open);
    for (let i = 0; i < n; i++) {
      const life = 0.8 + 0.8 * h2(this.seed + i, 11);
      const p = (tick / 60 / life + h2(this.seed + i, 12)) % 1;
      const a = h2(this.seed + i, 13) * Math.PI * 2 + p * p * 5;
      const r = 230 * (1 - p * p) + 20;
      const P = i % 3 ? bone : crust;
      const x = this.cx + fcos(a) * r;
      const y = this.cy + fsin(a) * r;
      this.front.putPal(Math.floor(x), Math.floor(y), P, P.length - 1 - (i % 2), 30);
      if (i % 4 === 0) this.front.putPal(Math.floor(x + 1), Math.floor(y), P, P.length - 2, 0);
    }
  }

  /** A tear of light in space (body space): a vertical slit with violet edges, `open` 0..1. */
  private drawTear(x: number, y: number, open: number, unfold: boolean): void {
    if (open <= 0) return;
    const { spark, vortex } = this.pal;
    const h = 70 * open;
    for (let dy = -h; dy <= h; dy++) {
      const w = (1 - (dy / h) * (dy / h)) * (unfold ? 6 : 4) * open;
      const jx = (h2(Math.floor(dy), this.seed) - 0.5) * 3;
      for (let dx = -Math.ceil(w) - 1; dx <= Math.ceil(w) + 1; dx++) {
        const edge = Math.abs(dx) > w - 1;
        this.front.putPal(
          Math.floor(x + dx + jx),
          Math.floor(y + dy),
          edge ? vortex : spark,
          edge ? vortex.length - 2 : spark.length - 1,
          edge ? 80 : 220,
        );
      }
    }
  }

  /** The tear left behind when it folds away: drawn in the world where it was, closing. */
  private drawWorldTear(v: RemainderMoveView, k: number): void {
    const W = this.world;
    const open = k < 4 ? k / 4 : 1 - (k - 4) / 18;
    if (open <= 0) return;
    const { spark, vortex } = this.pal;
    const h = 64 * open;
    const x = v.foldFromX;
    const y = v.foldFromY;
    for (let dy = -h; dy <= h; dy++) {
      const w = (1 - (dy / h) * (dy / h)) * 5 * open;
      const jx = (h2(Math.floor(dy), this.seed + 1) - 0.5) * 3;
      for (let dx = -Math.ceil(w) - 1; dx <= Math.ceil(w) + 1; dx++) {
        const edge = Math.abs(dx) > w - 1;
        const P = edge ? vortex : spark;
        W.set(
          Math.floor(x + dx + jx),
          Math.floor(y + dy),
          P[edge ? P.length - 2 : P.length - 1]!,
          edge ? 80 : 220,
        );
      }
    }
    // the last of it streaming into the slit
    for (let i = 0; i < 14; i++) {
      const a = h2(this.seed + i, 21) * Math.PI * 2;
      const r = 70 * (1 - ((k + i) % 10) / 10);
      W.set(Math.floor(x + fcos(a) * r), Math.floor(y + fsin(a) * r * 0.8), vortex[vortex.length - 1]!, 60);
    }
  }

  /** LOOSENING's snap: a ring of light thrown outward as the wound slams shut. */
  private drawShutRing(k: number): void {
    const { spark, bone } = this.pal;
    const r = 20 + k * 16;
    const n = Math.round(r * 2.4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const P = i % 3 ? spark : bone;
      for (let t = 0; t < 2; t++)
        this.front.putPal(
          Math.floor(this.cx + fcos(a) * (r + t)),
          Math.floor(this.cy + fsin(a) * (r + t) * 0.9),
          P,
          P.length - 1,
          Math.max(0, 230 - k * 14),
        );
    }
    void DMath;
  }

  reset(): void {
    this.front.clear();
    this.world.hide();
  }
}
