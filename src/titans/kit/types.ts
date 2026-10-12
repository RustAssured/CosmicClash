import type { StageLighting, TitanDef } from '@/contracts';
import type { PaintedTitan, TitanRig } from '../generate';

/**
 * A titan built with the titan kit (`npm run new:titan`): its definition (JSON, with the `kit` roster block), its painter and
 * its rig builder. Its behaviour is registered in src/combat/behaviours/kit/ (the combat layer), its voice is tuned by the
 * JSON's `kit.voice` (src/audio/voices/kitVoice.ts). Everything else (menus, site, press, checks) reads the roster.
 */
export interface KitTitan {
  def: TitanDef;
  paint(def: TitanDef, seed: number, lighting: StageLighting): PaintedTitan;
  rig(def: TitanDef, seed: number): TitanRig;
}
