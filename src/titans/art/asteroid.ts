import {
  Rng,
  clamp,
  clamp01,
  createMatterMap,
  hex,
  type MatterMap,
  type StageLighting,
  type TitanDef,
} from '@/contracts';
import { ArtCanvas, buildLitRamps, type ShadeParams } from './canvas';
import { edt, keepLargestComponent } from './field';
import { bayer4, fbm, hash01, makeWorley, ridged, worley } from './noise';
import { sdCircle, sdEllipse, sdTaperedCapsule, smax, smin, ssub } from './sdf';

/**
 * THE ASTEROID — an iron-nickel wanderer. Faceted silhouette with a horn-like prow and a few silhouette-breaking crags;
 * a pitted regolith skin over a Widmanstätten basket-weave of kamacite/taenite lamellae (domain patches, each with its own
 * crystal orientation), winding ice veins that glint cyan, pallasite olivine gems, and a dense copper-gold core.
 * Impact craters are relief bowls whose floors expose bare metal.
 */

export interface AsteroidRig {
  core: { x: number; y: number; r: number };
  /** Mean body radius in px (pebbles orbit outside it). */
  radius: number;
  /** Prow tip in map cells (where the ram lands). */
  prow: { x: number; y: number };
  ids: { regolith: number; kamacite: number; taenite: number; ice: number; olivine: number; dense: number };
}

interface Crag {
  ax: number;
  ay: number;
  ra: number;
  bx: number;
  by: number;
  rb: number;
}

interface P {
  centre: [number, number];
  body: { rx: number; ry: number };
  facets: number;
  crags: Crag[];
  craters: number;
  bites: number;
  veins: number;
  olivine: number;
  core: { x: number; y: number; r: number };
  pebbles: number;
}

const params = (def: TitanDef): P => def.art.params as unknown as P;

const matId = (def: TitanDef, key: string): number => {
  const i = def.materials.findIndex((m) => m.key === key);
  if (i < 0) throw new Error(`asteroid: material '${key}' missing`);
  return i + 1;
};

interface Crater {
  x: number;
  y: number;
  r: number;
}

interface Layout {
  p: P;
  cx: number;
  cy: number;
  sd(x: number, y: number): number;
  craters: Crater[];
  olivine: { x: number; y: number; r: number; rot: number }[];
  /** Ice vein polylines: flat [x, y, halfWidth, …]. */
  veins: number[][];
}

