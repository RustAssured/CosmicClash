import {
  MOVE_SLOTS,
  pb,
  pg,
  pr,
  type AimDir,
  type MatterMap,
  type MoveSlot,
  type RenderLayer,
} from '@/contracts';
import type { MotionPreset, TitanDef } from '@/contracts';
import { DMath } from '@/contracts/dmath';
import { BodySkin, BodySpaceLayer, fcos, fsin, h2, ss, vnoise } from '../../fx/idle';

/**
 * ANIMATION PRESETS for kit titans (`kit.motion` in a titan's JSON, edited with sliders in the titan builder): reusable pieces
 * of a living idle and of move animation, generalised from the Remainder's hand-built ones. Each runs on the cells of one
 * material (its region):
 *
 *  - swirl:   the region turns like a vortex and drains toward its centre (a flow map: two copies of the motion half a cycle
 *             apart, cross-faded per cell, so it can turn forever without winding into rings);
 *  - pulse:   the region brightens and dims (a step or more along its own colour ramp) and glows, optionally as a wave
 *             running outward from its centre;
 *  - shimmer: scattered cells of the region flare to the top of its ramp and fade (sparkle, embers, stars);
 *  - stretch: during a move (Strike by default) the region is warped out toward the aim like a rubber sheet, its own pixels
 *             stretched to a point, and snaps back (the Remainder's Snap);
 *  - iris:    while guarding (or during a move) petals in another material close over the region from its rim inward.
 *
 * PRESENTATION ONLY (S19): the sim never reads any of it and the clock is the fighter's tick, so replays and netplay peers see
 * the same frames. Cells a fight has changed (damage, heat, char, infection) are left as the matter world shows them.
 * A titan with a hand-written idle (its behaviour overrides `renderLayers`) does not run its presets.
 */

export const MOTION_TYPES = ['swirl', 'pulse', 'shimmer', 'stretch', 'iris'] as const;
export type MotionType = (typeof MOTION_TYPES)[number];

/** A preset's numeric knob: the builder makes a slider from it, the runtime reads the default when it is missing. */
export interface MotionKnob {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
  hint: string;
}

export const MOTION_KNOBS: Readonly<Record<MotionType, readonly MotionKnob[]>> = {
  swirl: [
    {
      key: 'speed',
      label: 'speed',
      min: 0,
      max: 8,
      step: 0.1,
      def: 2.4,
      hint: 'turns per second at the rim (rad/s)',
    },
    {
      key: 'inflow',
      label: 'inflow',
      min: 0,
      max: 1,
      step: 0.05,
      def: 0.5,
      hint: 'how hard colour drains to the centre',
    },
    {
      key: 'turbulence',
      label: 'turbulence',
      min: 0,
      max: 1,
      step: 0.05,
      def: 0.4,
      hint: 'shiver in the turn',
    },
    {
      key: 'direction',
      label: 'direction',
      min: -1,
      max: 1,
      step: 2,
      def: 1,
      hint: '1 clockwise, −1 the other way',
    },
  ],
  pulse: [
    { key: 'rate', label: 'rate', min: 0.05, max: 4, step: 0.05, def: 0.6, hint: 'beats per second' },
    { key: 'depth', label: 'depth', min: 0, max: 4, step: 1, def: 1, hint: 'steps along its colour ramp' },
    { key: 'glow', label: 'glow', min: 0, max: 220, step: 5, def: 60, hint: 'emissive at the peak' },
    {
      key: 'wave',
      label: 'wave',
      min: 0,
      max: 1,
      step: 0.05,
      def: 0,
      hint: '0 all at once, 1 a ring running outward',
    },
  ],
  shimmer: [
    {
      key: 'density',
      label: 'density',
      min: 0,
      max: 0.2,
      step: 0.005,
      def: 0.03,
      hint: 'share of cells lit at once',
    },
    { key: 'rate', label: 'rate', min: 0.2, max: 12, step: 0.1, def: 3, hint: 'flickers per second' },
    { key: 'glow', label: 'glow', min: 0, max: 255, step: 5, def: 120, hint: 'emissive of a lit cell' },
  ],
  stretch: [
    {
      key: 'reach',
      label: 'reach',
      min: 30,
      max: 220,
      step: 2,
      def: 150,
      hint: 'how far the tip goes from the centre (px)',
    },
    {
      key: 'ripple',
      label: 'ripple',
      min: 0,
      max: 1,
      step: 0.05,
      def: 0.5,
      hint: 'waves running along the stretch',
    },
  ],
  iris: [
    {
      key: 'petals',
      label: 'petals',
      min: 3,
      max: 12,
      step: 1,
      def: 7,
      hint: 'how many plates close over it',
    },
    {
      key: 'speed',
      label: 'speed',
      min: 0.05,
      max: 1,
      step: 0.05,
      def: 0.3,
      hint: 'how fast it shuts (per tick)',
    },
  ],
};

