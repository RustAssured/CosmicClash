import { describe, expect, it } from 'vitest';
import { STAGE_INFO as STAGES } from '../info';
import { AmbientLife } from './ambient';
import { makeCloud } from './clouds';
import { hexLinear, mixRgb, paletteRamps, rampAt } from './color';
import { SceneryKit, SpriteBuilder } from './kit';
import { Noise2, noiseTextureData } from './noise';
import { layerBounds, makeStarField } from './stars';
import type { SceneryInit } from '../types';

const arena = STAGES.nursery.arena;

describe('Noise2 (CPU placement noise)', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const a = new Noise2(5);
    const b = new Noise2(5);
    const c = new Noise2(6);
    let same = 0;
    for (let i = 0; i < 200; i++) {
      const x = i * 0.37;
      const y = i * 0.91;
      expect(a.fbm(x, y)).toBe(b.fbm(x, y));
      if (a.fbm(x, y) === c.fbm(x, y)) same++;
    }
    expect(same).toBeLessThan(5);
  });

  it('gradient noise is continuous, bounded and has zero mean-ish', () => {
    const n = new Noise2(9);
    let sum = 0;
    let maxStep = 0;
    let prev = n.noise(0, 0);
    for (let i = 1; i < 4000; i++) {
      const v = n.noise(i * 0.02, i * 0.013);
      expect(Math.abs(v)).toBeLessThanOrEqual(1.5);
      maxStep = Math.max(maxStep, Math.abs(v - prev));
      prev = v;
      sum += v;
    }
    expect(maxStep).toBeLessThan(0.15); // no lattice discontinuities
    expect(Math.abs(sum / 4000)).toBeLessThan(0.15);
  });

  it('fbm stays inside [0,1] and covers a useful range', () => {
    const n = new Noise2(2);
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < 5000; i++) {
      const v = n.fbm(i * 0.05, ((i * 7919) % 500) * 0.05);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi - lo).toBeGreaterThan(0.4);
  });

  it('noise texture data is reproducible and has a flat histogram', () => {
    const a = noiseTextureData(1);
    expect(a).toEqual(noiseTextureData(1));
    expect(a.length).toBe(256 * 256 * 4);
    const hist = new Array<number>(4).fill(0);
    for (let i = 0; i < a.length; i += 4) hist[a[i]! >> 6]!++;
    for (const h of hist) expect(h / (256 * 256)).toBeGreaterThan(0.2);
  });
});

describe('layer bounds, star fields and clouds', () => {
  it('layerBounds covers every camera position for its parallax', () => {
    for (const p of [0.03, 0.2, 0.58, 1, 1.55]) {
      const b = layerBounds(arena, p, 0);
      // screen x of a layer point = x - view.x0 * p, view.x0 ∈ [0, maxX-640]
      expect(b.x0).toBeLessThanOrEqual(arena.minX * p);
      expect(b.x1).toBeGreaterThanOrEqual((arena.maxX - 640) * p + 640);
      expect(b.y1).toBeGreaterThanOrEqual((arena.maxY - 360) * p + 360);
    }
  });

  it('star fields are deterministic, inside the bounds and mostly dim (power-law)', () => {
    const bounds = layerBounds(arena, 0.2);
    const opts = {
      count: 800,
      bounds,
      size: [0.9, 1.6] as [number, number],
      base: 0.5,
      boost: 2.5,
      seed: 12,
    };
    const a = makeStarField(opts);
    const b = makeStarField(opts);
    expect(a.count).toBe(800);
    expect(a.pos).toEqual(b.pos);
    expect(a.color).toEqual(b.color);
    let bright = 0;
    for (let i = 0; i < a.count; i++) {
      const x = a.pos[i * 4]!;
      const y = a.pos[i * 4 + 1]!;
      expect(x).toBeGreaterThanOrEqual(bounds.x0);
      expect(x).toBeLessThanOrEqual(bounds.x1);
      expect(y).toBeGreaterThanOrEqual(bounds.y0);
      expect(y).toBeLessThanOrEqual(bounds.y1);
      if (a.color[i * 4]! + a.color[i * 4 + 1]! + a.color[i * 4 + 2]! > 3) bright++;
    }
    expect(bright).toBeGreaterThan(0);
    expect(bright).toBeLessThan(a.count * 0.25);
  });

  it('cloud sprites concentrate where the density field is high and never exceed the requested count', () => {
    const noise = new Noise2(3);
    const bounds = layerBounds(arena, 0.1);
    const cloud = makeCloud({
      count: 500,
      bounds,
      noise,
      freq: 1 / 200,
      lo: 0.5,
      hi: 0.75,
      size: [8, 20],
      color: () => [1, 1, 1, 0.1],
      seed: 4,
    });
    expect(cloud.count).toBeLessThanOrEqual(500);
    expect(cloud.count).toBeGreaterThan(100);
    let meanDensity = 0;
    for (let i = 0; i < cloud.count; i++)
      meanDensity += noise.fbm(cloud.pos[i * 4]! / 200, cloud.pos[i * 4 + 1]! / 200);
    meanDensity /= cloud.count;
    // uniform sampling would average ~0.5; rejection sampling above 0.5 must beat that clearly
    expect(meanDensity).toBeGreaterThan(0.56);
  });

  it('SpriteBuilder packs attributes in the layout the shaders read', () => {
    const b = new SpriteBuilder();
    b.push(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11);
    const s = b.build();
    expect(Array.from(s.pos)).toEqual([1, 2, 3, 4]);
    expect(Array.from(s.shape)).toEqual([5, 6, 7, 0]);
    expect(Array.from(s.color)).toEqual([8, 9, 10, 11]);
  });
});

