import { Btn, INPUT_BUFFER_TICKS, type BtnMask } from '@/contracts';

const NONE = -1e9;
const BITS = [Btn.STRIKE, Btn.CRUSH, Btn.SURGE, Btn.SIGNATURE, Btn.ULTIMATE, Btn.GUARD, Btn.FEINT] as const;

/**
 * The input buffer: a button press stays "live" for INPUT_BUFFER_TICKS (9) ticks so an early press is not lost
 * during recovery, hit-stop or stun. Stores the tick of the last press per button (no allocation after construction).
 */
export class InputBuffer {
  private readonly last = new Int32Array(BITS.length).fill(NONE);

  /** Record this tick's fresh presses. */
  note(pressed: BtnMask, tick: number): void {
    for (let i = 0; i < BITS.length; i++) if (pressed & BITS[i]!) this.last[i] = tick;
  }

  clear(): void {
    this.last.fill(NONE);
  }

  /** Was `bit` pressed within the buffer window? */
  has(bit: number, tick: number, window = INPUT_BUFFER_TICKS): boolean {
    const i = BITS.indexOf(bit as (typeof BITS)[number]);
    return i >= 0 && tick - this.last[i]! <= window;
  }

  /** Consume a buffered press (returns whether one was live). */
  take(bit: number, tick: number, window = INPUT_BUFFER_TICKS): boolean {
    const i = BITS.indexOf(bit as (typeof BITS)[number]);
    if (i < 0 || tick - this.last[i]! > window) return false;
    this.last[i] = NONE;
    return true;
  }

  /**
   * The most recently pressed of `bits` that is still live, or 0. Ties go to the earlier entry of `bits`
   * (callers list them in priority order: ultimate, signature, crush, strike).
   */
  latest(bits: readonly number[], tick: number, window = INPUT_BUFFER_TICKS): number {
    let best = 0;
    let bestTick = NONE;
    for (const bit of bits) {
      const i = BITS.indexOf(bit as (typeof BITS)[number]);
      if (i < 0) continue;
      const t = this.last[i]!;
      if (tick - t <= window && t > bestTick) {
        best = bit;
        bestTick = t;
      }
    }
    return best;
  }

  /** Ticks since `bit` was last pressed (large if never). */
  age(bit: number, tick: number): number {
    const i = BITS.indexOf(bit as (typeof BITS)[number]);
    return i < 0 ? 1e9 : tick - this.last[i]!;
  }
}