/** When a preset runs: always, or during a move slot ('guard' = while the guard is up). Stretch defaults to Strike, iris to Guard. */
export const MOTION_TRIGGERS = ['always', ...MOVE_SLOTS] as const;

export const motionKnob = (p: MotionPreset, key: string): number => {
  const v = p[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return MOTION_KNOBS[p.type as MotionType]?.find((k) => k.key === key)?.def ?? 0;
};

const triggerOf = (p: MotionPreset): string =>
  p.on ?? (p.type === 'stretch' ? 'strike' : p.type === 'iris' ? 'guard' : 'always');

/** What is wrong with a titan's presets (empty = fine): the builder shows these, the roster test fails on them. */
export function motionProblems(def: TitanDef): string[] {
  const out: string[] = [];
  const keys = def.materials.map((m) => m.key);
  (def.kit?.motion ?? []).forEach((p, i) => {
    const at = `kit.motion[${i}]`;
    if (!(MOTION_TYPES as readonly string[]).includes(p.type)) out.push(`${at}: unknown type '${p.type}'`);
    if (!keys.includes(p.material)) out.push(`${at}: no material '${p.material}'`);
    if (p.on !== undefined && !(MOTION_TRIGGERS as readonly string[]).includes(p.on))
      out.push(`${at}: unknown trigger '${p.on}'`);
    if (p.type === 'iris' && p.cover !== undefined && !keys.includes(String(p.cover)))
      out.push(`${at}: no cover material '${String(p.cover)}'`);
  });
  return out;
}

/** What the presets need to know about the fighter this frame (read from the fighter by `KitBehaviour`). */
export interface MotionInput {
  tick: number;
  /** The move under way (null = none) and where it is. */
  slot: MoveSlot | null;
  phase: string;
  phaseTick: number;
  startup: number;
  active: number;
  recovery: number;
  aim: AimDir;
  guarding: boolean;
}

/** Where a Strike's tip goes per aim, in the body's own (facing-right) space: a unit direction. */
const AIM_DIR: Record<AimDir, [number, number]> = {
  up: [0.871, -0.491],
  forward: [0.999, -0.024],
  down: [0.89, 0.456],
};

/** A preset bound to its region: the cells, their polar coordinates round the region's centre, its radius. */
interface Region {
  p: MotionPreset;
  type: MotionType;
  mat: number;
  cells: Int32Array;
  r: Float32Array;
  a: Float32Array;
  cx: number;
  cy: number;
  R: number;
  /** Swirl: per cell, whether it is in the region (a source outside it shows the region's darkest colour). */
  mask: Uint8Array;
  /** Iris: how shut it is (0..1), eased per drawn tick. */
  amt: number;
}

const FIGHT_FLAGS = 1 | 2 | 4 | 8 | 64;
/** A patch smaller than this (cells) is a fleck, not a part: it is left still (unless it is the material's only patch). */
const MIN_PIECE = 12;

/** Of the patches at least a third the size of the largest, the one whose middle is furthest forward (+x: facing right). */
function frontmost(pieces: number[][], W: number): number[] {
  const big = pieces.filter((c) => c.length * 3 >= pieces[0]!.length);
  const midX = (c: number[]): number => c.reduce((s, i) => s + (i % W), 0) / c.length;
  return big.reduce((best, c) => (midX(c) > midX(best) ? c : best), big[0]!);
}

/**
 * The separate patches of one material, largest first. Cells up to two apart count as touching, so a vortex threaded with
 * veins of another material stays one patch while two eyes on two wings are two.
 */
function piecesOf(map: MatterMap, mat: number): number[][] {
  const { w: W, h: H } = map;
  const seen = new Uint8Array(W * H);
  const out: number[][] = [];
  const stack: number[] = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || map.material[s] !== mat) continue;
    const cells: number[] = [];
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      const x = i % W;
      const y = (i - x) / W;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (!seen[j] && map.material[j] === mat) {
            seen[j] = 1;
            stack.push(j);
          }
        }
    }
    cells.sort((p, q) => p - q);
    out.push(cells);
  }
  return out.sort((p, q) => q.length - p.length || p[0]! - q[0]!);
}
const FLOW_T = 0.6;

