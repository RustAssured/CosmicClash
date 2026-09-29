import { describe, expect, it } from 'vitest';
import { runSliced, runToEnd, scaled } from './slicer';

/** A fake clock advanced by the work itself, and a frame wait that advances it by 16.7 ms. */
function harness() {
  let t = 0;
  const log = { waits: 0 };
  return {
    now: () => t,
    work: (ms: number) => {
      t += ms;
    },
    nextFrame: async () => {
      log.waits++;
      t += 16.7;
    },
    log,
  };
}

function* job(
  h: ReturnType<typeof harness>,
  steps: number,
  msPerStep: number,
): Generator<number, void, void> {
  for (let i = 0; i < steps; i++) {
    h.work(msPerStep);
    yield (i + 1) / steps;
  }
}

describe('runSliced', () => {
  it('spreads work over frames according to the budget', async () => {
    const h = harness();
    const r = await runSliced(job(h, 40, 2), { budgetMs: 5, now: h.now, nextFrame: h.nextFrame });
    expect(r.completed).toBe(true);
    // 40 steps × 2 ms = 80 ms of work, ≥ 5 ms per slice ⇒ 3 steps per slice ⇒ ~14 slices
    expect(r.frames).toBeGreaterThanOrEqual(12);
    expect(r.frames).toBeLessThanOrEqual(16);
    expect(h.log.waits).toBe(r.frames);
  });

  it('never runs a slice much longer than budget + one step', async () => {
    const h = harness();
    const r = await runSliced(job(h, 60, 1.5), { budgetMs: 5, now: h.now, nextFrame: h.nextFrame });
    expect(r.maxSliceMs).toBeLessThanOrEqual(5 + 1.5 + 1e-9);
  });

  it('reports monotonic progress ending at exactly 1', async () => {
    const h = harness();
    const seen: number[] = [];
    await runSliced(job(h, 20, 1), { now: h.now, nextFrame: h.nextFrame, onProgress: (p) => seen.push(p) });
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(seen.at(-1)).toBe(1);
    expect(seen.every((p) => p >= 0 && p <= 1)).toBe(true);
  });

  it('a job shorter than one slice finishes without waiting for a frame', async () => {
    const h = harness();
    const r = await runSliced(job(h, 2, 1), { budgetMs: 5, now: h.now, nextFrame: h.nextFrame });
    expect(r.completed).toBe(true);
    expect(r.frames).toBe(0);
  });

  it('cancellation stops between steps and closes the generator', async () => {
    const h = harness();
    let closed = false;
    function* g(): Generator<number, void, void> {
      try {
        for (let i = 0; i < 100; i++) {
          h.work(2);
          yield i / 100;
        }
      } finally {
        closed = true;
      }
    }
    let n = 0;
    const r = await runSliced(g(), {
      budgetMs: 5,
      now: h.now,
      nextFrame: async () => {
        n++;
        await h.nextFrame();
      },
      cancelled: () => n >= 2,
    });
    expect(r.completed).toBe(false);
    expect(closed).toBe(true);
  });

  it('propagates exceptions thrown by a step', async () => {
    const h = harness();
    function* bad(): Generator<number, void, void> {
      yield 0.1;
      throw new Error('bake failed');
    }
    await expect(runSliced(bad(), { now: h.now, nextFrame: h.nextFrame })).rejects.toThrow('bake failed');
  });
});

describe('runSliced with promise steps', () => {
  it('awaits a yielded promise before continuing and does not count the wait against the budget', async () => {
    const h = harness();
    const order: string[] = [];
    function* g(): Generator<number | Promise<unknown>, void, void> {
      order.push('a');
      h.work(1);
      yield new Promise<void>((res) =>
        setTimeout(() => {
          order.push('compiled');
          res();
        }, 5),
      );
      order.push('b');
      h.work(1);
      yield 1;
    }
    const r = await runSliced(g(), { budgetMs: 5, now: h.now, nextFrame: h.nextFrame });
    expect(r.completed).toBe(true);
    expect(order).toEqual(['a', 'compiled', 'b']);
    expect(r.maxSliceMs).toBeLessThan(5);
  });
});

describe('scaled / runToEnd', () => {
  it('rescales child progress into the parent range', () => {
    const h = harness();
    const vals = [...scaled(job(h, 4, 0), 0.2, 0.6)];
    expect(vals[0]).toBeCloseTo(0.3, 9);
    expect(vals.at(-1)).toBeCloseTo(0.6, 9);
  });

  it('runToEnd drains the generator', () => {
    const h = harness();
    runToEnd(job(h, 10, 3));
    expect(h.now()).toBe(30);
  });
});
