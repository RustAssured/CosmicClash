import { Btn } from '@/contracts';
import { Pad, type Action, type ProfileKind } from './types';

/** Logical action → `Btn` bit. */
export const ACTION_BIT: Record<Action, number> = {
  strike: Btn.STRIKE,
  crush: Btn.CRUSH,
  surge: Btn.SURGE,
  signature: Btn.SIGNATURE,
  ultimate: Btn.ULTIMATE,
  guard: Btn.GUARD,
  feint: Btn.FEINT,
  pause: Btn.PAUSE,
  training: Btn.TRAINING,
  gravity: Btn.GRAVITY,
};

export type PadBindingTable = Record<Action, readonly number[]>;

/**
 * Default layout, in Nintendo POSITIONS (Y left = Strike · X top = Crush · B bottom = Surge · A right = Signature ·
 * ZR Ultimate · ZL Guard · L feint-cancel · R Gravity · + pause · − training). Xbox and PlayStation pads use the same physical
 * positions, so muscle memory transfers; only the printed labels differ (see labels.ts).
 */
export const DEFAULT_PAD_BINDINGS: PadBindingTable = {
  strike: [Pad.WEST],
  crush: [Pad.NORTH],
  surge: [Pad.SOUTH],
  signature: [Pad.EAST],
  ultimate: [Pad.R2],
  guard: [Pad.L2],
  // D27: R1 is the second hold button (the Planet's Tidal Draw); L1 alone stays Feint
  feint: [Pad.L1],
  pause: [Pad.START],
  training: [Pad.SELECT],
  gravity: [Pad.R1],
};

/**
 * A single sideways Joy-Con has no reachable ZL/ZR: SL/SR become Guard/Ultimate (the shoulder positions), and either of the
 * pad's own shoulder/trigger buttons still works if the player holds it differently.
 */
export const SIDEWAYS_PAD_BINDINGS: PadBindingTable = {
  strike: [Pad.WEST],
  crush: [Pad.NORTH],
  surge: [Pad.SOUTH],
  signature: [Pad.EAST],
  ultimate: [Pad.SR, Pad.R2],
  guard: [Pad.SL, Pad.L2],
  feint: [Pad.L1, Pad.R1],
  pause: [Pad.START, Pad.SELECT],
  training: [Pad.CAPTURE, Pad.HOME],
  // a sideways Joy-Con has no spare shoulder: the stick click (D27)
  gravity: [Pad.L3],
};

export function defaultBindingsFor(kind: ProfileKind): PadBindingTable {
  return kind === 'joycon-l' || kind === 'joycon-r' ? SIDEWAYS_PAD_BINDINGS : DEFAULT_PAD_BINDINGS;
}

/** Digital press thresholds with hysteresis so a wobbling analog trigger doesn't chatter. */
export const PRESS_ON = 0.5;
export const PRESS_OFF = 0.32;
