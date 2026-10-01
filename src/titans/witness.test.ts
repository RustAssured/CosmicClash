import { describe, expect, it } from 'vitest';
import { DEFAULT_LIGHTING, hex, pb, pg, pr, rgbToHsl } from '@/contracts';
import { paintWitness, WITNESS_MATERIALS, type WitnessBody } from './art/lastone';
import { generateTitanBody } from './generate';
import { getTitanDef } from '@/titans';

const W: WitnessBody = paintWitness(1234, DEFAULT_LIGHTING);

/** Live extent of the Planet's painted body (its visible diameter). */
function planetDiameter(): number {
  const m = generateTitanBody(getTitanDef('planet'), 1234, DEFAULT_LIGHTING).map;
  let x0 = m.w;
  let x1 = -1;
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++)
      if (m.material[y * m.w + x] !== 0) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
      }
  return x1 - x0 + 1;
}

/**
 * Is a packed colour red/orange (hue < 30° or ≥ 340°, saturated, mid lightness)? Dead gold and bronze (hue ≈ 40–48°) and pale
 * white-gold highlights are not.
 */
const isWarmWound = (c: number): boolean => {
  const [h, s, l] = rgbToHsl(pr(c), pg(c), pb(c));
  return (h < 30 / 360 || h > 340 / 360) && s > 0.45 && l > 0.25 && l < 0.8;
};

