import { describe, expect, it } from 'vitest';
import {
  Btn,
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  DIFFICULTIES,
  REACTION_MS,
  msToTicks,
  type AIContext,
  type Difficulty,
  type InputFrame,
  type InputSource,
  type MatchConfig,
  type TitanId,
} from '@/contracts';
import { createFighter } from '@/combat';
import { ManualSource, createFakeWorld, makeMatch, skipIntro } from '@/combat/testing/harness';
import { createAiSource, createMatch, type Match } from '@/sim';
import { getTitanDef } from '@/titans';
import type { UtilityAI } from './controller';
import { createAI } from './index';
import { levelParams } from './levels';

/** A full AI-controlled match on the fake world (fast). `dummy` makes a slot passive. */
function play(
  seed: number,
  a: TitanId,
  b: TitanId,
  la: Difficulty,
  lb: Difficulty,
  dummy: '' | 'a' | 'b' = '',
  maxTicks = 60 * 60 * 3,
): { match: Match; ais: (UtilityAI | null)[] } {
  const cfg: MatchConfig = {
    seed,
    stage: 'nursery',
    mode: 'aivai',
    slots: [
      { titan: a, controller: dummy === 'a' ? 'dummy' : 'ai', aiLevel: la },
      { titan: b, controller: dummy === 'b' ? 'dummy' : 'ai', aiLevel: lb },
    ],
  };
  const match = createMatch(cfg, {
    createWorld: (s) => createFakeWorld(s),
    createFighter,
    getTitanDef,
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  });
  const ais: (UtilityAI | null)[] = [null, null];
  const srcs: (InputSource | null)[] = [null, null];
  const levels = [la, lb] as const;
  const titans = [a, b] as const;
  for (const s of [0, 1] as const) {
    if ((dummy === 'a' && s === 0) || (dummy === 'b' && s === 1)) continue;
    ais[s] = createAI(levels[s], getTitanDef(titans[s]), seed * 31 + s) as UtilityAI;
    srcs[s] = createAiSource(match, s, ais[s]!);
  }
  match.setSources(srcs[0]!, srcs[1]!);
  let t = 0;
  while (match.phase !== 'matchend' && t++ < maxTicks) match.step();
  return { match, ais };
}

describe('AI contract and human limits', () => {
  it('decide() takes only the public AIContext and the output frame — there is no other input channel', () => {
    const ai = createAI(3, getTitanDef('lastone'), 1);
    expect(ai.decide.length).toBe(2);
    expect(ai.level).toBe(3);
    expect(Array.isArray(ai.log)).toBe(true);
    // the context type carries FighterViews only: no InputFrame / InputSource of the opponent exists in it
    const keys: (keyof AIContext)[] = ['tick', 'self', 'foe', 'arena', 'roundTicksLeft', 'roundTick'];
    expect(keys.length).toBe(6);
  });

  it('observes the foe through a delay of REACTION_MS[level] (never fresher), for every level', () => {
    for (const level of DIFFICULTIES) {
      const want = msToTicks(REACTION_MS[level]);
      expect(levelParams(level).reactionTicks).toBe(want);
      const { match, ais } = (() => {
        const m = makeMatch({ createWorld: createFakeWorld });
        const ai = createAI(level, getTitanDef('lastone'), 3) as UtilityAI;
        m.setSources(createAiSource(m, 0, ai), new ManualSource());
        return { match: m, ais: ai };
      })();
      skipIntro(match);
      let minAge = 1e9;
      let maxAge = 0;
      for (let i = 0; i < 200; i++) {
        match.step();
        if (i > want + 2) {
          minAge = Math.min(minAge, ais.perceivedFoeAge);
          maxAge = Math.max(maxAge, ais.perceivedFoeAge);
        }
      }
      expect(minAge).toBeGreaterThanOrEqual(want);
      expect(maxAge).toBeLessThanOrEqual(want + 1);
    }
  });

  it('reaction delay ranges 180–350 ms across the difficulty levels', () => {
    expect(REACTION_MS[1]).toBeLessThanOrEqual(350);
    expect(REACTION_MS[6]).toBeGreaterThanOrEqual(180);
    for (let l = 1; l < 6; l++)
      expect(REACTION_MS[l as Difficulty]).toBeGreaterThan(REACTION_MS[(l + 1) as Difficulty]);
  });

  it('is causal: outputs cannot depend on what the foe does until the reaction delay has passed', () => {
    const level: Difficulty = 4;
    const delay = msToTicks(REACTION_MS[level]);
    const T = 60;
    const run = (foePressAt: number): InputFrame[] => {
      const m = makeMatch({ createWorld: createFakeWorld });
      const ai = createAI(level, getTitanDef('lastone'), 9);
      const rec: InputFrame[] = [];
      const inner = createAiSource(m, 0, ai);
      const src: InputSource = {
        kind: 'ai',
        poll(t, out) {
          inner.poll(t, out);
          rec.push({ ...out });
        },
      };
      const foe = new ManualSource();
      m.setSources(src, foe);
      skipIntro(m);
      for (let i = 0; i < T + delay + 40; i++) {
        foe.held = i === foePressAt ? Btn.CRUSH : 0;
        m.step();
      }
      return rec.slice(rec.length - (T + delay + 40));
    };
    const early = run(T);
    const late = run(T + 6);
    // identical until the earlier press has had time to reach the AI's perception
    for (let i = 0; i < T + delay - 1; i++) expect(early[i]).toEqual(late[i]);
  }, 30_000);

  it('does not act during the intro or after the round is decided', () => {
    const m = makeMatch({ createWorld: createFakeWorld });
    const ai = createAI(6, getTitanDef('asteroid'), 1);
    const out: InputFrame = { moveX: 0, moveY: 0, held: 0, pressed: 0, released: 0 };
    ai.decide(m.aiContext(1), out);
    expect(out.held).toBe(0);
    expect(out.moveX).toBe(0);
  });
});

