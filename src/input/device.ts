import { ACTION_BIT, PRESS_OFF, PRESS_ON, defaultBindingsFor, type PadBindingTable } from './bindings';
import { processStick } from './deadzone';
import { DIR_BITS, KeyboardState, dirsToStick, type KeyLayout } from './keyboard';
import { backButton, confirmButton, resolveFamily } from './labels';
import { decodeHat, normalizePad, rawRefValue } from './mapping';
import { NAV, StickNav } from './nav';
import { defaultRotation, type DeviceProfile } from './profiles';
import { hasRumble } from './rumble';
import type { DeviceOverrides } from './storage';
import {
  ACTIONS,
  Pad,
  PAD_BUTTON_COUNT,
  createPadState,
  type DeviceInfo,
  type InputSettings,
  type PadLike,
  type PadState,
  type StickCalibration,
} from './types';

/** Menu-nav button bits reported by a device. */
export const NB = { CONFIRM: 1, BACK: 2, START: 4, TAB: 8 } as const;

/** Runtime device: what the manager polls, samples per tick and reads for menus. */
export interface Device {
  readonly info: DeviceInfo;
  /** Current action bits (Btn mask), NOT including latch. */
  actions: number;
  /** Processed movement (after calibration, deadzone, d-pad / keys), +y down. */
  moveX: number;
  moveY: number;
  /** Actions held at any moment since the last `takeSample`, plus now — a sub-tick tap is never lost. */
  takeSample(out: { x: number; y: number }): number;
  /** Forget latched taps (the sim is not ticking, so nothing will ever consume them). */
  dropLatch(): void;
  /** Menu nav: direction bits (NAV.*) and button bits (NB.*), levels. */
  navDirs(): number;
  navButtons(settings: InputSettings): number;
  /** True while something activation-worthy (a button/key, not a stick) is held. */
  anyDown(): boolean;
}

const ACTIVATION_BUTTONS: readonly number[] = [
  Pad.SOUTH,
  Pad.EAST,
  Pad.WEST,
  Pad.NORTH,
  Pad.L1,
  Pad.R1,
  Pad.L2,
  Pad.R2,
  Pad.SELECT,
  Pad.START,
  Pad.UP,
  Pad.DOWN,
  Pad.LEFT,
  Pad.RIGHT,
  Pad.HOME,
  Pad.CAPTURE,
  Pad.SL,
  Pad.SR,
];

export class PadDevice implements Device {
  readonly info: DeviceInfo;
  readonly profile: DeviceProfile;
  readonly state: PadState = createPadState();
  pad: PadLike | null = null;
  overrides: DeviceOverrides;
  rotation: number;
  calL: StickCalibration | null;
  calR: StickCalibration | null;
  actions = 0;
  moveX = 0;
  moveY = 0;
  /** Processed sticks for the Controller Check. */
  leftX = 0;
  leftY = 0;
  rightX = 0;
  rightY = 0;
  readonly canonHeld = new Uint8Array(PAD_BUTTON_COUNT);
  private latch = 0;
  private readonly defaults: PadBindingTable;
  private readonly tmp = { x: 0, y: 0 };
  private readonly stickNav = new StickNav();
  private hat: ReturnType<typeof decodeHat> = null;

  constructor(
    info: DeviceInfo,
    profile: DeviceProfile,
    overrides: DeviceOverrides,
    private readonly getSettings: () => InputSettings,
  ) {
    this.info = info;
    this.profile = profile;
    this.overrides = overrides;
    this.defaults = defaultBindingsFor(profile.kind);
    this.rotation = overrides.rotation ?? defaultRotation(profile);
    this.calL = overrides.calL ?? null;
    this.calR = overrides.calR ?? null;
  }

  get currentHat(): ReturnType<typeof decodeHat> {
    return this.hat;
  }