function makeLayout(def: TitanDef, seed: number): Layout {
  const p = params(def);
  const rng = new Rng(seed ^ 0xa57e);
  const cx = p.centre[0];
  const cy = p.centre[1];
  const s1 = (seed & 0xffff) + 5;
  const s2 = ((seed >>> 9) & 0xffff) + 17;
  const meanR = (p.body.rx + p.body.ry) / 2;

  // flat facets: half-planes shaving the blob into a rough polyhedron
  const planes: { nx: number; ny: number; d: number }[] = [];
  const nf = p.facets;
  for (let k = 0; k < nf; k++) {
    const a = ((k + rng.range(-0.28, 0.28)) / nf) * Math.PI * 2;
    planes.push({ nx: Math.cos(a), ny: Math.sin(a), d: meanR * rng.range(0.86, 1.02) });
  }
  const crags = p.crags.map((c) => ({
    ...c,
    ra: c.ra * rng.range(0.9, 1.1),
    by: c.by + rng.range(-3, 3),
  }));

  const base = (x: number, y: number): number => {
    const wx = x + fbm(x * 0.05, y * 0.05, s1, 3) * 4.5;
    const wy = y + fbm(x * 0.05 + 3.7, y * 0.05 + 9.1, s2, 3) * 4.5;
    let d = sdEllipse(wx, wy, cx, cy, p.body.rx, p.body.ry);
    for (const pl of planes) d = smax(d, (wx - cx) * pl.nx + (wy - cy) * pl.ny - pl.d, 2.5);
    for (const c of crags)
      d = smin(d, sdTaperedCapsule(wx, wy, cx + c.ax, cy + c.ay, c.ra, cx + c.bx, cy + c.by, c.rb), 8);
    return d;
  };
  // bites nibbled from the silhouette (big impact scoops), centred exactly ON the outline; the prow tip stays clean
  const bites: Crater[] = [];
  for (let i = 0; i < p.bites; i++) {
    const a = rng.range(-Math.PI, Math.PI);
    if (Math.abs(a) < 0.35) continue;
    let r = 12;
    while (r < 120 && base(cx + Math.cos(a) * r, cy + Math.sin(a) * r) < 0) r += 0.5;
    bites.push({ x: cx + Math.cos(a) * (r - 0.5), y: cy + Math.sin(a) * (r - 0.5), r: rng.range(4.5, 8) });
  }
  const sd = (x: number, y: number): number => {
    let d = base(x, y);
    for (const b of bites) d = ssub(d, sdCircle(x, y, b.x, b.y, b.r), 2.2);
    return d;
  };

  // surface craters (relief bowls): centres chosen inside the body, away from the edge, not on the core
  const craters: Crater[] = [];
  for (let tries = 0; craters.length < p.craters && tries < 200; tries++) {
    const x = cx + rng.range(-38, 38);
    const y = cy + rng.range(-34, 34);
    const r = rng.range(5, 12);
    if (sd(x, y) > -r - 3) continue;
    if (Math.hypot(x - (cx + p.core.x), y - (cy + p.core.y)) < p.core.r + r) continue;
    if (craters.some((c) => Math.hypot(c.x - x, c.y - y) < c.r + r + 3)) continue;
    craters.push({ x, y, r });
  }
  // olivine (pallasite) gems inside the metal
  const olivine: Layout['olivine'] = [];
  for (let tries = 0; olivine.length < p.olivine && tries < 300; tries++) {
    const x = cx + rng.range(-36, 36);
    const y = cy + rng.range(-32, 32);
    const r = rng.range(2.4, 4.6);
    if (sd(x, y) > -r - 8) continue;
    if (Math.hypot(x - (cx + p.core.x), y - (cy + p.core.y)) < p.core.r + r + 3) continue;
    if (craters.some((c) => Math.hypot(c.x - x, c.y - y) < c.r + r + 1)) continue;
    if (olivine.some((o) => Math.hypot(o.x - x, o.y - y) < o.r + r + 5)) continue;
    olivine.push({ x, y, r, rot: rng.range(0, Math.PI) });
  }

  // ice veins: meandering random walks that start at the surface and wander inward, with a branch or two
  const veins: number[][] = [];
  const walk = (x0: number, y0: number, h0: number, len: number, w0: number, depth: number): void => {
    const path: number[] = [];
    let x = x0;
    let y = y0;
    let h = h0;
    let turn = 0;
    for (let s = 0; s < len; s++) {
      turn = turn * 0.9 + rng.range(-0.1, 0.1);
      h += turn;
      x += Math.cos(h) * 2.6;
      y += Math.sin(h) * 2.6;
      const t = s / len;
      path.push(x, y, w0 * (1 - 0.55 * t));
      if (depth === 0 && s === Math.floor(len * 0.45))
        walk(x, y, h + rng.range(0.7, 1.2) * (rng.chance(0.5) ? 1 : -1), Math.floor(len * 0.5), w0 * 0.6, 1);
      if (sd(x, y) > -1 && s > 6) break;
    }
    veins.push(path);
  };
  for (let v = 0; v < p.veins; v++) {
    const a = rng.range(0, Math.PI * 2);
    let r = 10;
    while (r < 100 && sd(cx + Math.cos(a) * r, cy + Math.sin(a) * r) < 0) r += 0.5;
    const sx = cx + Math.cos(a) * (r - 5);
    const sy = cy + Math.sin(a) * (r - 5);
    walk(sx, sy, a + Math.PI + rng.range(-0.7, 0.7), rng.intRange(20, 30), 1.7, 0);
  }
  return { p, cx, cy, sd, craters, olivine, veins };
}

