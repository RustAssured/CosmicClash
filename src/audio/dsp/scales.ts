import type { StageId } from '@/contracts';
import { midiToHz } from './math';

/** Scale degrees in semitones above the root. */
export const MODES = {
  lydian: [0, 2, 4, 6, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
  wholetone: [0, 2, 4, 6, 8, 10],
  suspended: [0, 2, 7, 9, 12],
} as const;
export type ModeId = keyof typeof MODES;

export interface StageMusic {
  /** MIDI note of the drone root. */
  root: number;
  mode: ModeId;
  /** Base tempo in BPM (the score speeds up with intensity). */
  bpm: number;
  /** Which scale degrees (indices into the mode) the pad chords may voice. */
  chords: readonly (readonly number[])[];
}

/**
 * One musical identity per stage. Roots sit low (a drone lives around 55–110 Hz); modes follow the stage colour:
 * Stellar Nursery — warm, hopeful Lydian; Galactic Rim — vast Aeolian; Red Giant's Wake — bruised Phrygian; Quasar Void —
 * unresolved whole-tone; Tussenruimte — still celadon open fifths.
 */
export const STAGE_MUSIC: Record<StageId, StageMusic> = {
  nursery: {
    root: 38,
    mode: 'lydian',
    bpm: 68,
    chords: [
      [0, 2, 4],
      [1, 3, 5],
      [0, 3, 4],
      [4, 6, 1],
    ],
  },
  rim: {
    root: 33,
    mode: 'aeolian',
    bpm: 62,
    chords: [
      [0, 2, 4],
      [5, 0, 2],
      [3, 5, 0],
      [4, 6, 1],
    ],
  },
  redgiant: {
    root: 35,
    mode: 'phrygian',
    bpm: 58,
    chords: [
      [0, 2, 4],
      [1, 3, 5],
      [0, 1, 4],
      [6, 1, 3],
    ],
  },
  quasar: {
    root: 31,
    mode: 'wholetone',
    bpm: 76,
    chords: [
      [0, 2, 4],
      [1, 3, 5],
      [0, 3, 5],
      [2, 4, 1],
    ],
  },
  tussenruimte: {
    root: 36,
    mode: 'suspended',
    bpm: 52,
    chords: [
      [0, 2, 4],
      [0, 1, 3],
      [2, 3, 4],
      [0, 2, 3],
    ],
  },
};

/** MIDI note of scale degree `d` (may exceed the mode length: wraps up octaves; negative wraps down). */
export function degreeToMidi(root: number, mode: ModeId, d: number): number {
  const steps = MODES[mode];
  const n = steps.length;
  const oct = Math.floor(d / n);
  const idx = ((d % n) + n) % n;
  return root + oct * 12 + steps[idx]!;
}

export const degreeToHz = (root: number, mode: ModeId, d: number): number =>
  midiToHz(degreeToMidi(root, mode, d));
