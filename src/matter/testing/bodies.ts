import {
  DEFAULT_LIGHTING,
  createMatterMap,
  hueShiftRamp,
  toHex,
  type BodySpec,
  type BodyTransform,
  type MaterialDef,
  type MaterialSpec,
  type MatterMap,
  type StageLighting,
  type TitanAttributes,
} from '@/contracts';
import { buildMaterialTable } from '../materials';
import { noise2, valueNoise } from '../util';

/**
 * Synthetic test bodies (the real titan generators come from B3). They are authored with the same contract a generator
 * has — material ids per cell, density, baseColor lit from a height field, core anchor — and are good enough looking
 * that damage reads at a glance in the dev sandbox. Layered disc (crust/mantle/core with faults), ribbed slab, sparse
 * lattice, gas-shrouded planet, bridge, star and black hole.
 */

export interface TestBody {
  spec: BodySpec;
  materials: MaterialDef[];
  map: MatterMap;
  /** Material id by key for convenience in tests. */
  id: Record<string, number>;
}

export interface TestBodyOpts {
  seed?: number;
  /** Radius / half-size in cells (default depends on the body). */
  size?: number;
  lighting?: StageLighting;
  x?: number;
  y?: number;
  facing?: 1 | -1;
  attributes?: Partial<TitanAttributes>;
  ownerSlot?: 0 | 1 | -1;
}

const ramp = (hue: number, sat: number, steps = 6, lMin = 0.1, lMax = 0.9): string[] =>
  hueShiftRamp(hue, sat, steps, { lMin, lMax }).map(toHex);

function mat(
  key: string,
  base: string,
  hue: number,
  sat: number,
  extra: Partial<MaterialSpec['visual']> = {},
  physics?: MaterialSpec['physics'],
): MaterialSpec {
  const r = ramp(hue, sat);
  return {
    key,
    base,
    physics,
    visual: {
      ramp: r,
      emissive: 0,
      char: '#141013',
      crack: toHex(hueShiftRamp(hue, sat * 0.6, 3, { lMin: 0.03, lMax: 0.12 })[0]!),
      ...extra,
    },
  };
}

export const defaultAttributes = (o: Partial<TitanAttributes> = {}): TitanAttributes => ({
  mass: 5,
  cohesion: 6,
  heat: 5,
  gravity: 3,
  reach: 5,
  tempo: 5,
  ...o,
});

/** Working buffers for the generator. */
interface Canvas {
  w: number;
  h: number;
  map: MatterMap;
  /** Height in 0..1 floats before quantisation. */
  hf: Float32Array;
}

function newCanvas(w: number, h: number): Canvas {
  return { w, h, map: createMatterMap(w, h), hf: new Float32Array(w * h) };
}

/**
 * Light the height field and colour every live cell from its material ramp: lambert from the height gradient, ordered
 * dither between ramp steps, rim highlight/shadow on the outline. This is the "generator" shading damage later re-uses.
 */
