import type { TitanDef } from '@/contracts';
import type { KitTitan } from '../types';
import json from './cradle.json';
import { buildCradleRig, paintCradle } from './paint';

/**
 * THE CRADLE / 태반체: made with the titan kit (blob template), grown into its own painter and rig (./paint.ts). WJ's brief:
 * docs/titans/cradle/BRIEF.md. Gate 1 (look and silhouette) only: its moves and behaviour are still the blob's.
 */
const def = json as unknown as TitanDef;
const kit: KitTitan = { def, paint: paintCradle, rig: buildCradleRig };
export default kit;
