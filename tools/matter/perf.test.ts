import { describe, expect, it } from 'vitest';
import { replay, summarize } from './harness';

/**
 * Performance regression guard. Wall-clock ticks on a shared machine are noisy, so the scenario (deterministic) is replayed and
 * the per-tick minimum is judged (see harness.ts): scheduler noise disappears, real per-tick cost stays. The budget is the
 * Lead's: Match.step() must stay <= 5 ms at p99, of which the matter world may use a fraction; the ceiling here is 3.5 ms p99
 * for the SATURATED scenario (two ~22k-cell bodies, every damage type, a hit every 4 ticks), which is twice the real body size.
 */
describe('matter performance budget', () => {
  it('saturated scenario: p99 per applyDamage+tick stays <= 3.5 ms (load-robust, two 22k-cell bodies)', () => {
    const r = replay({ ticks: 900, everyN: 4, seed: 2 }, 4);
    const s = summarize(r.step);
    expect(s.p99).toBeLessThanOrEqual(3.5);
    // The mean is far below the budget too.
    expect(s.avg).toBeLessThan(1.5);
    // The ledger stays exact under the same load.
    expect(Math.abs(r.last.world.ledger().error)).toBeLessThan(1e-2);
  }, 120_000);

  it('real-size bodies (~10k cells) with both pools full: p99 <= 3 ms', () => {
    const r = replay({ ticks: 600, everyN: 4, seed: 4, radius: 55, prefill: true }, 4);
    expect(summarize(r.step).p99).toBeLessThanOrEqual(3);
  }, 120_000);
});
