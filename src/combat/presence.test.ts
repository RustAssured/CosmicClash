import { describe, expect, it } from 'vitest';
import { parseScript, type TitanId } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { getTitanDef } from '@/titans';
import type { FighterImpl } from './fighter';
import { resolveFeel } from './feel';
import { createScriptSource, makeMatch, skipIntro } from './testing/harness';

function knock(a: TitanId, b: TitanId, script: string): { peak: number; travel: number; lean: number } {
  const m = makeMatch({ a, b, seed: 5, createWorld: (s) => createMatterWorld(s) });
  skipIntro(m);
  const A = m.fighters[0] as FighterImpl;
  const B = m.fighters[1] as FighterImpl;
  B.px = A.px + 130;
  B.py = A.py;
  m.setSources(createScriptSource(parseScript(script), m.tick + 1), createScriptSource([], m.tick + 1));
  let x0 = NaN;
  let peak = 0;
  let lean = 0;
  for (let i = 0; i < 170; i++) {
    m.step();
    if (Number.isNaN(x0) && B.lastHitTick > 0) x0 = B.px;
    if (!Number.isNaN(x0)) {
      peak = Math.max(peak, Math.abs(B.vx + B.kvx) / 60);
      lean = Math.max(lean, Math.abs(B.body.transform.lean));
    }
  }
  return { peak, travel: Math.abs(B.px - x0), lean };
}

describe('body weight and presence', () => {
  it('a landed Crush is an eased shove: 5 to 11 px/tick at the start, 150 to 260 px in total for a lighter defender', () => {
    const r = knock('lastone', 'asteroid', '4:crush');
    expect(r.peak).toBeGreaterThan(5);
    expect(r.peak).toBeLessThan(11);
    expect(r.travel).toBeGreaterThan(150);
    expect(r.travel).toBeLessThan(260);
  });

  it('heavier defenders barely move but recoil (a lean kick); a Strike is a nudge', () => {
    const light = knock('lastone', 'asteroid', '4:crush');
    const heavy = knock('lastone', 'planet', '4:crush');
    const nudge = knock('lastone', 'asteroid', '4:strike');
    expect(heavy.travel).toBeLessThan(light.travel * 0.6);
    expect(heavy.lean).toBeGreaterThan(2);
    expect(nudge.travel).toBeLessThan(60);
  });

  it('feel defaults follow mass and the JSON block overrides them', () => {
    const ast = resolveFeel(getTitanDef('asteroid'));
    const planet = resolveFeel(getTitanDef('planet'));
    const bh = resolveFeel(getTitanDef('blackhole'));
    expect(planet.accelMul).toBeGreaterThan(ast.accelMul);
    expect(planet.bobAmp).toBeGreaterThan(ast.bobAmp * 3);
    expect(bh.bobAmp).toBe(0);
    expect(ast.fx?.kind).toBe('dust');
  });

  it('idle bob is deterministic and the body layer really moves', () => {
    const run = (): number[] => {
      const m = makeMatch({ a: 'planet', b: 'asteroid', seed: 9, createWorld: (s) => createMatterWorld(s) });
      skipIntro(m);
      const ys: number[] = [];
      for (let i = 0; i < 200; i++) {
        m.step();
        if (i % 10 === 0) ys.push((m.fighters[0] as FighterImpl).body.transform.y);
      }
      return ys;
    };
    const a = run();
    expect(run()).toEqual(a);
    expect(Math.max(...a) - Math.min(...a)).toBeGreaterThanOrEqual(3);
  });
});
