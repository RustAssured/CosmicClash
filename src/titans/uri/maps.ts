import { createMatterMap, rgba, type MaterialSpec, type MatterMap } from '@/contracts';
import { uriGrids } from './asset';
import { URI_PARTS, URI_REF, type UriPartKey } from './rig';

/**
 * 우리's part grids as matter maps (uri/data/uri_rig.json, loaded as is: nothing is repainted).
 *
 * Each of the 13 parts becomes one MatterMap in its own local space (spec §3): the material comes from the part's `mat` code
 * (and `surf` for warm / cool stone), the base colour is the oracle's own rest shading of that pixel (`shadeAt` with the part
 * unrotated: form light, live light, tone, crevice darkening, the lit rim, the outline; uri/src/10_parts_render.js), and the
 * relief is its form light. The per-pixel chunk ids ride along (`chunks`) for the tearing in 2C. Live shading of rotated
 * parts (normals, the form/live blend) is the lit part pass's job on the GPU; this is the matter and the at-rest look.
 *
 * Deterministic; decoded once per process and cloned per fighter.
 */

/** Material codes in the asset (spec §3). */
export const URI_MAT = {
  rock: 1,
  field: 2,
  civ: 3,
  habitat: 7,
  crack: 8,
  slit: 9,
  crevice: 10,
} as const;

/** The oracle's ramps (uri/src/10_parts_render.js `RP`): two stone ramps of 11 steps, the emissive sets. */
export const URI_RAMPS = {
  s1: [
    '#08060a',
    '#120d11',
    '#1d1619',
    '#2a1f21',
    '#382a29',
    '#4a3834',
    '#5f4a42',
    '#776053',
    '#937a68',
    '#b3987f',
    '#cfb79a',
  ],
  s2: [
    '#07070c',
    '#100f17',
    '#1a1824',
    '#252232',
    '#312c40',
    '#3f3850',
    '#504762',
    '#645a76',
    '#7c708c',
    '#978ba5',
    '#b3a8bd',
  ],
  civ: ['#e88a3a', '#ffb060', '#ffd890'],
  field: ['#3a5ac8', '#6a92f8', '#b0ccff'],
} as const;

const UMAT = (
  key: string,
  base: string,
  ramp: readonly string[],
  emissive: number,
  crack: string,
  physics: MaterialSpec['physics'] = {},
): MaterialSpec => ({
  key,
  base,
  physics,
  visual: {
    ramp: [...ramp],
    emissive,
    // wound light in the pack's own colours: exposed habitat (warm civilization light), field blue
    glowRamp: ['#2c140a', '#ffd696', '#ffb060', '#b0ccff', '#ffffff'],
    char: ramp[1]!,
    crack,
    debris: ramp[Math.floor(ramp.length / 2)]!,
  },
});

/** 우리's materials: material id = index + 1 (the asset's codes map onto them in `idOf`). */
/**
 * Physics (S4's proposal for 2C): the masses are one dense, brittle war-body rock (the two stone surfaces, the crevices); the
 * authored cracks bond weaker (they part first); the emissive inlays (field, civilization lights, sensor slit) are lighter
 * glassy matter; the exposed habitat is already a wound — light and crumbly.
 */
const STONE = { density: 1.15, bond: 160, toughness: 0.6, brittleness: 0.7 };
const CREVICE = { density: 1.0, bond: 130, toughness: 0.5, brittleness: 0.7 };
const INLAY = { density: 0.75, bond: 120 };
export const URI_MATERIALS: readonly MaterialSpec[] = Object.freeze([
  UMAT('stoneWarm', 'rock', URI_RAMPS.s1, 0, '#1d1619', STONE),
  UMAT('stoneCool', 'rock', URI_RAMPS.s2, 0, '#1a1824', STONE),
  UMAT('field', 'crystal', URI_RAMPS.field, 200, '#b0ccff', { density: 0.6, bond: 120 }),
  UMAT('civLight', 'glass', URI_RAMPS.civ, 210, '#ffd890', INLAY),
  UMAT('habitat', 'glass', ['#2c140a', '#8a5a30', '#ffd696'], 160, '#ffd696', {
    density: 0.65,
    bond: 70,
    toughness: 0.25,
    brittleness: 0.4,
  }),
  UMAT('crack', 'rock', ['#5a3018', '#c87a40', '#ffaa5a'], 150, '#ffaa5a', {
    density: 1.0,
    bond: 90,
    toughness: 0.4,
    brittleness: 0.8,
  }),
  UMAT('slit', 'glass', ['#5a6a8a', '#b4dcff', '#ffbe78'], 200, '#b4dcff', INLAY),
  UMAT('creviceWarm', 'rock', URI_RAMPS.s1.slice(0, 5), 0, '#08060a', CREVICE),
  UMAT('creviceCool', 'rock', URI_RAMPS.s2.slice(0, 5), 0, '#07070c', CREVICE),
]);

