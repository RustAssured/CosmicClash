import {
  Rng,
  clamp,
  clamp01,
  createMatterMap,
  hex,
  lerp,
  smoothstep,
  type MatterMap,
  type StageLighting,
  type TitanDef,
} from '@/contracts';
import { blend } from './color';
import { ArtCanvas, buildLitRamps } from './canvas';
import { keepLargestComponent } from './field';
import { bayer8, fbm, hash01, makeWorley, valueNoise, worley } from './noise';

/**
 * SUPERNOVA — a dying star in convulsions. One continuous gradient (violet shadow → crimson → orange → gold → white → a cool
 * blue-white flash) is laid over a granulated disc: polygonal granules with dark intergranular lanes at two scales (small
 * outside, larger convection cells deeper in), limb darkening, faculae, sunspots with penumbral filaments and a thin
 * chromosphere ring. The disc is built of concentric MATERIALS (photosphere → convective shell → core) whose colours are the
 * same gradient, so stripping the outer layers leaves a smaller, hotter, whiter star. Around it: a violet-white corona of
 * tapered streamers and four arching prominences. The stage light only whispers on the limb: a star lights itself.
 */

export interface SupernovaRig {
  core: { x: number; y: number; r: number };
  /** Photosphere radius, convective-shell radius, hot-core radius (px). */
  radius: number;
  inner: number;
  coreR: number;
  /** Coronal streamers: axis angle, length beyond the photosphere (px) and half-width (rad). */
  streamers: { a: number; len: number; hw: number }[];
  /**
   * Prominences: a `loop` stands on two footpoints (limb angles a0, a1); a `plume` rises from a0 and hooks over toward a1.
   * `h` is the height above the limb and `t` the thickness (px).
   */
  prominences: { kind: 'loop' | 'plume'; a0: number; a1: number; h: number; t: number }[];
  /** Sunspots in map cells. */
  spots: { x: number; y: number; r: number }[];
  ids: { core: number; inner: number; photosphere: number; corona: number; prominence: number };
}

interface P {
  centre: [number, number];
  radius: number;
  inner: number;
  coreR: number;
  grain: number;
  innerGrain: number;
  spots: number;
  gradient: string[];
  streamers: [number, number, number][];
  prominences: { kind: 'loop' | 'plume'; a0: number; a1: number; h: number; t: number }[];
}

const params = (def: TitanDef): P => def.art.params as unknown as P;

const matId = (def: TitanDef, key: string): number => {
  const i = def.materials.findIndex((m) => m.key === key);
  if (i < 0) throw new Error(`supernova: material '${key}' missing`);
  return i + 1;
};

const angDiff = (a: number, b: number): number => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

interface Streamer {
  a: number;
  len: number;
  hw: number;
  bend: number;
  id: number;
}

interface Layout {
  p: P;
  cx: number;
  cy: number;
  rPhoto(theta: number): number;
  streamers: Streamer[];
  spots: { x: number; y: number; r: number }[];
  /** Prominence strands: cubic Bézier control points in map cells (flat x0,y0..x3,y3), thickness at the foot and the tip. */
  arches: { pts: number[]; t0: number; t1: number; strand: number }[];
}

