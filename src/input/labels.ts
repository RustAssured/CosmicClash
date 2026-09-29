import { DEFAULT_PAD_BINDINGS, defaultBindingsFor } from './bindings';
import {
  Pad,
  type Action,
  type ConfirmMode,
  type GlyphFamily,
  type LabelMode,
  type PadButton,
  type ProfileKind,
} from './types';

/**
 * PlayStation face symbols live in the Unicode private-use area; the UI pixel font ships a glyph for each.
 * (A real ✕ ○ □ △ would need font coverage the bitmap font doesn't have and shouldn't.)
 */
export const GLYPH_CROSS = String.fromCharCode(0xe000);
export const GLYPH_CIRCLE = String.fromCharCode(0xe001);
export const GLYPH_SQUARE = String.fromCharCode(0xe002);
export const GLYPH_TRIANGLE = String.fromCharCode(0xe003);

const NINTENDO: Partial<Record<number, string>> = {
  [Pad.SOUTH]: 'B',
  [Pad.EAST]: 'A',
  [Pad.WEST]: 'Y',
  [Pad.NORTH]: 'X',
  [Pad.L1]: 'L',
  [Pad.R1]: 'R',
  [Pad.L2]: 'ZL',
  [Pad.R2]: 'ZR',
  [Pad.SELECT]: '−',
  [Pad.START]: '+',
  [Pad.L3]: 'LS',
  [Pad.R3]: 'RS',
  [Pad.UP]: 'UP',
  [Pad.DOWN]: 'DOWN',
  [Pad.LEFT]: 'LEFT',
  [Pad.RIGHT]: 'RIGHT',
  [Pad.HOME]: 'HOME',
  [Pad.CAPTURE]: 'CAP',
  [Pad.SL]: 'SL',
  [Pad.SR]: 'SR',
};
const XBOX: Partial<Record<number, string>> = {
  ...NINTENDO,
  [Pad.SOUTH]: 'A',
  [Pad.EAST]: 'B',
  [Pad.WEST]: 'X',
  [Pad.NORTH]: 'Y',
  [Pad.L1]: 'LB',
  [Pad.R1]: 'RB',
  [Pad.L2]: 'LT',
  [Pad.R2]: 'RT',
  [Pad.SELECT]: 'VIEW',
  [Pad.START]: 'MENU',
  [Pad.L3]: 'LS',
  [Pad.R3]: 'RS',
  [Pad.CAPTURE]: 'SHARE',
};
const PLAYSTATION: Partial<Record<number, string>> = {
  ...NINTENDO,
  [Pad.SOUTH]: GLYPH_CROSS,
  [Pad.EAST]: GLYPH_CIRCLE,
  [Pad.WEST]: GLYPH_SQUARE,
  [Pad.NORTH]: GLYPH_TRIANGLE,
  [Pad.L1]: 'L1',
  [Pad.R1]: 'R1',
  [Pad.L2]: 'L2',
  [Pad.R2]: 'R2',
  [Pad.SELECT]: 'SHARE',
  [Pad.START]: 'OPT',
  [Pad.L3]: 'L3',
  [Pad.R3]: 'R3',
  [Pad.HOME]: 'PS',
  [Pad.CAPTURE]: 'PAD',
};

/** The text/glyph printed on a canonical positional button for a given glyph family. */
export function padButtonLabel(family: GlyphFamily, b: number): string {
  const t = family === 'nintendo' ? NINTENDO : family === 'playstation' ? PLAYSTATION : XBOX;
  return t[b] ?? `#${b}`;
}

/** Resolve the family prompts should use: the user's override, else the device's own. */
export function resolveFamily(mode: LabelMode, deviceFamily: GlyphFamily | null): GlyphFamily {
  if (mode !== 'auto') return mode;
  return deviceFamily ?? 'nintendo';
}

/** Positional mode: bottom confirms on every pad. Label mode: the button *printed* A/Cross confirms. */
export function confirmButton(family: GlyphFamily, mode: ConfirmMode): PadButton {
  if (mode === 'positional') return Pad.SOUTH;
  return family === 'nintendo' ? Pad.EAST : Pad.SOUTH;
}

export function backButton(family: GlyphFamily, mode: ConfirmMode): PadButton {
  if (mode === 'positional') return Pad.EAST;
  return family === 'nintendo' ? Pad.SOUTH : Pad.EAST;
}

/** First default pad button for an action on a profile — what a prompt shows before any remap. */
export function defaultPadButton(kind: ProfileKind, a: Action): PadButton {
  return (defaultBindingsFor(kind)[a][0] ?? DEFAULT_PAD_BINDINGS[a][0]!) as PadButton;
}
