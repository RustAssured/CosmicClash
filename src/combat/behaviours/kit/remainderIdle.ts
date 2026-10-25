import { pb, pg, pr, type MatterMap, type RenderLayer } from '@/contracts';
import { DMath } from '@/contracts/dmath';
import { BodySkin, BodySpaceLayer, bay8, fcos, fsin, h2, vnoise } from '../../fx/idle';

/**
 * THE REMAINDER'S LIVING IDLE (presentation only: the sim never reads it; the one clock is the sim tick, so replays and both
 * netplay peers see the same idle). A wound in reality that wants to close and is held open by force: everything about it
 * is strain.
 *
 *  - the vortex SWIRLS VIOLENTLY and DRAINS: each cell shows the painted colour from where the spiral was a moment ago,
 *    further round (much faster near the eye) and further out (the inflow), with turbulence and surges. It is a flow map:
 *    two copies of the motion half a cycle apart, cross-faded through the Bayer pattern, so it can spin and drain forever
 *    without winding the arms into rings;
 *  - it tries to CLOSE and tears itself OPEN: every few seconds the eye shrinks and the swirl chokes, then it forces itself
 *    open (the eye blown wide, a flash through the veins, a burst of speed, the body shuddering);
 *  - it SUCKS IN its surroundings: the shell around the vortex creeps inward, stress fractures crackle along the rim,
 *    wreckage spirals in and is consumed, and dust streams over the shell into the eye;
 *  - it is UNDER STRESS: the body twitches, and shakes when it is hit (the fear) or tears open;
 *  - the ichor races down the green veins toward the core.
 *
 * Cells a fight has changed (damage, heat, char, infection) are left exactly as the matter world shows them.
 */

const FIGHT_FLAGS = 1 | 2 | 4 | 8 | 64;
/** Angular speed of the vortex's rim (rad/s); the eye turns up to 5× faster. */
const SPIN = 2.4;
/** Inflow (per second, logarithmic): how fast the colours stream toward the eye. */
const INFLOW = 0.35;
/** One cycle of the flow map (s): each copy of the motion runs this long before it fades out and restarts. */
const FLOW_T = 0.6;
/** The closing spasm: one every SPASM_EVERY s (± a third), lasting SPASM_LEN s (closing for the first 60 %). */
const SPASM_EVERY = 5.5;
const SPASM_LEN = 1.4;
/** Wreckage chunks and dust motes being drawn in. */
const CHUNKS = 9;
const MOTES = 28;

/** What the moves ask of the idle this frame (src/combat/behaviours/kit/remainderFx.ts `act`); neutral = 1 / 0. */
export interface RemainderAct {
  /** Multipliers on the vortex's spin and inflow. */
  spin: number;
  inflow: number;
  /** 0..1: the vortex darkens (the tell of an intake). */
  dark: number;
  /** 0..1: the wound spreads over the shell (Loosening). */
  loosen: number;
  /** 0..1: the wound is held shut (Hold Shut, the snap of Loosening): plates over the rim, the vortex stalled and dark. */
  shut: number;
  /** 0..1: the body drains into its own eye (Fold: 1 = gone), twisted by `twist` radians. */
  fold: number;
  twist: number;
  /** Multiplier on the eye's opening (below 0.15 it is shut). */
  pupil: number;
  /** 0..1: the eye's rim blazes. */
  glow: number;
  /** 0..1: the whole vortex flares a step brighter. */
  flash: number;
  /** Extra shaking (px). */
  shake: number;
  /** A move is running: the body redraws every tick and the spontaneous spasms hold off. */
  busy: boolean;
}

export const NEUTRAL_ACT: RemainderAct = {
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
  busy: false,
};

export interface RemainderIdleInput {
  /** Sim tick of the frame. */
  tick: number;
  /** Ticks since it was last hit. */
  sinceHit: number;
  ko: boolean;
  /** What the moves ask of it (default: nothing). */
  act?: RemainderAct;
}