describe('palette ramps for scenery', () => {
  it('splits every stage palette into its declared ramps, dark to light', () => {
    for (const info of Object.values(STAGES)) {
      const ramps = paletteRamps(info);
      expect(ramps.reduce((a, r) => a + r.length, 0)).toBe(info.palette.length);
      for (const r of ramps) {
        const lum = r.map((c) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722);
        for (let i = 1; i < lum.length; i++) expect(lum[i]!).toBeGreaterThanOrEqual(lum[i - 1]! - 1e-6);
      }
    }
  });

  it('linear conversion and interpolation behave', () => {
    expect(hexLinear('#000000')).toEqual([0, 0, 0]);
    expect(hexLinear('#ffffff')[0]).toBeCloseTo(1, 6);
    expect(hexLinear('#808080')[0]).toBeCloseTo(0.2158, 3);
    const ramp = paletteRamps(STAGES.nursery)[2]!;
    expect(rampAt(ramp, 0)).toEqual(ramp[0]);
    expect(rampAt(ramp, 1)).toEqual(ramp[ramp.length - 1]);
    expect(mixRgb([0, 0, 0], [1, 2, 4], 0.5)).toEqual([0.5, 1, 2]);
  });
});

/** The kit can be constructed without a GL context (three objects are only realised on first render). */
function testKit(): SceneryKit {
  const init = {
    renderer: null,
    info: STAGES.nursery,
    quality: 2,
    width: 1280,
    height: 720,
  } as unknown as SceneryInit;
  return new SceneryKit(init, 1);
}

describe('AmbientLife (comets and supernova flares)', () => {
  const opts = {
    seed: 77,
    parallax: 0.05,
    cometColor: [0.7, 0.85, 1] as [number, number, number],
    flareColor: [1, 0.7, 0.8] as [number, number, number],
    comets: 2,
    cometPeriod: [16, 27] as [number, number],
    cometLife: 6.5,
    flares: 2,
    flarePeriod: [9, 17] as [number, number],
    region: { x0: 0, y0: 10, x1: 660, y1: 230 },
  };
  const snapshot = (kit: SceneryKit, life: AmbientLife, t: number): number[] => {
    life.update(t);
    const out: number[] = [];
    for (const l of kit.layers) {
      for (const n of ['aPos', 'aShape', 'aColor'])
        out.push(...Array.from(l.mesh.geometry.getAttribute(n).array as Float32Array));
    }
    return out;
  };

  it('is a pure function of time: same clock → identical sprites, independent of call history', () => {
    const k1 = testKit();
    const k2 = testKit();
    const a = new AmbientLife(k1, opts);
    const b = new AmbientLife(k2, opts);
    // b visits other times first
    for (const t of [3, 50, 12.5, 0.1]) snapshot(k2, b, t);
    for (const t of [0, 7.25, 19.5, 31, 64.2, 120]) expect(snapshot(k1, a, t)).toEqual(snapshot(k2, b, t));
    k1.dispose();
    k2.dispose();
  });

  it('comets appear, cross the sky and leave; flares flash and fade', () => {
    const kit = testKit();
    const life = new AmbientLife(kit, opts);
    let cometFrames = 0;
    let flareFrames = 0;
    let maxHeadBright = 0;
    for (let t = 0; t < 120; t += 0.1) {
      life.update(t);
      const heads = kit.layers.find((l) => l.name === 'ambient-heads')!;
      const pos = heads.mesh.geometry.getAttribute('aPos').array as Float32Array;
      const col = heads.mesh.geometry.getAttribute('aColor').array as Float32Array;
      for (let i = 0; i < 4; i++) {
        if (pos[i * 4]! > -9000) {
          if (i < 2) cometFrames++;
          else flareFrames++;
          maxHeadBright = Math.max(maxHeadBright, col[i * 4]!);
          expect(pos[i * 4]!).toBeGreaterThan(-400);
          expect(pos[i * 4]!).toBeLessThan(1200);
        }
      }
    }
    expect(cometFrames).toBeGreaterThan(20);
    expect(flareFrames).toBeGreaterThan(20);
    expect(maxHeadBright).toBeGreaterThan(1);
    kit.dispose();
  });

  it('parks idle sprites far off-screen with zero brightness', () => {
    const kit = testKit();
    const life = new AmbientLife(kit, opts);
    life.update(1000.3);
    let parked = 0;
    for (const l of kit.layers) {
      const pos = l.mesh.geometry.getAttribute('aPos').array as Float32Array;
      const col = l.mesh.geometry.getAttribute('aColor').array as Float32Array;
      for (let i = 0; i < pos.length / 4; i++) {
        if (pos[i * 4]! >= -9000) continue;
        parked++;
        expect(col[i * 4]!).toBe(0); // parked sprites carry no light either
      }
    }
    expect(parked).toBeGreaterThan(0);
    kit.dispose();
  });
});
