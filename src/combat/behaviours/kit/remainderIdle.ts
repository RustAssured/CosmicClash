import { pb, pg, pr, type MatterMap, type RenderLayer } from '@/contracts';
import { DMath } from '@/contracts/dmath';
import { BodySkin, BodySpaceLayer, bay8, fcos, fsin, h2 } from '../../fx/idle';

/**
 * THE REMAINDER'S LIVING IDLE (presentation only: the sim never reads it; the one clock is the sim tick, so replays and both
 * netplay peers see the same idle). Four motions on its imported body (src/titans/kit/remainder/):
 *
 *  - the vortex TURNS: the vortex, ichor, spark and core cells within the spiral's radius take the painted colour from
 *    where the spiral was (a slow rotation about the core, the inner turns leading a little), so the arms wheel inward;
 *  - the ichor FLOWS: light runs down the green veins toward the core in slow waves (each cell steps up its own ladder);
 *  - the eye BREATHES: the black centre widens and narrows, and flinches tight when it is hit (the fear);
 *  - wreckage ORBITS: captured chunks circle the body on tilted orbits, passing behind it and in front of it.
 *
 * Cells a fight has changed (damage, heat, char, infection) are left exactly as the matter world shows them.
 */

const FIGHT_FLAGS = 1 | 2 | 4 | 8 | 64;
/** One turn of the vortex, seconds. */
const TURN = 14;
/** Wreckage chunks in orbit. */
const CHUNKS = 9;

export interface RemainderIdleInput {
  /** Sim tick of the frame. */
  tick: number;
  /** Ticks since it was last hit. */
  sinceHit: number;
  ko: boolean;
}

interface Chunk {
  /** Orbit radius (cells), its flattening, tilt (rad), period (s), phase (rad), size (cells), colour ladder offset. */
  a: number;
  flat: number;
  tilt: number;
  period: number;
  phase: number;
  size: number;
  shade: number;
  /** Seed of its lumpy outline. */
  mask: number;
}

export class RemainderIdle {
  private readonly W: number;
  private readonly H: number;
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
  private lastTick = -1;

