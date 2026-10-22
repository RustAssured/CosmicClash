import {
  Rng,
  clamp01,
  createMatterMap,
  smoothstep,
  type MatterMap,
  type StageLighting,
  type TitanDef,
} from '@/contracts';
import { ArtCanvas, buildLitRamps, type ShadeParams } from '../../art/canvas';
import { edt, keepLargestComponent } from '../../art/field';
import { bayer8, fbm, hash01, makeWorley, ridged, worley } from '../../art/noise';
import { sdPolygon, sdTaperedCapsule } from '../../art/sdf';
import { DMath, sq } from '@/contracts/dmath';

/**
 * CRADLE CHILD / 요람의 아이: its own painter (WJ's brief docs/titans/cradlechild/BRIEF.md, refined by his paint-over of
 * 2026-10-15: docs/titans/cradlechild/paintover-gate1.webp).
 *
 * First glance: a sacred icon, pale, centred, elegant. Second glance: biologically wrong and not finished being born. From
 * the top: a containment apparatus of bone rings (one broken and hooked), a cross spire and knobbed nodes, webbed and
 * dripping; a sealed mitre-like hood (no face); under it an OPEN CAVITY holding the great galaxy-organ, a pearl spiral round
 * a stellar-gold core; two gestational membrane lobes stretched on knobbed bone struts, laced with holes at their edges,
 * each with a spiral galaxy in its lilac window and raw red vessels fanning from the root; a vertical pearl torso with red
 * vessels running down it and almond galaxy-pods in it, a healed cord scar low on the belly; below, unfinished incarnation:
 * two heavy scaffold limbs, a column that ends in a hanging chain of galaxy-pods and bone beads, laced webs between them,
 * drips with bead tips everywhere.
 *
 * Every look number is in the JSON's `art.params` (ChildParams); the palette is the JSON materials' ramps. Materials, by key:
 * tissue, flesh, vein, bone, membrane, galaxy, star, core. One body for now (Gate 2 may cut lobes and chains into rig
 * regions, as the Cradle's disc and cord are). Pure and deterministic in (def, seed, lighting). x offsets (`dx`) are from
 * the body's axis `cx`; the left side mirrors the right.
 */
export interface ChildParams {
  cx: number;
  /** The torso's half-width profile (hood included): [y, half-width] pairs, top to bottom (px). */
  profile: [number, number][];
  /** The sealed hood: apex y, base y (its brow overhangs the cavity), bone ribs down it. */
  hood: { top: number; base: number; ribs: number };
  /**
   * The crown apparatus: rings round (cx, cy + dy) behind the body; a ring may be broken by `gap` (radians, screen angles)
   * and ends there in a hook; knobs at `knobs` angles; the cross spire up to `spire`, its bar at `bar.y`, ±`bar.half`.
   */
  crown: {
    cy: number;
    rings: { r: number; dy: number; w: number; gap?: [number, number]; knobs: number[] }[];
    spire: number;
    bar: { y: number; half: number };
  };
  /** A lobe (mirrored): root, leading tip, outer corner, bottom corner ([dx, y] each), edge sags (px), galaxy [dx, y, r]. */
  lobes: {
    root: [number, number];
    tip: [number, number];
    outer: [number, number];
    bottom: [number, number];
    sag: [number, number, number];
    galaxy: [number, number, number];
  }[];
  /** The open cavity and the galaxy-organ in it. */
  cavity: { y: number; rx: number; ry: number; organ: number; core: number };
  /** Galaxy-pods set in the torso: [dx, y, rx, ry]. */
  chambers: [number, number, number, number][];
  scar: { y: number; r: number };
  /** The heavy lower structures: splines ([dx, y] points) with a root → tip radius. */
  limbs: { pts: [number, number][]; r0: number; r1: number }[];
  /** Hanging chains: a thread through `pts`, galaxy-pods [dx, y, rx, ry] on it, bone beads every `bead` px. */
  chains: { pts: [number, number][]; pods: [number, number, number, number][]; bead: number }[];
  /** Laced webs between the lower structures: polygons of [dx, y] (mirrored only if `mirror`). */
  webs: { pts: [number, number][]; mirror: boolean }[];
}

export interface ChildRig {
  core: { x: number; y: number; r: number };
  /** Mean body radius (px). */
  radius: number;
  /** The crown apparatus (the halo the arena's matter will answer to). */
  crown: { x: number; y: number; r: number };
  /** Each lobe's nodes (left first) and its galaxy: Gate 2 sways them, Gate 3 dims a sheared one. */
  lobes: { side: -1 | 1; root: Pt; tip: Pt; outer: Pt; bottom: Pt }[];
  galaxies: { x: number; y: number; r: number }[];
  /** Every galaxy-pod (torso and chains): the organs still deciding what to be. */
  pods: { x: number; y: number; rx: number; ry: number }[];
  /** The lower structures' roots and tips (limbs, then chains). */
  strands: { x0: number; y0: number; x1: number; y1: number }[];
  scar: { x: number; y: number; r: number };
  ids: {
    tissue: number;
    flesh: number;
    vein: number;
    bone: number;
    membrane: number;
    galaxy: number;
    star: number;
    core: number;
  };
}

interface Pt {
  x: number;
  y: number;
}

const params = (def: TitanDef): ChildParams => def.art.params as unknown as ChildParams;

const matId = (def: TitanDef, key: string): number => {
  const i = def.materials.findIndex((m) => m.key === key);
  if (i < 0) throw new Error(`${def.id} (cradle child): material '${key}' missing`);
  return i + 1;
};

interface Seg {
  ax: number;
  ay: number;
  ra: number;
  bx: number;
  by: number;
  rb: number;
}
type Bone = Seg & { knuckle: number; behind?: boolean };

interface Lobe {
  side: -1 | 1;
  root: Pt;
  tip: Pt;
  outer: Pt;
  bottom: Pt;
  /** The membrane outline (sagging edges), flat [x0, y0, …] for sdPolygon. */
  poly: number[];
  /** The bottom and outer edges as point runs (drips hang from them). */
  lower: Pt[];
  gx: number;
  gy: number;
  gr: number;
  seed: number;
}

interface Pod {
  x: number;
  y: number;
  rx: number;
  ry: number;
  seed: number;
}

