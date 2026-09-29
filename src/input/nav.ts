/**
 * Menu navigation: turns "which directions are held right now" into discrete fire events with auto-repeat, the way every
 * console menu does — fire on press, wait `delayMs`, then repeat every `repeatMs` while held. Pure and clock-injected.
 */
export const NAV = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8 } as const;

export interface RepeatOptions {
  delayMs: number;
  repeatMs: number;
}
export const DEFAULT_REPEAT: RepeatOptions = { delayMs: 380, repeatMs: 90 };

export class NavRepeater {
  private readonly nextAt = new Float64Array(4).fill(-1);
  private prev = 0;
  private readonly opts: RepeatOptions;

  constructor(opts: RepeatOptions = DEFAULT_REPEAT) {
    this.opts = opts;
  }

  /**
   * @param nowMs monotonic clock (ms)
   * @param held bitmask of NAV.* currently held (opposites cancel)
   * @returns bitmask of directions that fire on this step
   */
  step(nowMs: number, held: number): number {
    if (held & NAV.UP && held & NAV.DOWN) held &= ~(NAV.UP | NAV.DOWN);
    if (held & NAV.LEFT && held & NAV.RIGHT) held &= ~(NAV.LEFT | NAV.RIGHT);
    let fire = 0;
    for (let i = 0; i < 4; i++) {
      const bit = 1 << i;
      if (held & bit) {
        if (!(this.prev & bit)) {
          fire |= bit;
          this.nextAt[i] = nowMs + this.opts.delayMs;
        } else if (nowMs >= this.nextAt[i]!) {
          fire |= bit;
          // Catch up without bursting: if a frame hitch skipped several intervals, fire once and re-anchor.
          this.nextAt[i] = Math.max(this.nextAt[i]! + this.opts.repeatMs, nowMs + this.opts.repeatMs * 0.5);
        }
      }
    }
    this.prev = held;
    return fire;
  }

  reset(): void {
    this.prev = 0;
    this.nextAt.fill(-1);
  }
}

/** Stick → nav bits with hysteresis: engages at `on`, releases at `off`; on a diagonal the dominant axis wins. */
export class StickNav {
  private bits = 0;
  constructor(
    private readonly on = 0.55,
    private readonly off = 0.38,
  ) {}

  private axis(b: number, v: number, pos: number, neg: number): number {
    if (v > this.on) return (b | pos) & ~neg;
    if (v < -this.on) return (b | neg) & ~pos;
    if (Math.abs(v) < this.off) return b & ~(pos | neg);
    return b;
  }

  step(x: number, y: number): number {
    let b = this.axis(this.bits, x, NAV.RIGHT, NAV.LEFT);
    b = this.axis(b, y, NAV.DOWN, NAV.UP);
    if (b & (NAV.LEFT | NAV.RIGHT) && b & (NAV.UP | NAV.DOWN)) {
      const ax = Math.abs(x);
      const ay = Math.abs(y);
      if (ax > ay * 1.25) b &= ~(NAV.UP | NAV.DOWN);
      else if (ay > ax * 1.25) b &= ~(NAV.LEFT | NAV.RIGHT);
    }
    this.bits = b;
    return b;
  }

  reset(): void {
    this.bits = 0;
  }
}