function shade(c: Canvas, mats: MaterialDef[], light: StageLighting, seed: number, contrast = 1): void {
  const { w, h, map, hf } = c;
  const [lx, ly, lz] = light.dir;
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const at = (x: number, y: number, fallback: number): number => {
    if (x < 0 || y < 0 || x >= w || y >= h) return fallback;
    const i = y * w + x;
    return map.material[i] === 0 ? fallback - 0.09 : hf[i]!;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = map.material[i]!;
      if (m === 0) continue;
      const here = hf[i]!;
      const gx = at(x + 1, y, here) - at(x - 1, y, here);
      const gy = at(x, y + 1, here) - at(x, y - 1, here);
      const nx = -gx * 5.2 * contrast;
      const ny = -gy * 5.2 * contrast;
      const nl = Math.sqrt(nx * nx + ny * ny + 1);
      const lit = (nx * lx + ny * ly + lz) / nl; // 0.. ~1
      let t = (lit - 0.3) / 0.7; // 0 .. 1
      t = Math.max(0, Math.min(1, t * 0.9 + here * 0.12));
      const r = mats[m]!.ramp;
      const steps = r.length - 1;
      const f = t * steps + (BAYER[((y & 3) << 2) | (x & 3)]! / 16 - 0.5) * 0.38;
      const idx = Math.max(0, Math.min(steps, Math.floor(f + 0.5)));
      map.baseColor[i] = r[idx]!;
      map.height[i] = Math.max(0, Math.min(255, Math.round(here * 255)));
    }
  }
  // Outline: cells beside void darken on the shadow side, brighten on the lit side.
  const out = map.baseColor.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = map.material[i]!;
      if (m === 0) continue;
      let nx = 0;
      let ny = 0;
      if (x === 0 || map.material[i - 1] === 0) nx -= 1;
      if (x === w - 1 || map.material[i + 1] === 0) nx += 1;
      if (y === 0 || map.material[i - w] === 0) ny -= 1;
      if (y === h - 1 || map.material[i + w] === 0) ny += 1;
      if (nx === 0 && ny === 0) continue;
      const d = (nx * lx + ny * ly) / Math.hypot(nx, ny);
      const r = mats[m]!.ramp;
      const cur = out[i]!;
      const idx = Math.max(0, r.indexOf(cur));
      out[i] =
        d > 0.2
          ? r[Math.min(r.length - 1, idx + 1)]!
          : d < -0.2
            ? r[Math.max(0, idx - 2)]!
            : r[Math.max(0, idx - 1)]!;
    }
  }
  map.baseColor.set(out);
  void seed;
}

function finish(
  c: Canvas,
  specs: MaterialSpec[],
  opts: TestBodyOpts,
  core: { x: number; y: number; r: number },
  hooks?: { afterMats?: (mats: MaterialDef[]) => void },
): TestBody {
  const mats = buildMaterialTable(specs);
  hooks?.afterMats?.(mats);
  const { map } = c;
  for (let i = 0; i < map.material.length; i++) if (map.material[i] !== 0) map.density[i] = 128;
  shade(c, mats, opts.lighting ?? DEFAULT_LIGHTING, opts.seed ?? 1);
  map.coreX = Math.round(core.x);
  map.coreY = Math.round(core.y);
  map.coreRadius = core.r;
  const transform: BodyTransform = {
    x: opts.x ?? 400,
    y: opts.y ?? 290,
    anchorX: map.coreX,
    anchorY: map.coreY,
    facing: opts.facing ?? 1,
    lean: 0,
  };
  const spec: BodySpec = {
    kind: 'titan',
    ownerSlot: opts.ownerSlot ?? 0,
    map,
    materials: mats,
    attributes: defaultAttributes(opts.attributes),
    seed: opts.seed ?? 1,
    transform,
  };
  const id: Record<string, number> = {};
  for (const m of mats) id[m.key] = m.id;
  return { spec, materials: mats, map, id };
}

/** Warped radius factor around the silhouette, so discs are not perfect circles. */
function warp(theta: number, seed: number, amp: number): number {
  return 1 + amp * (valueNoise(Math.cos(theta) * 1.7 + 5, Math.sin(theta) * 1.7 + 5, seed) - 0.5) * 2;
}

function fbm(x: number, y: number, seed: number): number {
  return (
    valueNoise(x / 22, y / 22, seed) * 0.55 +
    valueNoise(x / 9, y / 9, seed + 3) * 0.3 +
    valueNoise(x / 4, y / 4, seed + 9) * 0.15
  );
}

