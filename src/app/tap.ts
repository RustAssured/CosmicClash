import { Btn, type InputFrame, type InputSource } from '@/contracts';

/**
 * Wrap a human InputSource so the app can see PAUSE / TRAINING presses that happen inside sim ticks without owning the devices.
 * (The Match only sees InputFrames; the app needs these two edges for its own state machine.)
 */
export interface TappedSource extends InputSource {
  /** Edges seen since the last `take()`. */
  take(): { pause: boolean; training: boolean };
}

export function tapSource(inner: InputSource): TappedSource {
  let pause = false;
  let training = false;
  return {
    get kind() {
      return inner.kind;
    },
    poll(tick: number, out: InputFrame): void {
      inner.poll(tick, out);
      if (out.pressed & Btn.PAUSE) pause = true;
      if (out.pressed & Btn.TRAINING) training = true;
      // the sim never needs these two buttons
      out.held &= ~(Btn.PAUSE | Btn.TRAINING);
      out.pressed &= ~(Btn.PAUSE | Btn.TRAINING);
      out.released &= ~(Btn.PAUSE | Btn.TRAINING);
    },
    take() {
      const r = { pause, training };
      pause = false;
      training = false;
      return r;
    },
  };
}

/** A dummy that holds GUARD forever (training). */
export function createGuardDummy(): InputSource {
  let prev = 0;
  return {
    kind: 'script',
    poll(_tick, out) {
      out.moveX = 0;
      out.moveY = 0;
      out.held = Btn.GUARD;
      out.pressed = Btn.GUARD & ~prev;
      out.released = 0;
      prev = Btn.GUARD;
    },
  };
}
