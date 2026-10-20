/**
 * THE CRADLE'S SAIL FRAMES (idle handover specs/cradle.md §2; WJ 2026-10-19: ship the approved frames): 32 precession
 * frames and 240 claw frames (16 tilts × 15 claw values) of the disc, painted by the game's own painter at seed 7 under
 * DEFAULT_LIGHTING, palette-indexed (94 colours; 0 = empty). Extracted from the approved prototype by
 * tools/titans/cradle-frames.ts into cradle_frames.bin (zlib) and cradle_frames.json.
 *
 * Presentation only. The browser loads it once on first use (`requestCradleFrames(url)`, the Vite asset URL; until it has
 * arrived the sail draws its painted rest disc); in Node (tests, tools) `cradleFrames()` reads the file synchronously.
 */
import meta from './cradle_frames.json';

export interface CradleFrame {
  kind: 'loop' | 'claw';
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
}

export interface CradleFrames {
  /** Palette entries [r, g, b, material id], index 1-based in `idx`. */
  pal: readonly (readonly [number, number, number, number])[];
  frames: readonly CradleFrame[];
  /** The palette index of every frame cell, frames concatenated. */
  idx: Uint16Array;
  /** The default-lit rest disc (the game's disc region at seed 7) as palette indices: the stage recolouring's key. */
  rest: { ox: number; oy: number; w: number; h: number; idx: readonly number[] };
  nLoop: number;
  /** The claw values of one tilt, in frame order. */
  claw: readonly number[];
}

type Meta = Omit<CradleFrames, 'idx' | 'nLoop' | 'claw'>;
let data: CradleFrames | null = null;
let loading = false;

function install(raw: Uint8Array): void {
  const m = meta as unknown as Meta;
  const idx = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);
  const nLoop = m.frames.filter((f) => f.kind === 'loop').length;
  const claw = m.frames.filter((f) => f.kind === 'claw' && f.ti === 0).map((f) => f.c);
  data = { ...m, idx, nLoop, claw };
}

/** Browser: start loading the frames (once); `cradleFrames()` returns null until they are in. */
export function requestCradleFrames(url: string): void {
  if (data || loading || typeof fetch === 'undefined' || typeof DecompressionStream === 'undefined') return;
  loading = true;
  void fetch(url)
    .then((r) => {
      if (!r.ok || !r.body) throw new Error(`cradle frames: ${r.status}`);
      return new Response(r.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
    })
    .then((b) => install(new Uint8Array(b)))
    .catch(() => {
      loading = false;
    });
}

/** The frames, or null (not loaded yet in the browser). In Node the file is read synchronously on first use. */
export function cradleFrames(): CradleFrames | null {
  if (data) return data;
  const proc = (
    globalThis as { process?: { getBuiltinModule?: (id: string) => unknown; cwd?: () => string } }
  ).process;
  const fs = proc?.getBuiltinModule?.('node:fs') as { readFileSync(p: string): Uint8Array } | undefined;
  const zlib = proc?.getBuiltinModule?.('node:zlib') as
    { inflateSync(b: Uint8Array): Uint8Array } | undefined;
  if (!fs || !zlib || typeof window !== 'undefined') return null;
  const b = zlib.inflateSync(fs.readFileSync(`${proc!.cwd!()}/src/titans/kit/cradle/cradle_frames.bin`));
  install(new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
  return data;
}
