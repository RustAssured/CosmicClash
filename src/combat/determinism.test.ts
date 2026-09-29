import { describe, expect, it } from 'vitest';
import { parseScript, type SimEvent, type TitanId } from '@/contracts';
import type { Match } from '@/sim';
import { createMatterWorld } from '@/matter';
import { createScriptSource, makeMatch, skipIntro } from './testing/harness';

/** A busy, scripted exchange that exercises movement, strikes, crushes, beams, guard, surge, swarm and an ultimate. */
const SCRIPT_A =
  '1:right*40,45:strike,80:crush,140:surge,150:right*30,190:sig*50,260:guard*30,300:strike,310:upright*20,330:crush,400:ult';
const SCRIPT_B =
  '1:left*50,60:strike,100:left*20,130:guard*40,200:crush,240:sig,300:surge,330:left*40,370:strike,420:ult';

function fight(
  seed: number,
  a: TitanId,
  b: TitanId,
  ticks: number,
): { match: Match; events: number; hash: number } {
  const m = makeMatch({ seed, a, b, createWorld: (s) => createMatterWorld(s) });
  skipIntro(m);
  const t0 = m.tick;
  m.setSources(createScriptSource(parseScript(SCRIPT_A), t0), createScriptSource(parseScript(SCRIPT_B), t0));
  (m.fighters[0] as unknown as { meter: number }).meter = 1;
  (m.fighters[1] as unknown as { meter: number }).meter = 1;
  let events = 0;
  const kinds = new Set<string>();
  for (let i = 0; i < ticks; i++) {
    m.step();
    events += m.events.length;
    for (const e of m.events as readonly SimEvent[]) kinds.add(e.t);
  }
  expect(kinds.has('hit')).toBe(true);
  return { match: m, events, hash: m.hash() };
}

describe('determinism (real matter world)', () => {
  it('two identical scripted fights end in identical state hashes, world hashes and event counts', () => {
    const one = fight(11, 'lastone', 'asteroid', 700);
    const two = fight(11, 'lastone', 'asteroid', 700);
    expect(two.hash).toBe(one.hash);
    expect(two.match.world.hash()).toBe(one.match.world.hash());
    expect(two.events).toBe(one.events);
    for (let s = 0; s < 2; s++) {
      const a = one.match.fighters[s]!.view;
      const b = two.match.fighters[s]!.view;
      expect(b.x).toBe(a.x);
      expect(b.y).toBe(a.y);
      expect(b.bodyStats.mass).toBe(a.bodyStats.mass);
      expect(b.parts).toBe(a.parts);
      expect(b.meter).toBe(a.meter);
    }
  }, 60_000);

  it('a different seed produces a different fight', () => {
    const one = fight(11, 'lastone', 'asteroid', 400);
    const two = fight(12, 'lastone', 'asteroid', 400);
    expect(two.hash).not.toBe(one.hash);
  }, 60_000);

  it('mirror matches (same titan both sides) also run clean and deterministically', () => {
    const one = fight(5, 'asteroid', 'asteroid', 500);
    const two = fight(5, 'asteroid', 'asteroid', 500);
    expect(two.hash).toBe(one.hash);
    const three = fight(5, 'lastone', 'lastone', 500);
    const four = fight(5, 'lastone', 'lastone', 500);
    expect(four.hash).toBe(three.hash);
  }, 90_000);

  it('never produces NaN/Infinity in fighter state, however the fight goes', () => {
    const { match } = fight(3, 'lastone', 'asteroid', 900);
    for (const f of match.fighters) {
      const v = f.view;
      for (const n of [
        v.x,
        v.y,
        v.vx,
        v.vy,
        v.boundsX0,
        v.boundsX1,
        v.integrityPct,
        v.meter,
        v.resource,
        v.guardHealth,
      ])
        expect(Number.isFinite(n)).toBe(true);
      expect(v.meter).toBeGreaterThanOrEqual(0);
      expect(v.meter).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});