const ID = new Map(URI_MATERIALS.map((m, i) => [m.key, i + 1]));
const idOf = (code: number, surf: number): number => {
  switch (code) {
    case URI_MAT.rock:
      return ID.get(surf === 2 ? 'stoneCool' : 'stoneWarm')!;
    case URI_MAT.field:
      return ID.get('field')!;
    case URI_MAT.civ:
      return ID.get('civLight')!;
    case URI_MAT.habitat:
      return ID.get('habitat')!;
    case URI_MAT.crack:
      return ID.get('crack')!;
    case URI_MAT.slit:
      return ID.get('slit')!;
    case URI_MAT.crevice:
      return ID.get(surf === 2 ? 'creviceCool' : 'creviceWarm')!;
    default:
      return ID.get(surf === 2 ? 'stoneCool' : 'stoneWarm')!;
  }
};

/** A decoded part: its matter map (pristine) and its per-cell chunk ids. */
export interface UriPartMatter {
  key: UriPartKey;
  map: MatterMap;
  chunks: Uint16Array;
  /**
   * Shading planes for the lit part pass (S4 → S5; map-local, row-major, RGBA8 per cell, the rig's own bytes):
   * `light` = (nx, ny, nz, form) — the proposal-172 `RenderLayer.light` format; `shade` = (surf 1 warm / 2 cool, tone, edge
   * distance, asset material code) — what the oracle's `shadeAt` reads besides the normals.
   */
  light: Uint8Array;
  shade: Uint8Array;
}

export interface RawFields {
  name: string;
  w: number;
  h: number;
  x0: number;
  y0: number;
  pivX: number;
  pivY: number;
  mat: string;
  surf: string;
  tone: string;
  form: string;
  nx: string;
  ny: string;
  nz: string;
  edge: string;
  chunk: string;
}

const B64 = (() => {
  const t = new Int16Array(128).fill(-1);
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < a.length; i++) t[a.charCodeAt(i)] = i;
  return t;
})();

/** Base64 → bytes (no DOM; the asset's fields). */
export function decodeBase64(s: string): Uint8Array {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === 61) n--;
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < n; i++) {
    const v = B64[s.charCodeAt(i)]!;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}

const hex = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const RX = {
  s1: URI_RAMPS.s1.map(hex),
  s2: URI_RAMPS.s2.map(hex),
  civ: URI_RAMPS.civ.map(hex),
  field: URI_RAMPS.field.map(hex),
};
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);
const rampAt = (R: [number, number, number][], l: number, x: number, y: number): [number, number, number] => {
  const k = Math.floor(l * R.length * 1.02 + BAYER[(y & 3) * 4 + (x & 3)]! * 0.6);
  return R[k < 0 ? 0 : k >= R.length ? R.length - 1 : k]!;
};
/** The sky: upper-left-front (spec §2.3). */
const LS = (() => {
  const l = [-0.55, -0.62, 0.56];
  const n = Math.hypot(l[0]!, l[1]!, l[2]!);
  return l.map((v) => v / n) as [number, number, number];
})();

/** The oracle's shading of one unrotated pixel (`shadeAt` with angle 0: the form light dominates, wForm = 0.82). */
function restColour(f: Decoded, i: number, x: number, y: number): number {
  const mat = f.mat[i]!;
  switch (mat) {
    case URI_MAT.civ: {
      const c = RX.civ[(x * 7 + y * 3) % 3]!;
      return rgba(c[0], c[1], c[2]);
    }
    case URI_MAT.field: {
      const c = RX.field[(x + y) % 3 === 0 ? 2 : 1]!;
      return rgba(c[0], c[1], c[2]);
    }
    case URI_MAT.slit:
      return x % 2 ? rgba(255, 190, 120) : rgba(180, 220, 255);
    case URI_MAT.habitat:
      return (x + y) % 4 === 0 || (x - y) % 4 === 0 ? rgba(255, 214, 150) : rgba(44, 20, 10);
    case URI_MAT.crack:
      return rgba(255, 170, 90);
    default:
  }
  const lnx = (f.nx[i]! - 128) / 120;
  const lny = (f.ny[i]! - 128) / 120;
  const lnz = f.nz[i]! / 250;
  const dk = Math.max(0, lnx * LS[0] + lny * LS[1] + lnz * LS[2]);
  const wForm = 0.82;
  const form = f.form[i]! / 255;
  const tone = f.tone[i]! / 255;
  let lum = wForm * form * 1.3 + (1 - wForm) * (0.06 + 0.58 * dk) + (tone - 0.5) * 0.22;
  if (mat === URI_MAT.crevice) lum *= 0.3;
  let c = rampAt(f.surf[i] === 2 ? RX.s2 : RX.s1, lum, x, y);
  const rim = Math.pow(1 - lnz, 2) * Math.max(0, lnx * 0.9 - lny * 0.1);
  if (rim > 0.5 && mat === URI_MAT.rock)
    c = [(c[0] * 0.6 + 44) | 0, (c[1] * 0.6 + 47.2) | 0, (c[2] * 0.6 + 64) | 0];
  // every part outlined in its own darker colour
  if (f.edge[i]! <= 1.01) c = [(c[0] * 0.55) | 0, (c[1] * 0.55) | 0, (c[2] * 0.6) | 0];
  return rgba(c[0], c[1], c[2]);
}

