import { describe, expect, it } from 'vitest';
import { createMatterMap, type MatterBody } from '@/contracts';
import { asShape, makeFatShape } from './shapes';
import { makeLab, probeHit, type Lab } from './testing/feelLab';
import type { FakeWorld } from './testing/fakeWorld';

/** A solid 24×24 region body owned by fighter 1, placed `dx` px in front of (toward the attacker) and `dy` px from its anchor. */
function addRegion(lab: Lab, dx: number, dy: number, counts = true): MatterBody {
  const f = lab.f1;
  const map = createMatterMap(24, 24);
  for (let i = 0; i < map.material.length; i++) {
    map.material[i] = 1;
    map.integrity[i] = 255;
    map.density[i] = 128;
    map.baseColor[i] = 0xff8899aa;
    map.pixels[i] = 0xff8899aa;
  }
  map.coreX = 12;
  map.coreY = 12;
  const body = lab.m.world.createBody({
    kind: 'part',
    ownerSlot: f.slot,
    map,
    materials: f.body.materials,
    attributes: f.def.attributes,
    seed: 3,
    transform: {
      x: Math.round(f.px + dx),
      y: Math.round(f.py + dy),
      anchorX: 12,
      anchorY: 12,
      facing: 1,
      lean: 0,
    },
  });
  f.addRegion(body, counts);
  return body;
}

describe('multi-body fighters (region bodies, proposal 160)', () => {
  it('probe sees a region body, a blow on it is routed to it, and the fighter aggregates mass and bounds', () => {
    const lab = makeLab({ a: 'lastone', b: 'planet', gap: 300 });
    const f = lab.f1;
    // well in front of the Planet's own silhouette, toward the Witness
    const region = addRegion(lab, -150, 0);
    const before = f.view.bodyStats.mass;
    const sh = makeFatShape();
    sh.kind = 'point';
    sh.x = region.transform.x;
    sh.y = region.transform.y;
    sh.r = 6;
    expect(f.probe(asShape(sh)).cells).toBeGreaterThan(50);
    // the aggregate includes the region: more mass than the Planet's body alone
    lab.step();
    expect(f.view.bodyStats.mass).toBeGreaterThan(before);
    expect(f.view.boundsX0).toBeLessThanOrEqual(region.transform.x - 12);
    // a blow aimed at the region lands on the region body, not on the primary
    probeHit(lab, region.transform.x - f.view.x, 0, 600, 500);
    const log = (lab.m.world as FakeWorld).damageLog;
    expect(log[log.length - 1]!.bodyId).toBe(region.id);
    lab.step();
    expect(f.view.bodyStats.massFrac).toBeLessThan(1);
  });

  it('a severed region keeps counting as lost mass; a region that does not count leaves mass alone', () => {
    const lab = makeLab({ a: 'lastone', b: 'planet', gap: 300 });
    const f = lab.f1;
    const arm = addRegion(lab, -150, 0);
    lab.step();
    const withArm = f.view.bodyStats.massFrac;
    const armShare = lab.m.world.stats(arm.id).initialMass / f.view.bodyStats.initialMass;
    f.removeRegion(arm.id);
    lab.m.world.removeBody(arm.id);
    lab.step();
    expect(withArm).toBeGreaterThan(0.99);
    expect(armShare).toBeGreaterThan(0.002);
    // the arm's whole mass is gone from the fighter: massFrac drops by its share
    expect(f.view.bodyStats.massFrac).toBeCloseTo(withArm - armShare, 3);
    // a resource region (halo arc): probed and struck, but no part of the mass total
    const lab2 = makeLab({ a: 'lastone', b: 'planet', gap: 300 });
    const m0 = lab2.f1.view.bodyStats.mass;
    addRegion(lab2, -150, 0, false);
    lab2.step();
    expect(lab2.f1.view.bodyStats.mass).toBeCloseTo(m0, 3);
  });

  it('a blow across two bodies is split by the cells it touches on each', () => {
    const lab = makeLab({ a: 'lastone', b: 'planet', gap: 300 });
    const f = lab.f1;
    const a = addRegion(lab, -150, -14);
    const b = addRegion(lab, -150, 14);
    lab.step();
    probeHit(lab, a.transform.x - f.view.x, 0, 600, 500);
    const log = (lab.m.world as FakeWorld).damageLog;
    const ids = log.slice(-2).map((d) => d.bodyId);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });
});