function catmull(pts: [number, number][], steps: number): Pt[] {
  const out: Pt[] = [];
  const P = (i: number): [number, number] => pts[Math.max(0, Math.min(pts.length - 1, i))]!;
  for (let i = 0; i < pts.length - 1; i++)
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const [x0, y0] = P(i - 1);
      const [x1, y1] = P(i);
      const [x2, y2] = P(i + 1);
      const [x3, y3] = P(i + 2);
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number): number =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(x0, x1, x2, x3), y: f(y0, y1, y2, y3) });
    }
  const last = pts[pts.length - 1]!;
  out.push({ x: last[0], y: last[1] });
  return out;
}

/** The torso's half-width at y (0 outside its span), smoothly through the profile's points. */
function halfWidth(p: ChildParams, y: number): number {
  const P = p.profile;
  if (y < P[0]![0] || y > P[P.length - 1]![0]) return 0;
  for (let k = 0; k < P.length - 1; k++) {
    const [y0, w0] = P[k]!;
    const [y1, w1] = P[k + 1]!;
    if (y <= y1) return w0 + (w1 - w0) * smoothstep(0, 1, (y - y0) / Math.max(1e-6, y1 - y0));
  }
  return 0;
}

/** Capsules along a run of points, radius from `r(q)` (q = 0 … 1 along the run). */
function capsules(pts: readonly Pt[], r: (q: number) => number): Seg[] {
  const out: Seg[] = [];
  for (let s = 0; s < pts.length - 1; s++)
    out.push({
      ax: pts[s]!.x,
      ay: pts[s]!.y,
      ra: r(s / (pts.length - 1)),
      bx: pts[s + 1]!.x,
      by: pts[s + 1]!.y,
      rb: r((s + 1) / (pts.length - 1)),
    });
  return out;
}

