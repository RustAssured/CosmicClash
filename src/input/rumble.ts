import type { PadLike } from './types';

/** The bits of `GamepadHapticActuator` we use (typed structurally: it is missing from some lib.dom versions). */
interface DualRumbleActuator {
  playEffect?: (
    type: string,
    params: { startDelay?: number; duration: number; weakMagnitude: number; strongMagnitude: number },
  ) => Promise<unknown> | unknown;
}
interface PulseActuator {
  pulse?: (value: number, duration: number) => Promise<unknown> | unknown;
}

/**
 * Per-device rumble gate. Browsers queue effects; firing one per tick for a sustained hit train makes the motors stutter and
 * (on Bluetooth) floods the link. A new request is admitted when the gate is quiet, or when it is clearly stronger than what
 * is still playing (so a heavy blow always cuts through a light rumble).
 */
export class RumbleGate {
  private lastAt = -1e9;
  private lastUntil = -1e9;
  private lastPeak = 0;
  constructor(private readonly minGapMs = 45) {}

  admit(nowMs: number, peak: number, ms: number): boolean {
    const playing = nowMs < this.lastUntil;
    const gap = nowMs - this.lastAt;
    const stronger = peak > this.lastPeak * 1.3 + 0.05;
    if (playing && gap < this.minGapMs && !stronger) return false;
    if (playing && !stronger && peak <= this.lastPeak) return false;
    this.lastAt = nowMs;
    this.lastUntil = nowMs + ms;
    this.lastPeak = peak;
    return true;
  }

  reset(): void {
    this.lastAt = -1e9;
    this.lastUntil = -1e9;
    this.lastPeak = 0;
  }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Play a dual-rumble effect on a pad. `vibrationActuator.playEffect('dual-rumble', …)` first; the legacy
 * `hapticActuators[0].pulse` as a fallback. Never throws and never leaves an unhandled rejection. Returns true if an effect
 * was submitted.
 */
export function playRumble(
  pad: PadLike | null | undefined,
  strong: number,
  weak: number,
  ms: number,
): boolean {
  if (!pad) return false;
  const s = clamp01(strong);
  const w = clamp01(weak);
  const duration = Math.max(10, Math.min(2000, Math.round(ms)));
  try {
    const va = pad.vibrationActuator as DualRumbleActuator | null | undefined;
    if (va && typeof va.playEffect === 'function') {
      const r = va.playEffect('dual-rumble', {
        startDelay: 0,
        duration,
        weakMagnitude: w,
        strongMagnitude: s,
      });
      swallow(r);
      return true;
    }
    const ha = pad.hapticActuators as ArrayLike<PulseActuator> | null | undefined;
    const first = ha && ha.length > 0 ? ha[0] : undefined;
    if (first && typeof first.pulse === 'function') {
      swallow(first.pulse(Math.max(s, w), duration));
      return true;
    }
  } catch {
    /* rumble is a luxury: a controller that dislikes the request must never break the game */
  }
  return false;
}

export function hasRumble(pad: PadLike | null | undefined): boolean {
  if (!pad) return false;
  const va = pad.vibrationActuator as DualRumbleActuator | null | undefined;
  if (va && typeof va.playEffect === 'function') return true;
  const ha = pad.hapticActuators as ArrayLike<PulseActuator> | null | undefined;
  return !!ha && ha.length > 0;
}

function swallow(r: unknown): void {
  if (r && typeof (r as Promise<unknown>).catch === 'function')
    (r as Promise<unknown>).catch(() => undefined);
}
