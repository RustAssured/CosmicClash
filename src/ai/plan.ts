import { Btn, type InputFrame } from '@/contracts';

/** How a step steers the stick. World axes: +x right, +y down. */
export const enum Steer {
  Neutral = 0,
  /** Toward the foe (x), aligning vertically with it. */
  Toward = 1,
  /** Away from the foe. */
  Away = 2,
  /** Fixed world direction (`sx`,`sy`). */
  Fixed = 3,
}

export interface Step {
  /** Buttons held during the step. */
  mask: number;
  steer: Steer;
  sx: number;
  sy: number;
  /** Vertical alignment with the foe while steering Toward: 0 = none, 1 = full. */
  align: number;
  ticks: number;
}

const MAX_STEPS = 8;

/**
 * A short script the AI runs: a few (buttons, stick, duration) steps. Plans are what make actions span several ticks
 * (walk in, press, hold to charge, release, back away). Preallocated; `begin` reuses the same objects.
 */
export class Plan {
  name = '';
  readonly steps: Step[] = Array.from({ length: MAX_STEPS }, () => ({
    mask: 0,
    steer: Steer.Neutral,
    sx: 0,
    sy: 0,
    align: 0,
    ticks: 0,
  }));
  count = 0;
  index = 0;
  tickInStep = 0;
  /** Ticks to wait (neutral) before step 0 starts: the human execution delay. */
  delay = 0;
  /** Priority class so defensive plans can pre-empt offensive ones (0 idle/space, 1 attack, 2 defend). */
  kind: 'space' | 'attack' | 'defend' | 'wait' = 'wait';
  /** Tick the plan was created (for logs and timeouts). */
  startedAt = 0;

  get active(): boolean {
    return this.index < this.count;
  }

  begin(name: string, kind: Plan['kind'], tick: number, delay = 0): this {
    this.name = name;
    this.kind = kind;
    this.count = 0;
    this.index = 0;
    this.tickInStep = 0;
    this.delay = delay;
    this.startedAt = tick;
    return this;
  }

  add(mask: number, steer: Steer, ticks: number, sx = 0, sy = 0, align = 0): this {
    const s = this.steps[this.count++]!;
    s.mask = mask;
    s.steer = steer;
    s.sx = sx;
    s.sy = sy;
    s.align = align;
    s.ticks = ticks;
    return this;
  }

  cancel(): void {
    this.index = this.count;
    this.delay = 0;
  }

  /**
   * Write this tick's input. `dx,dy` = foe − self (world) as the AI perceives it. Returns false when the plan has finished.
   */
  run(out: InputFrame, dx: number, dy: number): boolean {
    if (this.delay > 0) {
      this.delay--;
      out.moveX = 0;
      out.moveY = 0;
      out.held = 0;
      return true;
    }
    if (!this.active) return false;
    const s = this.steps[this.index]!;
    let mx = 0;
    let my = 0;
    switch (s.steer) {
      case Steer.Toward:
        mx = dx === 0 ? 0 : Math.sign(dx);
        my = s.align > 0 ? Math.max(-1, Math.min(1, (dy / 70) * s.align)) : 0;
        break;
      case Steer.Away:
        mx = dx === 0 ? -1 : -Math.sign(dx);
        my = 0;
        break;
      case Steer.Fixed:
        mx = s.sx;
        my = s.sy;
        break;
      default:
    }
    out.moveX = mx;
    out.moveY = my;
    out.held = s.mask;
    if (++this.tickInStep >= s.ticks) {
      this.index++;
      this.tickInStep = 0;
    }
    return this.active || true;
  }
}

export const B = Btn;
