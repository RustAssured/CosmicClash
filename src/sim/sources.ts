import {
  Btn,
  copyInput,
  type AIController,
  type InputFrame,
  type InputSource,
  type MatchApi,
  type ScriptEvent,
} from '@/contracts';

/** An input source that never presses anything (idle dummy). */
export function createNullSource(): InputSource {
  return {
    kind: 'none',
    poll(_tick, out) {
      out.moveX = 0;
      out.moveY = 0;
      out.held = 0;
      out.pressed = 0;
      out.released = 0;
    },
  };
}

/**
 * Scripted input for the deterministic harness / tests. Each ScriptEvent presses `buttons` at `tick` and holds them `hold` ticks
 * (0 = a one-tick tap); a direction event deflects the stick from `tick` for `moveTicks` ticks (or until the next direction event).
 * `poll` must be called once per tick with strictly increasing ticks counted from the script's own zero (tick 0 = round start is
 * NOT assumed: pass the sim tick you want the script measured against via `offset`).
 */
export function createScriptSource(events: readonly ScriptEvent[], offset = 0): InputSource {
  let prevHeld = 0;
  let stickUntil = -1;
  let sx = 0;
  let sy = 0;
  return {
    kind: 'script',
    poll(tick, out) {
      const t = tick - offset;
      let held = 0;
      for (let i = 0; i < events.length; i++) {
        const e = events[i]!;
        if (e.buttons !== 0) {
          if (t >= e.tick && t <= e.tick + e.hold) held |= e.buttons;
        } else if (e.moveTicks > 0 && t === e.tick) {
          sx = e.moveX;
          sy = e.moveY;
          stickUntil = e.moveTicks >= 1e8 ? Infinity : e.tick + e.moveTicks;
        }
      }
      if (t >= stickUntil) {
        sx = 0;
        sy = 0;
        stickUntil = -1;
      }
      out.moveX = sx;
      out.moveY = sy;
      out.held = held;
      out.pressed = held & ~prevHeld;
      out.released = prevHeld & ~held;
      prevHeld = held;
    },
  };
}

/**
 * Wraps an AIController as an InputSource. The AI only sees the public AIContext (delayed by its own reaction buffer) and
 * fills `held` + stick; edge bits are derived HERE from the held mask so an AI can never fabricate an edge.
 */
export function createAiSource(match: MatchApi, slot: 0 | 1, ai: AIController): InputSource {
  let prevHeld = 0;
  const tmp: InputFrame = { moveX: 0, moveY: 0, held: 0, pressed: 0, released: 0 };
  return {
    kind: 'ai',
    poll(_tick, out) {
      tmp.moveX = 0;
      tmp.moveY = 0;
      tmp.held = 0;
      tmp.pressed = 0;
      tmp.released = 0;
      ai.decide(match.aiContext(slot), tmp);
      const held = tmp.held & ~(Btn.PAUSE | Btn.TRAINING);
      out.moveX = Math.max(-1, Math.min(1, tmp.moveX));
      out.moveY = Math.max(-1, Math.min(1, tmp.moveY));
      out.held = held;
      out.pressed = held & ~prevHeld;
      out.released = prevHeld & ~held;
      prevHeld = held;
    },
  };
}

/** Merge helper used by the match to keep presses that happen during hit-stop. */
export function accumulateInput(acc: InputFrame, frame: InputFrame): void {
  acc.pressed |= frame.pressed;
  acc.released |= frame.released;
  acc.held = frame.held;
  acc.moveX = frame.moveX;
  acc.moveY = frame.moveY;
}

export { copyInput };