/** A sagging edge from a to b: `n` points, bowed `sag` px toward `toward`. */
function sagEdge(a: Pt, b: Pt, sag: number, toward: Pt, n: number): Pt[] {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const len = DMath.hypot(ex, ey) || 1;
  let nx = -ey / len;
  let ny = ex / len;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  if ((toward.x - mx) * nx + (toward.y - my) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const out: Pt[] = [];
  for (let s = 0; s < n; s++) {
    const t = s / n;
    const k = sag * DMath.sin(Math.PI * t);
    out.push({ x: a.x + ex * t + nx * k, y: a.y + ey * t + ny * k });
  }
  return out;
}

interface Layout {
  p: ChildParams;
  lobes: Lobe[];
  bones: Bone[];
  knobs: { x: number; y: number; r: number }[];
  /** Thin vessels (wine-red) laid over soft tissue. */
  veins: Seg[];
  /** Vessels and threads that hang free in the void (red loops, web strands between the rings). */
  threads: { seg: Seg; red: boolean }[];
  limbs: { segs: Seg[]; x0: number; y0: number; x1: number; y1: number }[];
  chains: { segs: Seg[]; beads: Pt[]; x0: number; y0: number; x1: number; y1: number }[];
  pods: Pod[];
  webs: number[][];
  core: { x: number; y: number; r: number };
}

function makeLayout(def: TitanDef, seed: number): Layout {
  const p = params(def);
  const rng = new Rng(seed ^ 0xc41d);
  const cx = p.cx;
  const at = (dx: number, y: number, side: number): Pt => ({ x: cx + side * dx, y });
  const bones: Bone[] = [];
  const knobs: Layout['knobs'] = [];
  const threads: Layout['threads'] = [];
  const bone = (pts: Pt[], w0: number, w1: number, knuckle = 0, behind = false): void => {
    for (const s of capsules(pts, (q) => w0 + (w1 - w0) * q)) bones.push({ ...s, knuckle, behind });
  };
  const line = (a: Pt, b: Pt, n: number): Pt[] => {
    const out: Pt[] = [];
    for (let s = 0; s <= n; s++) out.push({ x: a.x + ((b.x - a.x) * s) / n, y: a.y + ((b.y - a.y) * s) / n });
    return out;
  };

  // THE CROWN APPARATUS: rings round the head (behind the body), one broken open and hooked at the break, knobbed nodes;
  // a cross spire through them; web strands between the rings
  const C = p.crown;
  for (const R of C.rings) {
    const ry = C.cy + R.dy;
    const [g0, g1] = R.gap ?? [0, 0];
    const a0 = R.gap ? g1 : -Math.PI / 2;
    const a1 = R.gap ? g0 + Math.PI * 2 : (Math.PI * 3) / 2;
    const n = Math.ceil(R.r * (a1 - a0) * 0.5);
    const pts: Pt[] = [];
    for (let s = 0; s <= n; s++) {
      const a = a0 + ((a1 - a0) * s) / n;
      pts.push({ x: cx + DMath.cos(a) * R.r, y: ry + DMath.sin(a) * R.r });
    }
    bone(pts, R.w, R.w, 0, true);
    if (R.gap) {
      // one end curls back on itself (a hook: the clasp that no longer closes), the other ends in a knob
      const e = pts[0]!;
      const hook: Pt[] = [];
      for (let s = 0; s <= 6; s++) {
        const a = g1 + Math.PI / 2 + (s / 6) * Math.PI * 1.3;
        hook.push({ x: e.x + DMath.cos(g1 - Math.PI / 2) * 3.2 + DMath.cos(a) * 3.2, y: e.y + DMath.sin(g1 - Math.PI / 2) * 3.2 + DMath.sin(a) * 3.2 });
      }
      bone(hook, R.w * 0.8, R.w * 0.6, 0, true);
      const f = pts[pts.length - 1]!;
      knobs.push({ x: f.x, y: f.y, r: R.w + 1.1 });
    }
    for (const a of R.knobs) knobs.push({ x: cx + DMath.cos(a) * R.r, y: ry + DMath.sin(a) * R.r, r: R.w + 1 });
  }
  // the spire and its cross bar, knobbed at every end
  bone(line({ x: cx, y: p.hood.top + 3 }, { x: cx, y: C.spire }, 10), 2.1, 1.5);
  knobs.push({ x: cx, y: C.spire, r: 2.3 });
  bone(line({ x: cx - C.bar.half, y: C.bar.y }, { x: cx + C.bar.half, y: C.bar.y }, 6), 1.4, 1.4);
  knobs.push({ x: cx - C.bar.half, y: C.bar.y, r: 1.8 }, { x: cx + C.bar.half, y: C.bar.y, r: 1.8 });
  // web strands strung between the two rings, sagging (some red: something feeds through them)
  if (C.rings.length >= 2) {
    const [r0, r1] = [C.rings[0]!, C.rings[1]!];
    for (const a of [-2.5, -2.05, -0.95, -0.4, 0.3, 2.7]) {
      const A = { x: cx + DMath.cos(a) * r0.r, y: C.cy + r0.dy + DMath.sin(a) * r0.r };
      const B = { x: cx + DMath.cos(a + 0.12) * r1.r, y: C.cy + r1.dy + DMath.sin(a + 0.12) * r1.r };
      const red = rng.next() < 0.4;
      for (const s of capsules(sagEdge(A, B, 2.5, { x: (A.x + B.x) / 2, y: 999 }, 6).concat([B]), () => 0.8))
        threads.push({ seg: s, red });
    }
  }

  // THE HOOD: bone ribs down the sealed mitre (a crest; no openings, no pair of dark spots)
  const H = p.hood;
  for (let k = 0; k < H.ribs; k++) {
    const t = H.ribs === 1 ? 0 : k / (H.ribs - 1) - 0.5;
    const bw = halfWidth(p, H.base - 4) * 0.9;
    const pts: Pt[] = [];
    for (let s = 0; s <= 8; s++) {
      const q = s / 8;
      pts.push({ x: cx + t * 2 * bw * (1 - q) + t * 4 * DMath.sin(Math.PI * q), y: H.base - 4 + (H.top + 2 - (H.base - 4)) * q });
    }
    bone(pts, Math.abs(t) < 0.3 ? 1.5 : 1.2, 0.8);
  }

  // THE LOBES: membranes stretched on four knobbed struts (leading edge heavy, the rest light), each node pushed a little
  // past the membrane like a tent pole
  const lobes: Lobe[] = [];
  p.lobes.forEach((Lp, k) => {
    for (const side of [-1, 1] as const) {
      const root = at(Lp.root[0], Lp.root[1], side);
      const tip = at(Lp.tip[0], Lp.tip[1], side);
      const outer = at(Lp.outer[0], Lp.outer[1], side);
      const bottom = at(Lp.bottom[0], Lp.bottom[1], side);
      const mid = { x: (root.x + tip.x + outer.x + bottom.x) / 4, y: (root.y + tip.y + outer.y + bottom.y) / 4 };
      const eOut = sagEdge(tip, outer, Lp.sag[0], mid, 10);
      const eBot = sagEdge(outer, bottom, Lp.sag[1], mid, 10);
      const eIn = sagEdge(bottom, root, Lp.sag[2], mid, 8);
      const ring = [...line(root, tip, 10).slice(0, -1), ...eOut, ...eBot, ...eIn];
      const lobe: Lobe = {
        side,
        root,
        tip,
        outer,
        bottom,
        poly: ring.flatMap((q) => [q.x, q.y]),
        lower: [...eOut, ...eBot],
        gx: cx + side * Lp.galaxy[0],
        gy: Lp.galaxy[1],
        gr: Lp.galaxy[2],
        seed: Math.floor(rng.range(0, 1e6)) + k * 7 + (side + 1),
      };
      lobes.push(lobe);
      const past = (a: Pt, b: Pt, d: number): Pt => {
        const l = DMath.hypot(b.x - a.x, b.y - a.y) || 1;
        return { x: b.x + ((b.x - a.x) / l) * d, y: b.y + ((b.y - a.y) / l) * d };
      };
      bone(line(root, past(root, tip, 3), 14), 2.4, 1.4, 1);
      bone([...eOut, outer], 1.3, 1.1);
      bone([...eBot, bottom], 1.1, 1);
      // the mid rib from the root to the outer corner, bowing under the galaxy
      const ribMid = { x: lobe.gx + side * 2, y: lobe.gy + lobe.gr * 0.85 + 3 };
      bone(catmull([[root.x, root.y], [ribMid.x, ribMid.y], [outer.x, outer.y]], 6), 1.6, 1.1, 1);
      const tp = past(root, tip, 3);
      knobs.push({ x: tp.x, y: tp.y, r: 2.6 });
      const op = past(mid, outer, 2.5);
      bone(line(outer, op, 2), 1.1, 1.1);
      knobs.push({ x: op.x, y: op.y, r: 2.2 });
      const bp = past(mid, bottom, 2.5);
      bone(line(bottom, bp, 2), 1, 1);
      knobs.push({ x: bp.x, y: bp.y, r: 1.9 });
      knobs.push({ x: root.x, y: root.y, r: 2.8 });
    }
  });

  // vessels: raw red, fanning from each lobe root across the membrane; running down the torso from the cavity; a few
  // loops hanging free off the torso's flank
  const veins: Seg[] = [];
  const walk = (x: number, y: number, dir: number, steps: number, len: number, pull: (x: number, y: number) => number, depth: number, w: number): void => {
    let d = dir;
    for (let s = 0; s < steps; s++) {
      const nx = x + DMath.cos(d) * len;
      const ny = y + DMath.sin(d) * len;
      veins.push({ ax: x, ay: y, ra: w, bx: nx, by: ny, rb: w * 0.92 });
      x = nx;
      y = ny;
      w = Math.max(0.6, w * 0.92);
      let delta = pull(x, y) - d;
      delta = DMath.atan2(DMath.sin(delta), DMath.cos(delta));
      d += delta * 0.3 + rng.range(-0.4, 0.4);
      if (depth < 2 && s % 3 === 1 && rng.next() < 0.7)
        walk(x, y, d + (rng.next() < 0.5 ? -1 : 1) * rng.range(0.45, 0.85), steps - s - 1, len * 0.85, pull, depth + 1, w * 0.8);
    }
  };
  for (const L of lobes) {
    const targets = [L.tip, L.outer, { x: L.gx, y: L.gy + L.gr + 3 }, L.bottom];
    for (const T of targets) {
      const pull = (): number => DMath.atan2(T.y - L.root.y, T.x - L.root.x);
      const n = Math.round(DMath.hypot(T.x - L.root.x, T.y - L.root.y) / 4.2);
      walk(L.root.x, L.root.y, pull() + rng.range(-0.2, 0.2), n, 3.6, pull, 1, 1.1);
    }
  }
  const Cv = p.cavity;
  const down = (): number => Math.PI / 2;
  for (let j = 0; j < 2; j++) {
    const n0 = veins.length;
    walk(cx - rng.range(0.2, 0.8) * Cv.rx, Cv.y + Cv.ry * 0.85, Math.PI / 2 + rng.range(-0.25, 0.35), 14, 3.6, down, 2, 0.95);
    // bilateral: mirror the run onto the other side (with a little drift, so it is not a stamp)
    for (const v of veins.slice(n0)) {
      const jx = (hash01(Math.round(v.ax), Math.round(v.ay), seed) - 0.5) * 1.2;
      veins.push({ ...v, ax: 2 * cx - v.ax + jx, bx: 2 * cx - v.bx + jx });
    }
  }
  for (const [side, y0, y1, out] of [
    [-1, Cv.y + Cv.ry + 4, Cv.y + Cv.ry + 34, 9],
    [1, Cv.y + Cv.ry + 16, Cv.y + Cv.ry + 40, 6],
  ] as const) {
    const ya = y0;
    const yb = y1;
    const xa = cx + side * (halfWidth(p, ya) - 1.5);
    const xb = cx + side * (halfWidth(p, yb) - 1.5);
    const loop = catmull(
      [
        [xa, ya],
        [xa + side * out, (ya * 2 + yb) / 3 + 4],
        [xb + side * out * 0.8, (ya + yb * 2) / 3 + 6],
        [xb, yb],
      ],
      6,
    );
    for (const s of capsules(loop, () => 0.9)) threads.push({ seg: s, red: true });
  }

  // the lower structures
  const limbs: Layout['limbs'] = [];
  for (const Lm of p.limbs) {
    const c = catmull(Lm.pts.map(([dx, y]) => [cx + dx, y] as [number, number]), 8);
    // heavy: holds its weight most of the way, then tapers fast
    const segs = capsules(c, (q) => Lm.r1 + (Lm.r0 - Lm.r1) * (1 - DMath.pow(q, 1.6)));
    limbs.push({ segs, x0: c[0]!.x, y0: c[0]!.y, x1: c[c.length - 1]!.x, y1: c[c.length - 1]!.y });
    knobs.push({ x: c[c.length - 1]!.x, y: c[c.length - 1]!.y + 1, r: Lm.r1 + 0.8 });
    // knuckles where the scaffold bears weight
    for (const q of [0.45, 0.75]) {
      const pt = c[Math.round(q * (c.length - 1))]!;
      const r = Lm.r1 + (Lm.r0 - Lm.r1) * (1 - DMath.pow(q, 1.6));
      knobs.push({ x: pt.x + rng.range(-0.8, 0.8), y: pt.y, r: r * 0.75 });
    }
  }
  const pods: Pod[] = p.chambers.map(([dx, y, rx, ry], k) => ({ x: cx + dx, y, rx, ry, seed: seed + 400 + k }));
  const chains: Layout['chains'] = [];
  p.chains.forEach((Ch, k) => {
    const c = catmull(Ch.pts.map(([dx, y]) => [cx + dx, y] as [number, number]), 8);
    const segs = capsules(c, () => 0.85);
    const beads: Pt[] = [];
    let acc = Ch.bead * 0.6;
    for (let s = 1; s < c.length; s++) {
      acc += DMath.hypot(c[s]!.x - c[s - 1]!.x, c[s]!.y - c[s - 1]!.y);
      if (acc >= Ch.bead) {
        acc = 0;
        beads.push(c[s]!);
      }
    }
    Ch.pods.forEach(([dx, y, rx, ry], j) => pods.push({ x: cx + dx, y, rx, ry, seed: seed + 500 + k * 10 + j }));
    chains.push({ segs, beads, x0: c[0]!.x, y0: c[0]!.y, x1: c[c.length - 1]!.x, y1: c[c.length - 1]!.y });
  });
  const webs: number[][] = [];
  for (const Wb of p.webs)
    for (const side of Wb.mirror ? [-1, 1] : [1])
      webs.push(Wb.pts.flatMap(([dx, y]) => [cx + side * dx, y]));

  return {
    p,
    lobes,
    bones,
    knobs,
    veins,
    threads,
    limbs,
    chains,
    pods,
    webs,
    core: { x: cx, y: Cv.y, r: Cv.core },
  };
}

const segSd = (x: number, y: number, s: Seg): number =>
  sdTaperedCapsule(x, y, s.ax, s.ay, s.ra, s.bx, s.by, s.rb);

/** Stamp a set of capsules: calls `f(i, d, k)` for every cell within capsule k (d = signed distance, < 0 inside). */
function stamp(W: number, H: number, segs: readonly Seg[], f: (i: number, d: number, k: number) => void): void {
  segs.forEach((sg, k) => {
    const r = Math.max(sg.ra, sg.rb) + 1;
    const x0 = Math.max(1, Math.floor(Math.min(sg.ax, sg.bx) - r));
    const x1 = Math.min(W - 2, Math.ceil(Math.max(sg.ax, sg.bx) + r));
    const y0 = Math.max(1, Math.floor(Math.min(sg.ay, sg.by) - r));
    const y1 = Math.min(H - 2, Math.ceil(Math.max(sg.ay, sg.by) + r));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const d = segSd(x + 0.5, y + 0.5, sg);
        if (d < 0) f(y * W + x, d, k);
      }
  });
}

