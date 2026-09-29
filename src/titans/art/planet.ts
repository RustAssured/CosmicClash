import {
  Rng,
  clamp,
  clamp01,
  createMatterMap,
  hex,
  smoothstep,
  type MaterialDef,
  type MaterialSpec,
  type MatterMap,
  type StageLighting,
  type TitanDef,
} from '@/contracts';
import { ArtCanvas, buildLitRamps, type ShadeParams } from './canvas';
import { keepLargestComponent } from './field';
import { bayer8, fbm, hash01, makeWorley, ridged, worley } from './noise';
import { sdEllipse } from './sdf';
import { resolveMaterials } from '../materialTable';

/**
 * PLANET — a layered world seen as a lit globe. The visible face is painted from a lat/lon surface (oceans with shallows and
 * a sun glint, forests, deserts, mountain ranges, polar ice) lit as a true sphere by the stage light (day side, terminator,
 * dark side), wrapped in a thin atmosphere ring with cloud wisps. The MATERIALS underneath are concentric: surface class →
 * crust → mantle → magma → core. The face colours hide the depth in the pristine body; the fighter's overlay draws the real
 * strata (crust, mantle, glowing magma) wherever damage exposes them.
 */

export interface MoonSpec {
  /** Radius px, orbit semi-axes, orbit tilt (rad), orbital period (ticks) and starting phase (rad). */
  r: number;
  a: number;
  b: number;
  tilt: number;
  period: number;
  phase: number;
  crater: number;
  lumpy: number;
  materials: MaterialSpec[];
}

export interface PlanetRig {
  core: { x: number; y: number; r: number };
  radius: number;
  atmo: number;
  surface: number;
  crust: number;
  magmaR: number;
  coreR: number;
  tilt: number;
  moons: MoonSpec[];
  /** Per map cell: sphere z (0..255), longitude (0..65535 around the sphere) and latitude (0..127) indices, 255/0 outside the disc. Lighting-independent. */
  nz: Uint8Array;
  lon: Uint16Array;
  lat: Uint8Array;
  /** Wrapping cloud density texture, 256 (lon) × 128 (lat), 0..255. */
  clouds: Uint8Array;
  ids: {
    atmosphere: number;
    cloud: number;
    ocean: number;
    forest: number;
    desert: number;
    mountain: number;
    ice: number;
    crust: number;
    mantle: number;
    magma: number;
    core: number;
  };
}

interface P {
  radius: number;
  atmo: number;
  surface: number;
  crust: number;
  magmaR: number;
  coreR: number;
  tilt: number;
  sea: number;
  moons: MoonSpec[];
}

const params = (def: TitanDef): P => def.art.params as unknown as P;
const CX = (def: TitanDef): number => def.art.coreX;
const CY = (def: TitanDef): number => def.art.coreY;

const matId = (def: TitanDef, key: string): number => {
  const i = def.materials.findIndex((m) => m.key === key);
  if (i < 0) throw new Error(`planet: material '${key}' missing`);
  return i + 1;
};

const ids = (def: TitanDef): PlanetRig['ids'] => ({
  atmosphere: matId(def, 'atmosphere'),
  cloud: matId(def, 'cloud'),
  ocean: matId(def, 'ocean'),
  forest: matId(def, 'forest'),
  desert: matId(def, 'desert'),
  mountain: matId(def, 'mountain'),
  ice: matId(def, 'ice'),
  crust: matId(def, 'crust'),
  mantle: matId(def, 'mantle'),
  magma: matId(def, 'magma'),
  core: matId(def, 'core'),
});

/** Longitude-periodic value noise (blends the field with itself shifted a full turn so the texture wraps). */
function periodic(x: number, y: number, w: number, seed: number, oct: number): number {
  const a = fbm(x, y, seed, oct);
  const b = fbm(x - w, y, seed, oct);
  const t = clamp01(x / w);
  return a * (1 - t) + b * t;
}

