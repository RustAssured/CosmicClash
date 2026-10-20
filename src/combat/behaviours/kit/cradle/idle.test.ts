import { describe, expect, it } from 'vitest';
import { LOGICAL_H, LOGICAL_W, parseScript, type TitanId } from '@/contracts';
import { createScriptSource, makeMatch, skipIntro } from '../../../testing/harness';
import { createMatterWorld } from '@/matter';
import type { FighterImpl } from '../../../fighter';
import type { CradlePose } from './pose';
import type { CradleIdle } from './idle';

const view = { x0: 480, y0: 180, w: LOGICAL_W, h: LOGICAL_H };

interface Peek {
  pose: CradlePose;
  idle: CradleIdle;
  atlas: { pixels: Uint32Array; w: number };
  regions: {
    kind: string;
    index: number;
    body: {
      map: {
        w: number;
        h: number;
        material: Uint8Array;
        integrity: Uint8Array;
        pixels: Uint32Array;
        version: number;
      };
    };
  }[];
  places: { sx: number; sy: number }[];
}
const peek = (f: FighterImpl): Peek => (f as unknown as { behaviour: Peek }).behaviour;

/** The Cradle (slot 0, facing the foe on its right) against a still foe within the quickening's 240 px. */
function setup() {
  const m = makeMatch({
    a: 'cradle' as TitanId,
    b: 'asteroid' as TitanId,
    seed: 21,
    createWorld: (s) => createMatterWorld(s),
  });
  skipIntro(m);
  const f = m.fighters[0] as FighterImpl;
  const g = m.fighters[1] as FighterImpl;
  g.px = f.px + 200;
  m.setSources(
    createScriptSource(parseScript(''), m.tick + 1),
    createScriptSource(parseScript(''), m.tick + 1),
  );
  // the intro's catch-up is longer than the idle's input ring: start both runs from one drawn frame
  f.renderLayers(view, 1);
  return { m, f };
}

describe('the Cradle living idle (idle handover, specs/cradle.md; WJ 2026-10-19: approved frames, real cord, idle only)', () => {
  it('rendering never changes the sim through a calm idle with a quickening (S19, 1200 ticks)', () => {
    const a = setup();
    const b = setup();
    let quick = false;
    for (let t = 0; t < 1200; t++) {
      a.m.step();
      b.m.step();
      a.f.renderLayers(view, 1);
      if (peek(a.f).pose.wit >= 0) quick = true;
    }
    expect(quick).toBe(true);
    expect(a.m.hash()).toBe(b.m.hash());
  });

  it('the quickening waits for the foe: none with the foe beyond 240 px', () => {
    const { m, f } = setup();
    (m.fighters[1] as FighterImpl).px = f.px + 420;
    let quick = false;
    for (let t = 0; t < 1200; t++) {
      m.step();
      if (peek(f).pose.wit >= 0) quick = true;
    }
    expect(quick).toBe(false);
  });

  it('is the same picture at any frame rate: drawn every tick or every fourth', () => {
    const a = setup();
    const b = setup();
    let compared = 0;
    for (let t = 1; t <= 960; t++) {
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
    expect(compared).toBe(16);
  });

  it('keeps destroyed matter destroyed: a sail with no matter left draws nothing', () => {
    const { m, f } = setup();
    const B = peek(f);
    const disc = B.regions.find((r) => r.kind === 'disc')!;
    const map = disc.body.map;
    const pl = B.places[disc.index]!;
    const drawn = (): number => {
      const L = B.atlas;
      let n = 0;
      for (let y = 0; y < B.idle.slotH; y++)
        for (let x = 0; x < B.idle.slotW; x++) if (L.pixels[(pl.sy + y) * L.w + pl.sx + x] !== 0) n++;
      return n;
    };
    for (let t = 0; t < 60; t++) {
      m.step();
      f.renderLayers(view, 0);
    }
    expect(drawn()).toBeGreaterThan(1000);
    map.material.fill(0);
    map.integrity.fill(0);
    map.pixels.fill(0);
    map.version++;
    for (let t = 0; t < 240; t++) {
      m.step();
      f.renderLayers(view, 0);
      if (t % 2 === 1) expect(drawn()).toBe(0);
    }
  });
});
