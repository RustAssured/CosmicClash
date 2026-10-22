import { describe, expect, it } from 'vitest';
import { makeLab } from '@/combat/testing/feelLab';
import { SIG_ROLE, type RenderLayerSig } from './signature';

/** The signature animation (docs/SIGNATURE.md) is render-only data on the body layer: the Black Hole opts in. */
describe('signature animation: the Black Hole', () => {
  it('its body layer carries a signature whose roles cover the disk, the horizon and the lensed arcs', () => {
    const lab = makeLab({ a: 'blackhole', b: 'planet' });
    for (let i = 0; i < 5; i++) lab.step();
    const view = { x0: 0, y0: 0, w: 640, h: 360 };
    const L = lab.f0.renderLayers(view, 0.5)[0] as RenderLayerSig;
    const s = L.signature!;
    expect(s).toBeDefined();
    expect(s.roles.length).toBe(L.w * L.h);
    const count = (r: number): number => s.roles.reduce((n, v) => n + (v === r ? 1 : 0), 0);
    expect(count(SIG_ROLE.flow)).toBeGreaterThan(3000);
    expect(count(SIG_ROLE.occluder)).toBeGreaterThan(1000);
    expect(count(SIG_ROLE.lensed)).toBeGreaterThan(100);
    // the centre is the horizon; its clock follows the snapshotted tick and the render alpha, never the wall clock
    const map = lab.f0.body.map;
    expect(s.roles[Math.floor(s.cy) * map.w + Math.floor(s.cx)]).toBe(SIG_ROLE.occluder);
    const t = s.t;
    const spin = s.spin;
    lab.f0.renderLayers(view, 0.5);
    expect([s.t, s.spin]).toEqual([t, spin]);
    lab.step();
    lab.f0.renderLayers(view, 0.5);
    expect(s.t).toBeGreaterThan(t);
    expect(s.spin).toBeGreaterThan(spin);
  });
});
