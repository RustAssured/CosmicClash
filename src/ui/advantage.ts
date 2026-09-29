import type { FighterView } from '@/contracts';

/**
 * Frame advantage from the last exchange, derived only from public FighterViews (no event bus needed).
 *
 * When the defender first enters hit-stun, advantage = (defender's remaining hit-stun) − (attacker's remaining ticks in their
 * own move). Positive = the attacker recovers first (plus on hit). A block has no exposed block-stun value in `FighterView`,
 * so a block is reported without a number. The figure is ±1 tick because the UI samples once per rendered frame.
 */
export interface ExchangeReport {
  /** Slot that attacked. */
  attacker: 0 | 1;
  kind: 'hit' | 'block';
  /** Frames of advantage for the attacker (hit only). */
  advantage: number | null;
  moveId: string | null;
  /** Tick (match) when it was observed. */
  tick: number;
}

export class AdvantageTracker {
  last: ExchangeReport | null = null;
  private prevState: [string, string] = ['idle', 'idle'];

  reset(): void {
    this.last = null;
    this.prevState = ['idle', 'idle'];
  }

  update(views: readonly [FighterView, FighterView], tick: number): void {
    for (const d of [0, 1] as const) {
      const a = (1 - d) as 0 | 1;
      const now = views[d].state;
      const before = this.prevState[d];
      const entered = (now === 'hitstun' && before !== 'hitstun') || (now === 'guard' && before !== 'guard');
      if (entered) {
        const att = views[a];
        const attackerBusy = att.moveId !== null && att.state !== 'idle' && att.state !== 'move';
        if (attackerBusy) {
          if (now === 'hitstun') {
            const remaining = Math.max(0, att.moveTotal - att.moveTick);
            this.last = {
              attacker: a,
              kind: 'hit',
              advantage: views[d].hitstunTicks - remaining,
              moveId: att.moveId,
              tick,
            };
          } else {
            this.last = { attacker: a, kind: 'block', advantage: null, moveId: att.moveId, tick };
          }
        }
      }
      this.prevState[d] = now;
    }
  }
}
