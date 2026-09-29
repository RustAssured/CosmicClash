import { browserFamily, parseGamepadId, hex4, type BrowserFamily } from './parse';
import { Pad, type GlyphFamily, type ProfileKind } from './types';

/**
 * Device profiles and layout tables.
 *
 * A *profile* says what a device IS (Switch Pro, Joy-Con L, Xbox …) and drives glyph labels + defaults.
 * A *layout* says how the browser's raw button/axis numbers map onto the canonical positional buttons (`Pad.*`).
 *
 * HONESTY NOTE — what is verified and what is not:
 *   `standard` is the W3C table and is what Chrome/Edge (Windows, macOS, Linux) and Safari (macOS) expose for the Pro
 *   Controller; Nintendo B/A/Y/X sit at indices 0/1/2/3 (bottom/right/left/top), 16 = Home, 17 = Capture.
 *   Every OTHER table below (`nintendo-directinput`, `xbox-firefox-linux`, `ds4-legacy`, the Joy-Con ones) is encoded
 *   from documentation and community reports, has been exercised against *fake* gamepad objects only, and is
 *   overridable in the Controller Check screen ("remap"), which stores raw indices and therefore survives a wrong table.
 */

export const VENDOR = {
  NINTENDO: 0x057e,
  MICROSOFT: 0x045e,
  SONY: 0x054c,
} as const;

export const NINTENDO_PRODUCT = {
  JOYCON_L: 0x2006,
  JOYCON_R: 0x2007,
  /** Some OSes expose a docked Joy-Con pair under this id. */
  JOYCON_PAIR_A: 0x2008,
  PRO: 0x2009,
  /** Charging grip: the two Joy-Cons appear as a single combined device. */
  JOYCON_PAIR_GRIP: 0x200e,
  NSO_SNES: 0x2017,
  NSO_N64: 0x2019,
} as const;

export interface PadLayout {
  id: string;
  /** Canonical button -> raw button index (or several, first pressed wins). */
  buttons: Readonly<Partial<Record<number, number | readonly number[]>>>;
  /** Raw axis indices of [leftX, leftY, rightX, rightY]. */
  sticks: readonly [number, number, number, number];
  /** Axis carrying an 8-direction hat (values ≈ −1, −0.714 … 1, neutral > 1.1). */
  hatAxis?: number;
  /** D-pad reported as two ±1 axes [x, y]. */
  dpadAxes?: readonly [number, number];
  /** Triggers reported as axes at rest −1 (canonical L2 / R2). */
  triggerAxes?: { l2?: number; r2?: number };
  /** Where the raw numbers came from; shown in the Controller Check. */
  note: string;
}

const ident = (n: number): Record<number, number> => {
  const o: Record<number, number> = {};
  for (let i = 0; i < n; i++) o[i] = i;
  return o;
};

/** W3C standard mapping, plus the extras Nintendo pads add: 16 Home, 17 Capture, 18/19 SL/SR when present. */
export const LAYOUT_STANDARD: PadLayout = {
  id: 'standard',
  buttons: ident(20),
  sticks: [0, 1, 2, 3],
  note: 'W3C standard mapping',
};

/**
 * Nintendo Pro Controller, non-standard mapping (Firefox on Windows/macOS, older Chrome, Chromium without the Nintendo mapper):
 * DirectInput-style order B, A, Y, X, L, R, ZL, ZR, −, +, L3, R3, Home, Capture with the D-pad as a hat on axis 9.
 */
export const LAYOUT_NINTENDO_DIRECTINPUT: PadLayout = {
  id: 'nintendo-directinput',
  buttons: {
    [Pad.SOUTH]: 0,
    [Pad.EAST]: 1,
    [Pad.WEST]: 2,
    [Pad.NORTH]: 3,
    [Pad.L1]: 4,
    [Pad.R1]: 5,
    [Pad.L2]: 6,
    [Pad.R2]: 7,
    [Pad.SELECT]: 8,
    [Pad.START]: 9,
    [Pad.L3]: 10,
    [Pad.R3]: 11,
    [Pad.HOME]: 12,
    [Pad.CAPTURE]: 13,
  },
  sticks: [0, 1, 2, 3],
  hatAxis: 9,
  note: 'DirectInput-style: B A Y X L R ZL ZR − + L3 R3 Home Capture, D-pad hat on axis 9',
};

