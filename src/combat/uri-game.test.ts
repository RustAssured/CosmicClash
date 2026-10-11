import { describe, expect, it } from 'vitest';
import {
  BLOW_HITSTOP_TICKS,
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  parseScript,
  validateTitanDef,
  type MatchConfig,
  type SimEvent,
} from '@/contracts';
import { createAI } from '@/ai';
import { tuning } from '@/debug/tuning';
import { createMatterWorld } from '@/matter';
import { createAiSource, createMatch, createScriptSource, type Match } from '@/sim';
import { getTitanDef, IMPLEMENTED_TITANS } from '@/titans';
import { SLICE, TITAN_IDS } from '@/contracts';
import { createFighter } from './index';
import type { FighterImpl } from './fighter';
import type { UriBehaviour } from './behaviours/uri';
import { skipIntro } from './testing/harness';
import { makeDamageSum } from './damageSum';
import { URI_SCALE } from '@/titans/uri/rig';

/** Gate 2D: 우리 in the game (URI_SPEC §6, §10; D31-2). */

/**
 * A duel at a fixed gap: 225 reference px from 우리's root to the foe's centre, drawn at URI_SCALE (D34: 우리 about 200 px
 * tall, the Planet 121 px). Both the lead punch and the shorter rear cross land on the Planet there (measured: the cross
 * lands up to a 150 px gap and misses at 173).
 */
function duel(
  script: string,
  dx = Math.round(225 * URI_SCALE),
): { m: Match; u: FighterImpl; beh: UriBehaviour; events: SimEvent[] } {
  const cfg: MatchConfig = {
    seed: 11,
    stage: 'nursery',
    mode: 'versus',
    infinite: true,
    slots: [
      { titan: 'uri', controller: 'human' },
      { titan: 'planet', controller: 'human' },
    ],
    // D34's pace (ROUND LENGTH Short, S11), where the oracle's "3 × power a blow" holds
    pace: 2.1,
  };
  const m = createMatch(cfg, {
    createWorld: (s) => createMatterWorld(s),
    createFighter,
    getTitanDef,
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  });
  skipIntro(m);
  const u = m.fighters[0] as FighterImpl;
  const foe = m.fighters[1] as unknown as { px: number; py: number };
  foe.px = u.px + dx;
  foe.py = u.py;
  m.setSources(createScriptSource(parseScript(script), m.tick + 1), null);
  const events: SimEvent[] = [];
  return { m, u, beh: u.behaviour as unknown as UriBehaviour, events };
}

const run = (d: ReturnType<typeof duel>, ticks: number): void => {
  for (let i = 0; i < ticks; i++) {
    d.m.step();
    d.events.push(...d.m.events);
  }
};

