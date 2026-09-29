export { createInputManager, type InputManagerOptions } from './manager';
export * from './types';
export { parseGamepadId, browserFamily, type ParsedPadId, type BrowserFamily } from './parse';
export {
  detectProfile,
  layoutFor,
  defaultRotation,
  ALL_LAYOUTS,
  LAYOUT_STANDARD,
  LAYOUT_NINTENDO_DIRECTINPUT,
  type DeviceProfile,
  type PadLayout,
} from './profiles';
export { decodeHat, normalizePad, rotateStick, type HatDir } from './mapping';
export { radialDeadzone, applyCalibration, processStick, StickCapture, rotationFromUp } from './deadzone';
export { DEFAULT_PAD_BINDINGS, SIDEWAYS_PAD_BINDINGS, ACTION_BIT } from './bindings';
export { KEY_LAYOUT_P1, KEY_LAYOUT_P2, KEY_LAYOUTS, keyLabel, type KeyLayout } from './keyboard';
export { padButtonLabel, confirmButton, backButton, resolveFamily } from './labels';
export { computeAutoAssignment } from './assign';
export { createMemoryStore, browserStore } from './storage';
export { NavRepeater, StickNav, NAV } from './nav';
export { RumbleGate, playRumble } from './rumble';
export { hidSupported, parseStandardReport, encodeRumble, HidPad } from './webhid';
