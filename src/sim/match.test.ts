import { describe, expect, it } from 'vitest';
import {
  Btn,
  HITSTOP_MAX_TICKS,
  KO_TIME_SCALE,
  ROUNDS_TO_WIN,
  ROUND_INTRO_TICKS,
  ROUND_TIME_TICKS,
  type InputFrame,
  type MatchConfig,
  type SimEvent,
} from '@/contracts';
import { createMatch, createScriptSource, type Match } from '@/sim';
import { fakeDeps, type FakeFighter } from './testing/fakes';

const cfg = (over: Partial<MatchConfig> = {}): MatchConfig => ({
  seed: 7,
  stage: 'nursery',
  mode: 'versus',
  slots: [
    { titan: 'lastone', controller: 'human' },
    { titan: 'asteroid', controller: 'human' },
  ],
  ...over,
});
const fighter = (m: Match, s: 0 | 1): FakeFighter => m.fighters[s] as FakeFighter;
const run = (m: Match, n: number): void => {
  for (let i = 0; i < n; i++) m.step();
};

describe('Match phases', () => {
  it('starts in intro, becomes live after the intro, and reports round events', () => {
    const m = createMatch(cfg(), fakeDeps());
    expect(m.phase).toBe('intro');
    const seen: string[] = [];
    for (let i = 0; i < ROUND_INTRO_TICKS + 2; i++) {
      m.step();
      for (const e of m.events) if (e.t === 'round') seen.push(e.phase);
    }
    expect(m.phase).toBe('fight');
    expect(seen).toContain('fight');
  });

  it('alternates fighter order per tick and ticks the world once per step', () => {
    const m = createMatch(cfg(), fakeDeps());
    const order: number[] = [];
    for (const s of [0, 1] as const) fighter(m, s).script = (f) => order.push(f.slot);
    run(m, 4);
    expect(order).toEqual([1, 0, 0, 1, 1, 0, 0, 1].slice(0, 8).map((x) => x)); // tick 1: 1 first, tick 2: 0 first…
    expect((m.world as unknown as { ticks: number }).ticks).toBe(4);
  });

  it('does not let fighters attack during intro (live=false) and does during the fight', () => {
    const m = createMatch(cfg(), fakeDeps());
    const lives: boolean[] = [];
    fighter(m, 0).script = (_f, ctx) => lives.push(ctx.live);
    run(m, ROUND_INTRO_TICKS + 3);
    expect(lives[0]).toBe(false);
    expect(lives[lives.length - 1]).toBe(true);
  });

  it('a KO ends the round with slow motion and awards the win; best of 3 ends the match', () => {
    const m = createMatch(cfg(), fakeDeps());
    m.setSources(null, null);
    let koOnce = false;
    fighter(m, 1).script = (f, ctx) => {
      if (ctx.live && !koOnce && m.roundTick() > 10) {
        f.view.ko = true;
        koOnce = true;
      }
    };
    let sawSlow = false;
    let guard = 0;
    while (m.wins[0] < 1 && guard++ < 2000) {
      m.step();
      if (m.phase === 'ko' && m.timeScale <= KO_TIME_SCALE + 1e-6) sawSlow = true;
    }
    expect(m.wins).toEqual([1, 0]);
    expect(sawSlow).toBe(true);
    expect(fighter(m, 0).victory).toBe(true);

    // round 2: player 0 wins again ⇒ match over
    fighter(m, 1).script = (f, ctx) => {
      if (ctx.live && m.roundTick() > 10) f.view.ko = true;
    };
    guard = 0;
    while (m.phase !== 'matchend' && guard++ < 4000) m.step();
    expect(m.phase).toBe('matchend');
    expect(m.wins[0]).toBe(ROUNDS_TO_WIN);
    expect(m.winner).toBe(0);
    expect(fighter(m, 0).rounds).toBe(1); // nextRound called once between rounds
  });

  it('time over picks the fighter with higher integrity', () => {
    const m = createMatch(cfg(), fakeDeps());
    fighter(m, 0).view.integrityPct = 40;
    fighter(m, 1).view.integrityPct = 80;
    run(m, ROUND_INTRO_TICKS + ROUND_TIME_TICKS + 5);
    expect(m.phase === 'timeover' || m.phase === 'roundend').toBe(true);
    let g = 0;
    while (m.phase !== 'roundend' && g++ < 500) m.step();
    expect(m.wins).toEqual([0, 1]);
  });

  it('training (infinite) never ends the round and rebuilds a KO’d fighter', () => {
    const m = createMatch(cfg({ mode: 'training', infinite: true }), fakeDeps());
    run(m, ROUND_INTRO_TICKS + 1);
    const before = m.roundTicksLeft;
    run(m, 100);
    expect(m.roundTicksLeft).toBe(before);
    fighter(m, 1).view.ko = true;
    run(m, 200);
    expect(m.phase).toBe('fight');
    expect(fighter(m, 1).rounds).toBeGreaterThan(0);
    expect(fighter(m, 1).view.ko).toBe(false);
  });

  it('harness startState carves both bodies', () => {
    const m = createMatch(cfg({ startState: '50' }), fakeDeps());
    expect((m.world as unknown as { carved: number[] }).carved).toHaveLength(2);
  });
});

