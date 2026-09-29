/**
 * n-gram model of the opponent's habits. Tokens are coarse actions the AI can see (attack slots, guard, surge, approach, retreat,
 * idle); the model learns P(next | last two tokens) with exponential forgetting, so it adapts as the player changes style.
 * It only ever consumes tokens the AI observed (after its reaction delay): it predicts habits, it does not read inputs.
 */
export const TOKENS = ['idle', 'approach', 'retreat', 'strike', 'crush', 'surge', 'signature', 'ultimate', 'guard', 'hurt'] as const;
export type Token = (typeof TOKENS)[number];
export const TOKEN_COUNT = TOKENS.length;
const IDX: Record<string, number> = Object.fromEntries(TOKENS.map((t, i) => [t, i]));

export class NGram {
  /** counts[ctx2][ctx1][next] */
  private readonly c2 = new Float32Array(TOKEN_COUNT * TOKEN_COUNT * TOKEN_COUNT);
  private readonly c1 = new Float32Array(TOKEN_COUNT * TOKEN_COUNT);
  private readonly c0 = new Float32Array(TOKEN_COUNT);
  private p1 = 0;
  private p2 = 0;
  readonly dist = new Float32Array(TOKEN_COUNT);

  reset(): void {
    this.c2.fill(0);
    this.c1.fill(0);
    this.c0.fill(0);
    this.p1 = 0;
    this.p2 = 0;
  }

  /** Observe the foe starting `token` (call only on changes). */
  observe(token: Token): void {
    const t = IDX[token]!;
    const decay = 0.985;
    for (let i = 0; i < TOKEN_COUNT; i++) {
      this.c2[(this.p2 * TOKEN_COUNT + this.p1) * TOKEN_COUNT + i]! *= decay;
      this.c1[this.p1 * TOKEN_COUNT + i]! *= decay;
      this.c0[i]! *= decay;
    }
    this.c2[(this.p2 * TOKEN_COUNT + this.p1) * TOKEN_COUNT + t]! += 1;
    this.c1[this.p1 * TOKEN_COUNT + t]! += 1;
    this.c0[t]! += 1;
    this.p2 = this.p1;
    this.p1 = t;
  }

  /** Fills `dist` with the predicted next-token distribution (backing off from trigram to bigram to unigram). */
  predict(): Float32Array {
    const d = this.dist;
    let sum = 0;
    for (let i = 0; i < TOKEN_COUNT; i++) {
      const a = this.c2[(this.p2 * TOKEN_COUNT + this.p1) * TOKEN_COUNT + i]!;
      const b = this.c1[this.p1 * TOKEN_COUNT + i]!;
      const c = this.c0[i]!;
      const v = a * 1 + b * 0.35 + c * 0.08 + 0.02;
      d[i] = v;
      sum += v;
    }
    for (let i = 0; i < TOKEN_COUNT; i++) d[i]! /= sum;
    return d;
  }

  prob(token: Token): number {
    return this.dist[IDX[token]!]!;
  }

  /** Total observations (with decay), to know whether the model has anything to say yet. */
  get weight(): number {
    let s = 0;
    for (let i = 0; i < TOKEN_COUNT; i++) s += this.c0[i]!;
    return s;
  }
}
