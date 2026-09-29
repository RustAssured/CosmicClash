import type { PadLayout } from './profiles';
import { Pad, PAD_BUTTON_COUNT, type PadLike, type PadState, type RawRef } from './types';

/** 8-way hat values, clockwise from up: −1, −0.714, −0.428, −0.143, 0.143, 0.429, 0.714, 1. Neutral is ≈ 1.286 (or 3.286). */
export type HatDir = 'u' | 'ur' | 'r' | 'dr' | 'd' | 'dl' | 'l' | 'ul';
const HAT_ORDER: readonly HatDir[] = ['u', 'ur', 'r', 'dr', 'd', 'dl', 'l', 'ul'];

/** Decode a hat axis value; null = neutral / not a hat value. */
export function decodeHat(v: number | undefined): HatDir | null {
  if (v === undefined || !Number.isFinite(v) || v > 1.15 || v < -1.15) return null;
  const k = Math.round((v + 1) * 3.5);
  if (k < 0 || k > 7) return null;
  // Real hats report exact step values; a value that sits between two steps is a stick axis, not a hat.
  if (Math.abs(k / 3.5 - 1 - v) > 0.12) return null;
  return HAT_ORDER[k]!;
}

export function hatBits(d: HatDir | null): { u: boolean; d: boolean; l: boolean; r: boolean } {
  if (d === null) return { u: false, d: false, l: false, r: false };
  return { u: d.includes('u'), d: d.includes('d'), l: d.includes('l'), r: d.includes('r') };
}

const HAT_TMP = { u: false, d: false, l: false, r: false };
function hatInto(d: HatDir | null): typeof HAT_TMP {
  HAT_TMP.u = d !== null && d.includes('u');
  HAT_TMP.d = d !== null && d.includes('d');
  HAT_TMP.l = d !== null && d.includes('l');
  HAT_TMP.r = d !== null && d.includes('r');
  return HAT_TMP;
}

const btnValue = (pad: PadLike, i: number): number => {
  const b = pad.buttons[i];
  if (!b) return 0;
  const v = b.value;
  // Some drivers flag `pressed` on digital buttons without a value; analog triggers keep their travel.
  return b.pressed && v < 0.5 ? 1 : v;
};

/** Rotate a stick vector by `quarterTurns` clockwise (+y is DOWN, so clockwise on screen). */
export function rotateStick(x: number, y: number, quarterTurns: number, out: [number, number]): void {
  switch (((quarterTurns % 4) + 4) % 4) {
    // `0 - v` (not `-v`) so a resting stick never turns into −0.
    case 1:
      out[0] = 0 - y;
      out[1] = x;
      return;
    case 2:
      out[0] = 0 - x;
      out[1] = 0 - y;
      return;
    case 3:
      out[0] = y;
      out[1] = 0 - x;
      return;
    default:
      out[0] = x;
      out[1] = y;
  }
}

const ROT_TMP: [number, number] = [0, 0];

const axis = (pad: PadLike, i: number): number => {
  const v = pad.axes[i];
  return v === undefined || !Number.isFinite(v) ? 0 : v;
};

/**
 * Normalise a raw pad into canonical positional state via its layout table. Writes into `out` (no allocation).
 * Sticks are rotated by `rotation` quarter-turns (sideways Joy-Con).
 */