/** Layered rocky disc: regolith skin, brittle crust, mantle, glowing core. Radius `size` (default 62). */
export function layeredDisc(o: TestBodyOpts = {}): TestBody {
  const R = o.size ?? 62;
  const pad = 6;
  const W = Math.ceil((R + pad) * 2);
  const c = newCanvas(W, W);
  const cx = W / 2;
  const cy = W / 2;
  const seed = o.seed ?? 1;
  const specs: MaterialSpec[] = [
    mat('regolith', 'regolith', 0.09, 0.22),
    mat('crust', 'rock', 0.07, 0.3),
    mat('mantle', 'mantle', 0.03, 0.55),
    mat('core', 'core', 0.07, 0.85, { emissive: 110 }),
  ];
  const ids = { regolith: 1, crust: 2, mantle: 3, core: 4 };
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const theta = Math.atan2(dy, dx);
      const r = Math.sqrt(dx * dx + dy * dy);
      const Rw = R * warp(theta, seed, 0.07);
      if (r > Rw) continue;
      const u = r / Rw; // 0 centre .. 1 rim
      const depth = Rw - r;
      let m: number;
      if (depth < 3.5 + 2 * valueNoise(x / 5, y / 5, seed)) m = ids.regolith;
      else if (u > 0.62) m = ids.crust;
      else if (u > 0.3) m = ids.mantle;
      else m = ids.core;
      const i = y * W + x;
      c.map.material[i] = m;
      // Height: dome + surface noise; core sunken.
      let hh = 0.3 + 0.35 * Math.sqrt(Math.max(0, 1 - u * u)) + 0.16 * (fbm(x, y, seed) - 0.5);
      if (m === ids.core) hh += 0.05;
      c.hf[i] = hh;
    }
  }
  // Impact craters in the height field (visual only).
  for (let k = 0; k < 7; k++) {
    const a = noise2(k, 1, seed) * Math.PI * 2;
    const rr = R * (0.35 + 0.5 * noise2(k, 2, seed));
    const qx = cx + Math.cos(a) * rr;
    const qy = cy + Math.sin(a) * rr;
    const cr = 3 + noise2(k, 3, seed) * 7;
    for (let y = Math.floor(qy - cr - 2); y <= Math.ceil(qy + cr + 2); y++)
      for (let x = Math.floor(qx - cr - 2); x <= Math.ceil(qx + cr + 2); x++) {
        if (x < 0 || y < 0 || x >= W || y >= W) continue;
        const d = Math.hypot(x + 0.5 - qx, y + 0.5 - qy) / cr;
        if (d > 1.3) continue;
        const i = y * W + x;
        if (c.map.material[i] === 0) continue;
        c.hf[i] = c.hf[i]! + (d < 1 ? -0.13 * (1 - d * d) : 0.04 * (1.3 - d));
      }
  }
  return finish(c, specs, o, { x: cx, y: cy, r: Math.round(R * 0.2) });
}

/** Ribbed iron-nickel slab with regolith patches and ice veins (Asteroid-like). Half-width `size` (default 64). */
export function ribbedSlab(o: TestBodyOpts = {}): TestBody {
  const HW = o.size ?? 64;
  const HH = Math.round(HW * 0.55);
  const pad = 6;
  const W = Math.ceil((HW + pad) * 2);
  const H = Math.ceil((HH + pad) * 2);
  const c = newCanvas(W, H);
  const cx = W / 2;
  const cy = H / 2;
  const seed = o.seed ?? 1;
  const specs: MaterialSpec[] = [
    mat('iron', 'ironNickel', 0.6, 0.14),
    mat('regolith', 'regolith', 0.08, 0.2),
    mat('ice', 'ice', 0.54, 0.45),
    mat('core', 'core', 0.05, 0.8, { emissive: 90 }),
  ];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x + 0.5 - cx) / HW;
      const dy = (y + 0.5 - cy) / HH;
      const theta = Math.atan2(dy, dx);
      const q = Math.pow(Math.abs(dx), 2.6) + Math.pow(Math.abs(dy), 2.4);
      const lim = warp(theta, seed, 0.1);
      if (q > lim) continue;
      const i = y * W + x;
      let m = 1;
      const patch = valueNoise(x / 14, y / 14, seed + 5);
      if (patch > 0.64) m = 2;
      // ice veins: thin meandering bands
      const vein = Math.abs(valueNoise(x / 20, y / 20, seed + 11) - 0.5);
      if (vein < 0.018 && q < 0.8) m = 3;
      if (Math.hypot(dx * HW, dy * HH * 1.4) < 8) m = 4;
      c.map.material[i] = m;
      // ribs
      const rib = Math.abs(((x + 0.5) % 15) - 7.5) < 1.6 ? 0.1 : 0;
      c.hf[i] = 0.35 + 0.3 * (1 - q) + rib + 0.2 * (fbm(x, y, seed) - 0.5);
    }
  }
  return finish(c, specs, o, { x: cx, y: cy, r: 8 });
}

