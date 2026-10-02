import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  type FighterView,
  type MatchConfig,
  type TitanId,
} from '@/contracts';
import { createFighter } from '@/combat';
import { createFakeWorld } from '@/combat/testing/harness';
import { createAiSource, createMatch } from '@/sim';
import { getTitanDef } from '@/titans';
import type { UtilityAI } from './controller';
import { createAI } from './index';

/** The AI's own-body bookkeeping, driven directly with the few view fields it reads (proprioception only). */
interface SelfProbe {
  nowTick: number;
  regroupUntil: number;
  trackSelf(S: Pick<FighterView, 'state' | 'moveId'> & { bodyStats: { massFrac: number } }): void;
  selfCost(mi: unknown): number;
  infos: { def: { id: string } }[];
}

function feed(
  ai: SelfProbe,
  from: number,
  ticks: number,
  state: string,
  moveId: string | null,
  mass: { v: number },
  loss: number,
): number {
  for (let i = 0; i < ticks; i++) {
    ai.nowTick = from + i;
    mass.v -= loss;
    ai.trackSelf({ state: state as FighterView['state'], moveId, bodyStats: { massFrac: mass.v } });
  }
  return from + ticks;
}

describe('AI patience in orbit footwork (D28 pacing)', () => {
  it('regroups after a heavy blow, but not for a slow bleed', () => {
    const ai = createAI(3, getTitanDef('lastone'), 1, { footwork: 'orbit' }) as unknown as SelfProbe;
    const mass = { v: 1 };
    // 4 s of burning: 0.08 % a tick, 19 % in all, and no stagger
    let t = feed(ai, 1, 240, 'move', null, mass, 0.0008);
    expect(ai.regroupUntil).toBe(0);
    // a heavy blow: 7 % of the body inside a short stagger
    t = feed(ai, t, 6, 'hitstun', null, mass, 0.012);
    t = feed(ai, t, 4, 'idle', null, mass, 0);
    expect(ai.regroupUntil).toBeGreaterThan(t + 40);
  });

  it('learns which of its own moves wound it, net of its background bleed (levels that model the foe)', () => {
    const cost = (level: 2 | 3): { comet: number; slam: number } => {
      const ai = createAI(level, getTitanDef('planet'), 1, { footwork: 'orbit' }) as unknown as SelfProbe;
      const mass = { v: 1 };
      let t = 1;
      for (let k = 0; k < 3; k++) {
        t = feed(ai, t, 120, 'move', null, mass, 0.0001);
        // a comet shepherded through its own well: 0.2 % of the body a tick while charging
        t = feed(ai, t, 50, 'charge', 'planet.comet', mass, 0.002);
        t = feed(ai, t, 30, 'move', null, mass, 0.0001);
        // a moon slam that costs nothing beyond the usual bleed
        t = feed(ai, t, 40, 'active', 'planet.moonslam', mass, 0.0001);
        t = feed(ai, t, 30, 'move', null, mass, 0.0001);
      }
      const of = (id: string): number => ai.selfCost(ai.infos.find((m) => m.def.id === id));
      return { comet: of('planet.comet'), slam: of('planet.moonslam') };
    };
    const l3 = cost(3);
    expect(l3.comet).toBeGreaterThan(0.05);
    expect(l3.slam).toBeLessThan(0.002);
    const l2 = cost(2);
    expect(l2.comet).toBe(0);
  });

  it('sizes the foe up between exchanges: probes and steps off the line of a windup', () => {
    const t: [TitanId, TitanId] = ['lastone', 'planet'];
    const cfg: MatchConfig = {
      seed: 5,
      stage: 'nursery',
      mode: 'aivai',
      footwork: 'orbit',
      infinite: true,
      slots: [
        { titan: t[0], controller: 'ai', aiLevel: 4 },
        { titan: t[1], controller: 'ai', aiLevel: 4 },
      ],
    };
    const m = createMatch(cfg, {
      createWorld: (s) => createFakeWorld(s),
      createFighter,
      getTitanDef,
      arena: DEFAULT_ARENA,
      lighting: DEFAULT_LIGHTING,
    });
    const ais = [0, 1].map(
      (s) => createAI(4, getTitanDef(t[s]!), 30 + s, { footwork: 'orbit' }) as UtilityAI,
    );
    m.setSources(createAiSource(m, 0, ais[0]!), createAiSource(m, 1, ais[1]!));
    const seen = new Set<string>();
    for (let i = 0; i < 60 * 60; i++) {
      m.step();
      for (const ai of ais) {
        const p = ai.currentPlan;
        if (p === 'probe' || p === 'off the line') seen.add(p);
      }
    }
    expect(seen.has('probe')).toBe(true);
    expect(seen.has('off the line')).toBe(true);
  }, 60_000);
});
