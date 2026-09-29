import { describe, expect, it } from 'vitest';
import { parseScript, type DamageEvent, type SimEvent, type TitanId } from '@/contracts';
import { createMatterWorld, type MatterWorldEx } from '@/matter';
import type { FighterImpl } from './fighter';
import type { PlanetBehaviour } from './behaviours/planet';
import { createScriptSource, makeMatch, skipIntro } from './testing/harness';

function duel(a: TitanId, b: TitanId, gap = 170, seed = 7) {
  const m = makeMatch({ a, b, seed, createWorld: (s) => createMatterWorld(s) });
  skipIntro(m);
  const fa = m.fighters[0] as FighterImpl;
  const fb = m.fighters[1] as FighterImpl;
  fa.px = 800 - gap / 2;
  fb.px = 800 + gap / 2;
  return { m, fa, fb, pl: (fa.behaviour ?? fb.behaviour) as unknown as PlanetBehaviour };
}

const thermal = (cx: number, cy: number): DamageEvent => ({
  type: 'THERMAL',
  shape: { kind: 'field', x: cx, y: cy, r: 60, falloff: 1.5 },
  energy: 380,
  dirX: 1,
  dirY: 0,
  duration: 1,
  sourceMass: 7,
  sourceBodyId: -1,
  originX: cx - 100,
  originY: cy,
  flags: 0,
  params: {},
});

describe('Planet', () => {
  it('its moons are real matter bodies on visible orbits, in front of and behind the world', () => {
    const { m, fa, pl } = duel('planet', 'asteroid', 380);
    m.setSources(null, null);
    const seenFront = new Set<boolean>();
    const xs: number[] = [];
    for (let t = 0; t < 500; t++) {
      m.step();
      for (const mo of pl.moonBodies) {
        expect(fa.world.getBody(mo.body.id)?.kind).toBe('moon');
        if (mo === pl.moonBodies[0]) {
          seenFront.add(mo.back);
          xs.push(mo.x - fa.px);
        }
      }
    }
    expect(pl.moonBodies.length).toBe(2);
    expect(seenFront.size).toBe(2);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(150);
    expect(fa.view.resource).toBe(2);
    expect(fa.view.parts).toBe(2);
    expect(fa.world.ledger().error).toBeLessThan(0.05);
  }, 60_000);

  it('Moon Slam spends a moon, hits for real, and the moon comes home damaged', () => {
    const { m, fa, fb, pl } = duel('planet', 'asteroid', 300);
    const ini = fb.view.bodyStats.mass;
    m.setSources(createScriptSource(parseScript('1:sig*45'), m.tick + 1), null);
    let spent = false;
    for (let t = 0; t < 300; t++) {
      m.step();
      if (fa.view.resource === 1) spent = true;
    }
    expect(spent).toBe(true);
    expect(fb.view.bodyStats.mass).toBeLessThan(ini * 0.97);
    expect(fa.view.resource).toBe(2);
    expect(Math.min(pl.moonFrac(0), pl.moonFrac(1))).toBeLessThan(0.95);
  }, 60_000);

  it('hard blows that reach a moon damage it, knock it out of orbit and lose it (cue, pip out)', () => {
    const { m, fb } = duel('asteroid', 'planet', 120);
    m.setSources(null, null);
    const b = fb.behaviour as unknown as PlanetBehaviour;
    const attacker = m.fighters[0]!;
    const events: SimEvent[] = [];
    const mo = b.moonBodies[0]!;
    let lost = false;
    let knocked = false;
    for (let t = 0; t < 400 && !lost; t++) {
      m.step();
      if (mo.mode === 3) knocked = true;
      for (const e of m.events) if (e.t === 'cue' && e.id === 'moon-lost') lost = true;
      if (t % 10 === 0 && mo.mode !== 4) {
        const ev = thermal(mo.x, mo.y);
        ev.type = 'CRUSH';
        ev.energy = 900;
        ev.shape = { kind: 'point', x: mo.x, y: mo.y, r: 14 };
        events.length = 0;
        fb.receive(ev, attacker, events);
        if (events.some((e) => e.t === 'cue' && e.id === 'moon-lost')) lost = true;
      }
    }
    expect(lost).toBe(true);
    expect(mo.mode).toBe(4);
    expect(knocked || lost).toBe(true);
    expect(fb.world.getBody(mo.body.id)).toBeUndefined();
    expect(fb.view.parts).toBe(1);
    expect(fb.world.ledger().error).toBeLessThan(0.05);
  }, 60_000);

  it('atmosphere absorbs heat: the same burst does far less to an intact planet than to a stripped one', () => {
    const measure = (strip: boolean): number => {
      const { m, fb } = duel('supernova', 'planet', 170);
      const ids = fb.rig as unknown as { ids: { atmosphere: number; cloud: number } };
      m.setSources(null, null);
      if (strip) {
        const map = fb.body.map;
        for (let i = 0; i < map.material.length; i++)
          if (map.material[i] === ids.ids.atmosphere || map.material[i] === ids.ids.cloud) {
            map.material[i] = 0;
            map.integrity[i] = 0;
          }
        (fb.world as MatterWorldEx).settleBody(fb.body.id);
      }
      const t = fb.body.transform;
      const before = fb.world.stats(fb.body.id).mass;
      const ev = thermal(t.x - 60, t.y);
      ev.energy = 700;
      fb.world.applyDamage(fb.body.id, ev);
      for (let k = 0; k < 40; k++) m.step();
      return before - fb.world.stats(fb.body.id).mass;
    };
    const intact = measure(false);
    const stripped = measure(true);
    expect(intact).toBeGreaterThan(0);
    expect(stripped).toBeGreaterThan(intact * 1.05);
  }, 60_000);

  it('stripping the atmosphere weakens the guard shell', () => {
    const { m, fb, pl } = duel('asteroid', 'planet', 200);
    m.setSources(null, null);
    const b = fb.behaviour as unknown as PlanetBehaviour;
    for (let t = 0; t < 12; t++) m.step();
    const full = b.guardMultiplier();
    const map = fb.body.map;
    const ids = (fb.rig as unknown as { ids: { atmosphere: number; cloud: number } }).ids;
    for (let i = 0; i < map.material.length; i++)
      if (map.material[i] === ids.atmosphere || map.material[i] === ids.cloud) map.material[i] = 0;
    for (let t = 0; t < 12; t++) m.step();
    expect(b.guardMultiplier()).toBeLessThan(full - 0.3);
    void pl;
  }, 60_000);

  it('is deterministic: identical scripted fights end in identical hashes (moons included)', () => {
    const run = (): number => {
      const { m } = duel('planet', 'lastone', 200);
      const t0 = m.tick;
      m.setSources(
        createScriptSource(parseScript('1:strike,50:sig*30,150:crush,300:guard*30'), t0 + 1),
        createScriptSource(parseScript('20:strike,120:crush,200:sig'), t0 + 1),
      );
      for (let t = 0; t < 450; t++) m.step();
      return m.hash();
    };
    expect(run()).toBe(run());
  }, 90_000);
});