/** Cells inside a polygon (flat points), with the signed distance to its edge. */
function fillPoly(W: number, H: number, poly: readonly number[], f: (i: number, x: number, y: number, d: number) => void): void {
  let x0 = W;
  let x1 = 0;
  let y0 = H;
  let y1 = 0;
  for (let k = 0; k < poly.length; k += 2) {
    x0 = Math.min(x0, poly[k]!);
    x1 = Math.max(x1, poly[k]!);
    y0 = Math.min(y0, poly[k + 1]!);
    y1 = Math.max(y1, poly[k + 1]!);
  }
  for (let y = Math.max(1, Math.floor(y0)); y <= Math.min(H - 2, Math.ceil(y1)); y++)
    for (let x = Math.max(1, Math.floor(x0)); x <= Math.min(W - 2, Math.ceil(x1)); x++) {
      const d = sdPolygon(x + 0.5, y + 0.5, poly);
      if (d < 0) f(y * W + x, x, y, d);
    }
}

export function buildChildRig(def: TitanDef, seed: number): ChildRig {
  const L = makeLayout(def, seed);
  const p = L.p;
  const outer = p.crown.rings[p.crown.rings.length - 1]!;
  const P0 = p.profile[0]![0];
  const P1 = p.profile[p.profile.length - 1]![0];
  return {
    core: L.core,
    radius: (Math.max(...p.profile.map(([, w]) => w)) + (P1 - P0) / 2) / 2,
    crown: { x: p.cx, y: p.crown.cy + outer.dy, r: outer.r },
    lobes: L.lobes.map((l) => ({ side: l.side, root: l.root, tip: l.tip, outer: l.outer, bottom: l.bottom })),
    galaxies: L.lobes.map((l) => ({ x: l.gx, y: l.gy, r: l.gr })),
    pods: L.pods.map((q) => ({ x: q.x, y: q.y, rx: q.rx, ry: q.ry })),
    strands: [...L.limbs, ...L.chains].map((s) => ({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 })),
    scar: { x: p.cx, y: p.scar.y, r: p.scar.r },
    ids: {
      tissue: matId(def, 'tissue'),
      flesh: matId(def, 'flesh'),
      vein: matId(def, 'vein'),
      bone: matId(def, 'bone'),
      membrane: matId(def, 'membrane'),
      galaxy: matId(def, 'galaxy'),
      star: matId(def, 'star'),
      core: matId(def, 'core'),
    },
  };
}

