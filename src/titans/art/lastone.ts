import {
  Rng,
  clamp,
  clamp01,
  createMatterMap,
  hex,
  lerp,
  mix,
  rgba,
  smoothstep,
  type MatterMap,
  type StageLighting,
  type TitanDef,
} from '@/contracts';
import { ArtCanvas, buildLitRamps, type ShadeParams } from './canvas';
import { edt } from './field';
import { bayer8, fbm, hash01, makeWorley, ridged, worley } from './noise';
import { sdCircle, sdEllipse, sdEllipseRot, sdSegment, smax, smin, ssub } from './sdf';

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
    const lenBase = kind === 'front' ? 0.55 : kind === 'crown' ? 0.62 : kind === 'hem' ? 0.95 : 0.85;
    const len = clamp(
      lerp(p.tendrils.minLen, p.tendrils.maxLen, lenBase * (0.75 + 0.25 * rng.next())),
      p.tendrils.minLen,
      p.tendrils.maxLen,
    );
    roots.push({ x, y, nx, ny, len, phase: rng.next(), kind });
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
        const warpA = 0.28 * Math.sin(rho / 15 + (L.seed & 255) * 0.05) + 0.16 * fbm(fx * 0.04, fy * 0.04, sA + 9, 2);
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
        if (rho > eyeR + 0.5 && rho < sockR + 0.5 && rho >= sockR - 1.1 && hash01(Math.floor(th * 14), 3, sA) > 0.22)
          m = ids.gilt;
        if (rho <= eyeR + 0.5) {
          const q = rho / eyeR;
          const upper = sdCircle(fx, fy, ex0, ey0 + 9.5, eyeR * 0.98);
          const lower = sdCircle(fx, fy, ex0, ey0 - 11.5, eyeR * 0.98);
          if (upper > 0 || lower > 0) {
            m = ids.shell;
            rel = 12 + 3 * (1 - q) + (upper > 0 ? 2.2 : 0);
            tone += 0.2;
          } else {
            rel = 9 + 7.5 * (1 - q * q);
            m = q > 0.78 ? ids.eye : q > 0.29 ? ids.iris : ids.pupil;
            if (m === ids.eye) tone = 0.6 - (q - 0.78) * 4;
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
  bleedCoreLight(cv, colors, L, def, ids);
  paintEye(cv, colors, L, def, lighting, ids);
  paintCore(cv, colors, L, def, ids);
  paintHaloDetail(cv, colors, L, def, ids, seed);

  const map = createMatterMap(W, H);
  cv.writeTo(map, colors, (m) => (m === ids.core ? 170 : m === ids.inner ? 118 : m === ids.gilt ? 150 : 128));
  map.coreX = Math.round(L.coreX);
  map.coreY = Math.round(L.coreY);
  map.coreRadius = p.core.r;
  return { map, rig };
}

/** Warm light leaking from the core through the glaze: quantised to three tints so the palette stays clean. */
function bleedCoreLight(cv: ArtCanvas, colors: Uint32Array, L: Layout, def: TitanDef, ids: LastOneRig['ids']): void {
  const W = cv.w;
  const warm = hex('#ffd98a');
  const R = L.p.core.r;
  void def;
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
      if (q > 0) colors[i] = mix(colors[i]!, warm, q);
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
        const shade = clamp01(0.6 - (q - 0.78) * 1.2 - (dy < 0 ? (-dy / R) * 0.35 : 0));
        const k = clamp(Math.round(1 + shade * 4.4), 1, 5);
        c = eyeRamp[hash01(Math.floor(x / 2), Math.floor(y / 2), 77) > 0.9 ? Math.max(0, k - 1) : k]!;
      } else if (m === ids.pupil) {
        c = pupilRamp[q < 0.16 ? 0 : q < 0.24 ? 1 : 2]!;
      } else if (q > 0.7) {
        c = iris[1]!; // limbal ring, deep teal
      } else {
        // iris: radial fibres, teal → jade → gold near the pupil, lit from within on the lower half
        const t = (q - 0.29) / (0.7 - 0.29);
        const fibre = ridged(th * 4.2 + 3, q * 6, 991, 2);
        const fleck = hash01(Math.floor(th * 9), Math.floor(q * 12), 313) > 0.86;
        const k = clamp(5 - t * 3.6 + (fibre - 0.5) * 1.6 + (dy > 0 ? 0.6 : -0.5), 1, 6);
        c = iris[Math.round(k)]!;
        if (t < 0.28) c = mix(c, gold, 0.75 - t * 1.5);
        if (fleck && t < 0.75 && t > 0.15) c = mix(c, goldHi, 0.65);
      }
      if (dx + dy < -R * 0.5 && q < 0.9) c = mix(c, key, 0.1);
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
  hl(6, 6, 2, 1, mix(white, iris[5]!, 0.45));
  hl(5, 7, 1, 1, mix(white, iris[5]!, 0.45));
  // the upper lid throws a shadow line onto the eyeball
  for (let x = Math.floor(ex - R); x <= Math.ceil(ex + R); x++) {
    for (let y = Math.floor(ey - R); y <= ey; y++) {
      const i = y * W + x;
      if (cv.mat[i] !== ids.eye && cv.mat[i] !== ids.iris) continue;
      if (cv.mat[(y - 1) * W + x] === ids.shell) colors[i] = mix(colors[i]!, iris[0]!, 0.7);
    }
  }
}

function paintCore(cv: ArtCanvas, colors: Uint32Array, L: Layout, def: TitanDef, ids: LastOneRig['ids']): void {
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
          colors[i] = big && edge <= 1 ? mix(gilt[4]!, gilt[5]!, 0.5) : edge >= 2 ? gilt[1]! : gilt[3]!;
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
    const idx = (Math.floor(((g + 0.5) / 4) * L.haloPts.length + rng.range(-2, 2)) + L.haloPts.length) % L.haloPts.length;
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