/** Sparse Nexus-like lattice: node discs, thick chains between them, thin lattice web. Half-size `size` (default 70). */
export function sparseLattice(o: TestBodyOpts = {}): TestBody {
  const S = o.size ?? 70;
  const pad = 8;
  const W = Math.ceil((S + pad) * 2);
  const c = newCanvas(W, W);
  const cx = W / 2;
  const cy = W / 2;
  const seed = o.seed ?? 1;
  const specs: MaterialSpec[] = [
    mat('lattice', 'lattice', 0.98, 0.7, {}),
    mat('chain', 'chain', 0.0, 0.55),
    mat('node', 'node', 0.96, 0.75, { emissive: 60 }),
    mat('hub', 'crystal', 0.93, 0.5, { emissive: 120 }),
  ];
  const nodes: { x: number; y: number; r: number }[] = [{ x: cx, y: cy, r: 10 }];
  const ringN = 6;
  for (let k = 0; k < ringN; k++) {
    const a = (k / ringN) * Math.PI * 2 + 0.3 + (noise2(k, 1, seed) - 0.5) * 0.3;
    const rr = S * (0.72 + 0.2 * noise2(k, 2, seed));
    nodes.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr, r: 5 + noise2(k, 3, seed) * 3 });
  }
  const segs: [number, number, number][] = []; // [from, to, thick]
  for (let k = 1; k <= ringN; k++) {
    segs.push([0, k, 3]);
    segs.push([k, (k % ringN) + 1, 2]);
  }
  const put = (x: number, y: number, m: number, h: number): void => {
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    const i = y * W + x;
    if (c.map.material[i] !== 0 && m < c.map.material[i]! && m !== 4) return; // chains/nodes win over lattice
    c.map.material[i] = m;
    c.hf[i] = Math.max(c.hf[i]!, h);
  };
  // lattice web first (material 1), then chains (2), nodes (3), hub (4)
  for (const [a, b] of segs) {
    const A = nodes[a]!;
    const B = nodes[b]!;
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    // two thin lattice strands beside each chain
    for (let t = 0; t <= len; t += 0.5) {
      const u = t / len;
      const px = A.x + (B.x - A.x) * u;
      const py = A.y + (B.y - A.y) * u;
      const nx = -(B.y - A.y) / len;
      const ny = (B.x - A.x) / len;
      for (const off of [-5, 5])
        put(Math.floor(px + nx * off), Math.floor(py + ny * off), 1, 0.4 + 0.1 * Math.sin(t * 0.6));
    }
  }
  // cross bracing between neighbouring chain midpoints (thin)
  for (let k = 1; k <= ringN; k++) {
    const A = nodes[k]!;
    const B = nodes[(k % ringN) + 1]!;
    const M = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    const len = Math.hypot(M.x - cx, M.y - cy);
    for (let t = 0; t <= len; t += 0.5) {
      const u = t / len;
      put(Math.floor(cx + (M.x - cx) * u), Math.floor(cy + (M.y - cy) * u), 1, 0.35);
    }
  }
  for (const [a, b, th] of segs) {
    const A = nodes[a]!;
    const B = nodes[b]!;
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    for (let t = 0; t <= len; t += 0.5) {
      const u = t / len;
      const px = A.x + (B.x - A.x) * u;
      const py = A.y + (B.y - A.y) * u;
      const rr = th / 2 + 0.3;
      for (let dy = -Math.ceil(rr); dy <= Math.ceil(rr); dy++)
        for (let dx = -Math.ceil(rr); dx <= Math.ceil(rr); dx++) {
          if (dx * dx + dy * dy > rr * rr) continue;
          const hh = 0.55 + 0.25 * (1 - Math.hypot(dx, dy) / (rr + 0.5));
          put(Math.floor(px) + dx, Math.floor(py) + dy, 2, hh);
        }
    }
  }
  nodes.forEach((n, k) => {
    for (let y = Math.floor(n.y - n.r - 1); y <= Math.ceil(n.y + n.r + 1); y++)
      for (let x = Math.floor(n.x - n.r - 1); x <= Math.ceil(n.x + n.r + 1); x++) {
        const d = Math.hypot(x + 0.5 - n.x, y + 0.5 - n.y);
        if (d > n.r) continue;
        put(x, y, k === 0 ? 4 : 3, 0.5 + 0.4 * Math.sqrt(1 - (d / n.r) ** 2));
      }
  });
  return finish(c, specs, o, { x: cx, y: cy, r: 9 });
}

