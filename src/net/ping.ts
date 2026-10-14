/** Round-trip statistics from the input lane's pings: median RTT and the jitter (p95 of the deviation from it). */
export class RttStats {
  private readonly samples: number[] = [];
  last: number | null = null;

  constructor(private readonly keep = 40) {}

  add(rttMs: number): void {
    if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > 10_000) return;
    this.last = rttMs;
    this.samples.push(rttMs);
    if (this.samples.length > this.keep) this.samples.shift();
  }

  get count(): number {
    return this.samples.length;
  }

  /** Median RTT in ms, or null with fewer than 5 samples (too few to choose a delay from). */
  get rtt(): number | null {
    if (this.samples.length < 5) return null;
    return quantile(this.samples, 0.5);
  }

  /** p95 of |sample − median| in ms (0 with too few samples). */
  get jitter(): number {
    const m = this.rtt;
    if (m === null) return 0;
    return quantile(
      this.samples.map((s) => Math.abs(s - m)),
      0.95,
    );
  }

  clear(): void {
    this.samples.length = 0;
    this.last = null;
  }
}

function quantile(a: readonly number[], q: number): number {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}
