import { describe, expect, it } from 'vitest';
import { buildVfxInstances, VFX_MAX_AGE, VFX_WEIGHTS, type VfxImpact, type VfxWeight } from './vfx';

const impact = (weight: VfxWeight, age: number, matter: VfxImpact['matter'] = 'rock'): VfxImpact => ({
  x: 320,
  y: 180,
  weight,
  age,
  dirX: 1,
  dirY: 0,
  seed: 4242,
  matter,
});
const kinds = (out: Float32Array, n: number): number[] => Array.from({ length: n }, (_, i) => out[i * 12]!);
const K = { pin: 0, pull: 1, star: 2, rock: 3, spark: 4, dust: 5, edge: 6 };

describe('shared impact VFX (shared/VFX_SPEC.md)', () => {
  it('keeps to the spec timings at 60 fps for every weight', () => {
    for (const w of VFX_WEIGHTS) {
      expect(w.pinFrames).toBeGreaterThanOrEqual(1);
      expect(w.pinFrames).toBeLessThanOrEqual(2);
      expect(w.flashFrames).toBeGreaterThanOrEqual(3);
      expect(w.flashFrames).toBeLessThanOrEqual(5);
      expect(w.flashSteps).toBeGreaterThanOrEqual(4);
      expect(w.flashSteps).toBeLessThanOrEqual(6);
      expect(w.ringFrames).toBeGreaterThanOrEqual(8);
      expect(w.ringFrames).toBeLessThanOrEqual(20);
      expect(w.debrisLife[0]).toBeGreaterThanOrEqual(0.5);
      expect(w.debrisLife[1]).toBeLessThanOrEqual(2);
      expect(w.dustLife[0]).toBeGreaterThanOrEqual(1);
      expect(w.dustLife[1]).toBeLessThanOrEqual(3);
    }
  });

  it('scales every element with the weight: light < medium < heavy < catastrophic', () => {
    for (let i = 1; i < 4; i++) {
      const a = VFX_WEIGHTS[i - 1]!;
      const b = VFX_WEIGHTS[i]!;
      expect(b.flashPx).toBeGreaterThan(a.flashPx);
      expect(b.ringPx).toBeGreaterThan(a.ringPx);
      expect(b.sparks).toBeGreaterThan(a.sparks);
      expect(b.debris).toBeGreaterThanOrEqual(a.debris);
      expect(b.dust).toBeGreaterThan(a.dust);
    }
  });

  it('plays the recipe in order: anticipation, then the star flash and the ring, then debris and dust', () => {
    const out = new Float32Array(1024 * 12);
    const at = (age: number): number[] => kinds(out, buildVfxInstances([impact(2, age)], 0, 0, out).count);
    expect(at(0)).toEqual(expect.arrayContaining([K.pin, K.pull]));
    expect(at(0)).not.toContain(K.star);
    expect(at(1 / 60)).toEqual(expect.arrayContaining([K.star, K.edge]));
    expect(at(6 / 60)).not.toContain(K.star);
    expect(at(0.5)).toEqual(expect.arrayContaining([K.rock, K.dust]));
    expect(at(0.5)).not.toContain(K.edge);
    expect(at(2.2)).toContain(K.dust);
    expect(at(VFX_MAX_AGE + 0.1)).toEqual([]);
  });

  it('draws the flash on top of the debris thrown from under it', () => {
    const out = new Float32Array(1024 * 12);
    const ks = kinds(out, buildVfxInstances([impact(3, 1 / 60)], 0, 0, out).count);
    expect(ks.lastIndexOf(K.star)).toBe(ks.length - 1);
  });

  it('feeds the distortion ring to the post pass (flattened toward the camera), from the frame after contact', () => {
    const out = new Float32Array(1024 * 12);
    const data = new Float32Array(32);
    const ell = new Float32Array(8);
    expect(buildVfxInstances([impact(1, 0)], 0, 0, out, { data, ell, start: 0, max: 8 }).shocks).toBe(0);
    const r = buildVfxInstances([impact(1, 3 / 60)], 0, 0, out, { data, ell, start: 2, max: 8 });
    expect(r.shocks).toBe(1);
    expect(data[8]).toBe(320);
    expect(data[10]).toBeGreaterThan(0);
    expect(ell[2]).toBeLessThan(1);
  });

  it('is a pure function of age and seed (replays and captures are exact)', () => {
    const a = new Float32Array(1024 * 12);
    const b = new Float32Array(1024 * 12);
    const ims = [impact(3, 0.4), impact(1, 0.1, 'witness')];
    const na = buildVfxInstances(ims, 10, 20, a).count;
    const nb = buildVfxInstances(ims, 10, 20, b).count;
    expect(na).toBe(nb);
    expect(Array.from(a.subarray(0, na * 12))).toEqual(Array.from(b.subarray(0, nb * 12)));
    // integer pixel positions: no sub-pixel sprites
    for (let i = 0; i < na; i++) {
      expect(Number.isInteger(a[i * 12 + 1])).toBe(true);
      expect(Number.isInteger(a[i * 12 + 2])).toBe(true);
    }
  });

  it("leaves 우리's torn chunks to its own matter: no debris sprites for uri", () => {
    const out = new Float32Array(1024 * 12);
    expect(kinds(out, buildVfxInstances([impact(3, 0.3, 'uri')], 0, 0, out).count)).not.toContain(K.rock);
  });
});
