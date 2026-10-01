import type { SimEvent } from '@/contracts';

/** What a fighter draws this tick, as far as the feel instrumentation cares (integers: what the player sees). */
export interface DrawnState {
  /** Integer root position (anchor, without the idle bob/sway, which move on their own). */
  rx: number;
  ry: number;
  /** Integer row-shear lean of the body (world px). */
  lean: number;
}

/**
 * Feel instrumentation (contract `SimEvent` 'feel'): for every accepted command it reports
 *  - `accept` on the tick the command was taken (ticks 0),
 *  - `respond` on the first tick a drawn pixel changed because of it: the integer root left its extrapolated path
 *    (`root`) or the lean changed (`pose`), with the ticks since accept,
 *  - `settle` on the first of three consecutive quiet ticks (the body back within rest thresholds), ticks since accept.
 * A new command replaces a pending one. Deterministic and allocation-light (one small event object per report).
 */
export class FeelTracker {
  private cmd = '';
  private acceptTick = 0;
  private pendRespond = false;
  private pendSettle = false;
  private quiet = 0;
  private quietStart = 0;
  private init = false;
  private rx = 0;
  private ry = 0;
  private dx = 0;
  private dy = 0;
  private lean = 0;
  /** Ticks after which an unsettled command is reported as settled-late (so telemetry never waits forever). */
  static readonly SETTLE_LIMIT = 300;

  get pending(): boolean {
    return this.pendRespond;
  }

  get command(): string {
    return this.cmd;
  }

  reset(): void {
    this.pendRespond = false;
    this.pendSettle = false;
    this.quiet = 0;
    this.init = false;
  }

  accept(cmd: string, tick: number, slot: 0 | 1, events: SimEvent[]): void {
    this.cmd = cmd;
    this.acceptTick = tick;
    this.pendRespond = true;
    this.pendSettle = true;
    this.quiet = 0;
    events.push({ t: 'feel', slot, kind: 'accept', cmd, ticks: 0 });
  }

  /** The pending command was answered through a light or fx the behaviour drew (not the body's root or lean). */
  respondVia(channel: 'light' | 'fx', tick: number, slot: 0 | 1, events: SimEvent[]): void {
    if (!this.pendRespond) return;
    this.pendRespond = false;
    events.push({ t: 'feel', slot, kind: 'respond', cmd: this.cmd, ticks: tick - this.acceptTick, channel });
  }

  /** Would this drawn state count as a response to the pending command (vs. the previous tick)? */
  changed(s: DrawnState): 'root' | 'pose' | null {
    if (!this.init) return null;
    if (s.lean !== this.lean) return 'pose';
    if (s.rx !== this.rx + this.dx || s.ry !== this.ry + this.dy) return 'root';
    return null;
  }

  /** End of tick: report respond/settle and remember the drawn state. `quiet` = the body is within rest thresholds. */
  observe(tick: number, s: DrawnState, quiet: boolean, slot: 0 | 1, events: SimEvent[]): void {
    if (this.pendRespond) {
      const ch = this.changed(s);
      if (ch !== null) {
        this.pendRespond = false;
        events.push({
          t: 'feel',
          slot,
          kind: 'respond',
          cmd: this.cmd,
          ticks: tick - this.acceptTick,
          channel: ch,
        });
      }
    }
    if (this.pendSettle && !this.pendRespond) {
      if (quiet) {
        if (this.quiet === 0) this.quietStart = tick;
        this.quiet++;
      } else this.quiet = 0;
      const late = tick - this.acceptTick >= FeelTracker.SETTLE_LIMIT;
      if (this.quiet >= 3 || late) {
        this.pendSettle = false;
        events.push({
          t: 'feel',
          slot,
          kind: 'settle',
          cmd: this.cmd,
          ticks: (late && this.quiet < 3 ? tick : this.quietStart) - this.acceptTick,
        });
      }
    }
    if (this.init) {
      this.dx = s.rx - this.rx;
      this.dy = s.ry - this.ry;
    }
    this.rx = s.rx;
    this.ry = s.ry;
    this.lean = s.lean;
    this.init = true;
  }
}
