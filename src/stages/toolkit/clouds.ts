import { Rng, smoothstep } from '@/contracts';
import { SpriteBuilder, type SpriteBuffer } from './kit';
import type { Noise2 } from './noise';
import type { LayerBounds } from './stars';

export interface CloudOpts {
  count: number;
  bounds: LayerBounds;
  noise: Noise2;
  /** Noise frequency (1 / layer px) and octaves for the density field. */
  freq: number;
  octaves?: number;
  /** Density below `lo` is empty; acceptance probability rises to 1 at `hi`, raised to `power`. */
  lo: number;
  hi: number;
  power?: number;
  /** Half-size range of a puff (px) and stretch range (1 = round). */
  size: [number, number];
  stretch?: [number, number];
  /** Puff colour + alpha given position, density (0..1) and a random 0..1. Linear HDR rgb. */
  color: (x: number, y: number, d: number, u: number) => readonly [number, number, number, number];
  /** Optional spatial multiplier on density (concentrate the cloud in a band, near the light…). */
  mask?: (x: number, y: number) => number;
  /** Parallax jitter amplitude written to each sprite (× the layer's `spread`). */
  jitter?: number;
  /** Rotation follows a flow direction field (radians) when given, else random. */
  rotation?: (x: number, y: number, rng: Rng) => number;
  seed: number;
}

/** Puffs distributed by rejection sampling of a noise density: the soft particle body of a nebula. */
export function makeCloud(o: CloudOpts): SpriteBuffer {
  const rng = new Rng(o.seed);
  const b = new SpriteBuilder();
  const { bounds: bd } = o;
  const w = bd.x1 - bd.x0;
  const h = bd.y1 - bd.y0;
  const stretch = o.stretch ?? [1, 1];
  let attempts = 0;
  const maxAttempts = o.count * 60;
  while (b.count < o.count && attempts++ < maxAttempts) {
    const x = bd.x0 + rng.next() * w;
    const y = bd.y0 + rng.next() * h;
    let d = o.noise.fbm(x * o.freq, y * o.freq, o.octaves ?? 5);
    if (o.mask) d *= o.mask(x, y);
    const p = Math.pow(smoothstep(o.lo, o.hi, d), o.power ?? 1.5);
    if (rng.next() > p) continue;
    const s = o.size[0] + (o.size[1] - o.size[0]) * Math.pow(rng.next(), 1.6);
    const st = stretch[0] + (stretch[1] - stretch[0]) * rng.next();
    const rot = o.rotation ? o.rotation(x, y, rng) : rng.next() * Math.PI * 2;
    const c = o.color(x, y, d, rng.next());
    b.push(x, y, (rng.next() * 2 - 1) * (o.jitter ?? 1), rng.next(), s * st, s / st, rot, c[0], c[1], c[2], c[3]);
  }
  return b.build();
}
