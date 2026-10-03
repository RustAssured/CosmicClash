import {
  DEFAULT_LIGHTING,
  Rng,
  clamp,
  clamp01,
  createMatterMap,
  hex,
  lerp,
  rgba,
  smoothstep,
  AIM_DIRS,
  type MaterialSpec,
  type MatterMap,
  type MoveDef,
  type StageLighting,
  type TitanDef,
} from '@/contracts';
import { blend } from './color';
import { ArtCanvas, buildLitRamps, type ShadeParams } from './canvas';
import { edt, keepLargestComponent } from './field';
import { bayer8, fbm, hash01, makeWorley, ridged, worley } from './noise';
import { sdCircle, sdEllipse, sdEllipseRot, sdSegment, sdTaperedCapsule, smax, smin, ssub } from './sdf';

/**
 * THE LAST ONE — an ancient celadon idol: a weathered glazed pod-head with one great eye set in a bevelled socket, a tilted
 * gilt halo on fine spokes, a bell-shaped mantle with a scalloped hem. Under the glaze: a paler crystalline lattice, dark
 * fault ribs, and a golden lantern-core that glows warmly through the porcelain. Tendrils are NOT in this map — they are
 * verlet chains (src/combat), rooted at the `roots` returned in the rig.
 */

export interface TendrilRoot {
  /** Map-local root position (cells) and outward unit normal. */
  x: number;
  y: number;
  nx: number;
  ny: number;
  /** Natural length in px and a phase in [0,1) for idle sway. */
  len: number;
  phase: number;
  /**
   * Rest shape: total heading change from root to tip (rad, signed; a curl), and an S-wave along the length (amplitude rad and
   * phase rad). Every tendril gets its own, so the veil reads as grown, not combed.
   */
  curl: number;
  wave: number;
  wavePh: number;
  /** Drives resting posture. */
  kind: 'hem' | 'back' | 'crown' | 'front';
}

export interface LastOneRig {
  eye: { x: number; y: number; r: number; socketR: number };
  core: { x: number; y: number; r: number };
  halo: { cx: number; cy: number; a: number; b: number; tilt: number };
  roots: TendrilRoot[];
  /** Material ids in the generated map (index+1 of the JSON material list). */
  ids: {
    shell: number;
    seam: number;
    inner: number;
    core: number;
    eye: number;
    iris: number;
    pupil: number;
    gilt: number;
  };
}

interface P {
  centre: [number, number];
  head: { cx: number; cy: number; rx: number; ry: number; bulgeX: number; bulgeRx: number; bulgeRy: number };
  mantle: { top: number; bottom: number; topR: number; bottomR: number; belly: number; hemScallops: number };
  eye: { x: number; y: number; r: number; socketR: number };
  core: { x: number; y: number; r: number };
  halo: {
    cx: number;
    cy: number;
    a: number;
    b: number;
    tilt: number;
    thickness: number;
    spokes: number;
    ticks: number;
  };
  seams: number;
  tendrils: { count: number; minLen: number; maxLen: number };
}

const params = (def: TitanDef): P => def.art.params as unknown as P;

const matId = (def: TitanDef, key: string): number => {
  const i = def.materials.findIndex((m) => m.key === key);
  if (i < 0) throw new Error(`lastone: material '${key}' missing`);
  return i + 1;
};

/** The silhouette functions and derived anchor geometry, shared by the painter and the fighter's rig. */
interface Layout {
  p: P;
  cx: number;
  cy: number;
  seed: number;
  sdBody(x: number, y: number): number;
  sdHalo(x: number, y: number): number;
  eyeX: number;
  eyeY: number;
  coreX: number;
  coreY: number;
  haloPts: { x: number; y: number }[];
}

function makeLayout(def: TitanDef, seed: number): Layout {
  const p = params(def);
  const rng = new Rng(seed ^ 0x1a57);
  const cx = p.centre[0];
  const cy = p.centre[1];
  const s1 = (seed & 0xffff) + 11;
  const s2 = ((seed >>> 8) & 0xffff) + 23;
  const m = p.mantle;

  const scallops: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < m.hemScallops; i++) {
    const t = (i + 0.5) / m.hemScallops - 0.5;
    scallops.push({
      x: cx - 6 + t * (m.bottomR * 2.0) + rng.range(-0.8, 0.8),
      y: cy + m.bottom + 1.2 + rng.range(-0.8, 0.8),
      r: rng.range(6, 7.4),
    });
  }

  // First pass silhouette (no chips) so chips can be placed exactly ON the outline.
  const base = (x: number, y: number): number => {
    const wx = x + fbm(x * 0.045, y * 0.045, s1, 3) * 3.0;
    const wy = y + fbm(x * 0.045 + 7.3, y * 0.045 - 2.1, s2, 3) * 3.0;
    const h = p.head;
    const head = sdEllipse(wx, wy, cx + h.cx, cy + h.cy, h.rx, h.ry);
    const bulge = sdEllipse(wx, wy, cx + h.cx + h.bulgeX, cy + h.cy + 1, h.bulgeRx, h.bulgeRy);
    let d = smin(head, bulge, 14);
    // bell mantle: tapered column cut flat at the hem
    const t = clamp01((wy - (cy + m.top)) / Math.max(1, m.bottom - m.top));
    const r = lerp(m.topR, m.bottomR, t) + m.belly * Math.sin(Math.PI * t);
    let bell = smax(Math.abs(wx - (cx - 3 - 2 * t)) - r, wy - (cy + m.bottom), 4);
    bell = smax(bell, cy + m.top - 8 - wy, 6);
    d = smin(d, bell, 15);
    // heavy brow above the eye
    d = smin(d, sdEllipse(wx, wy, cx + p.eye.x - 2, cy + p.eye.y - 27, 22, 9), 8);
    for (const s of scallops) d = ssub(d, sdCircle(wx, wy, s.x, s.y, s.r), 3);
    return d;
  };

  // Weathering chips: notches nibbled out of the outline (small, few: it is old, not ruined).
  const chips: { x: number; y: number; r: number }[] = [];
  const chipAngles = [-2.75, -2.3, -1.15, -0.55, 2.35, 2.85];
  for (const a0 of chipAngles) {
    const a = a0 + rng.range(-0.12, 0.12);
    const ox = cx - 2;
    const oy = cy - 4;
    let r = 10;
    while (r < 120 && base(ox + Math.cos(a) * r, oy + Math.sin(a) * r) < 0) r += 0.5;
    chips.push({ x: ox + Math.cos(a) * (r + 0.8), y: oy + Math.sin(a) * (r + 0.8), r: rng.range(2.6, 5.2) });
  }
  const sdBody = (x: number, y: number): number => {
    let d = base(x, y);
    for (const c of chips) d = ssub(d, sdCircle(x, y, c.x, c.y, c.r), 2.2);
    return d;
  };

  // halo: a tilted ring, centre-line points for spokes / ticks / gems
  const hp = p.halo;
  const hx = cx + hp.cx;
  const hy = cy + hp.cy;
  const haloPts: Layout['haloPts'] = [];
  const NP = 120;
  const c = Math.cos(hp.tilt);
  const sn = Math.sin(hp.tilt);
  for (let i = 0; i < NP; i++) {
    const a = (i / NP) * Math.PI * 2;
    const ex = Math.cos(a) * hp.a;
    const ey = Math.sin(a) * hp.b;
    haloPts.push({ x: hx + ex * c - ey * sn, y: hy + ex * sn + ey * c });
  }
  const sdHalo = (x: number, y: number): number =>
    Math.abs(sdEllipseRot(x, y, hx, hy, hp.a, hp.b, -hp.tilt)) - hp.thickness * 0.5;

  return {
    p,
    cx,
    cy,
    seed,
    sdBody,
    sdHalo,
    eyeX: cx + p.eye.x,
    eyeY: cy + p.eye.y,
    coreX: cx + p.core.x,
    coreY: cy + p.core.y,
    haloPts,
  };
}

/** Tendril roots: spread around the lower + back of the body (the "veil"), a few on the crown and front. */
function makeRoots(L: Layout): TendrilRoot[] {
  const { p } = L;
  const n = p.tendrils.count;
  const roots: TendrilRoot[] = [];
  const rng = new Rng(L.seed ^ 0x7e1d);
  const shape = new Rng(L.seed ^ 0x51c3);
  // path: front-lower → hem → back → crown, expressed as polar angles from a point below the head centre
  const ox = L.cx - 2;
  const oy = L.cy + 14;
  const a0 = 0.3;
  const a1 = 3.95;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const a = lerp(a0, a1, t) + rng.range(-0.04, 0.04);
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let r = 6;
    while (r < 120 && L.sdBody(ox + dx * r, oy + dy * r) < 0) r += 0.5;
    const x = ox + dx * (r - 2.2);
    const y = oy + dy * (r - 2.2);
    const e = 1.2;
    let nx = L.sdBody(x + e, y) - L.sdBody(x - e, y);
    let ny = L.sdBody(x, y + e) - L.sdBody(x, y - e);
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const kind: TendrilRoot['kind'] = t < 0.16 ? 'front' : t < 0.55 ? 'hem' : t < 0.86 ? 'back' : 'crown';
    const lenBase = kind === 'front' ? 0.45 : kind === 'crown' ? 0.5 : kind === 'hem' ? 0.85 : 0.72;
    // lengths vary a lot (and every third hem tendril is a long one) so the veil never reads as a comb of equal rods
    const longOne = kind === 'hem' && i % 3 === 1 ? 0.3 : 0;
    const len = clamp(
      lerp(p.tendrils.minLen, p.tendrils.maxLen, clamp01(lenBase * (0.3 + 0.8 * rng.next()) + longOne)),
      p.tendrils.minLen,
      p.tendrils.maxLen,
    );
    const phase = rng.next();
    const sign = shape.next() < 0.5 ? -1 : 1;
    const curl = sign * (kind === 'crown' ? shape.range(0.7, 1.3) : shape.range(0.3, 0.95));
    const wave = shape.range(0.12, 0.42);
    const wavePh = shape.range(0, Math.PI * 2);
    roots.push({ x, y, nx, ny, len, phase, kind, curl, wave, wavePh });
  }
  return roots;
}

export function buildLastOneRig(def: TitanDef, seed: number): LastOneRig {
  const L = makeLayout(def, seed);
  const p = L.p;
  return {
    eye: { x: L.eyeX, y: L.eyeY, r: p.eye.r, socketR: p.eye.socketR },
    core: { x: L.coreX, y: L.coreY, r: p.core.r },
    halo: { cx: L.cx + p.halo.cx, cy: L.cy + p.halo.cy, a: p.halo.a, b: p.halo.b, tilt: p.halo.tilt },
    roots: makeRoots(L),
    ids: {
      shell: matId(def, 'shell'),
      seam: matId(def, 'seam'),
      inner: matId(def, 'inner'),
      core: matId(def, 'core'),
      eye: matId(def, 'eye'),
      iris: matId(def, 'iris'),
      pupil: matId(def, 'pupil'),
      gilt: matId(def, 'gilt'),
    },
  };
}