/**
 * A spiral galaxy at disc coordinates (u, v; r = 1 at its edge): two logarithmic arms of cold light round a gold nucleus,
 * a violet glow between them. Returns the material and tone, or null for the haze that lets the host show through.
 */
function galaxyAt(
  u: number,
  v: number,
  spin: number,
  s: number,
  x: number,
  y: number,
  ids: ChildRig['ids'],
): { m: number; tone: number } | null {
  const r = DMath.hypot(u, v);
  if (r >= 1) {
    // its lilac halo: the light it gives off, dithered out into the host (the "window" it sits in)
    const h = (1.55 - r) / 0.55;
    return h > 0 && bayer8(x, y) < h * 0.8 ? { m: ids.galaxy, tone: -0.1 + h * 0.6 } : null;
  }
  const th = DMath.atan2(v, u);
  const arm = DMath.cos(2 * (th - spin * 2.4 * DMath.log(r + 0.08)));
  const dust = fbm(u * 3 + 2, v * 3, s, 2);
  if (r < 0.26 + dust * 0.05) return { m: ids.star, tone: 2 - r * 5 };
  // light, not an iris: the arms and the glow fade out into the host (no dark ring)
  const lit = arm * (1 - r * 0.4) + dust * 0.4;
  if (r > 0.78 && (lit < -0.2 || bayer8(x, y) < (r - 0.78) / 0.22)) return null;
  return { m: ids.galaxy, tone: 0.4 + lit * 2.2 + (1 - r) * 2.2 };
}