/** Single Joy-Con (either), non-standard: same DirectInput family. SL/SR are the top two buttons after Capture. */
export const LAYOUT_JOYCON_DIRECTINPUT: PadLayout = {
  id: 'joycon-directinput',
  buttons: {
    [Pad.SOUTH]: 0,
    [Pad.EAST]: 1,
    [Pad.WEST]: 2,
    [Pad.NORTH]: 3,
    [Pad.L1]: [4, 14],
    [Pad.R1]: [5, 15],
    [Pad.L2]: 6,
    [Pad.R2]: 7,
    [Pad.SELECT]: 8,
    [Pad.START]: 9,
    [Pad.L3]: 10,
    [Pad.R3]: 11,
    [Pad.HOME]: 12,
    [Pad.CAPTURE]: 13,
    [Pad.SL]: 14,
    [Pad.SR]: 15,
  },
  sticks: [0, 1, 2, 3],
  hatAxis: 9,
  note: 'Joy-Con, DirectInput-style: face buttons 0-3, L/R 4/5, SL/SR 14/15, hat on axis 9',
};

/** Xbox pad, non-standard (Firefox on Linux/xpad): triggers are axes 2/5 at rest −1, D-pad is axes 6/7. */
export const LAYOUT_XBOX_FIREFOX_LINUX: PadLayout = {
  id: 'xbox-firefox-linux',
  buttons: {
    [Pad.SOUTH]: 0,
    [Pad.EAST]: 1,
    [Pad.WEST]: 2,
    [Pad.NORTH]: 3,
    [Pad.L1]: 4,
    [Pad.R1]: 5,
    [Pad.SELECT]: 6,
    [Pad.START]: 7,
    [Pad.HOME]: 8,
    [Pad.L3]: 9,
    [Pad.R3]: 10,
  },
  sticks: [0, 1, 3, 4],
  triggerAxes: { l2: 2, r2: 5 },
  dpadAxes: [6, 7],
  note: 'xpad/evdev: A B X Y LB RB Back Start Guide LS RS; LT axis 2, RT axis 5, D-pad axes 6/7',
};

/** DualShock 4 / DualSense, non-standard (older Chrome, Firefox): Cross Circle Square Triangle L1 R1 L2 R2 Share Options L3 R3 PS Pad. */
export const LAYOUT_PLAYSTATION_LEGACY: PadLayout = {
  id: 'ds4-legacy',
  buttons: {
    [Pad.SOUTH]: 0,
    [Pad.EAST]: 1,
    [Pad.WEST]: 2,
    [Pad.NORTH]: 3,
    [Pad.L1]: 4,
    [Pad.R1]: 5,
    [Pad.L2]: 6,
    [Pad.R2]: 7,
    [Pad.SELECT]: 8,
    [Pad.START]: 9,
    [Pad.L3]: 10,
    [Pad.R3]: 11,
    [Pad.HOME]: 12,
    [Pad.CAPTURE]: 13,
  },
  sticks: [0, 1, 2, 5],
  hatAxis: 9,
  note: 'DS4-style: Cross Circle Square Triangle L1 R1 L2 R2 Share Options L3 R3 PS Touchpad; sticks 0/1 and 2/5; hat axis 9',
};

/** Unknown non-standard pad: the most common DirectInput order. */
export const LAYOUT_GENERIC_LEGACY: PadLayout = {
  id: 'generic-legacy',
  buttons: {
    [Pad.SOUTH]: 0,
    [Pad.EAST]: 1,
    [Pad.WEST]: 2,
    [Pad.NORTH]: 3,
    [Pad.L1]: 4,
    [Pad.R1]: 5,
    [Pad.SELECT]: 6,
    [Pad.START]: 7,
    [Pad.L3]: 8,
    [Pad.R3]: 9,
    [Pad.L2]: 10,
    [Pad.R2]: 11,
  },
  sticks: [0, 1, 2, 3],
  hatAxis: 9,
  note: 'generic guess: A B X Y L R Select Start L3 R3; hat axis 9',
};

export const ALL_LAYOUTS: readonly PadLayout[] = [
  LAYOUT_STANDARD,
  LAYOUT_NINTENDO_DIRECTINPUT,
  LAYOUT_JOYCON_DIRECTINPUT,
  LAYOUT_XBOX_FIREFOX_LINUX,
  LAYOUT_PLAYSTATION_LEGACY,
  LAYOUT_GENERIC_LEGACY,
];

export interface DeviceProfile {
  kind: ProfileKind;
  family: GlyphFamily;
  name: string;
  vendor: number | null;
  product: number | null;
  mapping: string;
  layout: PadLayout;
  /** Single sideways Joy-Con: sticks need a quarter-turn (see `defaultRotation`). */
  sideways: boolean;
  /** Which hand, for a sideways Joy-Con. */
  hand: 'left' | 'right' | null;
  /** Persistence key for calibration/bindings. */
  key: string;
}

