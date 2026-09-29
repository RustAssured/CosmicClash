import { describe, expect, it } from 'vitest';
import {
  Btn,
  Rng,
  createMatterMap,
  hash32,
  hex,
  hueShiftRamp,
  leanShift,
  localToWorld,
  mapWorldAABB,
  parseHarnessParams,
  parseScript,
  pb,
  pg,
  pr,
  rgba,
  toHex,
  worldToLocal,
  type BodyTransform,
} from '@/contracts';

describe('Rng', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const c = new Rng(43);
    const sa = Array.from({ length: 50 }, () => a.next());
    const sb = Array.from({ length: 50 }, () => b.next());
    const sc = Array.from({ length: 50 }, () => c.next());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    expect(Math.min(...sa)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...sa)).toBeLessThan(1);
  });
  it('has a sane distribution', () => {
    const r = new Rng(7);
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += r.next();
    expect(sum / n).toBeGreaterThan(0.49);
    expect(sum / n).toBeLessThan(0.51);
  });
  it('save/restore state reproduces the stream; fork is stable', () => {
    const r = new Rng(9);
    r.next();
    const st = r.getState();
    const x = [r.next(), r.next()];
    r.setState(st);
    expect([r.next(), r.next()]).toEqual(x);
    expect(new Rng(5).fork('a').next()).toBe(new Rng(5).fork('a').next());
    expect(new Rng(5).fork('a').next()).not.toBe(new Rng(5).fork('b').next());
    expect(hash32(1, 2, 3)).toBe(hash32(1, 2, 3));
    expect(hash32(1, 2, 3)).not.toBe(hash32(3, 2, 1));
  });
});

describe('colour packing', () => {
  it('round-trips and lays out bytes as RGBA in memory', () => {
    const c = rgba(10, 20, 30, 255);
    expect([pr(c), pg(c), pb(c)]).toEqual([10, 20, 30]);
    const u8 = new Uint8Array(new Uint32Array([c]).buffer);
    expect(Array.from(u8)).toEqual([10, 20, 30, 255]);
    expect(toHex(hex('#a8bdb2'))).toBe('#a8bdb2');
    expect(hex('#fff')).toBe(rgba(255, 255, 255));
  });
  it('builds monotone-lightness hue-shifted ramps', () => {
    const ramp = hueShiftRamp(0.4, 0.3, 6);
    expect(ramp).toHaveLength(6);
    const lum = ramp.map((c) => 0.3 * pr(c) + 0.59 * pg(c) + 0.11 * pb(c));
    for (let i = 1; i < lum.length; i++) expect(lum[i]!).toBeGreaterThan(lum[i - 1]!);
  });
});

describe('body space mapping', () => {
  const t: BodyTransform = { x: 300, y: 200, anchorX: 40, anchorY: 50, facing: 1, lean: 0 };
  it('round-trips local→world→local for both facings and lean', () => {
    for (const facing of [1, -1] as const) {
      for (const lean of [0, 3, -4]) {
        const tt = { ...t, facing, lean };
        const w = { x: 0, y: 0 };
        const l = { x: 0, y: 0 };
        for (const [lx, ly] of [
          [10, 5],
          [40, 50],
          [77, 99],
        ] as const) {
          localToWorld(tt, lx, ly, w);
          worldToLocal(tt, w.x, w.y, l);
          expect(l.x).toBeCloseTo(lx, 6);
          expect(l.y).toBeCloseTo(ly, 6);
        }
      }
    }
  });
  it('mirrors around the anchor and leans zero at the anchor row', () => {
    const w = { x: 0, y: 0 };
    localToWorld({ ...t, facing: -1 }, 60, 50, w);
    expect(w.x).toBe(300 - 20);
    expect(leanShift(6, 50, 50)).toBe(0);
    expect(leanShift(6, 0, 50)).toBe(6);
    expect(leanShift(6, 100, 50)).toBe(-6);
    const bb = mapWorldAABB(t, 80, 100);
    expect(bb.x0).toBe(260);
    expect(bb.x1).toBe(340);
  });
});

describe('matter map', () => {
  it('allocates parallel arrays of the right size', () => {
    const m = createMatterMap(90, 70);
    for (const a of [
      m.material,
      m.integrity,
      m.density,
      m.bondR,
      m.bondD,
      m.infection,
      m.emissive,
      m.detached,
      m.flags,
      m.height,
    ]) {
      expect(a.length).toBe(90 * 70);
    }
    expect(m.temperature.length).toBe(90 * 70);
    expect(m.pixels.length).toBe(90 * 70);
  });
});

describe('harness params', () => {
  it('parses defaults and explicit values', () => {
    const d = parseHarnessParams('');
    expect(d.active).toBe(false);
    expect(d.a).toBe('lastone');
    const p = parseHarnessParams(
      '?stage=quasar&a=nexus&b=planet&seed=99&t=180&state=50&ai=5&script0=20:crush,90:right*30',
    );
    expect(p.stage).toBe('quasar');
    expect(p.a).toBe('nexus');
    expect(p.b).toBe('planet');
    expect(p.seed).toBe(99);
    expect(p.t).toBe(180);
    expect(p.state).toBe('50');
    expect(p.ai).toBe(5);
    expect(p.active).toBe(true);
    expect(p.freeze).toBe(true);
    expect(p.script0).toHaveLength(2);
  });
  it('rejects garbage safely', () => {
    const p = parseHarnessParams('?stage=nope&a=zzz&ai=99&state=77');
    expect(p.stage).toBe('nursery');
    expect(p.a).toBe('lastone');
    expect(p.ai).toBe(6);
    expect(p.state).toBe('intact');
  });
  it('parses scripts', () => {
    const s = parseScript('40:sig*30,20:crush,90:upright*10,bogus,5:zzz');
    expect(s.map((e) => e.tick)).toEqual([20, 40, 90]);
    expect(s[0]!.buttons).toBe(Btn.CRUSH);
    expect(s[1]!.hold).toBe(30);
    expect(s[2]!.moveY).toBeLessThan(0);
  });
});
