import { ROT_LUT, ROT_ONE, hex, pb, pg, pr, type RenderLayer } from '@/contracts';
import { DMath } from '@/contracts/dmath';
import { BAY8, BodySkin, IdleClock, IdleRng, Pool, clampN, fcos, fsin, h2 } from '../fx/idle';
import type { Overlay } from '../fx/overlay';

/**
 * THE ASTEROID'S LIVING IDLE, RENDER SIDE (idle handover: specs/asteroid.md, prototype `rock.src.html`; WJ: "love the
 * twitchyness!!"). The pose itself (head snaps, darts, the feint, the spin) is sim state (asteroidPose.ts): the body really
 * turns and steps. This draws what rides on it, from per-tick records (the same at any frame rate and on both peers):
 *  - the swarm: the fragments (the resource) on stiff springs round tight orbits, trailing every dart and swinging back;
 *  - smear frames, the only titan allowed them (speed is its identity): a fast dart drags the silhouette out behind it in its
 *    own darker colours with speed lines off the trailing rim, a fast turn smears through the angles it swept, for 2 ticks;
 *    afterimages of a lunge, cooled toward ice;
 *  - life in the body (a skin, rotated with it by the renderer): the copper heart's quick lub-dub, light running along the
 *    ice veins as it turns (every vein lit while it charges), olivine winking;
 *  - the horn's glint on a lock and while charging, sniffs of vapour at the horn, gas jets for every dart, dust and rings.
 * Every colour is one of the Asteroid's own painted colours (the prototype's off-palette whites, ghost mix, gas and ring tails
 * map onto its ice and regolith ramps, spec §6); glow goes to the additive fx overlay and emissive only.
 */

/** What the fight and the pose tell the idle each tick. */
export interface RockIdleInput {
  /** Pose clock (asteroidPose `pt`) and the body's world position (pose included), rotation, facing. */
  pt: number;
  x: number;
  y: number;
  ox: number;
  oy: number;
  rot: number;
  facing: 1 | -1;
  /** The horn's world angle, the charge, ticks since the head locked. */
  dir: number;
  charge: number;
  lockAge: number;
  spinning: boolean;
  /** Pose events (their pose tick), as asteroidPose sets them. */
  dartAt: number;
  dartAng: number;
  dartN: number;
  hitAt: number;
  hitX: number;
  hitY: number;
  spinEndAt: number;
  /** Idle extras (glints, sniffs) show. */
  rest: boolean;
  /** Fragments orbiting (the resource), and whether they are out in the world (hidden here). */
  frags: number;
  hidden: boolean;
  guard: boolean;
  rubble: boolean;
  ko: boolean;
}

export interface RockIdleMap {
  version: number;
  w: number;
  h: number;
  material: Uint8Array;
  integrity: Uint8Array;
  flags: Uint8Array;
  infection: Uint8Array;
  pixels: Uint32Array;
  emissive: Uint8Array;
}

const FIGHT_FLAGS = 1 | 2 | 4 | 8 | 64;
const RING = 16;
const TAU = Math.PI * 2;
const FRAG = 12;
const STEP_PER_FRAME = 256 / 72;

interface Peb {
  id: number;
  a: number;
  r: number;
  sp: number;
  tilt: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  tone: number;
  kick: number;
  init: boolean;
}
interface Part {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  gas: boolean;
  c: number;
}
interface Ring {
  x: number;
  y: number;
  t0: number;
  big: boolean;
}
interface Ghost {
  x: number;
  y: number;
  rot: number;
  facing: 1 | -1;
  t0: number;
}
/** A silhouette of the body at one rotation step and facing: per destination pixel (relative to the pivot) its source cell. */
interface Sil {
  key: number;
  version: number;
  x0: number;
  y0: number;
  w: number;
  h: number;
  cell: Int32Array;
  n: number;
  list: Int32Array;
}

