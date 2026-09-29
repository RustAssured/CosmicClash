/**
 * Time-sliced execution of a generator: the way stage preparation (bakes, palette LUT, particle placement) is spread across
 * frames so the game never freezes at round start. Pure (clock and frame-wait are injected), so it is unit-tested in Node.
 *
 * A "step" is one `next()` of the generator; the generator yields at every point where pausing is safe and (optionally)
 * reports progress in 0..1. `runSliced` executes steps until the per-frame budget is spent, then waits for the next frame.
 */

/** A step may yield a Promise: the runner awaits it (outside the time budget) before continuing — used to wait for background shader compiles. */
export type StepValue = number | void | Promise<unknown>;

export interface SliceOptions {
  /** Milliseconds of work per slice (default 5 — leaves most of a 16.7 ms frame to the game). */
  budgetMs?: number;
  /** Monotonic ms clock. */
  now: () => number;
  /** Resolves on the next animation frame (or a timer when the tab is hidden). */
  nextFrame: () => Promise<void>;
  /** Called with monotonically non-decreasing progress in 0..1 after each step that reported one. */
  onProgress?: (fraction: number) => void;
  /** Checked between steps; return true to abandon the work (the generator is closed). */
  cancelled?: () => boolean;
}

export interface SliceResult {
  /** True if the generator ran to completion, false if it was cancelled. */
  completed: boolean;
  /** Number of frame waits (slices - 1) — i.e. how many frames the work was spread over. */
  frames: number;
  /** Largest single slice in ms (a good stall indicator: should stay near the budget unless one step is itself long). */
  maxSliceMs: number;
}

export async function runSliced(
  gen: Generator<StepValue, void, void>,
  o: SliceOptions,
): Promise<SliceResult> {
  const budget = o.budgetMs ?? 5;
  let progress = 0;
  let frames = 0;
  let maxSlice = 0;
  for (;;) {
    if (o.cancelled?.()) {
      gen.return();
      return { completed: false, frames, maxSliceMs: maxSlice };
    }
    const start = o.now();
    const deadline = start + budget;
    do {
      const r = gen.next();
      if (r.done) {
        maxSlice = Math.max(maxSlice, o.now() - start);
        if (o.onProgress && progress < 1) o.onProgress(1);
        return { completed: true, frames, maxSliceMs: maxSlice };
      }
      if (typeof r.value === 'number' && r.value > progress) {
        progress = Math.min(1, r.value);
        o.onProgress?.(progress);
      } else if (r.value instanceof Promise) {
        // Close the slice, wait (e.g. for an off-thread shader compile), then continue with a fresh budget.
        maxSlice = Math.max(maxSlice, o.now() - start);
        await r.value;
        break;
      }
    } while (o.now() < deadline);
    maxSlice = Math.max(maxSlice, o.now() - start);
    frames++;
    await o.nextFrame();
  }
}

/** Run a generator to completion synchronously (the blocking path: `setStage` on something that was never prepared). */
export function runToEnd(gen: Generator<StepValue, void, void>): void {
  for (;;) if (gen.next().done) return;
}

/** Rescale a child generator's 0..1 progress into [from, to] of the parent's range. */
export function* scaled(
  gen: Generator<StepValue, void, void>,
  from: number,
  to: number,
): Generator<StepValue, void, void> {
  for (;;) {
    const r = gen.next();
    if (r.done) return;
    yield typeof r.value === 'number' ? from + (to - from) * r.value : r.value;
  }
}

/** Resolves on the next animation frame; a timer stands in while the tab is hidden (rAF is paused there). */
export function animationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (
      typeof requestAnimationFrame === 'undefined' ||
      (typeof document !== 'undefined' && document.visibilityState === 'hidden')
    )
      setTimeout(resolve, 50);
    else requestAnimationFrame(() => resolve());
  });
}
