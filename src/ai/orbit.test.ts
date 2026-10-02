import { describe, expect, it } from 'vitest';
import { DEFAULT_ARENA, DEFAULT_LIGHTING, type MatchConfig, type TitanId } from '@/contracts';
import { createFighter } from '@/combat';
import { createFakeWorld } from '@/combat/testing/harness';
import { createAiSource, createMatch } from '@/sim';
import { getTitanDef } from '@/titans';
import type { UtilityAI } from './controller';
import { createAI } from './index';

/** An AI (slot 0) against a do-nothing dummy, orbit footwork, fake world. */
function vsDummy(
  titan: TitanId,
  foe: TitanId,
  seed: number,
  ticks: number,
  tell: boolean,
): {
  hits: number;
  dist2d: number[];
  stickY: number;
  ai: UtilityAI;
} {
  const cfg: MatchConfig = {
    seed,
    stage: 'nursery',
    mode: 'aivai',
    footwork: 'orbit',
    slots: [
      { titan, controller: 'ai', aiLevel: 4 },
      { titan: foe, controller: 'dummy' },
    ],
  };
  const m = createMatch(cfg, {
    createWorld: (s) => createFakeWorld(s),
    createFighter,
    getTitanDef,
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  });
  const ai = createAI(4, getTitanDef(titan), seed, tell ? { footwork: 'orbit' } : {}) as UtilityAI;
  const src = createAiSource(m, 0, ai);
  let stickY = 0;
  m.setSources(
    {
      kind: 'ai',
      poll(tick, out) {
        src.poll(tick, out);
        stickY += Math.abs(out.moveY);
      },
    },
    null,
  );
  let hits = 0;
  const dist2d: number[] = [];
  for (let t = 0; t < ticks && m.phase !== 'matchend'; t++) {
    m.step();
    for (const e of m.events) if (e.t === 'hit' && e.attacker === 0) hits++;
    const a = m.fighters[0].view;
    const b = m.fighters[1].view;
    dist2d.push(Math.hypot(a.x - b.x, a.y - b.y));
  }
  return { hits, dist2d, stickY, ai };
}

describe('AI with orbital footwork (minimal 2-D spacing)', () => {
  for (const [who, foe] of [
    ['lastone', 'planet'],
    ['planet', 'lastone'],
  ] as const) {
    it(`${who} closes in the plane and lands blows on an idle ${foe}, using the vertical stick`, () => {
      const r = vsDummy(who, foe, 11, 60 * 20, true);
      expect(r.hits).toBeGreaterThan(2);
      expect(Math.min(...r.dist2d)).toBeLessThan(260);
      expect(r.stickY).toBeGreaterThan(10);
    }, 60_000);
  }

  it('paces like colossi (D28): between its own attacks it breathes, so moves per minute stay low', () => {
    const cfg: MatchConfig = {
      seed: 21,
      stage: 'nursery',
      mode: 'aivai',
      footwork: 'orbit',
      infinite: true,
      slots: [
        { titan: 'lastone', controller: 'ai', aiLevel: 3 },
        { titan: 'planet', controller: 'ai', aiLevel: 3 },
      ],
    };
    const m = createMatch(cfg, {
      createWorld: (s) => createFakeWorld(s),
      createFighter,
      getTitanDef,
      arena: DEFAULT_ARENA,
      lighting: DEFAULT_LIGHTING,
    });
    m.setSources(
      createAiSource(m, 0, createAI(3, getTitanDef('lastone'), 1, { footwork: 'orbit' })),
      createAiSource(m, 1, createAI(3, getTitanDef('planet'), 2, { footwork: 'orbit' })),
    );
    let attacks = 0;
    const T = 60 * 60;
    for (let t = 0; t < T; t++) {
      m.step();
      for (const e of m.events)
        if (
          e.t === 'move' &&
          (e.moveSlot === 'strike' || e.moveSlot === 'crush' || e.moveSlot === 'signature')
        )
          attacks++;
    }
    // two fighters, an ~8 s breath each (punishes may cut it in half): well under the ~25 contacts a minute of Gate B
    expect(attacks).toBeGreaterThan(4);
    expect(attacks).toBeLessThan(22);
  }, 60_000);

  it('latches orbit footwork from its own view when nobody told it', () => {
    const r = vsDummy('lastone', 'planet', 5, 60 * 12, false);
    expect(r.hits).toBeGreaterThan(0);
    expect((r.ai as unknown as { orbit: boolean }).orbit).toBe(true);
  }, 60_000);
});
