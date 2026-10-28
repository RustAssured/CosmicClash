import { describe, expect, it } from 'vitest';
import { LOGICAL_H, LOGICAL_W, parseScript, type RenderLayer } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { createScriptSource, makeMatch, skipIntro } from '../../testing/harness';
import type { FighterImpl } from '../../fighter';

const view = { x0: 480, y0: 180, w: LOGICAL_W, h: LOGICAL_H };

function setup(script1 = '') {
  const m = makeMatch({ a: 'remainder', b: 'lastone', seed: 21, createWorld: (s) => createMatterWorld(s) });
  skipIntro(m);
  m.setSources(
    createScriptSource(parseScript(''), m.tick + 1),
    createScriptSource(parseScript(script1), m.tick + 1),
  );
  return { m, f: m.fighters[0] as FighterImpl };
}

const layers = (f: FighterImpl): RenderLayer[] => f.renderLayers(view, 1);

describe('the Remainder living idle (presentation only)', () => {
  it('never changes the fight: the same scripted exchange hashes the same whether it is drawn or not', () => {
    const run = (draw: boolean): number => {
      const { m, f } = setup('30:crush,140:strike');
      for (let t = 0; t < 240; t++) {
        m.step();
        if (draw) layers(f);
      }
      return m.hash();
    };
    expect(run(true)).toBe(run(false));
  });

  it('turns the vortex and keeps the body: the skin changes over time, only inside the body, and the map is untouched', () => {
    const { m, f } = setup();
    const map = f.body.map;
    const before = map.pixels.slice();
    m.step();
    const a = layers(f)
      .find((l) => l.id.startsWith('titan'))!
      .pixels.slice();
    for (let t = 0; t < 90; t++) m.step();
    const b = layers(f).find((l) => l.id.startsWith('titan'))!.pixels;
    let moved = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) moved++;
      // nothing is drawn where there is no matter
      if (!map.material[i]) expect(b[i]).toBe(0);
    }
    expect(moved).toBeGreaterThan(500);
    expect(Buffer.compare(Buffer.from(map.pixels.buffer), Buffer.from(before.buffer))).toBe(0);
  });

  it('keeps wreckage in orbit on its own layers, behind and in front', () => {
    const { m, f } = setup();
    let back = 0;
    let front = 0;
    for (let t = 0; t < 600; t += 20) {
      for (let k = 0; k < 20; k++) m.step();
      for (const l of layers(f)) {
        if (!l.visible) continue;
        if (l.id === 'remainder-wreck-back') back++;
        if (l.id === 'remainder-wreck-front') front++;
      }
    }
    expect(back).toBeGreaterThan(0);
    expect(front).toBeGreaterThan(0);
  });
});