const angDiff = (a: number, b: number): number => {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/** Pick `count` spoke attachment points on the halo ring: those closest to the body, spread apart. */
function pickSpokes(L: Layout, count: number): { x: number; y: number; ex: number; ey: number }[] {
  const { p } = L;
  const cands: { x: number; y: number; d: number; i: number }[] = [];
  for (let i = 0; i < L.haloPts.length; i++) {
    const pt = L.haloPts[i]!;
    const d = L.sdBody(pt.x, pt.y);
    if (d > 3 && d < 34) cands.push({ x: pt.x, y: pt.y, d, i });
  }
  cands.sort((a, b) => a.d - b.d || a.i - b.i);
  const chosen: typeof cands = [];
  for (const c of cands) {
    if (chosen.length >= count) break;
    if (chosen.every((q) => Math.hypot(q.x - c.x, q.y - c.y) > 22)) chosen.push(c);
  }
  const tx = L.cx + p.head.cx - 4;
  const ty = L.cy + p.head.cy;
  return chosen.map((c) => {
    const dx = tx - c.x;
    const dy = ty - c.y;
    const dl = Math.hypot(dx, dy);
    let t = 0;
    while (t < dl && L.sdBody(c.x + (dx / dl) * t, c.y + (dy / dl) * t) > -2.6) t += 0.5;
    return { x: c.x, y: c.y, ex: c.x + (dx / dl) * t, ey: c.y + (dy / dl) * t };
  });
}

export function paintLastOne(
  def: TitanDef,
  seed: number,
  lighting: StageLighting,
): { map: MatterMap; rig: LastOneRig } {
  const L = makeLayout(def, seed);
  const rig = buildLastOneRig(def, seed);
  const { p } = L;
  const ids = rig.ids;
  const W = def.art.w;
  const H = def.art.h;
  const cv = new ArtCanvas(W, H);
  const sA = (seed & 0xfff) + 101;
  const sB = ((seed >>> 12) & 0xfff) + 211;
  const hp = p.halo;

  // ---------- 1. silhouettes ----------
  const bodyMask = new Uint8Array(W * H);
  const haloMask = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (L.sdBody(x + 0.5, y + 0.5) < 0) bodyMask[i] = 1;
      if (L.sdHalo(x + 0.5, y + 0.5) < 0) haloMask[i] = 1;
    }
  }
  const spokeMask = new Uint8Array(W * H);
  for (const sp of pickSpokes(L, hp.spokes)) {
    const x0 = Math.floor(Math.min(sp.x, sp.ex)) - 3;
    const x1 = Math.ceil(Math.max(sp.x, sp.ex)) + 3;
    const y0 = Math.floor(Math.min(sp.y, sp.ey)) - 3;
    const y1 = Math.ceil(Math.max(sp.y, sp.ey)) + 3;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        if (sdSegment(x + 0.5, y + 0.5, sp.x, sp.y, sp.ex, sp.ey) < 1.35) spokeMask[y * W + x] = 1;
  }

  const dBody = edt(bodyMask, W, H, false);
  const worleyOut = makeWorley();
  const ex0 = L.eyeX;
  const ey0 = L.eyeY;
  const eyeR = p.eye.r;
  const sockR = p.eye.socketR;

  // ---------- 2. materials, relief, tone ----------
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const fx = x + 0.5;
      const fy = y + 0.5;
      const inBody = bodyMask[i] === 1;
      const inHalo = haloMask[i] === 1 || spokeMask[i] === 1;
      if (!inBody && !inHalo) continue;

      if (!inBody) {
        // halo ring / spokes (gilt)
        cv.mat[i] = ids.gilt;
        const t = clamp01((L.sdHalo(fx, fy) + hp.thickness * 0.5) / hp.thickness);
        cv.relief[i] =
          haloMask[i] === 0 ? 1.6 : 3.2 * Math.sqrt(Math.max(0, 1 - (2 * t - 1) * (2 * t - 1))) + 0.6;
        cv.tone[i] = (hash01(x, y, sA) - 0.5) * 0.6;
        continue;
      }

      const d = dBody[i]!;
      const dx = fx - ex0;
      const dy = fy - ey0;
      const rho = Math.hypot(dx, dy);
      const th = Math.atan2(dy, dx);

      // layer depth: glaze shell over crystalline lattice
      const isMantle = fy > L.cy + p.mantle.top - 6 && fy > ey0 + 24;
      const cdx0 = fx - L.coreX;
      const cdy0 = fy - L.coreY;
      const cr0 = Math.hypot(cdx0, cdy0);
      // glaze thickness: thick on the head, thinner on the robe, always thinning toward the lantern so the lattice shows there
      const shellT =
        (isMantle ? 5 : 11) * (0.55 + 0.45 * smoothstep(8, 34, cr0)) + fbm(fx * 0.1, fy * 0.1, sA, 2) * 2.2;
      let m = d < shellT ? ids.shell : ids.inner;

      // relief: dome + weathering
      const dome = 17 * Math.sqrt(clamp01(d / 27));
      let rel = dome + fbm(fx * 0.07, fy * 0.07, sB, 3) * 1.5;
      // tone: mottled patina (blue-green) with a fine grain
      let tone =
        fbm(fx * 0.045, fy * 0.045, sA + 3, 3) * 1.1 +
        Math.max(0, fbm(fx * 0.09, fy * 0.09, sB + 8, 2) - 0.25) * 2.2 +
        (hash01(x, y, sB) - 0.5) * 0.3;

      // ---- radial "petal" seams around the socket + concentric plate arcs ----
      if (m === ids.shell && rho > sockR + 1.5) {
        const step = (Math.PI * 2) / p.seams;
        const warpA =
          0.28 * Math.sin(rho / 15 + (L.seed & 255) * 0.05) + 0.16 * fbm(fx * 0.04, fy * 0.04, sA + 9, 2);
        const k = Math.round((th - warpA) / step);
        const perp = Math.abs(angDiff(th - warpA, k * step)) * rho;
        if (perp < 0.62 && hash01(k + 40, Math.floor(rho / 9), sA) > 0.12) {
          m = ids.seam;
          rel -= 1.4;
        }
        for (const rr of [39, 54, 70]) {
          const dr = Math.abs(rho - (rr + 2.5 * Math.sin(th * 3 + rr)));
          if (dr < 0.6 && hash01(Math.floor(th * 6 + rr), rr, sB) > 0.35) {
            m = ids.seam;
            rel -= 1.1;
          }
        }
      }
      // ---- craquelure: sparse glaze crackle near the surface ----
      if (m === ids.shell && d > 1.5) {
        worley(fx / 10.5, fy / 10.5, sA + 5, worleyOut, 0.85);
        const edge = (worleyOut.f2 - worleyOut.f1) * 10.5;
        const patch = fbm(fx * 0.03, fy * 0.03, sB + 2, 2);
        if (edge < 0.8 && patch > -0.05) {
          tone -= 0.95;
          rel -= 0.5;
        }
      }
      // ---- lattice interior: facets, dark fault ribs, warm light bleeding from the core ----
      const cdx = fx - L.coreX;
      const cdy = fy - L.coreY;
      const cr = Math.hypot(cdx, cdy);
      if (m === ids.inner) {
        const cth = Math.atan2(cdy, cdx);
        const nRib = 7;
        const step = (Math.PI * 2) / nRib;
        const wob = 0.3 * Math.sin(cr / 11);
        const kk = Math.round((cth + wob) / step);
        const perp = Math.abs(angDiff(cth + wob, kk * step)) * cr;
        if (cr > p.core.r + 3 && perp < 0.6 && hash01(kk + 9, Math.floor(cr / 7), sA) > 0.28) {
          m = ids.seam;
          rel -= 0.8;
        }
        worley(fx / 6.5, fy / 6.5, sB + 17, worleyOut, 0.8);
        tone += (worleyOut.id - 0.5) * 1.4;
        if ((worleyOut.f2 - worleyOut.f1) * 6.5 < 0.7) tone -= 1.1;
      }

      // ---- socket: bevelled lip, gilt inlay ring, the eye ----
      if (rho < sockR + 4) {
        const lip = smoothstep(sockR + 4, sockR - 1, rho);
        rel += 5.5 * lip * (rho > eyeR - 1 ? 1 : 0.4);
        if (
          rho > eyeR + 0.5 &&
          rho < sockR + 0.5 &&
          rho >= sockR - 1.1 &&
          hash01(Math.floor(th * 14), 3, sA) > 0.22
        )
          m = ids.gilt;
        if (rho <= eyeR + 0.5) {
          const q = rho / eyeR;
          const upper = sdCircle(fx, fy, ex0, ey0 + 9.5, eyeR * 1.075);
          const lower = sdCircle(fx, fy, ex0, ey0 - 10.5, eyeR * 1.075);
          if (upper > 0 || lower > 0) {
            m = ids.shell;
            rel = 12 + 3 * (1 - q) + (upper > 0 ? 2.2 : 0);
            tone += 0.2;
          } else {
            rel = 9 + 7.5 * (1 - q * q);
            m = q > 0.66 ? ids.eye : q > 0.29 ? ids.iris : ids.pupil;
            if (m === ids.eye) tone = 0.6 - (q - 0.66) * 3;
          }
        }
      }

      // ---- the core: a golden lantern-heart ----
      const wobble = fbm(fx * 0.2, fy * 0.2, sA + 1, 2) * 1.2;
      if (m !== ids.eye && m !== ids.iris && m !== ids.pupil && cr < p.core.r + wobble) {
        m = ids.core;
        rel = 8 + 4 * (1 - cr / p.core.r);
      }

      // robe: drapery pleats fanning from the neck, and a gilt collar
      if (isMantle && m !== ids.core) {
        const nx0 = L.cx - 3;
        const ny0 = L.cy + p.mantle.top;
        const pa = Math.atan2(fy - ny0, fx - nx0);
        const pr = Math.hypot(fx - nx0, fy - ny0);
        const fold = Math.sin(pa * 11 + fbm(fx * 0.05, fy * 0.05, sB + 5, 2) * 1.4);
        rel += fold * 1.5 * smoothstep(6, 20, pr);
        tone += fold * 0.55;
        if (m === ids.shell || m === ids.inner) {
          const kk = Math.round(pa / 0.2);
          if (pr > 14 && Math.abs(angDiff(pa, kk * 0.2)) * pr < 0.55 && hash01(kk, 5, sA) > 0.35) {
            m = ids.seam;
            rel -= 0.9;
          }
        }
      }
      {
        // collar: a hanging U of gilt beads at the neck
        const xc = L.cx - 3;
        const u = (fx - xc) / (p.mantle.topR + 2);
        const yc = L.cy + p.mantle.top + 7 + 7 * (1 - u * u);
        if (Math.abs(u) < 1 && Math.abs(fy - yc) < 1.7 && m !== ids.core) {
          m = ids.gilt;
          rel += 2.2;
        }
      }

      cv.mat[i] = m;
      cv.relief[i] = Math.max(0.2, rel);
      cv.tone[i] = tone;
    }
  }
  cv.invalidate();

  // ---------- 3. shade ----------
  const ramps = buildLitRamps(def.materials, lighting, 0.85);
  const shade: (Partial<ShadeParams> | undefined)[] = [];
  shade[ids.shell] = { contrast: 1.2, dither: 0.5, ao: 0.8 };
  shade[ids.seam] = { contrast: 1.1, dither: 0.35, rim: 0.5 };
  shade[ids.inner] = { contrast: 1.25, dither: 0.6, ao: 0.9, bayer8: true };
  shade[ids.gilt] = { contrast: 1.35, dither: 0.3, rim: 0 };
  shade[ids.eye] = { contrast: 1.1, dither: 0.4 };
  shade[ids.iris] = { contrast: 1.0, dither: 0.4 };
  const colors = cv.render({ ramps, params: shade, lighting });

  // ---------- 4. hand-painted parts ----------
  bleedCoreLight(cv, colors, L, ids);
  paintEye(cv, colors, L, def, lighting, ids);
  paintCore(cv, colors, L, def, ids);
  paintHaloDetail(cv, colors, L, def, ids, seed);

  // studs, gems and spokes must never leave a stray island: keep the single connected body
  keepLargestComponent(cv.mat, W, H);
  const map = createMatterMap(W, H);
  cv.writeTo(map, colors, (m) => (m === ids.core ? 170 : m === ids.inner ? 118 : m === ids.gilt ? 150 : 128));
  map.coreX = Math.round(L.coreX);
  map.coreY = Math.round(L.coreY);
  map.coreRadius = p.core.r;
  return { map, rig };
}

/** Warm light leaking from the core through the glaze: quantised to three tints so the palette stays clean. */
function bleedCoreLight(cv: ArtCanvas, colors: Uint32Array, L: Layout, ids: LastOneRig['ids']): void {
  const W = cv.w;
  const warm = hex('#ffd98a');
  const R = L.p.core.r;
  for (let y = Math.floor(L.coreY - R - 26); y <= Math.ceil(L.coreY + R + 26); y++) {
    for (let x = Math.floor(L.coreX - R - 26); x <= Math.ceil(L.coreX + R + 26); x++) {
      const i = y * W + x;
      const m = cv.mat[i];
      if (m !== ids.inner && m !== ids.shell && m !== ids.seam) continue;
      const r = Math.hypot(x + 0.5 - L.coreX, y + 0.5 - L.coreY) - R;
      if (r <= 0) continue;
      const k = Math.exp(-(r * r) / 150) * (m === ids.shell ? 0.4 : 0.7);
      const lv = k * 4.2;
      const fl = Math.floor(lv);
      const level = fl + (lv - fl > bayer8(x, y) ? 1 : 0);
      const q = level >= 3 ? 0.5 : level === 2 ? 0.32 : level === 1 ? 0.16 : 0;
      if (q > 0) colors[i] = blend(colors[i]!, warm, q);
    }
  }
}

function paintEye(
  cv: ArtCanvas,
  colors: Uint32Array,
  L: Layout,
  def: TitanDef,
  lighting: StageLighting,
  ids: LastOneRig['ids'],
): void {
  const { p } = L;
  const W = cv.w;
  const ex = L.eyeX;
  const ey = L.eyeY;
  const R = p.eye.r;
  const key = hex(lighting.color);
  const iris = def.materials[ids.iris - 1]!.visual.ramp.map(hex);
  const eyeRamp = def.materials[ids.eye - 1]!.visual.ramp.map(hex);
  const pupilRamp = def.materials[ids.pupil - 1]!.visual.ramp.map(hex);
  const gold = hex('#e8c15a');
  const goldHi = hex('#fff0a8');
  for (let y = Math.floor(ey - R - 2); y <= Math.ceil(ey + R + 2); y++) {
    for (let x = Math.floor(ex - R - 2); x <= Math.ceil(ex + R + 2); x++) {
      const i = y * W + x;
      const m = cv.mat[i]!;
      if (m !== ids.eye && m !== ids.iris && m !== ids.pupil) continue;
      const dx = x + 0.5 - ex;
      const dy = y + 0.5 - ey;
      const q = Math.hypot(dx, dy) / R;
      const th = Math.atan2(dy, dx);
      let c: number;
      if (m === ids.eye) {
        // sclera: pale bone-jade, shaded toward the lids
        const shade = clamp01(0.7 - (q - 0.66) * 1.1 - (dy < 0 ? (-dy / R) * 0.3 : 0));
        const k = clamp(Math.round(2.2 + shade * 3.4), 2, 5);
        c = eyeRamp[hash01(Math.floor(x / 2), Math.floor(y / 2), 77) > 0.9 ? Math.max(0, k - 1) : k]!;
      } else if (m === ids.pupil) {
        c = pupilRamp[q < 0.16 ? 0 : q < 0.24 ? 1 : 2]!;
      } else if (q > 0.6) {
        c = iris[1]!; // limbal ring, deep teal
      } else {
        // iris: radial fibres, teal → jade → gold near the pupil, lit from within on the lower half
        const t = (q - 0.29) / (0.6 - 0.29);
        const fibre = ridged(th * 4.2 + 3, q * 6, 991, 2);
        const fleck = hash01(Math.floor(th * 9), Math.floor(q * 12), 313) > 0.86;
        const k = clamp(5 - t * 3.6 + (fibre - 0.5) * 1.6 + (dy > 0 ? 0.6 : -0.5), 1, 6);
        c = iris[Math.round(k)]!;
        if (t < 0.28) c = blend(c, gold, 0.75 - t * 1.5);
        if (fleck && t < 0.75 && t > 0.15) c = blend(c, goldHi, 0.65);
      }
      if (dx + dy < -R * 0.5 && q < 0.9) c = blend(c, key, 0.1);
      colors[i] = c;
    }
  }
  const hl = (ox: number, oy: number, w: number, h: number, col: number): void => {
    for (let yy = 0; yy < h; yy++)
      for (let xx = 0; xx < w; xx++) {
        const i = Math.round(ey + oy + yy) * W + Math.round(ex + ox + xx);
        if (cv.mat[i] === ids.iris || cv.mat[i] === ids.pupil || cv.mat[i] === ids.eye) colors[i] = col;
      }
  };
  const white = rgba(255, 252, 236);
  hl(-8, -8, 3, 2, white);
  hl(-9, -6, 1, 1, white);
  hl(-6, -9, 2, 1, white);
  hl(6, 6, 2, 1, blend(white, iris[5]!, 0.45));
  hl(5, 7, 1, 1, blend(white, iris[5]!, 0.45));
  // the upper lid throws a shadow line onto the eyeball
  for (let x = Math.floor(ex - R); x <= Math.ceil(ex + R); x++) {
    for (let y = Math.floor(ey - R); y <= ey; y++) {
      const i = y * W + x;
      if (cv.mat[i] !== ids.eye && cv.mat[i] !== ids.iris) continue;
      if (cv.mat[(y - 1) * W + x] === ids.shell) colors[i] = blend(colors[i]!, iris[0]!, 0.7);
    }
  }
}