export interface Decoded {
  mat: Uint8Array;
  surf: Uint8Array;
  tone: Uint8Array;
  form: Uint8Array;
  nx: Uint8Array;
  ny: Uint8Array;
  nz: Uint8Array;
  edge: Uint8Array;
  chunk: Uint16Array;
}

let DECODED: UriPartMatter[] | null = null;

/** The per-cell fields of one part straight from uri_rig.json (base64): the reference the packed asset is tested against. */
export function decodeJsonPart(r: RawFields): Decoded {
  const ck = decodeBase64(r.chunk);
  return {
    mat: decodeBase64(r.mat),
    surf: decodeBase64(r.surf),
    tone: decodeBase64(r.tone),
    form: decodeBase64(r.form),
    nx: decodeBase64(r.nx),
    ny: decodeBase64(r.ny),
    nz: decodeBase64(r.nz),
    edge: decodeBase64(r.edge),
    chunk: new Uint16Array(
      ck.buffer.slice(ck.byteOffset, ck.byteOffset + (ck.length & ~1)),
      0,
      ck.length >> 1,
    ),
  };
}

function decodeAll(fields: readonly Decoded[] = uriGrids()): UriPartMatter[] {
  return URI_PARTS.map((meta, pi) => {
    const f = fields[pi]!;
    const map = createMatterMap(meta.w, meta.h);
    // the oracle draws its origin (200, 170) at screen (320, 186): use the same screen coordinates for the dither pattern
    const sx0 = meta.x0 + URI_REF.screenX - URI_REF.originX;
    const sy0 = meta.y0 + URI_REF.screenY - URI_REF.originY;
    for (let iy = 0; iy < meta.h; iy++)
      for (let ix = 0; ix < meta.w; ix++) {
        const i = iy * meta.w + ix;
        const code = f.mat[i]!;
        if (!code) continue;
        map.material[i] = idOf(code, f.surf[i]!);
        map.density[i] = 128;
        map.baseColor[i] = restColour(f, i, sx0 + ix, sy0 + iy);
        map.height[i] = f.form[i]!;
      }
    // the connectivity anchor / core: the live cell nearest the pivot
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < map.material.length; i++) {
      if (!map.material[i]) continue;
      const d = ((i % meta.w) + 0.5 - meta.pivX) ** 2 + (Math.floor(i / meta.w) + 0.5 - meta.pivY) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    map.coreX = best % meta.w;
    map.coreY = Math.floor(best / meta.w);
    map.coreRadius = 3;
    const n = meta.w * meta.h;
    const light = new Uint8Array(n * 4);
    const shade = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      light[4 * i] = f.nx[i]!;
      light[4 * i + 1] = f.ny[i]!;
      light[4 * i + 2] = f.nz[i]!;
      light[4 * i + 3] = f.form[i]!;
      shade[4 * i] = f.surf[i]!;
      shade[4 * i + 1] = f.tone[i]!;
      shade[4 * i + 2] = f.edge[i]!;
      shade[4 * i + 3] = f.mat[i]!;
    }
    return { key: meta.key, map, chunks: f.chunk, light, shade };
  });
}

/** Every part's pristine matter (decoded once; do not mutate: clone before handing a map to the world). */
export function uriPartMatter(): readonly UriPartMatter[] {
  if (!DECODED) DECODED = decodeAll();
  return DECODED;
}

/** Build the part matter from explicitly given fields (tests: the JSON's base64 grids vs the packed asset). */
export function uriPartMatterFrom(fields: readonly Decoded[]): UriPartMatter[] {
  return decodeAll(fields);
}

/** A private copy of a part's map (the matter world mutates the maps it is given). */
export function cloneUriMap(src: MatterMap): MatterMap {
  const m = createMatterMap(src.w, src.h);
  m.material.set(src.material);
  m.density.set(src.density);
  m.baseColor.set(src.baseColor);
  m.height.set(src.height);
  m.coreX = src.coreX;
  m.coreY = src.coreY;
  m.coreRadius = src.coreRadius;
  return m;
}