const cloudCache = new Map<number, Uint8Array>();
/** The cloud texture: latitude bands, cumulus clumps and one large cyclone; seamless in longitude. */
function buildClouds(seed: number): Uint8Array {
  const hit = cloudCache.get(seed);
  if (hit) return hit;
  const W = 256;
  const H = 128;
  const out = new Uint8Array(W * H);
  const raw = new Float32Array(W * H);
  const s = (seed & 0xfff) + 77;
  const stormX = 0.42 * W;
  const stormY = 0.62 * H;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const lat = (y / H - 0.5) * Math.PI;
      const band = 0.5 + 0.5 * Math.sin(lat * 7 + 1.2 * periodic(x * 0.03, y * 0.05, W * 0.03, s + 3, 2));
      const n = periodic(u * 9, y * 0.06, 9, s, 4) * 0.7 + periodic(u * 20, y * 0.13, 20, s + 9, 3) * 0.3;
      let d = 0.5 + 0.55 * n + 0.3 * band - 0.42;
      // cyclone: a spiral arm pattern around the storm eye
      let dx = x - stormX;
      if (dx > W / 2) dx -= W;
      if (dx < -W / 2) dx += W;
      const dy = (y - stormY) * 1.6;
      const r = Math.hypot(dx, dy);
      if (r < 34) {
        const th = Math.atan2(dy, dx) + r * 0.16;
        const arm = 0.5 + 0.5 * Math.cos(th * 2);
        d = Math.max(d, 0.85 * arm * (1 - r / 34) + (r < 4 ? -1 : 0) * 0.5);
      }
      raw[y * W + x] = d;
    }
  // normalise: the densest ~38% of the sphere becomes cloud, with soft edges
  const sorted = Float32Array.from(raw).sort();
  const thr = sorted[Math.floor(sorted.length * 0.68)]!;
  const top = sorted[Math.floor(sorted.length * 0.95)]!;
  for (let i = 0; i < raw.length; i++)
    out[i] = Math.round(smoothstep(thr - 0.03 * (top - thr), thr + 0.35 * (top - thr), raw[i]!) * 255);
  cloudCache.set(seed, out);
  return out;
}

interface Layout {
  p: P;
  cx: number;
  cy: number;
  seed: number;
  rDisc(theta: number): number;
  rAtmo(theta: number): number;
}

function layout(def: TitanDef, seed: number): Layout {
  const p = params(def);
  const s1 = (seed & 0xffff) + 13;
  const s2 = ((seed >>> 8) & 0xffff) + 29;
  return {
    p,
    cx: CX(def) + 0.5,
    cy: CY(def) + 0.5,
    seed,
    rDisc: (th) => p.radius * (1 + 0.012 * fbm(Math.cos(th) * 1.2 + 4, Math.sin(th) * 1.2 + 4, s1, 2)),
    rAtmo: (th) =>
      p.radius +
      p.atmo * (0.62 + 0.38 * (0.5 + 0.5 * fbm(Math.cos(th) * 3.1 + 2, Math.sin(th) * 3.1 + 9, s2, 3))),
  };
}

/** Sphere mapping of a cell: (lon, lat) in radians for the visible face, or null off the disc. */
function sphere(
  dx: number,
  dy: number,
  tilt: number,
  out: { lon: number; lat: number; nz: number },
): boolean {
  const r2 = dx * dx + dy * dy;
  if (r2 >= 1) return false;
  const nz = Math.sqrt(1 - r2);
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  const px = dx * c + dy * s;
  const py = -dx * s + dy * c;
  out.lat = Math.asin(clamp(-py, -1, 1));
  out.lon = Math.atan2(px, nz);
  out.nz = nz;
  return true;
}

