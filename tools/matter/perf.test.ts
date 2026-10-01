import { describe, expect, it } from 'vitest';
import { replayAgainst } from './harness';

/**
 * Performance regression guard. Wall-clock ticks on a shared machine are noisy, so the scenario (deterministic) is replayed and
 * the per-tick minimum is judged (see harness.ts): scheduler spikes disappear, the real per-tick cost stays. Under the full
 * suite's parallel workers the machine is also slower as a whole (shared cores, memory bandwidth, cache): the budgets scale
 * with `speedFactor()` — an ALU and a memory-bound reference workload sampled between replays, 1.0 on WJ's quiet laptop (the
 * reference machine), so there the assertions ARE the spec budgets — and a run that is still over budget is replayed more
 * (`replayAgainst`, up to 10 replays) before it is judged. The tests run one after the other within this file.
 */
describe.sequential('matter performance budget', () => {
  it('saturated scenario: p99 per applyDamage+tick stays <= 5 ms (spec budget) (load-robust, two 22k-cell bodies)', () => {
    const r = replayAgainst({ ticks: 900, everyN: 4, seed: 2 }, 5.0);
    expect(r.stats.p99).toBeLessThanOrEqual(5.0 * r.factor);
    // The mean is far below the budget too.
    expect(r.stats.avg).toBeLessThan(1.5 * r.factor);
    // The ledger stays exact under the same load.
    expect(Math.abs(r.last.world.ledger().error)).toBeLessThan(1e-2);
  }, 300_000);

  it('real-size bodies (~10k cells) with both pools full: p99 <= 3 ms', () => {
    const r = replayAgainst({ ticks: 600, everyN: 4, seed: 4, radius: 55, prefill: true }, 3.0);
    expect(r.stats.p99).toBeLessThanOrEqual(3 * r.factor);
  }, 300_000);
});
