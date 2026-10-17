import { describe, expect, it } from 'vitest';
import { LOGICAL_H, LOGICAL_W } from '@/contracts';
import { makeMatch, skipIntro } from '../testing/harness';
import { createMatterWorld } from '@/matter';
import type { FighterImpl } from '../fighter';

const view = { x0: 480, y0: 180, w: LOGICAL_W, h: LOGICAL_H };
const mk = () => {
  const m = makeMatch({ a: 'supernova', b: 'supernova', seed: 21, createWorld: (s) => createMatterWorld(s) });
  skipIntro(m);
  return m;
};

describe('the Supernova living idle (idle handover, specs/supernova.md)', () => {
  it('is the same at any frame rate: rendered twice a tick or once every two ticks, the star looks the same', () => {
    const a = mk();
    const b = mk();
    let la: Uint32Array | null = null;
    let lb: Uint32Array | null = null;
    for (let t = 1; t <= 180; t++) {
      a.step();
      b.step();
      // a: a 120 Hz display (two frames a tick); b: a frame every second tick (a slow machine)
      la = a.fighters[0]!.renderLayers(view, 0)[0]!.pixels;
      la = a.fighters[0]!.renderLayers(view, 0.5)[0]!.pixels;
      if (t % 2 === 0) lb = b.fighters[0]!.renderLayers(view, 0)[0]!.pixels;
    }
    expect(la).not.toBe((a.fighters[0] as FighterImpl).body.map.pixels);
    expect(Array.from(la!)).toEqual(Array.from(lb!));
  });

  it('draws the living disc in its own skin, never in the matter map', () => {
    const m = mk();
    const f = m.fighters[0] as FighterImpl;
    for (let t = 0; t < 60; t++) m.step();
    const before = new Uint32Array(f.body.map.pixels);
    const body = f.renderLayers(view, 0)[0]!;
    expect(body.pixels).not.toBe(f.body.map.pixels);
    expect(Array.from(f.body.map.pixels)).toEqual(Array.from(before));
    let diff = 0;
    for (let i = 0; i < before.length; i++) if (body.pixels[i] !== before[i]) diff++;
    expect(diff).toBeGreaterThan(1000);
  });

  it('keeps destroyed matter destroyed: a hole in the disc stays a hole', () => {
    const m = mk();
    const f = m.fighters[0] as FighterImpl;
    for (let t = 0; t < 30; t++) m.step();
    f.renderLayers(view, 0);
    const map = f.body.map;
    // punch a hole 10 cells across, a little off the core
    const cx = 104;
    const cy = 90;
    const hole: number[] = [];
    for (let y = cy - 5; y < cy + 5; y++)
      for (let x = cx - 5; x < cx + 5; x++) {
        const i = y * map.w + x;
        (map.material as Uint8Array)[i] = 0;
        map.pixels[i] = 0;
        hole.push(i);
      }
    for (let t = 0; t < 40; t++) {
      m.step();
      const body = f.renderLayers(view, 0)[0]!;
      for (const i of hole) expect(body.pixels[i]).toBe(0);
    }
  });
});
