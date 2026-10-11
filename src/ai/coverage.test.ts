import { describe, expect, it } from 'vitest';
import {
  Btn,
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  type InputSource,
  type MatchConfig,
  type MoveDef,
  type TitanDef,
} from '@/contracts';
import { createFighter } from '@/combat';
import { createFakeWorld } from '@/combat/testing/harness';
import { createAiSource, createMatch } from '@/sim';
import { getTitanDef } from '@/titans';
import { createAI } from './index';
import { buildMoveInfos } from './moves';

describe('AI move coverage (every move of the slice titans is in the model)', () => {
  it('models the colossus (The Last One, D36) kit moves that have no JSON hitboxes (Halo Shards, Sweeping Architecture, Revelation)', () => {
    const infos = buildMoveInfos(getTitanDef('colossus'));
    for (const id of ['colossus.halo', 'colossus.sweep', 'colossus.revelation', 'colossus.gaze']) {
      const mine = infos.filter((m) => m.def.id === id);
      expect(mine.length).toBe(3);
      for (const mi of mine) {
        expect(mi.hasHitboxes, `${id} ${mi.aim}`).toBe(true);
        expect(mi.x1).toBeGreaterThan(80);
        expect(mi.energy).toBeGreaterThan(0);
        expect(mi.hitTo).toBeGreaterThan(mi.hitFrom);
      }
    }
    // the beam fan is judged along its axis
    expect(infos.find((m) => m.def.id === 'colossus.revelation')!.line).not.toBeNull();
  });

  it('models every blow of the returning Witness (id lastone, D36): lash, lunge, shatter, gaze and the Last Light', () => {
    const infos = buildMoveInfos(getTitanDef('lastone'));
    for (const id of [
      'lastone.lash',
      'lastone.lunge',
      'lastone.shatter',
      'lastone.gaze',
      'lastone.lastlight',
    ]) {
      const mine = infos.filter((m) => m.def.id === id);
      expect(mine.length, id).toBe(3);
      for (const mi of mine) {
        expect(mi.hasHitboxes, `${id} ${mi.aim}`).toBe(true);
        expect(mi.energy).toBeGreaterThan(0);
        expect(mi.hitTo).toBeGreaterThan(mi.hitFrom);
      }
    }
  });

  it("reads a move's own `extra.aiReach` before any stand-in (proposal 167)", () => {
    const base = getTitanDef('colossus');
    const moves: MoveDef[] = base.moves.map((m) =>
      m.id === 'colossus.halo'
        ? {
            ...m,
            extra: { ...m.extra, aiReach: { x0: 0, y0: -10, x1: 333, y1: 10, from: 1, to: 5, energy: 77 } },
          }
        : m,
    );
    const def: TitanDef = { ...base, moves };
    const halo = buildMoveInfos(def).find((m) => m.def.id === 'colossus.halo')!;
    expect(halo.x1).toBe(333);
    expect(halo.energy).toBe(77);
  });

  it('the Planet uses Tidal Draw (R1) once there is wreckage about; a titan without a well never does', () => {
    const cfg: MatchConfig = {
      seed: 9,
      stage: 'nursery',
      mode: 'aivai',
      footwork: 'orbit',
      infinite: true,
      slots: [
        { titan: 'planet', controller: 'ai', aiLevel: 4 },
        { titan: 'lastone', controller: 'ai', aiLevel: 4 },
      ],
    };
    const m = createMatch(cfg, {
      createWorld: (s) => createFakeWorld(s),
      createFighter,
      getTitanDef,
      arena: DEFAULT_ARENA,
      lighting: DEFAULT_LIGHTING,
    });
    const held = [0, 0];
    const wrap = (s: 0 | 1, src: InputSource): InputSource => ({
      kind: src.kind,
      poll(tick, out) {
        src.poll(tick, out);
        if (out.held & Btn.GRAVITY) held[s]!++;
      },
    });
    m.setSources(
      wrap(0, createAiSource(m, 0, createAI(4, getTitanDef('planet'), 3, { footwork: 'orbit' }))),
      wrap(1, createAiSource(m, 1, createAI(4, getTitanDef('lastone'), 4, { footwork: 'orbit' }))),
    );
    // a fight already under way: both bodies have shed a fifth of their matter (wreckage drifts about)
    const w = m.world as unknown as { carve(id: number, frac: number, seed: number): void };
    for (const f of m.fighters) w.carve(f.view.body.id, 0.8, 7);
    for (let i = 0; i < 60 * 60; i++) m.step();
    // it draws (R1 held for at least a third of a second); how long depends on the balance knobs, not on the plan existing
    expect(held[0]).toBeGreaterThan(20);
    expect(held[1]).toBe(0);
  }, 90_000);
});