function paintCore(
  cv: ArtCanvas,
  colors: Uint32Array,
  L: Layout,
  def: TitanDef,
  ids: LastOneRig['ids'],
): void {
  const { p } = L;
  const W = cv.w;
  const ramp = def.materials[ids.core - 1]!.visual.ramp.map(hex);
  for (let y = Math.floor(L.coreY - p.core.r - 3); y <= Math.ceil(L.coreY + p.core.r + 3); y++) {
    for (let x = Math.floor(L.coreX - p.core.r - 3); x <= Math.ceil(L.coreX + p.core.r + 3); x++) {
      const i = y * W + x;
      if (cv.mat[i] !== ids.core) continue;
      const r = Math.hypot(x + 0.5 - L.coreX, y + 0.5 - L.coreY) / p.core.r;
      const sw = 0.5 + 0.5 * Math.sin(Math.atan2(y - L.coreY, x - L.coreX) * 3 + r * 5);
      const k = clamp(6.4 - r * 3.4 + (sw - 0.5) * 0.8, 1.6, 5);
      const fl = Math.floor(k);
      const th = ((x & 1) * 2 + (y & 1) * 3 + ((x + y) & 3)) / 8;
      colors[i] = ramp[Math.min(5, fl + (k - fl > th ? 1 : 0))]!;
    }
  }
}

function paintHaloDetail(
  cv: ArtCanvas,
  colors: Uint32Array,
  L: Layout,
  def: TitanDef,
  ids: LastOneRig['ids'],
  seed: number,
): void {
  const { p } = L;
  const W = cv.w;
  const hp = p.halo;
  const gilt = def.materials[ids.gilt - 1]!.visual.ramp.map(hex);
  const jade = hex('#66c9a2');
  const jadeHi = hex('#d8ffe4');
  const jadeDk = hex('#12404a');
  // tick marks: notches along the ring (an astrolabe rim); every 4th is a raised stud
  const n = hp.ticks;
  for (let k = 0; k < n; k++) {
    const idx = Math.floor((k / n) * L.haloPts.length);
    const a = L.haloPts[idx]!;
    const b = L.haloPts[(idx + 1) % L.haloPts.length]!;
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const nx = -ty;
    const ny = tx;
    const big = k % 4 === 0;
    for (let s = -1; s <= 1; s++) {
      for (let o = -3; o <= 3; o++) {
        const px = Math.round(a.x + tx * s + nx * o);
        const py = Math.round(a.y + ty * s + ny * o);
        const i = py * W + px;
        if (cv.mat[i] === ids.gilt) {
          const edge = Math.abs(o);
          colors[i] = big && edge <= 1 ? blend(gilt[4]!, gilt[5]!, 0.5) : edge >= 2 ? gilt[1]! : gilt[3]!;
        } else if (cv.mat[i] === 0 && big && Math.abs(o) === 3 && s === 0) {
          cv.mat[i] = ids.gilt;
          cv.relief[i] = 1.2;
          colors[i] = gilt[2]!;
        }
      }
    }
  }
  // jade gems set in the ring
  const rng = new Rng(seed);
  for (let g = 0; g < 4; g++) {
    const idx =
      (Math.floor(((g + 0.5) / 4) * L.haloPts.length + rng.range(-2, 2)) + L.haloPts.length) %
      L.haloPts.length;
    const c = L.haloPts[idx]!;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const r2 = dx * dx + dy * dy;
        if (r2 > 5) continue;
        const i = Math.round(c.y + dy) * W + Math.round(c.x + dx);
        if (cv.mat[i] === 0) {
          cv.mat[i] = ids.gilt;
          cv.relief[i] = 2;
        }
        colors[i] = r2 >= 4 ? gilt[2]! : dx + dy < 0 ? jadeHi : dx + dy > 1 ? jadeDk : jade;
      }
    }
  }
}

/* ================================================================================================================== *
 *  THE WITNESS — painter v1 (rest pose; not yet wired into the game, see docs/briefs/witness-art-notes.md)
 *
 *  A colossal sacred witness that HANGS: the crosshair sigil and a large broken halo above, the planet-scale eye in its
 *  cracked jade-black carapace in the middle, a chandelier of bone and gold spires below, and four asymmetric scythe
 *  architectures sweeping down and around. Painted as SEPARATE region maps (one matter body per rigid region, D27), each
 *  with its own frame pivot and parent for the XPBD rig:
 *
 *    eye cradle (root, the KO core) → carapace → [channels, lattice, abyss] (welded interior layers, behind the carapace)
 *                                              → shrine
 *                                              → arm k segment 0 → 1 → …      (k = 0..3; 3, 4, 2 and 3 segments)
 *    eye cradle → halo arc 0..3 (each orbits the eye on its own; arc 2 sits a little out of phase)
 *
 *  The four reveal layers are stacked bodies at the same place: the carapace in front, then the luminous cyan-white
 *  tension channels (a sparse network), the gold sacred-geometry lattice (sparse), and the abyss (a full back wall with
 *  star specks and closed inner eyes). A hole in a front layer shows the next one behind it.
 *
 *  Wrong at the second glance: the pupil sits off-centre and is not quite round, a few hairline fractures glow cyan as if
 *  something inside were looking out, the orb-eyes on the arm joints are dormant but not quite closed, the arms differ in
 *  length and joint count, two spires have snapped, one halo arc drifts out of phase.
 *
 *  Body coordinates: origin = the eye's centre, +x = facing (right), +y down, px. The palette is three ramps (jade,
 *  bone, dead gold) plus emissives (cyan channels, white-gold lattice, abyss, stars); wound light is white-gold and cyan,
 *  never red or orange (crack and heat-glow colours included).
 * ================================================================================================================== */

// art v3: the base is deep teal and dark bronze (no green); celadon appears only in the top highlight step
const W_JADE = ['#05080b', '#0a141a', '#10212a', '#183139', '#22434b', '#31595d', '#5d8a80'];
const W_BONE = ['#2c2820', '#4d4638', '#7a7058', '#a69c7f', '#cdc5a8', '#ece6d0'];
const W_GOLD = ['#211a10', '#3d3018', '#5f4c24', '#857034', '#a89048', '#c8b068'];
const W_CYAN = ['#1d4c55', '#3d8d96', '#7fd2d6', '#cdf6f2', '#f6fffd'];
const W_WHITEGOLD = ['#6b5426', '#a88a44', '#e2c77e', '#fff1c9'];
const W_ABYSS = ['#030409', '#080a14', '#10122a', '#1a1c3a'];
const W_IRIS = ['#14302c', '#2c5a50', '#56877a', '#8fae8c', '#b49a52', '#d8bb6a'];
/** Wound light: what cracks and heat show on every Witness material (white-gold and cyan). */
const W_GLOW = ['#3d8d96', '#7fd2d6', '#e2f6e6', '#fff1c9', '#ffffff'];
const W_RESIST = { FRACTURE: 1.1, KINETIC: 1, CRUSH: 1, THERMAL: 1.4, ASSIMILATION: 0.3, TIDAL: 0.9 };

const wmat = (
  key: string,
  base: string,
  ramp: string[],
  emissive: number,
  crack: string,
  physics: MaterialSpec['physics'] = {},
): MaterialSpec => ({
  key,
  base,
  physics: { ...physics, resist: W_RESIST },
  visual: {
    ramp,
    emissive,
    glowRamp: W_GLOW,
    char: ramp[1]!,
    crack,
    debris: ramp[Math.floor(ramp.length / 2)]!,
  },
});

/** The Witness's materials (Phase 2 moves them into `lastone.json`; ids are index + 1, as for every titan). */
export const WITNESS_MATERIALS: readonly MaterialSpec[] = Object.freeze([
  wmat('carapace', 'celadon', W_JADE, 0, '#5fc4c8'),
  wmat('vein', 'celadon', W_JADE.slice(3), 12, '#a6eef0', { bond: 46, toughness: 0.15 }),
  wmat('channel', 'crystal', W_CYAN, 170, '#f6fffd'),
  wmat('lattice', 'lattice', W_WHITEGOLD, 90, '#fff1c9'),
  wmat('abyss', 'glass', W_ABYSS, 0, '#7fd2d6'),
  wmat('star', 'glass', ['#7fd2d6', '#e9fbff', '#ffffff'], 210, '#ffffff'),
  // art v3: the eye is crisp, not a lamp (the post bloom washed the iris out at 22 / 70)
  wmat('sclera', 'eye', W_BONE.slice(2), 6, '#5fc4c8'),
  wmat('iris', 'eye', W_IRIS, 24, '#e2c77e'),
  wmat('pupil', 'eye', ['#010205', '#04060c', '#090c18'], 0, '#7fd2d6'),
  wmat('gold', 'glass', W_GOLD, 30, '#fff1c9'),
  wmat('bronze', 'ironNickel', W_GOLD.slice(0, 5), 0, '#e2c77e'),
  wmat('bone', 'crystal', W_BONE, 0, '#7fd2d6'),
  wmat('membrane', 'tendril', W_JADE.slice(2), 40, '#a6eef0'),
  wmat('orb', 'eye', W_GOLD.slice(1), 16, '#fff1c9'),
  wmat('hairline', 'celadon', W_CYAN.slice(1), 120, '#f6fffd', { bond: 46, toughness: 0.15 }),
]);

const WID = (key: string): number => {
  const i = WITNESS_MATERIALS.findIndex((m) => m.key === key);
  if (i < 0) throw new Error(`witness: material '${key}' missing`);
  return i + 1;
};

export type WitnessRegionKind = 'eye' | 'carapace' | 'interior' | 'mantle' | 'shrine' | 'halo' | 'arm';

export interface WitnessRegion {
  key: string;
  kind: WitnessRegionKind;
  /** The region's own matter map (one body). `coreX/coreY` is its connectivity anchor (always on matter). */
  map: MatterMap;
  /** Body coordinates of map cell (0, 0)'s corner: cell (x, y) covers [ox + x, ox + x + 1) × [oy + y, oy + y + 1). */
  ox: number;
  oy: number;
  /** Frame origin (the rig body's pivot) in body coordinates at rest. It may lie off the region's matter (halo arcs orbit the eye). */
  pivotX: number;
  pivotY: number;
  /** Parent region index (−1 = the root: the eye, driven by intent). */
  parent: number;
  /** Interior layers move rigidly with their parent (one rig body, several matter bodies). */
  weld: boolean;
  /** Reveal layer for the carapace stack: 0 carapace, 1 channels, 2 lattice, 3 abyss; −1 elsewhere. */
  layer: number;
  /** Draw order, back to front. */
  z: number;
  /** Arm index and segment for arm regions (−1 otherwise). */
  arm: number;
  segment: number;
}

/** A point attached to a region, in body coordinates at rest (convert to the region's frame with its pivot). */
export interface WitnessAnchor {
  region: number;
  x: number;
  y: number;
}

/** An arm's joint chain at rest: the joints (segment starts) and the blade tip, with the region of each segment. */
export interface WitnessArm {
  regions: number[];
  /** Joint points (segment starts) then the tip; length = regions.length + 1. */
  points: { x: number; y: number }[];
  /** Spine and blade half-widths (px) at the root, for the runtime arm renderer. */
  width: number;
  /** +1 / −1: the blade (membrane) side relative to the root → tip direction. */
  bladeSide: number;
}