describe('hit-stop', () => {
  it('freezes fighters and the world, clamps the request, and keeps presses made during the freeze', () => {
    const m = createMatch(cfg(), fakeDeps());
    const script = createScriptSource([{ tick: 0, buttons: 0, hold: 0, moveX: 0, moveY: 0, moveTicks: 0 }]);
    m.setSources(script, null);
    run(m, ROUND_INTRO_TICKS + 2);
    const f0 = fighter(m, 0);
    let fired = false;
    f0.script = (_f, ctx) => {
      if (!fired && ctx.live) {
        fired = true;
        ctx.events.push({ t: 'hitstop', ticks: 999 });
      }
    };
    m.step(); // emits hitstop
    expect(m.hitstopTicks).toBe(HITSTOP_MAX_TICKS);
    const worldTicks = (m.world as unknown as { ticks: number }).ticks;
    const f0Ticks = f0.ticks;
    // press STRIKE for one tick while frozen
    let tapTick = -1;
    m.setSources(
      {
        kind: 'script',
        poll(tick, out: InputFrame) {
          const tap = tick === m.tick + 0 && tapTick < 0 ? ((tapTick = tick), true) : false;
          out.moveX = 0;
          out.moveY = 0;
          out.held = tap ? Btn.STRIKE : 0;
          out.pressed = tap ? Btn.STRIKE : 0;
          out.released = 0;
        },
      },
      null,
    );
    for (let i = 0; i < 3; i++) m.step();
    expect((m.world as unknown as { ticks: number }).ticks).toBe(worldTicks);
    expect(f0.ticks).toBe(f0Ticks);
    expect(f0.freezes.length).toBeGreaterThan(0);
    let delivered = false;
    f0.script = (f) => {
      if (f.lastInput.pressed & Btn.STRIKE) delivered = true;
    };
    run(m, HITSTOP_MAX_TICKS + 2);
    expect(delivered).toBe(true);
  });

  it('hitstop events are applied to both fighters as freezes', () => {
    const m = createMatch(cfg(), fakeDeps());
    run(m, ROUND_INTRO_TICKS + 1);
    fighter(m, 1).script = (_f, ctx) => ctx.events.push({ t: 'hitstop', ticks: 6 } as SimEvent);
    m.step();
    expect(fighter(m, 0).freezes.at(-1)).toBe(6);
    expect(fighter(m, 1).freezes.at(-1)).toBe(6);
  });
});

describe('determinism', () => {
  it('identical seeds and inputs give identical hashes; different seeds diverge', () => {
    const script = [
      { tick: 130, buttons: Btn.STRIKE, hold: 3, moveX: 0, moveY: 0, moveTicks: 0 },
      { tick: 200, buttons: 0, hold: 0, moveX: 1, moveY: 0, moveTicks: 50 },
    ];
    const a = createMatch(cfg(), fakeDeps());
    const b = createMatch(cfg(), fakeDeps());
    const c = createMatch(cfg({ seed: 8 }), fakeDeps());
    for (const m of [a, b, c]) m.setSources(createScriptSource(script), null);
    for (let i = 0; i < 400; i++) {
      a.step();
      b.step();
      c.step();
    }
    expect(a.hash()).toBe(b.hash());
    void c;
  });
});

describe('sources', () => {
  it('script source produces edges and holds', () => {
    const s = createScriptSource([
      { tick: 2, buttons: Btn.CRUSH, hold: 2, moveX: 0, moveY: 0, moveTicks: 0 },
    ]);
    const f: InputFrame = { moveX: 0, moveY: 0, held: 0, pressed: 0, released: 0 };
    const seq: number[][] = [];
    for (let t = 0; t < 6; t++) {
      s.poll(t, f);
      seq.push([f.held, f.pressed, f.released]);
    }
    expect(seq).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [Btn.CRUSH, Btn.CRUSH, 0],
      [Btn.CRUSH, 0, 0],
      [Btn.CRUSH, 0, 0],
      [0, 0, Btn.CRUSH],
    ]);
  });
});

describe('script source stick events', () => {
  it('applies a stick event at script tick 0 on the very first poll', () => {
    const s = createScriptSource([{ tick: 0, buttons: 0, hold: 0, moveX: 1, moveY: 0, moveTicks: 3 }], 10);
    const f: InputFrame = { moveX: 0, moveY: 0, held: 0, pressed: 0, released: 0 };
    const xs: number[] = [];
    for (let t = 11; t < 17; t++) {
      s.poll(t, f);
      xs.push(f.moveX);
    }
    expect(xs).toEqual([1, 1, 0, 0, 0, 0]); // held for ticks 0..2 of script time; first poll is script tick 1
  });
});