function makeLayout(def: TitanDef, seed: number): Layout {
  const p = params(def);
  const rng = new Rng(seed ^ 0x5a17);
  const cx = p.centre[0];
  const cy = p.centre[1];
  const s1 = (seed & 0xffff) + 31;
  const R = p.radius;

  const rPhoto = (theta: number): number =>
    R * (1 + 0.02 * fbm(Math.cos(theta) * 1.3 + 5, Math.sin(theta) * 1.3 + 5, s1, 2));

  const streamers: Streamer[] = p.streamers.map(([a, len, hw], i) => ({
    a,
    len: len * rng.range(0.92, 1.08),
    hw,
    bend: rng.range(-0.16, 0.16),
    id: i,
  }));

  // sunspots: inside the photosphere, away from the core and the limb, not overlapping
  const spots: Layout['spots'] = [];
  for (let tries = 0; spots.length < p.spots && tries < 200; tries++) {
    const a = rng.range(0, Math.PI * 2);
    const rr = rng.range(0.42, 0.78) * R;
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    const r = rng.range(3.4, 6.8);
    if (spots.some((s) => Math.hypot(s.x - x, s.y - y) < s.r + r + 14)) continue;
    spots.push({ x, y, r });
  }

  // prominences: cubic Béziers standing on the limb. A loop is a braided arch between two footpoints; a plume rises from one
  // foot, leans over and hooks back down, tapering to a wisp. Each gets a finer companion strand so it reads as braided plasma.
  const arches: Layout['arches'] = [];
  for (const pr of p.prominences) {
    const rf = R * 0.93;
    const ux0 = Math.cos(pr.a0);
    const uy0 = Math.sin(pr.a0);
    const x0 = cx + ux0 * rf;
    const y0 = cy + uy0 * rf;
    let pts: number[];
    if (pr.kind === 'loop') {
      const ux1 = Math.cos(pr.a1);
      const uy1 = Math.sin(pr.a1);
      const x3 = cx + ux1 * rf;
      const y3 = cy + uy1 * rf;
      const k = pr.h * 1.34 + (R - rf);
      pts = [x0, y0, x0 + ux0 * k, y0 + uy0 * k, x3 + ux1 * k, y3 + uy1 * k, x3, y3];
    } else {
      // plume: tangent toward the hook side
      const side = Math.sign(pr.a1 - pr.a0) || 1;
      const tx = -uy0 * side;
      const ty = ux0 * side;
      const s = Math.abs(pr.a1 - pr.a0) * R;
      pts = [
        x0,
        y0,
        x0 + ux0 * pr.h * 0.9,
        y0 + uy0 * pr.h * 0.9,
        x0 + ux0 * pr.h * 1.15 + tx * s * 0.55,
        y0 + uy0 * pr.h * 1.15 + ty * s * 0.55,
        x0 + ux0 * pr.h * 0.62 + tx * s,
        y0 + uy0 * pr.h * 0.62 + ty * s,
      ];
    }
    arches.push({ pts, t0: pr.t * 1.35, t1: pr.kind === 'loop' ? pr.t * 1.35 : pr.t * 0.3, strand: 0 });
    // the companion: same path nudged toward the star and a little thinner
    const comp = pts.map(
      (v, i) => (i % 2 === 0 ? v + (cx - v) * 0.1 : v + (cy - v) * 0.1) + (rng.next() - 0.5) * 1.2,
    );
    arches.push({ pts: comp, t0: pr.t * 0.75, t1: pr.kind === 'loop' ? pr.t * 0.75 : pr.t * 0.2, strand: 1 });
  }
  return { p, cx, cy, rPhoto, streamers, spots, arches };
}

export function buildSupernovaRig(def: TitanDef, seed: number): SupernovaRig {
  const L = makeLayout(def, seed);
  const { p } = L;
  return {
    core: { x: def.art.coreX, y: def.art.coreY, r: def.art.coreRadius },
    radius: p.radius,
    inner: p.inner,
    coreR: p.coreR,
    streamers: L.streamers.map((s) => ({ a: s.a, len: s.len, hw: s.hw })),
    prominences: p.prominences.map((q) => ({ ...q })),
    spots: L.spots.map((s) => ({ ...s })),
    ids: {
      core: matId(def, 'core'),
      inner: matId(def, 'inner'),
      photosphere: matId(def, 'photosphere'),
      corona: matId(def, 'corona'),
      prominence: matId(def, 'prominence'),
    },
  };
}

const cub = (a: number, b: number, c: number, d: number, t: number): number => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};

/** Distance from a point to a cubic Bézier (sampled: prominences are short, 56 samples resolve them well under a pixel). */
function distToArch(a: Layout['arches'][number], x: number, y: number, out: { t: number }): number {
  const q = a.pts;
  let best = 1e9;
  let bt = 0;
  const N = 56;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const dx = cub(q[0]!, q[2]!, q[4]!, q[6]!, t) - x;
    const dy = cub(q[1]!, q[3]!, q[5]!, q[7]!, t) - y;
    const d = dx * dx + dy * dy;
    if (d < best) {
      best = d;
      bt = t;
    }
  }
  out.t = bt;
  return Math.sqrt(best);
}