/** Planet shrouded in gas: hot core, mantle, rock continents, ocean, cloud tufts and an atmosphere shell. Radius `size` (default 60). */
export function gasPlanet(o: TestBodyOpts = {}): TestBody {
  const R = o.size ?? 56;
  const pad = 12;
  const W = Math.ceil((R + pad) * 2);
  const c = newCanvas(W, W);
  const cx = W / 2;
  const cy = W / 2;
  const seed = o.seed ?? 1;
  const specs: MaterialSpec[] = [
    mat('crust', 'rock', 0.07, 0.3),
    mat('mantle', 'mantle', 0.02, 0.6),
    mat('core', 'core', 0.07, 0.85, { emissive: 110 }),
    mat('ocean', 'ocean', 0.58, 0.6),
    mat('cloud', 'cloud', 0.6, 0.15),
    mat('air', 'gas', 0.56, 0.35),
    mat('magma', 'magma', 0.04, 0.9, { emissive: 150 }),
  ];
  const ID = { crust: 1, mantle: 2, core: 3, ocean: 4, cloud: 5, air: 6, magma: 7 };
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const theta = Math.atan2(dy, dx);
      const r = Math.sqrt(dx * dx + dy * dy);
      const Rp = R * warp(theta, seed, 0.03);
      const Ra = Rp + 8;
      if (r > Ra) continue;
      const i = y * W + x;
      let m: number;
      let hh = 0.4;
      if (r > Rp) {
        m = ID.air;
        hh = 0.3;
      } else {
        const u = r / Rp;
        if (u > 0.9) {
          const land = valueNoise(x / 16, y / 16, seed + 4) > 0.5;
          m = land ? ID.crust : ID.ocean;
          hh = land ? 0.55 + 0.3 * (fbm(x, y, seed) - 0.5) : 0.4;
        } else if (u > 0.78) {
          m = ID.crust;
          hh = 0.5;
        } else if (u > 0.4) m = ID.mantle;
        else if (u > 0.3) m = ID.magma;
        else m = ID.core;
        if (u <= 0.9 && u > 0.78) hh = 0.45;
        if (u <= 0.78) hh = 0.42;
        // cloud tufts sit over the surface layer
        if (u > 0.86 && valueNoise(x / 10, y / 7, seed + 8) > 0.68) {
          m = ID.cloud;
          hh = 0.6;
        }
      }
      c.map.material[i] = m;
      c.hf[i] = hh;
    }
  }
  return finish(c, specs, o, { x: cx, y: cy, r: Math.round(R * 0.22) });
}

