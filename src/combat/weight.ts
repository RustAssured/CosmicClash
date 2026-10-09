import { BLOW_WEIGHTS, type BlowWeight, type MoveDef, type MoveSlot } from '@/contracts';

/**
 * Blow weight (shared/VFX_SPEC.md item 6; proposal 171): which of light · medium · heavy · catastrophic a landed blow is.
 * It sets the hit-stop and the camera shake here and the shared impact VFX (S5).
 *
 * Order of precedence: the move's own `extra.weight` (any titan can author it), then the table below for the Witness and the
 * Planet (their moves live in S2's / S3's files; the mapping is proposed in 171), then a fallback by slot and energy for every
 * other titan. A guarded blow lands one step lighter; the blow that KOs is catastrophic (fighter.ts).
 */
export const MOVE_WEIGHTS: Readonly<Record<string, BlowWeight>> = {
  // the Witness
  'witness.halo': 'light', // each arc / shard is a separate small cut
  'witness.gaze': 'light', // the beam marks (continuous: no hit-stop either way)
  'witness.fracture': 'medium', // a gaze / shear mark shearing 0.3–0.8 s later
  'witness.charge': 'medium', // the lunge out of the sidestep
  'witness.sweep': 'heavy', // Sweeping Architecture's blades and Structural Shear's cone
  'witness.revelation': 'heavy',
  // the Planet
  'planet.shift': 'light', // Orbital Drift's shove
  'planet.moonslam': 'medium',
  'planet.magmavent': 'medium',
  'planet.comet': 'heavy', // the slung comet
  'planet.impact': 'heavy', // Tidal Rush
  'planet.crustbreaker': 'heavy',
  'planet.corepulse': 'heavy',
  'planet.cataclysm': 'heavy',
  // the returning originals (D34): their own mechanics, read on the same ladder
  'asteroid.shoulder': 'medium', // a hop-check
  'asteroid.meteor': 'heavy', // the ram
  'asteroid.swarm': 'light', // each fragment
  'asteroid.kessler': 'medium', // a storm of many debris hits
  'nexus.latch': 'medium', // the chain bite that plants the infection
  'nexus.constrict': 'heavy', // the crushing grab
  'nexus.harvest': 'light', // continuous tearing
  'nexus.oog': 'light', // the cage's grinding ticks
  'blackhole.shear': 'heavy', // tidal shear (huge energy, a short field)
  'blackhole.maw': 'catastrophic', // the maw: the black hole's heaviest single blow
  'blackhole.well': 'light', // continuous pull
  'blackhole.spaghetti': 'light', // continuous spaghettification ticks
  'supernova.flare': 'medium',
  'supernova.ejection': 'heavy', // the mass ejection
  'supernova.prominence': 'light', // a lingering zone
  'supernova.collapse': 'heavy',
  'supernova.nova': 'catastrophic', // the nova itself
  // 우리 (VFX_SPEC "Titan hooks": punch / cross / uppercut heavy, double slam catastrophic; its break-apart is the KO blow)
  'uri.punch': 'heavy',
  'uri.cross': 'heavy',
  'uri.upper': 'heavy',
  'uri.slam': 'catastrophic',
};

const isWeight = (w: unknown): w is BlowWeight => BLOW_WEIGHTS.includes(w as BlowWeight);

/** The weight a blow is thrown with (before guard and KO adjust it). */
export function blowWeight(
  moveId: string,
  def: MoveDef | null,
  slot: MoveSlot,
  energy: number,
  continuous: boolean,
): BlowWeight {
  const own = def?.id === moveId ? def.extra?.['weight'] : undefined;
  if (isWeight(own)) return own;
  const table = MOVE_WEIGHTS[moveId];
  if (table) return table;
  if (continuous) return 'light';
  // by the blow's energy, the heavier slots reaching each weight sooner (a cage's or a barrage's many small ticks stay light)
  const [medium, heavy] = FALLBACK[slot] ?? [250, 900];
  return energy >= heavy ? 'heavy' : energy >= medium ? 'medium' : 'light';
}

/** Fallback energy thresholds [medium, heavy] per slot (titans without an authored or tabled weight). */
const FALLBACK: Partial<Record<MoveSlot, readonly [number, number]>> = {
  strike: [220, 800],
  crush: [200, 500],
  ultimate: [200, 500],
  signature: [250, 700],
};

/** One step lighter (a guarded blow), never below light. */
export function lighter(w: BlowWeight): BlowWeight {
  return BLOW_WEIGHTS[Math.max(0, BLOW_WEIGHTS.indexOf(w) - 1)]!;
}