export function paintSupernova(
  def: TitanDef,
  seed: number,
  lighting: StageLighting,
): { map: MatterMap; rig: SupernovaRig } {
  const L = makeLayout(def, seed);
  const rig = buildSupernovaRig(def, seed);
  const ids = rig.ids;
  const { p, cx, cy } = L;
  const W = def.art.w;
  const H = def.art.h;
  const cv = new ArtCanvas(W, H);
  const sA = (seed & 0xfff) + 511;
  const sB = ((seed >>> 12) & 0xfff) + 613;
  const w1 = makeWorley();
  const w2 = makeWorley();
  const arch = { t: 0 };

  /** Corona brightness 0..1 at a cell (−1 = no corona here): a thin bright ring plus tapered, finely-rayed streamers. */
  const corona = (r: number, th: number, rp: number): number => {
    const ringT = 3 + 3.2 * valueNoise(th * 55, 4.4, sA + 71) + 1.4 * valueNoise(th * 17, 9.1, sB + 5);
    const out = r - rp;
    let v = -1;
    if (out <= ringT) v = 0.92 - 0.35 * (out / ringT) + 0.06 * (valueNoise(th * 90, 1.2, sB + 13) - 0.5);
    for (const s of L.streamers) {
      const t = out / s.len;
      if (t <= 0 || t >= 1) continue;
      const ax = s.a + s.bend * t * t;
      const d = angDiff(th, ax);
      const hw = s.hw * (1 - Math.pow(t, 1.35)) * (0.8 + 0.3 * valueNoise(t * 4 + s.id * 3.1, 2.7, sA + 3));
      const rag = 0.1 * (valueNoise(th * 46, t * 7 + s.id, sB + 17) - 0.5);
      if (Math.abs(d) >= hw + rag) continue;
      const u = Math.abs(d) / Math.max(1e-3, hw);
      const stripe = 0.5 + 0.5 * Math.sin((d / hw) * 11 + 4 * valueNoise(t * 5, s.id * 5.5, sA + 29));
      // beyond the first third the streamer parts into separate fibres: dark stripes become gaps
      if (t > 0.34 && stripe < 0.1 + 0.2 * t) continue;
      const b = 0.92 - 0.44 * Math.pow(t, 0.85) - 0.14 * u * u + 0.28 * (stripe - 0.5);
      if (b > v) v = b;
    }
    return v;
  };

  // ---- 1. the mask and the material of every cell -----------------------------------------------------------------------
  const cor = new Float32Array(W * H).fill(-1);
  const hot = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const fx = x + 0.5;
      const fy = y + 0.5;
      const dx = fx - cx;
      const dy = fy - cy;
      const r = Math.hypot(dx, dy);
      const th = Math.atan2(dy, dx);
      const rp = L.rPhoto(th);
      let m = 0;
      if (r <= rp) {
        if (r < p.coreR * (1 + 0.05 * fbm(fx * 0.14, fy * 0.14, sA + 1, 2))) m = ids.core;
        else if (r < p.inner * (1 + 0.04 * fbm(fx * 0.1, fy * 0.1, sA + 2, 2))) m = ids.inner;
        else m = ids.photosphere;
      } else if (r < rp + 60) {
        const c = corona(r, th, rp);
        if (c >= 0) {
          m = ids.corona;
          cor[y * W + x] = c;
        }
      }
      // prominence arches (their feet are sunk into the photosphere, the arch stands over the corona)
      if (r > rp - 4) {
        for (const a of L.arches) {
          const d = distToArch(a, fx, fy, arch);
          const half = 0.5 * lerp(a.t0, a.t1, arch.t) * (1 + 0.12 * Math.sin(arch.t * 11 + a.strand * 2.1));
          const rip = a.strand === 0 ? 0 : Math.sin(arch.t * 19 + a.strand * 2.3) * 0.7;
          if (d - rip < half) {
            m = ids.prominence;
            hot[y * W + x] =
              1 -
              clamp01(d / Math.max(0.6, half)) * 0.6 -
              (a.strand ? 0.12 : 0) -
              0.2 * (1 - arch.t) * (1 - arch.t) * 0 -
              0.1 * Math.abs(arch.t - 0.5);
            break;
          }
        }
      }
      cv.mat[y * W + x] = m;
    }
  }
  keepLargestComponent(cv.mat, W, H);
  cv.invalidate();

  // ---- 2. colour ----------------------------------------------------------------------------------------------------------
  // the star gradient, tinted very lightly by the stage (shadow → ambient, highlight → key): a star lights itself
  const tint = buildLitRamps(
    [{ key: 'g', base: 'plasma', visual: { ramp: p.gradient, emissive: 0, char: '#000', crack: '#000' } }],
    lighting,
    0.2,
  )[1]!;
  const ramps = buildLitRamps(def.materials, lighting, 0.2);
  const colors = new Uint32Array(W * H);
  const dist = cv.distance();
  const rim = hex(lighting.rim);
  const lx = lighting.dir[0];
  const ly = lighting.dir[1];
  const ll = Math.hypot(lx, ly) || 1;

  const pick = (ramp: readonly number[], v: number, x: number, y: number, spread = 0.85): number => {
    const s = clamp(v, 0, 1) * (ramp.length - 1);
    const fl = Math.floor(s);
    const fr = s - fl;
    const idx = fl + (fr > 0.5 + (bayer8(x, y) - 0.5) * spread ? 1 : 0);
    return ramp[Math.min(ramp.length - 1, Math.max(0, idx))]!;
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const m = cv.mat[i]!;
      if (m === 0) continue;
      const fx = x + 0.5;
      const fy = y + 0.5;
      const dx = fx - cx;
      const dy = fy - cy;
      const r = Math.hypot(dx, dy);
      const th = Math.atan2(dy, dx);
      const rp = L.rPhoto(th);
      const u = r / rp;
      let rel = Math.sqrt(Math.max(0, 1 - clamp01(u) * clamp01(u))) * 30;

      if (m === ids.photosphere || m === ids.inner || m === ids.core) {
        // depth profile: hottest (whitest) at the centre, limb-darkened toward the edge
        let v = 0.72 - 0.4 * Math.pow(clamp01(u), 1.4);
        // granulation: Voronoi polygons — dark lanes where two cells meet, per-cell brightness, a soft gradient inside each
        worley(fx / p.grain, fy / p.grain, sA + 40, w1, 0.94);
        worley(fx / p.innerGrain, fy / p.innerGrain, sA + 90, w2, 0.9);
        const laneA = smoothstep(0.02, 0.3, w1.f2 - w1.f1);
        const laneB = smoothstep(0.02, 0.26, w2.f2 - w2.f1);
        const cellA = (laneA - 0.5) * 0.62 + (w1.id - 0.5) * 0.34 + (0.36 - w1.f1) * 0.34;
        const cellB = (laneB - 0.5) * 0.5 + (w2.id - 0.5) * 0.3 + (0.5 - w2.f1) * 0.24;
        const wB = smoothstep(0.78, 0.36, u);
        const amp = lerp(0.2, 0.13, wB);
        v += amp * lerp(cellA, cellB, wB);
        v += 0.07 * fbm(fx * 0.045, fy * 0.045, sA + 5, 3);
        if (m === ids.photosphere) {
          // faculae hugging the limb
          const fac =
            smoothstep(0.68, 0.9, fbm(fx * 0.11 + 4, fy * 0.11 - 2, sB + 9, 3)) * smoothstep(0.6, 0.95, u);
          v += 0.22 * fac;
          // sunspots: umbra and a penumbra of radial filaments
          for (const s of L.spots) {
            const d = Math.hypot(fx - s.x, fy - s.y);
            if (d > s.r * 2.4) continue;
            const ang = Math.atan2(fy - s.y, fx - s.x);
            const fil = 0.5 + 0.5 * valueNoise(ang * 7, d * 0.22, sA + 11);
            if (d < s.r) {
              v = 0.05 + 0.1 * fil;
              rel -= 5;
            } else if (d < s.r * (1.7 + 0.4 * fil)) {
              v = Math.min(v, 0.26 + 0.2 * fil);
              rel -= 2;
            }
          }
          // chromosphere: a thin hot ring right at the limb
          if (dist[i]! <= 1.7 && u > 0.93) v = Math.max(v, 0.5 + 0.1 * hash01(x, y, sA));
        }
        if (m === ids.core) {
          // white-hot at the heart, the blue-white flash on the top of the gradient at the very centre
          const q = clamp01(r / p.coreR);
          v = Math.max(v, 0.9 - 0.42 * q * q - 0.26 * clamp01(q * 1.6 - 0.2));
          rel = 20 + (1 - q) * 6;
        }
        rel += 3.2 * (laneA - 0.5);
        colors[i] = pick(tint, v, x, y, 0.8);
      } else if (m === ids.prominence) {
        const a = hot[i]!;
        const flick = fbm(fx * 0.22, fy * 0.22, sB + 21, 2);
        colors[i] = pick(ramps[m]!, 0.4 + 0.52 * a + 0.16 * flick, x, y, 0.6);
        rel = 6 + a * 4;
      } else {
        const c = cor[i]!;
        const sparkle = hash01(x, y, sB + 8) > 0.97 ? 0.22 : 0;
        colors[i] = pick(
          ramps[m]!,
          c + sparkle + 0.05 * (fbm(fx * 0.2, fy * 0.2, sB + 3, 2) - 0.1),
          x,
          y,
          0.95,
        );
        rel = 4 * c;
      }
      cv.relief[i] = Math.max(0.3, rel);
      // a whisper of the stage light on the limb that faces it
      if (m !== ids.corona && dist[i]! <= 2.4) {
        const nx = dx / (r || 1);
        const ny = dy / (r || 1);
        const facing = clamp01((nx * lx + ny * ly) / ll);
        if (facing > 0.4)
          colors[i] = blend(colors[i]!, rim, 0.14 * smoothstep(0.4, 1, facing) * (dist[i]! <= 1.6 ? 1 : 0.5));
      }
    }
  }

  // ---- 3. write the map ---------------------------------------------------------------------------------------------------
  const map = createMatterMap(W, H);
  cv.writeTo(map, colors, () => 128);
  map.coreX = def.art.coreX;
  map.coreY = def.art.coreY;
  map.coreRadius = def.art.coreRadius;
  return { map, rig };
}