export function buildPlanetRig(def: TitanDef, seed: number): PlanetRig {
  const p = params(def);
  const W = def.art.w;
  const H = def.art.h;
  const nz = new Uint8Array(W * H);
  const lon = new Uint16Array(W * H);
  const lat = new Uint8Array(W * H);
  const cx = CX(def) + 0.5;
  const cy = CY(def) + 0.5;
  const q = { lon: 0, lat: 0, nz: 0 };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!sphere((x + 0.5 - cx) / p.radius, (y + 0.5 - cy) / p.radius, p.tilt, q)) continue;
      const i = y * W + x;
      nz[i] = Math.round(q.nz * 255);
      lon[i] = Math.round(((q.lon / Math.PI) * 0.5 + 0.5) * 65535);
      lat[i] = Math.round((q.lat / Math.PI + 0.5) * 127);
    }
  return {
    core: { x: def.art.coreX, y: def.art.coreY, r: def.art.coreRadius },
    radius: p.radius,
    atmo: p.atmo,
    surface: p.surface,
    crust: p.crust,
    magmaR: p.magmaR,
    coreR: p.coreR,
    tilt: p.tilt,
    moons: p.moons,
    nz,
    lon,
    lat,
    clouds: buildClouds(seed),
    ids: ids(def),
  };
}

type Class = 'ocean' | 'forest' | 'desert' | 'mountain' | 'ice';