export function buildAsteroidRig(def: TitanDef, seed: number): AsteroidRig {
  const L = makeLayout(def, seed);
  const { p } = L;
  // prow tip: march along +x from the crag base until outside
  let x = L.cx + p.crags[0]!.ax;
  const y = L.cy + p.crags[0]!.ay - 3;
  while (x < L.cx + 90 && L.sd(x, y) < 0) x += 0.5;
  return {
    core: { x: L.cx + p.core.x, y: L.cy + p.core.y, r: p.core.r },
    radius: (p.body.rx + p.body.ry) / 2,
    prow: { x, y },
    ids: {
      regolith: matId(def, 'regolith'),
      kamacite: matId(def, 'kamacite'),
      taenite: matId(def, 'taenite'),
      ice: matId(def, 'ice'),
      olivine: matId(def, 'olivine'),
      dense: matId(def, 'dense'),
    },
  };
}

export function paintAsteroid(
  def: TitanDef,
  seed: number,
  lighting: StageLighting,
): { map: MatterMap; rig: AsteroidRig } {
  const L = makeLayout(def, seed);
  const rig = buildAsteroidRig(def, seed);
  const ids = rig.ids;
  const { p } = L;
  const W = def.art.w;
  const H = def.art.h;
  const cv = new ArtCanvas(W, H);
  const sA = (seed & 0xfff) + 301;
  const sB = ((seed >>> 12) & 0xfff) + 407;
  const w1 = makeWorley();
  const w2 = makeWorley();

  const mask = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) if (L.sd(x + 0.5, y + 0.5) < 0) mask[y * W + x] = 1;
  keepLargestComponent(mask, W, H);
  const dist = edt(mask, W, H, false);
  const coreX = L.cx + p.core.x;
  const coreY = L.cy + p.core.y;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (mask[i] === 0) continue;
      const fx = x + 0.5;
      const fy = y + 0.5;
      const d = dist[i]!;
      const skinT = 3.6 + fbm(fx * 0.13, fy * 0.13, sA, 2) * 1.6 + hash01(x, y, sA) * 0.6;
      let m: number;
      let tone = (hash01(x, y, sB) - 0.5) * 0.5;
      let rel: number;

      // --- relief: dome + faceted planes (per Voronoi patch tilt) + rocky noise ---
      worley(fx / 30, fy / 30, sA + 40, w1, 0.9);
      const tiltA = (hash01(Math.floor(w1.px * 7), Math.floor(w1.py * 7), 11) - 0.5) * 0.5;
      const tiltB = (hash01(Math.floor(w1.px * 7), Math.floor(w1.py * 7), 12) - 0.5) * 0.5;
      rel =
        15 * Math.sqrt(clamp01(d / 24)) +
        tiltA * (fx - w1.px * 30) +
        tiltB * (fy - w1.py * 30) +
        fbm(fx * 0.09, fy * 0.09, sB, 3) * 2.4 +
        ridged(fx * 0.05, fy * 0.05, sA + 3, 3) * 3;

      if (d < skinT) {
        // pitted regolith skin
        m = ids.regolith;
        tone += fbm(fx * 0.25, fy * 0.25, sB + 2, 2) * 1.1;
        if (hash01(x, y, sA + 9) > 0.93) tone -= 1.2; // pits
        if (hash01(x, y, sA + 19) > 0.97) tone += 1.6; // sparkling grains
      } else {
        // Widmanstätten basket-weave: Voronoi domains, two lamellar families each
        worley(fx / 34, fy / 34, sB + 60, w2, 0.95);
        const th = w2.id * Math.PI;
        const c1 = Math.cos(th);
        const s1 = Math.sin(th);
        const c2 = Math.cos(th + 1.15);
        const s2 = Math.sin(th + 1.15);
        const per = 6.2 + w2.id * 2.6;
        const u1 = (fx * c1 + fy * s1) / per;
        const u2 = (fx * c2 + fy * s2) / (per * 1.3);
        const b1 = Math.abs(u1 - Math.floor(u1) - 0.5);
        const b2 = Math.abs(u2 - Math.floor(u2) - 0.5);
        const kam = b1 < 0.3 || b2 < 0.12;
        m = kam ? ids.kamacite : ids.taenite;
        tone += kam ? 0.5 : -0.5;
        tone += (w2.id - 0.5) * 0.9;
        if ((w2.f2 - w2.f1) * 34 < 1.1) {
          m = ids.taenite;
          tone -= 1.4; // domain boundaries
          rel -= 0.8;
        }
      }
      cv.mat[i] = m;
      cv.relief[i] = Math.max(0.3, rel);
      cv.tone[i] = tone;
    }
  }

  // craters: relief bowls with a raised lip; floors expose bare metal
  for (const c of L.craters) {
    const R = c.r;
    for (let y = Math.floor(c.y - R - 3); y <= Math.ceil(c.y + R + 3); y++) {
      for (let x = Math.floor(c.x - R - 3); x <= Math.ceil(c.x + R + 3); x++) {
        const i = y * W + x;
        if (mask[i] === 0) continue;
        const dd = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y);
        const q = dd / R;
        if (q < 1) {
          cv.relief[i] = cv.relief[i]! - (1 - q * q) * (1.4 + R * 0.26);
          if (q < 0.72 && cv.mat[i] === ids.regolith) {
            const wob = hash01(x >> 1, y >> 1, 5);
            cv.mat[i] = wob > 0.5 ? ids.kamacite : ids.taenite;
          }
        } else if (q < 1.3) {
          cv.relief[i] = cv.relief[i]! + (1.3 - q) * 6; // raised lip
        }
      }
    }
  }
  // ice veins (only where there is metal under the skin)
  for (const path of L.veins) {
    for (let k = 0; k + 5 < path.length; k += 3) {
      const ax = path[k]!;
      const ay = path[k + 1]!;
      const bx = path[k + 3]!;
      const by = path[k + 4]!;
      const hw = path[k + 2]!;
      for (let y = Math.floor(Math.min(ay, by) - hw - 2); y <= Math.ceil(Math.max(ay, by) + hw + 2); y++) {
        for (let x = Math.floor(Math.min(ax, bx) - hw - 2); x <= Math.ceil(Math.max(ax, bx) + hw + 2); x++) {
          const i = y * W + x;
          if (mask[i] === 0 || dist[i]! < 4.5) continue;
          if (sdTaperedCapsule(x + 0.5, y + 0.5, ax, ay, hw, bx, by, path[k + 5]!) < 0) {
            cv.mat[i] = ids.ice;
            cv.relief[i] = cv.relief[i]! - 0.9;
          }
        }
      }
    }
  }
  // olivine gems
  for (const o of L.olivine) {
    for (let y = Math.floor(o.y - o.r - 2); y <= Math.ceil(o.y + o.r + 2); y++) {
      for (let x = Math.floor(o.x - o.r - 2); x <= Math.ceil(o.x + o.r + 2); x++) {
        const i = y * W + x;
        if (mask[i] === 0) continue;
        const dx = x + 0.5 - o.x;
        const dy = y + 0.5 - o.y;
        const c = Math.cos(o.rot);
        const s = Math.sin(o.rot);
        const px = dx * c + dy * s;
        const py = -dx * s + dy * c;
        // hexagon-ish gem
        const hexd = Math.max(Math.abs(px) * 0.9 + Math.abs(py) * 0.5, Math.abs(py));
        if (hexd < o.r) {
          cv.mat[i] = ids.olivine;
          cv.relief[i] = 7 + (o.r - hexd) * 0.8;
          // three cut facets: light upper-left, mid right, dark lower
          const fa = Math.atan2(py, px);
          cv.tone[i] = (fa < -0.4 ? 1.6 : fa < 1.9 ? 0.2 : -1.4) + (hexd > o.r - 1 ? -0.6 : 0);
        }
      }
    }
  }
  // dense core (core–mantle boundary drawn as a dark taenite ring)
  const CR = p.core.r;
  for (let y = Math.floor(coreY - CR - 4); y <= Math.ceil(coreY + CR + 4); y++) {
    for (let x = Math.floor(coreX - CR - 4); x <= Math.ceil(coreX + CR + 4); x++) {
      const i = y * W + x;
      if (mask[i] === 0) continue;
      const r = Math.hypot(x + 0.5 - coreX, y + 0.5 - coreY);
      const rr = CR + fbm((x + 0.5) * 0.25, (y + 0.5) * 0.25, sA + 77, 2) * 1.3;
      if (r < rr) {
        cv.mat[i] = ids.dense;
        cv.relief[i] = 9 + (1 - r / CR) * 4;
        cv.tone[i] = 0;
      } else if (r < rr + 1.6) {
        cv.mat[i] = ids.taenite;
        cv.tone[i] = -1.6;
      }
    }
  }
  cv.invalidate();

  const ramps = buildLitRamps(def.materials, lighting, 0.9);
  const shade: (Partial<ShadeParams> | undefined)[] = [];
  shade[ids.regolith] = { contrast: 1.25, dither: 0.7, ao: 1, bayer8: true };
  shade[ids.kamacite] = { contrast: 1.3, dither: 0.35, ao: 0.8 };
  shade[ids.taenite] = { contrast: 1.3, dither: 0.35, ao: 0.8 };
  shade[ids.ice] = { contrast: 1.4, dither: 0.3, rim: 0.3, outline: 0.3 };
  shade[ids.olivine] = { contrast: 0.9, dither: 0, rim: 0, outline: 0.7, ao: 0 };
  shade[ids.dense] = { contrast: 1.2, dither: 0.4 };
  const colors = cv.render({ ramps, params: shade, lighting, rimMix: 0.22 });

  paintIce(cv, colors, def, ids);
  paintCore(cv, colors, def, ids, coreX, coreY, CR);

  keepLargestComponent(cv.mat, W, H);
  const map = createMatterMap(W, H);
  cv.writeTo(map, colors, (m) =>
    m === ids.dense ? 205 : m === ids.ice ? 92 : m === ids.regolith ? 122 : 130,
  );
  map.coreX = Math.round(coreX);
  map.coreY = Math.round(coreY);
  map.coreRadius = CR;
  return { map, rig };
}