export interface WitnessBody {
  regions: WitnessRegion[];
  materials: readonly MaterialSpec[];
  arms: WitnessArm[];
  /** Tension membranes (dithered opaque triangles between three anchors) and luminous fibres (two anchors). */
  membranes: [WitnessAnchor, WitnessAnchor, WitnessAnchor][];
  fibres: [WitnessAnchor, WitnessAnchor][];
  /** Live extent in body coordinates (px). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cells: number;
}

/** Shape constants (body px). */
const WE = {
  eyeR: 34,
  rimR: 39,
  /** The burning socket ring's crystal teeth reach out to here. */
  teethR: 43.5,
  socketR: 38,
  carCX: 0,
  carCY: 4,
  carR: 58,
  /** The dark mantle behind the head that the arms grow out of (half-axes). */
  mantleRX: 74,
  mantleRY: 62,
  haloR: 100,
  haloT: 3.5,
  shrineY: 54,
  /** The pupil is not quite centred and not quite round (it tracks at runtime). */
  pupilDX: 2.5,
  pupilDY: 1.5,
};

/**
 * Halo arcs: span (degrees, y down: −90 = straight up) and a radius offset: THREE broken rings (−8, 0, +8 px). The long top
 * arc of the middle ring carries the crosshair sigil; the rest are pieces of the inner and outer rings, with wide gaps.
 */
const HALO_ARCS: readonly [number, number, number][] = [
  [-150, -28, 0],
  [-16, 44, -8],
  [-64, -22, 8],
  [134, 196, -8],
  [160, 226, 8],
];

interface ArmDef {
  /** Cubic Bézier control points (body px). */
  c: readonly number[];
  /** Arc-length fractions where segments start (the first is 0). */
  joints: readonly number[];
  /** Width scale. */
  w: number;
}

/**
 * Six broad crescent limbs, three per side, growing out of the mantle and sweeping out and down (art v3, WJ's reference):
 * an upper pair that arches over the halo, a middle pair, a lower pair that hangs past the spires. Right side first in each
 * pair (arms 0, 2, 4 are the right side). Not mirror images: the left arms are a little shorter or held differently.
 * Two rigid pieces per arm.
 */
const ARMS: readonly ArmDef[] = [
  { c: [40, -34, 80, -122, 160, -112, 178, -54], joints: [0, 0.5], w: 1.15 },
  { c: [-40, -30, -86, -114, -166, -98, -180, -40], joints: [0, 0.48], w: 1.1 },
  { c: [52, 2, 110, -30, 172, -12, 152, 42], joints: [0, 0.5], w: 1.0 },
  { c: [-50, 6, -104, -22, -164, 6, -146, 54], joints: [0, 0.52], w: 0.95 },
  { c: [38, 44, 84, 70, 142, 96, 124, 128], joints: [0, 0.5], w: 0.95 },
  { c: [-34, 46, -74, 78, -128, 110, -104, 132], joints: [0, 0.5], w: 0.9 },
];

interface RegionCanvas {
  cv: ArtCanvas;
  ox: number;
  oy: number;
}

function regionCanvas(x0: number, y0: number, x1: number, y1: number): RegionCanvas {
  const ox = Math.floor(x0) - 3;
  const oy = Math.floor(y0) - 3;
  const w = Math.ceil(x1) - ox + 4;
  const h = Math.ceil(y1) - oy + 4;
  return { cv: new ArtCanvas(w, h), ox, oy };
}

/** Shading per Witness material (low relief on the parts that rotate a lot, so baked light stays plausible). */
function witnessShade(): (Partial<ShadeParams> | undefined)[] {
  const s: (Partial<ShadeParams> | undefined)[] = [];
  s[WID('carapace')] = { contrast: 1.25, bias: -0.1, dither: 0.35, ao: 0.6, rim: 0.3 };
  s[WID('vein')] = { contrast: 1.0, dither: 0.2, rim: 0.2, outline: 0 };
  s[WID('hairline')] = { contrast: 0.6, dither: 0.2, rim: 0, outline: 0 };
  s[WID('channel')] = { contrast: 0.8, dither: 0.2, rim: 0, outline: 0.3 };
  s[WID('lattice')] = { contrast: 1.0, dither: 0.25, rim: 0, outline: 0.3 };
  s[WID('abyss')] = { contrast: 0.5, dither: 0.8, rim: 0, outline: 0.4, bayer8: true };
  s[WID('star')] = { contrast: 0.6, rim: 0, outline: 0 };
  s[WID('gold')] = { contrast: 1.3, dither: 0.3, rim: 0.25 };
  s[WID('bronze')] = { contrast: 1.35, dither: 0.3, rim: 0.2 };
  s[WID('bone')] = { contrast: 1.15, dither: 0.35, rim: 0.15, bump: 0.7 };
  s[WID('membrane')] = { contrast: 0.9, dither: 0.7, rim: 0.2, bayer8: true, bump: 0.5 };
  s[WID('orb')] = { contrast: 1.3, dither: 0.2, rim: 0.3 };
  return s;
}

/** Turn a painted canvas into a region (largest connected piece only, so every region body is one piece). */
function finishRegion(
  rc: RegionCanvas,
  ramps: number[][],
  lighting: StageLighting,
  over: ((colors: Uint32Array, cv: ArtCanvas, ox: number, oy: number) => void) | null,
  anchorX: number,
  anchorY: number,
  coreR: number,
  meta: Omit<WitnessRegion, 'map' | 'ox' | 'oy'>,
): WitnessRegion {
  const { cv, ox, oy } = rc;
  keepLargestComponent(cv.mat, cv.w, cv.h);
  cv.invalidate();
  const colors = cv.render({ ramps, params: witnessShade(), lighting, rimMix: 0.12 });
  if (over) over(colors, cv, ox, oy);
  const map = createMatterMap(cv.w, cv.h);
  const ids = {
    lat: WID('lattice'),
    ch: WID('channel'),
    star: WID('star'),
    gold: WID('gold'),
    bronze: WID('bronze'),
  };
  cv.writeTo(map, colors, (m) =>
    m === ids.ch || m === ids.lat || m === ids.star ? 110 : m === ids.gold || m === ids.bronze ? 150 : 128,
  );
  // connectivity anchor: the live cell nearest the requested point
  let best = -1;
  let bd = Infinity;
  for (let y = 0; y < cv.h; y++)
    for (let x = 0; x < cv.w; x++) {
      if (cv.mat[y * cv.w + x] === 0) continue;
      const d = (x + ox + 0.5 - anchorX) ** 2 + (y + oy + 0.5 - anchorY) ** 2;
      if (d < bd) {
        bd = d;
        best = y * cv.w + x;
      }
    }
  map.coreX = best % cv.w;
  map.coreY = (best / cv.w) | 0;
  map.coreRadius = coreR;
  return { ...meta, map, ox, oy };
}

/** Points along a cubic Bézier with cumulative arc length (normalised 0..1). */
function bezierSamples(
  c: readonly number[],
  n: number,
): { x: Float64Array; y: Float64Array; s: Float64Array } {
  const x = new Float64Array(n + 1);
  const y = new Float64Array(n + 1);
  const s = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = (1 - t) ** 3;
    const b = 3 * (1 - t) ** 2 * t;
    const cc = 3 * (1 - t) * t * t;
    const d = t ** 3;
    x[i] = a * c[0]! + b * c[2]! + cc * c[4]! + d * c[6]!;
    y[i] = a * c[1]! + b * c[3]! + cc * c[5]! + d * c[7]!;
    if (i > 0) s[i] = s[i - 1]! + Math.hypot(x[i]! - x[i - 1]!, y[i]! - y[i - 1]!);
  }
  const L = s[n]!;
  for (let i = 0; i <= n; i++) s[i] = s[i]! / L;
  return { x, y, s };
}

/** The point at arc-length fraction u of a sampled curve. */
function samplesAt(
  S: { x: Float64Array; y: Float64Array; s: Float64Array },
  u: number,
): { x: number; y: number } {
  const n = S.s.length - 1;
  let k = 0;
  while (k < n && S.s[k + 1]! < u) k++;
  return { x: S.x[k]!, y: S.y[k]! };
}

/**
 * Paint the Witness in its rest pose: every region as its own matter map with its rig metadata (arms, membranes, fibres).
 * Pure and deterministic in (seed, lighting).
 */
export function paintWitness(
  seed: number,
  lighting: StageLighting,
  armStyle: WitnessArmStyle = WITNESS_ARM_STYLE,
  opts: { micro?: boolean } = {},
): WitnessBody {
  const ramps = buildLitRamps(WITNESS_MATERIALS, lighting, 0.85);
  const regions: WitnessRegion[] = [];
  const add = (r: WitnessRegion): number => regions.push(r) - 1;
  const eye = add(paintEyeCradle(ramps, lighting, opts.micro ?? true));
  const car = add(paintCarapace(ramps, lighting, seed, eye));
  add(paintInterior(ramps, lighting, seed, car, 1));
  add(paintInterior(ramps, lighting, seed, car, 2));
  add(paintInterior(ramps, lighting, seed, car, 3));
  add(paintMantle(ramps, lighting, seed, car));
  const shrine = add(paintShrine(ramps, lighting, seed, car));
  for (let k = 0; k < HALO_ARCS.length; k++) add(paintHaloArc(ramps, lighting, seed, eye, k));
  const arms: WitnessArm[] = [];
  for (let a = 0; a < ARMS.length; a++) {
    const def = ARMS[a]!;
    const S = bezierSamples(def.c, 200);
    const segs: number[] = [];
    let parent = car;
    for (let seg = 0; seg < def.joints.length; seg++) {
      parent = add(paintArmSegment(ramps, lighting, seed, parent, a, seg, armStyle));
      segs.push(parent);
    }
    const points = def.joints.map((u) => samplesAt(S, u));
    points.push({ x: S.x[200]!, y: S.y[200]! });
    arms.push({ regions: segs, points, width: 4.8 * def.w, bladeSide: armTurn(S) });
  }
  // tension membranes: carapace ↔ the first and second joints of the three long arms; fibres: carapace → later joints
  const membranes: WitnessBody['membranes'] = [];
  const fibres: WitnessBody['fibres'] = [];
  for (const arm of arms) {
    if (arm.regions.length < 3) continue;
    const root = arm.points[0]!;
    const elbow = arm.points[1]!;
    // the carapace anchor sits a little below and inside the arm root
    const ang = Math.atan2(root.y - WE.carCY, root.x - WE.carCX) + (root.x > 0 ? 0.55 : -0.55);
    const ca = {
      region: car,
      x: WE.carCX + Math.cos(ang) * (WE.carR - 3),
      y: WE.carCY + Math.sin(ang) * (WE.carR - 3),
    };
    membranes.push([
      { region: arm.regions[0]!, x: root.x, y: root.y },
      { region: arm.regions[1]!, x: elbow.x, y: elbow.y },
      ca,
    ]);
    for (let j = 2; j < arm.points.length - 1; j++)
      fibres.push([ca, { region: arm.regions[j]!, x: arm.points[j]!.x, y: arm.points[j]!.y }]);
  }
  // the shrine hangs on fibres too
  fibres.push([
    { region: car, x: -24, y: WE.carCY + 36 },
    { region: shrine, x: -20, y: WE.shrineY + 12 },
  ]);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let cells = 0;
  for (const r of regions) {
    const m = r.map;
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        if (m.material[y * m.w + x] === 0) continue;
        cells++;
        x0 = Math.min(x0, x + r.ox);
        x1 = Math.max(x1, x + r.ox + 1);
        y0 = Math.min(y0, y + r.oy);
        y1 = Math.max(y1, y + r.oy + 1);
      }
  }
  return { regions, materials: WITNESS_MATERIALS, arms, membranes, fibres, x0, y0, x1, y1, cells };
}

/** Which side the blade sits on: the side the curve turns toward near its hook (+1 = left of the direction of travel). */
function armTurn(S: { x: Float64Array; y: Float64Array }): number {
  const n = S.x.length - 1;
  const mid = Math.round(n * 0.8);
  const tx = S.x[mid + 1]! - S.x[mid - 1]!;
  const ty = S.y[mid + 1]! - S.y[mid - 1]!;
  const t2x = S.x[mid + 1]! - 2 * S.x[mid]! + S.x[mid - 1]!;
  const t2y = S.y[mid + 1]! - 2 * S.y[mid]! + S.y[mid - 1]!;
  return Math.sign(tx * t2y - ty * t2x) || 1;
}

/* ---------------------------------------------------------------- the eye (root, KO core) */

function paintEyeCradle(ramps: number[][], lighting: StageLighting, micro: boolean): WitnessRegion {
  const R = WE.eyeR;
  const rc = regionCanvas(-WE.teethR, -WE.teethR, WE.teethR, WE.teethR);
  const { cv, ox, oy } = rc;
  const sclera = WID('sclera');
  const iris = WID('iris');
  const pupil = WID('pupil');
  const gold = WID('gold');
  const burn = WID('lattice');
  const crystal = WID('bone');
  for (let y = 0; y < cv.h; y++)
    for (let x = 0; x < cv.w; x++) {
      const bx = x + ox + 0.5;
      const by = y + oy + 0.5;
      const rho = Math.hypot(bx, by);
      const i = y * cv.w + x;
      const th = Math.atan2(by, bx);
      if (rho > WE.rimR) {
        // crystal teeth round the burning ring: 28 of them, uneven in length, tapering outward
        if (rho > WE.teethR) continue;
        const k = Math.floor(((th + Math.PI) / (Math.PI * 2)) * 28);
        const f = (((th + Math.PI) / (Math.PI * 2)) * 28) % 1;
        const len = (WE.teethR - WE.rimR) * (0.55 + 0.45 * hash01(k, 3, 77));
        const u = (rho - WE.rimR) / len;
        if (u > 1 || Math.abs(f - 0.5) > 0.42 * (1 - u)) continue;
        cv.mat[i] = crystal;
        cv.relief[i] = 10 - 4 * u;
        cv.tone[i] = f < 0.5 ? 1.2 : -0.4;
        continue;
      }
      if (rho > R) {
        // the socket: a raised ring of gold that BURNS on its inner edge, with notched inlays
        const t = (rho - R) / (WE.rimR - R);
        cv.mat[i] = t < 0.3 ? burn : gold;
        cv.relief[i] = 12 + 4 * Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2));
        const notch = Math.abs((((th / (Math.PI * 2)) * 36 + 36) % 1) - 0.5) > 0.44;
        if (notch && t >= 0.3) cv.tone[i] = -1.4;
        continue;
      }
      // the iris and pupil are offset from the sclera's centre (it looks; it is not a target)
      const q = rho / R;
      const qi = Math.hypot(bx - WE.pupilDX, (by - WE.pupilDY) * 0.94) / R;
      cv.mat[i] = qi < 0.27 ? pupil : qi < 0.66 ? iris : sclera;
      cv.relief[i] = 10 + 8 * (1 - q * q);
    }
  return finishRegion(
    rc,
    ramps,
    lighting,
    (colors, c) => paintWitnessEye(colors, c, ox, oy, lighting, micro),
    WE.pupilDX,
    WE.pupilDY,
    9,
    {
      key: 'eye',
      kind: 'eye',
      pivotX: 0,
      pivotY: 0,
      parent: -1,
      weld: false,
      layer: -1,
      z: 8,
      arm: -1,
      segment: -1,
    },
  );
}

