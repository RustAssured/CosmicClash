import {
  Rng,
  clamp01,
  createMatterMap,
  DEFAULT_LIGHTING,
  smoothstep,
  type MatterMap,
  type StageLighting,
  type TitanDef,
} from '@/contracts';
import { ArtCanvas, buildLitRamps, type ShadeParams } from '../../art/canvas';
import { keepLargestComponent } from '../../art/field';
import { bayer8, fbm, hash01, ridged } from '../../art/noise';
import { sdCircle, sdTaperedCapsule, smin } from '../../art/sdf';

/**
 * THE CRADLE / 태반체: its own painter (grown out of the kit's blob template; WJ's brief docs/titans/cradle/BRIEF.md).
 *
 * Not a body but a developmental process: a huge tilted radial membrane disc (calcified rib-spokes, translucent membrane
 * panels lit from within, branching vasculature, amniotic sacs), a hanging central body-knot around a black-red embryonic
 * core, and ONE long segmented umbilical tail ending in a blunt, plated jaw-organ. The sprite faces +x (the jaw-organ points
 * at the foe).
 *
 * The disc is painted in its own "disc space" (u, v on the unit disc, projected through a tilt and a squash), so the rig can
 * later billow and tilt it as a sail (Gate 2). Every look number is in the JSON's `art.params` (CradleParams); the palette is
 * the JSON materials' ramps. Materials, by key: membrane, vessel, collagen, muscle, bone, sac, lumen, core.
 * Pure and deterministic in (def, seed, lighting).
 */
export interface CradleParams {
  disc: {
    /** Disc centre (= the hub the spokes converge on), map px. */
    cx: number;
    cy: number;
    /** Projected radii (px): rx across, ry the squash of the tilt toward the camera. */
    rx: number;
    ry: number;
    /** In-plane roll of the disc (radians, negative = the front edge, +x, raised). */
    roll: number;
    spokes: number;
    /** How deep the membrane edge sags between two spoke tips (0..0.3 of the radius). */
    scallop: number;
    /** Torn panels: how many, and how deep the tear runs (0..0.6 of the radius). */
    tears: number;
    tearDepth: number;
    /** How far the spoke tips poke past the membrane (fraction of the radius). */
    tipOut: number;
  };
  /** The hanging body-knot: offset from the hub (px) and its size. */
  knot: { dx: number; dy: number; r: number };
  /** The embryonic core: offset from the knot centre (px) and radius. */
  core: { dx: number; dy: number; r: number };
  /**
   * The umbilical tail: a spline through `pts` (map px, from the knot down), radius r0 → r1, `segs` beads; in the game it is
   * `links` rigid links (each a few beads: a heavy chain, not a rope) and the jaw-organ.
   */
  tail: {
    pts: [number, number][];
    r0: number;
    r1: number;
    segs: number;
    links: number;
    jaw: { len: number; r: number };
  };
}

/**
 * One of the Cradle's bodies in the game, cut out of the painted composite: [0] the knot (the fighter's primary body and KO
 * core), [1] the disc (a rig region pinned at the hub: the sail), then the cord links root → tip, then the jaw-organ.
 */
export interface CradleRegion {
  key: string;
  kind: 'knot' | 'disc' | 'cord' | 'jaw';
  map: MatterMap;
  /** Where the map's (0, 0) sits in the composite (px). */
  ox: number;
  oy: number;
  /** The body's pivot in the composite (px): the knot's core, the disc's hub, a link's root joint. */
  pivotX: number;
  pivotY: number;
  /** Draw order inside the rig layer (the knot is the body layer itself, in front). */
  z: number;
  /** Cord link index (the jaw = links), −1 otherwise. */
  link: number;
}

/** Cell owners in the composite (0 = void). */
const OWN_KNOT = 1;
const OWN_DISC = 2;
const OWN_CORD = 3;

export interface CradleRig {
  /** The hub the spokes converge on and the disc's projection (for the sail rig). */
  hub: { x: number; y: number };
  disc: { cx: number; cy: number; rx: number; ry: number; roll: number };
  spokes: { ax: number; ay: number; bx: number; by: number; phi: number }[];
  sacs: { x: number; y: number; rx: number; ry: number }[];
  knot: { x: number; y: number; r: number };
  core: { x: number; y: number; r: number };
  /** Tail segment centres root → jaw (the chain the Gate 2 rig swings). */
  tail: { x: number; y: number; r: number }[];
  jaw: { x: number; y: number; angle: number; len: number; r: number };
  /** The jaw-organ's blunt end (composite px). */
  jawTip: { x: number; y: number };
  /** Mean body radius (px). */
  radius: number;
  /** The game's bodies (filled by the painter; [0] is the knot = the primary map). */
  regions: CradleRegion[];
  /** The whole Cradle at rest (menus, site, checks): every region composited. */
  portrait: MatterMap | null;
  /** The KO core cell's centre in the composite (px): the primary body's anchor. */
  coreAt: { x: number; y: number };
  /** The stage-lit ramps it was painted with, per material id (wrong development recolours with them: ./grow.ts). */
  ramps: number[][];
  ids: {
    membrane: number;
    vessel: number;
    collagen: number;
    muscle: number;
    bone: number;
    sac: number;
    lumen: number;
    core: number;
  };
}

const TAU = Math.PI * 2;
/** Capsule pieces per spoke (the knuckles need the resolution). */
const SPOKE_PIECES = 24;
const params = (def: TitanDef): CradleParams => def.art.params as unknown as CradleParams;

const matId = (def: TitanDef, key: string): number => {
  const i = def.materials.findIndex((m) => m.key === key);
  if (i < 0) throw new Error(`${def.id} (cradle): material '${key}' missing`);
  return i + 1;
};

/* ------------------------------------------------------------------------------------------------ layout */

interface Seg {
  ax: number;
  ay: number;
  ra: number;
  bx: number;
  by: number;
  rb: number;
}
interface Sac {
  x: number;
  y: number;
  a: number;
  b: number;
  rot: number;
  lumen: boolean;
  seed: number;
}
interface TailSample {
  x: number;
  y: number;
  tx: number;
  ty: number;
  s: number;
}

export interface Layout {
  p: CradleParams;
  /** disc space ↔ map px */
  toScreen(u: number, v: number, out: { x: number; y: number }): void;
  toDisc(x: number, y: number, out: { u: number; v: number }): void;
  phis: number[];
  /** Membrane edge radius (disc space) at angle phi, and which panel / where across it (0..1). */
  edge(phi: number): { r: number; k: number; t: number };
  spokes: Seg[][];
  spokeKnuckles: { n: number; ph: number }[];
  spokeEnds: { ax: number; ay: number; bx: number; by: number; phi: number }[];
  nodules: { x: number; y: number; r: number }[];
  vessels: Seg[];
  sacs: Sac[];
  knotSd(x: number, y: number): number;
  knot: { x: number; y: number; r: number };
  core: { x: number; y: number; r: number };
  knotBands: Seg[];
  knotNodules: { x: number; y: number; r: number }[];
  knotVessels: Seg[];
  tail: TailSample[];
  tailLen: number;
  strands: Seg[];
}