export class KitMotion {
  private readonly W: number;
  private readonly H: number;
  readonly skin: BodySkin;
  private readonly front: BodySpaceLayer;
  private readonly orig: Uint32Array;
  private readonly regions: Region[] = [];
  /** Per material id: its painted colours dark → light; per cell its rank on that ladder. */
  private readonly lad: Uint32Array[] = [];
  private readonly rank: Int16Array;
  private readonly keys: readonly string[];
  private readonly shiver = new Float32Array(512);
  private lastTick = -1;

  constructor(map: MatterMap, def: TitanDef) {
    const W = (this.W = map.w);
    const H = (this.H = map.h);
    const N = W * H;
    this.keys = def.materials.map((m) => m.key);
    this.orig = map.baseColor.slice();
    this.skin = new BodySkin(W, H);
    const big = Math.max(W, H);
    this.front = new BodySpaceLayer('kit-motion', 2, big * 2 + 64, big * 2 + 64, map.coreX, map.coreY);

    const lum = (c: number): number => 0.3 * pr(c) + 0.59 * pg(c) + 0.11 * pb(c);
    const maxM = this.keys.length + 1;
    const sets: Set<number>[] = Array.from({ length: maxM }, () => new Set());
    for (let i = 0; i < N; i++) if (map.material[i]) sets[map.material[i]!]?.add(this.orig[i]! >>> 0);
    for (let m = 0; m < maxM; m++)
      this.lad[m] = Uint32Array.from([...sets[m]!].sort((a, b) => lum(a) - lum(b)));
    const where = this.lad.map((L) => new Map([...L].map((c, k) => [c, k])));
    this.rank = new Int16Array(N).fill(-1);
    for (let i = 0; i < N; i++)
      if (map.material[i]) this.rank[i] = where[map.material[i]!]!.get(this.orig[i]! >>> 0) ?? -1;

    const pieces = new Map<number, number[][]>();
    for (const p of def.kit?.motion ?? []) {
      const mat = this.keys.indexOf(p.material) + 1;
      if (!mat || !(MOTION_TYPES as readonly string[]).includes(p.type)) continue;
      if (!pieces.has(mat)) pieces.set(mat, piecesOf(map, mat));
      const all = pieces.get(mat)!;
      if (!all.length) continue;
      // each patch of the material moves round its own centre (a titan's two eyes swirl apart); a stretch pulls the
      // patch nearest the front (of those at least a third the size of the largest)
      const use =
        p.type === 'stretch' ? [frontmost(all, W)] : all.filter((c, k) => k === 0 || c.length >= MIN_PIECE);
      const mask = new Uint8Array(N);
      for (const c of use) for (const i of c) mask[i] = 1;
      for (const cells of use) {
        let sx = 0;
        let sy = 0;
        let hasCore = false;
        for (const i of cells) {
          sx += i % W;
          sy += Math.floor(i / W);
          if (i % W === map.coreX && Math.floor(i / W) === map.coreY) hasCore = true;
        }
        // the centre: the body's core when the patch holds it (an eye, a vortex), else the patch's own middle
        const cx = hasCore ? map.coreX + 0.5 : sx / cells.length + 0.5;
        const cy = hasCore ? map.coreY + 0.5 : sy / cells.length + 0.5;
        const r = Float32Array.from(cells, (i) =>
          DMath.hypot((i % W) + 0.5 - cx, Math.floor(i / W) + 0.5 - cy),
        );
        const a = Float32Array.from(cells, (i) =>
          DMath.atan2(Math.floor(i / W) + 0.5 - cy, (i % W) + 0.5 - cx),
        );
        const sorted = Float32Array.from(r).sort();
        this.regions.push({
          p,
          type: p.type as MotionType,
          mat,
          cells: Int32Array.from(cells),
          r,
          a,
          cx,
          cy,
          R: Math.max(2, sorted[Math.floor(sorted.length * 0.85)]!),
          mask,
          amt: 0,
        });
      }
    }
  }

