import { afterEach, describe, expect, it } from 'vitest';
import { LOGICAL_H, LOGICAL_W, parseScript, type TitanId } from '@/contracts';
import { createScriptSource, makeMatch, skipIntro } from '../testing/harness';
import { createMatterWorld } from '@/matter';
import type { FighterImpl } from '../fighter';
import { GARGANTUA, type GargantuaIdle } from './blackholeGargantua';

const view = { x0: 480, y0: 180, w: LOGICAL_W, h: LOGICAL_H };

interface Peek {
  gar: GargantuaIdle | null;
  bodyLayer: { visible: boolean } | null;
}
const peek = (f: FighterImpl): Peek => (f as unknown as { behaviour: Peek }).behaviour;

/** The Black Hole (slot 0) against a still foe, with the Gargantua variant on. */
function setup(script = '') {
  const m = makeMatch({
    a: 'blackhole',
    b: 'asteroid' as TitanId,
    seed: 21,
    createWorld: (s) => createMatterWorld(s),
  });
  skipIntro(m);
  const f = m.fighters[0] as FighterImpl;
  const g = m.fighters[1] as FighterImpl;
  g.px = f.px + 300;
  m.setSources(
    createScriptSource(parseScript(script), m.tick + 1),
    createScriptSource(parseScript(''), m.tick + 1),
  );
  m.step();
  f.renderLayers(view, 1);
  return { m, f };
}

describe('the Black Hole, idle v3 "Gargantua" (a variant behind ?bh=gargantua; WJ 2026-10-22: look only, 1:1, 7% tint)', () => {
  afterEach(() => {
    GARGANTUA.on = false;
  });

  it('rendering never changes the sim, through a Feast (S19, 900 ticks)', () => {
    GARGANTUA.on = true;
    const a = setup();
    const b = setup();
    let feast = false;
    for (let t = 0; t < 900; t++) {
      a.m.step();
      b.m.step();
      a.f.renderLayers(view, 1);
      if ((peek(a.f).gar?.feastState ?? -9) > 0) feast = true;
    }
    expect(feast).toBe(true);
    expect(a.m.hash()).toBe(b.m.hash());
  });

  it('is the same picture at any frame rate: drawn every tick or every fourth', () => {
    GARGANTUA.on = true;
    const a = setup();
    const b = setup();
    let compared = 0;
    for (let t = 1; t <= 600; t++) {
      a.m.step();
      b.m.step();
      a.f.renderLayers(view, 1);
      // (b draws every fourth tick, on even ticks, where a draws too: the picture of a tick must be the same)
      if ((a.f.tickNo & 3) !== 0) continue;
      b.f.renderLayers(view, 1);
      if (t % 60 > 3 || t < 60) continue;
      const pa = peek(a.f).gar!.fx.pixels;
      const pb = peek(b.f).gar!.fx.pixels;
      expect(Buffer.from(pb.buffer).equals(Buffer.from(pa.buffer))).toBe(true);
      compared++;
    }
    // (one comparison in each second after the first)
    expect(compared).toBe(9);
  });

  it('covers the painted body, and the Feast comes 4.5 s in, then every 9–12 s', () => {
    GARGANTUA.on = true;
    const { m, f } = setup();
    const gar = peek(f).gar!;
    const starts: number[] = [];
    let prev = -9;
    for (let t = 0; t < 1800; t++) {
      m.step();
      f.renderLayers(view, 1);
      const s = gar.feastState;
      if (prev === -9 && s !== -9) starts.push(gar.time);
      prev = s;
    }
    expect(peek(f).bodyLayer!.visible).toBe(false);
    expect(starts[0]).toBeGreaterThan(4.4);
    expect(starts[0]).toBeLessThan(4.7);
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(9);
  });

  it('yields to a move: the idle weight falls within ~10 ticks', () => {
    GARGANTUA.on = true;
    const { m, f } = setup();
    const gar = peek(f).gar!;
    for (let t = 0; t < 120; t++) {
      m.step();
      f.renderLayers(view, 1);
    }
    expect(gar.weight).toBeGreaterThan(0.95);
    m.setSources(createScriptSource(parseScript('1:strike'), m.tick + 1), createScriptSource([], m.tick + 1));
    let low = false;
    for (let t = 0; t < 30; t++) {
      m.step();
      f.renderLayers(view, 1);
      if (gar.weight < 0.4) low = true;
    }
    expect(low).toBe(true);
  });

  it('keeps destroyed gas destroyed: with the painted disk gone the near disk is mostly holes', () => {
    GARGANTUA.on = true;
    const { m, f } = setup();
    const gar = peek(f).gar!;
    const lit = (): number => {
      let n = 0;
      for (const p of gar.fx.pixels) if (p >>> 24 !== 0) n++;
      return n;
    };
    for (let t = 0; t < 60; t++) {
      m.step();
      f.renderLayers(view, 1);
    }
    const before = lit();
    const map = f.body.map;
    const rig = f.rig as unknown as { ids: { diskhot: number; diskmid: number; diskdim: number } };
    for (let i = 0; i < map.w * map.h; i++) {
      const k = map.material[i]!;
      if (k === rig.ids.diskhot || k === rig.ids.diskmid || k === rig.ids.diskdim) {
        map.material[i] = 0;
        map.integrity[i] = 0;
      }
    }
    map.version++;
    for (let t = 0; t < 4; t++) {
      m.step();
      f.renderLayers(view, 1);
    }
    expect(lit()).toBeLessThan(before * 0.75);
  });

  it('is off by default: the desktop Black Hole draws as before', () => {
    const { m, f } = setup();
    for (let t = 0; t < 30; t++) m.step();
    const layers = f.renderLayers(view, 1);
    expect(peek(f).gar).toBeNull();
    expect(layers.some((L) => L.id === 'blackhole-gargantua')).toBe(false);
    expect(peek(f).bodyLayer!.visible).not.toBe(false);
  });
});