/**
 * Bone sclera shaded as a sphere, a celadon → tarnished-gold radial iris, an abyssal pupil, ONE sharp catchlight.
 *
 * With `micro` (the default) the eye is also a WORLD on close inspection: the value structure is the same at 1× (every
 * microfeature moves the local tone by at most one or two ramp steps, sparse, never a new edge), but zoomed in:
 *  - the sclera is an ice world: faint latitude seams, plate boundaries (Worley edges), a few hairline fissures, and where
 *    it meets the iris a crenellated ring wall;
 *  - the iris is a crater landscape: radial canyons with lit ridges beside them, three concentric terraces stepping down
 *    to the pupil, three warm points of light in the valleys (settlements, vents), and a collarette of regular built
 *    notches;
 *  - the pupil is a shaft: rims step down into it and one deep teal glow sits at the very bottom;
 *  - the catchlight resolves into a lens facet with a structural seam across it.
 */
function paintWitnessEye(
  colors: Uint32Array,
  cv: ArtCanvas,
  ox: number,
  oy: number,
  lighting: StageLighting,
  micro: boolean,
): void {
  const R = WE.eyeR;
  const bone = W_BONE.map(hex);
  const irisR = W_IRIS.map(hex);
  const pup = ['#010205', '#04060c', '#090c18', '#14182a'].map(hex);
  const warm = ['#a88a44', '#e2c77e'].map(hex);
  const deep = hex('#0a2228');
  const sclera = WID('sclera');
  const iris = WID('iris');
  const pupil = WID('pupil');
  const lx = lighting.dir[0] * 0.7;
  const ly = lighting.dir[1];
  const wor = makeWorley();
  // hairline fissures across the sclera: short polylines (body px), drawn 1 px wide
  const fissures: [number, number, number, number][] = [
    [-24, -9, -17, -4],
    [-17, -4, -13, -6],
    [16, 18, 22, 11],
    [9, -24, 14, -20],
    [-20, 14, -14, 20],
  ];
  const onFissure = (bx: number, by: number): boolean => {
    for (const [ax, ay, cx, cy] of fissures) {
      const dx = cx - ax;
      const dy = cy - ay;
      const u = clamp01(((bx - ax) * dx + (by - ay) * dy) / (dx * dx + dy * dy));
      if (Math.hypot(bx - ax - u * dx, by - ay - u * dy) < 0.5) return true;
    }
    return false;
  };
  // settlements / vents: angle (rad) and radius (iris fraction t), in valleys between canyons
  const lights: [number, number][] = [
    [2.35, 0.62],
    [-0.55, 0.48],
    [0.95, 0.74],
  ];
  for (let y = 0; y < cv.h; y++)
    for (let x = 0; x < cv.w; x++) {
      const i = y * cv.w + x;
      const m = cv.mat[i];
      if (m !== sclera && m !== iris && m !== pupil) continue;
      const bx = x + ox + 0.5;
      const by = y + oy + 0.5;
      const q = Math.hypot(bx, by) / R;
      const ix = bx - WE.pupilDX;
      const iy = (by - WE.pupilDY) * 0.94;
      const qi = Math.hypot(ix, iy) / R;
      const th = Math.atan2(iy, ix);
      // sphere light: the side toward the key light is brighter
      const nz = Math.sqrt(Math.max(0, 1 - q * q));
      const lit = clamp01(
        0.55 + (0.45 * ((bx / R) * lx + (by / R) * ly)) / Math.max(0.3, Math.hypot(lx, ly)) - 0.25 * (1 - nz),
      );
      const th8 = bayer8(x, y) / 64;
      let c: number;
      if (m === sclera) {
        const v = 1.2 + lit * 3.6 - (q > 0.92 ? 1.2 : 0) - (by < -R * 0.55 ? 0.8 : 0);
        const fl = Math.floor(v);
        let k = fl + (v - fl > th8 ? 1 : 0);
        if (micro) {
          // microfeatures move the DITHERED level by whole steps (no new dither noise), sparse 1-px marks:
          // ice-shelf plate boundaries (large Worley cells, broken), latitude seams every ~6 px (every other pixel),
          // a few hairline fissures, and a crenellated ring wall where the sclera meets the iris
          worley(bx * 0.11, by * 0.11, 9131, wor);
          const lat = Math.asin(clamp(by / R, -1, 1)) * (R / 6);
          let d = 0;
          if (wor.f2 - wor.f1 < 0.045 && hash01(x, y, 71) > 0.3) d = -1;
          else if (Math.abs(lat - Math.round(lat)) < 0.08 && (x + y) % 2 === 0) d = -1;
          if (onFissure(bx, by)) d = -1;
          if (qi < 0.7) d = Math.floor(((th + Math.PI) / (Math.PI * 2)) * 40) % 2 === 0 ? 1 : -1;
          k += d;
        }
        c = bone[clamp(k, 1, 5)]!;
      } else if (m === iris) {
        const t = (qi - 0.27) / (0.66 - 0.27); // 0 at the pupil, 1 at the limbus
        const fibre = ridged(th * 5.1 + 2, qi * 5.5, 4177, 2) - 0.5;
        // a narrow tarnished-gold collarette round the pupil, celadon fibres outward, a dark limbal ring
        let v = t < 0.2 ? 4.3 + fibre * 1.2 : 3.4 - t * 2.2 + fibre * 1.8 + (lit - 0.5) * 1.0;
        if (t > 0.86) v = 0.2;
        const fl = Math.floor(v);
        let k = fl + (v - fl > th8 ? 1 : 0);
        if (micro && t <= 0.86) {
          if (t < 0.2) {
            // the collarette is BUILT: 16 regular slots round it
            if ((((th + Math.PI) / (Math.PI * 2)) * 16) % 1 < 0.16) k -= 1;
          } else {
            // canyons: 14 radial cuts, slightly meandering, one step down; three terrace lips one step up (broken)
            const a = ((th + Math.PI) / (Math.PI * 2)) * 14 + 0.3 * Math.sin(qi * 9 + th * 3);
            if (a - Math.floor(a) < 0.07) k -= 1;
            else
              for (const tt of [0.4, 0.58, 0.74]) if (Math.abs(t - tt) < 0.022 && (x + y) % 2 === 0) k += 1;
          }
        }
        c = irisR[clamp(k, 0, 5)]!;
        if (micro && t > 0.2 && t < 0.86)
          for (const [la, lt] of lights) {
            const px = WE.pupilDX + Math.cos(la) * (0.27 + lt * 0.39) * R;
            const py = WE.pupilDY + (Math.sin(la) * (0.27 + lt * 0.39) * R) / 0.94;
            if (Math.floor(bx) === Math.floor(px) && Math.floor(by) === Math.floor(py))
              c = warm[lt > 0.6 ? 0 : 1]!;
          }
      } else {
        let v = qi < 0.18 ? 0 : qi < 0.24 ? 1 : 2;
        if (micro) {
          // the shaft: rims step down into it (one ramp step, broken), and a deep glow at the bottom
          if (Math.abs(qi - 0.2) < 0.012 || (Math.abs(qi - 0.13) < 0.012 && hash01(x, y, 5) > 0.4))
            v = Math.min(3, v + 1);
          if (Math.abs(ix) < 0.6 && Math.abs(iy) < 0.6) {
            colors[i] = deep;
            continue;
          }
        }
        c = pup[v]!;
      }
      colors[i] = c;
    }
  // ONE sharp catchlight, up toward the light; with microdetail it is a lens facet with a seam across it
  const white = hex('#ffffff');
  const facet = hex('#cfe9ee');
  const cx = Math.round(-R * 0.34 + (lighting.dir[0] < 0 ? 0 : R * 0.68)) - ox;
  const cy = Math.round(-R * 0.36) - oy;
  const dots: [number, number][] = [
    [0, -1],
    [-1, 0],
    [0, 0],
    [1, 0],
    [0, 1],
    [1, -1],
  ];
  for (const [dx, dy] of dots) {
    const i = (cy + dy) * cv.w + cx + dx;
    if (cv.mat[i] === 0 || cv.mat[i] === WID('gold')) continue;
    // the seam runs diagonally through the facet: two of its six pixels a step down from white
    colors[i] = micro && dx + dy === 0 && !(dx === 0 && dy === 0) ? facet : white;
  }
}

/* ---------------------------------------------------------------- the carapace stack */

const carapaceSd = (bx: number, by: number, seed: number): number => {
  // not a sphere: an irregular mosaic mass, wider than tall, lumpy at the rim
  const wx = bx + fbm(bx * 0.04, by * 0.04, seed + 3, 3) * 6.0;
  const wy = by + fbm(bx * 0.04 + 4.1, by * 0.04, seed + 5, 3) * 6.0;
  let d = sdEllipse(wx, wy, WE.carCX, WE.carCY, WE.carR * 1.04, WE.carR * 0.94);
  // a few weathered notches on the rim (sparse and uneven: it is ancient, not ruined)
  for (const a of [-2.6, -1.95, -0.45, 0.4, 1.15, 2.35]) {
    const r = WE.carR + 1;
    d = ssub(
      d,
      sdCircle(
        bx,
        by,
        WE.carCX + Math.cos(a) * r,
        WE.carCY + Math.sin(a) * r,
        1.8 + hash01(a * 10, 1, seed) * 1.6,
      ),
      1.5,
    );
  }
  return d;
};

function paintCarapace(
  ramps: number[][],
  lighting: StageLighting,
  seed: number,
  parent: number,
): WitnessRegion {
  const R = WE.carR;
  const rc = regionCanvas(-R * 1.04 - 9, WE.carCY - R - 9, R * 1.04 + 9, WE.carCY + R + 9);
  const { cv, ox, oy } = rc;
  const carapace = WID('carapace');
  const vein = WID('vein');
  const hairline = WID('hairline');
  const worleyOut = makeWorley();
  // fracture veins radiating from the socket (stress lines; their weak bonds crack first); three of them are hairline
  // fractures that glow cyan, as if something inside were looking out
  const veinSegs: number[] = [];
  const veinGlow: number[] = [];
  const rng = new Rng(seed ^ 0x3a11);
  for (let k = 0; k < 9; k++) {
    let a = (k / 9) * Math.PI * 2 + rng.range(-0.2, 0.2);
    let r = WE.socketR + 0.5;
    let px = Math.cos(a) * r;
    let py = Math.sin(a) * r;
    let branch = rng.int(3) + 2;
    const glow = k === 4 ? 1 : 0;
    while (r < R * 0.82) {
      a += rng.range(-0.18, 0.18);
      r += 3;
      const nx = Math.cos(a) * r;
      const ny = Math.sin(a) * r;
      veinSegs.push(px, py, nx, ny);
      veinGlow.push(glow && r < WE.socketR + 12 ? 1 : 0);
      if (--branch === 0) {
        // a short side crack
        const ba = a + (rng.next() < 0.5 ? -0.5 : 0.5);
        veinSegs.push(nx, ny, nx + Math.cos(ba) * 7, ny + Math.sin(ba) * 7);
        veinGlow.push(0);
      }
      px = nx;
      py = ny;
    }
  }
  for (let y = 0; y < cv.h; y++)
    for (let x = 0; x < cv.w; x++) {
      const bx = x + ox + 0.5;
      const by = y + oy + 0.5;
      if (carapaceSd(bx, by, seed) > 0) continue;
      const rho = Math.hypot(bx, by);
      if (rho < WE.socketR) continue;
      const i = y * cv.w + x;
      cv.mat[i] = carapace;
      const rr = Math.hypot(bx - WE.carCX, by - WE.carCY) / R;
      let rel = 30 * Math.sqrt(Math.max(0, 1 - rr * rr)) + Math.max(0, WE.socketR + 5 - rho) * 1.3;
      // a MOSAIC of plates: dark seams between them that widen toward the rim, where the plates come apart (it frays)
      worley(bx / 9, by / 9, seed + 17, worleyOut, 0.85);
      let tone = (worleyOut.id - 0.5) * 0.9;
      const gap = (worleyOut.f2 - worleyOut.f1) * 9;
      const fray = smoothstep(0.7, 1.05, rr);
      if (gap < 0.45 + 1.6 * fray) {
        if (fray > 0.55) {
          cv.mat[i] = 0;
          continue;
        }
        tone -= 1.3;
        rel -= 1.6;
      }
      // the plates are domed: lit in their middles
      rel += 2.2 * Math.min(1, gap / 3);
      if (worleyOut.id > 0.9) cv.mat[i] = WID('bronze');
      for (let s = 0; s < veinSegs.length; s += 4)
        if (sdSegment(bx, by, veinSegs[s]!, veinSegs[s + 1]!, veinSegs[s + 2]!, veinSegs[s + 3]!) < 0.62) {
          cv.mat[i] = veinGlow[s >> 2] ? hairline : vein;
          rel -= 0.8;
          tone = 0.4;
          break;
        }
      cv.relief[i] = Math.max(0.2, rel);
      cv.tone[i] = tone;
    }
  const over = (colors: Uint32Array, c: ArtCanvas): void => {
    const cyan = W_CYAN.map(hex);
    for (let k = 0; k < colors.length; k++)
      if (c.mat[k] === hairline) colors[k] = cyan[hash01(k, 9, seed) > 0.5 ? 3 : 2]!;
  };
  return finishRegion(rc, ramps, lighting, over, 0, WE.socketR + 5, 4, {
    key: 'carapace',
    kind: 'carapace',
    pivotX: 0,
    pivotY: 0,
    parent,
    weld: false,
    layer: 0,
    z: 7,
    arm: -1,
    segment: -1,
  });
}

/**
 * Interior layer `layer` (1 channels, 2 lattice, 3 abyss) behind the carapace, at the same place. Channels and lattice are
 * sparse connected networks; the abyss is the full back wall with star specks and closed inner eyes.
 */