/** Ice: bright glassy veins, brightest on the lit (upper-left) flank, with a hot white spine. */
function paintIce(cv: ArtCanvas, colors: Uint32Array, def: TitanDef, ids: AsteroidRig['ids']): void {
  const W = cv.w;
  const ramp = def.materials[ids.ice - 1]!.visual.ramp.map(hex);
  for (let y = 1; y < cv.h - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (cv.mat[i] !== ids.ice) continue;
      // neighbours that are also ice: interior of the vein is brighter
      let n = 0;
      for (const o of [-1, 1, -W, W]) if (cv.mat[i + o] === ids.ice) n++;
      const sparkle = hash01(x, y, 4242) > 0.9 ? 1 : 0;
      const k = clamp(2 + n * 0.7 + sparkle + (cv.tone[i]! > 0 ? 0.5 : 0), 1, 5);
      colors[i] = ramp[Math.round(k)]!;
    }
  }
}

function paintCore(
  cv: ArtCanvas,
  colors: Uint32Array,
  def: TitanDef,
  ids: AsteroidRig['ids'],
  cx: number,
  cy: number,
  R: number,
): void {
  const W = cv.w;
  const ramp = def.materials[ids.dense - 1]!.visual.ramp.map(hex);
  for (let y = Math.floor(cy - R - 3); y <= Math.ceil(cy + R + 3); y++) {
    for (let x = Math.floor(cx - R - 3); x <= Math.ceil(cx + R + 3); x++) {
      const i = y * W + x;
      if (cv.mat[i] !== ids.dense) continue;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const r = Math.hypot(dx, dy) / R;
      // metallic sphere: light from the upper left, warm bounce below
      // sphere shading: key from the upper left, warm bounce from below right, dark limb
      const nz = Math.sqrt(Math.max(0, 1 - r * r));
      const diff = clamp01((-dx / R) * 0.55 + (-dy / R) * 0.55 + nz * 0.62);
      const bounce = clamp01((dx / R + dy / R) * 0.35) * 0.35;
      let k = 0.5 + diff * 3.2 + bounce + fbm(x * 0.3, y * 0.3, 555, 2) * 0.35;
      k *= 1 - 0.4 * clamp01((r - 0.78) / 0.22);
      k = clamp(k, 0, 5);
      const fl = Math.floor(k);
      const fr = k - fl;
      colors[i] = ramp[Math.min(5, fl + (fr > 0.5 + (bayer4(x, y) - 0.5) * 0.5 ? 1 : 0))]!;
      if (nz > 0.72 && dx < 0 && dy < 0 && Math.hypot(dx + R * 0.32, dy + R * 0.36) < R * 0.17)
        colors[i] = ramp[5]!;
    }
  }
}