function kindFor(vendor: number | null, product: number | null, name: string): ProfileKind {
  const n = name.toLowerCase();
  if (vendor === VENDOR.NINTENDO) {
    switch (product) {
      case NINTENDO_PRODUCT.PRO:
        return 'switch-pro';
      case NINTENDO_PRODUCT.JOYCON_L:
        return 'joycon-l';
      case NINTENDO_PRODUCT.JOYCON_R:
        return 'joycon-r';
      case NINTENDO_PRODUCT.JOYCON_PAIR_A:
      case NINTENDO_PRODUCT.JOYCON_PAIR_GRIP:
        return 'joycon-pair';
      default:
        break;
    }
  }
  if (/joy-?con/.test(n)) {
    if (/\(l\/r\)|l\+r|\(pair\)|charging/.test(n)) return 'joycon-pair';
    if (/\(l\)|\bleft\b/.test(n)) return 'joycon-l';
    if (/\(r\)|\bright\b/.test(n)) return 'joycon-r';
    return 'joycon-pair';
  }
  if (/pro controller|switch pro|nintendo switch/.test(n)) return 'switch-pro';
  if (vendor === VENDOR.NINTENDO) return 'nintendo-other';
  if (vendor === VENDOR.SONY) return 'playstation';
  if (vendor === VENDOR.MICROSOFT) return 'xbox';
  if (/xbox|xinput|x-box/.test(n)) return 'xbox';
  if (/dualshock|dualsense|wireless controller|playstation|ps[345]/.test(n)) return 'playstation';
  return 'generic';
}

const FAMILY_OF: Record<ProfileKind, GlyphFamily> = {
  keyboard: 'keyboard',
  'switch-pro': 'nintendo',
  'joycon-l': 'nintendo',
  'joycon-r': 'nintendo',
  'joycon-pair': 'nintendo',
  'nintendo-other': 'nintendo',
  xbox: 'xbox',
  playstation: 'playstation',
  generic: 'generic',
};

const DISPLAY_NAME: Partial<Record<ProfileKind, string>> = {
  'switch-pro': 'Pro Controller',
  'joycon-l': 'Joy-Con (L)',
  'joycon-r': 'Joy-Con (R)',
  'joycon-pair': 'Joy-Con (L+R)',
};

/** Choose the layout table from (profile kind, browser mapping, browser family). */
export function layoutFor(kind: ProfileKind, mapping: string, browser: BrowserFamily): PadLayout {
  if (mapping === 'standard') return LAYOUT_STANDARD;
  switch (kind) {
    case 'switch-pro':
    case 'joycon-pair':
    case 'nintendo-other':
      return LAYOUT_NINTENDO_DIRECTINPUT;
    case 'joycon-l':
    case 'joycon-r':
      return LAYOUT_JOYCON_DIRECTINPUT;
    case 'xbox':
      return browser === 'firefox' ? LAYOUT_XBOX_FIREFOX_LINUX : LAYOUT_GENERIC_LEGACY;
    case 'playstation':
      return LAYOUT_PLAYSTATION_LEGACY;
    default:
      return LAYOUT_GENERIC_LEGACY;
  }
}

/** Detect the profile of a connected pad from its browser-reported id + mapping. */
export function detectProfile(id: string, mapping: string, userAgent = ''): DeviceProfile {
  const parsed = parseGamepadId(id);
  const kind = kindFor(parsed.vendor, parsed.product, parsed.name);
  const layout = layoutFor(kind, mapping, browserFamily(userAgent));
  const sideways = kind === 'joycon-l' || kind === 'joycon-r';
  const vp = parsed.vendor === null ? 'generic' : `${hex4(parsed.vendor)}:${hex4(parsed.product)}`;
  return {
    kind,
    family: FAMILY_OF[kind],
    name: DISPLAY_NAME[kind] ?? (parsed.name || 'Gamepad'),
    vendor: parsed.vendor,
    product: parsed.product,
    mapping,
    layout,
    sideways,
    hand: kind === 'joycon-l' ? 'left' : kind === 'joycon-r' ? 'right' : null,
    key: `${vp}:${layout.id}`,
  };
}

/**
 * Default stick quarter-turn (clockwise) for a device. Sideways Joy-Cons report their stick in the upright frame; held
 * sideways, "up" for the player is a quarter-turn away. In *standard* mapping Chromium's Nintendo mapper is believed to
 * pre-rotate, so we default to 0 there and let the Controller Check's rotation wizard settle it. (Unverified on hardware.)
 */
export function defaultRotation(p: DeviceProfile): number {
  if (!p.sideways) return 0;
  if (p.mapping === 'standard') return 0;
  return p.hand === 'left' ? 3 : 1;
}

export const isNintendo = (p: DeviceProfile): boolean => p.family === 'nintendo';
