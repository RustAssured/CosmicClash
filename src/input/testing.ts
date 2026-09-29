import { Pad, type PadLike } from './types';

/**
 * Fake `Gamepad` objects for unit tests, the UI dev sandbox and the e2e harness. They follow the browser's shape
 * (`buttons[i].{pressed,touched,value}`, `axes[]`, `mapping`, `id`) so the exact same code path runs as with hardware.
 */
export class FakePad implements PadLike {
  connected = true;
  timestamp = 0;
  readonly buttons: { pressed: boolean; touched: boolean; value: number }[];
  readonly axes: number[];
  vibrationActuator: unknown = undefined;
  hapticActuators: unknown = undefined;
  /** Effects the pad was asked to play (when `withRumble()` was used). */
  readonly effects: { type: string; params: Record<string, number> }[] = [];

  constructor(
    readonly id: string,
    readonly index: number,
    readonly mapping: 'standard' | '',
    nButtons: number,
    axes: number[],
  ) {
    this.buttons = Array.from({ length: nButtons }, () => ({ pressed: false, touched: false, value: 0 }));
    this.axes = axes.slice();
  }

  /** Press/release a raw button index (analog `value` optional). */
  set(i: number, down: boolean | number = true): this {
    const b = this.buttons[i]!;
    const v = typeof down === 'number' ? down : down ? 1 : 0;
    b.value = v;
    b.pressed = v > 0.5;
    b.touched = v > 0;
    this.timestamp++;
    return this;
  }

  release(i: number): this {
    return this.set(i, false);
  }

  releaseAll(): this {
    for (let i = 0; i < this.buttons.length; i++) this.set(i, false);
    return this;
  }

  axis(i: number, v: number): this {
    this.axes[i] = v;
    this.timestamp++;
    return this;
  }

  /** Give the pad a `vibrationActuator` that records what it is asked to play. */
  withRumble(): this {
    this.vibrationActuator = {
      playEffect: (type: string, params: Record<string, number>): Promise<void> => {
        this.effects.push({ type, params });
        return Promise.resolve();
      },
    };
    return this;
  }
}

export const PRO_STANDARD_ID = 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)';
export const PRO_FIREFOX_ID = '057e-2009-Pro Controller';
/** Hat neutral value seen on Chrome-legacy / Firefox. */
export const HAT_NEUTRAL = 1.2857142686843872;
export const HAT_VALUES = {
  u: -1,
  ur: -0.7142857313156128,
  r: -0.4285714030265808,
  dr: -0.14285719394683838,
  d: 0.14285707473754883,
  dl: 0.4285714626312256,
  l: 0.7142857313156128,
  ul: 1,
} as const;

/** Pro Controller as Chrome/Edge/Safari expose it: `mapping: 'standard'`, 18 buttons, 4 axes. */
export const proStandard = (index = 0, id = PRO_STANDARD_ID): FakePad =>
  new FakePad(id, index, 'standard', 18, [0, 0, 0, 0]);

/** Pro Controller as Firefox / older Chrome expose it: no mapping, DirectInput order, D-pad hat on axis 9. */
export function proDirectInput(index = 0, id = PRO_FIREFOX_ID): FakePad {
  const axes = new Array<number>(10).fill(0);
  axes[9] = HAT_NEUTRAL;
  return new FakePad(id, index, '', 14, axes);
}

export const xboxStandard = (index = 0): FakePad =>
  new FakePad(
    'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    index,
    'standard',
    17,
    [0, 0, 0, 0],
  );

export const dualSenseStandard = (index = 0): FakePad =>
  new FakePad(
    'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
    index,
    'standard',
    18,
    [0, 0, 0, 0],
  );

export const joyconLeftStandard = (index = 0): FakePad =>
  new FakePad(
    'Joy-Con (L) (STANDARD GAMEPAD Vendor: 057e Product: 2006)',
    index,
    'standard',
    20,
    [0, 0, 0, 0],
  );

export const joyconRightDirectInput = (index = 0): FakePad => {
  const axes = new Array<number>(10).fill(0);
  axes[9] = HAT_NEUTRAL;
  return new FakePad('057e-2007-Joy-Con (R)', index, '', 16, axes);
};

/** A mutable list of pads with the `getGamepads` shape (holes are `null`, like the browser). */
export function createFakeGamepads(): {
  pads: (FakePad | null)[];
  getGamepads: () => (PadLike | null)[];
  plug: (p: FakePad) => FakePad;
  unplug: (index: number) => void;
} {
  const pads: (FakePad | null)[] = [null, null, null, null];
  return {
    pads,
    getGamepads: () => pads.slice(),
    plug: (p) => {
      pads[p.index] = p;
      return p;
    },
    unplug: (i) => {
      pads[i] = null;
    },
  };
}

/** Canonical → raw index on the Nintendo DirectInput table, for readable tests. */
export const DI = {
  B: 0,
  A: 1,
  Y: 2,
  X: 3,
  L: 4,
  R: 5,
  ZL: 6,
  ZR: 7,
  MINUS: 8,
  PLUS: 9,
  L3: 10,
  R3: 11,
  HOME: 12,
  CAPTURE: 13,
} as const;

/** Standard-mapping raw indices (identical to `Pad.*`). */
export const STD = Pad;