export class AsteroidIdle {
  readonly skin: BodySkin;
  private readonly W: number;
  private readonly H: number;
  private readonly ax: number;
  private readonly ay: number;
  private readonly R: number;
  private readonly ids: Record<string, number>;
  private readonly origBase: Uint32Array;
  /** Per material id: its painted colours by luminance; per cell its rank on its ladder. */
  private readonly lad: Uint32Array[] = [];
  private readonly rank: Int16Array;
  private readonly cellMat: Uint8Array;
  private readonly rockL: Uint32Array;
  /** The prototype's ICEHOT[0..2] and its tails, mapped onto the ice and regolith ramps. */
  private readonly ice0: number;
  private readonly iceTop: number;
  private readonly gasTail: number;
  private readonly ringTail: number;
  private readonly iceLad: Uint32Array;
  private readonly regLad: Uint32Array;
  private readonly cellHash: Uint32Array;

  /* the clock and per-tick inputs */
  readonly clock = new IdleClock();
  private readonly rng: IdleRng;
  private readonly seed: number;
  private readonly ring: RockIdleInput[];
  private readonly ringTick = new Int32Array(RING).fill(-1);
  private readonly lastIn: RockIdleInput;

  /* state */
  private readonly peb: Peb[] = [];
  private readonly parts = new Pool<Part>(128, () => ({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    age: 0,
    life: 1,
    gas: true,
    c: 0,
  }));
  private readonly rings = new Pool<Ring>(8, () => ({ x: 0, y: 0, t0: 0, big: false }));
  private readonly ghosts = new Pool<Ghost>(12, () => ({ x: 0, y: 0, rot: 0, facing: 1, t0: 0 }));
  private prevOx = 0;
  private prevOy = 0;
  private prevRot = -1;
  private prevX = 0;
  private prevY = 0;
  private prevFacing: 1 | -1 = 1;
  private smearT0 = -99;
  private smearDx = 0;
  private smearDy = 0;
  private smearLen = 0;
  private rsT0 = -99;
  private rsFrom = 0;
  private rsD = 0;
  private nextSniff = 1;
  private lastPt = -1;
  private readonly sils: Sil[] = [];

