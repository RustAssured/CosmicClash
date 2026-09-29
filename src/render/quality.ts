/**
 * Adaptive quality controller (pure: no clock, no GL — it is fed frame timings and answers with a tier).
 *
 * Tiers 0 (cheapest) … 2 (showpiece). The controller is deliberately conservative about *changing* anything, because every
 * tier change costs a hitch (render targets are resized) and a flip-flopping quality setting looks worse than either tier:
 *
 *  - STEP DOWN after sustained misses: evaluation windows of ~1.5 s; a window is "bad" when ≥ 20 % of its frames were late
 *    (frame-to-frame delta > 1.2 × the 16.7 ms budget). Two consecutive bad windows are required (≥ 3 s of trouble).
 *  - STEP UP after sustained headroom, cautiously. With a GPU timer (EXT_disjoint_timer_query_webgl2) the measured GPU time,
 *    scaled by the expected cost ratio of the next tier, must fit the budget with margin for several clean windows. Without one
 *    (vsync hides headroom) it PROBES: after `upDelayMs` without a single late frame it tries the next tier; if that probe fails
 *    (a step-down follows within `probeWindowMs`) the delay doubles (up to `upDelayMaxMs`), so a machine that cannot hold the
 *    higher tier stops asking for it.
 *  - At most one change per `minChangeMs` (default 3 s); samples are ignored for `warmupMs` after any change or disruption
 *    (stage switch, resize, hidden tab — the renderer reports those explicitly), and a delta above `disruptionMs` (5 s: a
 *    debugger, a suspended tab) is a disruption, never a miss. Slow-but-steady frames (software GL: 0.3–2 s) count as misses.
 *
 * In this repo's sandbox only software GL exists, so frames take 0.3–3 s: the controller bottoms out at tier 0, as intended.
 */

export type Tier = 0 | 1 | 2;

export interface QualityOptions {
  startTier?: Tier;
  minTier?: Tier;
  maxTier?: Tier;
  /** Frame budget in ms (60 Hz). A frame is late when its delta exceeds `budgetMs × lateFactor`. */
  budgetMs?: number;
  lateFactor?: number;
  /** Evaluation window length in ms and the minimum samples needed to judge one. */
  windowMs?: number;
  minSamples?: number;
  /** A window is bad when this fraction of its frames were late. */
  badLateRate?: number;
  /** Consecutive bad windows needed to step down. */
  downWindows?: number;
  /** Minimum time between tier changes, and the settle time ignored after a change or disruption. */
  minChangeMs?: number;
  warmupMs?: number;
  /** Deltas above this are disruptions (hidden tab, debugger), not misses. */
  disruptionMs?: number;
  /** Probe-based step up (no GPU timer): quiet time before trying, its ceiling, and how soon a failure counts as a failed probe. */
  upDelayMs?: number;
  upDelayMaxMs?: number;
  probeWindowMs?: number;
  /** Timer-based step up: predicted GPU ms at the next tier must be ≤ this × budget, for `upWindows` clean windows in a row. */
  headroom?: number;
  upWindows?: number;
  /** Expected cost multiplier of moving from tier i to i+1 (used to predict GPU time). */
  costRatio?: readonly [number, number];
}

const DEFAULTS: Required<QualityOptions> = {
  startTier: 1,
  minTier: 0,
  maxTier: 2,
  budgetMs: 1000 / 60,
  lateFactor: 1.2,
  windowMs: 1500,
  minSamples: 3,
  badLateRate: 0.2,
  downWindows: 2,
  minChangeMs: 3000,
  warmupMs: 1500,
  disruptionMs: 5000,
  upDelayMs: 15_000,
  upDelayMaxMs: 240_000,
  probeWindowMs: 10_000,
  headroom: 0.85,
  upWindows: 4,
  costRatio: [1.6, 3.6],
};

export interface QualitySnapshot {
  tier: Tier;
  /** Late-frame rate of the last evaluated window (0..1), or 0 before the first. */
  lateRate: number;
  /** Most recent GPU ms estimate (p90 of the last window) or null. */
  gpuMs: number | null;
  /** Current quiet time (ms since the last late frame or change). */
  quietMs: number;
  upDelayMs: number;
  changes: number;
}

