import { TICK_HZ } from '@/contracts';

/**
 * Fixed-timestep game loop: a rAF-driven accumulator.
 *
 * The simulation only ever sees FIXED ticks (D10). Slow-motion is therefore expressed as "fewer ticks per second"
 * (`timeScale`), never as a variable dt. Rendering interpolates between ticks with `alpha ∈ [0,1)`.
 *
 * Guarantees
 *  - at most `maxTicksPerFrame` (2) ticks per frame; a backlog after a hitch is caught up over the next frames, but never
 *    more than `maxCatchUp` (5) ticks of it: anything beyond is DROPPED (no spiral of death). S21: a 5-tick burst in one
 *    frame made that frame long too (a cascade on a slow machine); spreading it keeps every frame's CPU bounded,
 *  - vsync snap: a frame interval within ±`VSYNC_SNAP_MS` of a whole number of ticks counts as exactly that many ticks, so
 *    a 60 Hz panel's rAF jitter (±0.5 ms) never turns into alternating 0- and 2-tick frames (judder),
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
  /** Most ticks of backlog ever caught up (beyond it time is dropped). Default 5. */
  maxCatchUp?: number;
  /** Most ticks run in one frame (the rest of the backlog waits for the next frames). Default 2. */
  maxTicksPerFrame?: number;
  /** Monotonic millisecond clock. Default `performance.now`. */
  now?: () => number;
  /** rAF-alike. Default `requestAnimationFrame`. */
  requestFrame?: (cb: (nowMs: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  /** Subscribe to page visibility. Returns an unsubscribe. Default: `document.visibilitychange`. */
  onVisibility?: (visibleCb: (visible: boolean) => void) => () => void;
  /** Profiling hook: main-thread ms of every tick (`frame` false) and every rendered frame (`frame` true). */
  onTiming?: (frame: boolean, ms: number) => void;
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
/** A frame interval this close to a whole number of ticks is snapped to it (rAF timestamp jitter on a vsynced display). */
export const VSYNC_SNAP_MS = 0.6;
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
  const perFrame = Math.max(1, Math.min(maxCatchUp, opts.maxTicksPerFrame ?? 2));
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
    const ms = now() - t0;
    stats.msPerTick = avg(stats.msPerTick, ms, nTick++);
    opts.onTiming?.(false, ms);
  }

  function runFrame(a: number, dtSec: number): void {
    const t0 = now();
    opts.frame(a, dtSec);
    const ms = now() - t0;
    stats.msPerFrame = avg(stats.msPerFrame, ms, nFrame++);
    opts.onTiming?.(true, ms);
  }

  function step(t: number): void {
    handle = 0;
    if (!running) return;
    handle = requestFrame(step);
    let realMs = Math.min(MAX_FRAME_MS, Math.max(0, t - last));
    last = t;
    const k = Math.round(realMs / tickMs);
    if (k >= 1 && k <= maxCatchUp && Math.abs(realMs - k * tickMs) < VSYNC_SNAP_MS) realMs = k * tickMs;
    if (paused || hidden) {
      alpha = 0;
      runFrame(0, realMs / 1000);
      return;
    }
    acc += realMs * scale;
    if (acc >= (maxCatchUp + 1) * tickMs) {
      // Further behind than we ever catch up: drop the excess rather than chase it (keep the fraction for interpolation).
      acc = maxCatchUp * tickMs + (acc % tickMs);
      stats.droppedFrames++;
    }
    let n = 0;
    while (acc >= tickMs && n < perFrame) {
      runTick();
      acc -= tickMs;
      n++;
    }
    // a backlog left for the next frames still renders at the newest tick (alpha < 1)
    alpha = Math.min(acc / tickMs, 0.999);
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
