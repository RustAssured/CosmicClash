import { describe, expect, it } from 'vitest';
import type { RenderLayer } from '@/contracts';
import { makeLab } from './testing/feelLab';

/** Fighter hooks for titans that are never mirrored and whose primary body rotates (우리, proposal 173 notes). */
describe('behaviour hooks: mirrors(), decorateBodyLayer(), a rotating primary', () => {
  it('a titan that does not mirror is drawn and hit with facing +1 and no shear, while its facing still names the foe side', () => {
    const lab = makeLab({ gap: 220 });
    const f1 = lab.f1;
    (f1.behaviour as unknown as { mirrors(): boolean }).mirrors = () => false;
    for (let i = 0; i < 30; i++) lab.step();
    expect(f1.facing).toBe(-1); // the foe is on its left
    expect(f1.body.transform.facing).toBe(1);
    expect(f1.body.transform.lean).toBe(0);
    // the other fighter is untouched
    expect(lab.f0.body.transform.facing).toBe(lab.f0.facing);
  });

  it('the body layer is drawn as one rotated part once the primary rotates, at the transform, with the step it is hit at', () => {
    const lab = makeLab({ gap: 220 });
    const f0 = lab.f0;
    const view = { x0: 0, y0: 0, w: 640, h: 360 };
    const plain = f0.renderLayers(view, 0)[0]!;
    expect(plain.parts).toBeUndefined();
    f0.body.transform.rot = 37;
    const L = f0.renderLayers(view, 0)[0]!;
    const p = L.parts![0]!;
    expect(p.step).toBe(37);
    expect([p.px, p.py]).toEqual([f0.body.transform.anchorX, f0.body.transform.anchorY]);
    expect([p.sw, p.sh]).toEqual([f0.body.map.w, f0.body.map.h]);
    expect(p.wx).toBe(f0.body.transform.x);
  });

  it('decorateBodyLayer is offered the fighter body layer once, after attach', () => {
    const lab = makeLab({ gap: 220 });
    const seen: RenderLayer[] = [];
    const proto = Object.getPrototypeOf(lab.f0.behaviour) as { decorateBodyLayer(l: RenderLayer): void };
    const orig = proto.decorateBodyLayer;
    proto.decorateBodyLayer = (l: RenderLayer) => seen.push(l);
    try {
      const again = makeLab({ gap: 220 });
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen).toContain(again.f0.renderLayers({ x0: 0, y0: 0, w: 640, h: 360 }, 0)[0]);
    } finally {
      proto.decorateBodyLayer = orig;
    }
  });
});
