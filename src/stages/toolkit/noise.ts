import { Rng } from '@/contracts';

/**
 * CPU-side seeded noise used to PLACE things (particle positions, star fields, pillar layouts). Deterministic:
 * the same seed always yields the same universe. The GPU has its own texture-based noise for per-pixel work.
 */

const quintic = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

export class Noise2 {
  private readonly perm = new Uint8Array(512);
  private readonly gx = new Float32Array(256);
  private readonly gy = new Float32Array(256);

  constructor(seed: number) {
    const rng = new Rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = p[i]!;
      p[i] = p[j]!;
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]!;
    for (let i = 0; i < 256; i++) {
      const a = rng.next() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }

  /** Gradient noise in roughly [-1, 1]. */
  noise(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const perm = this.perm;
    const h00 = perm[perm[X]! + Y]!;
    const h10 = perm[perm[X + 1]! + Y]!;
    const h01 = perm[perm[X]! + Y + 1]!;
    const h11 = perm[perm[X + 1]! + Y + 1]!;
    const n00 = this.gx[h00]! * xf + this.gy[h00]! * yf;
    const n10 = this.gx[h10]! * (xf - 1) + this.gy[h10]! * yf;
    const n01 = this.gx[h01]! * xf + this.gy[h01]! * (yf - 1);
    const n11 = this.gx[h11]! * (xf - 1) + this.gy[h11]! * (yf - 1);
    const u = quintic(xf);
    const v = quintic(yf);
    const a = n00 + (n10 - n00) * u;
    const b = n01 + (n11 - n01) * u;
    return (a + (b - a) * v) * 1.4142;
  }

  /** Fractal sum, normalised to roughly [0, 1]. */
  fbm(x: number, y: number, octaves = 5, lacunarity = 2.02, gain = 0.5): number {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let fx = x;
    let fy = y;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise(fx, fy);
      norm += amp;
      // rotate a little each octave so the lattice never lines up
      const nx = fx * 0.8 - fy * 0.6;
      const ny = fx * 0.6 + fy * 0.8;
      fx = nx * lacunarity + 17.3;
      fy = ny * lacunarity - 9.1;
      amp *= gain;
    }
    return (sum / norm) * 0.5 + 0.5;
  }
}

/** 256×256 RGBA8 of independent uniform noise (four decorrelated channels) for the GPU value-noise lookups. */
export function noiseTextureData(seed: number): Uint8Array {
  const rng = new Rng(seed);
  const d = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < d.length; i++) d[i] = rng.int(256);
  return d;
}
