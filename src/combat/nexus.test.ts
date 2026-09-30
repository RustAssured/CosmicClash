import { describe, expect, it } from 'vitest';
import { DEFAULT_LIGHTING, parseScript, validateTitanDef, type DamageEvent } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { generateTitanBody, getTitanDef, groupNexusCells } from '@/titans';
import type { NexusBehaviour } from './behaviours/nexus';
import type { FighterImpl } from './fighter';
import { createScriptSource, makeMatch, skipIntro } from './testing/harness';

function duel(script: string, gap: number, foe: 'asteroid' | 'lastone' = 'asteroid') {
  const m = makeMatch({ a: 'nexus', b: foe, seed: 5, createWorld: (s) => createMatterWorld(s) });
  skipIntro(m);
  const a = m.fighters[0] as FighterImpl;
  const b = m.fighters[1] as FighterImpl;
  b.px = a.px + gap;
  b.py = a.py;
  a.meter = 1;
  m.setSources(createScriptSource(parseScript(script), m.tick + 1), createScriptSource([], m.tick + 1));
  return { m, a, b, beh: a.behaviour as NexusBehaviour };
}

describe('the Nexus', () => {
  it('has valid data and a body of 90-180 px whose graph is wired as authored', () => {
    const def = getTitanDef('nexus');
    expect(validateTitanDef(def)).toEqual([]);
    const g = generateTitanBody(def, 3, DEFAULT_LIGHTING);
    const groups = groupNexusCells(g.map, g.rig as never);
    expect(groups.nodeCells.length).toBe(13);
    expect(groups.edgeCells.length).toBe(28);
    for (const c of [...groups.nodeCells, ...groups.edgeCells]) expect(c.length).toBeGreaterThan(20);
  });

  it('Latch infects and Harvest tears lattice out and grows the graph', () => {
    const { m, b, beh } = duel('4:strike,60:sig*40', 150);
    for (let i = 0; i < 380; i++) m.step();
    expect(b.view.bodyStats.infectedCells).toBeGreaterThan(500);
    expect(b.view.bodyStats.massFrac).toBeLessThan(0.995);
    expect(beh.grown).toBeGreaterThan(0);
  });

  it('a cut chain puts the far side of the graph out: nodes go dark, parts drop', () => {
    const { m, a, beh } = duel('', 300);
    m.step();
    const t = a.body.transform;
    const rig = (
      a as unknown as {
        rig: { nodes: { x: number; y: number }[]; edges: { a: number; b: number; pts: number[] }[] };
      }
    ).rig;
    // sever the spoke from the hub to inner node 1 and the ring edges around it: cut every chain touching node 1
    const cut = rig.edges.filter((e) => e.a === 1 || e.b === 1);
    for (const e of cut) {
      const i = Math.floor(e.pts.length / 4) * 2;
      const wx = t.x + (e.pts[i]! - a.body.map.coreX) * t.facing;
      const wy = t.y + (e.pts[i + 1]! - a.body.map.coreY);
      const ev: DamageEvent = {
        type: 'KINETIC',
        shape: { kind: 'point', x: wx, y: wy, r: 7 },
        energy: 900,
        dirX: 1,
        dirY: 0,
        duration: 1,
        sourceMass: 5,
        sourceBodyId: -1,
        originX: wx,
        originY: wy,
        flags: 0,
        params: { crater: 7 },
      };
      m.world.applyDamage(a.body.id, ev);
      (a as unknown as { behaviour: NexusBehaviour }).behaviour.onDamaged(900, 1, 0);
    }
    expect(beh.nodeLit(1)).toBe(false);
    expect(beh.litNodes).toBeLessThan(12);
    expect(a.view.parts).toBeLessThan(12);
  });

  it('Constrict roots the foe (a time-limited speed multiplier) until it is hurt hard enough', () => {
    const { m, b, beh } = duel('4:crush', 130);
    let rooted = false;
    for (let i = 0; i < 120; i++) {
      m.step();
      if (beh.rooted) rooted = true;
    }
    expect(rooted).toBe(true);
    expect(b.statusMul).toBeLessThan(1);
  });

  it('Ingesloten Oog builds a cage and crushes a foe that stays inside', () => {
    const { m, b, beh } = duel('4:ult', 200);
    let cage = false;
    for (let i = 0; i < 330; i++) {
      m.step();
      if (beh.cageActive) cage = true;
    }
    expect(cage).toBe(true);
    expect(b.view.bodyStats.massFrac).toBeLessThan(0.95);
  });

  it('a scripted duel on the real world is deterministic', () => {
    const run = (): number => {
      const { m } = duel('4:strike,40:crush,120:sig*30,200:ult', 140);
      for (let i = 0; i < 420; i++) m.step();
      return m.hash();
    };
    expect(run()).toBe(run());
  });
});