/** Crimson lattice mesh disc: chain rim, node hub, lattice body with a regular grid of holes. Good for fire/infection spread. */
export function latticeDisc(o: TestBodyOpts = {}): TestBody {
  const R = o.size ?? 44;
  const W = Math.ceil((R + 6) * 2);
  const c = newCanvas(W, W);
  const cx = W / 2;
  const cy = W / 2;
  const seed = o.seed ?? 1;
  const specs: MaterialSpec[] = [
    mat('lattice', 'lattice', 0.98, 0.7),
    mat('chain', 'chain', 0.0, 0.55),
    mat('node', 'node', 0.96, 0.75, { emissive: 60 }),
  ];
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const r = Math.hypot(dx, dy);
      const Rw = R * warp(Math.atan2(dy, dx), seed, 0.04);
      if (r > Rw) continue;
      const i = y * W + x;
      let m = 1;
      if (r > Rw - 3.5) m = 2;
      else if (r < 7) m = 3;
      else if (x % 6 < 2 && y % 6 < 2) continue; // mesh holes
      c.map.material[i] = m;
      c.hf[i] = 0.4 + 0.2 * fbm(x, y, seed) + (m === 2 ? 0.25 : 0);
    }
  return finish(c, specs, o, { x: cx, y: cy, r: 8 });
}

/** A disc made of ONE archetype (for calibration tables): radius `size` (default 44). */
export function uniformDisc(base: string, o: TestBodyOpts = {}): TestBody {
  const R = o.size ?? 44;
  const W = Math.ceil((R + 6) * 2);
  const c = newCanvas(W, W);
  const cx = W / 2;
  const cy = W / 2;
  const seed = o.seed ?? 1;
  const specs: MaterialSpec[] = [mat(base, base, 0.1, 0.3, base === 'core' ? { emissive: 90 } : {})];
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const r = Math.hypot(dx, dy);
      if (r > R * warp(Math.atan2(dy, dx), seed, 0.04)) continue;
      const i = y * W + x;
      c.map.material[i] = 1;
      c.hf[i] = 0.3 + 0.35 * Math.sqrt(Math.max(0, 1 - (r / R) ** 2)) + 0.12 * (fbm(x, y, seed) - 0.5);
    }
  return finish(c, specs, o, { x: cx, y: cy, r: 6 });
}

/** Two rock blocks joined by a thin bridge: the classic connectivity test. Blocks are 24×24, bridge 14×3. */
export function bridge(o: TestBodyOpts = {}): TestBody {
  const W = 84;
  const H = 40;
  const c = newCanvas(W, H);
  const seed = o.seed ?? 1;
  const specs: MaterialSpec[] = [mat('rock', 'rock', 0.07, 0.3)];
  const fill = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = y * W + x;
        c.map.material[i] = 1;
        c.hf[i] = 0.4 + 0.2 * fbm(x, y, seed);
      }
  };
  fill(6, 8, 30, 32); // left block (core inside)
  fill(30, 18, 54, 21); // bridge
  fill(54, 8, 78, 32); // right block
  return finish(c, specs, o, { x: 18, y: 20, r: 4 });
}