export function paintPlanet(
  def: TitanDef,
  seed: number,
  lighting: StageLighting,
): { map: MatterMap; rig: PlanetRig } {
  const L = layout(def, seed);
  const rig = buildPlanetRig(def, seed);
  const I = rig.ids;
  const { p, cx, cy } = L;
  const W = def.art.w;
  const H = def.art.h;
  const sA = (seed & 0xfff) + 211;
  const sB = ((seed >>> 12) & 0xfff) + 307;
  const R = p.radius;
  const face = new ArtCanvas(W, H); // what it looks like
  const real = new ArtCanvas(W, H); // what it is made of
  const cls = new Uint8Array(W * H); // surface class ids for the face
  const shallow = new Float32Array(W * H);
  const q = { lon: 0, lat: 0, nz: 0 };
  const w1 = makeWorley();
  const classId: Record<Class, number> = {
    ocean: I.ocean,
    forest: I.forest,
    desert: I.desert,
    mountain: I.mountain,
    ice: I.ice,
  };

  // ---- surface function on the sphere --------------------------------------------------------------------------------------
  const surf = (lon: number, lat: number): { c: Class; elev: number; moist: number } => {
    const n =
      fbm(lon * 1.25 + 3, lat * 1.6 + 1, sA, 4) * 0.85 + 0.3 * (ridged(lon * 2.6, lat * 3, sA + 5, 3) - 0.4);
    const elev = n - p.sea;
    const moist = fbm(lon * 2.3 + 8, lat * 2.7 - 2, sB, 3);
    const iceLat = 1.14 + 0.22 * fbm(lon * 1.8, 5, sB + 3, 2);
    if (Math.abs(lat) > iceLat) return { c: 'ice', elev, moist };
    if (elev <= 0) return { c: 'ocean', elev, moist };
    if (elev > 0.34 && ridged(lon * 4.2, lat * 4.5, sA + 11, 3) > 0.5) return { c: 'mountain', elev, moist };
    if (moist < -0.02 || (Math.abs(lat) < 0.42 && moist < 0.14)) return { c: 'desert', elev, moist };
    return { c: 'forest', elev, moist };
  };

  // ---- 1. mask, classes, relief ---------------------------------------------------------------------------------------------
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const r = Math.hypot(dx, dy);
      const th = Math.atan2(dy, dx);
      const rd = L.rDisc(th);
      const i = y * W + x;
      if (r <= rd) {
        const un = clamp(r / R, 0, 0.985);
        let rel = 0.92 * R * Math.sqrt(1 - un * un);
        if (sphere(dx / R, dy / R, p.tilt, q)) {
          const s = surf(q.lon, q.lat);
          const c = s.c;
          cls[i] = classId[c];
          if (c === 'ocean') {
            shallow[i] = clamp01(1 + s.elev / 0.16);
            rel += 0.4 * fbm(x * 0.4, y * 0.4, sB + 2, 2);
          } else if (c === 'ice') rel += 1.6;
          else
            rel +=
              3 * clamp01(s.elev / 0.5) +
              (c === 'mountain' ? 2.6 + 2.5 * ridged(x * 0.09, y * 0.09, sA + 8, 3) : 0);
        } else cls[i] = I.ocean;
        face.mat[i] = cls[i]!;
        face.relief[i] = rel;
        // the real materials, by depth
        const d = rd - r;
        let m: number;
        if (d < p.surface + 0.6 * fbm(x * 0.2, y * 0.2, sA + 9, 2)) {
          m = cls[i]!;
          // mountain ranges crossing the limb: land there is bare rock (the face colours already blend into it)
          if (
            (m === I.forest || m === I.desert) &&
            fbm(Math.cos(th) * 2.6 + 3, Math.sin(th) * 2.6 - 1, sB + 44, 3) > 0.16
          )
            m = I.mountain;
        } else if (d < p.crust) m = I.crust;
        else if (r > p.magmaR + 2 * fbm(x * 0.13, y * 0.13, sB + 4, 2)) m = I.mantle;
        else if (r > p.coreR + 1.2 * fbm(x * 0.2, y * 0.2, sA + 1, 2)) m = I.magma;
        else m = I.core;
        real.mat[i] = m;
      } else if (r <= L.rAtmo(th)) {
        // atmosphere ring; cloud wisps where the cloud field is dense
        const c = fbm(x * 0.07, y * 0.07, sB + 6, 3) + 0.4 * fbm(x * 0.18, y * 0.18, sA + 21, 2);
        const m = c > 0.2 && r < R + p.atmo * 0.78 ? I.cloud : I.atmosphere;
        face.mat[i] = m;
        real.mat[i] = m;
        face.relief[i] = 1 + (m === I.cloud ? 2 : 0);
      }
    }
  keepLargestComponent(real.mat, W, H);
  for (let i = 0; i < W * H; i++) if (real.mat[i] === 0) face.mat[i] = 0;
  face.invalidate();
  real.invalidate();

  // ---- 2. lit render -------------------------------------------------------------------------------------------------------
  const ramps = buildLitRamps(def.materials, lighting, 1);
  const shade: (Partial<ShadeParams> | undefined)[] = [];
  shade[I.ocean] = { contrast: 1.3, dither: 0.5, ao: 0, rim: 0.4, outline: 0, bump: 0.9 };
  shade[I.forest] = { contrast: 1.35, dither: 0.6, ao: 0.4, rim: 0.4, outline: 0, bayer8: true };
  shade[I.desert] = { contrast: 1.3, dither: 0.6, ao: 0.4, rim: 0.4, outline: 0, bayer8: true };
  shade[I.mountain] = { contrast: 1.5, dither: 0.5, ao: 0.6, rim: 0.4, outline: 0 };
  shade[I.ice] = { contrast: 1.3, dither: 0.5, ao: 0.2, rim: 0.4, outline: 0 };
  shade[I.atmosphere] = { contrast: 1.6, dither: 0.8, ao: 0, rim: 1, outline: 0, bump: 0.6, bayer8: true };
  shade[I.cloud] = { contrast: 1.5, dither: 0.6, ao: 0.6, rim: 0.7, outline: 0.2, bump: 1.2 };
  const kx = lighting.dir[0] * 0.8;
  const ky = lighting.dir[1];
  const kz = lighting.dir[2];
  const kn = Math.hypot(kx, ky, kz) || 1;
  // tone: shallows, vegetation, deserts, glints of variety
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const m = face.mat[i]!;
      if (m === 0) continue;
      let t = (hash01(x, y, sB) - 0.5) * 0.35;
      if (m === I.ocean) t += 2.3 * shallow[i]! - 0.9 + fbm(x * 0.06, y * 0.06, sA + 4, 2) * 0.5;
      else if (m === I.forest) t += fbm(x * 0.08, y * 0.08, sB + 7, 3) * 1.4;
      else if (m === I.desert) t += fbm(x * 0.1, y * 0.1, sA + 12, 3) * 1.3;
      else if (m === I.mountain) {
        worley(x / 7, y / 7, sA + 3, w1, 0.8);
        t += (w1.id - 0.5) * 1.2 - ((w1.f2 - w1.f1) * 7 < 0.5 ? 0.9 : 0);
      } else if (m === I.atmosphere || m === I.cloud) t += fbm(x * 0.2, y * 0.2, sA, 2) * 0.6;
      if (m !== I.atmosphere && m !== I.cloud) {
        const dx = (x + 0.5 - cx) / R;
        const dy = (y + 0.5 - cy) / R;
        const nz = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
        const nl = (dx * kx + dy * ky + nz * kz) / kn;
        t -= 2.4 * smoothstep(0.42, -0.08, nl); // the terminator and the night side
        t += 0.5 * smoothstep(0.6, 1, nl);
      }
      face.tone[i] = t;
    }
  const colors = face.render({ ramps, params: shade, lighting, rimMix: 0.5, lightXBias: 0.8 });

  // ---- 3. hand-painted touches: the sun glint on the sea, the atmosphere's lit edge -----------------------------------------
  const key = [lighting.dir[0] * 0.8, lighting.dir[1], lighting.dir[2]];
  const kl = Math.hypot(key[0]!, key[1]!, key[2]!) || 1;
  const hx = key[0]! / kl;
  const hy = key[1]! / kl;
  const hz = key[2]! / kl + 1;
  const hl = Math.hypot(hx, hy, hz);
  const oceanRamp = def.materials[I.ocean - 1]!.visual.ramp.map(hex);
  const atmoRamp = ramps[I.atmosphere]!;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const m = face.mat[i]!;
      if (m === I.ocean) {
        const dx = (x + 0.5 - cx) / R;
        const dy = (y + 0.5 - cy) / R;
        const nz = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
        const g = Math.max(0, (dx * hx + dy * hy + nz * hz) / hl);
        const glint = Math.pow(g, 260);
        if (glint > 0.4 && hash01(x, y, sA + 40) > 0.25) colors[i] = oceanRamp[oceanRamp.length - 1]!;
        else if (glint > 0.16) colors[i] = oceanRamp[Math.min(oceanRamp.length - 1, 5)]!;
      } else if (m === I.atmosphere) {
        // Rayleigh edge: cyan-white where the limb faces the light, deep blue-violet on the dark side
        const ang = Math.atan2(y + 0.5 - cy, x + 0.5 - cx);
        const facing = clamp01(
          ((Math.cos(ang) * key[0]! + Math.sin(ang) * key[1]!) / Math.hypot(key[0]!, key[1]!)) * 0.5 + 0.5,
        );
        const out = clamp01((Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - R) / p.atmo);
        const v = (0.25 + 0.75 * facing * facing) * (1 - 0.55 * out) + 0.12 * (hash01(x, y, sB + 60) - 0.5);
        const s = clamp(v, 0, 1) * (atmoRamp.length - 1);
        const fl = Math.floor(s);
        colors[i] =
          atmoRamp[Math.min(atmoRamp.length - 1, fl + (s - fl > (bayer8(x, y) + 0.05) * 0.95 ? 1 : 0))]!;
      }
    }

  // ---- 4. the map -----------------------------------------------------------------------------------------------------------
  const map = createMatterMap(W, H);
  real.relief.set(face.relief);
  const dens = (m: number): number =>
    m === I.core ? 170 : m === I.magma ? 140 : m === I.atmosphere ? 120 : m === I.cloud ? 120 : 128;
  real.writeTo(map, colors, dens);
  map.coreX = def.art.coreX;
  map.coreY = def.art.coreY;
  map.coreRadius = def.art.coreRadius;
  return { map, rig };
}

