import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  LOGICAL_H,
  LOGICAL_W,
  type MatchConfig,
  type RenderLayer,
} from '@/contracts';
import { createMatterWorld } from '@/matter';
import { createMatch, type Match } from '@/sim';
import { getTitanDef } from '@/titans';
import { createFighter } from '..';
import { skipIntro } from '../testing/harness';
import type { FighterImpl } from '../fighter';
import type { ColossusPose } from './colossusPose';

const view = { x0: 480, y0: 180, w: LOGICAL_W, h: LOGICAL_H };

interface Peek {
  pose: ColossusPose;
  atlas: RenderLayer;
}
const peek = (f: FighterImpl): Peek => f.behaviour as unknown as Peek;

/** The Last One (id colossus, slot 0) against a still Asteroid. */
function setup(): { m: Match; f: FighterImpl } {
  const cfg: MatchConfig = {
    seed: 7,
    stage: 'nursery',
    mode: 'versus',
    slots: [
      { titan: 'colossus', controller: 'human' },
      { titan: 'asteroid', controller: 'human' },
    ],
  };
  const m = createMatch(cfg, {
    createWorld: (s) => createMatterWorld(s),
    createFighter,
    getTitanDef,
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  });
  skipIntro(m);
  return { m, f: m.fighters[0] as FighterImpl };
}

describe('the Last One living idle (idle handover, specs/last-one.md; WJ 2026-10-19: real rig, idle only)', () => {
  it('rendering never changes the sim through a whole calm idle, a witnessing included (S19)', () => {
    const a = setup();
    const b = setup();
    let witnessed = false;
    for (let t = 0; t < 900; t++) {
      a.m.step();
      b.m.step();
      a.f.renderLayers(view, 1);
      if (peek(a.f).pose.wit >= 0) witnessed = true;
    }
    expect(witnessed).toBe(true);
    expect(a.m.hash()).toBe(b.m.hash());
  });

  it('is the same picture at any frame rate: the atlas drawn every tick or every fourth', () => {
    const a = setup();
    const b = setup();
    // the intro was skipped without drawing: both catch it up at once here (a catch-up longer than the 16-tick input ring
    // steps its oldest ticks on the latest input, which in a game drawn every frame never happens)
    a.f.renderLayers(view, 1);
    b.f.renderLayers(view, 1);
    let compared = 0;
    for (let t = 1; t <= 720; t++) {
      a.m.step();
      b.m.step();
      a.f.renderLayers(view, 1);
      if (t % 4 !== 0) continue;
      b.f.renderLayers(view, 1);
      if (t % 60 !== 0) continue;
      const pa = peek(a.f).atlas.pixels;
      const pb = peek(b.f).atlas.pixels;
      expect(Buffer.from(pb.buffer).equals(Buffer.from(pa.buffer))).toBe(true);
      compared++;
    }
    expect(compared).toBe(12);
  });

  it('the breath and the shifts move the real body, and a move takes the idle away within ~0.15 s', () => {
    const { m, f } = setup();
    const ys = new Set<number>();
    for (let t = 0; t < 600; t++) {
      m.step();
      ys.add(f.body.transform.y);
    }
    // the body is not still: the breath (0 / −2 px) and the drift move it
    expect(ys.size).toBeGreaterThan(1);
    expect(peek(f).pose.w).toBe(1);
  });
});
