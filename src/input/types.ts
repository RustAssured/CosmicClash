import type { InputSource } from '@/contracts';

/* ------------------------------------------------------------------------------------------------ *
 *  Canonical (POSITIONAL) pad buttons.
 *
 *  The W3C "standard gamepad" indices, extended past 15 with the buttons Nintendo pads add. Every physical pad is
 *  normalised into this space by its layout table (`profiles.ts`); bindings, menus and glyph labels all speak it.
 *  Positions are physical: SOUTH is the bottom face button (Nintendo B, Xbox A, PlayStation Cross).
 * ------------------------------------------------------------------------------------------------ */
export const Pad = {
  SOUTH: 0,
  EAST: 1,
  WEST: 2,
  NORTH: 3,
  L1: 4,
  R1: 5,
  L2: 6,
  R2: 7,
  SELECT: 8,
  START: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
  HOME: 16,
  CAPTURE: 17,
  SL: 18,
  SR: 19,
} as const;
export type PadButton = (typeof Pad)[keyof typeof Pad];
export const PAD_BUTTON_COUNT = 20;
export const PAD_BUTTON_NAMES: readonly string[] = [
  'south',
  'east',
  'west',
  'north',
  'l1',
  'r1',
  'l2',
  'r2',
  'select',
  'start',
  'l3',
  'r3',
  'up',
  'down',
  'left',
  'right',
  'home',
  'capture',
  'sl',
  'sr',
];

/** Normalised state of one pad: canonical buttons 0..1 plus both sticks (raw of the physical stick, +y DOWN). */
export interface PadState {
  buttons: Float32Array;
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  /** Axis-encoded triggers are only trusted after they have been seen at rest (−1): drivers report 0 before first use. */
  armedL2: boolean;
  armedR2: boolean;
}

export function createPadState(): PadState {
  return {
    buttons: new Float32Array(PAD_BUTTON_COUNT),
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    armedL2: false,
    armedR2: false,
  };
}

/* ------------------------------------------------------------------------------------------------ *
 *  Structural gamepad (a real `Gamepad` satisfies it; tests and the e2e harness pass fakes).
 * ------------------------------------------------------------------------------------------------ */
export interface PadButtonLike {
  readonly pressed: boolean;
  readonly touched?: boolean;
  readonly value: number;
}
export interface PadLike {
  readonly id: string;
  readonly index: number;
  readonly connected: boolean;
  /** 'standard' or '' (browser could not map it). */
  readonly mapping: string;
  readonly timestamp: number;
  readonly axes: ArrayLike<number>;
  readonly buttons: ArrayLike<PadButtonLike>;
  readonly vibrationActuator?: unknown;
  readonly hapticActuators?: unknown;
}

/* ------------------------------------------------------------------------------------------------ *
 *  Game actions and bindings
 * ------------------------------------------------------------------------------------------------ */
export const ACTIONS = [
  'strike',
  'crush',
  'surge',
  'signature',
  'ultimate',
  'guard',
  'feint',
  'pause',
  'training',
] as const;
export type Action = (typeof ACTIONS)[number];

/** A physical control on a specific pad, independent of any layout table (so a remap survives a wrong table). */
export type RawRef =
  { k: 'b'; i: number } | { k: 'a'; i: number; s: 1 | -1 } | { k: 'h'; d: 'u' | 'd' | 'l' | 'r' };

/** Physical keyboard key (`KeyboardEvent.code`, so AZERTY/QWERTZ users get the same physical layout). */
export type KeyRef = string;

export type GlyphFamily = 'nintendo' | 'xbox' | 'playstation' | 'generic' | 'keyboard';
export type LabelMode = 'auto' | 'nintendo' | 'xbox' | 'playstation';
export type ConfirmMode = 'label' | 'positional';

/* ------------------------------------------------------------------------------------------------ *
 *  Devices
 * ------------------------------------------------------------------------------------------------ */
export type DeviceKind = 'keyboard' | 'gamepad' | 'hid';
export type ProfileKind =
  | 'keyboard'
  | 'switch-pro'
  | 'joycon-l'
  | 'joycon-r'
  | 'joycon-pair'
  | 'nintendo-other'
  | 'xbox'
  | 'playstation'
  | 'generic';

