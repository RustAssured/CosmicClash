import { describe, expect, it } from 'vitest';
import { LOGICAL_H, LOGICAL_W, parseScript, type TitanId } from '@/contracts';
import { createScriptSource, makeMatch, skipIntro } from '../testing/harness';
import { createMatterWorld } from '@/matter';
import type { FighterImpl } from '../fighter';

const view = { x0: 480, y0: 180, w: LOGICAL_W, h: LOGICAL_H };

/** An Asteroid (slot 0) against a still foe; `foeLeft` swaps the sides so the Asteroid faces −1. */
function setup(foeLeft = false, script0 = '') {
  const m = makeMatch({
    a: 'asteroid',
    b: 'planet' as TitanId,
    seed: 21,
    createWorld: (s) => createMatterWorld(s),
  });
  skipIntro(m);
  const f = m.fighters[0] as FighterImpl;
  const g = m.fighters[1] as FighterImpl;
  if (foeLeft) {
    f.px = 1000;
    g.px = 600;
  }
  m.setSources(
    createScriptSource(parseScript(script0), m.tick + 1),
    createScriptSource(parseScript(''), m.tick + 1),
  );
  return { m, f, g };
}

const pose = (f: FighterImpl): { dir: number; lockAge: number; ox: number; oy: number; rot: number } =>
  (
    f as unknown as {
      behaviour: { pose: { dir: number; lockAge: number; ox: number; oy: number; rot: number } };
    }
  ).behaviour.pose;

describe('the Asteroid living idle (idle handover, specs/asteroid.md; real rotation, WJ 2026-10-17)', () => {
  for (const foeLeft of [false, true])
    it(`turns its horn toward the foe for real (facing ${foeLeft ? '−1' : '+1'}): the horn tip is where the head points`, () => {
      const { m, f } = setup(foeLeft);
      const rig = f.rig as unknown as { core: { x: number; y: number }; prow: { x: number; y: number } };
      const dist = Math.hypot(rig.prow.x - (rig.core.x + 0.5), rig.prow.y - (rig.core.y + 0.5));
      let checked = 0;
      let rotated = 0;
      for (let t = 0; t < 600; t++) {
        m.step();
        const p = pose(f);
        const tr = f.body.transform;
        if (p.lockAge >= 999 || p.lockAge < 1) continue;
        if ((tr.rot ?? 0) !== 0) rotated++;
        // where the head points, at the prow's distance: the body's matter there is the horn
        const wx = tr.x + Math.cos(p.dir) * (dist - 2);
        const wy = tr.y + Math.sin(p.dir) * (dist - 2);
        let near = 1e9;
        for (let dy = -3; dy <= 3; dy++)
          for (let dx = -3; dx <= 3; dx++) {
            const c = f.body.cellAtWorld(wx + dx, wy + dy);
            if (c < 0) continue;
            const lx = c % f.body.map.w;
            const ly = (c - lx) / f.body.map.w;
            near = Math.min(near, Math.hypot(lx + 0.5 - rig.prow.x, ly + 0.5 - rig.prow.y));
          }
        expect(near).toBeLessThan(6);
        checked++;
      }
      expect(checked).toBeGreaterThan(100);
      expect(rotated).toBeGreaterThan(0);
    });

  it('yields at once: the tick a move starts there is no idle offset or rotation (attack frames are exact)', () => {
    const { m, f } = setup(false, '200:strike,420:crush*20');
    let moveTicks = 0;
    for (let t = 0; t < 600; t++) {
      m.step();
      if (!f.mv.def) continue;
      moveTicks++;
      const p = pose(f);
      expect(f.body.transform.rot ?? 0).toBe(0);
      expect(p.ox).toBe(0);
      expect(p.oy).toBe(0);
    }
    expect(moveTicks).toBeGreaterThan(10);
  });

  it('is deterministic: two runs of the same match give the same hashes (the pose is sim state)', () => {
    const a = setup();
    const b = setup();
    for (let t = 0; t < 400; t++) {
      a.m.step();
      b.m.step();
      expect(a.m.hash()).toBe(b.m.hash());
    }
  });

  it('keeps destroyed matter destroyed: a crater in the rock is a hole in the turned body', () => {
    const { m, f } = setup();
    const map = f.body.map;
    const hole: number[] = [];
    for (let y = 60; y < 70; y++)
      for (let x = 85; x < 95; x++) {
        const i = y * map.w + x;
        (map.material as Uint8Array)[i] = 0;
        map.pixels[i] = 0;
        hole.push(i);
      }
    for (let t = 0; t < 120; t++) {
      m.step();
      const body = f.renderLayers(view, 0)[0]!;
      for (const i of hole) expect(body.pixels[i]).toBe(0);
    }
  });
});