describe('우리 in the game (Gate 2D)', () => {
  it('is on the roster: an id, a validator-clean definition with Surge and Guard declared unbound, in the slice menus', () => {
    expect(TITAN_IDS).toContain('uri');
    expect(IMPLEMENTED_TITANS).toContain('uri');
    expect(SLICE.titans).toContain('uri');
    const def = getTitanDef('uri');
    expect(validateTitanDef(def)).toEqual([]);
    expect(def.unboundSlots).toEqual(['surge', 'guard']);
    expect(def.resource.id).toBe('loop');
    // every blow says it comes from the body and where its timing comes from
    for (const m of def.moves) {
      expect(m.extra?.['bodyHits']).toBe(true);
      expect(String(m.extra?.['lockedTiming'])).toMatch(/TUNING/);
    }
  });

  it('the fist strikes with its own matter when the arm arrives: a heavy blow, one match-wide hold (not two)', () => {
    const d = duel('1:strike');
    run(d, 90);
    const hit = d.events.find((e) => e.t === 'hit' && e.attacker === 0);
    expect(hit && hit.t === 'hit' ? hit.weight : null).toBe('heavy');
    // the kinetic system's own hold (0.12 s) becomes the match's freeze; its private hold is dropped
    const stops = d.events.filter((e) => e.t === 'hitstop').map((e) => (e.t === 'hitstop' ? e.ticks : 0));
    expect(Math.max(...stops)).toBe(Math.max(BLOW_HITSTOP_TICKS.heavy, Math.round(0.12 * 60)));
    expect((d.beh as unknown as { kin: { hitstop: number } }).kin.hitstop).toBe(0);
    expect(d.m.fighters[1].view.bodyStats.massFrac).toBeLessThan(1);
  }, 60_000);

  it('the double slam lands as a catastrophic blow', () => {
    const d = duel('1:ultimate');
    (d.u as unknown as { debugSetMeter(v: number): void }).debugSetMeter(1);
    // the slam comes down below 우리: put the foe low and close
    const foe = d.m.fighters[1] as unknown as { px: number; py: number };
    foe.px = d.u.px + Math.round(40 * URI_SCALE);
    foe.py = d.u.py + Math.round(110 * URI_SCALE);
    run(d, 140);
    expect(d.events.some((e) => e.t === 'hit' && e.attacker === 0 && e.weight === 'catastrophic')).toBe(true);
  }, 60_000);

  it('a move pressed while the last blow is still committed waits, then grows out of its follow-through', () => {
    // a cross, then a strike pressed in the input buffer just before the cross's frame data ends (its arm may still be on the
    // way: the kinetic system lands on arrival)
    const d = duel('1:crush,48:strike');
    const kv = d.beh.kview;
    let crossLanded = -1;
    let punchBegan = -1;
    for (let t = 0; t < 160; t++) {
      d.m.step();
      for (const e of d.m.events) if (e.t === 'hitstop' && crossLanded < 0) crossLanded = t;
      if (kv.move === 'punch' && punchBegan < 0) punchBegan = t;
    }
    expect(crossLanded).toBeGreaterThan(0);
    expect(punchBegan).toBeGreaterThanOrEqual(crossLanded);
  }, 60_000);

  it('the loop is the health: the HUD reads it and the fighter goes down when it is empty (proposal 176)', () => {
    const d = duel('');
    const kin = (d.beh as unknown as { kin: { hp: number } }).kin;
    kin.hp = 37;
    run(d, 1);
    expect(d.u.view.integrityPct).toBe(37);
    expect(d.u.view.ko).toBe(false);
    kin.hp = 0;
    run(d, 1);
    expect(d.u.view.ko).toBe(true);
  }, 60_000);

  it('the loop pays once per blow, not once per hit volume (a sweep of several blades is one blow)', () => {
    const d = duel('');
    const kin = (d.beh as unknown as { kin: { hp: number } }).kin;
    const u = d.u;
    // three volumes of one move land on three parts in one tick
    const inc = u as unknown as { incomingMoveId: string };
    inc.incomingMoveId = 'planet.impact';
    const hitAt = (x: number, y: number): void => {
      d.beh.routeDamage(
        {
          type: 'KINETIC',
          shape: { kind: 'point', x, y, r: 3 },
          energy: 400,
          dirX: 1,
          dirY: 0,
          duration: 1,
          sourceMass: 4,
          sourceBodyId: -1,
          originX: x,
          originY: y,
          flags: 0,
          params: {},
          weight: 'heavy',
        },
        makeDamageSum(),
      );
    };
    const b = u.liveBounds();
    const cy = (b.y0 + b.y1) / 2;
    hitAt(b.x0 + (b.x1 - b.x0) * 0.3, cy);
    hitAt(b.x0 + (b.x1 - b.x0) * 0.5, cy);
    hitAt(b.x0 + (b.x1 - b.x0) * 0.7, cy);
    expect(kin.hp).toBeCloseTo(100 - 3 * 2.2, 5);
    // another move's blow costs again
    inc.incomingMoveId = 'planet.moonslam';
    hitAt(b.x0 + (b.x1 - b.x0) * 0.4, cy);
    expect(kin.hp).toBeCloseTo(100 - 2 * 3 * 2.2, 5);
  }, 60_000);

  it('the provisional knobs are on the debug overlay, marked to be tuned', () => {
    duel('');
    const labels = tuning.list().map((e) => e.knob.label);
    expect(labels.some((l) => /POWER.*TUNE/.test(l))).toBe(true);
    expect(labels.some((l) => /TICKS\/HIT.*TUNE/.test(l))).toBe(true);
  }, 60_000);

  it("its AI throws the blow the kinetic system's best-move rule names, and lands it", () => {
    const cfg: MatchConfig = {
      seed: 5,
      stage: 'nursery',
      mode: 'aivai',
      footwork: 'orbit',
      infinite: true,
      slots: [
        { titan: 'uri', controller: 'ai', aiLevel: 4 },
        { titan: 'planet', controller: 'dummy' },
      ],
    };
    const m = createMatch(cfg, {
      createWorld: (s) => createMatterWorld(s),
      createFighter,
      getTitanDef,
      arena: DEFAULT_ARENA,
      lighting: DEFAULT_LIGHTING,
    });
    m.setSources(createAiSource(m, 0, createAI(4, getTitanDef('uri'), 3, { footwork: 'orbit' })), null);
    const moves = new Set<string>();
    let hits = 0;
    // (D34: at the game's scale the knocked-back Planet ends further from 우리's shorter reach; the AI's orbit pacing needs
    // about 40 s for a few blows: measured 4 hits by 32 s, 6 by 45 s with seed 5)
    for (let t = 0; t < 60 * 40; t++) {
      m.step();
      for (const e of m.events) {
        if (e.t === 'move' && e.slot === 0) moves.add(e.moveId);
        if (e.t === 'hit' && e.attacker === 0) hits++;
      }
    }
    // a level foe: the punch and the cross in turn
    expect(moves.has('uri.punch')).toBe(true);
    expect(moves.has('uri.cross')).toBe(true);
    expect(hits).toBeGreaterThan(2);
  }, 120_000);
});