/** A star: plasma body with granulation, corona shell, hot core. Radius `size` (default 54). */
export function star(o: TestBodyOpts = {}): TestBody {
  const R = o.size ?? 54;
  const pad = 14;
  const W = Math.ceil((R + pad) * 2);
  const c = newCanvas(W, W);
  const cx = W / 2;
  const cy = W / 2;
  const seed = o.seed ?? 1;
  const specs: MaterialSpec[] = [
    mat('core', 'core', 0.1, 0.9, { emissive: 200 }),
    mat('plasma', 'plasma', 0.08, 0.85, { emissive: 130 }),
    mat('corona', 'corona', 0.11, 0.7, { emissive: 80 }),
  ];
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const theta = Math.atan2(dy, dx);
      const r = Math.hypot(dx, dy);
      const Rs = R * warp(theta, seed, 0.04);
      const Rc = Rs + 10 * (0.6 + 0.8 * valueNoise(theta * 3 + 7, 3, seed));
      if (r > Rc) continue;
      const i = y * W + x;
      let m: number;
      if (r > Rs) m = 3;
      else if (r / Rs < 0.3) m = 1;
      else m = 2;
      c.map.material[i] = m;
      c.hf[i] = 0.4 + 0.5 * (fbm(x * 1.6, y * 1.6, seed) - 0.3);
    }
  return finish(c, specs, o, { x: cx, y: cy, r: Math.round(R * 0.18) });
}

/** Black hole: horizon disc with a turbulent accretion disk ring. Horizon radius `size` (default 16). */
export function blackHole(o: TestBodyOpts = {}): TestBody {
  const Rh = o.size ?? 16;
  const Rd = Rh * 3.6;
  const pad = 6;
  const W = Math.ceil((Rd + pad) * 2);
  const H = Math.ceil((Rd * 0.75 + pad) * 2);
  const c = newCanvas(W, H);
  const cx = W / 2;
  const cy = H / 2;
  const seed = o.seed ?? 1;
  const specs: MaterialSpec[] = [
    mat('horizon', 'horizon', 0.7, 0.2, {}),
    mat('disk', 'diskGas', 0.08, 0.9, { emissive: 150 }),
  ];
  specs[0]!.visual.ramp = ['#000000', '#020204', '#04040a', '#06060e'];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - cx;
      const dy = (y + 0.5 - cy) / 0.72; // disk seen slightly inclined
      const r = Math.hypot(dx, dy);
      const i = y * W + x;
      if (Math.hypot(dx, y + 0.5 - cy) < Rh) {
        c.map.material[i] = 1;
        c.hf[i] = 0.3;
      } else if (r < Rd && r > Rh * 1.15 && Math.abs(y + 0.5 - cy) < Rd * 0.3 * (1 - (r / Rd) * 0.5) + 2) {
        c.map.material[i] = 2;
        c.hf[i] = 0.5 + 0.3 * (1 - r / Rd) + 0.2 * (fbm(x, y, seed) - 0.5);
      }
    }
  return finish(c, specs, o, { x: cx, y: cy, r: Math.round(Rh * 0.6) });
}

/** Celadon glass-like titan body: ovoid of brittle celadon around a single glowing eye (Last One-like). */
export function celadonBody(o: TestBodyOpts = {}): TestBody {
  const R = o.size ?? 60;
  const pad = 8;
  const W = Math.ceil((R + pad) * 2);
  const c = newCanvas(W, W);
  const cx = W / 2;
  const cy = W / 2;
  const seed = o.seed ?? 1;
  const specs: MaterialSpec[] = [
    mat('celadon', 'celadon', 0.4, 0.28),
    mat('inner', 'crystal', 0.45, 0.35),
    mat('eye', 'eye', 0.13, 0.85, { emissive: 200 }),
  ];
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const dx = (x + 0.5 - cx) / R;
      const dy = (y + 0.5 - cy) / (R * 0.92);
      const theta = Math.atan2(dy, dx);
      const q = Math.hypot(dx, dy);
      const lim = warp(theta, seed, 0.06);
      if (q > lim) continue;
      const i = y * W + x;
      let m = 1;
      if (q < 0.62) m = 2;
      if (Math.hypot(dx * R, dy * R) < 9) m = 3;
      c.map.material[i] = m;
      c.hf[i] = 0.35 + 0.4 * Math.sqrt(Math.max(0, 1 - q * q)) + 0.14 * (fbm(x, y, seed) - 0.5);
    }
  return finish(c, specs, o, { x: cx, y: cy, r: 8 });
}