  /** Whether any preset bound to a region (a titan whose presets all name missing materials draws nothing). */
  get active(): boolean {
    return this.regions.length > 0;
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

  /** 0..1: how strongly a trigger holds this frame (a move eases in over its startup and out over its recovery). */
  private triggered(p: MotionPreset, inp: MotionInput): number {
    const on = triggerOf(p);
    if (on === 'always') return 1;
    if (on === 'guard') return inp.guarding ? 1 : 0;
    if (inp.slot !== on) return 0;
    if (inp.phase === 'startup') return ss(0, 1, inp.phaseTick / Math.max(1, inp.startup));
    if (inp.phase === 'active') return 1;
    if (inp.phase === 'recovery') return 1 - ss(0, 1, inp.phaseTick / Math.max(1, inp.recovery));
    return 0;
  }

  /** Draw the frame: the presented skin in place of the body layer, and the stretch layer in front of it. */
  render(body: RenderLayer, map: MatterMap, inp: MotionInput, out: RenderLayer[]): void {
    const redraw = inp.tick !== this.lastTick;
    const t = inp.tick / 60;
    if (redraw) {
      this.skin.copyFrom(map.pixels, map.emissive);
      for (const g of this.regions) {
        const k = this.triggered(g.p, inp);
        if (g.type === 'iris') {
          const sp = motionKnob(g.p, 'speed');
          g.amt = k > 0.5 ? Math.min(1, g.amt + sp) : Math.max(0, g.amt - sp * 0.5);
          if (g.amt > 0) this.iris(g, map, t);
        } else if (g.type !== 'stretch' && k > 0) {
          if (g.type === 'swirl') this.swirl(g, map, t, k);
          else if (g.type === 'pulse') this.pulse(g, map, t, k);
          else this.shimmer(g, map, t, k, inp.tick);
        }
      }
      this.lastTick = inp.tick;
    }
    this.skin.present(body, redraw);
    this.front.begin(body);
    for (const g of this.regions) if (g.type === 'stretch') this.stretch(g, map, inp);
    this.front.end();
    out.push(this.front.layer);
  }

  private swirl(g: Region, map: MatterMap, t: number, k: number): void {
    const { W, H } = this;
    const px = this.skin.px;
    const speed = motionKnob(g.p, 'speed') * k * (motionKnob(g.p, 'direction') < 0 ? -1 : 1);
    const inflow = motionKnob(g.p, 'inflow') * 0.7;
    const turb = motionKnob(g.p, 'turbulence');
    const ph0 = (t / FLOW_T) % 1;
    const ph1 = (ph0 + 0.5) % 1;
    const w0 = 1 - Math.abs(2 * ph0 - 1);
    const grow0 = DMath.exp(inflow * ph0 * FLOW_T);
    const grow1 = DMath.exp(inflow * ph1 * FLOW_T);
    const nR = Math.min(this.shiver.length, Math.ceil(g.R) + 2);
    for (let q = 0; q < nR; q++) this.shiver[q] = vnoise(q * 0.22, t * 6) - 0.5;
    const dark = this.lad[g.mat]![0] ?? 0;
    for (let c = 0; c < g.cells.length; c++) {
      const i = g.cells[c]!;
      if (this.changed(map, i)) continue;
      const r = g.r[c]!;
      const inner = Math.max(0, 1 - r / g.R);
      const omega = speed * (1 + 3 * inner * inner);
      const use0 = h2(i, 977) < w0;
      const ph = use0 ? ph0 : ph1;
      const a =
        g.a[c]! - omega * ph * FLOW_T + turb * this.shiver[Math.min(nR - 1, r | 0)]! * (0.3 + 0.6 * inner);
      const rs = Math.min(g.R * 0.97, r * (use0 ? grow0 : grow1));
      const sx = Math.floor(g.cx + fcos(a) * rs);
      const sy = Math.floor(g.cy + fsin(a) * rs);
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const j = sy * W + sx;
      px[i] = g.mask[j] && !this.changed(map, j) ? this.orig[j]! : dark;
    }
  }

  private pulse(g: Region, map: MatterMap, t: number, k: number): void {
    const px = this.skin.px;
    const em = this.skin.emis;
    const rate = motionKnob(g.p, 'rate');
    const depth = motionKnob(g.p, 'depth');
    const glow = motionKnob(g.p, 'glow');
    const wave = motionKnob(g.p, 'wave');
    for (let c = 0; c < g.cells.length; c++) {
      const i = g.cells[c]!;
      if (this.changed(map, i)) continue;
      const v = 0.5 + 0.5 * fsin(Math.PI * 2 * (rate * t - wave * (g.r[c]! / g.R)));
      const s = Math.round(depth * k * (v - 0.35));
      if (s) px[i] = this.step(map, i, s);
      if (glow > 0) em[i] = Math.max(em[i]!, Math.round(glow * k * v * v));
    }
  }

  private shimmer(g: Region, map: MatterMap, t: number, k: number, tick: number): void {
    const px = this.skin.px;
    const em = this.skin.emis;
    const density = motionKnob(g.p, 'density') * k;
    const rate = motionKnob(g.p, 'rate');
    const glow = motionKnob(g.p, 'glow');
    const L = this.lad[g.mat]!;
    if (!L.length) return;
    const top = L[L.length - 1]!;
    for (let c = 0; c < g.cells.length; c++) {
      const i = g.cells[c]!;
      // each cell keeps its own beat: it is lit for a moment of every cycle whose roll comes under the density
      const u = t * rate + h2(i, 31);
      const cyc = Math.floor(u);
      if (h2(i, cyc) >= density) continue;
      if (this.changed(map, i)) continue;
      const f = 1 - (u - cyc);
      px[i] = f > 0.5 ? top : this.step(map, i, 1);
      em[i] = Math.max(em[i]!, Math.round(glow * f));
    }
    void tick;
  }

  private iris(g: Region, map: MatterMap, t: number): void {
    const px = this.skin.px;
    const em = this.skin.emis;
    const coverKey = typeof g.p.cover === 'string' ? g.p.cover : '';
    const cm = this.keys.indexOf(coverKey) + 1;
    const B = (cm && this.lad[cm]!.length ? this.lad[cm]! : null) ?? this.lad[g.mat]!;
    if (!B.length) return;
    const petals = Math.max(3, Math.round(motionKnob(g.p, 'petals')));
    const open = g.R * (1 - 0.97 * g.amt);
    const turn = t * 0.2;
    for (let c = 0; c < g.cells.length; c++) {
      const i = g.cells[c]!;
      const r = g.r[c]!;
      if (r < open || this.changed(map, i)) continue;
      const a = g.a[c]!;
      // the seams curve inward like an aperture's blades
      const pet = ((a + turn) / (Math.PI * 2)) * petals + (r / g.R) * 0.9;
      const f = pet - Math.floor(pet);
      const lit = 0.55 - 0.3 * fsin(a + 0.8) - 0.25 * (1 - r / g.R);
      px[i] = f < 0.07 ? B[0]! : B[Math.max(0, Math.min(B.length - 1, Math.floor(lit * B.length)))]!;
      if (r < open + 1.5 && g.amt > 0.85) em[i] = Math.max(em[i]!, 90);
    }
  }

  /**
   * The region pulled out toward the aim like rubber: the front of it is stretched so its rim leaves the circle on the two
   * tangents to the tip and pinches there, every pixel the skin's own (whatever else animates the region shows in it too).
   */
  private stretch(g: Region, map: MatterMap, inp: MotionInput): void {
    const on = triggerOf(g.p);
    if (inp.slot !== on) return;
    const S = Math.max(1, inp.startup);
    const A = Math.max(1, inp.active);
    const Rc = Math.max(1, inp.recovery);
    let ext = 0;
    if (inp.phase === 'startup') {
      const p = inp.phaseTick / S;
      ext = 0.12 * p * p;
    } else if (inp.phase === 'active') {
      const p = (inp.phaseTick + 1) / A;
      ext = Math.min(1.1, 1.1 * (1 - (1 - p) * (1 - p)));
    } else if (inp.phase === 'recovery') {
      const q = inp.phaseTick / Rc / 0.22;
      ext = q < 1 ? 1.1 * (1 - q * q) : 0;
    }
    const R = g.R;
    const L = Math.max(R * 1.1, motionKnob(g.p, 'reach'));
    const d = R + (L - R) * ext;
    if (d <= R * 1.04) return;
    const [dX, dY] = AIM_DIR[inp.aim];
    const nX = -dY;
    const nY = dX;
    const ca = R / d;
    const sa = Math.sqrt(1 - ca * ca);
    const bx = R * ca;
    const hw0 = R * sa;
    const a0 = R * 0.3;
    const { cx, cy } = g;
    const x0 = Math.floor(Math.min(cx - R, cx + dX * d)) - 1;
    const x1 = Math.ceil(Math.max(cx + R, cx + dX * d)) + 1;
    const y0 = Math.floor(Math.min(cy - R, cy + dY * d)) - 1;
    const y1 = Math.ceil(Math.max(cy + R, cy + dY * d)) + 1;
    const wave = inp.tick * (inp.phase === 'recovery' ? -0.9 : 0.6);
    const ripple = motionKnob(g.p, 'ripple') * 0.06;
    const Rs = R * (1 - 0.1 * Math.min(1, ext * 4));
    const R2 = R * R;
    const { px: SP, emis: SE } = this.skin;
    const W = map.w;
    const dark = this.lad[g.mat]![0] ?? 0xff000000;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - cx;
        const py = y + 0.5 - cy;
        const along = px * dX + py * dY;
        if (along < a0 || along > d) continue;
        const lat = px * nX + py * nY;
        const disc = along < R ? Math.sqrt(R2 - along * along) : 0;
        const s2 = along > bx ? (along - bx) / (d - bx) : 0;
        const band = along > bx ? hw0 * DMath.pow(1 - s2, 1.35) + 1.1 * s2 : 0;
        const Hh = Math.max(disc, band);
        if (Hh <= 0) continue;
        const u = lat / Hh;
        if (u < -1 || u > 1) continue;
        const gg = (along - a0) / (d - a0);
        const k = 1 - DMath.pow(1 - gg, 1.6);
        const rip = ripple * (1 - Math.abs(u)) * fsin(gg * 14 - wave) * ext;
        const sa0 = Math.min(Rs - 0.6, a0 + (Rs - a0) * (k + rip));
        const sl = u * Math.sqrt(Math.max(0, Rs * Rs - sa0 * sa0));
        const sx = Math.floor(cx + dX * sa0 + nX * sl);
        const sy = Math.floor(cy + dY * sa0 + nY * sl);
        const j = sy * W + sx;
        if (sx < 0 || sy < 0 || sx >= W || sy >= this.H || !map.material[j]) {
          if (along > R) this.front.put(x, y, dark | 0xff000000, 0);
          continue;
        }
        this.front.put(x, y, SP[j]! | 0xff000000, SE[j]!);
      }
  }
}