describe('The Witness painter v1 (rest pose, region bodies)', () => {
  it('is deterministic', () => {
    const b = paintWitness(1234, DEFAULT_LIGHTING);
    expect(b.regions.length).toBe(W.regions.length);
    for (let k = 0; k < W.regions.length; k++) {
      expect(Array.from(b.regions[k]!.map.baseColor)).toEqual(Array.from(W.regions[k]!.map.baseColor));
      expect(Array.from(b.regions[k]!.map.material)).toEqual(Array.from(W.regions[k]!.map.material));
    }
  });

  it('has the silhouette hierarchy as separate regions: eye, carapace + 3 interior layers, shrine, 4 halo arcs, 4 asymmetric arms', () => {
    const count = (k: string): number => W.regions.filter((r) => r.kind === k).length;
    expect(count('eye')).toBe(1);
    expect(count('carapace')).toBe(1);
    expect(count('interior')).toBe(3);
    expect(count('shrine')).toBe(1);
    expect(count('halo')).toBe(4);
    expect(count('arm')).toBe(12);
    // four arms with different joint counts (wrong at the second glance), each with its joint chain
    expect(W.arms).toHaveLength(4);
    expect(new Set(W.arms.map((a) => a.regions.length)).size).toBeGreaterThan(1);
    for (const a of W.arms) expect(a.points).toHaveLength(a.regions.length + 1);
    expect(W.membranes.length).toBeGreaterThanOrEqual(2);
    expect(W.fibres.length).toBeGreaterThanOrEqual(2);
    // the rig graph: one root (the eye), every parent precedes its child, interior layers are welded to the carapace
    expect(W.regions.filter((r) => r.parent < 0).map((r) => r.key)).toEqual(['eye']);
    W.regions.forEach((r, i) => expect(r.parent).toBeLessThan(i));
    for (const r of W.regions.filter((q) => q.kind === 'interior')) {
      expect(r.weld).toBe(true);
      expect(W.regions[r.parent]!.kind).toBe('carapace');
    }
    expect(new Set(W.regions.filter((r) => r.layer >= 0).map((r) => r.layer))).toEqual(new Set([0, 1, 2, 3]));
  });

  it('every region is one 4-connected body with its anchor on matter', () => {
    for (const r of W.regions) {
      const m = r.map;
      const a = m.coreY * m.w + m.coreX;
      expect(m.material[a]).not.toBe(0);
      const seen = new Uint8Array(m.w * m.h);
      const st = [a];
      seen[a] = 1;
      let n = 0;
      while (st.length) {
        const i = st.pop()!;
        n++;
        const x = i % m.w;
        for (const j of [i - 1, i + 1, i - m.w, i + m.w]) {
          if (j < 0 || j >= m.material.length || seen[j] || m.material[j] === 0) continue;
          if ((j === i - 1 && x === 0) || (j === i + 1 && x === m.w - 1)) continue;
          seen[j] = 1;
          st.push(j);
        }
      }
      let live = 0;
      for (let i = 0; i < m.material.length; i++) if (m.material[i] !== 0) live++;
      expect(n, r.key).toBe(live);
      expect(live, r.key).toBeGreaterThan(100);
    }
  });

  it('hangs: 1.25–1.5× the Planet tall, ≤ 200 px wide, a big shrine, a large halo, a dominant eye, within budget', () => {
    const height = W.y1 - W.y0;
    const ratio = height / planetDiameter();
    expect(ratio).toBeGreaterThanOrEqual(1.25);
    expect(ratio).toBeLessThanOrEqual(1.5);
    const eye = W.regions.find((r) => r.kind === 'eye')!;
    let ex0 = Infinity;
    let ex1 = -Infinity;
    for (let y = 0; y < eye.map.h; y++)
      for (let x = 0; x < eye.map.w; x++) {
        const m = eye.map.material[y * eye.map.w + x]!;
        if (m === 0 || WITNESS_MATERIALS[m - 1]!.key === 'gold') continue;
        ex0 = Math.min(ex0, x);
        ex1 = Math.max(ex1, x);
      }
    const eyeFrac = (ex1 - ex0 + 1) / height;
    // the eye stays the central event; with the taller halo and chandelier it is a third of the height
    expect(eyeFrac).toBeGreaterThanOrEqual(0.3);
    expect(eyeFrac).toBeLessThanOrEqual(0.4);
    const width = W.x1 - W.x0;
    expect(width).toBeLessThanOrEqual(200);
    expect(height).toBeGreaterThanOrEqual(width * 0.9);
    // the chandelier hangs well below the carapace: ≥ 25 % of the height
    const car = W.regions.find((r) => r.kind === 'carapace')!;
    const shrine = W.regions.find((r) => r.kind === 'shrine')!;
    let carBottom = -Infinity;
    let shrineBottom = -Infinity;
    for (const [r, set] of [
      [car, (v: number) => (carBottom = Math.max(carBottom, v))],
      [shrine, (v: number) => (shrineBottom = Math.max(shrineBottom, v))],
    ] as const)
      for (let y = 0; y < r.map.h; y++)
        for (let x = 0; x < r.map.w; x++) if (r.map.material[y * r.map.w + x] !== 0) set(y + r.oy + 1);
    expect((shrineBottom - carBottom) / height).toBeGreaterThanOrEqual(0.25);
    // the halo ring is 1.3–1.5× the carapace's radius
    const maxR = (kind: string): number => {
      let m = 0;
      for (const r of W.regions.filter((q) => q.kind === kind))
        for (let y = 0; y < r.map.h; y++)
          for (let x = 0; x < r.map.w; x++)
            if (r.map.material[y * r.map.w + x] !== 0)
              m = Math.max(m, Math.hypot(x + r.ox + 0.5, y + r.oy + 0.5 - 6));
      return m;
    };
    const haloMid = W.regions
      .filter((r) => r.kind === 'halo')
      .map((r) => Math.hypot(r.map.coreX + r.ox + 0.5, r.map.coreY + r.oy + 0.5));
    const ratioHalo = Math.min(...haloMid) / maxR('carapace');
    expect(ratioHalo).toBeGreaterThanOrEqual(1.25);
    expect(ratioHalo).toBeLessThanOrEqual(1.5);
    expect(W.cells).toBeLessThanOrEqual(26000);
  });

  it('the eye is the KO core: its anchor is the (off-centre) pupil, with the largest core radius', () => {
    const eye = W.regions[0]!;
    expect(eye.kind).toBe('eye');
    const m = eye.map;
    // the pupil sits a little off the sclera's centre (it tracks)
    const d = Math.hypot(m.coreX + eye.ox + 0.5, m.coreY + eye.oy + 0.5);
    expect(d).toBeGreaterThan(1);
    expect(d).toBeLessThan(5);
    expect(WITNESS_MATERIALS[m.material[m.coreY * m.w + m.coreX]! - 1]!.key).toBe('pupil');
    for (const r of W.regions.slice(1)) expect(r.map.coreRadius).toBeLessThan(m.coreRadius);
  });

  it('wound light is white-gold and cyan: no red/orange crack, heat-glow or painted pixel anywhere', () => {
    for (const spec of WITNESS_MATERIALS) {
      expect(isWarmWound(hex(spec.visual.crack)), spec.key).toBe(false);
      for (const g of spec.visual.glowRamp ?? [])
        expect(isWarmWound(hex(g)), `${spec.key} glow ${g}`).toBe(false);
    }
    let warm = 0;
    let total = 0;
    for (const r of W.regions)
      for (let i = 0; i < r.map.baseColor.length; i++) {
        if (r.map.material[i] === 0) continue;
        total++;
        if (isWarmWound(r.map.baseColor[i]!)) warm++;
      }
    // dead gold and tarnished bronze are allowed; saturated red/orange is not
    expect(warm / total).toBeLessThan(0.01);
  });
});