  /** Read a fresh snapshot of the pad: normalise, calibrate, evaluate the bindings, latch. */
  refresh(pad: PadLike): void {
    this.pad = pad;
    const s = this.state;
    const layout = this.profile.layout;
    normalizePad(pad, layout, this.rotation, s);
    this.hat = layout.hatAxis !== undefined ? decodeHat(pad.axes[layout.hatAxis]) : null;

    const dz = this.getSettings().deadzone;
    processStick(s.lx, s.ly, this.calL, dz, this.tmp);
    this.leftX = this.tmp.x;
    this.leftY = this.tmp.y;
    processStick(s.rx, s.ry, this.calR, dz, this.tmp);
    this.rightX = this.tmp.x;
    this.rightY = this.tmp.y;

    const b = s.buttons;
    for (let i = 0; i < PAD_BUTTON_COUNT; i++) {
      const v = b[i]!;
      this.canonHeld[i] = v > (this.canonHeld[i] ? PRESS_OFF : PRESS_ON) ? 1 : 0;
    }

    let m = 0;
    const bindings = this.overrides.bindings;
    for (const a of ACTIONS) {
      const bit = ACTION_BIT[a];
      const refs = bindings?.[a];
      let down = false;
      if (refs && refs.length) {
        const thr = this.actions & bit ? PRESS_OFF : PRESS_ON;
        for (let j = 0; j < refs.length; j++) {
          if (rawRefValue(pad, refs[j]!, layout.hatAxis) > thr) {
            down = true;
            break;
          }
        }
      } else {
        const list = this.defaults[a];
        for (let j = 0; j < list.length; j++) {
          if (this.canonHeld[list[j]!]) {
            down = true;
            break;
          }
        }
      }
      if (down) m |= ACTION_BIT[a];
    }
    this.actions = m;
    this.latch |= m;

    // Movement: the D-pad (digital, always full deflection) or the stick, whichever is deflected further.
    let dirs = 0;
    if (this.canonHeld[Pad.UP]) dirs |= DIR_BITS.u;
    if (this.canonHeld[Pad.DOWN]) dirs |= DIR_BITS.d;
    if (this.canonHeld[Pad.LEFT]) dirs |= DIR_BITS.l;
    if (this.canonHeld[Pad.RIGHT]) dirs |= DIR_BITS.r;
    if (dirs !== 0) {
      dirsToStick(dirs, this.tmp);
      this.moveX = this.tmp.x;
      this.moveY = this.tmp.y;
    } else {
      this.moveX = this.leftX;
      this.moveY = this.leftY;
    }
  }

  /** Called when the pad vanished this frame. */
  clear(): void {
    this.actions = 0;
    this.moveX = 0;
    this.moveY = 0;
    this.leftX = this.leftY = this.rightX = this.rightY = 0;
    this.canonHeld.fill(0);
    this.latch = 0;
    this.stickNav.reset();
  }

  takeSample(out: { x: number; y: number }): number {
    out.x = this.moveX;
    out.y = this.moveY;
    const held = this.actions | this.latch;
    this.latch = 0;
    return held;
  }

  dropLatch(): void {
    this.latch = 0;
  }

  navDirs(): number {
    let n = this.stickNav.step(this.leftX, this.leftY);
    if (this.canonHeld[Pad.UP]) n |= NAV.UP;
    if (this.canonHeld[Pad.DOWN]) n |= NAV.DOWN;
    if (this.canonHeld[Pad.LEFT]) n |= NAV.LEFT;
    if (this.canonHeld[Pad.RIGHT]) n |= NAV.RIGHT;
    return n;
  }

  navButtons(settings: InputSettings): number {
    const fam = resolveFamily(settings.labelMode, this.info.family);
    let n = 0;
    if (this.canonHeld[confirmButton(fam, settings.confirmMode)]) n |= NB.CONFIRM;
    if (this.canonHeld[backButton(fam, settings.confirmMode)]) n |= NB.BACK;
    if (this.canonHeld[Pad.START]) n |= NB.START;
    if (this.canonHeld[Pad.SELECT] || this.canonHeld[Pad.L1] || this.canonHeld[Pad.R1]) n |= NB.TAB;
    // A sideways Joy-Con's SL/SR are its only shoulders: let them page too.
    if (this.canonHeld[Pad.SL] || this.canonHeld[Pad.SR]) n |= NB.TAB;
    return n;
  }

  anyDown(): boolean {
    for (let i = 0; i < ACTIVATION_BUTTONS.length; i++)
      if (this.canonHeld[ACTIVATION_BUTTONS[i]!]) return true;
    return false;
  }

  get rumbleCapable(): boolean {
    return hasRumble(this.pad);
  }
}

export class KeyboardDevice implements Device {
  readonly info: DeviceInfo;
  readonly keys: KeyboardState;
  actions = 0;
  moveX = 0;
  moveY = 0;
  private dirs = 0;
  private readonly tmp = { x: 0, y: 0 };

  constructor(info: DeviceInfo, layout: KeyLayout) {
    this.info = info;
    this.keys = new KeyboardState(layout);
  }

  refresh(): void {
    this.actions = this.keys.heldActions();
    this.dirs = this.keys.heldDirs();
    dirsToStick(this.dirs, this.tmp);
    this.moveX = this.tmp.x;
    this.moveY = this.tmp.y;
  }

  takeSample(out: { x: number; y: number }): number {
    // A movement key tapped and released between ticks still nudges the stick for one tick.
    dirsToStick(this.dirs | this.keys.latchDirs, out);
    const held = this.actions | this.keys.latchHeld;
    this.keys.consumeLatch();
    return held;
  }

  dropLatch(): void {
    this.keys.consumeLatch();
  }

  navDirs(): number {
    let n = 0;
    if (this.dirs & DIR_BITS.u) n |= NAV.UP;
    if (this.dirs & DIR_BITS.d) n |= NAV.DOWN;
    if (this.dirs & DIR_BITS.l) n |= NAV.LEFT;
    if (this.dirs & DIR_BITS.r) n |= NAV.RIGHT;
    return n;
  }

  navButtons(): number {
    return this.keys.heldNav();
  }

  anyDown(): boolean {
    return this.keys.heldActions() !== 0 || this.keys.heldDirs() !== 0 || this.keys.heldNav() !== 0;
  }
}
