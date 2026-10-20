import type { TitanDef } from '@/contracts';
import type { KitTitan } from '../types';
import json from './cradle.json';
import { buildCradleRig, paintCradle } from './paint';

/**
 * THE CRADLE / 태반체: made with the titan kit (blob template), grown into its own painter and rig (./paint.ts). WJ's brief:
 * docs/titans/cradle/BRIEF.md. Gate 1 (look and silhouette) only: its moves and behaviour are still the blob's.
 */
const def = json as unknown as TitanDef;
/**
 * WJ 2026-10-19: every Cradle is the approved creature, painted from seed 7, so the living idle's shipped sail frames
 * (cradle_frames.bin, from the approved prototype) are its own disc. Its matter bodies still take the fighter's seed.
 */
export const CRADLE_PAINT_SEED = 7;
const kit: KitTitan = {
  def,
  paint: (d, _seed, lighting) => paintCradle(d, CRADLE_PAINT_SEED, lighting),
  rig: (d) => buildCradleRig(d, CRADLE_PAINT_SEED),
};
export default kit;