function catmull(pts: [number, number][], steps: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
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

export function makeLayout(def: TitanDef, seed: number): Layout {
  const p = params(def);
  const D = p.disc;
  const rng = new Rng(seed ^ 0xc4ad1e);
  const cr = Math.cos(D.roll);
  const sr = Math.sin(D.roll);
  const toScreen = (u: number, v: number, out: { x: number; y: number }): void => {
    const a = u * D.rx;
    const b = v * D.ry;
    out.x = D.cx + a * cr - b * sr;
    out.y = D.cy + a * sr + b * cr;
  };
  const toDisc = (x: number, y: number, out: { u: number; v: number }): void => {
    const dx = x - D.cx;
    const dy = y - D.cy;
    out.u = (dx * cr + dy * sr) / D.rx;
    out.v = (-dx * sr + dy * cr) / D.ry;
  };

  // spoke angles: evenly spread with a little irregularity (organic, but radially ordered: "horrible but organised")
  const N = D.spokes;
  const phase = rng.range(0, TAU / N);
  const phis: number[] = [];
  for (let k = 0; k < N; k++) phis.push(phase + ((k + rng.range(-0.18, 0.18)) / N) * TAU);
  // torn panels: never the front-most ones (the jaw side keeps a clean edge to read the facing)
  const tears = new Map<number, { t: number; w: number; d: number }>();
  for (let n = 0; n < D.tears; n++) {
    const k = (Math.floor(rng.range(0, N)) + n * 3) % N;
    tears.set(k, { t: rng.range(0.3, 0.7), w: rng.range(0.07, 0.13), d: D.tearDepth * rng.range(0.6, 1) });
  }
  const panelOf = (phi: number): { k: number; t: number } => {
    let a = (((phi - phis[0]!) % TAU) + TAU) % TAU;
    for (let k = 0; k < N; k++) {
      const span = (((phis[(k + 1) % N]! - phis[k]!) % TAU) + TAU) % TAU || TAU;
      if (a < span) return { k, t: a / span };
      a -= span;
    }
    return { k: N - 1, t: 0.999 };
  };
  const edge = (phi: number): { r: number; k: number; t: number } => {
    const { k, t } = panelOf(phi);
    let r = 1 - D.scallop * Math.pow(Math.sin(Math.PI * t), 1.3) + fbm(phi * 2.2, 0.5, seed + 77, 3) * 0.035;
    const tear = tears.get(k);
    if (tear) r -= tear.d * Math.max(0, 1 - Math.abs(t - tear.t) / tear.w) ** 1.4;
    return { r, k, t };
  };

  // spokes: bowed, tapered bone ribs from the hub to past the membrane edge
  const tmp = { x: 0, y: 0 };
  const spokes: Seg[][] = [];
  const spokeKnuckles: Layout['spokeKnuckles'] = [];
  const spokeEnds: Layout['spokeEnds'] = [];
  const nodules: Layout['nodules'] = [];
  for (let k = 0; k < N; k++) {
    const phi = phis[k]!;
    const reach = 1 + D.tipOut * rng.range(0.6, 1.2);
    const bow = rng.range(0.04, 0.09) * (k % 2 ? 1 : -1);
    const pts: { x: number; y: number }[] = [];
    for (let s = 0; s <= SPOKE_PIECES; s++) {
      const t = s / SPOKE_PIECES;
      const rho = 0.06 + (reach - 0.06) * t;
      const a = phi + bow * Math.sin(Math.PI * t);
      toScreen(Math.cos(a) * rho, Math.sin(a) * rho, tmp);
      pts.push({ x: tmp.x, y: tmp.y });
    }
    // nearer spokes (the lower half, v > 0: toward the camera) read a touch heavier
    const near = 1 + 0.25 * Math.sin(phi);
    // knuckled, calcified bone: a run of swollen joints (like vertebrae fused into a rib), thinning toward the tip
    const knuckles = Math.round(rng.range(5, 7.5));
    const kph = rng.range(0, 1);
    const rad = (t: number): number => {
      const taper = 3.6 - 1.9 * t;
      const knot = Math.pow(Math.abs(Math.cos(Math.PI * (t * knuckles + kph))), 4);
      return taper * (0.66 + 0.48 * knot) * near;
    };
    const segs: Seg[] = [];
    for (let s = 0; s < SPOKE_PIECES; s++)
      segs.push({
        ax: pts[s]!.x,
        ay: pts[s]!.y,
        ra: rad(s / SPOKE_PIECES),
        bx: pts[s + 1]!.x,
        by: pts[s + 1]!.y,
        rb: rad((s + 1) / SPOKE_PIECES),
      });
    spokes.push(segs);
    spokeKnuckles.push({ n: knuckles, ph: kph });
    const tip = pts[SPOKE_PIECES]!;
    spokeEnds.push({ ax: pts[0]!.x, ay: pts[0]!.y, bx: tip.x, by: tip.y, phi });
    // a knuckled tip and one or two calcified knots along the rib
    nodules.push({ x: tip.x, y: tip.y, r: 2.6 * near + rng.range(0, 0.8) });
    const nk = 1 + (rng.next() < 0.5 ? 1 : 0);
    for (let j = 0; j < nk; j++) {
      const q = pts[Math.round(rng.range(0.3, 0.8) * SPOKE_PIECES)]!;
      nodules.push({
        x: q.x + rng.range(-0.6, 0.6),
        y: q.y + rng.range(-0.6, 0.6),
        r: rng.range(2.4, 3.4) * near,
      });
    }
  }

  // vasculature: a branching tree per panel, rooted at the hub, fanning out toward the rim and the spokes
  const vessels: Seg[] = [];
  const a0 = { x: 0, y: 0 };
  const a1 = { x: 0, y: 0 };
  const grow = (u: number, v: number, dir: number, len: number, rad: number, depth: number): void => {
    let cu = u;
    let cv = v;
    let d = dir;
    for (let step = 0; step < 7 - depth; step++) {
      const nu = cu + Math.cos(d) * len;
      const nv = cv + Math.sin(d) * len;
      const rho = Math.hypot(nu, nv);
      if (rho > edge(Math.atan2(nv, nu)).r - 0.03) return;
      toScreen(cu, cv, a0);
      toScreen(nu, nv, a1);
      const r = Math.max(0.5, rad * (1 - step * 0.1));
      vessels.push({ ax: a0.x, ay: a0.y, ra: r, bx: a1.x, by: a1.y, rb: Math.max(0.5, r * 0.9) });
      cu = nu;
      cv = nv;
      // vessels drift outward, wandering
      const out = Math.atan2(cv, cu);
      let delta = out - d;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      d += delta * 0.2 + rng.range(-0.5, 0.5);
      if (depth < 2 && step % 2 === 1 && rng.next() < (depth === 0 ? 0.7 : 0.35))
        grow(
          cu,
          cv,
          d + (rng.next() < 0.5 ? -1 : 1) * rng.range(0.6, 1.1),
          len * 0.75,
          rad * 0.72,
          depth + 1,
        );
    }
  };
  for (let k = 0; k < N; k++) {
    const mid = phis[k]! + ((((phis[(k + 1) % N]! - phis[k]!) % TAU) + TAU) % TAU) / 2;
    for (const off of [-0.2, 0.2]) {
      const a = mid + off * rng.range(0.6, 1.3);
      grow(Math.cos(a) * 0.24, Math.sin(a) * 0.24, a, 0.085, 0.72, 0);
    }
  }

  // amniotic sacs: developmental chambers inside the panels, some glowing cold
  const sacs: Sac[] = [];
  for (let k = 0; k < N; k++) {
    const span = (((phis[(k + 1) % N]! - phis[k]!) % TAU) + TAU) % TAU || TAU;
    const roll = rng.next();
    const count = roll < 0.3 ? 2 : roll < 0.85 ? 1 : 0;
    for (let j = 0; j < count; j++) {
      const t = count === 1 ? rng.range(0.4, 0.6) : j === 0 ? rng.range(0.25, 0.38) : rng.range(0.62, 0.75);
      const phi = phis[k]! + span * t;
      const er = edge(phi).r;
      const rho = er * rng.range(0.5, 0.68);
      toScreen(Math.cos(phi) * rho, Math.sin(phi) * rho, tmp);
      const size = (count === 1 ? rng.range(0.1, 0.135) : rng.range(0.07, 0.095)) * D.rx;
      // perspective: chambers bulge toward the camera, so they squash less than the disc does
      sacs.push({
        x: tmp.x,
        y: tmp.y,
        a: size * (0.75 + 0.25 * Math.abs(Math.sin(phi))),
        b: size * (0.5 + 0.18 * Math.abs(Math.cos(phi))),
        rot: D.roll + Math.cos(phi) * 0.35,
        lumen: false,
        seed: Math.floor(rng.range(0, 1e6)),
      });
    }
  }
  // cold light is sparse: only the two largest chambers hold it (where the anatomy is already failing)
  [...sacs]
    .sort((a, b) => b.a * b.b - a.a * a.b)
    .slice(0, 2)
    .forEach((s) => (s.lumen = true));

  // the hanging body-knot: a clutch of lobes, pulled downward by the cord
  const kx = D.cx + p.knot.dx;
  const ky = D.cy + p.knot.dy;
  const KR = p.knot.r;
  // pendulous: wider and heavier below its centre, narrowing up into the hub
  const lobes: { x: number; y: number; r: number }[] = [{ x: kx, y: ky, r: KR * 0.72 }];
  for (let j = 0; j < 8; j++) {
    const a = (j / 8) * TAU + rng.range(-0.3, 0.3);
    const low = Math.max(0, Math.sin(a));
    lobes.push({
      x: kx + Math.cos(a) * KR * (0.6 + 0.1 * low),
      y: ky + Math.sin(a) * KR * 0.62 + KR * 0.12,
      r: KR * rng.range(0.36, 0.5) * (0.8 + 0.4 * low),
    });
  }
  const s1 = seed + 301;
  const knotSd = (x: number, y: number): number => {
    const wx = x + fbm(x * 0.09, y * 0.09, s1, 3) * 2.6;
    const wy = y + fbm(x * 0.09 + 3.1, y * 0.09 + 7.7, s1 + 9, 3) * 2.6;
    let d = Infinity;
    for (const l of lobes) d = smin(d, sdCircle(wx, wy, l.x, l.y, l.r), 7);
    // the stalk up into the hub and the sheath down into the cord
    d = smin(d, sdTaperedCapsule(wx, wy, D.cx, D.cy - 2, KR * 0.42, kx, ky, KR * 0.6), 8);
    const t0 = p.tail.pts[0]!;
    d = smin(d, sdTaperedCapsule(wx, wy, kx, ky, KR * 0.55, t0[0], t0[1], p.tail.r0 * 1.05), 6);
    return d;
  };
  const core = { x: kx + p.core.dx, y: ky + p.core.dy, r: p.core.r };
  // collagen cords wrapping the knot (chords across it, bowed), a few bone islands and surface vessels
  const knotBands: Seg[] = [];
  for (let j = 0; j < 3; j++) {
    // steep wraps (never a horizontal band across the core: that would read as a mouth)
    const a = Math.PI / 2 + (j % 2 ? 1 : -1) * rng.range(0.35, 0.8);
    const off = rng.range(-0.5, 0.5) * KR;
    const ox = Math.cos(a + Math.PI / 2) * off;
    const oy = Math.sin(a + Math.PI / 2) * off;
    const L = KR * 0.9;
    const n = 6;
    let px = kx + ox - Math.cos(a) * L;
    let py = ky + oy - Math.sin(a) * L;
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      const bow = Math.sin(Math.PI * t) * KR * 0.18;
      const qx = kx + ox - Math.cos(a) * L + Math.cos(a) * 2 * L * t + Math.cos(a + Math.PI / 2) * bow;
      const qy = ky + oy - Math.sin(a) * L + Math.sin(a) * 2 * L * t + Math.sin(a + Math.PI / 2) * bow;
      knotBands.push({ ax: px, ay: py, ra: 0.8, bx: qx, by: qy, rb: 0.8 });
      px = qx;
      py = qy;
    }
  }
  const knotNodules: Layout['knotNodules'] = [];
  for (let j = 0; j < 5; j++) {
    const a = rng.range(0, TAU);
    const r = rng.range(0.45, 0.85) * KR;
    knotNodules.push({ x: kx + Math.cos(a) * r, y: ky + Math.sin(a) * r * 1.1, r: rng.range(1.8, 3.2) });
  }
  const knotVessels: Seg[] = [];
  for (let j = 0; j < 12; j++) {
    let x = kx + rng.range(-0.45, 0.45) * KR;
    let y = D.cy + rng.range(0, 6);
    let d = Math.PI / 2 + rng.range(-1.1, 1.1);
    for (let s = 0; s < 9; s++) {
      const nx = x + Math.cos(d) * 4.2;
      const ny = y + Math.sin(d) * 4.2;
      knotVessels.push({ ax: x, ay: y, ra: 1.0 - s * 0.05, bx: nx, by: ny, rb: 0.95 - s * 0.05 });
      x = nx;
      y = ny;
      d += (Math.PI / 2 - d) * 0.15 + rng.range(-0.5, 0.5);
    }
  }

  // the umbilical tail: a dense centreline (arc length and tangent per sample)
  const raw = catmull(p.tail.pts, 24);
  const tail: TailSample[] = [];
  let s = 0;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[Math.max(0, i - 1)]!;
    const b = raw[Math.min(raw.length - 1, i + 1)]!;
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    if (i > 0) s += Math.hypot(raw[i]!.x - raw[i - 1]!.x, raw[i]!.y - raw[i - 1]!.y);
    tail.push({ x: raw[i]!.x, y: raw[i]!.y, tx: (b.x - a.x) / l, ty: (b.y - a.y) / l, s });
  }

  // a few wet strands hanging from the disc's underside near the knot
  const strands: Seg[] = [];
  for (let j = 0; j < 5; j++) {
    const phi = Math.PI / 2 + rng.range(-1.3, 1.3);
    const rho = rng.range(0.3, 0.55);
    toScreen(Math.cos(phi) * rho, Math.sin(phi) * rho, tmp);
    const len = rng.range(6, 13);
    strands.push({
      ax: tmp.x,
      ay: tmp.y,
      ra: 0.75,
      bx: tmp.x + rng.range(-1.5, 1.5),
      by: tmp.y + len,
      rb: 0.6,
    });
  }

  return {
    p,
    toScreen,
    toDisc,
    phis,
    edge,
    spokes,
    spokeKnuckles,
    spokeEnds,
    nodules,
    vessels,
    sacs,
    knotSd,
    knot: { x: kx, y: ky, r: KR },
    core,
    knotBands,
    knotNodules,
    knotVessels,
    tail,
    tailLen: s,
    strands,
  };
}