export function paintChild(
  def: TitanDef,
  seed: number,
  lighting: StageLighting,
): { map: MatterMap; rig: ChildRig } {
  const L = makeLayout(def, seed);
  const rig = buildChildRig(def, seed);
  const { ids } = rig;
  const p = L.p;
  const W = def.art.w;
  const H = def.art.h;
  const cv = new ArtCanvas(W, H);
  const cx = p.cx;
  const sA = (seed & 0xfff) + 211;
  const sB = ((seed >>> 12) & 0xfff) + 977;
  const wc = makeWorley();
  // thin things (drips, threads, web strands, beads) are all edge: the shader would outline them dark, so they take a fixed
  // step of their lit ramp instead (index per cell; −1 = shade normally)
  const thin = new Int8Array(W * H).fill(-1);
  const set = (i: number, m: number, rel: number, tone: number): void => {
    cv.mat[i] = m;
    cv.relief[i] = rel;
    cv.tone[i] = tone;
    thin[i] = -1;
  };
  const setThin = (i: number, m: number, step: number): void => {
    set(i, m, 3, 0);
    thin[i] = step;
  };
  /** A bone bead: a fixed little sphere, lit from the top left. */
  const bead = (bx: number, by: number, r: number, m = ids.bone): void => {
    for (let y = Math.floor(by - r - 1); y <= Math.ceil(by + r + 1); y++)
      for (let x = Math.floor(bx - r - 1); x <= Math.ceil(bx + r + 1); x++) {
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        const dx = x + 0.5 - bx;
        const dy = y + 0.5 - by;
        if (DMath.hypot(dx, dy) >= r) continue;
        const lit = -(dx + dy) / (r * 1.4);
        setThin(y * W + x, m, lit > 0.35 ? 6 : lit > -0.4 ? 4 : 2);
      }
  };
  const soft = (m: number): boolean => m === ids.tissue || m === ids.flesh || m === ids.membrane;
  const paintBones = (bones: readonly Bone[]): void =>
    stamp(W, H, bones, (i, d, k) => {
      const sg = bones[k]!;
      const r = Math.max(sg.ra, sg.rb);
      const round = Math.sqrt(clamp01(-d / r));
      const x = i % W;
      const y = (i / W) | 0;
      const knot = sg.knuckle ? DMath.pow(Math.abs(DMath.cos((k % 5) * 0.63)), 6) : 0;
      const pit = ridged(x * 0.4, y * 0.4, sA + 80, 2);
      set(i, ids.bone, 15 + round * 3 + knot * 2, 0.8 + round * 0.8 + knot * 0.6 - pit * 0.4);
    });
  /**
   * Lace: membrane near its free edge is eaten into holes (Worley cells), leaving a web of strands along the cell borders.
   * `edge` is the distance (px) to the free edge at which the lace stops.
   */
  const lace = (x: number, y: number, depth: number, edge: number, s: number): 'hole' | 'web' | 'whole' => {
    if (depth > edge) return 'whole';
    const cell = 6.5;
    worley((x + 0.5) / cell, (y + 0.5) / cell, s, wc, 0.9);
    const border = (wc.f2 - wc.f1) * cell;
    if (border < 1.1) return depth < edge * 0.85 ? 'web' : 'whole';
    return wc.id < 0.9 * (1 - depth / edge) ? 'hole' : 'whole';
  };

  // 1. the crown's rings, behind everything painted after them; the free threads (red loops, ring webs)
  paintBones(L.bones.filter((b) => b.behind));
  L.threads.forEach(({ seg, red }) =>
    stamp(W, H, [seg], (i) => {
      if (cv.mat[i] === 0) setThin(i, red ? ids.vein : ids.membrane, red ? 3 : 5);
    }),
  );

  // 2. THE LOWER STRUCTURES (behind the torso): laced webs, then the hanging chains, then the heavy limbs
  for (const poly of L.webs)
    fillPoly(W, H, poly, (i, x, y, d) => {
      const depth = -d;
      const l = lace(x, y, depth, 9, sB + 5);
      if (l === 'hole') return;
      if (l === 'web') return setThin(i, ids.membrane, 5);
      set(i, ids.membrane, 3 + Math.min(depth, 4) * 0.5, 0.9 + fbm(x * 0.12, y * 0.12, sB + 6, 2) * 0.6);
    });
  for (const Ch of L.chains) {
    stamp(W, H, Ch.segs, (i) => setThin(i, ids.tissue, 5));
    for (const b of Ch.beads) bead(b.x, b.y, 1.9);
  }
  L.limbs.forEach((Lm, k) => {
    let along = 0;
    for (const sg of Lm.segs) {
      const len = DMath.hypot(sg.bx - sg.ax, sg.by - sg.ay);
      stamp(W, H, [sg], (i, d) => {
        const r = Math.max(sg.ra, sg.rb);
        const dome = Math.sqrt(clamp01(-d / r));
        const x = i % W;
        const y = (i / W) | 0;
        const ring = ((along + len * 0.5) / 8 + k * 0.37) % 1 < 0.12 ? -0.6 : 0;
        const inner = dome > 0.7 && fbm(x * 0.2, y * 0.2, sA + 30 + k, 2) > 0.05;
        set(i, inner ? ids.flesh : ids.tissue, 6 + dome * r * 1.4, 0.5 + dome * 0.8 + ring);
      });
      along += len;
    }
  });

  // 3. THE LOBES: gestational membrane, lilac in the window round the galaxy, flushed rose toward the root, laced with
  //    holes along the free edges; a broken wine-red hem on the lower edge
  for (const Lb of L.lobes) {
    fillPoly(W, H, Lb.poly, (i, x, y, d) => {
      const fx = x + 0.5;
      const fy = y + 0.5;
      const depth = -d;
      // the leading edge is held by its strut: no lace there
      const nearLead = sdTaperedCapsule(fx, fy, Lb.root.x, Lb.root.y, 0, Lb.tip.x, Lb.tip.y, 0) < 5;
      const gd = DMath.hypot(fx - Lb.gx, fy - Lb.gy) / (Lb.gr + 3);
      const l = nearLead || gd < 1.25 ? 'whole' : lace(x, y, depth, 12, Lb.seed);
      if (l === 'hole') return;
      if (l === 'web') return setThin(i, ids.membrane, 5);
      const rootD = DMath.hypot(fx - Lb.root.x, fy - Lb.root.y);
      const window = 1 - smoothstep(0.7, 1.6, gd);
      let m = ids.membrane;
      let tone = 0.6 + window * 0.9 + fbm(fx * 0.14, fy * 0.14, Lb.seed + 3, 2) * 0.5 - (1 - clamp01(depth / 6)) * 0.3;
      if (rootD < 14 + fbm(fx * 0.1, fy * 0.1, Lb.seed + 5, 2) * 5) {
        m = ids.flesh;
        tone = 0.2 + clamp01(rootD / 14) * 0.6;
      }
      set(i, m, 4 + Math.min(depth, 8) * 0.6, tone);
    });
  }

  // 4. THE TORSO: sickly pearl tissue, rose flesh in its deep folds; translucent edges
  const mask = new Uint8Array(W * H);
  const P0 = p.profile[0]![0];
  const P1 = p.profile[p.profile.length - 1]![0];
  for (let y = Math.max(1, Math.floor(P0)); y <= Math.min(H - 2, Math.ceil(P1)); y++)
    for (let x = 1; x < W - 1; x++) {
      const fx = x + 0.5;
      const fy = y + 0.5;
      const hw = halfWidth(p, fy) + fbm(fy * 0.08, 1.7, sA + 1, 2) * 1.2;
      if (Math.abs(fx - cx) < hw) mask[y * W + x] = 1;
    }
  const dist = edt(mask, W, H, false);
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    const x = i % W;
    const y = (i / W) | 0;
    const fx = x + 0.5;
    const fy = y + 0.5;
    const d = dist[i]!;
    const dome = Math.sqrt(clamp01(d / 14));
    const mx = Math.abs(fx - cx);
    const fold = ridged(mx * 0.22, fy * 0.04, sB + 3, 2);
    let m = ids.tissue;
    let tone = 0.5 + dome * 0.9 - fold * 1.1 + fbm(mx * 0.08, fy * 0.08, sA + 7, 2) * 0.5;
    if (d > 3 && fy > p.hood.base && (fold > 0.8 || fbm(mx * 0.06, fy * 0.05, sB + 11, 3) > 0.32)) {
      m = ids.flesh;
      tone = 0.4 + dome * 0.7 - fold * 0.4;
    }
    if (d < 1.6) tone += 0.8;
    // the hood is smoother and paler: sealed, a mask that never resolves into a face
    if (fy < p.hood.base) tone += 0.4;
    set(i, m, 8 + dome * 10 + fold * 1.2, tone);
  }

  // 5. vessels over the soft tissue
  stamp(W, H, L.veins, (i) => {
    if (soft(cv.mat[i]!)) set(i, ids.vein, cv.relief[i]! + 0.5, 1.1);
  });

  // 6. THE OPEN CAVITY under the brow, and the great galaxy-organ in it: pearl tissue wound into a spiral round the gold
  //    core, raw red grooves between its arms, the cavity's wet rose wall falling away into shadow behind it
  const Cv = p.cavity;
  const kc = L.core;
  for (let y = Math.floor(Cv.y - Cv.ry - 2); y <= Math.ceil(Cv.y + Cv.ry + 2); y++)
    for (let x = Math.floor(cx - Cv.rx - 2); x <= Math.ceil(cx + Cv.rx + 2); x++) {
      const i = y * W + x;
      const fx = x + 0.5;
      const fy = y + 0.5;
      const dx = fx - cx;
      const dy = fy - Cv.y;
      // taller than wide and narrowing to a point under the brow (an opening in tissue, never a round socket)
      const wq = Cv.rx * (1 - 0.4 * Math.max(0, -dy / Cv.ry));
      const q = DMath.hypot(dx / wq, dy / Cv.ry) + fbm(fx * 0.12, fy * 0.12, sA + 60, 2) * 0.1;
      if (q >= 1 || cv.mat[i] === 0) continue;
      const rc = DMath.hypot(dx, dy);
      const th = DMath.atan2(dy, dx);
      if (rc < kc.r + 0.5) {
        // the core: white-hot at its heart, gold toward its edge
        set(i, ids.core, 16 + (1 - rc / kc.r) * 4, 3.2 - DMath.pow(rc / kc.r, 1.5) * 3 + fbm(fx * 0.3, fy * 0.3, sB + 61, 2) * 0.3);
        continue;
      }
      const spill = 1 - (rc - kc.r) / 3;
      if (spill > 0 && bayer8(x, y) < spill * 0.9) {
        set(i, ids.star, 15, spill * 2.2 - 0.3);
        continue;
      }
      const oq = rc / Cv.organ;
      // the organ: two heavy pearl arms curling in to the core (a galaxy wound out of tissue); between their turns the rose
      // wall shows, a raw red line deepest in each groove
      const arm = DMath.cos(2 * (th + 1.7 * DMath.log(oq + 0.05)) + 0.6);
      const fade = smoothstep(0.95, 1.35, oq);
      if (arm - fade * 1.6 > -0.35) {
        const lip = 1 - Math.min(1, oq);
        set(i, ids.tissue, 12 + arm * 3 + lip * 4, 0.8 + arm * 1 - oq * 0.3);
        continue;
      }
      // the cavity wall: wet rose ridges, deepest in shadow under the brow, lifting into the torso below
      const wall = ridged(th * 4, oq * 2, sB + 63, 2);
      const under = clamp01(-dy / Cv.ry + 0.3);
      if (arm < -0.9 && oq < 1.1) set(i, ids.vein, 6, 0);
      else set(i, ids.flesh, 4 + wall + q * 3, -0.6 + wall * 0.8 - under * 1.4 + q * 0.6);
    }
  // the brow's soft drips hanging into the cavity (pale, rounded, few: tissue sagging, not teeth)
  {
    const rng = new Rng(seed ^ 0xd21b);
    for (let k = 0; k < 4; k++) {
      const dx = (k - 1.5) * Cv.rx * 0.42 + rng.range(-1.5, 1.5);
      const top = Cv.y - Cv.ry * DMath.pow(Math.max(0, 1 - sq(dx / Cv.rx)), 0.5) + 1;
      const len = rng.range(3, 6.5);
      stamp(W, H, [{ ax: cx + dx, ay: top, ra: 1.5, bx: cx + dx + rng.range(-0.5, 0.5), by: top + len, rb: 1 }], (i, d) =>
        set(i, ids.tissue, 13, 1.1 + d * 0.4),
      );
    }
  }

  // 7. GALAXIES: one in each lobe's window (turning opposite ways), and the almond galaxy-pods (torso and chains), each in
  //    a raw rose rim
  for (const Lb of L.lobes) {
    const R = Lb.gr;
    for (let y = Math.floor(Lb.gy - R * 1.6); y <= Math.ceil(Lb.gy + R * 1.6); y++)
      for (let x = Math.floor(Lb.gx - R * 1.6); x <= Math.ceil(Lb.gx + R * 1.6); x++) {
        const i = y * W + x;
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1 || !soft(cv.mat[i]!) && cv.mat[i] !== ids.vein) continue;
        // tilted along the lobe, seen at a slant
        const a = DMath.atan2(Lb.outer.y - Lb.root.y, Lb.outer.x - Lb.root.x);
        const dx = x + 0.5 - Lb.gx;
        const dy = y + 0.5 - Lb.gy;
        const u = (dx * DMath.cos(a) + dy * DMath.sin(a)) / R;
        const v = (-dx * DMath.sin(a) + dy * DMath.cos(a)) / (R * 0.72);
        const g = galaxyAt(u, v, Lb.side, Lb.seed + 9, x, y, ids);
        if (g) set(i, g.m, 6 + (1 - DMath.hypot(u, v)) * 2, g.tone);
      }
  }
  for (const pd of L.pods) {
    for (let y = Math.floor(pd.y - pd.ry - 2); y <= Math.ceil(pd.y + pd.ry + 2); y++)
      for (let x = Math.floor(pd.x - pd.rx - 2); x <= Math.ceil(pd.x + pd.rx + 2); x++) {
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        const i = y * W + x;
        const dx = x + 0.5 - pd.x;
        const dy = (y + 0.5 - pd.y) / (pd.ry + 1.4);
        // almond: narrowing to a point at both poles
        const w = (pd.rx + 1.4) * (1 - 0.55 * Math.abs(dy));
        const q = DMath.hypot(dx / Math.max(0.5, w), dy);
        if (q >= 1) continue;
        const rim = 1.4 / (pd.rx + 1.4);
        if (q > 1 - rim) {
          set(i, hash01(x, y, pd.seed) < 0.55 ? ids.vein : ids.flesh, 10, 1.4);
          continue;
        }
        const g = galaxyAt((dx / w) * 1.15, dy * 1.15, pd.seed & 1 ? 1 : -1, pd.seed, x, y, ids);
        set(i, g ? g.m : ids.galaxy, 9, g ? g.tone : 0.6);
      }
  }

  // 8. BONE: the spire, the hood ribs, the lobe struts; the knobs at every node and tip
  paintBones(L.bones.filter((b) => !b.behind));
  for (const n of L.knobs) {
    const R = n.r + 1;
    for (let y = Math.floor(n.y - R); y <= Math.ceil(n.y + R); y++)
      for (let x = Math.floor(n.x - R); x <= Math.ceil(n.x + R); x++) {
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        const d = DMath.hypot(x + 0.5 - n.x, y + 0.5 - n.y);
        if (d < n.r) set(y * W + x, ids.bone, 18 + (1 - d / n.r) * 3, 1.3 - (d / n.r) * 0.9);
      }
  }

  // 9. THE HEALED CORD SCAR: a puckered pale knot of keloid tissue, a dimpled centre, creases radiating from it; closed
  const S = p.scar;
  for (let y = Math.floor(S.y - S.r * 2.4); y <= Math.ceil(S.y + S.r * 2.4); y++)
    for (let x = Math.floor(cx - S.r * 2.4); x <= Math.ceil(cx + S.r * 2.4); x++) {
      const i = y * W + x;
      if (cv.mat[i] === 0 || cv.mat[i] === ids.bone) continue;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - S.y;
      const r = DMath.hypot(dx, dy * 1.15);
      const th = DMath.atan2(dy, dx);
      if (r < S.r * 0.38) set(i, ids.flesh, cv.relief[i]! - 2, -0.9);
      else if (r < S.r) {
        const pucker = DMath.cos(th * 7 + r * 0.8);
        set(i, ids.bone, cv.relief[i]! + 1.5 + pucker * 0.6, 0.2 + pucker * 0.7 + (1 - r / S.r) * 0.4);
      } else if (r < S.r * 2.3) {
        const crease = Math.abs(DMath.sin(th * 4.5 + 0.4));
        if (crease < 0.12 + 0.1 * (1 - r / (S.r * 2.3))) {
          cv.tone[i] = cv.tone[i]! - 1.1;
          cv.relief[i] = cv.relief[i]! - 0.8;
        }
      }
    }

  // 10. DRIPS: it is still wet from becoming. Thin runs hang from the lobes' lower edges, the crown's knobs and the lower
  //     structures, each ending in a small bead
  {
    const rng = new Rng(seed ^ 0xd819);
    const anchors: Pt[] = [];
    for (const Lb of L.lobes) for (let k = 2; k < Lb.lower.length; k += 3) if (rng.next() < 0.55) anchors.push(Lb.lower[k]!);
    for (const n of L.knobs) if (rng.next() < 0.3) anchors.push({ x: n.x, y: n.y + n.r });
    for (const Lm of [...L.limbs, ...L.chains]) anchors.push({ x: Lm.x1, y: Lm.y1 });
    for (const a of anchors) {
      const x = Math.round(a.x);
      let y = Math.round(a.y);
      // find the underside: walk down through matter to the first void cell
      let guard = 0;
      while (y < H - 3 && cv.mat[y * W + x] !== 0 && guard++ < 12) y++;
      if (cv.mat[(y - 1) * W + x] === 0 || cv.mat[y * W + x] !== 0) continue;
      const len = rng.range(2.5, 7.5);
      const by = Math.min(H - 5, y + len);
      const red = rng.next() < 0.3;
      stamp(W, H, [{ ax: x + 0.5, ay: y - 1, ra: 0.85, bx: x + 0.5, by, rb: 0.8 }], (i) => {
        if (cv.mat[i] === 0) setThin(i, red ? ids.vein : ids.membrane, red ? 3 : 5);
      });
      bead(x + 0.5, by, 1.6, red ? ids.vein : ids.bone);
    }
  }

  keepLargestComponent(cv.mat, W, H);
  cv.invalidate();

  const ramps = buildLitRamps(def.materials, lighting, 0.75);
  const shade: (Partial<ShadeParams> | undefined)[] = [];
  shade[ids.tissue] = { contrast: 0.9, dither: 0.55, ao: 0.55, rim: 0.7, outline: 0.7, bayer8: true, bias: 0.06 };
  shade[ids.flesh] = { contrast: 0.95, dither: 0.55, ao: 0.6, rim: 0.4, outline: 0.6, bayer8: true };
  shade[ids.vein] = { contrast: 0.8, dither: 0.2, ao: 0.2, rim: 0.2, outline: 0.2 };
  shade[ids.bone] = { contrast: 1.15, dither: 0.25, ao: 0.4, rim: 0.9, outline: 0.8, bias: 0.08 };
  shade[ids.membrane] = { contrast: 0.7, dither: 0.6, ao: 0.4, rim: 0.9, outline: 0.35, bayer8: true, bump: 0.6 };
  shade[ids.galaxy] = { contrast: 0.5, dither: 0.6, ao: 0, rim: 0, outline: 0, bayer8: true, bump: 0.3 };
  shade[ids.star] = { contrast: 0.5, dither: 0.3, ao: 0, rim: 0, outline: 0 };
  shade[ids.core] = { contrast: 0.6, dither: 0.3, ao: 0, rim: 0, outline: 0 };
  for (let i = 0; i < W * H; i++) {
    const r = ramps[cv.mat[i]!];
    if (thin[i]! >= 0 && r) cv.over[i] = r[Math.min(r.length - 1, thin[i]!)]!;
  }
  const colors = cv.render({ ramps, params: shade, lighting, rimMix: 0.2 });

  const map = createMatterMap(W, H);
  const dens: Record<number, number> = {
    [ids.tissue]: 100,
    [ids.flesh]: 110,
    [ids.vein]: 110,
    [ids.bone]: 190,
    [ids.membrane]: 70,
    [ids.galaxy]: 80,
    [ids.star]: 120,
    [ids.core]: 210,
  };
  cv.writeTo(map, colors, (m) => dens[m] ?? 110);
  map.coreX = Math.round(kc.x - 0.5);
  map.coreY = Math.round(kc.y - 0.5);
  map.coreRadius = kc.r;
  return { map, rig };
}
