import { describe, expect, it } from 'vitest';
import { LOGICAL_H, LOGICAL_W, parseScript, type RenderLayer, type TitanId } from '@/contracts';
import { paintPlanetFace } from '@/titans/art/planet';
import { createScriptSource, makeMatch, skipIntro } from '../testing/harness';
import { createMatterWorld } from '@/matter';
import type { FighterImpl } from '../fighter';
import type { PlanetIdle } from './planetIdle';
import { PlanetFrames } from './planetFrames';

const view = { x0: 480, y0: 180, w: LOGICAL_W, h: LOGICAL_H };

interface Peek {
  idle: Pick<PlanetIdle, 'faceBuf'> & { frames: PlanetFrames; cells: Int32Array; clock: { t: number } };
  rubBack: { layer: RenderLayer };
  rubFront: { layer: RenderLayer };
}
const peek = (f: FighterImpl): Peek => (f as unknown as { behaviour: Peek }).behaviour;

/** A Planet (slot 0) against a still foe. Node has no workers: the rotation frames are filled here (all frame 0's face). */
function setup(script0 = '') {
  const m = makeMatch({ a: 'planet', b: 'asteroid' as TitanId, seed: 21, createWorld: (s) => createMatterWorld(s) });
  skipIntro(m);
  const f = m.fighters[0] as FighterImpl;
  m.setSources(
    createScriptSource(parseScript(script0), m.tick + 1),
    createScriptSource(parseScript(''), m.tick + 1),
  );
  const fr = peek(f).idle.frames;
  if (!fr.have[0]) {
    const cells = peek(f).idle.cells;
    const { colors, cls } = paintPlanetFace(f.def, f.seed, f.lighting, 0);
    for (let fi = 0; fi < PlanetFrames.F; fi++) {
      for (let k = 0; k < cells.length; k++) {
        fr.col[fi * cells.length + k] = colors[cells[k]!]!;
        fr.cls[fi * cells.length + k] = cls[cells[k]!]!;
      }
      fr.have[fi] = 1;
    }
  }
  return { m, f };
}

const render = (f: FighterImpl): RenderLayer[] => f.renderLayers(view, 1);

describe('the Planet living idle (idle handover, specs/planet.md; 45 s day, WJ 2026-10-17)', () => {
  it('is frame-rate independent: drawn every tick or every fourth, the face and the rubble come out the same', () => {
    const a = setup();
    const b = setup();
    let compared = 0;
    for (let t = 1; t <= 900; t++) {
      a.m.step();
      b.m.step();
      render(a.f);
      if (t % 4 !== 0) continue;
      render(b.f);
      if (t % 60 !== 0) continue;
      const pa = peek(a.f);
      const pb = peek(b.f);
      expect(pb.idle.clock.t).toBeCloseTo(pa.idle.clock.t, 9);
      expect(Buffer.from(pb.idle.faceBuf.buffer).equals(Buffer.from(pa.idle.faceBuf.buffer))).toBe(true);
      expect(Buffer.from(pb.rubFront.layer.pixels.buffer).equals(Buffer.from(pa.rubFront.layer.pixels.buffer))).toBe(
        true,
      );
      compared++;
    }
    expect(compared).toBe(15);
  });

  it('paints the turning face on pristine cells only: a damaged cell keeps the fight’s drawing', () => {
    const { m, f } = setup();
    for (let t = 0; t < 30; t++) {
      m.step();
      render(f);
    }
    const idle = peek(f).idle;
    const i = idle.cells[Math.floor(idle.cells.length / 2)]!;
    expect(idle.faceBuf[i]).not.toBe(0);
    f.body.map.integrity[i] = 120;
    m.step();
    render(f);
    // a live event or the next skin paint redraws the face within a few ticks
    for (let t = 0; t < 6; t++) {
      m.step();
      render(f);
    }
    expect(idle.faceBuf[i]).toBe(0);
  });

  it('draws the ring of rubble on both sides of the globe, and the world keeps turning through the day', () => {
    const { m, f } = setup();
    const seen = new Set<number>();
    let back = 0;
    let front = 0;
    for (let t = 0; t < 2700; t++) {
      m.step();
      // the idle catches up every tick in between, so a frame every half second sees the whole day
      if (t % 30 !== 0) continue;
      const out = render(f);
      seen.add((peek(f).idle as unknown as { fi: number }).fi);
      if (out.includes(peek(f).rubBack.layer) && peek(f).rubBack.layer.visible) back++;
      if (out.includes(peek(f).rubFront.layer) && peek(f).rubFront.layer.visible) front++;
    }
    expect(back).toBe(90);
    expect(front).toBe(90);
    // 45 s at 60 Hz: the whole day comes round (240 frames, sampled every half second)
    expect(seen.size).toBeGreaterThan(80);
  });
});