/* ------------------------------------------------------------------------------------------------ *
 *  moons
 * ------------------------------------------------------------------------------------------------ */

export interface MoonBody {
  map: MatterMap;
  materials: MaterialDef[];
}

const MOON_CACHE = new Map<string, MoonBody>();

function paintMoon(def: TitanDef, seed: number, lighting: StageLighting, index: number): MoonBody {
  const spec = params(def).moons[index]!;
  const size = Math.ceil(spec.r * 2) + 10;
  const c = size / 2;
  const cv = new ArtCanvas(size, size);
  const rng = new Rng(seed ^ (0x30 + index * 977));
  const s = (seed & 0xfff) + 5 + index * 71;
  const ids = { rock: 1, dust: 2, dark: 3 };
  // silhouette: a sphere with lumps (noise-warped ellipse)
  const rx = spec.r * (1 + 0.1 * spec.lumpy);
  const ry = spec.r * (1 - 0.08 * spec.lumpy);
  const sd = (x: number, y: number): number => {
    const wx = x + fbm(x * 0.12, y * 0.12, s, 3) * 2.2 * (0.6 + spec.lumpy);
    const wy = y + fbm(x * 0.12 + 5, y * 0.12 + 2, s + 3, 3) * 2.2 * (0.6 + spec.lumpy);
    return sdEllipse(wx, wy, c, c, rx, ry);
  };
  const craters: { x: number; y: number; r: number }[] = [];
  for (let t = 0; craters.length < spec.crater && t < 200; t++) {
    const a = rng.range(0, 6.283);
    const rr = Math.sqrt(rng.next()) * spec.r * 0.85;
    const cr = rng.range(1.8, spec.r * 0.3);
    const x = c + Math.cos(a) * rr;
    const y = c + Math.sin(a) * rr;
    if (craters.some((k) => Math.hypot(k.x - x, k.y - y) < k.r + cr + 0.5)) continue;
    craters.push({ x, y, r: cr });
  }
  for (let y = 1; y < size - 1; y++)
    for (let x = 1; x < size - 1; x++) {
      const fx = x + 0.5;
      const fy = y + 0.5;
      if (sd(fx, fy) >= 0) continue;
      const i = y * size + x;
      const u = clamp(Math.hypot(fx - c, fy - c) / spec.r, 0, 0.985);
      let rel = 0.9 * spec.r * Math.sqrt(1 - u * u) + fbm(fx * 0.2, fy * 0.2, s + 8, 3) * 1.2;
      let m = fbm(fx * 0.09, fy * 0.09, s + 14, 3) > 0.12 ? ids.dark : ids.rock;
      let tone = (hash01(x, y, s) - 0.5) * 0.5;
      for (const k of craters) {
        const d = Math.hypot(fx - k.x, fy - k.y) / k.r;
        if (d < 1) {
          rel -= (1 - d * d) * (1 + k.r * 0.35);
          if (d < 0.75) tone -= 0.4;
        } else if (d < 1.25) rel += (1.25 - d) * 3.2;
      }
      if (Math.hypot(fx - c, fy - c) < spec.r * 0.55 && u > 0.7) m = ids.dust;
      cv.mat[i] = m;
      cv.relief[i] = Math.max(0.3, rel);
      cv.tone[i] = tone;
    }
  keepLargestComponent(cv.mat, size, size);
  cv.invalidate();
  const ramps = buildLitRamps(spec.materials, lighting, 0.9);
  const colors = cv.render({
    ramps,
    params: [
      undefined,
      { contrast: 1.4, dither: 0.6, bayer8: true },
      { contrast: 1.4, dither: 0.6, bayer8: true },
      { contrast: 1.5, dither: 0.5 },
    ],
    lighting,
    rimMix: 0.3,
    lightXBias: 0.8,
  });
  const map = createMatterMap(size, size);
  cv.writeTo(map, colors, () => 128);
  map.coreX = Math.round(c);
  map.coreY = Math.round(c);
  map.coreRadius = Math.max(3, Math.round(spec.r * 0.28));
  return { map, materials: resolveMaterials(spec.materials) };
}

/** A fresh, private copy of moon `index` (painting is memoised per seed and light). */
export function generateMoonBody(
  def: TitanDef,
  seed: number,
  lighting: StageLighting,
  index: number,
): MoonBody {
  const key = `${seed >>> 0}|${index}|${lighting.dir.join(',')}|${lighting.color}|${lighting.ambient}`;
  let hit = MOON_CACHE.get(key);
  if (!hit) {
    hit = paintMoon(def, seed, lighting, index);
    if (MOON_CACHE.size > 8) MOON_CACHE.delete(MOON_CACHE.keys().next().value as string);
    MOON_CACHE.set(key, hit);
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