function paintInterior(
  ramps: number[][],
  lighting: StageLighting,
  seed: number,
  parent: number,
  layer: 1 | 2 | 3,
): WitnessRegion {
  const R = WE.carR - 1;
  const rc = regionCanvas(-R * 1.04 - 8, WE.carCY - R - 8, R * 1.04 + 8, WE.carCY + R + 8);
  const { cv, ox, oy } = rc;
  const channel = WID('channel');
  const lattice = WID('lattice');
  const abyss = WID('abyss');
  const star = WID('star');
  const sclera = WID('sclera');
  const pupil = WID('pupil');
  const inner = WE.socketR - 1.5;
  const innerEyes: [number, number, number][] = [
    [-21, 43, 8],
    [1, 49, 9],
    [22, 42, 7.5],
    [-41, 18, 5.5],
    [40, 21, 5.5],
    // the second eye: larger, upper right, the first thing the wounded carapace shows
    [33, -27, 10],
  ];
  for (let y = 0; y < cv.h; y++)
    for (let x = 0; x < cv.w; x++) {
      const bx = x + ox + 0.5;
      const by = y + oy + 0.5;
      if (carapaceSd(bx, by, seed) > -1) continue;
      const rho = Math.hypot(bx, by);
      if (rho < inner) continue;
      const i = y * cv.w + x;
      const th = Math.atan2(by, bx);
      const rr = Math.hypot(bx - WE.carCX, by - WE.carCY);
      if (layer === 1) {
        // luminous tension channels: radial veins of stress joined by two hoops
        let on = false;
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2 + 0.12 + 0.07 * Math.sin(rho * 0.22 + k);
          let d = th - a;
          d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
          if (Math.abs(d) * rho < 0.95) on = true;
        }
        if (Math.abs(rr - (R - 10)) < 0.95 || Math.abs(rr - (R - 3)) < 0.95) on = true;
        if (rho < inner + 1.5) on = true; // a collar around the socket keeps the network in one piece
        if (!on) continue;
        cv.mat[i] = channel;
        cv.relief[i] = 3;
      } else if (layer === 2) {
        // sacred geometry: three hoops, six spokes, a ring of six overlapping circles
        // (lines are ≥ 1.8 px wide so diagonals stay 4-connected: the lattice is one body)
        let on =
          Math.abs(rr - (R - 11)) < 0.95 ||
          Math.abs(rr - (R - 5.5)) < 0.95 ||
          Math.abs(rr - (R - 1.2)) < 0.95 ||
          rho < inner + 1.2;
        for (let k = 0; k < 6 && !on; k++) {
          const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
          const cx = WE.carCX + Math.cos(a) * (R - 6);
          const cy = WE.carCY + Math.sin(a) * (R - 6);
          if (Math.abs(Math.hypot(bx - cx, by - cy) - 12) < 0.95) on = true;
          let d = th - (a - Math.PI / 6);
          d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
          if (Math.abs(d) * rho < 0.95) on = true;
        }
        if (!on) continue;
        cv.mat[i] = lattice;
        cv.relief[i] = 4;
      } else {
        cv.mat[i] = abyss;
        cv.relief[i] = 1;
        cv.tone[i] = -0.4 + 1.2 * smoothstep(R, R * 0.4, rr) * 0.5;
        if (hash01(x * 3 + 1, y * 5 + 2, seed + 91) > 0.986) cv.mat[i] = star;
        for (const [ex, ey, er] of innerEyes) {
          // closed lids: a bone almond (pointed: two arcs) with a dark lash slit (Phase 2 opens them)
          const half = er * 0.42 * Math.max(0, 1 - ((bx - ex) / er) ** 2);
          if (Math.abs(bx - ex) < er && Math.abs(by - ey) < half + 0.5) {
            cv.mat[i] = Math.abs(by - ey - half * 0.15) < 0.6 ? pupil : sclera;
            cv.relief[i] = 3 + half;
          }
        }
      }
    }
  const over =
    layer === 1
      ? (colors: Uint32Array, c: ArtCanvas): void => {
          // channel light: brightest along the centre of each channel
          const cyan = W_CYAN.map(hex);
          const d = c.distance();
          for (let k = 0; k < colors.length; k++)
            if (c.mat[k] === channel) colors[k] = cyan[d[k]! >= 1.5 ? 4 : 2]!;
        }
      : layer === 3
        ? (colors: Uint32Array, c: ArtCanvas): void => {
            const sp = ['#7fd2d6', '#e9fbff', '#ffffff'].map(hex);
            for (let k = 0; k < colors.length; k++)
              if (c.mat[k] === star) colors[k] = sp[hash01(k, 3, seed) > 0.6 ? 2 : 1]!;
          }
        : null;
  return finishRegion(rc, ramps, lighting, over, 0, inner + 0.5, 3, {
    key: layer === 1 ? 'channels' : layer === 2 ? 'lattice' : 'abyss',
    kind: 'interior',
    pivotX: 0,
    pivotY: 0,
    parent,
    weld: true,
    layer,
    z: 7 - layer,
    arm: -1,
    segment: -1,
  });
}

/* ---------------------------------------------------------------- the mantle */

/**
 * The dark mantle behind the head that the arms grow out of, so head and arms read as one structure. It is welded to the
 * carapace (one rig body) and drawn behind the arms; under the head it is hollow (nobody sees it there).
 */
function paintMantle(
  ramps: number[][],
  lighting: StageLighting,
  seed: number,
  parent: number,
): WitnessRegion {
  const RX = WE.mantleRX;
  const RY = WE.mantleRY;
  const cy = WE.carCY + 6;
  const rc = regionCanvas(-RX - 8, cy - RY - 8, RX + 8, cy + RY + 8);
  const { cv, ox, oy } = rc;
  const mantle = WID('abyss');
  const vein = WID('membrane');
  const wor = makeWorley();
  for (let y = 0; y < cv.h; y++)
    for (let x = 0; x < cv.w; x++) {
      const bx = x + ox + 0.5;
      const by = y + oy + 0.5;
      const wx = bx + fbm(bx * 0.05, by * 0.05, seed + 41, 2) * 7;
      const wy = by + fbm(bx * 0.05 + 3.3, by * 0.05, seed + 43, 2) * 7;
      if (sdEllipse(wx, wy, 0, cy, RX, RY) > 0) continue;
      if (carapaceSd(bx, by, seed) < -7) continue;
      const i = y * cv.w + x;
      worley(bx / 6, by / 6, seed + 47, wor, 0.8);
      const seam = (wor.f2 - wor.f1) * 6 < 0.7;
      cv.mat[i] = seam && hash01(x, y, seed + 5) > 0.5 ? vein : mantle;
      const e = -sdEllipse(wx, wy, 0, cy, RX, RY);
      cv.relief[i] = 1 + Math.min(4, e * 0.15) + (seam ? -0.5 : 0.8 * (1 - wor.f1));
      cv.tone[i] = seam ? -0.4 : 0.2;
    }
  return finishRegion(rc, ramps, lighting, null, RX - 10, cy, 3, {
    key: 'mantle',
    kind: 'mantle',
    pivotX: 0,
    pivotY: 0,
    parent,
    weld: true,
    layer: -1,
    z: 2,
    arm: -1,
    segment: -1,
  });
}

/* ---------------------------------------------------------------- the shrine chandelier */

/** x, length, root radius, snapped (0 = whole; else the fraction of the length that is left). Uneven; two have snapped. */
const SPIRES: readonly [number, number, number, number][] = [
  [-32, 30, 2.0, 0],
  [-21, 48, 2.5, 0.5],
  [-11, 58, 2.8, 0],
  [1, 66, 3.4, 0],
  [12, 52, 2.8, 0],
  [22, 40, 2.5, 0],
  [32, 26, 2.0, 0.6],
];
/** Where a spire hangs from the dome (the dome is lowest in the middle). */
const spireRootY = (x: number): number => WE.shrineY + 8 + 11 * (1 - Math.min(1, Math.abs(x) / 36));
/** Body y of the longest spire's tip, where the light under the hanging city hangs (drawn at runtime). */
export const WITNESS_SHRINE_LIGHT_Y = spireRootY(SPIRES[3]![0]) + SPIRES[3]![1];

function paintShrine(
  ramps: number[][],
  lighting: StageLighting,
  seed: number,
  parent: number,
): WitnessRegion {
  const top = WE.shrineY;
  const rc = regionCanvas(-46, top - 2, 48, top + 96);
  const { cv, ox, oy } = rc;
  const gold = WID('gold');
  const bone = WID('bone');
  const bronze = WID('bronze');
  for (let y = 0; y < cv.h; y++)
    for (let x = 0; x < cv.w; x++) {
      const bx = x + ox + 0.5;
      const by = y + oy + 0.5;
      const i = y * cv.w + x;
      // crown: an inverted dome tucked under the carapace, narrowing to a hanging boss
      const t = clamp01((by - top - 4) / 22);
      const cone = smax(Math.abs(bx - 1) - lerp(36, 4, t * t), Math.max(top + 4 - by, by - (top + 27)), 2);
      let d = smin(sdEllipse(bx, by, 0, top + 4, 36, 6.5), cone, 3);
      let spire = -1;
      let su = 0;
      for (let k = 0; k < SPIRES.length; k++) {
        const [sx, len0, r0, snap] = SPIRES[k]!;
        const ry = spireRootY(sx);
        const len = snap > 0 ? len0 * snap : len0;
        // a snapped spire keeps its taper but ends in a jagged break
        const rTip = snap > 0 ? r0 * (1 - snap) * 0.9 : 0.35;
        let ds = sdTaperedCapsule(bx, by, sx, ry, r0, sx * 1.12, ry + len, rTip);
        if (snap > 0) {
          const cut = ry + len - 0.8 + (hash01(Math.floor(bx * 2), k, seed + 3) - 0.5) * 2.2;
          ds = smax(ds, by - cut, 0.5);
        }
        if (ds < d) {
          spire = k;
          su = clamp01((by - ry) / len0);
        }
        d = smin(d, ds, 1.2);
      }
      // minor spires between the major ones
      for (let k = 0; k < SPIRES.length - 1; k++) {
        const mx = (SPIRES[k]![0] + SPIRES[k + 1]![0]) / 2;
        const ml = 5 + 5 * hash01(k, 7, seed);
        const ry = spireRootY(mx) - 1;
        d = smin(d, sdTaperedCapsule(bx, by, mx, ry, 1.3, mx * 1.08, ry + ml, 0.3), 0.8);
      }
      if (d > 0) continue;
      let m: number;
      let rel: number;
      if (spire >= 0 && su > 0.04) {
        const [sx, , r0] = SPIRES[spire]!;
        const across = Math.abs(bx - sx * (1 + 0.12 * su)) / Math.max(0.6, r0 * (1 - su));
        rel = 7 * Math.sqrt(Math.max(0, 1 - across * across)) + 2;
        // bone spires with gold collars; the centre spire is gold-tipped
        const band = Math.abs(su - 0.24) < 0.04 || Math.abs(su - 0.5) < 0.03;
        m = band || (spire === 3 && su > 0.82) ? gold : bone;
      } else {
        // the crown: a dark tarnished-bronze dome, ribbed with dead gold where the spires hang from it
        const rib = Math.abs(((bx + 40) % 7) - 3.5) < 0.8 && by > top + 5;
        m = rib ? gold : bronze;
        rel = 9 - Math.abs(bx) * 0.15 + (rib ? 1 : 0);
      }
      cv.mat[i] = m;
      cv.relief[i] = Math.max(0.5, rel);
      cv.tone[i] = (hash01(x, y, seed + 31) - 0.5) * 0.3;
    }
  return finishRegion(rc, ramps, lighting, null, 0, top + 6, 3, {
    key: 'shrine',
    kind: 'shrine',
    pivotX: 0,
    pivotY: top,
    parent,
    weld: false,
    layer: -1,
    z: 6,
    arm: -1,
    segment: -1,
  });
}

/* ---------------------------------------------------------------- the broken halo */

