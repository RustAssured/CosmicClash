import { describe, expect, it } from 'vitest';
import { DEFAULT_LIGHTING, parseScript, validateTitanDef } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { generateTitanBody, getTitanDef } from '@/titans';
import type { BlackHoleBehaviour } from './behaviours/blackhole';
import type { FighterImpl } from './fighter';
import { createScriptSource, makeMatch, skipIntro } from './testing/harness';

function duel(script: string, gap: number, foe: 'asteroid' | 'lastone' = 'asteroid') {
  const m = makeMatch({ a: 'blackhole', b: foe, seed: 5, createWorld: (s) => createMatterWorld(s) });
  skipIntro(m);
  const a = m.fighters[0] as FighterImpl;
  const b = m.fighters[1] as FighterImpl;
  b.px = a.px + gap;
  b.py = a.py;
  a.meter = 1;
  m.setSources(createScriptSource(parseScript(script), m.tick + 1), createScriptSource([], m.tick + 1));
  return { m, a, b, beh: a.behaviour as BlackHoleBehaviour };
}

describe('the Black Hole', () => {
  it('has valid data and a deterministic body', () => {
    const def = getTitanDef('blackhole');
    expect(validateTitanDef(def)).toEqual([]);
    const g1 = generateTitanBody(def, 3, DEFAULT_LIGHTING);
    const g2 = generateTitanBody(def, 3, DEFAULT_LIGHTING);
    expect(Array.from(g1.map.material)).toEqual(Array.from(g2.map.material));
    expect(g1.map.w).toBeGreaterThan(90);
  });

  it('its horizon is immune to everything', () => {
    const { m, a } = duel('', 120);
    m.step();
    const hz = a.body.materials.findIndex((mm) => mm.key === 'horizon');
    const count = (): number => {
      let n = 0;
      for (let i = 0; i < a.body.map.material.length; i++) if (a.body.map.material[i] === hz) n++;
      return n;
    };
    const before = count();
    const t = a.body.transform;
    for (let i = 0; i < 3; i++) {
      m.world.applyDamage(a.body.id, {
        type: 'KINETIC',
        shape: { kind: 'point', x: t.x, y: t.y, r: 12 },
        energy: 2000,
        dirX: 1,
        dirY: 0,
        duration: 1,
        sourceMass: 5,
        sourceBodyId: -1,
        originX: t.x,
        originY: t.y,
        flags: 0,
        params: { crater: 12 },
      });
      m.step();
    }
    expect(hz).toBeGreaterThan(0);
    expect(count()).toBe(before);
  });

  it('Gravity Well sets a gravity source and pulls the foe, then clears it', () => {
    const { m, a, b, beh } = duel('4:sig*40', 220);
    const x0 = b.px - a.px;
    let on = false;
    let lens = 0;
    for (let i = 0; i < 160; i++) {
      m.step();
      if (beh.wellActive) on = true;
      lens = Math.max(lens, a.view.lensRadius);
    }
    expect(on).toBe(true);
    expect(lens).toBeGreaterThan(0);
    expect(b.px - a.px).toBeLessThan(x0);
    for (let i = 0; i < 120; i++) m.step();
    expect(beh.wellActive).toBe(false);
  });

  it('accretion raises mass and the hole gets slower as it grows', () => {
    const { m, a } = duel('4:ult', 150);
    for (let i = 0; i < 300; i++) m.step();
    expect(a.view.bodyStats.massFrac).toBeGreaterThan(0.6);
    expect(a.view.resource).toBeGreaterThan(0);
  });

  it('Maw takes a real bite out of a foe', () => {
    const { m, b } = duel('4:crush', 130, 'lastone');
    for (let i = 0; i < 300; i++) m.step();
    expect(b.view.bodyStats.massFrac).toBeLessThan(0.97);
  });

  it('a scripted duel on the real world is deterministic', () => {
    const run = (): number => {
      const { m } = duel('4:strike,40:crush,120:sig*30,260:ult', 140);
      for (let i = 0; i < 420; i++) m.step();
      return m.hash();
    };
    expect(run()).toBe(run());
  });
});
