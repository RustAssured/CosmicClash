import { rgba } from '@/contracts';
import type { Portrait } from '../portrait';
import { MOUTH_PORTRAIT } from './portraitData';

let cached: Portrait | null = null;

/**
 * The Mouth's menu portrait: its head at rest from the LOCKED oracle (baked by tools/mouth/portrait-bake.ts; the Mouth has no
 * matter map to sample). Packed RGBA, transparent outside the figure.
 */
export function mouthPortrait(): Portrait {
  if (cached) return cached;
  const { w, h, rgba: b64 } = MOUTH_PORTRAIT;
  const bin = globalThis.atob(b64);
  const pixels = new Uint32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = bin.charCodeAt(i * 4 + 3);
    if (a < 128) continue;
    pixels[i] = rgba(bin.charCodeAt(i * 4), bin.charCodeAt(i * 4 + 1), bin.charCodeAt(i * 4 + 2), 255);
  }
  cached = { pixels, w, h };
  return cached;
}