function paintHaloArc(
  ramps: number[][],
  lighting: StageLighting,
  seed: number,
  parent: number,
  k: number,
): WitnessRegion {
  const [a0d, a1d, dr] = HALO_ARCS[k]!;
  const a0 = (a0d * Math.PI) / 180;
  const a1 = (a1d * Math.PI) / 180;
  const R = WE.haloR + dr;
  const T = WE.haloT;
  const sigil = a0 < -Math.PI / 2 && a1 > -Math.PI / 2;
  // bounding box of the arc (plus the sigil above the top arc)
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let s = 0; s <= 32; s++) {
    const a = a0 + ((a1 - a0) * s) / 32;
    for (const r of [R - T, R + T + 2]) {
      x0 = Math.min(x0, Math.cos(a) * r);
      x1 = Math.max(x1, Math.cos(a) * r);
      y0 = Math.min(y0, Math.sin(a) * r);
      y1 = Math.max(y1, Math.sin(a) * r);
    }
  }
  if (sigil) y0 = Math.min(y0, -R - 20);
  const rc = regionCanvas(x0, y0, x1, y1);
  const { cv, ox, oy } = rc;
  const gold = WID('gold');
  const sy = -R - 10; // sigil centre
  // angles are measured in (−π, π]; an arc that crosses ±π (the left one) is handled by unwrapping
  const wrapNear = (th: number): number => {
    let t = th;
    while (t < a0 - Math.PI) t += Math.PI * 2;
    while (t > a0 + Math.PI) t -= Math.PI * 2;
    return t;
  };
  for (let y = 0; y < cv.h; y++)
    for (let x = 0; x < cv.w; x++) {
      const bx = x + ox + 0.5;
      const by = y + oy + 0.5;
      const i = y * cv.w + x;
      const rho = Math.hypot(bx, by);
      const th = wrapNear(Math.atan2(by, bx));
      // broken ends: the angular limits wander with the radius
      const rag = (hash01(Math.floor(rho), k, seed + 5) - 0.5) * 0.05;
      let on = rho > R - T * 0.5 && rho < R + T * 0.5 && th > a0 + rag && th < a1 - rag;
      let rel = 0;
      if (on) {
        const t = (rho - (R - T * 0.5)) / T;
        rel = 4 + 4 * Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2));
      }
      // tick marks: an astrolabe rim, every 5°; every fourth a raised stud
      const deg = (th * 180) / Math.PI;
      const tick = Math.abs(((deg + 720) % 5) - 2.5) > 2.1;
      const stud = Math.abs(((deg + 720) % 20) - 10) > 9.3;
      if (th > a0 + 0.03 && th < a1 - 0.03 && stud && rho >= R + T * 0.5 && rho < R + T * 0.5 + 2.2) {
        on = true;
        rel = 6;
      }
      if (sigil) {
        // the crosshair sigil: a ring on a vertical spine, crossed
        const ring = Math.abs(Math.hypot(bx, by - sy) - 5) < 1.1;
        const vert = Math.abs(bx) < 0.9 && by > sy - 7 && by < -R + T * 0.5;
        const hor = Math.abs(by - sy) < 0.8 && Math.abs(bx) < 10;
        if (ring || vert || hor) {
          on = true;
          rel = ring ? 6 : 4;
        }
      }
      if (!on) continue;
      cv.mat[i] = gold;
      cv.relief[i] = rel;
      cv.tone[i] = tick && rho > R ? -1.3 : (hash01(x, y, seed + 13) - 0.5) * 0.4;
    }
  const mid = (a0 + a1) / 2;
  return finishRegion(rc, ramps, lighting, null, Math.cos(mid) * R, Math.sin(mid) * R, 2, {
    key: `halo${k}`,
    kind: 'halo',
    pivotX: 0,
    pivotY: 0,
    parent,
    weld: false,
    layer: -1,
    z: 0,
    arm: -1,
    segment: -1,
  });
}

/* ---------------------------------------------------------------- the arms: limb, tendril, root, architecture */

/**
 * How the arms are built (WJ: "more ambiguity … now it's too much like blades"). Every style keeps the long sweeping
 * silhouette, the joints and the asymmetry, and drops the single tapered cutting edge:
 *  - 'limb':  a knotted sinew core swelling at the joints, ceramic plates over its outer side with gaps where the cyan
 *             filament shows through, a ragged scrap of web on the inner side; the end frays into three fibres.
 *  - 'root':  two strands braided round each other (bone over sinew, sinew over bone), bronze nodes, rootlets branching
 *             off; the end splits into a fan of rootlets.
 *  - 'truss': architecture: an outer ceramic rail and an inner bone rail held by alternating struts, some bays plated, a
 *             cyan filament down the middle; the end is broken off and the filament hangs out of it.
 */
export type WitnessArmStyle = 'cells' | 'limb' | 'root' | 'truss';
export const WITNESS_ARM_STYLES: readonly WitnessArmStyle[] = ['cells', 'limb', 'root', 'truss'];
/** The style the game uses (art v3, WJ's reference: round limbs built of bulbous cells). */
export const WITNESS_ARM_STYLE: WitnessArmStyle = 'cells';

interface ArmCell {
  m: number;
  rel: number;
  tone: number;
}

