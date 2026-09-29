/**
 * Ordered-dither threshold matrices (pure). The renderer uploads one of these as an R8 texture and indexes it with the
 * LOGICAL pixel coordinate, so the pattern is locked to the pixel grid — that is what makes gradients read as drawn.
 */

/** Classic recursive Bayer matrix of side n (power of two). Values are ranks 0..n²-1, every rank used exactly once. */
export function bayerRanks(n: number): Uint16Array {
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error('bayer size must be a power of two >= 2');
  let m: number[][] = [
    [0, 2],
    [3, 1],
  ];
  for (let size = 2; size < n; size *= 2) {
    const next: number[][] = Array.from({ length: size * 2 }, () => new Array<number>(size * 2).fill(0));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = m[y]![x]! * 4;
        next[y]![x] = v;
        next[y]![x + size] = v + 2;
        next[y + size]![x] = v + 3;
        next[y + size]![x + size] = v + 1;
      }
    }
    m = next;
  }
  const out = new Uint16Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = m[y]![x]!;
  return out;
}

/** Threshold in (0,1) for the pixel at (x, y): (rank + 0.5) / n². */
export function bayerThreshold(ranks: Uint16Array, n: number, x: number, y: number): number {
  return (ranks[(y & (n - 1)) * n + (x & (n - 1))]! + 0.5) / (n * n);
}

/** Matrix as 8-bit texels for an R8 texture. Threshold = (texel + 0.5) / 255 in the shader for n = 8 (64 levels are exact). */
export function bayerTexels(n: number): Uint8Array {
  const r = bayerRanks(n);
  const out = new Uint8Array(n * n);
  const levels = n * n;
  for (let i = 0; i < out.length; i++) out[i] = Math.round(((r[i]! + 0.5) / levels) * 255);
  return out;
}

/**
 * Quantise `v` ∈ [0,1] to `levels` steps with an ordered-dither threshold (used for dithered bloom / vignette so
 * post effects stay in the pixel-art idiom instead of introducing smooth gradients).
 */
export function ditherQuantise(v: number, levels: number, threshold: number): number {
  return Math.floor(Math.min(1, Math.max(0, v)) * levels + threshold) / levels;
}