export function normalizePad(pad: PadLike, layout: PadLayout, rotation: number, out: PadState): void {
  const b = out.buttons;
  for (let c = 0; c < PAD_BUTTON_COUNT; c++) {
    const src = layout.buttons[c];
    let v = 0;
    if (src !== undefined) {
      if (typeof src === 'number') v = btnValue(pad, src);
      else for (let j = 0; j < src.length; j++) v = Math.max(v, btnValue(pad, src[j]!));
    }
    b[c] = v;
  }

  // Triggers reported as axes at rest −1. Trust them only once they have been seen at rest (drivers report 0 first).
  const ta = layout.triggerAxes;
  if (ta) {
    if (ta.l2 !== undefined) {
      const v = axis(pad, ta.l2);
      if (v <= -0.9) out.armedL2 = true;
      if (out.armedL2) b[Pad.L2] = Math.max(b[Pad.L2]!, Math.min(1, Math.max(0, (v + 1) / 2)));
    }
    if (ta.r2 !== undefined) {
      const v = axis(pad, ta.r2);
      if (v <= -0.9) out.armedR2 = true;
      if (out.armedR2) b[Pad.R2] = Math.max(b[Pad.R2]!, Math.min(1, Math.max(0, (v + 1) / 2)));
    }
  }

  // D-pad as a hat axis or as two ±1 axes.
  if (layout.hatAxis !== undefined) {
    const h = hatInto(decodeHat(pad.axes[layout.hatAxis]));
    if (h.u) b[Pad.UP] = 1;
    if (h.d) b[Pad.DOWN] = 1;
    if (h.l) b[Pad.LEFT] = 1;
    if (h.r) b[Pad.RIGHT] = 1;
  }
  if (layout.dpadAxes) {
    const dx = axis(pad, layout.dpadAxes[0]);
    const dy = axis(pad, layout.dpadAxes[1]);
    if (dx < -0.5) b[Pad.LEFT] = 1;
    if (dx > 0.5) b[Pad.RIGHT] = 1;
    if (dy < -0.5) b[Pad.UP] = 1;
    if (dy > 0.5) b[Pad.DOWN] = 1;
  }

  const s = layout.sticks;
  rotateStick(axis(pad, s[0]), axis(pad, s[1]), rotation, ROT_TMP);
  out.lx = ROT_TMP[0];
  out.ly = ROT_TMP[1];
  rotateStick(axis(pad, s[2]), axis(pad, s[3]), rotation, ROT_TMP);
  out.rx = ROT_TMP[0];
  out.ry = ROT_TMP[1];
}

/** Current 0..1 value of a raw reference on a pad (used for overridden bindings). */
export function rawRefValue(pad: PadLike, ref: RawRef, hatAxisHint?: number): number {
  switch (ref.k) {
    case 'b':
      return btnValue(pad, ref.i);
    case 'a': {
      const v = axis(pad, ref.i);
      return v * ref.s > 0.5 ? Math.min(1, v * ref.s) : 0;
    }
    case 'h': {
      const idx = hatAxisHint ?? 9;
      const h = hatBits(decodeHat(pad.axes[idx]));
      return h[ref.d] ? 1 : 0;
    }
  }
}

/**
 * Find the raw input that is "most pressed" on a pad relative to a rest snapshot — used by remap capture.
 * Returns null while nothing is clearly pressed. Sticks/axes must move past 0.7 from their rest value to count, and
 * axes that look like a hat are reported as hat directions.
 */
export function detectPress(
  pad: PadLike,
  rest: { axes: number[] },
  hatAxisHint: number | undefined,
): RawRef | null {
  for (let i = 0; i < pad.buttons.length; i++) {
    const b = pad.buttons[i]!;
    if (b.pressed || b.value > 0.6) return { k: 'b', i };
  }
  if (hatAxisHint !== undefined) {
    const d = decodeHat(pad.axes[hatAxisHint]);
    if (d && d.length === 1) return { k: 'h', d: d as 'u' | 'd' | 'l' | 'r' };
  }
  for (let i = 0; i < pad.axes.length; i++) {
    if (i === hatAxisHint) continue;
    const v = axis(pad, i);
    const r = rest.axes[i] ?? 0;
    // A trigger axis rests at −1 and travels to +1: measure travel from rest so it isn't "pressed" at −1.
    if (v - r > 0.7) return { k: 'a', i, s: 1 };
    if (v - r < -0.7 && r > -0.5) return { k: 'a', i, s: -1 };
  }
  return null;
}

export function describeRef(ref: RawRef): string {
  switch (ref.k) {
    case 'b':
      return `button ${ref.i}`;
    case 'a':
      return `axis ${ref.i}${ref.s > 0 ? '+' : '−'}`;
    case 'h':
      return `hat ${ref.d.toUpperCase()}`;
  }
}
