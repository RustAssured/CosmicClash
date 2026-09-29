/**
 * Input contract. One InputFrame per player per simulation tick. Human sources (keyboard, gamepad) and AI
 * controllers produce the SAME structure — the AI has no privileged path into the simulation.
 * The 8–10 tick input buffer, hold-to-charge and feint logic live in the Fighter (combat), not in input.
 */
export const Btn = {
  STRIKE: 1 << 0,
  CRUSH: 1 << 1,
  SURGE: 1 << 2,
  SIGNATURE: 1 << 3,
  ULTIMATE: 1 << 4,
  GUARD: 1 << 5,
  /** L/R bumpers: feint-cancel. */
  FEINT: 1 << 6,
  PAUSE: 1 << 7,
  /** '−' button: toggle training overlay. */
  TRAINING: 1 << 8,
} as const;
export type BtnMask = number;

export interface InputFrame {
  /** Left stick / dpad after radial deadzone + calibration, each in [-1, 1]; +x right, +y DOWN. Also aims attacks. */
  moveX: number;
  moveY: number;
  /** Bitmask of Btn currently held. */
  held: BtnMask;
  /** Bits that went down this tick / up this tick (edges). */
  pressed: BtnMask;
  released: BtnMask;
}

export const emptyInput = (): InputFrame => ({ moveX: 0, moveY: 0, held: 0, pressed: 0, released: 0 });

export function copyInput(dst: InputFrame, src: InputFrame): void {
  dst.moveX = src.moveX;
  dst.moveY = src.moveY;
  dst.held = src.held;
  dst.pressed = src.pressed;
  dst.released = src.released;
}

/** Produces the InputFrame for one slot each tick. Human: reads devices. AI: runs the controller. */
export interface InputSource {
  readonly kind: 'human' | 'ai' | 'script' | 'none';
  /** Called exactly once per simulation tick, in tick order. Must fill `out` (edges relative to the previous call). */
  poll(tick: number, out: InputFrame): void;
}

/** Scripted input for the deterministic harness: "0:crush,40:sig*30,90:right*20" style, see harness.ts. */
export interface ScriptEvent {
  tick: number;
  /** Buttons pressed at `tick` and held for `hold` ticks (0 = one-tick tap). */
  buttons: BtnMask;
  hold: number;
  moveX: number;
  moveY: number;
  /** Ticks the stick direction is held (0 = until next event). */
  moveTicks: number;
}