interface Chunk {
  /** Start radius (cells), flattening, tilt (rad), orbit period (s), phase (rad), size (cells), shade, outline seed. */
  a: number;
  flat: number;
  tilt: number;
  period: number;
  phase: number;
  size: number;
  shade: number;
  mask: number;
  /** Its fall into the vortex: one fall every `fall` s, offset by `off` (0..1). */
  fall: number;
  off: number;
}

/** The spasm state at time t: `close` 0..1 (the wound closing), `open` 0..1 (tearing itself open, decaying). */
function spasm(t: number, seed: number): { close: number; open: number } {
  // spasm k starts at k·EVERY plus a jitter; look at the latest that has started
  const k = Math.floor(t / SPASM_EVERY);
  for (const kk of [k, k - 1]) {
    const start = kk * SPASM_EVERY + (h2(seed, kk) - 0.5) * SPASM_EVERY * 0.66;
    const u = (t - start) / SPASM_LEN;
    if (u < 0 || u > 1.6) continue;
    if (u < 0.6) return { close: fsin((u / 0.6) * Math.PI * 0.5), open: 0 };
    const v = (u - 0.6) / 1.0;
    return { close: 0, open: v < 0.08 ? v / 0.08 : Math.max(0, 1 - (v - 0.08) / 0.92) };
  }
  return { close: 0, open: 0 };
}

export class RemainderIdle {
  private readonly W: number;
  private readonly H: number;
  private readonly seed: number;
  private readonly skin: BodySkin;
  private readonly back: BodySpaceLayer;
  private readonly front: BodySpaceLayer;
  private readonly orig: Uint32Array;
  private readonly cx: number;
  private readonly cy: number;
  /** The spiral's radius (cells) and its cells: index, radius, angle. */
  private readonly rv: number;
  private readonly swirl: Int32Array;
  private readonly sr: Float32Array;
  private readonly sa: Float32Array;
  /** The shell around the vortex (rv … 1.6 rv), drawn inward: index, radius, angle. */
  private readonly ring: Int32Array;
  private readonly rr: Float32Array;
  private readonly ra: Float32Array;
  /** The vein cells (ichor, spark) and their distance from the core. */
  private readonly veins: Int32Array;
  private readonly vr: Float32Array;
  /** Whether a cell belongs to the turning set (vortex, ichor, spark, core). */
  private readonly turns: Uint8Array;
  /** Per material id: its painted colours dark → light; per cell its rank on that ladder. */
  private readonly lad: Uint32Array[] = [];
  private readonly rank: Int16Array;
  private readonly ids: {
    vortex: number;
    ichor: number;
    spark: number;
    core: number;
    bone: number;
    crust: number;
  };
  private readonly coreR: number;
  private readonly chunks: Chunk[] = [];
  /** The turbulence of this frame, per whole radius. */
  private readonly shiver: Float32Array;
  private lastTick = -1;
  private bodyTick = -99;
  private tmpPx: Uint32Array | null = null;
  private tmpEm: Uint8Array | null = null;
  private jx = 0;
  private jy = 0;

