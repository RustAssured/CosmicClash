/**
 * The Mouth's draw list (Phase 3C): what the Mouth's geometry builder (src/combat/mouth/geom.ts, the CPU half of the locked
 * look-dev renderer `mouth/src/10_mouth_render_lib.js`) hands the GPU pass (src/render/mouthPass.ts). The prototype rasterised
 * every primitive per pixel on the CPU (30–45 ms a frame); here the CPU only lays out primitives and the GPU shades them, with
 * a depth buffer for crossings (shared/RENDERING.md: "strands as instanced round-tube segments (capsule impostors)").
 *
 * Everything is in WORLD px (+y down) with the prototype's depth z (+ toward the viewer). Pure data, no three.js.
 *
 * Primitive kinds:
 *  - TUBE: a capsule from p0 to p1 (radii r0 → r1), round in section, shaded as wet flesh (the prototype's `tube` + `flesh`);
 *  - ANNULUS: a ring in a tilted plane (the throat's gullet rings, the lips), the prototype's `annulus` + its shade closures;
 *  - STAMP: the small hand-placed pixels of the prototype — jaw-ring band discs, teeth and claws, barbs, gums, single pixels
 *    (slime, drips, the tell ring, the predicted path).
 */

export const TUBE_STRIDE = 16;
export const STAMP_STRIDE = 16;
export const ANN_STRIDE = 20;

/** Per-primitive flags. */
export const MF = {
  /** tube: rounded start / end cap */
  CAP0: 1,
  CAP1: 2,
  /** tube: the funnel (no cold violet in the shadows: the prototype's WARM) */
  WARM: 4,
  /** clipped to the mouth opening (the throat seen through it) */
  CLIP: 8,
  /** belongs to the back layer (drawn behind the foe: the coils, the wrap's back half) */
  BACK: 16,
  /** emissive */
  EMIS: 32,
} as const;

/** Stamp kinds. */
export const SK = { PIXEL: 0, RING: 1, TOOTH: 2, BARB: 3, GUM: 4 } as const;
/** Annulus kinds. */
export const AK = { THROAT: 0, MAW: 1, LIPS: 2 } as const;

export interface MouthDrawList {
  tubes: Float32Array;
  nTubes: number;
  stamps: Float32Array;
  nStamps: number;
  anns: Float32Array;
  nAnn: number;
  /** The mouth opening the throat is clipped to: C (x, y), u (x, y), w (x, y), radius, on (0 / 1). */
  readonly clip: Float32Array;
  /** Wounds (sid, u, len, 0) — the prototype's WOUNDS, looked up by strand id and arc length. */
  readonly wounds: Float32Array;
  nWounds: number;
  /** Sim seconds (writhe, the throat's glow, slime glints). */
  t: number;
  /** Light rig: 0 = the oracle's own (parity stills), 1 = turned to the one titan sky (UNIFICATION §1; the game). */
  sky: number;
  /** World rect the list covers (for the pass's bounds), and a version bumped every rebuild. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  version: number;
}

export const MAX_TUBES = 6000;
export const MAX_STAMPS = 12000;
export const MAX_ANN = 16;
export const MAX_WOUNDS = 64;

export function makeMouthDrawList(): MouthDrawList {
  return {
    tubes: new Float32Array(MAX_TUBES * TUBE_STRIDE),
    nTubes: 0,
    stamps: new Float32Array(MAX_STAMPS * STAMP_STRIDE),
    nStamps: 0,
    anns: new Float32Array(MAX_ANN * ANN_STRIDE),
    nAnn: 0,
    clip: new Float32Array(8),
    wounds: new Float32Array(MAX_WOUNDS * 4),
    nWounds: 0,
    t: 0,
    sky: 1,
    x0: 0,
    y0: 0,
    x1: 0,
    y1: 0,
    version: 0,
  };
}

/* ------------------------------------------------------------------------------------------------ *
 *  the prototype's palette and noise (mouth/src/00_shared_helpers.js, 10_mouth_render_lib.js), exact
 * ------------------------------------------------------------------------------------------------ */

const HX = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

/** The flesh palette: wet black, raw red, pale marbled sinew, old bone, a throat that glows. */
export const MOUTH_RAMPS = {
  black: ['#040205', '#0a050a', '#120810', '#1c0c17', '#28121f', '#36192a', '#472337'].map(HX),
  red: [
    '#0e0207',
    '#1c040b',
    '#300810',
    '#480c18',
    '#621320',
    '#7e1c28',
    '#9c2a30',
    '#ba3e3c',
    '#d45e50',
    '#e8866a',
  ].map(HX),
  pale: [
    '#200e12',
    '#3a1a1e',
    '#5a2c2c',
    '#7e443c',
    '#a2604e',
    '#c28268',
    '#dca88c',
    '#efcdb2',
    '#fbe8d6',
  ].map(HX),
  bone: [
    '#160e0e',
    '#2e201e',
    '#4e3a34',
    '#73594e',
    '#9a7e70',
    '#bfa392',
    '#dbc6b4',
    '#efe2d4',
    '#fcf6ee',
  ].map(HX),
  maw: [
    '#080103',
    '#170206',
    '#2c040a',
    '#4a080e',
    '#701010',
    '#9c1a12',
    '#c82e16',
    '#ee5420',
    '#ff8a40',
  ].map(HX),
};

/** The prototype's 4×4 Bayer offsets ((v + .5) / 16 − .5). */
export const MOUTH_BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(
  (v) => (v + 0.5) / 16 - 0.5,
);

export function h3(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export function n3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const a = lerp(
    lerp(h3(xi, yi, zi), h3(xi + 1, yi, zi), u),
    lerp(h3(xi, yi + 1, zi), h3(xi + 1, yi + 1, zi), u),
    v,
  );
  const b = lerp(
    lerp(h3(xi, yi, zi + 1), h3(xi + 1, yi, zi + 1), u),
    lerp(h3(xi, yi + 1, zi + 1), h3(xi + 1, yi + 1, zi + 1), u),
    v,
  );
  return lerp(a, b, w);
}
export function fbm(x: number, y: number, z: number, o: number): number {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let n = 0;
  for (let i = 0; i < o; i++) {
    s += a * n3(x * f, y * f, z * f);
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / n;
}

/** The flesh pattern tables (TM marble, TB vein, TF fibre, TD detail), 1024 × 32, interleaved RGBA float. Built once. */
export const MOUTH_NOISE_W = 1024;
export const MOUTH_NOISE_H = 32;
let NOISE: Float32Array | null = null;
export function mouthNoiseTable(): Float32Array {
  if (NOISE) return NOISE;
  const NU = MOUTH_NOISE_W;
  const NV = MOUTH_NOISE_H;
  const out = new Float32Array(NU * NV * 4);
  for (let j = 0; j < NV; j++)
    for (let i = 0; i < NU; i++) {
      const u = i * 1.0;
      const v = (j / (NV - 1)) * 2 - 1;
      const k = (j * NU + i) * 4;
      out[k] = fbm(u * 0.007, v * 0.25, 0.3, 3);
      out[k + 1] = 1 - Math.abs(2 * fbm(u * 0.03, v * 1.3 + u * 0.01, 0.6, 2) - 1);
      out[k + 2] = n3(u * 0.025, v * 2.2, 0.9);
      out[k + 3] = n3(u * 0.2, v * 3, 1.7);
    }
  NOISE = out;
  return out;
}
