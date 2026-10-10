/**
 * Frame packs: baked sequences of native frames (the LOCKED Mouth, tools/cinema/mouth-bake.ts) for actors that play them
 * back. Every pixel is already a master-palette colour, so a frame is a run-length stream of palette indices:
 *
 *   header  'CFP1' u32 · width u16 · height u16 · frames u32 · colours u16 · palette (colours × 3 bytes RGB)
 *   offsets frames × u32 (byte offset of each frame's stream from the start of the file)
 *   frame   runs of [count (LEB128), value (u8)] covering width × height pixels; value 255 = transparent, otherwise
 *           bit 7 = emissive (feeds the bloom), bits 0–6 = palette index
 *
 * Decoding is synchronous (an actor's draw is), and a frame is decoded straight into the actor's native buffer.
 */
export interface FramePack {
  w: number;
  h: number;
  frames: number;
  /** Packed RGBA (0xAABBGGRR) per palette index. */
  palette: Uint32Array;
  data: Uint8Array;
  offsets: Uint32Array;
}

export function readPack(buf: ArrayBuffer | Uint8Array): FramePack {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint32(0, true) !== 0x31504643) throw new Error('not a cinema frame pack (CFP1)');
  const w = dv.getUint16(4, true);
  const h = dv.getUint16(6, true);
  const frames = dv.getUint32(8, true);
  const n = dv.getUint16(12, true);
  const palette = new Uint32Array(n);
  let o = 14;
  for (let i = 0; i < n; i++, o += 3)
    palette[i] = (0xff000000 | (data[o + 2]! << 16) | (data[o + 1]! << 8) | data[o]!) >>> 0;
  const offsets = new Uint32Array(frames);
  for (let i = 0; i < frames; i++, o += 4) offsets[i] = dv.getUint32(o, true);
  return { w, h, frames, palette, data, offsets };
}

/**
 * Draw frame `i` of a pack into a native buffer: at (dx, dy), scaled by `s` (< 1 samples the frame nearest-neighbour into
 * a smaller rectangle: the pull-back's shrinking arena), keeping what is already there under transparent pixels.
 */
export function drawPackFrame(
  buf: { w: number; h: number; pixels: Uint32Array; emissive: Uint8Array },
  pack: FramePack,
  i: number,
  dx = 0,
  dy = 0,
  s = 1,
): void {
  if (i < 0 || i >= pack.frames) return;
  const { w, h, data, palette } = pack;
  let o = pack.offsets[i]!;
  const total = w * h;
  // decode the runs into a scratch row-major index plane, then blit (s = 1 straight, s < 1 by sampling)
  const plane = scratch(total);
  let p = 0;
  while (p < total) {
    let count = 0;
    let shift = 0;
    let b: number;
    do {
      b = data[o++]!;
      count |= (b & 127) << shift;
      shift += 7;
    } while (b & 128);
    const v = data[o++]!;
    plane.fill(v, p, Math.min(total, p + count));
    p += count;
  }
  const { w: W, h: H, pixels, emissive } = buf;
  if (s === 1) {
    for (let y = 0; y < h; y++) {
      const Y = y + dy;
      if (Y < 0 || Y >= H) continue;
      for (let x = 0; x < w; x++) {
        const v = plane[y * w + x]!;
        if (v === 255) continue;
        const X = x + dx;
        if (X < 0 || X >= W) continue;
        pixels[Y * W + X] = palette[v & 127]!;
        emissive[Y * W + X] = v & 128 ? 255 : 0;
      }
    }
    return;
  }
  const ow = Math.max(1, Math.round(w * s));
  const oh = Math.max(1, Math.round(h * s));
  for (let y = 0; y < oh; y++) {
    const Y = y + dy;
    if (Y < 0 || Y >= H) continue;
    const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / oh));
    for (let x = 0; x < ow; x++) {
      const X = x + dx;
      if (X < 0 || X >= W) continue;
      const sx = Math.min(w - 1, Math.floor(((x + 0.5) * w) / ow));
      const v = plane[sy * w + sx]!;
      if (v === 255) continue;
      pixels[Y * W + X] = palette[v & 127]!;
      emissive[Y * W + X] = v & 128 ? 255 : 0;
    }
  }
}

let plane: Uint8Array | null = null;
function scratch(n: number): Uint8Array {
  if (!plane || plane.length < n) plane = new Uint8Array(n);
  return plane;
}

/** Encode frames (palette indices, 255 = transparent, bit 7 = emissive) into a pack (tools only). */
export function writePack(w: number, h: number, palette: Uint32Array, frames: Uint8Array[]): Uint8Array {
  const parts: number[][] = [];
  for (const f of frames) {
    const out: number[] = [];
    let i = 0;
    while (i < f.length) {
      const v = f[i]!;
      let j = i + 1;
      while (j < f.length && f[j] === v) j++;
      let c = j - i;
      do {
        let b = c & 127;
        c >>>= 7;
        if (c) b |= 128;
        out.push(b);
      } while (c);
      out.push(v);
      i = j;
    }
    parts.push(out);
  }
  const head = 14 + palette.length * 3 + frames.length * 4;
  const size = head + parts.reduce((a, p) => a + p.length, 0);
  const data = new Uint8Array(size);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 0x31504643, true);
  dv.setUint16(4, w, true);
  dv.setUint16(6, h, true);
  dv.setUint32(8, frames.length, true);
  dv.setUint16(12, palette.length, true);
  let o = 14;
  for (const c of palette) {
    data[o++] = c & 255;
    data[o++] = (c >>> 8) & 255;
    data[o++] = (c >>> 16) & 255;
  }
  let at = head;
  const offAt = o;
  parts.forEach((p, k) => {
    dv.setUint32(offAt + k * 4, at, true);
    data.set(p, at);
    at += p.length;
  });
  return data;
}

/** Where the packs live, and how an actor gets one: fetched in the engine, handed in by Node tools. */
const PACKS = new Map<string, FramePack>();
const loading = new Map<string, Promise<FramePack>>();
export const PACK_BASE = '/press/cinema/work/mouth/';
export function providePack(name: string, pack: FramePack): void {
  PACKS.set(name, pack);
}
export const packNow = (name: string): FramePack | null => PACKS.get(name) ?? null;
export function loadPack(name: string): Promise<FramePack> {
  const hit = PACKS.get(name);
  if (hit) return Promise.resolve(hit);
  let p = loading.get(name);
  if (!p) {
    p = fetch(`${PACK_BASE}${name}.cfp`)
      .then((r) => {
        if (!r.ok)
          throw new Error(`frame pack ${name}: ${r.status} (bake it: npx tsx tools/cinema/mouth-bake.ts)`);
        return r.arrayBuffer();
      })
      .then((b) => {
        const pack = readPack(b);
        PACKS.set(name, pack);
        return pack;
      });
    loading.set(name, p);
  }
  return p;
}