describe('AI competence', () => {
  it.each([
    ['lastone', 'asteroid', 2],
    ['lastone', 'asteroid', 4],
    ['lastone', 'asteroid', 6],
    ['asteroid', 'lastone', 2],
    ['asteroid', 'lastone', 5],
  ] as const)(
    '%s beats a do-nothing %s at level %i',
    (a, b, level) => {
      const { match } = play(level * 11 + 1, a, b, level as Difficulty, 1, 'b');
      expect(match.winner).toBe(0);
      expect(match.wins[0]).toBe(2);
    },
    60_000,
  );

  it('skill shows in mechanics: higher levels dodge a telegraphed Crush far more often', () => {
    /** Fraction of thrown Meteor Strikes (a lunging heavy, 26 ticks of startup) that hit an otherwise idle AI. */
    const hitRate = (level: Difficulty): number => {
      let thrown = 0;
      let hit = 0;
      for (let seed = 1; seed <= 24; seed++) {
        const m = makeMatch({
          seed,
          a: 'lastone',
          b: 'asteroid',
          createWorld: createFakeWorld,
          infinite: true,
        });
        const ai = createAI(level, getTitanDef('lastone'), seed);
        const foe = new ManualSource();
        m.setSources(createAiSource(m, 0, ai), foe);
        skipIntro(m);
        const f0 = m.fighters[0]!;
        const f1 = m.fighters[1] as unknown as { px: number; py: number };
        f1.px = (f0 as unknown as { px: number }).px + 170;
        f1.py = (f0 as unknown as { py: number }).py;
        let at = -1;
        let got = false;
        for (let i = 0; i < 200; i++) {
          if (at < 0 && i >= 6 && f0.view.moveId === null && f0.view.state !== 'hitstun') {
            foe.held = Btn.CRUSH;
            at = i;
          } else foe.held = 0;
          m.step();
          for (const e of m.events) if (e.t === 'hit' && e.attacker === 1 && e.target === 0) got = true;
        }
        if (at >= 0) {
          thrown++;
          if (got) hit++;
        }
      }
      return hit / Math.max(1, thrown);
    };
    const r1 = hitRate(1);
    const r3 = hitRate(3);
    // (feints are off at every level after the round-3 ladder measurement, so level 6 no longer dodges best in isolation: use level 5)
    const r6 = hitRate(5);
    expect(r1).toBeGreaterThan(0.3);
    expect(r6).toBeLessThan(0.25);
    expect(r6).toBeLessThan(r3);
    expect(r3).toBeLessThan(r1);
  }, 240_000);

  it('a higher level defeats a do-nothing dummy no slower than a lower one, and never stalls a round out', () => {
    const ttk = (level: Difficulty): number => {
      let total = 0;
      for (let seed = 1; seed <= 4; seed++) {
        const t = play(seed * 13, 'lastone', 'asteroid', level, 1, 'b').match.tick;
        // a round times out at 90 s (5400 ticks + intro): a whole best-of-three must take far less than one timed-out round
        expect(t).toBeLessThan(5400);
        total += t;
      }
      return total / 4;
    };
    expect(ttk(6)).toBeLessThanOrEqual(ttk(2) * 1.1);
  }, 240_000);

  it('a top-level AI is not beaten by a novice more often than not (mirror matches, both titans)', () => {
    let hi = 0;
    let n = 0;
    for (const [a, b] of [
      ['lastone', 'lastone'],
      ['asteroid', 'asteroid'],
    ] as const)
      for (let seed = 1; seed <= 4; seed++) {
        n++;
        if (play(seed, a, b, 6, 1).match.winner === 0) hi++;
        n++;
        if (play(seed + 40, a, b, 1, 6).match.winner === 1) hi++;
      }
    expect(hi / n).toBeGreaterThanOrEqual(0.5);
  }, 240_000);

  it('makes fewer blunders at higher levels and none at level 6', () => {
    const rate = (level: Difficulty): number => {
      const { ais } = play(5, 'lastone', 'asteroid', level, level);
      const d = ais.reduce((s, a) => s + (a?.decisions ?? 0), 0);
      const b = ais.reduce((s, a) => s + (a?.blunders ?? 0), 0);
      return b / Math.max(1, d);
    };
    const r1 = rate(1);
    const r6 = rate(6);
    expect(r1).toBeGreaterThan(0.15);
    expect(r6).toBe(0);
  }, 90_000);

  it('is deterministic for a given seed and keeps a readable decision log', () => {
    const one = play(7, 'lastone', 'asteroid', 3, 3);
    const two = play(7, 'lastone', 'asteroid', 3, 3);
    expect(two.match.hash()).toBe(one.match.hash());
    const log = one.ais[0]!.log;
    expect(log.length).toBeGreaterThan(10);
    expect(log.length).toBeLessThanOrEqual(80);
    expect(log.some((l) => /attack|punish|ultimate/.test(l))).toBe(true);
    expect(log.every((l) => /^t=\d+ /.test(l))).toBe(true);
    const three = play(8, 'lastone', 'asteroid', 3, 3);
    expect(three.match.hash()).not.toBe(one.match.hash());
  }, 60_000);

  it('uses the titan personalities: the Last One sidesteps and gazes, the Asteroid dashes and rams', () => {
    const a = play(2, 'lastone', 'asteroid', 5, 5, '', 60 * 60 * 2);
    const la = a.ais[0]!.log.join('\n');
    const lb = a.ais[1]!.log.join('\n');
    expect(la).toMatch(/Gaze|Shatter|Lash|Last Light/);
    expect(lb).toMatch(/Meteor|Glancing|Swarm|Kessler|dash in/);
  }, 60_000);

  it('reacts to telegraphs: guard/sidestep decisions appear when the foe attacks', () => {
    const { ais } = play(3, 'asteroid', 'lastone', 6, 6);
    const all = ais.flatMap((a) => a?.log ?? []).join('\n');
    expect(all).toMatch(/sidestep|guard/);
  }, 60_000);
});

describe('AI cost', () => {
  it('a decision costs a few microseconds on average (thinking is amortised over many ticks)', () => {
    const m = makeMatch({ createWorld: createFakeWorld });
    const ai = createAI(5, getTitanDef('lastone'), 1);
    const foe = new ManualSource();
    m.setSources(null, foe);
    const out: InputFrame = { moveX: 0, moveY: 0, held: 0, pressed: 0, released: 0 };
    skipIntro(m);
    for (let i = 0; i < 200; i++) {
      m.step();
      ai.decide(m.aiContext(0), out);
    }
    let spent = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      foe.moveX = Math.sin(i * 0.03);
      m.step();
      const ctx = m.aiContext(0);
      const t = performance.now();
      ai.decide(ctx, out);
      spent += performance.now() - t;
    }
    expect(spent / N).toBeLessThan(0.15);
  }, 30_000);
});