const segSd = (x: number, y: number, s: Seg): number =>
  sdTaperedCapsule(x, y, s.ax, s.ay, s.ra, s.bx, s.by, s.rb);

/** Stamp a set of capsules: calls `f(i, d)` for every cell within a capsule (d = signed distance, < 0 inside). */
function stamp(W: number, H: number, segs: readonly Seg[], f: (i: number, d: number) => void): void {
  for (const sg of segs) {
    const r = Math.max(sg.ra, sg.rb) + 1;
    const x0 = Math.max(0, Math.floor(Math.min(sg.ax, sg.bx) - r));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(sg.ax, sg.bx) + r));
    const y0 = Math.max(0, Math.floor(Math.min(sg.ay, sg.by) - r));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(sg.ay, sg.by) + r));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const d = segSd(x + 0.5, y + 0.5, sg);
        if (d < 0) f(y * W + x, d);
      }
  }
}

/** Nearest tail sample to a point (brute force over the centreline; the tail is a few hundred samples). */
function nearestTail(L: Layout, x: number, y: number): { i: number; d2: number } {
  let best = 0;
  let bd = Infinity;
  const T = L.tail;
  for (let i = 0; i < T.length; i++) {
    const dx = x - T[i]!.x;
    const dy = y - T[i]!.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bd) {
      bd = d2;
      best = i;
    }
  }
  return { i: best, d2: bd };
}

