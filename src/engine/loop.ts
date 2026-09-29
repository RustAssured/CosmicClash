import { TICK_HZ } from '@/contracts';

/**
 * Fixed-timestep game loop: a rAF-driven accumulator.
 *
 * The simulation only ever sees FIXED ticks (D10). Slow-motion is therefore expressed as "fewer ticks per second"
 * (`timeScale`), never as a variable dt. Rendering interpolates between ticks with `alpha ∈ [0,1)`.
 *
 * Guarantees
 *  - at most `maxCatchUp` ticks per frame; any further backlog is DROPPED (no spiral of death),
 *  - a hidden tab pauses the clock and resumes without a burst of catch-up ticks,
 *  - `stepTicks(n)` runs exactly n ticks (deterministic harness) and never touches the real clock,
 *  - the clock, rAF and visibility source are injectable so the loop is fully unit-testable in Node.
 */

export interface LoopOptions {
  /** Advance the simulation exactly one fixed tick. */
  tick: () => void;
  /** Render one frame. `alpha` is the fraction of a tick elapsed since the last tick; `dtSec` real seconds since the last frame. */
  frame: (alpha: number, dtSec: number) => void;
  tickHz?: number;
  /** Max ticks executed per frame before the remainder is dropped. Default 5. */
  maxCatchUp?: number;
  /** Monotonic millisecond clock. Default `performance.now`. */
  now?: () => number;
  /** rAF-alike. Default `requestAnimationFrame`. */
  requestFrame?: (cb: (nowMs: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  /** Subscribe to page visibility. Returns an unsubscribe. Default: `document.visibilitychange`. */
  onVisibility?: (visibleCb: (visible: boolean) => void) => () => void;
}

export interface LoopStats {
  /** Rolling average CPU ms spent inside `tick()` per tick. */
  msPerTick: number;
  /** Rolling average CPU ms spent inside `frame()` per frame. */
  msPerFrame: number;
  /** Rolling average ticks executed per rendered frame (≈ 1 at 60 Hz display, < 1 under slow-mo). */
  ticksPerFrame: number;
  /** Frames where the catch-up cap was hit and time was dropped. */
  droppedFrames: number;
}

export interface Loop {
  /** Ticks per second multiplier, clamped to [MIN_TIME_SCALE, 1]. Set by the app for KO slow-mo. */
  timeScale: number;
  readonly running: boolean;
  readonly paused: boolean;
  /** Fraction of a tick elapsed since the last tick (what the last `frame()` received). */
  readonly alpha: number;
  readonly stats: LoopStats;
  /** Start driving from rAF. Idempotent. */
  start(): void;
  /** Stop driving and cancel rAF. */
  stop(): void;
  /** Freeze ticking (frames keep rendering with alpha = 0 so the harness can screenshot). */
  pause(): void;
  resume(): void;
  /** Run exactly `n` ticks now (no clock involved). Renders one frame afterwards unless `render` is false. */
  stepTicks(n: number, render?: boolean): void;
  dispose(): void;
}

export const MIN_TIME_SCALE = 0.05;
/** A frame longer than this is treated as a stall (debugger, GC, slow device) and clamped. */
const MAX_FRAME_MS = 250;
/** Smoothing factor of the rolling averages (≈ 1/60: about one second of history). */
const SMOOTH = 1 / 60;

const defaultVisibility = (cb: (visible: boolean) => void): (() => void) => {
  if (typeof document === 'undefined') return () => undefined;
  const h = (): void => cb(document.visibilityState !== 'hidden');
  document.addEventListener('visibilitychange', h);
  return () => document.removeEventListener('visibilitychange', h);
};

export function createLoop(opts: LoopOptions): Loop {
  const tickMs = 1000 / (opts.tickHz ?? TICK_HZ);
  const maxCatchUp = Math.max(1, opts.maxCatchUp ?? 5);
  const now = opts.now ?? ((): number => performance.now());
  const requestFrame = opts.requestFrame ?? ((cb: (t: number) => void): number => requestAnimationFrame(cb));
  const cancelFrame = opts.cancelFrame ?? ((h: number): void => cancelAnimationFrame(h));
  const onVisibility = opts.onVisibility ?? defaultVisibility;

  let scale = 1;
  let running = false;
  let paused = false;
  let hidden = false;
  let handle = 0;
  let last = 0;
  let acc = 0;
  let alpha = 0;
  let unsub: (() => void) | null = null;

  const stats: LoopStats = { msPerTick: 0, msPerFrame: 0, ticksPerFrame: 0, droppedFrames: 0 };
  /** Sample counts so each rolling average seeds itself with its first sample instead of ramping up from 0. */
  let nTick = 0;
  let nFrame = 0;
  let nTpf = 0;
  const avg = (cur: number, sample: number, count: number): number =>
    count === 0 ? sample : cur + (sample - cur) * SMOOTH;

  function runTick(): void {
    const t0 = now();
    opts.tick();
    stats.msPerTick = avg(stats.msPerTick, now() - t0, nTick++);
  }

  function runFrame(a: number, dtSec: number): void {
    const t0 = now();
    opts.frame(a, dtSec);
    stats.msPerFrame = avg(stats.msPerFrame, now() - t0, nFrame++);
  }

  function step(t: number): void {
    handle = 0;
    if (!running) return;
    handle = requestFrame(step);
    const realMs = Math.min(MAX_FRAME_MS, Math.max(0, t - last));
    last = t;
    if (paused || hidden) {
      alpha = 0;
      runFrame(0, realMs / 1000);
      return;
    }
    acc += realMs * scale;
    let n = 0;
    while (acc >= tickMs && n < maxCatchUp) {
      runTick();
      acc -= tickMs;
      n++;
    }
    if (acc >= tickMs) {
      // Still behind after the cap: drop the backlog rather than chase it.
      acc %= tickMs;
      stats.droppedFrames++;
    }
    alpha = acc / tickMs;
    stats.ticksPerFrame = avg(stats.ticksPerFrame, n, nTpf++);
    runFrame(alpha, realMs / 1000);
  }

  const loop: Loop = {
    get timeScale() {
      return scale;
    },
    set timeScale(v: number) {
      scale = Math.min(1, Math.max(MIN_TIME_SCALE, Number.isFinite(v) ? v : 1));
    },
    get running() {
      return running;
    },
    get paused() {
      return paused;
    },
    get alpha() {
      return alpha;
    },
    stats,
    start() {
      if (running) return;
      running = true;
      last = now();
      acc = 0;
      unsub = onVisibility((visible) => {
        hidden = !visible;
        // Resuming: forget the time spent hidden so no burst of ticks follows.
        if (visible) {
          last = now();
          acc = 0;
        }
      });
      handle = requestFrame(step);
    },
    stop() {
      running = false;
      if (handle) cancelFrame(handle);
      handle = 0;
      if (unsub) unsub();
      unsub = null;
    },
    pause() {
      paused = true;
    },
    resume() {
      if (!paused) return;
      paused = false;
      last = now();
      acc = 0;
    },
    stepTicks(n, render = true) {
      for (let i = 0; i < n; i++) runTick();
      if (render) {
        alpha = 0;
        runFrame(0, 0);
      }
    },
    dispose() {
      loop.stop();
    },
  };
  return loop;
}
