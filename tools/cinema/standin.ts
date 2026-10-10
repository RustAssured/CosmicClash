/**
 * S7's stand-in for the Director's compose (P4/P6 gates only; the real one is S5's src/cinema/director.ts): layers
 * composited by depth (alpha 0 = see-through), a two-pass additive bloom from the emissive channel (≈3 px and ≈10 px,
 * UNIFICATION §5), and the result snapped back to the master palette through the Bayer dither (the renderer's final pass).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { NATIVE_H, NATIVE_W } from '../../src/cinema/types';
import { BAYER4, nearestMaster } from '../../src/cinema/p4/palette';

const W = NATIVE_W;
const H = NATIVE_H;

export class Frame {
  readonly pixels = new Uint32Array(W * H);
  readonly emissive = new Uint8Array(W * H);
  clear(c: number): void {
    this.pixels.fill(c);
    this.emissive.fill(0);
  }
  /** Lay a buffer over the frame (opaque pixels only). */
  over(src: { pixels: Uint32Array; emissive: Uint8Array }): void {
    for (let i = 0; i < W * H; i++) {
      const c = src.pixels[i]!;
      if (!(c >>> 24)) continue;
      this.pixels[i] = c;
      this.emissive[i] = src.emissive[i]!;
    }
  }
}

const tmp = new Float32Array(W * H * 3);
const glowSrc = new Float32Array(W * H * 3);
const glowA = new Float32Array(W * H * 3);
const glowB = new Float32Array(W * H * 3);
function blur(src: Float32Array, dst: Float32Array, r: number): void {
  const pass = (a: Float32Array, b: Float32Array, horiz: boolean): void => {
    const L = horiz ? W : H;
    const N = horiz ? H : W;
    for (let j = 0; j < N; j++) {
      const idx = (i: number): number => (horiz ? j * W + i : i * W + j) * 3;
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      for (let i = -r; i <= r; i++) {
        const k = idx(Math.min(L - 1, Math.max(0, i)));
        s0 += a[k]!;
        s1 += a[k + 1]!;
        s2 += a[k + 2]!;
      }
      for (let i = 0; i < L; i++) {
        const o = idx(i);
        b[o] = s0 / (2 * r + 1);
        b[o + 1] = s1 / (2 * r + 1);
        b[o + 2] = s2 / (2 * r + 1);
        const ka = idx(Math.max(0, i - r));
        const kb = idx(Math.min(L - 1, i + r + 1));
        s0 += a[kb]! - a[ka]!;
        s1 += a[kb + 1]! - a[ka + 1]!;
        s2 += a[kb + 2]! - a[ka + 2]!;
      }
    }
  };
  pass(src, tmp, true);
  pass(tmp, dst, false);
}

/** Bloom and palette snap: the finished native frame. */
export function finish(f: Frame, out = new Uint32Array(W * H)): Uint32Array {
  for (let i = 0; i < W * H; i++) {
    const c = f.pixels[i]!;
    const e = f.emissive[i]! / 255;
    glowSrc[i * 3] = (c & 255) * e;
    glowSrc[i * 3 + 1] = ((c >>> 8) & 255) * e;
    glowSrc[i * 3 + 2] = ((c >>> 16) & 255) * e;
  }
  blur(glowSrc, glowA, 2);
  blur(glowSrc, glowB, 7);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const c = f.pixels[i]!;
      const a0 = glowA[i * 3]! * 0.32 + glowB[i * 3]! * 0.22;
      const a1 = glowA[i * 3 + 1]! * 0.32 + glowB[i * 3 + 1]! * 0.22;
      const a2 = glowA[i * 3 + 2]! * 0.32 + glowB[i * 3 + 2]! * 0.22;
      if (a0 + a1 + a2 < 6) {
        out[i] = c;
        continue;
      }
      const d = (BAYER4[((y & 3) << 2) | (x & 3)]! - 0.5) * 14;
      const q = (v: number): number => Math.max(0, Math.min(255, Math.round(v + d)));
      out[i] = nearestMaster(q((c & 255) + a0), q(((c >>> 8) & 255) + a1), q(((c >>> 16) & 255) + a2));
    }
  return out;
}

/** An ffmpeg writer for native frames, delivered at ×2 nearest (so 4:2:0 chroma lands on whole pixels). */
export function videoWriter(
  file: string,
  fps = 60,
): { write(f: Uint32Array): Promise<void>; end(): Promise<void> } {
  const ff: ChildProcessWithoutNullStreams = spawn('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${W}x${H}`,
    '-r',
    String(fps),
    '-i',
    '-',
    '-vf',
    'scale=iw*2:ih*2:flags=neighbor',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '12',
    '-tune',
    'animation',
    '-pix_fmt',
    'yuv420p',
    file,
  ]);
  ff.stderr.on('data', (d: Buffer) => process.stderr.write(d));
  return {
    async write(f: Uint32Array): Promise<void> {
      const b = Buffer.from(f.slice().buffer);
      if (!ff.stdin.write(b)) await new Promise((r) => ff.stdin.once('drain', r));
    },
    async end(): Promise<void> {
      ff.stdin.end();
      await new Promise((r) => ff.on('close', r));
    },
  };
}