  constructor(
    map: { w: number; h: number; material: Uint8Array; baseColor: Uint32Array },
    rig: { core: { x: number; y: number }; radius: number; ids: Record<string, number> },
    anchor: { x: number; y: number },
    origBase: Uint32Array,
    seed: number,
  ) {
    const W = (this.W = map.w);
    const H = (this.H = map.h);
    const N = W * H;
    this.ax = anchor.x;
    this.ay = anchor.y;
    this.R = rig.radius;
    this.ids = rig.ids;
    this.origBase = origBase;
    this.seed = seed;
    this.rng = new IdleRng(seed);
    this.skin = new BodySkin(W, H);
    const mat = map.material;
    const lum = (c: number): number => 0.3 * pr(c) + 0.59 * pg(c) + 0.11 * pb(c);
    // ladders: every painted colour of a material, by luminance ("index shift, not alpha")
    const maxM = Math.max(...Object.values(rig.ids)) + 1;
    const sets: Set<number>[] = Array.from({ length: maxM }, () => new Set());
    for (let i = 0; i < N; i++) if (mat[i]) sets[mat[i]!]?.add((origBase[i]! | 0xff000000) >>> 0);
    for (let m = 0; m < maxM; m++) {
      const L = [...(sets[m] ?? [])].sort((a, b) => lum(a) - lum(b));
      this.lad[m] = Uint32Array.from(L);
    }
    this.rank = new Int16Array(N).fill(-1);
    this.cellMat = new Uint8Array(N);
    this.cellHash = new Uint32Array(N);
    const idx: Map<number, number>[] = this.lad.map((L) => {
      const mp = new Map<number, number>();
      L.forEach((c, k) => mp.set(c, k));
      return mp;
    });
    for (let i = 0; i < N; i++) {
      const m = mat[i]!;
      if (!m) continue;
      const c = (origBase[i]! | 0xff000000) >>> 0;
      this.cellMat[i] = m;
      this.rank[i] = idx[m]?.get(c) ?? -1;
      this.cellHash[i] = (c * 2654435761) >>> 24;
    }
    const reg = this.lad[rig.ids['regolith']!] ?? new Uint32Array(0);
    const kam = this.lad[rig.ids['kamacite']!] ?? new Uint32Array(0);
    this.rockL = Uint32Array.from(
      [...reg, ...kam].filter((c) => lum(c) > 28 && lum(c) < 215).sort((a, b) => lum(a) - lum(b)),
    );
    this.iceLad = this.lad[rig.ids['ice']!] ?? new Uint32Array(0);
    this.regLad = reg;
    const nearest = (L: Uint32Array, want: number, fallback: number): number => {
      let best = fallback;
      let bd = 1e9;
      for (const c of L) {
        const er = pr(c) - pr(want);
        const eg = pg(c) - pg(want);
        const eb = pb(c) - pb(want);
        const d = er * er + eg * eg + eb * eb;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      return best;
    };
    const iceTopF = this.iceLad.length ? this.iceLad[this.iceLad.length - 1]! : hex('#defafb');
    this.iceTop = nearest(this.iceLad, hex('#defafb'), iceTopF);
    this.ice0 = nearest(this.iceLad, hex('#a2ecef'), iceTopF);
    this.gasTail = nearest(this.iceLad, hex('#2c98bd'), iceTopF);
    this.ringTail = nearest(reg, hex('#cdbb98'), iceTopF);
    for (let k = 0; k < FRAG; k++)
      this.peb.push({
        id: k,
        a: 0,
        r: 0,
        sp: 0,
        tilt: 0,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        size: 0,
        tone: 0,
        kick: 0,
        init: false,
      });
    const mk = (): RockIdleInput => ({
      pt: 0,
      x: 0,
      y: 0,
      ox: 0,
      oy: 0,
      rot: 0,
      facing: 1,
      dir: 0,
      charge: 0,
      lockAge: 999,
      spinning: false,
      dartAt: -1,
      dartAng: 0,
      dartN: 0,
      hitAt: -1,
      hitX: 0,
      hitY: 0,
      spinEndAt: -1,
      rest: true,
      frags: 0,
      hidden: false,
      guard: false,
      rubble: false,
      ko: false,
    });
    this.ring = Array.from({ length: RING }, mk);
    this.lastIn = mk();
    this.reset();
  }

  reset(): void {
    this.clock.reset();
    this.rng.reseed(this.seed);
    this.ringTick.fill(-1);
    for (let k = 0; k < FRAG; k++) {
      const p = this.peb[k]!;
      p.a = (k / FRAG) * TAU;
      p.r = 66 + (k % 3) * 8 + this.rnd() * 6;
      p.sp = 2.6 + this.rnd() * 1.4;
      p.tilt = (this.rnd() - 0.5) * 0.5;
      p.size = [3.2, 1.8, 2.5, 1.4][k % 4]! + this.rnd() * 0.6;
      p.tone = this.rnd();
      p.kick = 0;
      p.vx = p.vy = 0;
      p.init = false;
    }
    this.parts.clear();
    this.rings.clear();
    this.ghosts.clear();
    this.prevRot = -1;
    this.smearT0 = -99;
    this.rsT0 = -99;
    this.nextSniff = 1;
    this.lastPt = -1;
  }

  private rnd(): number {
    return this.rng.next();
  }

  record(tick: number, inp: RockIdleInput): void {
    if (this.clock.last < 0) this.clock.last = tick - 1;
    const k = tick & (RING - 1);
    Object.assign(this.ring[k]!, inp);
    this.ringTick[k] = tick;
    Object.assign(this.lastIn, inp);
  }

  private inputAt(tick: number): RockIdleInput {
    const k = tick & (RING - 1);
    return this.ringTick[k] === tick ? this.ring[k]! : this.lastIn;
  }

  advance(tick: number): boolean {
    const n = this.clock.due(tick);
    for (let i = 0; i < n; i++) this.step(this.inputAt(tick - n + 1 + i));
    return n > 0;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  one fixed step
   * ---------------------------------------------------------------------------------------------- */

  private gasAt(
    x: number,
    y: number,
    a: number,
    n: number,
    s0: number,
    s1: number,
    life0: number,
    life1: number,
  ): void {
    for (let k = 0; k < n; k++) {
      const p = this.parts.alloc();
      if (!p) return;
      const s = s0 + this.rnd() * (s1 - s0);
      const aa = a + (this.rnd() - 0.5) * 0.5;
      p.x = x;
      p.y = y;
      p.vx = fcos(aa) * s;
      p.vy = fsin(aa) * s;
      p.age = 0;
      p.life = life0 + this.rnd() * (life1 - life0);
      p.gas = true;
    }
  }

  private dust(x: number, y: number, n: number, sp: number): void {
    const L = this.regLad;
    for (let k = 0; k < n; k++) {
      const p = this.parts.alloc();
      if (!p) return;
      const a = this.rnd() * TAU;
      const s = sp * (0.4 + this.rnd());
      p.x = x;
      p.y = y;
      p.vx = fcos(a) * s;
      p.vy = fsin(a) * s;
      p.age = 0;
      p.life = 0.5 + this.rnd() * 0.6;
      p.gas = false;
      p.c = L.length ? L[Math.floor(this.rnd() * L.length)]! : this.ringTail;
    }
  }

  private ringAt(x: number, y: number, big: boolean): void {
    const r = this.rings.alloc();
    if (!r) return;
    r.x = x;
    r.y = y;
    r.t0 = this.clock.t;
    r.big = big;
  }

  private step(inp: RockIdleInput): void {
    const dt = IdleClock.DT;
    const C = this.clock;
    C.t += dt;
    const t = C.t;
    const fresh = inp.pt !== this.lastPt;
    this.lastPt = inp.pt;

    // ---- pose events (each once) ----
    if (fresh && inp.dartAt === inp.pt && !inp.ko) {
      const rr = this.R * 0.8;
      this.gasAt(
        inp.x + fcos(inp.dartAng) * rr,
        inp.y + fsin(inp.dartAng) * rr,
        inp.dartAng,
        inp.dartN,
        20,
        60,
        0.18,
        0.43,
      );
    }
    if (fresh && inp.hitAt === inp.pt) {
      this.ringAt(inp.hitX, inp.hitY, false);
      this.dust(inp.hitX, inp.hitY, 12, 35);
    }
    if (fresh && inp.spinEndAt === inp.pt) {
      this.dust(inp.x, inp.y, 20, 50);
      this.ringAt(inp.x, inp.y, true);
    }
    // ---- sniffs: little breaths of vapour at the horn ----
    if (inp.rest && t > this.nextSniff) {
      const tx = inp.x + fcos(inp.dir) * this.R * 1.32;
      const ty = inp.y + fsin(inp.dir) * this.R * 1.32;
      for (let k = 0; k < 4; k++) {
        const p = this.parts.alloc();
        if (!p) break;
        p.x = tx;
        p.y = ty;
        p.vx = fcos(inp.dir) * 10 + (this.rnd() - 0.5) * 6;
        p.vy = fsin(inp.dir) * 10 + (this.rnd() - 0.5) * 6;
        p.age = 0;
        p.life = 0.35;
        p.gas = true;
      }
      this.nextSniff = t + 0.9 + this.rnd() * 0.8;
    }

    // ---- afterimages and smears: the pose's own fast motion (not walking or knockback) ----
    if (this.prevRot >= 0) {
      const mx = inp.ox - this.prevOx;
      const my = inp.oy - this.prevOy;
      const moved = Math.sqrt(mx * mx + my * my);
      if (moved >= 3) {
        const g = this.ghosts.alloc();
        if (g) {
          g.x = this.prevX;
          g.y = this.prevY;
          g.rot = this.prevRot;
          g.facing = this.prevFacing;
          g.t0 = t;
        }
      }
      if (moved >= 2.5) {
        this.smearT0 = t;
        this.smearDx = mx / moved;
        this.smearDy = my / moved;
        this.smearLen = Math.min(22, Math.round(moved * 1.3));
      }
      let d = inp.rot - this.prevRot;
      if (d > 128) d -= 256;
      if (d < -128) d += 256;
      if (inp.facing === this.prevFacing && Math.abs(d) >= 2 * STEP_PER_FRAME) {
        this.rsT0 = t;
        this.rsFrom = this.prevRot;
        this.rsD = d;
      }
    }
    this.prevOx = inp.ox;
    this.prevOy = inp.oy;
    this.prevRot = inp.rot;
    this.prevX = inp.x;
    this.prevY = inp.y;
    this.prevFacing = inp.facing;
    for (let i = this.ghosts.n - 1; i >= 0; i--)
      if (t - this.ghosts.items[i]!.t0 >= 0.16) this.ghosts.kill(i);

    // ---- the swarm: fragments on stiff springs round tight orbits ----
    const tight =
      (inp.charge > 0 ? 1 - inp.charge * 0.35 : 1) * (inp.guard ? 0.72 : 1) * (inp.rubble ? 1.15 : 1);
    for (let k = 0; k < FRAG; k++) {
      const p = this.peb[k]!;
      if (inp.spinning) p.kick = 1;
      p.a += dt * p.sp * (1 + inp.charge * 1.8 + p.kick * 3);
      p.kick = Math.max(0, p.kick - dt * 2);
      const rr = p.r * tight * (1 + p.kick * 0.6);
      const ex = fcos(p.a) * rr;
      const ey = fsin(p.a) * rr * 0.52;
      const c = fcos(p.tilt + 0.2);
      const s = fsin(p.tilt + 0.2);
      const tx = inp.x + ex * c - ey * s;
      const ty = inp.y + ex * s + ey * c;
      if (!p.init) {
        p.x = tx;
        p.y = ty;
        p.init = true;
      }
      p.vx += ((tx - p.x) * 260 - p.vx * 13) * dt;
      p.vy += ((ty - p.y) * 260 - p.vy * 13) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    // ---- particles and rings age ----
    for (let i = this.parts.n - 1; i >= 0; i--) {
      const p = this.parts.items[i]!;
      p.age += dt;
      if (p.age > p.life) {
        this.parts.kill(i);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - dt * 3;
      p.vy *= 1 - dt * 3;
    }
    for (let i = this.rings.n - 1; i >= 0; i--) {
      const r = this.rings.items[i]!;
      if ((t - r.t0) / (r.big ? 0.45 : 0.32) > 1) this.rings.kill(i);
    }
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  drawing
   * ---------------------------------------------------------------------------------------------- */

  private stepCol(i: number, k: number): number {
    const L = this.lad[this.cellMat[i]!];
    const r = this.rank[i]!;
    if (!L || r < 0) return this.origBase[i]!;
    return L[clampN(r + k, 0, L.length - 1)]!;
  }

  private changed(map: RockIdleMap, i: number): boolean {
    return (
      map.integrity[i]! < 255 ||
      (map.flags[i]! & FIGHT_FLAGS) !== 0 ||
      map.infection[i]! !== 0 ||
      map.pixels[i] !== this.origBase[i]
    );
  }

  /** The body's life, in its own skin (map space: the renderer rotates it with the body). Presented every frame. */
  renderBody(body: RenderLayer, map: RockIdleMap, redraw: boolean): void {
    if (redraw) {
      const inp = this.inputAt(this.clock.last);
      const t = this.clock.t;
      const skin = this.skin;
      skin.copyFrom(map.pixels, map.emissive);
      const px = skin.px;
      const em = skin.emis;
      const W = this.W;
      const N = W * this.H;
      const ids = this.ids;
      const beat = (t * 2.6) % 1;
      const pulse = beat < 0.08 ? 2 : beat < 0.16 ? 1 : beat > 0.28 && beat < 0.34 ? 1 : 0;
      const live = !inp.ko;
      const dense = ids['dense']!;
      const ice = ids['ice']!;
      const oliv = ids['olivine']!;
      const sweep = inp.dir * 9;
      const ch = inp.charge;
      const wink = Math.floor(t * 3);
      if (live)
        for (let i = 0; i < N; i++) {
          const m = map.material[i]!;
          if (m !== dense && m !== ice && m !== oliv) continue;
          if (this.changed(map, i)) continue;
          const x = i % W;
          const y = (i - x) / W;
          if (m === dense) {
            const k = Math.min(2, (pulse ? 1 : 0) + Math.round(ch));
            if (k) px[i] = this.stepCol(i, k);
            if (pulse === 2) em[i] = Math.max(em[i]!, 40);
          } else if (m === ice) {
            if (ch > 0.1) {
              // the veins charge: every one lit, hotter as the charge builds
              const k = Math.floor(ch * 2.4 + BAY8[((y & 7) << 3) | (x & 7)]!);
              px[i] = k >= 1 ? this.iceTop : this.ice0;
              em[i] = Math.max(em[i]!, Math.min(255, 80 * ch));
            } else if (fsin((x + y) * 0.35 - t * 9 - sweep) > 0.93) {
              // light runs along the veins as it turns
              px[i] = this.iceTop;
              em[i] = Math.max(em[i]!, 55);
            }
          } else if (h2(this.cellHash[i]! + x * 3 + y, wink) > 0.93) px[i] = this.stepCol(i, 2);
        }
    }
    this.skin.present(body, redraw);
  }

  /** The swarm, smears, afterimages, the horn, gas, dust, rings (into the behaviour's overlays, already begun). */
  drawOverlays(back: Overlay, front: Overlay, fx: Overlay, map: RockIdleMap): void {
    const inp = this.inputAt(this.clock.last);
    const t = this.clock.t;
    if (inp.ko) return;
    // ---- the swarm, behind ----
    if (!inp.hidden)
      for (let k = 0; k < Math.min(FRAG, inp.frags); k++) this.drawPeb(back, this.peb[k]!, false);
    // ---- afterimages: the last positions of a fast move, dithered and cooled toward ice ----
    for (let gi = 0; gi < this.ghosts.n; gi++) {
      const g = this.ghosts.items[gi]!;
      const k = 1 - (t - g.t0) / 0.16;
      const S = this.sil(map, g.rot, g.facing);
      this.stamp(back, S, g.x, g.y, 0, 0, k * 0.55, 'ghost', 0);
    }
    // ---- smear frames ----
    if ((t - this.rsT0) * 60 < 2 + 1e-6 && this.rsD !== 0) {
      // turning fast: the angles it swept, behind it, darker and broken toward the back
      const frames = Math.min(6, Math.round(Math.abs(this.rsD) / STEP_PER_FRAME));
      const sg = Math.sign(this.rsD);
      const fade = 1 - (t - this.rsT0) * 30;
      for (let k = frames - 1; k >= 1; k--) {
        const rot = (this.rsFrom + Math.round(sg * k * STEP_PER_FRAME)) & 255;
        const S = this.sil(map, rot, inp.facing);
        this.stamp(
          back,
          S,
          inp.x,
          inp.y,
          0,
          0,
          (k / frames) * fade * 0.9,
          'step',
          -1 - (k < frames / 2 ? 1 : 0),
        );
      }
    }
    if ((t - this.smearT0) * 60 < 2 + 1e-6 && this.smearLen > 0) {
      // travelling fast: the silhouette dragged out behind it, solid at the body, breaking up at the tail
      const len = Math.max(1, Math.round(this.smearLen * (1 - (t - this.smearT0) * 30)));
      const S = this.sil(map, inp.rot, inp.facing);
      for (let s = len; s >= 1; s--) {
        const u = s / len;
        this.stamp(
          back,
          S,
          inp.x,
          inp.y,
          Math.round(-this.smearDx * s),
          Math.round(-this.smearDy * s),
          -DMath.pow(u, 1.4) * 0.95,
          'step',
          -2 - Math.floor(u * 3),
        );
      }
      this.speedLines(back, S, inp.x, inp.y, len);
    }
    // ---- the horn: a glint when the head locks on, a white-hot point while it charges ----
    if (inp.rest || inp.charge > 0) {
      const tx = Math.round(inp.x + fcos(inp.dir) * (this.R * 1.3 + 1));
      const ty = Math.round(inp.y + fsin(inp.dir) * (this.R * 1.3 + 1));
      const lock = inp.lockAge / 60;
      if (inp.charge > 0.2 || lock < 0.09) {
        const hot = inp.charge > 0.6 || lock < 0.04;
        front.set(tx, ty, this.iceTop, 255);
        fx.glow(tx + 0.5, ty + 0.5, hot ? 4 : 3, 220, 252, 255, hot ? 1 : 0.7);
        if (hot)
          for (let q = 0; q < 4; q++)
            front.set(tx + [-1, 1, 0, 0][q]!, ty + [0, 0, -1, 1][q]!, this.ice0, 160);
        if (inp.charge > 0.9)
          for (let q = 0; q < 4; q++)
            front.set(tx + [-2, 2, 0, 0][q]!, ty + [0, 0, -2, 2][q]!, this.ice0, 120);
      }
    }
    // ---- the swarm, in front ----
    if (!inp.hidden)
      for (let k = 0; k < Math.min(FRAG, inp.frags); k++) this.drawPeb(front, this.peb[k]!, true);
    // ---- gas, dust, rings ----
    for (let i = 0; i < this.parts.n; i++) {
      const p = this.parts.items[i]!;
      const k = p.age / p.life;
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      if (BAY8[((y & 7) << 3) | (x & 7)]! < k) continue;
      if (p.gas)
        front.set(x, y, k < 0.3 ? this.iceTop : k < 0.6 ? this.ice0 : this.gasTail, k < 0.3 ? 90 : 30);
      else front.set(x, y, p.c);
    }
    for (let i = 0; i < this.rings.n; i++) {
      const R = this.rings.items[i]!;
      const u = (t - R.t0) / (R.big ? 0.45 : 0.32);
      const rad = 2 + u * (R.big ? 30 : 18);
      for (let a = 0; a < TAU; a += 1 / rad) {
        const x = Math.round(R.x + fcos(a) * rad);
        const y = Math.round(R.y + fsin(a) * rad * 0.8);
        if (BAY8[((y & 7) << 3) | (x & 7)]! < u) continue;
        front.set(x, y, u < 0.3 ? this.iceTop : this.ringTail, u < 0.3 ? 80 * (1 - u) : 0);
      }
    }
  }

  /** A fragment: a noisy disc lit by a turning light, from the rock's own colours. */
  private drawPeb(ov: Overlay, p: Peb, front: boolean): void {
    const z = fsin(p.a);
    if (z >= 0 !== front) return;
    const cx = Math.round(p.x);
    const cy = Math.round(p.y);
    const R = p.size;
    const R2 = Math.ceil(R);
    const spin = p.a * 1.7 + p.tone * 9;
    const lx = fcos(spin) * 0.6 - 0.55;
    const ly = fsin(spin) * 0.6 - 0.65;
    const L = this.rockL;
    if (!L.length) return;
    for (let yy = -R2; yy <= R2; yy++)
      for (let xx = -R2; xx <= R2; xx++) {
        const d = Math.sqrt(xx * xx + yy * yy) / (R + 0.35 + (h2(xx + p.id * 7, yy) - 0.5) * 0.7);
        if (d > 1) continue;
        const nx = xx / (R + 0.5);
        const ny = yy / (R + 0.5);
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        let sh = -(nx * lx + ny * ly) * 0.9 + nz * 0.35 + (front ? 0.05 : -0.25);
        if (d > 0.8) sh -= 0.35;
        const X = cx + xx;
        const Y = cy + yy;
        const k = clampN(
          Math.floor((sh + 0.35) * L.length * 0.8 + BAY8[((Y & 7) << 3) | (X & 7)]! * 1.2),
          0,
          L.length - 1,
        );
        ov.set(X, Y, L[k]!);
      }
  }

  /**
   * The body's silhouette at a rotation step and facing (nearest-texel inverse rotation about the anchor corner, mirrored
   * first as the renderer does), cached per angle while the matter is unchanged. Smears and afterimages only: dithered and
   * darkened, so the cheap sampler is enough.
   */
  private sil(map: RockIdleMap, rot: number, facing: 1 | -1): Sil {
    const key = rot * 2 + (facing < 0 ? 1 : 0);
    for (const s of this.sils) if (s.key === key && s.version === map.version) return s;
    const W = this.W;
    const H = this.H;
    const c = ROT_LUT.cos[rot]! / ROT_ONE;
    const s = ROT_LUT.sin[rot]! / ROT_ONE;
    // destination bounds: the rotated map rectangle about the pivot
    const cx = [-this.ax, W - this.ax, W - this.ax, -this.ax];
    const cy = [-this.ay, -this.ay, H - this.ay, H - this.ay];
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1e9;
    let y1 = -1e9;
    for (let k = 0; k < 4; k++) {
      const mx = cx[k]! * facing;
      const X = c * mx - s * cy[k]!;
      const Y = s * mx + c * cy[k]!;
      x0 = Math.min(x0, X);
      y0 = Math.min(y0, Y);
      x1 = Math.max(x1, X);
      y1 = Math.max(y1, Y);
    }
    const bx0 = Math.floor(x0) - 1;
    const by0 = Math.floor(y0) - 1;
    const w = Math.ceil(x1) - bx0 + 2;
    const h = Math.ceil(y1) - by0 + 2;
    let S = this.sils.length >= 6 ? this.sils.shift()! : null;
    if (!S || S.cell.length < w * h)
      S = {
        key,
        version: 0,
        x0: 0,
        y0: 0,
        w: 0,
        h: 0,
        cell: new Int32Array(w * h),
        n: 0,
        list: new Int32Array(w * h),
      };
    S.key = key;
    S.version = map.version;
    S.x0 = bx0;
    S.y0 = by0;
    S.w = w;
    S.h = h;
    S.n = 0;
    const mat = map.material;
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const X = bx0 + i + 0.5;
        const Y = by0 + j + 0.5;
        // inverse rotation, then un-mirror
        const mx = c * X + s * Y;
        const my = -s * X + c * Y;
        const lx = Math.floor(this.ax + mx * facing);
        const ly = Math.floor(this.ay + my);
        let cell = -1;
        if (lx >= 0 && ly >= 0 && lx < W && ly < H && mat[ly * W + lx]) cell = ly * W + lx;
        S.cell[j * w + i] = cell;
        if (cell >= 0) S.list[S.n++] = j * w + i;
      }
    this.sils.push(S);
    return S;
  }

  /**
   * Stamp a silhouette at world (x + dx, y + dy). `keep` > 0: a pixel shows where bayer ≤ keep; < 0: where bayer ≥ −keep (the
   * smear's solid-near-the-body falloff). `mode` 'step' darkens each cell `k` rungs down its own ramp; 'ghost' cools it to ice.
   */
  private stamp(
    ov: Overlay,
    S: Sil,
    x: number,
    y: number,
    dx: number,
    dy: number,
    keep: number,
    mode: 'step' | 'ghost',
    k: number,
  ): void {
    const ice = this.iceLad;
    const lumOf = (c: number): number => (0.3 * pr(c) + 0.59 * pg(c) + 0.11 * pb(c)) / 255;
    for (let q = 0; q < S.n; q++) {
      const j = S.list[q]!;
      const cell = S.cell[j]!;
      const X = x + S.x0 + (j % S.w) + dx;
      const Y = y + S.y0 + ((j / S.w) | 0) + dy;
      const b = BAY8[((Y & 7) << 3) | (X & 7)]!;
      if (keep >= 0 ? b > keep : b < -keep) continue;
      if (mode === 'step') ov.set(X, Y, this.stepCol(cell, k));
      else if (ice.length) {
        // cooled toward ice: the cell's brightness rank on the ice ramp (the prototype's off-palette mix, spec §6)
        const r = Math.round(lumOf(this.origBase[cell]!) * (ice.length - 1) * 0.55 + (ice.length - 1) * 0.45);
        ov.set(X, Y, ice[clampN(r, 0, ice.length - 1)]!);
      }
    }
  }

  /** Speed lines off the trailing rim of a travel smear. */
  private speedLines(ov: Overlay, S: Sil, x: number, y: number, len: number): void {
    const w = S.w;
    const cxs = -S.x0;
    const cys = -S.y0;
    const top = this.rockL.length ? this.rockL[this.rockL.length - 1]! : this.ringTail;
    for (let q = 0; q < S.n; q++) {
      const j = S.list[q]!;
      const i = j % w;
      const jy = (j / w) | 0;
      if (i < 1 || jy < 1 || i >= w - 1 || jy >= S.h - 1) continue;
      if (S.cell[j - 1]! >= 0 && S.cell[j + 1]! >= 0 && S.cell[j - w]! >= 0 && S.cell[j + w]! >= 0) continue;
      if ((i - cxs) * this.smearDx + (jy - cys) * this.smearDy > -6 || h2(i * 7 + this.prevRot, jy) < 0.93)
        continue;
      const ll = Math.round(len * (1.3 + h2(jy, i) * 0.9));
      for (let k = 1; k <= ll; k++) {
        const X = Math.round(x + S.x0 + i - this.smearDx * k);
        const Y = Math.round(y + S.y0 + jy - this.smearDy * k);
        const u = k / ll;
        if (BAY8[((Y & 7) << 3) | (X & 7)]! < u) continue;
        ov.set(X, Y, u < 0.35 ? this.ice0 : top);
      }
    }
  }
}