function paintArmSegment(
  ramps: number[][],
  lighting: StageLighting,
  seed: number,
  parent: number,
  arm: number,
  seg: number,
  style: WitnessArmStyle,
): WitnessRegion {
  const def = ARMS[arm]!;
  const N = 200;
  const S = bezierSamples(def.c, N);
  const u0 = def.joints[seg]!;
  const u1 = seg + 1 < def.joints.length ? def.joints[seg + 1]! : 1.0001;
  const turn = armTurn(S);
  const W = def.w;
  // the arc length (px) of the whole arm: the rhythms below are in pixels, so every arm has the same grain
  let L = 0;
  {
    const c = def.c;
    let px = c[0]!;
    let py = c[1]!;
    for (let i = 1; i <= 400; i++) {
      const t = i / 400;
      const qx =
        (1 - t) ** 3 * c[0]! + 3 * (1 - t) ** 2 * t * c[2]! + 3 * (1 - t) * t * t * c[4]! + t ** 3 * c[6]!;
      const qy =
        (1 - t) ** 3 * c[1]! + 3 * (1 - t) ** 2 * t * c[3]! + 3 * (1 - t) * t * t * c[5]! + t ** 3 * c[7]!;
      L += Math.hypot(qx - px, qy - py);
      px = qx;
      py = qy;
    }
  }
  const joint = samplesAt(S, u0);
  const jointR = (seg === 0 ? 5.4 : 4.6 - 0.5 * seg) * W;
  // bounding box of this segment's samples (the broad 'cells' crescents need a wider margin)
  const margin = style === 'cells' ? 19 * W : 11;
  let x0 = joint.x - jointR;
  let y0 = joint.y - jointR;
  let x1 = joint.x + jointR;
  let y1 = joint.y + jointR;
  for (let k = 0; k <= N; k++) {
    if (S.s[k]! < u0 - 0.02 || S.s[k]! > u1 + 0.02) continue;
    x0 = Math.min(x0, S.x[k]! - margin);
    x1 = Math.max(x1, S.x[k]! + margin);
    y0 = Math.min(y0, S.y[k]! - margin);
    y1 = Math.max(y1, S.y[k]! + margin);
  }
  const rc = regionCanvas(x0, y0, x1, y1);
  const { cv, ox, oy } = rc;
  const mat = {
    plate: WID('carapace'),
    edge: WID('lattice'),
    speck: WID('gold'),
    sinew: WID('membrane'),
    fibre: WID('vein'),
    bone: WID('bone'),
    bronze: WID('bronze'),
    filament: WID('channel'),
    glint: WID('hairline'),
    orb: WID('orb'),
    iris: WID('iris'),
    pupil: WID('pupil'),
  };
  const ph = arm * 1.7 + (seed % 7) * 0.3;
  const jointsT = def.joints.map((u) => u * L);
  /** Core half-width at arc length t: tapering, swelling at every joint, with a slow knotted rhythm between. */
  const core = (t: number): number => {
    let r = W * (2.1 + 3.3 * Math.max(0, 1 - t / L));
    for (const jt of jointsT) r += W * 1.9 * Math.exp(-(((t - jt) / 5) ** 2));
    r += W * 0.8 * Math.max(0, Math.sin(t / (5.2 + arm * 0.4) + ph)) ** 3;
    return r;
  };
  const tipStart = L - 12;
  /** Fibres / rootlets fanning from the end: [lateral spread per px past the split, length past L]. */
  const fan: readonly [number, number][] =
    style === 'root'
      ? [
          [-0.6, 4],
          [-0.2, 3],
          [0.2, 4],
          [0.6, 2],
        ]
      : [
          [-0.55, 3],
          [0.05, 4],
          [0.6, 2],
        ];
  const wor = makeWorley();
  /** 'cells': the crescent's half-width at arc length t: thick at the root (it grows from the mantle), broadest early. */
  const crescent = (t: number): number => {
    const u = Math.min(1, t / L);
    return W * (5.5 * (1 - u) ** 2 + 11 * Math.sin(Math.PI * Math.min(1, u * 1.08)) ** 0.85 + 1.0);
  };
  const cellArm = (t: number, s: number): ArmCell | null => {
    if (t > L) return null;
    const r = crescent(t);
    if (Math.abs(s) > r) return null;
    const u = t / L;
    // across the width: −1 on the OUTER (convex) edge, +1 on the inner edge
    const a = s / r;
    // the lattice of bulbous cells, in arm-local coordinates (cells run along the limb)
    worley(t / 4.2 + arm * 31, s / 3.6, seed + 211 + arm, wor, 0.85);
    const gap = wor.f2 - wor.f1;
    const id = wor.id;
    // edges dissolve: whole cells drop out near the rims and toward the tip (they drift away as fx)
    const edge = Math.max(0, Math.abs(a) - 0.72) / 0.28;
    const drop = 0.75 * edge + 1.4 * Math.max(0, u - 0.86);
    if (id < drop * 0.8 && Math.abs(a) > 0.35) return null;
    // the keen edge: one bright line, only along the outer curve
    if (a < -1 + 1.25 / r && u > 0.06 && u < 0.96) return { m: mat.edge, rel: 6, tone: 1.6 };
    // half-lidded orb-eyes along the limb, a little outside the centre line, every ~32 px
    const eT = (t + arm * 11) % 40;
    const eS = s + 0.18 * r;
    if (u > 0.08 && u < 0.88 && Math.hypot(eT - 20, eS) < 3.4) {
      const lid = eS < -0.6 || Math.abs(eS) > 1.1; // the upper half is lidded, a slit of iris below
      const slit = Math.abs(eS - 0.9) < 0.6;
      return {
        m: slit ? (Math.abs(eT - 20) < 0.7 ? mat.pupil : mat.iris) : mat.orb,
        rel: 7,
        tone: lid ? 0.4 : 0,
      };
    }
    // dark gaps between the cells (matter, so the limb stays one body; they read as cracks of shadow)
    if (gap < 0.16) return { m: mat.sinew, rel: 0.5 + 1.5 * (1 - a * a), tone: -1.8 };
    // a bulb: lit in its middle, dark at its own edge; the whole limb lit across its width
    const bulb = Math.sqrt(Math.max(0, 1 - (wor.f1 * 1.5) ** 2));
    const across = Math.sqrt(Math.max(0, 1 - a * a));
    // a sparse scatter of light in the lattice: gold specks and pale celadon cell-tops (the reference's glittering arms)
    const m = id > 0.965 ? mat.speck : id > 0.9 ? mat.fibre : id > 0.84 ? mat.bronze : mat.plate;
    return { m, rel: 2 + 3 * bulb + 6 * across, tone: (bulb - 0.6) * 0.8 + (id - 0.5) * 0.4 };
  };
  const cell = (t: number, s: number, bay: number): ArmCell | null => {
    if (style === 'cells') return cellArm(t, s);
    const r = core(t);
    // ---- the end: no point, a split, frayed, broken or hanging finish
    if (t > tipStart) {
      if (style === 'truss') {
        // broken off: the rails stop at ragged lengths, the filament hangs out of the break and droops
        const brk = L - 2 - 3 * hash01(arm, 9, seed);
        if (t < brk && Math.abs(s) <= r)
          return { m: mat.plate, rel: 4, tone: -0.6 + 0.6 * hash01(bay, arm, seed) };
        const sag = 0.06 * (t - brk) ** 2 * (arm % 2 ? 1 : -1);
        if (t < L + 5 && Math.abs(s - sag) < 1.1)
          return { m: t > L + 3.5 ? mat.glint : mat.filament, rel: 2, tone: 0.4 };
        return null;
      }
      const d = t - tipStart;
      for (let k = 0; k < fan.length; k++) {
        const [spread, ext] = fan[k]!;
        if (t > L + ext) continue;
        const c = spread * d;
        const w = Math.max(0.75, r * (0.55 - (0.35 * d) / (12 + ext)));
        if (Math.abs(s - c) < w)
          return {
            m: t > L + ext - 1.5 ? mat.glint : style === 'root' ? mat.fibre : k === 1 ? mat.sinew : mat.fibre,
            rel: 3,
            tone: 0.2 * (k - 1),
          };
      }
      return null;
    }
    if (style === 'limb') {
      if (Math.abs(s) <= r) {
        // ceramic plates over the OUTER side, bay by bay; a missing plate shows the sinew and the cyan filament
        const plated = hash01(bay, arm * 13 + 1, seed) > 0.27;
        const edge = t % 8 < 1.1;
        if (s < -0.15 * r && plated)
          return {
            m: mat.plate,
            rel: 5 + 2 * Math.sqrt(Math.max(0, 1 - (s / r) ** 2)),
            tone: edge ? -1.4 : 0.1,
          };
        if (!plated && Math.abs(s + 0.2 * r) < 0.7) return { m: mat.filament, rel: 3, tone: 0.5 };
        const tendon = bay % 2 === 0 && Math.abs(s - 0.45 * r) < 0.6;
        return { m: tendon ? mat.bone : mat.sinew, rel: 3 + (tendon ? 1 : 0), tone: -0.3 + 0.4 * (s / r) };
      }
      // a ragged scrap of web on the inner side, early in the arm, full of holes: never one clean edge
      const u = t / L;
      if (s > r && u > 0.12 && u < 0.5) {
        const web =
          W *
          3.2 *
          Math.sin((Math.PI * (u - 0.12)) / 0.38) *
          (0.45 + 0.55 * hash01(Math.floor(t / 3), arm, seed));
        if (s < r + web && hash01(Math.floor(t), Math.floor(s), seed + arm) > 0.18)
          return { m: mat.sinew, rel: 2, tone: -1.1 + 0.4 * ((s - r) / Math.max(1, web)) };
      }
      return null;
    }
    if (style === 'root') {
      const node = (t + arm * 5) % 13 < 2.2 && t > 4;
      if (node && Math.abs(s) <= r) return { m: mat.bronze, rel: 6, tone: -0.2 };
      const a = t / 5 + ph;
      const c0 = r * 0.45 * Math.sin(a);
      const rs = r * 0.62;
      const in0 = Math.abs(s - c0) < rs;
      const in1 = Math.abs(s + c0) < rs;
      if ((in0 || in1) && Math.abs(s) <= r) {
        // over and under: which strand is in front alternates every half twist
        const front0 = Math.cos(a) > 0;
        const k0 = in0 && (!in1 || front0);
        return {
          m: k0 ? mat.bone : mat.fibre,
          rel: 4 + (k0 === front0 ? 1 : 0),
          tone: (k0 ? 0.2 : -0.2) + 0.3 * Math.cos(a),
        };
      }
      // rootlets: a short branch every ~17 px on the inner side, reaching across and along
      const tb = Math.floor((t + arm * 3) / 17) * 17 - arm * 3;
      const side = 1; // toward the inner (concave) side: rootlets never widen the silhouette
      const dt = t - tb;
      if (dt >= 0 && dt < 5 && t < L - 14) {
        const cs = side * (r * 0.8 + dt * 0.6);
        if (Math.abs(s - cs) < 1.05) return { m: dt > 3.8 ? mat.glint : mat.fibre, rel: 2, tone: 0 };
      }
      return null;
    }
    // 'truss': two rails and alternating struts, some bays plated, a cyan filament down the middle
    const rr = Math.max(1.6, r);
    if (Math.abs(s + rr * 0.8) < 1.2) return { m: mat.plate, rel: 6, tone: 0.2 };
    if (Math.abs(s - rr * 0.8) < 0.95) return { m: mat.bone, rel: 5, tone: 0.3 };
    if (Math.abs(s) < 0.65) return { m: mat.filament, rel: 3, tone: 0.5 };
    if (Math.abs(s) < rr * 0.8) {
      const f = (t % 7) / 7;
      const diag = (Math.floor(t / 7) % 2 ? 1 - 2 * f : -1 + 2 * f) * rr * 0.8;
      if (Math.abs(s - diag) < 0.9) return { m: mat.bone, rel: 4, tone: 0 };
      if (hash01(bay, arm * 7 + 3, seed) > 0.58) return { m: mat.plate, rel: 3, tone: -0.7 };
    }
    return null;
  };
  // the orb-eye on this segment's start joint (every joint after the root), on the outer side
  let orbX = NaN;
  let orbY = NaN;
  if (seg > 0) {
    const k = Math.round(u0 * N);
    const nx = -(S.y[Math.min(N, k + 1)]! - S.y[Math.max(0, k - 1)]!);
    const ny = S.x[Math.min(N, k + 1)]! - S.x[Math.max(0, k - 1)]!;
    const nl = Math.hypot(nx, ny) || 1;
    const off = core(u0 * L) + 2.2;
    orbX = joint.x - (turn * nx * off) / nl;
    orbY = joint.y - (turn * ny * off) / nl;
  }
  for (let y = 0; y < cv.h; y++)
    for (let x = 0; x < cv.w; x++) {
      const bx = x + ox + 0.5;
      const by = y + oy + 0.5;
      const i = y * cv.w + x;
      // the joint (and its orb-eye) belongs to the segment that starts there
      const dj = Math.hypot(bx - joint.x, by - joint.y);
      if (style !== 'cells' && seg > 0 && Math.hypot(bx - orbX, by - orbY) < 2.8) {
        // dormant, but not quite closed: a gold lid with a thin slit of iris and a dark point
        const slit = Math.abs(by - orbY) < 0.55;
        cv.mat[i] = slit ? (Math.abs(bx - orbX) < 0.6 ? mat.pupil : mat.iris) : mat.orb;
        cv.relief[i] = 7;
        continue;
      }
      if (style !== 'cells' && dj < jointR) {
        cv.mat[i] = mat.bronze;
        cv.relief[i] = 6 + 4 * Math.sqrt(1 - (dj / jointR) ** 2);
        cv.tone[i] = dj > jointR - 1.2 ? -0.8 : 0;
        continue;
      }
      // nearest centreline sample
      let best = 0;
      let bd = Infinity;
      for (let k = 0; k <= N; k++) {
        const d = (bx - S.x[k]!) ** 2 + (by - S.y[k]!) ** 2;
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      const u = S.s[best]!;
      if (u < u0 || u >= u1) continue;
      const k0 = Math.max(0, best - 1);
      const k1 = Math.min(N, best + 1);
      const tdx = S.x[k1]! - S.x[k0]!;
      const tdy = S.y[k1]! - S.y[k0]!;
      const tl = Math.hypot(tdx, tdy) || 1;
      // signed distance across: + toward the inner (concave) side; arc length along, extended past the end
      const s = (((bx - S.x[best]!) * -tdy + (by - S.y[best]!) * tdx) / tl) * turn;
      const along = ((bx - S.x[best]!) * tdx + (by - S.y[best]!) * tdy) / tl;
      if (best === 0 && along < -0.8) continue;
      if (best !== N && Math.abs(along) > 0.8 && best !== 0) continue;
      const t = u * L + (best === N ? Math.max(0, along) : 0);
      const c = cell(t, s, Math.floor((t + arm * 3) / 8));
      if (!c) continue;
      cv.mat[i] = c.m;
      cv.relief[i] = c.rel;
      cv.tone[i] = c.tone + (hash01(x, y, seed + arm * 7 + seg) - 0.5) * 0.25;
    }
  return finishRegion(rc, ramps, lighting, null, joint.x, joint.y, 2, {
    key: `arm${arm}.${seg}`,
    kind: 'arm',
    pivotX: joint.x,
    pivotY: joint.y,
    parent,
    weld: false,
    layer: -1,
    z: 3,
    arm,
    segment: seg,
  });
}

/* ---------------------------------------------------------------- the Witness as a titan (behind `witness=1`) */

/** The rig a Witness fighter is generated with: every painted region (the eye cradle is the fighter's primary body). */
export interface WitnessTitanRig {
  kind: 'witness';
  body: WitnessBody;
  /** Material ids by key (index + 1 of WITNESS_MATERIALS). */
  ids: Record<string, number>;
}

/** True for the Witness's definition (see `witnessDef`). */
export const isWitnessDef = (def: TitanDef): boolean =>
  (def.art.params as { witness?: unknown }).witness === true;

/** Paint the Witness for the titan generator: the eye cradle is the primary map, every region rides in the rig. */
export function paintWitnessTitan(
  _def: TitanDef,
  seed: number,
  lighting: StageLighting,
): { map: MatterMap; rig: WitnessTitanRig } {
  const body = paintWitness(seed, lighting);
  const ids: Record<string, number> = {};
  for (const m of WITNESS_MATERIALS) ids[m.key] = WID(m.key);
  return { map: body.regions[0]!.map, rig: { kind: 'witness', body, ids } };
}

const WITNESS_DEFS = new WeakMap<TitanDef, TitanDef>();

/**
 * The Last One's definition rebuilt as the Witness (the `witness=1` flag; SLICE_PHASE2): the Witness's materials, its eye
 * cradle as the art recipe (the KO core is the pupil), its halo arcs as the resource, and the Witness's six moves (witnessMoves).
 * Cached per source definition.
 */
export function witnessDef(def: TitanDef): TitanDef {
  const hit = WITNESS_DEFS.get(def);
  if (hit) return hit;
  const eye = paintWitness(1, DEFAULT_LIGHTING).regions[0]!.map;
  const w: TitanDef = {
    ...def,
    name: 'The Witness',
    materials: WITNESS_MATERIALS.map((m) => ({ ...m })),
    // the pips count the halo arcs still bound to it (the id stays the contract's 'tendrils': ResourceId is a contract union)
    resource: {
      ...def.resource,
      name: 'Halo',
      nameKo: '후광',
      max: HALO_ARCS.length,
      start: HALO_ARCS.length,
    },
    passive: {
      name: 'Opened Eyes',
      text: 'Where its carapace breaks, inner eyes open. Every open eye adds a beam to its gaze.',
    },
    failureMode: {
      name: 'The Structure Fails',
      text: 'Joints give one by one: a severed arm shortens its reach, a broken halo arc weakens its Guard. The eye goes out last.',
    },
    ui: { ...def.ui, tagline: 'The more it breaks, the more it sees.' },
    moves: witnessMoves(def.moves),
    // D30(3) (S3's balance pass, proposal 164): the Witness's blows carry 3× energy (the knob's ceiling) and it takes blows at
    // 1/2.6, so its heavy moves remove matter per hit within 2× of the Planet's; the Last One's own block is unchanged
    ...({ balance: { power: 3, durability: 2.6 } } as object),
    art: {
      w: eye.w,
      h: eye.h,
      coreX: eye.coreX,
      coreY: eye.coreY,
      coreRadius: eye.coreRadius,
      params: { witness: true },
    },
  };
  // a colossus answers the stick slowly and never overshoots (scale spec: the hanging arms must not be jerked by the root)
  const base = (def as unknown as { feel?: Record<string, unknown> }).feel ?? {};
  (w as unknown as { feel: Record<string, unknown> }).feel = {
    ...base,
    accelMul: 1.9,
    glideMul: 1.5,
    zeta: 0.95,
  };
  WITNESS_DEFS.set(def, w);
  return w;
}

/** Deep copy of a move under a new id (the Witness reuses the Last One's frame data and choreography where they fit). */
function cloneMove(src: MoveDef | undefined, id: string, name: string, nameKo: string): MoveDef {
  if (!src) throw new Error(`witness: base move for '${id}' missing`);
  const m = JSON.parse(JSON.stringify(src)) as MoveDef;
  m.id = id;
  m.name = name;
  m.nameKo = nameKo;
  return m;
}

const emptyVariant = (
  movement: MoveDef['variants']['forward']['movement'],
): MoveDef['variants']['forward'] => ({
  hitboxes: [],
  movement,
});

/**
 * The Witness's kit (SLICE_PHASE2 S2.4). Moves whose reach comes from the body itself carry no JSON hitboxes: the behaviour
 * strikes with the live rig (halo arcs, arm blades, extra gaze angles) through `FighterImpl.strike`, so damage changes the kit
 * (a severed arm no longer sweeps, a broken arc no longer cuts, an opened inner eye adds a beam). `extra.witness` names the
 * behaviour's part of each move.
 */
export function witnessMoves(base: readonly MoveDef[]): MoveDef[] {
  const by = (id: string): MoveDef | undefined => base.find((m) => m.id === id);
  // Strike — HALO SHARDS: the broken halo's arcs swing forward through a lane, one after another
  const halo = cloneMove(by('lastone.lash'), 'witness.halo', 'Halo Shards', '후광 파편');
  halo.frame = { startup: 10, active: 24, recovery: 14, cancelWindow: 0.4, chargeMax: 0, hitstop: 6 };
  for (const a of AIM_DIRS) halo.variants[a] = emptyVariant([{ at: 0, ix: -20, iy: 0, damp: 0.3 }]);
  halo.tags = ['multi'];
  halo.extra = { witness: 'halo', pose: { startup: { lean: -2 }, active: { lean: 3 } } };
  // Crush — SWEEPING ARCHITECTURE (up/forward) / STRUCTURAL SHEAR (down, close range): the whole body turns through a scythe
  // arc on S1's load → commit → re-balance choreography; the arm blades are the hit volumes
  const sweep = cloneMove(by('lastone.shatter'), 'witness.sweep', 'Sweeping Architecture', '휩쓰는 구조');
  sweep.variants.up = emptyVariant(sweep.variants.up.movement);
  sweep.variants.forward = emptyVariant(sweep.variants.forward.movement);
  sweep.extra = { ...(sweep.extra ?? {}), witness: 'sweep', eyeFlare: false };
  // the down aim keeps its close cone and adds the delayed fracture path (the behaviour schedules it)
  sweep.variants.down.hitboxes.forEach((h) => {
    h.id = 'shear';
  });
  // Surge — CHARGE, AND SIDESTEP
  const side = cloneMove(by('lastone.sidestep'), 'witness.sidestep', 'Sidestep', '옆걸음');
  const charge = cloneMove(by('lastone.lunge'), 'witness.charge', 'Charge', '돌진');
  side.extra = {
    ...(side.extra ?? {}),
    followUp: { button: 'strike', from: 6, to: 20, move: 'witness.charge' },
  };
  // a colossus does not dart: the sidestep carries 70% of the Last One's speed (scale spec on the hanging arms)
  for (const a of AIM_DIRS)
    side.variants[a].movement = side.variants[a].movement.map((k) => ({
      ...k,
      ix: k.ix * 0.7,
      iy: k.iy * 0.7,
    }));
  // Signature — FRACTURE GAZE: the held beam marks the foe; each mark shears 0.3–0.8 s later
  const gaze = cloneMove(by('lastone.gaze'), 'witness.gaze', 'Fracture Gaze', '균열의 시선');
  gaze.extra = { ...(gaze.extra ?? {}), witness: 'gaze' };
  // the gaze leaves from the eye itself (the Last One's beam started at a crown above its root): keep each line's direction
  // and length, move its start onto the eye centre (2 px left of and 1 px above the anchor)
  for (const a of AIM_DIRS)
    for (const hb of gaze.variants[a].hitboxes) {
      const s = hb.shape;
      if (s.kind !== 'line') continue;
      const dx = -2 - s.ox0;
      const dy = -1 - s.oy0;
      hb.shape = { ...s, ox0: s.ox0 + dx, oy0: s.oy0 + dy, ox1: s.ox1 + dx, oy1: s.oy1 + dy };
      // from the eye the beam runs through the foe's centre instead of grazing it: 15% of the energy per tick, the
      // rest of the move's damage comes later, from the fractures it leaves (WitnessKit)
      hb.damage = { ...hb.damage, energy: hb.damage.energy * 0.15 };
    }
  // Ultimate — REVELATION: the inner eyes open and a lattice of gazes fans out
  const rev = cloneMove(by('lastone.lastlight'), 'witness.revelation', 'Revelation', '계시');
  for (const a of AIM_DIRS) rev.variants[a] = emptyVariant(rev.variants[a].movement);
  rev.tags = ['ultimate', 'armor'];
  rev.extra = { ...(rev.extra ?? {}), witness: 'revelation', halo: false };
  // Guard — HALO CLOSE: the arcs close into a shield in front; every broken arc weakens it
  const close = cloneMove(by('lastone.guard'), 'witness.close', 'Halo Close', '후광 닫기');
  close.extra = { ...(close.extra ?? {}), witness: 'close' };
  return [halo, sweep, side, charge, gaze, rev, close];
}