export interface DeviceInfo {
  /** Stable while connected: 'kb1' | 'kb2' | 'pad:<index>' | 'hid:<n>'. */
  id: string;
  kind: DeviceKind;
  name: string;
  profile: ProfileKind;
  family: GlyphFamily;
  vendor: number | null;
  product: number | null;
  /** Browser-reported mapping ('standard' | '' | 'keyboard' | 'webhid'). */
  mapping: string;
  layoutId: string;
  rawId: string;
  index: number;
  connected: boolean;
  slot: 0 | 1 | null;
  hasRumble: boolean;
  /** Persistence key for per-device calibration/bindings (`057e:2009:standard`, `kb:wasd`). */
  profileKey: string;
}

export interface StickCalibration {
  cx: number;
  cy: number;
  /** Extents of travel measured from the centre (all positive). */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/* ------------------------------------------------------------------------------------------------ *
 *  Menu navigation
 * ------------------------------------------------------------------------------------------------ */
export interface NavFrame {
  /** True on the poll where the direction fires: on press and then on auto-repeat while held. */
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  /** One-shot on press. */
  confirm: boolean;
  back: boolean;
  start: boolean;
  /** Fires on any fresh button/key press (title "press any button"). */
  any: boolean;
  /** Buttons fresh this poll, for prompts that need the raw press (Tab/Home etc.). */
  tab: boolean;
  /** Held state, for hold-to-confirm and sliders that want continuous input. */
  heldConfirm: boolean;
  heldBack: boolean;
}

export const emptyNav = (): NavFrame => ({
  up: false,
  down: false,
  left: false,
  right: false,
  confirm: false,
  back: false,
  start: false,
  any: false,
  tab: false,
  heldConfirm: false,
  heldBack: false,
});

/* ------------------------------------------------------------------------------------------------ *
 *  Storage
 * ------------------------------------------------------------------------------------------------ */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/* ------------------------------------------------------------------------------------------------ *
 *  Settings
 * ------------------------------------------------------------------------------------------------ */
export interface InputSettings {
  /** Radial deadzone 0.05..0.45. */
  deadzone: number;
  /** Which glyph set prompts show. 'auto' follows the connected device. */
  labelMode: LabelMode;
  /** 'label': the button *labelled* confirm on that pad confirms (Nintendo A = right). 'positional': bottom button confirms everywhere. */
  confirmMode: ConfirmMode;
  /** 0..1 scale on all rumble. */
  rumble: number;
}

export const DEFAULT_SETTINGS: Readonly<InputSettings> = Object.freeze({
  deadzone: 0.18,
  labelMode: 'auto',
  confirmMode: 'label',
  rumble: 1,
});

/* ------------------------------------------------------------------------------------------------ *
 *  Live views (Controller Check)
 * ------------------------------------------------------------------------------------------------ */
export interface LiveDevice {
  info: DeviceInfo;
  /** Raw browser numbers, untouched. */
  rawButtons: number[];
  rawAxes: number[];
  /** Canonical positional buttons 0..1 (after the layout table). */
  canon: Float32Array;
  /** Sticks after rotation only (raw physical), and after calibration + deadzone (what the game sees). */
  rawLeft: [number, number];
  rawRight: [number, number];
  left: [number, number];
  right: [number, number];
  /** Action bits currently held (Btn mask). */
  actions: number;
  /** Decoded hat direction, if the layout uses one. */
  hat: 'u' | 'd' | 'l' | 'r' | 'ur' | 'ul' | 'dr' | 'dl' | null;
  deadzone: number;
  hasCalibration: boolean;
  /** Quarter-turn rotation applied to the sticks (0..3, clockwise). */
  rotation: number;
  /** Which action -> raw refs overrides are active. */
  bindings: Partial<Record<Action, RawRef[]>>;
  /** Actions whose binding the player changed (pads and keyboards alike). */
  custom: Action[];
}

export interface CaptureState {
  /** 'idle' | waiting for a press | captured (transient result) */
  status: 'idle' | 'waiting' | 'done' | 'cancelled';
  /** What is being captured: a button/key for an action, or the stick-rotation wizard. */
  kind: 'binding' | 'rotation';
  action: Action | null;
  device: string | null;
  /** What was bound (human-readable) once done. */
  result: string | null;
}

export type CalibrationPhase = 'idle' | 'centre' | 'range' | 'done';
export interface CalibrationState {
  phase: CalibrationPhase;
  device: string | null;
  /** 0..1 progress of the current phase. */
  progress: number;
  /** Live extents while measuring the range (for drawing the gate). */
  leftExtent: StickCalibration | null;
  rightExtent: StickCalibration | null;
}

export type HidStatus = 'unsupported' | 'idle' | 'requesting' | 'connected' | 'denied' | 'error';

/** The full input service (see README). One instance per page. */
export interface InputManager {
  attach(target?: Window): void;
  detach(): void;
  /** Once per frame (idempotent within one timestamp). Rescans pads, updates nav and stickiness. */
  poll(nowMs?: number): void;
  /** Poll unless something already did within `maxAgeMs` (wall clock): safe for the UI to call even when the app polls. */
  pollIfStale(maxAgeMs?: number): void;
  /** The `InputSource` for a player slot. Samples devices *at tick time*; edges are per tick. */
  source(slot: 0 | 1): InputSource;
  /** Menu navigation frame, valid until the next poll. 'any' merges every device. */
  nav(which?: 0 | 1 | 'any'): Readonly<NavFrame>;

