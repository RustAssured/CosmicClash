import {
  clamp,
  clamp01,
  createMatterMap,
  hex,
  type MatterMap,
  type StageLighting,
  type TitanDef,
} from '@/contracts';
import { blend } from './color';
import { fbm, hash01 } from './noise';

/**
 * BLACK HOLE — a perfectly black event horizon (immune matter), a thin brilliant photon ring, a tilted accretion disk of gas cells
 * Doppler-beamed (hot orange-white where it approaches on the left, dim red where it recedes), the far side of the disk lensed into
 * an arc over the top and under the bottom of the horizon, and knotted relativistic jets along the axis. Self-luminous: colours come
 * straight from the ramps (the stage light barely touches a black hole). The rotation of the disk is animated by the behaviour.
 */
export interface BlackHoleRig {
  core: { x: number; y: number };
  horizon: number;
  ring: number;
  diskIn: number;
  diskOut: number;
  squash: number;
  tilt: number;
  /** Jet axis unit vector (up). */
  jetX: number;
  jetY: number;
  jetLen: number;
  ids: { horizon: number; photon: number; diskhot: number; diskmid: number; diskdim: number; jet: number };
}

interface P {
  centre: [number, number];
  horizon: number;
  ring: number;
  diskIn: number;
  diskOut: number;
  squash: number;
  tilt: number;
  jet: { len: number; w: number };
}
const matId = (def: TitanDef, key: string): number => {
  const i = def.materials.findIndex((m) => m.key === key);
  if (i < 0) throw new Error(`blackhole: material '${key}' missing`);
  return i + 1;
};

export function buildBlackHoleRig(def: TitanDef, _seed: number): BlackHoleRig {
  const p = def.art.params as unknown as P;
  return {
    core: { x: p.centre[0], y: p.centre[1] },
    horizon: p.horizon,
    ring: p.ring,
    diskIn: p.diskIn,
    diskOut: p.diskOut,
    squash: p.squash,
    tilt: p.tilt,
    jetX: Math.sin(p.tilt * 0.5),
    jetY: -Math.cos(p.tilt * 0.5),
    jetLen: p.jet.len,
    ids: {
      horizon: matId(def, 'horizon'),
      photon: matId(def, 'photon'),
      diskhot: matId(def, 'diskhot'),
      diskmid: matId(def, 'diskmid'),
      diskdim: matId(def, 'diskdim'),
      jet: matId(def, 'jet'),
    },
  };
}