  constructor(map: MatterMap, materialKeys: readonly string[], seed: number) {
    const W = (this.W = map.w);
    const H = (this.H = map.h);
    const N = W * H;
    this.seed = seed;
    this.orig = map.baseColor.slice();
    this.skin = new BodySkin(W, H);
    const id = (k: string): number => materialKeys.indexOf(k) + 1;
    this.ids = {
      vortex: id('vortex'),
      ichor: id('ichor'),
      spark: id('spark'),
      core: id('core'),
      bone: id('bone'),
      crust: id('crust'),
    };
    this.cx = map.coreX + 0.5;
    this.cy = map.coreY + 0.5;
    this.coreR = map.coreRadius;
    const big = Math.max(W, H);
    this.back = new BodySpaceLayer('remainder-wreck-back', -1, big * 2, big * 2, map.coreX, map.coreY);
    this.front = new BodySpaceLayer('remainder-wreck-front', 1, big * 2, big * 2, map.coreX, map.coreY);

    // ladders: every painted colour of a material, by luminance (an idle steps a cell along it, never off the palette)
    const lum = (c: number): number => 0.3 * pr(c) + 0.59 * pg(c) + 0.11 * pb(c);
    const maxM = materialKeys.length + 1;
    const sets: Set<number>[] = Array.from({ length: maxM }, () => new Set());
    for (let i = 0; i < N; i++) if (map.material[i]) sets[map.material[i]!]?.add(this.orig[i]! >>> 0);
    for (let m = 0; m < maxM; m++)
      this.lad[m] = Uint32Array.from([...sets[m]!].sort((a, b) => lum(a) - lum(b)));
    const where = this.lad.map((L) => new Map([...L].map((c, k) => [c, k])));
    this.rank = new Int16Array(N).fill(-1);
    for (let i = 0; i < N; i++)
      if (map.material[i]) this.rank[i] = where[map.material[i]!]!.get(this.orig[i]! >>> 0) ?? -1;

    // the spiral: the radius holding 85 % of the vortex cells, and every turning cell inside it
    const polar = (i: number): [number, number] => {
      const dx = (i % W) + 0.5 - this.cx;
      const dy = Math.floor(i / W) + 0.5 - this.cy;
      return [DMath.hypot(dx, dy), DMath.atan2(dy, dx)];
    };
    this.turns = new Uint8Array(N);
    const turning = [this.ids.vortex, this.ids.ichor, this.ids.spark, this.ids.core].filter((m) => m > 0);
    const vr: number[] = [];
    for (let i = 0; i < N; i++) {
      const m = map.material[i]!;
      if (!turning.includes(m)) continue;
      this.turns[i] = 1;
      if (m === this.ids.vortex) vr.push(polar(i)[0]);
    }
    vr.sort((a, b) => a - b);
    this.rv = vr.length ? vr[Math.floor(vr.length * 0.85)]! : this.coreR * 4;
    const sw: number[] = [];
    const rg: number[] = [];
    for (let i = 0; i < N; i++) {
      if (!map.material[i]) continue;
      const r = polar(i)[0];
      if (this.turns[i] && r <= this.rv) sw.push(i);
      else if (!this.turns[i] && r > this.rv * 0.85 && r < this.rv * 1.6) rg.push(i);
    }
    this.swirl = Int32Array.from(sw);
    this.shiver = new Float32Array(Math.ceil(this.rv) + 2);
    this.sr = Float32Array.from(sw, (i) => polar(i)[0]);
    this.sa = Float32Array.from(sw, (i) => polar(i)[1]);
    // the ring sorted by angle, so a stress arc visits only its own segment
    rg.sort((p, q) => polar(p)[1] - polar(q)[1]);
    this.ring = Int32Array.from(rg);
    this.rr = Float32Array.from(rg, (i) => polar(i)[0]);
    this.ra = Float32Array.from(rg, (i) => polar(i)[1]);

    const vc: number[] = [];
    for (let i = 0; i < N; i++)
      if (map.material[i] === this.ids.ichor || map.material[i] === this.ids.spark) vc.push(i);
    this.veins = Int32Array.from(vc);
    this.vr = Float32Array.from(vc, (i) => polar(i)[0]);

    // the wreckage: chunks on tilted orbits that decay into the vortex (pale, lit rock from the bone and crust ladders)
    for (let k = 0; k < CHUNKS; k++) {
      const u = (n: number): number => h2(seed + k * 31, n);
      this.chunks.push({
        a: big * (0.4 + 0.18 * u(1)),
        flat: 0.25 + 0.18 * u(2),
        tilt: (u(3) - 0.5) * 1.1,
        period: 5 + 5 * u(4),
        phase: u(5) * Math.PI * 2,
        size: 5 + Math.floor(u(6) * 6),
        shade: u(7),
        mask: Math.floor(u(8) * 0x1ffffff),
        fall: 7 + 6 * u(9),
        off: u(10),
      });
    }
  }