export class QualityController {
  private readonly o: Required<QualityOptions>;
  tier: Tier;
  private windowStart = -1;
  private late = 0;
  private total = 0;
  private gpu: number[] = [];
  private lateRate = 0;
  private gpuP90: number | null = null;
  private badStreak = 0;
  private goodStreak = 0;
  private lastChangeAt = -Infinity;
  private warmUntil = 0;
  private quietSince = 0;
  private upDelay: number;
  private lastUpAt = -Infinity;
  private changes = 0;

  constructor(opts: QualityOptions = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.tier = Math.min(this.o.maxTier, Math.max(this.o.minTier, this.o.startTier)) as Tier;
    this.upDelay = this.o.upDelayMs;
  }

  /** Something interrupted the frame stream (stage switch, resize, hidden tab): forget the window and settle. */
  disrupt(nowMs: number): void {
    this.windowStart = -1;
    this.late = 0;
    this.total = 0;
    this.gpu.length = 0;
    this.badStreak = 0;
    this.goodStreak = 0;
    this.quietSince = nowMs;
    this.warmUntil = nowMs + this.o.warmupMs;
  }

  /**
   * Feed one presented frame. `deltaMs` = time since the previous presented frame, `gpuMs` = measured GPU time for a recent frame
   * when a timer query is available. Returns the new tier when it changed, otherwise null.
   */
  sample(nowMs: number, deltaMs: number, gpuMs: number | null = null): Tier | null {
    const o = this.o;
    if (deltaMs > o.disruptionMs || !(deltaMs >= 0)) {
      this.disrupt(nowMs);
      return null;
    }
    if (nowMs < this.warmUntil) return null;
    if (this.windowStart < 0) this.windowStart = nowMs;
    this.total++;
    const isLate = deltaMs > o.budgetMs * o.lateFactor;
    if (isLate) {
      this.late++;
      this.quietSince = nowMs;
    }
    if (gpuMs !== null && gpuMs >= 0) this.gpu.push(gpuMs);
    if (nowMs - this.windowStart < o.windowMs || this.total < o.minSamples) return null;
    return this.evaluate(nowMs);
  }

  private evaluate(nowMs: number): Tier | null {
    const o = this.o;
    this.lateRate = this.late / this.total;
    if (this.gpu.length >= 5) {
      const s = [...this.gpu].sort((a, b) => a - b);
      this.gpuP90 = s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]!;
    } else {
      this.gpuP90 = null;
    }
    const bad = this.lateRate >= o.badLateRate;
    const clean = this.late === 0;
    this.windowStart = -1;
    this.late = 0;
    this.total = 0;
    this.gpu.length = 0;

    if (bad) {
      this.badStreak++;
      this.goodStreak = 0;
    } else {
      this.badStreak = 0;
      this.goodStreak = clean ? this.goodStreak + 1 : 0;
    }
    const canChange = nowMs - this.lastChangeAt >= o.minChangeMs;

    if (this.badStreak >= o.downWindows && this.tier > o.minTier && canChange) {
      if (nowMs - this.lastUpAt <= o.probeWindowMs) this.upDelay = Math.min(o.upDelayMaxMs, this.upDelay * 2); // failed probe
      return this.change(nowMs, (this.tier - 1) as Tier);
    }
    if (!clean || this.tier >= o.maxTier || !canChange) return null;

    const next = this.tier as 0 | 1;
    const predicted = this.gpuP90 === null ? null : this.gpuP90 * o.costRatio[next];
    let up = false;
    if (predicted !== null) {
      up = this.goodStreak >= o.upWindows && predicted <= o.headroom * o.budgetMs;
    } else {
      up = nowMs - this.quietSince >= this.upDelay;
    }
    if (!up) return null;
    this.lastUpAt = nowMs;
    return this.change(nowMs, (this.tier + 1) as Tier);
  }

  private change(nowMs: number, tier: Tier): Tier {
    this.tier = tier;
    this.changes++;
    this.lastChangeAt = nowMs;
    this.disrupt(nowMs);
    // A probe that survived long enough earns its way back to the base delay.
    return tier;
  }

  /** Call when a step-up has held for `probeWindowMs` without a step-down: the machine can take it, ask again sooner. */
  confirmProbe(nowMs: number): void {
    if (nowMs - this.lastUpAt >= this.o.probeWindowMs) this.upDelay = this.o.upDelayMs;
  }

  snapshot(nowMs = 0): QualitySnapshot {
    return {
      tier: this.tier,
      lateRate: this.lateRate,
      gpuMs: this.gpuP90,
      quietMs: Math.max(0, nowMs - this.quietSince),
      upDelayMs: this.upDelay,
      changes: this.changes,
    };
  }
}