/** Tail radius at arc length s: tapering cord, a bead per segment, swelling into the blunt jaw-organ. */
function tailRadius(L: Layout, s: number): { r: number; seg: number; inJaw: number } {
  const t = L.p.tail;
  const jawStart = L.tailLen - t.jaw.len;
  if (s >= jawStart) {
    const q = (s - jawStart) / t.jaw.len;
    // swells, holds, then a blunt rounded end
    const swell = smoothstep(0, 0.35, q);
    const end = q > 0.82 ? Math.sqrt(Math.max(0, 1 - ((q - 0.82) / 0.18) ** 2)) : 1;
    return { r: (t.r1 + (t.jaw.r - t.r1) * swell) * (0.35 + 0.65 * end), seg: -1, inJaw: q };
  }
  const q = s / jawStart;
  const base = t.r0 + (t.r1 - t.r0) * q;
  const spacing = jawStart / t.segs;
  const f = (s / spacing) % 1;
  const bead = 0.84 + 0.16 * Math.pow(Math.sin(Math.PI * f), 0.6);
  return { r: base * bead, seg: f, inJaw: -1 };
}

/* ------------------------------------------------------------------------------------------------ rig */

/** The rig without painting: geometry only (regions empty). */
function rigGeometry(def: TitanDef, seed: number): CradleRig {
  const L = makeLayout(def, seed);
  const p = L.p;
  const jawStart = L.tailLen - p.tail.jaw.len;
  const tail: CradleRig['tail'] = [];
  const spacing = jawStart / p.tail.segs;
  for (let k = 0; k < p.tail.segs; k++) {
    const s = (k + 0.5) * spacing;
    const smp = L.tail.reduce((a, b) => (Math.abs(b.s - s) < Math.abs(a.s - s) ? b : a));
    tail.push({ x: smp.x, y: smp.y, r: tailRadius(L, s).r });
  }
  const js = L.tail.reduce((a, b) => (Math.abs(b.s - jawStart) < Math.abs(a.s - jawStart) ? b : a));
  return {
    hub: { x: p.disc.cx, y: p.disc.cy },
    disc: { cx: p.disc.cx, cy: p.disc.cy, rx: p.disc.rx, ry: p.disc.ry, roll: p.disc.roll },
    spokes: L.spokeEnds,
    sacs: L.sacs.map((s) => ({ x: s.x, y: s.y, rx: s.a, ry: s.b })),
    knot: L.knot,
    core: L.core,
    tail,
    jaw: { x: js.x, y: js.y, angle: Math.atan2(js.ty, js.tx), len: p.tail.jaw.len, r: p.tail.jaw.r },
    jawTip: { x: L.tail[L.tail.length - 1]!.x, y: L.tail[L.tail.length - 1]!.y },
    radius: (p.disc.rx + p.disc.ry) / 2,
    regions: [],
    portrait: null,
    coreAt: { x: L.core.x, y: L.core.y },
    ramps: [],
    ids: {
      membrane: matId(def, 'membrane'),
      vessel: matId(def, 'vessel'),
      collagen: matId(def, 'collagen'),
      muscle: matId(def, 'muscle'),
      bone: matId(def, 'bone'),
      sac: matId(def, 'sac'),
      lumen: matId(def, 'lumen'),
      core: matId(def, 'core'),
    },
  };
}

