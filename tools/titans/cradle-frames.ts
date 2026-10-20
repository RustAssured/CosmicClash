/**
 * Extract the Cradle's approved sail frames from the built prototype page (idle handover `prototypes/built/cradle-idle.html`;
 * WJ 2026-10-19: ship the approved frames): 32 precession frames and 240 claw frames, palette-indexed, painted by the
 * game's own painter at seed 7 under DEFAULT_LIGHTING (the deleted exporter's output; specs/cradle.md §2).
 *
 *   npx tsx tools/titans/cradle-frames.ts <path to cradle-idle.html>
 *
 * Writes into src/titans/kit/cradle/:
 *  - cradle_frames.bin: the page's own zlib stream, inflating to uint16 palette indices (0 = empty), frames concatenated;
 *  - cradle_frames.json: the palette ([r, g, b, material]), the frames (kind, ti, c, w, h, ox, oy, rx, ry, roll, off in
 *    uint16 units), and the default-lit REST disc as palette indices (`rest`, the game's disc region at seed 7, row-major):
 *    the game recolours the palette for its stage by comparing that with its own stage-lit disc.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { resolve } from 'node:path';
import { DEFAULT_LIGHTING } from '@/contracts';
import { getTitanDef } from '@/titans';
import { paintCradle } from '@/titans/kit/cradle/paint';

const page = process.argv[2];
if (!page) throw new Error('usage: cradle-frames.ts <cradle-idle.html>');
const html = readFileSync(page, 'utf8');
const dm = /const DATA = '([A-Za-z0-9+/=]+)';/.exec(html);
const mi = html.indexOf('const META = ');
if (!dm || mi < 0) throw new Error('DATA / META not found in the page');
// META is one JSON object literal followed by `;`
let depth = 0;
let end = -1;
for (let i = mi + 'const META = '.length; i < html.length; i++) {
  const ch = html[i];
  if (ch === '{') depth++;
  else if (ch === '}') {
    depth--;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}
const META = JSON.parse(html.slice(mi + 'const META = '.length, end)) as {
  pal: [number, number, number, number][];
  frames: {
    kind: string;
    ti: number;
    c: number;
    w: number;
    h: number;
    ox: number;
    oy: number;
    rx: number;
    ry: number;
    roll: number;
    off: number;
  }[];
  materials: { key: string }[];
};
const zipped = Buffer.from(dm[1]!, 'base64');
const raw = inflateSync(zipped);
const idx = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);

// the default-lit rest disc of the game's own Cradle (seed 7), as palette indices
const def = getTitanDef('cradle' as never);
const { rig } = paintCradle(def, 7, DEFAULT_LIGHTING);
const disc = (
  rig as unknown as {
    regions: {
      kind: string;
      ox: number;
      oy: number;
      map: { w: number; h: number; material: Uint8Array; baseColor: Uint32Array };
    }[];
  }
).regions.find((r) => r.kind === 'disc')!;
const key = (r: number, g: number, b: number, m: number): string => `${r},${g},${b},${m}`;
const palIdx = new Map<string, number>();
META.pal.forEach((p, i) => palIdx.set(key(p[0], p[1], p[2], p[3]), i + 1));
const rest = new Array<number>(disc.map.w * disc.map.h).fill(0);
let miss = 0;
for (let i = 0; i < rest.length; i++) {
  const m = disc.map.material[i]!;
  if (!m) continue;
  const c = disc.map.baseColor[i]!;
  const k = palIdx.get(key(c & 255, (c >>> 8) & 255, (c >>> 16) & 255, m));
  if (k === undefined) miss++;
  else rest[i] = k;
}
const out = resolve('src/titans/kit/cradle');
writeFileSync(`${out}/cradle_frames.bin`, zipped);
writeFileSync(
  `${out}/cradle_frames.json`,
  JSON.stringify({
    pal: META.pal,
    frames: META.frames.map((f) => ({
      kind: f.kind,
      ti: f.ti,
      c: f.c,
      w: f.w,
      h: f.h,
      ox: f.ox,
      oy: f.oy,
      rx: f.rx,
      ry: f.ry,
      roll: f.roll,
      off: f.off,
    })),
    materials: META.materials.map((m) => m.key),
    rest: { ox: disc.ox, oy: disc.oy, w: disc.map.w, h: disc.map.h, idx: rest },
  }),
);
console.log(
  `frames ${META.frames.length}, palette ${META.pal.length}, ${idx.length} cells (${(zipped.length / 1e6).toFixed(2)} MB zipped); rest disc ${disc.map.w}x${disc.map.h}, ${miss} cells off the palette`,
);
