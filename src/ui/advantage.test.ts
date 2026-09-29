import { describe, expect, it } from 'vitest';
import { AdvantageTracker } from './advantage';
import { fakeFighter } from './fixtures';

const pair = (o0: Parameters<typeof fakeFighter>[0], o1: Parameters<typeof fakeFighter>[0]) =>
  [fakeFighter(o0).view, fakeFighter(o1).view] as const;

describe('AdvantageTracker', () => {
  it('reports frames of advantage when a defender enters hit-stun while the attacker is mid-move', () => {
    const t = new AdvantageTracker();
    t.update(
      pair(
        { slot: 0, titan: 'lastone', state: 'active', moveId: 'strike', moveTick: 20, moveTotal: 34 },
        { slot: 1, titan: 'asteroid' },
      ),
      100,
    );
    expect(t.last).toBeNull();
    // the foe is now in hit-stun for 22 ticks; the attacker has 14 ticks left in the move → +8 for the attacker
    t.update(
      pair(
        { slot: 0, titan: 'lastone', state: 'active', moveId: 'strike', moveTick: 20, moveTotal: 34 },
        { slot: 1, titan: 'asteroid', state: 'hitstun', hitstun: 22 },
      ),
      101,
    );
    expect(t.last).toMatchObject({ attacker: 0, kind: 'hit', advantage: 8, moveId: 'strike', tick: 101 });
  });
  it('negative advantage when the attacker recovers slower than the defender recovers from hit-stun', () => {
    const t = new AdvantageTracker();
    t.update(
      pair(
        { slot: 0, titan: 'lastone', state: 'recovery', moveId: 'crush', moveTick: 40, moveTotal: 100 },
        { slot: 1, titan: 'asteroid' },
      ),
      1,
    );
    t.update(
      pair(
        { slot: 0, titan: 'lastone', state: 'recovery', moveId: 'crush', moveTick: 40, moveTotal: 100 },
        { slot: 1, titan: 'asteroid', state: 'hitstun', hitstun: 12 },
      ),
      2,
    );
    expect(t.last!.advantage).toBe(12 - 60);
  });
  it('reports a block without a number, credited to the attacker', () => {
    const t = new AdvantageTracker();
    t.update(
      pair(
        { slot: 0, titan: 'lastone', state: 'idle' },
        { slot: 1, titan: 'asteroid', state: 'active', moveId: 'strike', moveTick: 8, moveTotal: 30 },
      ),
      1,
    );
    t.update(
      pair(
        { slot: 0, titan: 'lastone', state: 'guard' },
        { slot: 1, titan: 'asteroid', state: 'active', moveId: 'strike', moveTick: 8, moveTotal: 30 },
      ),
      2,
    );
    expect(t.last).toMatchObject({ attacker: 1, kind: 'block', advantage: null });
  });
  it('ignores hit-stun with no attacker move in progress, fires once per entry, and resets', () => {
    const t = new AdvantageTracker();
    t.update(
      pair(
        { slot: 0, titan: 'lastone', state: 'idle' },
        { slot: 1, titan: 'asteroid', state: 'hitstun', hitstun: 30 },
      ),
      1,
    );
    expect(t.last).toBeNull(); // e.g. hit by a lingering hazard
    const a = {
      slot: 0 as const,
      titan: 'lastone' as const,
      state: 'active' as const,
      moveId: 'x',
      moveTick: 1,
      moveTotal: 20,
    };
    t.update(pair(a, { slot: 1, titan: 'asteroid', state: 'idle' }), 2);
    t.update(pair(a, { slot: 1, titan: 'asteroid', state: 'hitstun', hitstun: 30 }), 3);
    const first = t.last;
    t.update(pair({ ...a, moveTick: 2 }, { slot: 1, titan: 'asteroid', state: 'hitstun', hitstun: 29 }), 4);
    expect(t.last).toBe(first);
    t.reset();
    expect(t.last).toBeNull();
  });
});