  private changed(map: MatterMap, i: number): boolean {
    return (
      map.integrity[i]! < 255 ||
      (map.flags[i]! & FIGHT_FLAGS) !== 0 ||
      map.infection[i]! !== 0 ||
      map.pixels[i] !== this.orig[i]
    );
  }

  /** A cell's painted colour stepped `k` along its material's ladder. */
  private step(map: MatterMap, i: number, k: number): number {
    const L = this.lad[map.material[i]!]!;
    const r = this.rank[i]!;
    if (r < 0 || !L.length) return this.orig[i]!;
    return L[Math.max(0, Math.min(L.length - 1, r + k))]!;
  }

  /** Draw the frame: the body's skin (presented in place of the body layer), the wreckage layers, the body's shudder. */
  render(body: RenderLayer, map: MatterMap, inp: RemainderIdleInput, out: RenderLayer[]): void {
    if (inp.ko) {
      this.back.clear();
      this.front.clear();
      return;
    }
    const redraw = inp.tick !== this.lastTick;
    this.lastTick = inp.tick;
    const t = inp.tick / 60;
    const act = inp.act ?? NEUTRAL_ACT;
    // a move owns the vortex while it runs: no spontaneous spasm on top of it
    const sp = act.busy ? { close: 0, open: 0 } : spasm(t, this.seed);
    // the body animates on twos (30 Hz, like hand-drawn pixel art, and half the cost), at once when it is hit, so damage
    // is never late; the wreckage and the dust move every tick
    const bodyDue =
      redraw && (act.busy || inp.tick - this.bodyTick >= 2 || inp.tick < this.bodyTick || inp.sinceHit === 0);
    if (bodyDue) {
      this.drawBody(map, t, inp.sinceHit, sp, act);
      this.bodyTick = inp.tick;
    }
    this.skin.present(body, bodyDue);
    if (redraw) this.drawWreck(body, map, t, sp);
    else {
      this.back.follow(body);
      this.front.follow(body);
    }
    out.push(this.back.layer, this.front.layer);

    // the strain: small twitches all the time, hard shaking when it is hit or tears itself open (the wreckage holds still)
    if (redraw) {
      const hit = inp.sinceHit < 24 ? 1 - inp.sinceHit / 24 : 0;
      const tick = inp.tick;
      const twitch = h2(this.seed + 5, tick >> 2) > 0.82 ? 1 : 0;
      const amp = Math.max(
        twitch,
        Math.round(2 * hit),
        Math.round(2 * sp.open),
        sp.close > 0.5 ? 1 : 0,
        act.shake,
      );
      this.jx = amp ? Math.round((h2(tick, this.seed) * 2 - 1) * amp) : 0;
      this.jy = amp ? Math.round((h2(this.seed, tick) * 2 - 1) * amp * 0.6) : 0;
    }
    body.x += this.jx;
    body.prevX += this.jx;
    body.y += this.jy;
    body.prevY += this.jy;
  }

