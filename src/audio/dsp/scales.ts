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
    bpm: 56,
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

/**
 * How a stage's score is VOICED, on top of what it plays (root, mode, tempo). Each number is a multiplier or an offset on a
 * part of the mix; together they are what makes the five stages sound like five places rather than five transpositions.
 */
export interface StageFeel {
  /** How much rhythm the planner adds at a given intensity (multiplies intensity inside `planStep`): 1 = the reference. */
  density: number;
  /** Drone level. */
  body: number;
  /** Drone and pad filter cut-offs: below 1 darker, above 1 brighter. */
  dark: number;
  /** Pad level. */
  pad: number;
  /** Semitones above the root that the pad chords are voiced (24 = the reference; 12 = deeper; 36 = thin and high). */
  padOct: number;
  /** Reverb send multiplier for the pad and the bells (a bigger space). */
  space: number;
  /** A floor under the "tense" mix (cluster note, dimmer filters) that low integrity would otherwise supply. */
  tension: number;
  /** How often glass motes (single bell notes) fall during a fight: the menu rate is 1. */
  motes: number;
}

export const STAGE_FEEL: Record<StageId, StageFeel> = {
  // warm and hopeful: open and bright, a full pad, a few bright motes
  nursery: { density: 1, body: 1, dark: 1.15, pad: 1.25, padOct: 24, space: 1, tension: 0, motes: 0.5 },
  // vast and slow: a deep, wide pad in a huge space; little rhythm, and what there is arrives late and low
  rim: { density: 0.55, body: 1.25, dark: 0.85, pad: 1.4, padOct: 12, space: 1.8, tension: 0, motes: 0.25 },
  // mournful and heavy: dark, a strong drone, a low pad with a permanent ache of the minor second under it
  redgiant: { density: 0.85, body: 1.5, dark: 0.6, pad: 0.9, padOct: 12, space: 1, tension: 0.3, motes: 0 },
  // tense and sparse: thin and high, hardly any rhythm, the unresolved cluster always faintly present
  quasar: { density: 0.4, body: 0.7, dark: 1.3, pad: 0.7, padOct: 36, space: 0.8, tension: 0.6, motes: 0.15 },
  // near-silent stillness: almost nothing but glass motes falling into a very large space
  tussenruimte: {
    density: 0.08,
    body: 0.16,
    dark: 1.1,
    pad: 0.2,
    padOct: 36,
    space: 2.2,
    tension: 0,
    motes: 3,
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

/**
 * MIDI note of the stage's "fifth": the degree of its mode nearest a perfect fifth above the root (a tie goes up). It is a true
 * fifth on the Lydian, Aeolian, Phrygian and suspended stages, and the augmented fifth on the whole-tone one, which has none.
 * The drone's fifth voices and the second taiko tuning play it, so the two always agree.
 */
export function fifthOf(m: StageMusic): number {
  let best: number = MODES[m.mode][0];
  for (const s of MODES[m.mode]) if (Math.abs(s - 7) <= Math.abs(best - 7)) best = s;
  return m.root + best;
}

export const degreeToHz = (root: number, mode: ModeId, d: number): number =>
  midiToHz(degreeToMidi(root, mode, d));