export function paintBlackHole(
  def: TitanDef,
  seed: number,
  lighting: StageLighting,
): { map: MatterMap; rig: BlackHoleRig } {
  const rig = buildBlackHoleRig(def, seed);
  const p = def.art.params as unknown as P;
  const W = def.art.w;
  const H = def.art.h;
  const map = createMatterMap(W, H);
  const ids = rig.ids;
  const ramp = (key: string): number[] => def.materials.find((m) => m.key === key)!.visual.ramp.map(hex);
  const R = {
    horizon: ramp('horizon'),
    photon: ramp('photon'),
    hot: ramp('diskhot'),
    mid: ramp('diskmid'),
    dim: ramp('diskdim'),
    jet: ramp('jet'),
  };
  const s1 = (seed & 0xfff) + 91;
  const cx = rig.core.x;
  const cy = rig.core.y;
  const ct = Math.cos(p.tilt);
  const st = Math.sin(p.tilt);
  const hz = p.horizon;
  const set = (i: number, m: number, c: number, dens: number): void => {
    map.material[i] = m;
    map.baseColor[i] = c;
    map.density[i] = dens;
    map.height[i] = 128;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const r = Math.hypot(dx, dy);
      const i = y * W + x;
      const u = dx * ct + dy * st;
      const v = -dx * st + dy * ct;
      const q = Math.hypot(u, v / p.squash);
      const dopp = clamp01(0.5 - u / (2 * p.diskOut)); // 1 on the approaching (left) side
      const swirl = fbm(q * 0.11 + s1, Math.atan2(v / p.squash, u) * 2.2, s1, 3);
      const streak = 0.5 + 0.5 * Math.sin(q * 0.85 + swirl * 5);
      let done = false;
      const frontBand =
        v > 0 && r < hz + p.ring && q >= p.diskIn - 1 && q <= p.diskIn + (p.diskOut - p.diskIn) * 0.28;
      if (r < hz && !frontBand) {
        set(i, ids.horizon, R.horizon[r > hz - 1.5 ? 2 : 0]!, 255);
        done = true;
      } else if (r < hz + p.ring && !frontBand) {
        const k = 1 + Math.round(2 * clamp01(0.4 + dopp * 0.6 + (hash01(x, y, s1) - 0.5) * 0.3));
        set(i, ids.photon, R.photon[Math.min(3, k)]!, 120);
        done = true;
      }
      if (done) continue;
      // lensed far side of the disk: an arc hugging the horizon over the top (bright) and under the bottom (fainter)
      const rr = r - (hz + p.ring);
      const taper = Math.sqrt(Math.max(0, 1 - (dx / (hz * 1.15)) ** 2));
      const upper = dy < 0 && rr >= 0.2 && rr < 12 * taper;
      const lower = dy > 0 && rr >= 0.2 && rr < 6 * taper;
      const inDisk = q >= p.diskIn && q <= p.diskOut && !(v < 0 && r < hz + p.ring + 1);
      const diskFrac = clamp01((q - p.diskIn) / (p.diskOut - p.diskIn));
      if (inDisk || upper || lower || frontBand) {
        const f = upper ? 0.08 + rr * 0.012 : lower ? 0.25 + rr * 0.03 : frontBand ? 0.1 : diskFrac;
        // thin, ragged outer edge and brightness streaks
        if (inDisk && diskFrac > 0.86 && hash01(x, y, s1 + 5) < (diskFrac - 0.86) * 5) continue;
        const heat =
          clamp01(1 - f * 0.95) * (0.55 + 0.45 * streak) * (0.6 + 0.75 * dopp) + (upper ? 0.25 : 0);
        const set3 = heat > 0.66 ? R.hot : heat > 0.36 ? R.mid : R.dim;
        const mid = heat > 0.66 ? ids.diskhot : heat > 0.36 ? ids.diskmid : ids.diskdim;
        const base = heat > 0.66 ? (heat - 0.66) / 0.34 : heat > 0.36 ? (heat - 0.36) / 0.3 : heat / 0.36;
        const idx = clamp(
          Math.round(base * (set3.length - 1) + (hash01(x, y, s1) - 0.5) * 0.9),
          0,
          set3.length - 1,
        );
        // where the band crosses the horizon it is light, not matter: it stays horizon so the black disc is one solid piece
        set(i, frontBand && r < hz ? ids.horizon : mid, set3[idx]!, 96);
        continue;
      }
      // jets along the axis, above and below the photon ring
      const ax = dx * rig.jetX + dy * rig.jetY; // along the jet (up positive)
      const across = Math.abs(dx * rig.jetY - dy * rig.jetX);
      const start = hz + p.ring - 2;
      if (Math.abs(ax) > start && Math.abs(ax) < start + rig.jetLen + 4) {
        const t = (Math.abs(ax) - start) / rig.jetLen;
        const w = p.jet.w * (1 - 0.55 * t) * (0.85 + 0.3 * Math.sin(t * 22 + (ax > 0 ? 0 : 2)));
        if (across < w && t < 1) {
          const k = clamp(Math.round(4 - t * 3.4 - across * 0.5 + (Math.sin(t * 22) > 0.7 ? 1 : 0)), 0, 4);
          set(i, ids.jet, R.jet[k]!, 40);
        }
      }
    }
  }
  // the stage light barely touches a black hole, but its colour does tint the glowing gas a little
  const tint = hex(lighting.color);
  for (let i = 0; i < W * H; i++) {
    const m = map.material[i]!;
    if (m !== 0 && m !== ids.horizon) map.baseColor[i] = blend(map.baseColor[i]!, tint, 0.07);
  }
  // nothing may float free of the horizon: keep only the cells 4-connected to the core
  const seen = new Uint8Array(W * H);
  const stack: number[] = [Math.round(cy) * W + Math.round(cx)];
  seen[stack[0]!] = 1;
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % W;
    const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i + W < W * H ? i + W : -1];
    for (const j of nb) {
      if (j < 0 || seen[j] || map.material[j] === 0) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  for (let i = 0; i < W * H; i++) {
    if (map.material[i] !== 0 && !seen[i]) {
      map.material[i] = 0;
      map.baseColor[i] = 0;
      map.density[i] = 0;
      map.height[i] = 0;
    }
  }
  map.coreX = Math.round(cx);
  map.coreY = Math.round(cy);
  map.coreRadius = def.art.coreRadius;
  return { map, rig };
}