/**
 * The rig with its region maps (the fighter rebuilds it this way when it has no painted body to read it from). Paints under
 * the default light: only the geometry and the maps' shapes matter there.
 */
export function buildCradleRig(def: TitanDef, seed: number): CradleRig {
  return paintCradle(def, seed, DEFAULT_LIGHTING).rig;
}

/* ------------------------------------------------------------------------------------------------ painter */

export function paintCradle(
  def: TitanDef,
  seed: number,
  lighting: StageLighting,
): { map: MatterMap; rig: CradleRig } {
  const L = makeLayout(def, seed);
  const rig = rigGeometry(def, seed);
  const { ids } = rig;
  const p = L.p;
  const W = def.art.w;
  const H = def.art.h;
  const cv = new ArtCanvas(W, H);
  const sA = (seed & 0xfff) + 911;
  const sB = ((seed >>> 12) & 0xfff) + 433;
  const uv = { u: 0, v: 0 };
  // which body each cell belongs to in the game (the knot is the fighter's primary; the disc and every cord link are
  // rig regions): see CradleRegion
  const own = new Uint8Array(W * H);
  let owner = OWN_DISC;
  const set = (i: number, m: number, rel: number, tone: number): void => {
    own[i] = owner;
    cv.mat[i] = m;
    cv.relief[i] = rel;
    cv.tone[i] = tone;
  };

  // 1. THE MEMBRANE: panels between the spokes, lit from within (transmitted light pools amber mid-panel, burgundy at the
  //    ribs and the rim), with radial wrinkles; the muscle sheet around the hub
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const fx = x + 0.5;
      const fy = y + 0.5;
      L.toDisc(fx, fy, uv);
      const rho = Math.hypot(uv.u, uv.v);
      if (rho > 1.2) continue;
      const phi = Math.atan2(uv.v, uv.u);
      const e = L.edge(phi);
      if (rho > e.r) continue;
      const i = y * W + x;
      const across = Math.sin(Math.PI * e.t);
      const outer = rho / e.r;
      const billow = across * Math.sin(Math.PI * Math.min(1, outer * 1.05));
      const wrinkle = ridged(phi * 9, rho * 3.2, sA, 3);
      const glow = Math.pow(across, 0.9) * smoothstep(0.18, 0.55, outer) * (1 - smoothstep(0.82, 1, outer));
      let tone = -2.3 + glow * 5.2 + fbm(fx * 0.06, fy * 0.06, sB, 3) * 0.7 - wrinkle * 0.6;
      tone += (hash01(x, y, sA) - 0.5) * 0.3;
      if (outer > 0.93) tone -= 0.8; // the thickened, darker hem
      let m = ids.membrane;
      let rel = 5 + billow * 4 + wrinkle * 0.8;
      const hubR = 0.26 + fbm(phi * 1.7, 2.3, sB + 5, 2) * 0.05;
      if (rho < hubR) {
        // the bruise-purple muscle sheet the disc contracts with: radial fibres
        m = ids.muscle;
        tone = -0.4 + Math.sin(phi * 46 + fbm(fx * 0.2, fy * 0.2, sA + 3, 2) * 3) * 0.55 + (rho / hubR) * 0.8;
        rel = 8 + (1 - rho / hubR) * 3;
      }
      set(i, m, rel, tone);
    }

  // 2. vasculature over the membrane (dark burgundy, raised)
  stamp(W, H, L.vessels, (i, d) => {
    if (cv.mat[i] !== ids.membrane && cv.mat[i] !== ids.muscle) return;
    set(i, ids.vessel, cv.relief[i]! + 1.2, -1.3 - d * 0.5);
  });

  // 3. amniotic sacs: domed chambers of amber fluid with clouded, half-formed matter inside; a capillary rim; a few hold a
  //    cold turquoise light (the only cold colour on the body)
  for (const s of L.sacs) {
    const R = Math.max(s.a, s.b) + 3;
    const c = Math.cos(s.rot);
    const sn = Math.sin(s.rot);
    for (let y = Math.floor(s.y - R); y <= Math.ceil(s.y + R); y++)
      for (let x = Math.floor(s.x - R); x <= Math.ceil(s.x + R); x++) {
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        const i = y * W + x;
        if (cv.mat[i] === 0) continue;
        const dx = x + 0.5 - s.x;
        const dy = y + 0.5 - s.y;
        const a = (dx * c + dy * sn) / s.a;
        const b = (-dx * sn + dy * c) / s.b;
        const q = Math.hypot(a, b) + fbm(x * 0.15, y * 0.15, s.seed, 2) * 0.08;
        if (q < 1) {
          // BACKLIT FLUID SEEN THROUGH TISSUE: no solid dome; the light pools in the middle and fades into the membrane at
          // the rim (dithered, no outline), the fluid's clouds drift in it, and something half-formed hangs in it as a
          // silhouette against the glow
          const glow = Math.pow(1 - q * q, 0.8);
          const cloud = fbm(a * 2.2 + 1.3, b * 2.2, s.seed + 1, 3);
          const fold = ridged(a * 3 + 7, b * 3, s.seed + 2, 2);
          // the rim: the membrane's own tissue thins over the sac, dithered into it
          if (q > 0.78 && bayer8(x, y) < (q - 0.78) / 0.22) continue;
          let m = ids.sac;
          let tone = -1.6 + glow * 3.4 + cloud * 0.8 - fold * 0.7;
          const oq = Math.hypot(a * 1.25 - 0.2, b * 1.1 + 0.15) + fbm(a * 2.6, b * 2.6, s.seed + 6, 3) * 0.45;
          if (hash01(s.seed, 3, 17) < 0.6 && oq < 0.42) tone -= 2.4 - oq * 2.5;
          if (s.lumen) {
            const lq = Math.hypot(a + 0.15, b - 0.1) + fbm(a * 3, b * 3, s.seed + 4, 2) * 0.35;
            if (lq < 0.27) {
              m = ids.lumen;
              tone = (0.27 - lq) * 6 - 0.6;
            }
          }
          // nearly flat: a translucent sac shows its light, not its shape
          set(i, m, cv.relief[i]! + 0.6 + glow * 1.2, tone);
        }
      }
  }

  // the capillaries in the tissue in FRONT of the fluid: dark silhouettes against its glow
  stamp(W, H, L.vessels, (i, d) => {
    if (cv.mat[i] === ids.sac) set(i, ids.vessel, cv.relief[i]! + 0.8, -1.9 - d * 0.3);
  });

  // 4. scattered bone islands in the membrane (mineralised, embedded)
  const islands: { x: number; y: number; r: number }[] = [];
  {
    const rng = new Rng(seed ^ 0x15a1d);
    const tmp = { x: 0, y: 0 };
    for (let j = 0; j < 7; j++) {
      const phi = rng.range(0, TAU);
      const rho = rng.range(0.3, 0.8) * L.edge(phi).r;
      L.toScreen(Math.cos(phi) * rho, Math.sin(phi) * rho, tmp);
      islands.push({ x: tmp.x, y: tmp.y, r: rng.range(1.4, 2.4) });
    }
  }

  // 5. spokes: calcified rib-spokes, ridged bone, with knuckles; then the rim cord of pale collagen along the hem
  owner = OWN_DISC;
  L.spokes.forEach((segs, k) => {
    const kn = L.spokeKnuckles[k]!;
    segs.forEach((sg, s) => {
      // along the rib: swollen knuckles catch the light, the narrow waists between them sink into shadow
      const t = (s + 0.5) / segs.length;
      const knot = Math.pow(Math.abs(Math.cos(Math.PI * (t * kn.n + kn.ph))), 4);
      stamp(W, H, [sg], (i, d) => {
        const x = i % W;
        const y = (i / W) | 0;
        // pitted, porous calcified surface
        const pit = ridged(x * 0.45, y * 0.45, sA + 11, 2);
        const r = Math.max(sg.ra, sg.rb);
        const round = Math.sqrt(clamp01(-d / r));
        set(i, ids.bone, 8 + round * 3 + knot * 3, -1.7 + knot * 1.5 + round * 0.6 - pit * 0.5);
      });
    });
  });
  for (const n of [...L.nodules, ...islands]) {
    const R = n.r + 1;
    for (let y = Math.floor(n.y - R); y <= Math.ceil(n.y + R); y++)
      for (let x = Math.floor(n.x - R); x <= Math.ceil(n.x + R); x++) {
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        const d = Math.hypot(x + 0.5 - n.x, y + 0.5 - n.y);
        if (d < n.r) set(y * W + x, ids.bone, 14 + (1 - d / n.r) * 3, 0.1 - d / n.r);
      }
  }
  // the hem cord: a pale collagen line along the membrane's edge, between the tips
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (cv.mat[i] !== ids.membrane && cv.mat[i] !== ids.vessel) continue;
      L.toDisc(x + 0.5, y + 0.5, uv);
      const rho = Math.hypot(uv.u, uv.v);
      const e = L.edge(Math.atan2(uv.v, uv.u));
      // ~1.3 px wide in screen, whatever the squash
      const px = ((e.r - rho) * Math.hypot(uv.u * p.disc.rx, uv.v * p.disc.ry)) / Math.max(rho, 1e-3);
      if (px < 1.4 && fbm(x * 0.3, y * 0.3, sB + 21, 2) > -0.35) set(i, ids.collagen, cv.relief[i]! + 1, 0.2);
    }

  // 6. hanging strands under the disc
  stamp(W, H, L.strands, (i) => {
    if (cv.mat[i] === 0) set(i, ids.vessel, 4, -0.3);
  });

  // 7. THE BODY-KNOT: lobed bruise-purple muscle, collagen cords wrapping it, bone islands, surface vessels, and deep in a
  //    chamber the black-red embryonic core (irregular, half-hidden by the cords: not an eye, not a heart)
  owner = OWN_KNOT;
  const K = L.knot;
  const kb = K.r * 2.2;
  for (let y = Math.max(1, Math.floor(K.y - kb - 8)); y < Math.min(H - 1, Math.ceil(K.y + kb)); y++)
    for (let x = Math.max(1, Math.floor(K.x - kb)); x < Math.min(W - 1, Math.ceil(K.x + kb)); x++) {
      const fx = x + 0.5;
      const fy = y + 0.5;
      const d = L.knotSd(fx, fy);
      if (d >= 0) continue;
      const i = y * W + x;
      // hanging, stretched folds of tissue (drawn downward by the cord), not cells
      const lump = Math.sqrt(clamp01(-d / (K.r * 0.8)));
      const fold = ridged(fx * 0.16 + fbm(fx * 0.05, fy * 0.05, sB + 8, 2) * 1.5, fy * 0.055, sA + 40, 2);
      const tone = -0.7 + lump * 1.2 - fold * 1.1 + fbm(fx * 0.1, fy * 0.1, sB + 2, 2) * 0.5;
      set(i, ids.muscle, 10 + lump * 9 + fbm(fx * 0.08, fy * 0.08, sA + 44, 2) * 4, tone);
    }
  stamp(W, H, L.knotVessels, (i, d) => {
    if (cv.mat[i] === ids.muscle) set(i, ids.vessel, cv.relief[i]! + 1.2, 0.6 - d * 0.6);
  });
  // the core chamber: a dark cavity around the core, then the core itself
  const C = L.core;
  const coreSd = (x: number, y: number): number => {
    const wx = x + fbm(x * 0.16, y * 0.16, sA + 60, 2) * 2.4;
    const wy = y + fbm(x * 0.16 + 4, y * 0.16 + 9, sA + 61, 2) * 2.4;
    // a clot of fused, unequal masses, taller than wide: no pupil, no slit, no symmetry
    let d = sdCircle(wx, wy, C.x - C.r * 0.15, C.y - C.r * 0.35, C.r * 0.62);
    d = smin(d, sdCircle(wx, wy, C.x + C.r * 0.35, C.y + C.r * 0.2, C.r * 0.55), 3);
    d = smin(d, sdCircle(wx, wy, C.x - C.r * 0.3, C.y + C.r * 0.55, C.r * 0.42), 3);
    d = smin(d, sdCircle(wx, wy, C.x + C.r * 0.15, C.y + C.r * 0.95, C.r * 0.3), 2.5);
    return d;
  };
  for (let y = Math.floor(C.y - C.r * 2); y <= Math.ceil(C.y + C.r * 2); y++)
    for (let x = Math.floor(C.x - C.r * 2); x <= Math.ceil(C.x + C.r * 2); x++) {
      const i = y * W + x;
      if (cv.mat[i] === 0) continue;
      const fx = x + 0.5;
      const fy = y + 0.5;
      const d = coreSd(fx, fy);
      if (d < 0) {
        const crease = ridged(fx * 0.3, fy * 0.3, sB + 70, 2);
        const tone = -1.6 + crease * 1.8 + Math.min(1, -d / C.r) * 0.3;
        set(i, ids.core, 6 + Math.min(1, -d / C.r) * 4, tone);
      } else if (d < 2.6) {
        cv.tone[i] = cv.tone[i]! - 2.2 + d * 0.4; // the chamber wall falls away into shadow
        cv.relief[i] = cv.relief[i]! - 4;
      }
    }
  stamp(W, H, L.knotBands, (i, d) => {
    if (cv.mat[i] === ids.muscle || cv.mat[i] === ids.vessel)
      set(i, ids.collagen, cv.relief[i]! + 1.5, -0.8 - d * 0.5);
  });
  for (const n of L.knotNodules) {
    const R = n.r + 1;
    for (let y = Math.floor(n.y - R); y <= Math.ceil(n.y + R); y++)
      for (let x = Math.floor(n.x - R); x <= Math.ceil(n.x + R); x++) {
        const i = y * W + x;
        if (cv.mat[i] !== ids.muscle && cv.mat[i] !== ids.vessel) continue;
        const d = Math.hypot(x + 0.5 - n.x, y + 0.5 - n.y);
        if (d < n.r) set(i, ids.bone, cv.relief[i]! + 2 + (1 - d / n.r) * 2, 0.6 - d / n.r);
      }
  }

  // 8. THE UMBILICAL TAIL: beaded segments of mauve cord, pale collagen rings between them, two dark arteries spiralling
  //    round it; it swells into the jaw-organ: two blunt bone plates closed on a dark cleft
  const T = L.tail;
  let tx0 = W;
  let tx1 = 0;
  let ty0 = H;
  let ty1 = 0;
  const rMax = Math.max(p.tail.r0, p.tail.jaw.r) + 2;
  for (const s of T) {
    tx0 = Math.min(tx0, s.x - rMax);
    tx1 = Math.max(tx1, s.x + rMax);
    ty0 = Math.min(ty0, s.y - rMax);
    ty1 = Math.max(ty1, s.y + rMax);
  }
  const jawStart = L.tailLen - p.tail.jaw.len;
  for (let y = Math.max(1, Math.floor(ty0)); y < Math.min(H - 1, Math.ceil(ty1)); y++)
    for (let x = Math.max(1, Math.floor(tx0)); x < Math.min(W - 1, Math.ceil(tx1)); x++) {
      const fx = x + 0.5;
      const fy = y + 0.5;
      const { i: si } = nearestTail(L, fx, fy);
      const smp = T[si]!;
      const dx = fx - smp.x;
      const dy = fy - smp.y;
      // signed offset across the cord (+ = right of the direction of travel), and past either end
      const along = dx * smp.tx + dy * smp.ty;
      const cross = -dx * smp.ty + dy * smp.tx;
      if ((si === 0 && along < 0) || (si === T.length - 1 && along > 0.5)) continue;
      const tr = tailRadius(L, smp.s);
      const r = tr.r + fbm(fx * 0.2, fy * 0.2, sA + 90, 2) * 0.5;
      if (Math.abs(cross) >= r) continue;
      const i = y * W + x;
      owner = linkOwner(L, smp.s);
      const c = cross / r;
      const dome = Math.sqrt(Math.max(0, 1 - c * c));
      let m = ids.muscle;
      let tone = -1.1 + dome * 1.2 + fbm(fx * 0.12, fy * 0.12, sB + 90, 2) * 0.4;
      let rel = 12 + dome * r;
      if (tr.inJaw < 0) {
        // segment rings
        if (tr.seg < 0.07 || tr.seg > 0.95) {
          m = ids.collagen;
          tone = -1.2 + dome * 1.1;
          rel -= 1.5;
        } else {
          // the helical vessels (the cord's own arteries)
          const pitch = 26;
          for (const ph of [0, Math.PI]) {
            const h = Math.sin((smp.s / pitch) * TAU + ph) * 0.72;
            const front = Math.cos((smp.s / pitch) * TAU + ph) > -0.2;
            if (front && Math.abs(c - h) < 1.15 / r) {
              m = ids.vessel;
              tone = -1.7 + dome * 0.5;
              rel += 1;
            }
          }
        }
      } else {
        // the jaw-organ: plated, blunt, closed
        const q = tr.inJaw;
        const seam = 0.12 + 0.3 * Math.pow(Math.max(0, q - 0.55) / 0.45, 1.6) + 0.04 * Math.sin(q * 9);
        if (q > 0.22 && Math.abs(c) > seam) {
          m = ids.bone;
          const plate = Math.sin(q * 4 * Math.PI + 1) > 0.8 ? -1.1 : 0;
          tone = -2.4 + dome * 1.3 + plate + (c < 0 ? 0.3 : -0.4);
          rel += 2;
        } else if (q > 0.22) {
          m = ids.vessel;
          tone = -1.6;
          rel -= 4;
        } else {
          tone += 0.2;
        }
      }
      set(i, m, rel, tone);
    }
  // the jaw-organ's plates get a knuckled ridge where they meet the cord
  owner = OWN_CORD + p.tail.links;
  {
    const js = T.reduce((a, b) =>
      Math.abs(b.s - (jawStart + p.tail.jaw.len * 0.24)) < Math.abs(a.s - (jawStart + p.tail.jaw.len * 0.24))
        ? b
        : a,
    );
    for (const side of [-1, 1]) {
      const nx = js.x - js.ty * side * p.tail.jaw.r * 0.8;
      const ny = js.y + js.tx * side * p.tail.jaw.r * 0.8;
      for (let y = Math.floor(ny - 4); y <= Math.ceil(ny + 4); y++)
        for (let x = Math.floor(nx - 4); x <= Math.ceil(nx + 4); x++) {
          const i = y * W + x;
          if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1 || cv.mat[i] === 0) continue;
          const d = Math.hypot(x + 0.5 - nx, y + 0.5 - ny);
          if (d < 2.6) set(i, ids.bone, cv.relief[i]! + 2, 0.4 - d * 0.3);
        }
    }
  }

  keepLargestComponent(cv.mat, W, H);
  cv.invalidate();

  const ramps = buildLitRamps(def.materials, lighting, 0.85);
  const shade: (Partial<ShadeParams> | undefined)[] = [];
  shade[ids.membrane] = {
    contrast: 0.85,
    dither: 0.6,
    ao: 0.6,
    rim: 0.6,
    outline: 0.9,
    bayer8: true,
    bump: 0.7,
  };
  shade[ids.vessel] = { contrast: 1.0, dither: 0.3, ao: 0.4, rim: 0.4 };
  shade[ids.collagen] = { contrast: 1.1, dither: 0.3, ao: 0.3, rim: 0.5 };
  shade[ids.muscle] = { contrast: 1.15, dither: 0.55, ao: 0.9, bayer8: true };
  shade[ids.bone] = { contrast: 1.3, dither: 0.25, ao: 0.6, rim: 0.8 };
  shade[ids.sac] = { contrast: 0.45, dither: 0.7, ao: 0, rim: 0, outline: 0, bayer8: true, bump: 0.4 };
  shade[ids.lumen] = { contrast: 0.7, dither: 0.4, ao: 0, rim: 0, outline: 0 };
  shade[ids.core] = { contrast: 0.7, dither: 0.35, ao: 0.2, rim: 0, outline: 0 };
  const colors = cv.render({ ramps, params: shade, lighting, rimMix: 0.2 });

  const map = createMatterMap(W, H);
  const dens: Record<number, number> = {
    [ids.membrane]: 70,
    [ids.vessel]: 110,
    [ids.collagen]: 130,
    [ids.muscle]: 120,
    [ids.bone]: 190,
    [ids.sac]: 90,
    [ids.lumen]: 90,
    [ids.core]: 210,
  };
  cv.writeTo(map, colors, (m) => dens[m] ?? 110);
  // the KO anchor: the embryonic core (nudged onto a live cell if the warp left its centre empty)
  let cx = Math.round(C.x);
  let cy = Math.round(C.y);
  if (map.material[cy * W + cx] === 0) {
    let best = Infinity;
    for (let y = cy - 8; y <= cy + 8; y++)
      for (let x = cx - 8; x <= cx + 8; x++)
        if (map.material[y * W + x] === ids.core) {
          const d = (x - C.x) ** 2 + (y - C.y) ** 2;
          if (d < best) {
            best = d;
            cx = x;
            cy = y;
          }
        }
  }
  map.coreX = cx;
  map.coreY = cy;
  map.coreRadius = C.r;

  // split the composite into the game's bodies: the knot (primary, KO core), the disc, the cord links, the jaw-organ
  const jawStartS = L.tailLen - p.tail.jaw.len;
  const linkLen = jawStartS / p.tail.links;
  const at = (s: number): TailSample =>
    L.tail.reduce((a, b) => (Math.abs(b.s - s) < Math.abs(a.s - s) ? b : a));
  const regions: CradleRegion[] = [];
  const cut = (
    o: number,
    key: string,
    kind: CradleRegion['kind'],
    px: number,
    py: number,
    z: number,
    link: number,
    cap = 0,
    capOwner = 0,
  ): void => {
    const r = extractRegion(map, own, o, key, kind, px, py, z, link, cap, capOwner);
    if (r) regions.push(r);
  };
  cut(OWN_KNOT, 'knot', 'knot', cx + 0.5, cy + 0.5, 0, -1);
  cut(OWN_DISC, 'disc', 'disc', p.disc.cx, p.disc.cy, -0.6, -1);
  for (let k = 0; k < p.tail.links; k++) {
    const s0 = at(k * linkLen);
    cut(
      OWN_CORD + k,
      `cord${k}`,
      'cord',
      s0.x,
      s0.y,
      -0.4 + k * 0.01,
      k,
      tailRadius(L, s0.s).r + 1,
      k === 0 ? OWN_KNOT : OWN_CORD + k - 1,
    );
  }
  const sj = at(jawStartS);
  cut(
    OWN_CORD + p.tail.links,
    'jaw',
    'jaw',
    sj.x,
    sj.y,
    -0.3,
    p.tail.links,
    p.tail.r1 + 1,
    OWN_CORD + p.tail.links - 1,
  );
  if (regions[0]?.key !== 'knot') throw new Error('cradle: the knot region is missing');
  rig.regions = regions;
  rig.portrait = map;
  rig.coreAt = { x: cx + 0.5, y: cy + 0.5 };
  rig.ramps = ramps;
  return { map: regions[0].map, rig };
}

