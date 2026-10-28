import type { TitanDef } from '@/contracts';
import { buildImageRig, paintImage, type ImageBody } from '../image';
import type { KitTitan } from '../types';
import body from './body.json';
import json from './remainder.json';

/**
 * remainder: a kit titan whose body was imported from key art in the titan builder (dev/builder/, "Import art"): body.json holds
 * its cells, the image painter (src/titans/kit/image.ts) lights them with its JSON's material ramps. Re-import or recolour it
 * in the builder; write its own painter here if it outgrows the import.
 */
const def = json as unknown as TitanDef;
const art = body as ImageBody;
const kit: KitTitan = {
  def,
  paint: (d, _seed, light) => paintImage(d, art, light),
  rig: (d) => buildImageRig(d, art),
};
export default kit;