  devices(): readonly DeviceInfo[];
  /** Device ids currently assigned to P1/P2. */
  assignment(): readonly [string | null, string | null];
  assign(slot: 0 | 1, deviceId: string | null): void;
  swapSlots(): void;
  /** P1 = first activated pad, P2 = second; keyboards fill the rest. */
  autoAssign(): void;
  onDevices(cb: () => void): () => void;
  /** Fires when a device produces a fresh digital press (the "press any button" activation). */
  onActivity(cb: (device: DeviceInfo) => void): () => void;
  /** Frames of `press any button` activity since the last call, to let a screen poll instead of subscribe. */
  drainActivity(out: DeviceInfo[]): void;

  rumble(slot: 0 | 1, strong: number, weak: number, ms: number): void;
  /** Rumble a specific device (the Controller Check's rumble test works on unassigned pads too). */
  rumbleDevice(deviceId: string, strong: number, weak: number, ms: number): void;

  readonly settings: Readonly<InputSettings>;
  updateSettings(patch: Partial<InputSettings>): void;
  onSettings(cb: (s: Readonly<InputSettings>) => void): () => void;

  /** Prompt labels for the UI. */
  familyOf(where: 0 | 1 | 'any' | string): GlyphFamily;
  /** Where does the UI take its glyphs from right now (settings.labelMode + last-used device)? */
  promptFamily(): GlyphFamily;
  /** Text for an action's binding on a device (e.g. 'Y', 'ZR', 'J'). */
  actionLabel(deviceId: string | null, action: Action): string;
  /** Text for menu confirm / back on the device. */
  confirmLabel(deviceId: string | null): string;
  backLabel(deviceId: string | null): string;
  /** The device that most recently produced input (for prompts in menus). */
  lastActiveDevice(): DeviceInfo | null;

  /* ---- Controller Check ---- */
  live(deviceId: string): LiveDevice | null;
  capture: CaptureState;
  beginCapture(deviceId: string, action: Action): void;
  cancelCapture(): void;
  clearBinding(deviceId: string, action: Action): void;
  resetBindings(deviceId: string): void;
  /** The UI clicks this after Capture.status === 'done' to acknowledge the toast. */
  ackCapture(): void;
  calibration: CalibrationState;
  beginCalibration(deviceId: string): void;
  /** Accept what has been measured so far (the user pressed confirm before the wizard auto-completed). */
  finishCalibration(): void;
  cancelCalibration(): void;
  clearCalibration(deviceId: string): void;
  /** Rotation wizard: push the stick away from you; sets the quarter-turn rotation. */
  beginRotationWizard(deviceId: string): void;
  setRotation(deviceId: string, quarterTurns: number | null): void;

  /* ---- optional WebHID ---- */
  readonly hidStatus: HidStatus;
  requestHid(): Promise<void>;
}
