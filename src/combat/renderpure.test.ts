import { describe, expect, it } from 'vitest';
import { LOGICAL_H, LOGICAL_W, parseScript, type TitanId } from '@/contracts';
import { createScriptSource, makeMatch, skipIntro } from './testing/harness';
import type { FighterImpl } from './index';

/**
 * S19: several behaviours rasterise their overlays at RENDER time (`renderLayers`, once per drawn frame) instead of in the
 * sim tick (the Cradle's False Birth membrane, the Supernova's star and nova …). Rendering must never change the
 * simulation: netplay peers render at different rates, a headless peer not at all. Every titan's Ultimate and a heavy
 * combo, played with no rendering and with rendering every other tick (a frame per tick, and frames that skip ticks, as in
 * the loop's catch-up), must give the same state hash every tick.
 */
const TITANS: TitanId[] = [
  'colossus',
  'lastone',
  'asteroid',
  'nexus',
  'blackhole',
  'supernova',
  'planet',
  'uri',
  'cradle',
  'mouth',
] as TitanId[];
const SCRIPT = '10:ult,200:strike,230:crush*40,280:sig';
const TICKS = 300;
const view = { x0: 480, y0: 180, w: LOGICAL_W, h: LOGICAL_H };

function run(a: TitanId, every: number): Uint32Array {
  const m = makeMatch({ a, b: a === 'cradle' ? 'planet' : 'cradle', seed: 7 });
  skipIntro(m);
  const fa = m.fighters[0] as FighterImpl;
  const fb = m.fighters[1] as FighterImpl;
  fa.px = 695;
  fb.px = 905;
  fa.meter = 1;
  m.setSources(
    createScriptSource(parseScript(SCRIPT), m.tick + 1),
    createScriptSource(parseScript(''), m.tick + 1),
  );
  const h = new Uint32Array(TICKS);
  for (let t = 0; t < TICKS; t++) {
    m.step();
    if (every > 0 && t % every === 0) {
      for (const f of m.fighters) f.renderLayers(view, 0.5);
      m.world.renderLayers(view, 0.5);
    }
    h[t] = m.hash();
  }
  return h;
}

const first = (x: Uint32Array, y: Uint32Array): number => x.findIndex((v, i) => v !== y[i]);

describe('rendering never changes the sim (S19)', () => {
  for (const a of TITANS)
    it(`${a}: ultimate + heavy moves, hashes identical with and without renderLayers`, () => {
      expect(first(run(a, 0), run(a, 2))).toBe(-1);
    }, 120_000);
});