/**
 * One body's cells cut out of the composite: its own map (bounding box + 2 px margin), where that map sits in the composite
 * and its pivot (composite px). The map's `coreX/coreY` is the live cell nearest the pivot (a region's joint patch is the
 * live cells round it; the knot's is the embryonic core, the KO anchor).
 */
function extractRegion(
  src: MatterMap,
  own: Uint8Array,
  o: number,
  key: string,
  kind: CradleRegion['kind'],
  pivotX: number,
  pivotY: number,
  z: number,
  link: number,
  cap: number,
  capOwner: number,
): CradleRegion | null {
  // a link also carries a round cap of its parent's cells about its pivot: when the joint bends, the cap covers the seam
  const mine = (i: number, x: number, y: number): boolean =>
    src.material[i] !== 0 &&
    (own[i] === o ||
      (cap > 0 && own[i] === capOwner && (x + 0.5 - pivotX) ** 2 + (y + 0.5 - pivotY) ** 2 < cap * cap));
  let x0 = src.w;
  let y0 = src.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      const i = y * src.w + x;
      if (!mine(i, x, y)) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  if (x1 < 0) return null;
  // the disc gets room round it for its living warp (combat/behaviours/kit/cradle/sail.ts): its rim lifts a few px
  const M = kind === 'disc' ? 7 : 2;
  const ox = x0 - M;
  const oy = y0 - M;
  const w = x1 - x0 + 1 + 2 * M;
  const h = y1 - y0 + 1 + 2 * M;
  const map = createMatterMap(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = x + ox;
      const sy = y + oy;
      if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) continue;
      const si = sy * src.w + sx;
      if (!mine(si, sx, sy)) continue;
      const i = y * w + x;
      map.material[i] = src.material[si]!;
      map.density[i] = src.density[si]!;
      map.baseColor[i] = src.baseColor[si]!;
      map.height[i] = src.height[si]!;
    }
  keepLargestComponent(map.material, w, h);
  for (let i = 0; i < w * h; i++)
    if (map.material[i] === 0) {
      map.density[i] = 0;
      map.baseColor[i] = 0;
      map.height[i] = 0;
    }
  // the anchor cell: the live cell nearest the pivot
  const lx = pivotX - ox;
  const ly = pivotY - oy;
  let best = Infinity;
  let cx = Math.floor(lx);
  let cy = Math.floor(ly);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (map.material[y * w + x] === 0) continue;
      const d = (x + 0.5 - lx) ** 2 + (y + 0.5 - ly) ** 2;
      if (d < best) {
        best = d;
        cx = x;
        cy = y;
      }
    }
  map.coreX = cx;
  map.coreY = cy;
  map.coreRadius = kind === 'knot' ? src.coreRadius : kind === 'disc' ? 7 : 4;
  return { key, kind, map, ox, oy, pivotX, pivotY, z, link };
}

/** Which body a cord cell at arc length s belongs to (a link, or the jaw-organ). */
function linkOwner(L: Layout, s: number): number {
  const t = L.p.tail;
  const jawStart = L.tailLen - t.jaw.len;
  if (s >= jawStart) return OWN_CORD + t.links;
  return OWN_CORD + Math.min(t.links - 1, Math.floor(s / (jawStart / t.links)));
}
