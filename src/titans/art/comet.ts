import {
  Rng,
  clamp,
  createMatterMap,
  type MaterialDef,
  type MaterialSpec,
  type MatterMap,
  type StageLighting,
  type TitanDef,
} from '@/contracts';
import { resolveMaterials } from '../materialTable';
import { ArtCanvas, buildLitRamps } from './canvas';
import { keepLargestComponent } from './field';
import { fbm, hash01 } from './noise';

/**
 * A COMET nucleus for the Planet's Comet Shepherd: a dirty snowball, elongated and lumpy (two lobes fused along a neck), dark
 * crusted dust over bright exposed ice in its pits. It is real matter (a body of its own while the Planet shepherds it; chunks when
 * it shatters). The tail is not painted: it is drawn by the behaviour from the comet's motion, so it always points the right way.
 */

export interface CometSpec {
  /** Nucleus half-length (px) and its elongation (length / width). */
  r: number;
  elong: number;
  /** Pits (count) and lobe asymmetry 0..1. */
  pits: number;
  lobes: number;
  materials: MaterialSpec[];
}

export interface CometBody {
  map: MatterMap;
  materials: MaterialDef[];
}

/** The comet spec in a titan's art params (`art.params.comet`), or null if the titan has none. */
export function cometSpecOf(def: TitanDef): CometSpec | null {
  const c = (def.art.params as { comet?: CometSpec }).comet;
  return c ?? null;
}

const CACHE = new Map<string, CometBody>();

function paintComet(spec: CometSpec, seed: number, lighting: StageLighting): CometBody {
  const R = spec.r;
  const size = Math.ceil(R * 2) + 10;
  const c = size / 2;
  const cv = new ArtCanvas(size, size);
  const rng = new Rng(seed ^ 0x5c0e7);
  const s = (seed & 0xfff) + 431;
  const ids = { ice: 1, dust: 2, rock: 3 };
  // two fused lobes along a slightly tilted axis
  const tilt = rng.range(-0.5, 0.5);
  const ax = Math.cos(tilt);
  const ay = Math.sin(tilt);
  const half = R * 0.42;
  const r1 = R / spec.elong;
  const r2 = r1 * (1 - 0.35 * spec.lobes);
  const pits: { x: number; y: number; r: number }[] = [];
  for (let t = 0; pits.length < spec.pits && t < 120; t++) {
    const u = rng.range(-1, 1) * R * 0.8;
    const v = rng.range(-1, 1) * r1 * 0.6;
    const pr = rng.range(1.2, r1 * 0.45);
    const x = c + ax * u - ay * v;
    const y = c + ay * u + ax * v;
    if (pits.some((k) => Math.hypot(k.x - x, k.y - y) < k.r + pr)) continue;
    pits.push({ x, y, r: pr });
  }
  for (let y = 1; y < size - 1; y++)
    for (let x = 1; x < size - 1; x++) {
      const fx = x + 0.5 - c;
      const fy = y + 0.5 - c;
      // distance to the two lobes, warped by noise so the outline is lumpy
      const u = fx * ax + fy * ay;
      const v = -fx * ay + fy * ax;
      const w = fbm(x * 0.15, y * 0.15, s, 3) * 1.8;
      const d1 = Math.hypot((u - half) / r1, v / (r1 * 0.9)) - 1;
      const d2 = Math.hypot((u + half) / r2, v / (r2 * 0.9)) - 1;
      const d = Math.min(d1, d2) * r1 + w;
      if (d >= 0) continue;
      const i = y * size + x;
      let rel = Math.sqrt(clamp(-d / r1, 0, 1)) * r1 * 0.8 + fbm(x * 0.3, y * 0.3, s + 7, 2) * 0.8;
      let m = fbm(x * 0.11, y * 0.11, s + 3, 3) > 0.05 ? ids.dust : ids.rock;
      let tone = (hash01(x, y, s) - 0.5) * 0.45;
      for (const k of pits) {
        const q = Math.hypot(x + 0.5 - k.x, y + 0.5 - k.y) / k.r;
        if (q < 1) {
          rel -= (1 - q * q) * (0.8 + k.r * 0.3);
          // pits expose the bright ice under the dark crust
          if (q < 0.7) m = ids.ice;
          tone += 0.2;
        }
      }
      cv.mat[i] = m;
      cv.relief[i] = Math.max(0.3, rel);
      cv.tone[i] = tone;
    }
  keepLargestComponent(cv.mat, size, size);
  cv.invalidate();
  const ramps = buildLitRamps(spec.materials, lighting, 0.95);
  const colors = cv.render({
    ramps,
    params: [
      undefined,
      { contrast: 1.3, dither: 0.5 },
      { contrast: 1.45, dither: 0.6, bayer8: true },
      { contrast: 1.5, dither: 0.5 },
    ],
    lighting,
    rimMix: 0.45,
    lightXBias: 0.8,
  });
  const map = createMatterMap(size, size);
  cv.writeTo(map, colors, () => 128);
  map.coreX = Math.round(c);
  map.coreY = Math.round(c);
  map.coreRadius = Math.max(2, Math.round(r1 * 0.35));
  return { map, materials: resolveMaterials(spec.materials) };
}

/** A fresh, private copy of the titan's comet nucleus (painting is memoised per seed and light). */
export function generateCometBody(def: TitanDef, seed: number, lighting: StageLighting): CometBody {
  const spec = cometSpecOf(def);
  if (!spec) throw new Error(`${def.id}: no art.params.comet`);
  const key = `${def.id}|${seed >>> 0}|${lighting.dir.join(',')}|${lighting.color}|${lighting.ambient}`;
  let hit = CACHE.get(key);
  if (!hit) {
    hit = paintComet(spec, seed, lighting);
    if (CACHE.size > 8) CACHE.delete(CACHE.keys().next().value as string);
    CACHE.set(key, hit);
  }
  const m = createMatterMap(hit.map.w, hit.map.h);
  m.material.set(hit.map.material);
  m.density.set(hit.map.density);
  m.baseColor.set(hit.map.baseColor);
  m.height.set(hit.map.height);
  m.coreX = hit.map.coreX;
  m.coreY = hit.map.coreY;
  m.coreRadius = hit.map.coreRadius;
  return { map: m, materials: hit.materials };
}