/** Per-cell granule data for the live granulation animation: which granule a cell belongs to and how strongly it may flicker. */
export interface SupernovaGranules {
  /** Granule id 0..255 (a random phase per granule; cells of one granule pulse together). */
  phase: Uint8Array;
  /** 0..255: how much the cell takes part (0 in lanes' cores, sunspots, the corona and prominences). */
  weight: Uint8Array;
}

const GRANULE_CACHE = new Map<string, SupernovaGranules>();

/** Recompute the granule field of a painted star (same seeds as `paintSupernova`, so the animation lines up with the painted granules). */
export function supernovaGranules(def: TitanDef, seed: number): SupernovaGranules {
  const key = `${def.id}|${seed >>> 0}`;
  const hit = GRANULE_CACHE.get(key);
  if (hit) return hit;
  const L = makeLayout(def, seed);
  const { p, cx, cy } = L;
  const rig = buildSupernovaRig(def, seed);
  const W = def.art.w;
  const H = def.art.h;
  const sA = (seed & 0xfff) + 511;
  const w1 = makeWorley();
  const phase = new Uint8Array(W * H);
  const weight = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const fx = x + 0.5;
      const fy = y + 0.5;
      const dx = fx - cx;
      const dy = fy - cy;
      const r = Math.hypot(dx, dy);
      const rp = L.rPhoto(Math.atan2(dy, dx));
      if (r > rp || r < p.coreR * 0.9) continue;
      worley(fx / p.grain, fy / p.grain, sA + 40, w1, 0.94);
      const lane = smoothstep(0.02, 0.3, w1.f2 - w1.f1);
      let k = lane * (0.35 + 0.65 * (1 - clamp01(r / rp) ** 1.4));
      for (const s of rig.spots) if (Math.hypot(fx - s.x, fy - s.y) < s.r * 2.1) k = 0;
      phase[y * W + x] = Math.round(w1.id * 255);
      weight[y * W + x] = Math.round(k * 255);
    }
  const out = { phase, weight };
  if (GRANULE_CACHE.size >= 4) GRANULE_CACHE.delete(GRANULE_CACHE.keys().next().value as string);
  GRANULE_CACHE.set(key, out);
  return out;
}