  constructor(map: MatterMap, materialKeys: readonly string[], seed: number) {
    const W = (this.W = map.w);
    const H = (this.H = map.h);
    const N = W * H;
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
    this.turns = new Uint8Array(N);
    const turning = [this.ids.vortex, this.ids.ichor, this.ids.spark, this.ids.core].filter((m) => m > 0);
    const vr: number[] = [];
    for (let i = 0; i < N; i++) {
      const m = map.material[i]!;
      if (!turning.includes(m)) continue;
      this.turns[i] = 1;
      if (m === this.ids.vortex)
        vr.push(DMath.hypot((i % W) + 0.5 - this.cx, Math.floor(i / W) + 0.5 - this.cy));
    }
    vr.sort((a, b) => a - b);
    this.rv = vr.length ? vr[Math.floor(vr.length * 0.85)]! : this.coreR * 4;
    const cells: number[] = [];
    for (let i = 0; i < N; i++) {
      if (!this.turns[i]) continue;
      const r = DMath.hypot((i % W) + 0.5 - this.cx, Math.floor(i / W) + 0.5 - this.cy);
      if (r <= this.rv) cells.push(i);
    }
    this.swirl = Int32Array.from(cells);
    this.sr = new Float32Array(cells.length);
    this.sa = new Float32Array(cells.length);
    cells.forEach((i, k) => {
      const dx = (i % W) + 0.5 - this.cx;
      const dy = Math.floor(i / W) + 0.5 - this.cy;
      this.sr[k] = DMath.hypot(dx, dy);
      this.sa[k] = DMath.atan2(dy, dx);
    });

    const vc: number[] = [];
    for (let i = 0; i < N; i++)
      if (map.material[i] === this.ids.ichor || map.material[i] === this.ids.spark) vc.push(i);
    this.veins = Int32Array.from(vc);
    this.vr = Float32Array.from(vc, (i) =>
      DMath.hypot((i % W) + 0.5 - this.cx, Math.floor(i / W) + 0.5 - this.cy),
    );

    // the wreckage: chunks on tilted orbits around the body (their colours are the bone and crust ladders: pale, lit rock)
    for (let k = 0; k < CHUNKS; k++) {
      const u = (n: number): number => h2(seed + k * 31, n);
      this.chunks.push({
        a: big * (0.36 + 0.18 * u(1)),
        flat: 0.25 + 0.18 * u(2),
        tilt: (u(3) - 0.5) * 1.1,
        period: 9 + 9 * u(4),
        phase: u(5) * Math.PI * 2,
        size: 5 + Math.floor(u(6) * 6),
        shade: u(7),
        mask: Math.floor(u(8) * 0x1ffffff),
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

  /** Draw the frame: the body's skin (presented in place of the body layer) and the wreckage layers. */
  render(body: RenderLayer, map: MatterMap, inp: RemainderIdleInput, out: RenderLayer[]): void {
    if (inp.ko) {
      this.back.clear();
      this.front.clear();
      return;
    }
    const redraw = inp.tick !== this.lastTick;
    this.lastTick = inp.tick;
    const t = inp.tick / 60;
    if (redraw) this.drawBody(map, t, inp.sinceHit);
    this.skin.present(body, redraw);
    if (redraw) this.drawWreck(body, map, t);
    else {
      this.back.follow(body);
      this.front.follow(body);
    }
    out.push(this.back.layer, this.front.layer);
  }

  private drawBody(map: MatterMap, t: number, sinceHit: number): void {
    const { W, skin, ids } = this;
    skin.copyFrom(map.pixels, map.emissive);
    const px = skin.px;
    const em = skin.emis;
    const turn = (t / TURN) * Math.PI * 2;
    // the fear: a hit snaps the eye tight, then it eases open again over a second
    const flinch = sinceHit < 60 ? 1 - sinceHit / 60 : 0;
    const pupil = this.coreR * (0.55 + 0.18 * fsin(t * 1.3) - 0.35 * flinch);

    // the vortex turns (the inner turns lead a little and breathe, so the arms seem to wheel inward)
    const rv = this.rv;
    for (let k = 0; k < this.swirl.length; k++) {
      const i = this.swirl[k]!;
      if (this.changed(map, i)) continue;
      const r = this.sr[k]!;
      const lead = 1 - r / rv;
      const a = this.sa[k]! - turn - lead * (0.6 + 0.25 * fsin(t * 0.4));
      const sx = Math.floor(this.cx + fcos(a) * r);
      const sy = Math.floor(this.cy + fsin(a) * r);
      if (sx < 0 || sy < 0 || sx >= W || sy >= this.H) continue;
      const j = sy * W + sx;
      if (!this.turns[j] || this.changed(map, j)) continue;
      // the eye keeps its own place (it breathes below); everything else takes the colour that turned onto it
      if (map.material[i] === ids.core || map.material[j] === ids.core) continue;
      px[i] = this.orig[j]!;
    }

    for (let k = 0; k < this.swirl.length; k++) {
      const i = this.swirl[k]!;
      if (this.changed(map, i)) continue;
      const m = map.material[i]!;
      const r = this.sr[k]!;
      if (m === ids.core) {
        // the eye: darker inside the pupil, a faint rim of light at its edge (brighter when it flinches)
        if (r < pupil) px[i] = this.step(map, i, -3);
        else if (r < pupil + 1.6) {
          px[i] = this.step(map, i, 1 + Math.round(flinch * 2));
          em[i] = Math.max(em[i]!, 40 + 120 * flinch);
        }
      }
    }

    // the ichor flows: waves of light running down the green veins toward the core
    for (let k = 0; k < this.veins.length; k++) {
      const i = this.veins[k]!;
      const m = map.material[i]!;
      if ((m !== ids.ichor && m !== ids.spark) || this.changed(map, i)) continue;
      const x = i % W;
      const y = (i - x) / W;
      const r = this.vr[k]!;
      if (m === ids.ichor) {
        const wave = fsin(r * 0.42 + t * 3.2);
        if (wave > 0.55) {
          const kk = wave + bay8(x, y) * 0.5 > 1.15 ? 2 : 1;
          px[i] = this.step(map, i, kk);
          em[i] = Math.max(em[i]!, 60 + 50 * kk);
        }
      } else if (h2(i, Math.floor(t * 5)) > 0.9) {
        px[i] = this.step(map, i, 2);
        em[i] = Math.max(em[i]!, 90);
      }
    }
  }

  private drawWreck(body: RenderLayer, map: MatterMap, t: number): void {
    this.back.begin(body);
    this.front.begin(body);
    const crust = this.lad[this.ids.crust] ?? this.lad[1]!;
    const bone = this.lad[this.ids.bone] ?? crust;
    for (const c of this.chunks) {
      const ang = c.phase + (t / c.period) * Math.PI * 2;
      // a tilted ellipse: x along the tilt, depth (sin) flattened into y; in front while sin > 0
      const ox = fcos(ang) * c.a;
      const oy = fsin(ang) * c.a * c.flat;
      const x = this.cx + ox * fcos(c.tilt) - oy * fsin(c.tilt);
      const y = this.cy + ox * fsin(c.tilt) + oy * fcos(c.tilt);
      const L = c.shade > 0.4 ? bone : crust;
      if (!L || !L.length) continue;
      const near = fsin(ang) > 0;
      const layer = near ? this.front : this.back;
      // a lumpy rock, lit from the upper left, with a dark rim; behind the body only where the body does not cover it
      const R = c.size / 2;
      for (let dy = -c.size; dy <= c.size; dy++)
        for (let dx = -c.size; dx <= c.size; dx++) {
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
    this.back.end();
    this.front.end();
  }

  reset(): void {
    this.lastTick = -1;
    this.back.clear();
    this.front.clear();
  }
}
