import { describe, expect, it } from 'vitest';
import { LOGICAL_H, LOGICAL_W, parseScript, type TitanId } from '@/contracts';
import { createScriptSource, makeMatch, skipIntro } from '../testing/harness';
import { createMatterWorld } from '@/matter';
import type { FighterImpl } from '../fighter';
import { NODES, type TendrilSystem } from './tendrils';
import type { LastOnePose } from './lastonePose';

const view = { x0: 480, y0: 180, w: LOGICAL_W, h: LOGICAL_H };

interface Peek {
  pose: LastOnePose;
  sys: TendrilSystem;
  idle: { skin: { px: Uint32Array } };
}
const peek = (f: FighterImpl): Peek => (f as unknown as { behaviour: Peek }).behaviour;

/** The Witness (id lastone, slot 0) against a still foe well out of the veil's reach. */
function setup() {
  const m = makeMatch({ a: 'lastone', b: 'asteroid' as TitanId, seed: 21, createWorld: (s) => createMatterWorld(s) });
  skipIntro(m);
  const f = m.fighters[0] as FighterImpl;
  const g = m.fighters[1] as FighterImpl;
  g.px = f.px + 320;
  m.setSources(
    createScriptSource(parseScript(''), m.tick + 1),
    createScriptSource(parseScript(''), m.tick + 1),
  );
  return { m, f };
}

describe('the Witness living idle (idle handover, specs/witness.md; WJ 2026-10-18: real veil and swim, idle only)', () => {
  it('rendering never changes the sim through a whole calm idle, Five Witnesses included (S19, 1300 ticks)', () => {
    const a = setup();
    const b = setup();
    for (let t = 0; t < 1300; t++) {
      a.m.step();
      b.m.step();
      a.f.renderLayers(view, 1);
    }
    expect(a.m.hash()).toBe(b.m.hash());
  });

  it('a Five Witnesses moment fires in calm idle and lifts the veil into a crown', () => {
    const { m, f } = setup();
    const { pose, sys } = peek(f);
    let fired = -1;
    let liftAtPeak = 0;
    let liftAtRest = 0;
    const lift = (): number => {
      // how far the tips stand above their roots, on average
      let s = 0;
      for (let i = 0; i < sys.n; i++) s += sys.ry[i]! - sys.y[i * NODES + sys.count[i]! - 1]!;
      return s / sys.n;
    };
    for (let t = 0; t < 1300; t++) {
      m.step();
      if (pose.wit >= 0 && fired < 0) {
        fired = t;
        liftAtRest = lift();
      }
      if (fired >= 0 && pose.wit > 3.2 && pose.wit < 3.25) liftAtPeak = lift();
    }
    expect(fired).toBeGreaterThan(0);
    expect(liftAtPeak - liftAtRest).toBeGreaterThan(6);
  });

  it('is the same picture at any frame rate: drawn every tick or every fourth', () => {
    const a = setup();
    const b = setup();
    let compared = 0;
    for (let t = 1; t <= 720; t++) {
      a.m.step();
      b.m.step();
      a.f.renderLayers(view, 1);
      if (t % 4 !== 0) continue;
      b.f.renderLayers(view, 1);
      if (t % 60 !== 0) continue;
      const pa = peek(a.f).idle.skin.px;
      const pb = peek(b.f).idle.skin.px;
      expect(Buffer.from(pb.buffer).equals(Buffer.from(pa.buffer))).toBe(true);
      compared++;
    }
    expect(compared).toBe(12);
  });

  it('keeps destroyed matter destroyed: a hole in an eye is a hole in the drawn body', () => {
    const { m, f } = setup();
    const map = f.body.map;
    const rig = f.rig as unknown as { eyes: { x: number; y: number; r: number }[] };
    const e = rig.eyes[0]!;
    const hole: number[] = [];
    for (let y = Math.floor(e.y - 1); y <= e.y + 1; y++)
      for (let x = Math.floor(e.x - 1); x <= e.x + 1; x++) hole.push(y * map.w + x);
    for (let t = 0; t < 30; t++) {
      m.step();
      f.renderLayers(view, 0);
    }
    for (const i of hole) {
      map.material[i] = 0;
      map.integrity[i] = 0;
      map.pixels[i] = 0;
    }
    map.version++;
    for (let t = 0; t < 240; t++) {
      m.step();
      f.renderLayers(view, 0);
      for (const i of hole) expect(peek(f).idle.skin.px[i]).toBe(0);
    }
  });
});