  private drawBody(
    map: MatterMap,
    t: number,
    sinceHit: number,
    sp: { close: number; open: number },
    act: RemainderAct,
  ): void {
    const { W, H, skin, ids, rv } = this;
    skin.copyFrom(map.pixels, map.emissive);
    const px = skin.px;
    const em = skin.emis;
    // the fear: a hit snaps the eye tight; a closing spasm squeezes it shut, tearing open blows it wide
    const flinch = sinceHit < 60 ? 1 - sinceHit / 60 : 0;
    const pupil0 = Math.max(
      1,
      this.coreR *
        (0.6 + 0.12 * fsin(t * 9) + 0.1 * fsin(t * 2.3) - 0.45 * flinch - 0.5 * sp.close + 0.9 * sp.open),
    );
    const pupil = act.pupil < 0.15 ? 0 : pupil0 * act.pupil;
    const blaze = Math.max(flinch, sp.open, act.glow);
    // how hard it turns: surges (noise), choked while closing, a burst when it tears open
    const surge =
      (1 + 0.5 * (vnoise(t * 1.7, 3.1) - 0.5)) * (1 - 0.7 * sp.close) * (1 + 2.2 * sp.open) * act.spin;
    const inflow = INFLOW * (1 - 1.4 * sp.close + 1.5 * sp.open) * act.inflow;
    // darker for an intake's tell and a held-shut wound, a step brighter for a flare
    const dim = Math.round(2 * act.dark + 2 * act.shut);
    const lift = act.flash > 0.5 ? 2 : act.flash > 0.15 ? 1 : 0;

    // the flow map: two copies of the motion, half a cycle apart; each cell picks one by the dither, weighted by a triangle
    const ph0 = (t / FLOW_T) % 1;
    const ph1 = (ph0 + 0.5) % 1;
    const w0 = 1 - Math.abs(2 * ph0 - 1);
    const grow0 = DMath.exp(inflow * ph0 * FLOW_T);
    const grow1 = DMath.exp(inflow * ph1 * FLOW_T);
    for (let q = 0; q < this.shiver.length; q++) this.shiver[q] = vnoise(q * 0.22, t * 6) - 0.5;
    for (let k = 0; k < this.swirl.length; k++) {
      const i = this.swirl[k]!;
      if (this.changed(map, i)) continue;
      const r = this.sr[k]!;
      const inner = 1 - r / rv;
      const omega = SPIN * surge * (1 + 4 * inner * inner);
      // an irregular per-cell threshold (a regular one shows the cross-fade as a checkerboard)
      const use0 = h2(i, 977) < w0;
      const ph = use0 ? ph0 : ph1;
      // turbulence: the angle shivers, more toward the eye (one noise value per whole radius, per frame)
      const shiver = this.shiver[r | 0]! * (0.35 + 0.6 * inner);
      const a = this.sa[k]! - omega * ph * FLOW_T + shiver;
      // the inflow: colours come from further out, never from beyond the rim (the rim streaks inward instead)
      const rs = Math.min(rv * 0.97, r * (use0 ? grow0 : grow1));
      const sx = Math.floor(this.cx + fcos(a) * rs);
      const sy = Math.floor(this.cy + fsin(a) * rs);
      let c = this.orig[i]!;
      if (sx >= 0 && sy >= 0 && sx < W && sy < H) {
        const j = sy * W + sx;
        // from beyond the spiral the colour is the vortex's own darkest (space being pulled in)
        if (this.turns[j] && !this.changed(map, j))
          c = dim || lift ? this.step(map, j, lift - dim) : this.orig[j]!;
        else c = this.lad[ids.vortex]?.[0] ?? c;
      }
      px[i] = c;
      if (lift) em[i] = Math.max(em[i]!, 60 * act.flash);
      // the eye: black inside the pupil, a rim of light at its edge (blinding when it tears open)
      if (r < pupil) px[i] = this.lad[ids.core]?.[0] ?? c;
      else if (r < pupil + 1.8) {
        const L = this.lad[ids.spark] ?? this.lad[ids.core]!;
        px[i] = L[Math.max(0, L.length - 1 - (blaze > 0.3 ? 0 : 2))]!;
        em[i] = Math.max(em[i]!, 70 + 150 * blaze);
      } else if (r < pupil + 4 && inner > 0.6) em[i] = Math.max(em[i]!, 30 + 60 * blaze);
    }

    // shut: an iris of bone closes over the wound from the rim inward (seven petals, seams between them, a slit of light
    // left at the centre): Hold Shut, and the snap at the end of Loosening
    if (act.shut > 0) {
      const B = this.lad[ids.bone] ?? this.lad[ids.crust]!;
      const C = this.lad[ids.crust] ?? B;
      const S = this.lad[ids.spark] ?? B;
      const open = rv * (1 - 0.97 * act.shut);
      const turn = t * 0.2;
      for (let k = 0; k < this.swirl.length; k++) {
        const i = this.swirl[k]!;
        if (this.changed(map, i)) continue;
        const r = this.sr[k]!;
        if (r < open) continue;
        const a = this.sa[k]!;
        // petal seams curve inward like an aperture
        const pet = ((a + turn) / (Math.PI * 2)) * 7 + (r / rv) * 0.9;
        const f = pet - Math.floor(pet);
        const lit = 0.55 - 0.3 * fsin(a + 0.8) - 0.25 * (1 - r / rv);
        if (f < 0.07) {
          px[i] = C[0]!;
        } else if (f < 0.12 && r < rv * 0.6) {
          px[i] = S[S.length - 1]!;
          em[i] = Math.max(em[i]!, 90);
        } else px[i] = B[Math.max(0, Math.min(B.length - 1, Math.floor(lit * B.length)))]!;
        if (r < open + 1.5 && act.shut > 0.85) {
          px[i] = S[S.length - 1]!;
          em[i] = Math.max(em[i]!, 200);
        }
      }
    }

    // the shell around it is drawn in: each cell shows the shell a little further out and back along the spin
    const pull = 0.06 + 0.035 * fsin(t * 2.1) + 0.12 * sp.open - 0.03 * sp.close + 0.1 * act.loosen;
    // Loosening: the wound spreads over the shell, out to `reach`; the shell there shows the vortex turning, squeezed in
    const reach = rv * (1 + 0.6 * act.loosen);
    const rimTurn = SPIN * surge * ph0 * FLOW_T;
    for (let k = 0; k < this.ring.length; k++) {
      const i = this.ring[k]!;
      if (this.changed(map, i)) continue;
      const r = this.rr[k]!;
      if (act.loosen > 0 && r < reach - 3 * h2(i, 31)) {
        const a = this.ra[k]! - rimTurn * 1.4;
        const rs = (r / reach) * rv * 0.95;
        const sx = Math.floor(this.cx + fcos(a) * rs);
        const sy = Math.floor(this.cy + fsin(a) * rs);
        const j = sy * W + sx;
        if (sx >= 0 && sy >= 0 && sx < W && sy < H && this.turns[j]) {
          px[i] = this.orig[j]!;
          em[i] = Math.max(em[i]!, 40);
          continue;
        }
      }
      if (act.shut > 0 && Math.abs(r - rv) < 7 * act.shut) {
        // Hold Shut: bone plates locked over the rim, grinding round slowly, seams of light between them
        const seg = (this.ra[k]! + t * 0.25) / 0.42;
        const f = seg - Math.floor(seg);
        const B = this.lad[ids.bone] ?? this.lad[ids.crust]!;
        if (f < 0.08) {
          const S = this.lad[ids.spark] ?? B;
          px[i] = S[S.length - 1]!;
          em[i] = Math.max(em[i]!, 110);
        } else px[i] = B[Math.max(0, B.length - 2 - ((Math.floor(seg) & 1) + (r > rv ? 1 : 0)))]!;
        continue;
      }
      const near = 1 - (r - rv * 0.85) / (rv * 0.75);
      const rs = r * (1 + pull * near);
      const a = this.ra[k]! - 0.12 * near * surge * (0.6 + 0.4 * fsin(t * 3 + r * 0.1));
      const sx = Math.floor(this.cx + fcos(a) * rs);
      const sy = Math.floor(this.cy + fsin(a) * rs);
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const j = sy * W + sx;
      if (!map.material[j] || this.turns[j] || this.changed(map, j)) continue;
      px[i] = this.orig[j]!;
    }

    // stress fractures: arcs of light crackling along the vortex's rim (more when it fights itself)
    const arcs = 2 + Math.round(3 * Math.max(sp.close, sp.open));
    const slot = Math.floor(t * 9);
    for (let n = 0; n < arcs; n++) {
      if (h2(this.seed + n, slot) > 0.55 + 0.4 * (1 - Math.max(sp.close, sp.open))) continue;
      const a0 = (h2(slot, this.seed + n * 7) - 0.5) * Math.PI * 2;
      const len = 0.25 + 0.5 * h2(slot + 3, n);
      const band = rv * (0.95 + 0.1 * h2(n, slot));
      const ra = this.ra;
      const RN = ra.length;
      // the first cell at or after a0 (binary search), then along the arc, wrapping past +π
      let lo = 0;
      let hi = RN;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ra[mid]! < a0) lo = mid + 1;
        else hi = mid;
      }
      for (let s = 0; s < RN; s++) {
        const k = (lo + s) % RN;
        const d = ra[k]! - a0 + (lo + s >= RN ? Math.PI * 2 : 0);
        if (d > len) break;
        if (Math.abs(this.rr[k]! - band) > 1.2) continue;
        const i = this.ring[k]!;
        if (this.changed(map, i)) continue;
        const L = this.lad[ids.spark] ?? this.lad[ids.ichor]!;
        px[i] = L[L.length - 1 - (h2(i, slot) > 0.5 ? 0 : 1)]!;
        em[i] = Math.max(em[i]!, 170);
      }
    }

    // the ichor races down the green veins toward the core; the sparks crackle (everything flares as it tears open)
    for (let k = 0; k < this.veins.length; k++) {
      const i = this.veins[k]!;
      const m = map.material[i]!;
      if ((m !== ids.ichor && m !== ids.spark) || this.changed(map, i)) continue;
      const x = i % W;
      const y = (i - x) / W;
      const r = this.vr[k]!;
      if (m === ids.ichor) {
        const wave = fsin(r * 0.5 + t * 8 * surge) + 0.8 * sp.open;
        if (wave > 0.4) {
          const kk = wave + bay8(x, y) * 0.5 > 1.05 ? 2 : 1;
          px[i] = this.step(map, i, kk);
          em[i] = Math.max(em[i]!, 70 + 60 * kk);
        }
      } else if (h2(i, Math.floor(t * 12)) > 0.82 - 0.5 * sp.open) {
        px[i] = this.step(map, i, 3);
        em[i] = Math.max(em[i]!, 120);
      }
    }
    // Fold: the whole body drains into its own eye, twisting, and unfolds again
    if (act.fold > 0) this.collapse(1 - act.fold, act.twist);
  }

  /** Shrink and twist the drawn skin about the eye (s = 1: as drawn, 0: gone). */
  private collapse(s: number, twist: number): void {
    const { W, H, skin } = this;
    const N = W * H;
    const tmp = (this.tmpPx ??= new Uint32Array(N));
    const tme = (this.tmpEm ??= new Uint8Array(N));
    tmp.set(skin.px);
    tme.set(skin.emis);
    skin.px.fill(0);
    skin.emis.fill(0);
    if (s < 0.04) return;
    const c = fcos(-twist);
    const sn = fsin(-twist);
    const inv = 1 / s;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const dx = (x + 0.5 - this.cx) * inv;
        const dy = (y + 0.5 - this.cy) * inv;
        const sx = Math.floor(this.cx + dx * c - dy * sn);
        const sy = Math.floor(this.cy + dx * sn + dy * c);
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        const j = sy * W + sx;
        const i = y * W + x;
        skin.px[i] = tmp[j]!;
        // the draining body glows as it goes
        skin.emis[i] = Math.max(tme[j]!, tmp[j] ? Math.round(160 * (1 - s)) : 0);
      }
  }

  private drawWreck(body: RenderLayer, map: MatterMap, t: number, sp: { close: number; open: number }): void {
    this.back.begin(body);
    this.front.begin(body);
    const crust = this.lad[this.ids.crust] ?? this.lad[1]!;
    const bone = this.lad[this.ids.bone] ?? crust;
    const glow = this.lad[this.ids.spark] ?? bone;
    const rv = this.rv;
    for (const c of this.chunks) {
      // the fall: the orbit decays into the vortex, faster and faster, then the chunk is consumed and a new one drifts in
      const u = (t / c.fall + c.off) % 1;
      const r = c.a * (1 - 0.78 * DMath.pow(u, 1.7)) + rv * 0.15 * (u * u * u);
      const ang = c.phase + (t / c.period) * Math.PI * 2 + 9 * u * u * u;
      const flat = c.flat * (1 - 0.7 * u);
      const ox = fcos(ang) * r;
      const oy = fsin(ang) * r * flat;
      const x = this.cx + ox * fcos(c.tilt) - oy * fsin(c.tilt);
      const y = this.cy + ox * fsin(c.tilt) + oy * fcos(c.tilt);
      const near = fsin(ang) > 0 || u > 0.7;
      const layer = near ? this.front : this.back;
      if (u > 0.94) {
        // consumed: a flash and a few shards torn along the spin
        for (let s = 0; s < 6; s++) {
          const sa = ang - s * 0.18;
          layer.putPal(
            Math.floor(this.cx + fcos(sa) * r * (1 - s * 0.05)),
            Math.floor(this.cy + fsin(sa) * r * flat * (1 - s * 0.05)),
            glow,
            glow.length - 1 - (s >> 1),
            200 - s * 25,
          );
        }
        continue;
      }
      const L = c.shade > 0.4 ? bone : crust;
      if (!L || !L.length) continue;
      // a lumpy rock, lit from the upper left, with a dark rim, stretched along its fall as it nears the eye
      const size = c.size * (1 - 0.45 * u);
      const R = size / 2;
      const S = Math.ceil(size);
      for (let dy = -S; dy <= S; dy++)
        for (let dx = -S; dx <= S; dx++) {
          const lump = R + 0.9 * (h2(c.mask + dx, dy) - 0.5);
          const d2 = dx * dx + dy * dy;
          if (d2 > lump * lump) continue;
          const mx = Math.floor(x) + dx;
          const my = Math.floor(y) + dy;
          if (!near && mx >= 0 && my >= 0 && mx < this.W && my < this.H && map.material[my * this.W + mx])
            continue;
          const rim = d2 > (lump - 1) * (lump - 1);
          const lit = rim
            ? 0.05
            : 0.45 + (near ? 0.15 : -0.1) + (-dx - dy) * (0.25 / Math.max(1, R)) + bay8(mx, my) * 0.12;
          layer.putPal(mx, my, L, Math.max(0, Math.min(L.length - 1, Math.floor(lit * (L.length - 1)))));
        }
    }

    // dust streaming over the shell into the eye along the spin (a streak of 3 cells, brightest at its head)
    for (let k = 0; k < MOTES; k++) {
      const life = 1.6 + 1.4 * h2(this.seed + k, 1);
      const u = (t / life + h2(this.seed + k, 2)) % 1;
      const r = rv * (1.75 - 1.6 * u * u) * (1 - 0.25 * sp.open * u);
      const base = h2(this.seed + k, 3) * Math.PI * 2;
      for (let s = 0; s < 3; s++) {
        const uu = Math.max(0, u - s * 0.02);
        const rr = rv * (1.75 - 1.6 * uu * uu);
        const a = base + 4.5 * uu * uu + t * SPIN * 0.3;
        const mx = Math.floor(this.cx + fcos(a) * (s ? rr : r));
        const my = Math.floor(this.cy + fsin(a) * (s ? rr : r));
        const L = s === 0 ? bone : crust;
        this.front.putPal(mx, my, L, Math.max(0, L.length - 1 - s * 2), s === 0 ? 60 : 0);
      }
    }
    this.back.end();
    this.front.end();
  }

  reset(): void {
    this.lastTick = -1;
    this.bodyTick = -99;
    this.jx = 0;
    this.jy = 0;
    this.back.clear();
    this.front.clear();
  }
}
