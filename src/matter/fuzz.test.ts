import { describe, it } from 'vitest';
import { DAMAGE_TYPES, Rng, type DamageEvent, type DamageShape } from '@/contracts';
import { createMatterWorld, type MatterWorldEx } from './index';
import {
  blackHole,
  bridge,
  celadonBody,
  gasPlanet,
  latticeDisc,
  layeredDisc,
  ribbedSlab,
  sparseLattice,
  star,
  uniformDisc,
} from './testing/bodies';

/**
 * Fuzz: random damage (all types, shapes, flags, extreme energies, fractional positions, mirrored/leaning bodies, gravity wells,
 * lifecycle calls) must never throw, corrupt the cell arrays, lose mass or produce non-finite state.
 */
function randomShape(rng: Rng, cx: number, cy: number): DamageShape {
  const x = cx + (rng.next() - 0.5) * 220;
  const y = cy + (rng.next() - 0.5) * 160;
  switch (rng.int(5)) {
    case 0:
      return { kind: 'point', x, y, r: 0.2 + rng.next() * 40 };
    case 1:
      return {
        kind: 'line',
        x0: x,
        y0: y,
        x1: x + (rng.next() - 0.5) * 200,
        y1: y + (rng.next() - 0.5) * 160,
        width: rng.next() * 20,
      };
    case 2:
      return {
        kind: 'cone',
        x,
        y,
        dirX: rng.next() - 0.5,
        dirY: rng.next() - 0.5,
        range: 5 + rng.next() * 120,
        halfAngle: rng.next() * 3.1,
      };
    case 3:
      return { kind: 'ring', x, y, r0: rng.next() * 30, r1: rng.next() * 60 };
    default:
      return { kind: 'field', x, y, r: 3 + rng.next() * 120, falloff: rng.next() * 6 };
  }
}

function checkConsistent(world: MatterWorldEx): void {
  for (const b of world.core.bodyList) {
    const m = b.map;
    for (let i = 0; i < m.material.length; i++) {
      if (m.material[i] === 0) {
        if (m.integrity[i] !== 0 || m.bondR[i] !== 0 || m.bondD[i] !== 0 || m.pixels[i] !== 0)
          throw new Error(`void cell ${i} not clean`);
      } else {
        if (m.integrity[i] === 0) throw new Error(`live cell ${i} with zero integrity`);
        if (!Number.isFinite(m.temperature[i]!)) throw new Error('non-finite temperature');
      }
      const x = i % m.w;
      if (m.bondR[i] !== 0 && (x === m.w - 1 || m.material[i] === 0 || m.material[i + 1] === 0))
        throw new Error(`dangling bondR ${i}`);
      if (
        m.bondD[i] !== 0 &&
        (i + m.w >= m.material.length || m.material[i] === 0 || m.material[i + m.w] === 0)
      )
        throw new Error(`dangling bondD ${i}`);
    }
    const s = world.stats(b.id);
    for (const v of [s.mass, s.massFrac, s.coreIntegrity, s.exposedCoreFrac, s.anchoredFrac])
      if (!Number.isFinite(v)) throw new Error('non-finite stats');
    for (const v of s.regionGrid) if (!Number.isFinite(v)) throw new Error('non-finite regionGrid');
  }
  const l = world.ledger();
  if (Math.abs(l.error) > 0.05) throw new Error(`ledger error ${l.error}`);
}

describe('fuzz', () => {
  const makers = [
    layeredDisc,
    ribbedSlab,
    celadonBody,
    latticeDisc,
    sparseLattice,
    gasPlanet,
    star,
    blackHole,
    bridge,
    (o: object) => uniformDisc('ice', o),
  ];
  for (let scenario = 0; scenario < 24; scenario++) {
    it(`random barrage #${scenario} keeps every invariant`, () => {
      const rng = new Rng(1000 + scenario);
      const world = createMatterWorld(scenario + 1);
      const ids: number[] = [];
      const facings = [1, -1] as const;
      for (let k = 0; k < 2; k++) {
        const mk = makers[rng.int(makers.length)]!;
        const tb = mk({
          size: undefined,
          seed: rng.int(100),
          x: 260 + k * 320 + rng.next(),
          y: 260 + rng.next() * 20,
          facing: facings[k],
          ownerSlot: k as 0 | 1,
        });
        tb.spec.transform.lean = rng.int(15) - 7;
        ids.push(world.createBody(tb.spec).id);
      }
      if (scenario % 2 === 0)
        world.setGravitySource(1, {
          x: 580,
          y: 280,
          strength: 350,
          radius: 300,
          consumeRadius: 14,
          creditBodyId: ids[1]!,
        });
      for (let t = 0; t < 260; t++) {
        const events = 1 + rng.int(2);
        for (let e = 0; e < events && t % 3 === 0; e++) {
          const target = rng.int(2);
          const energyRoll = rng.next();
          const ev: DamageEvent = {
            type: DAMAGE_TYPES[rng.int(6)]!,
            shape: randomShape(rng, 260 + target * 320, 280),
            energy:
              energyRoll < 0.05 ? 0 : energyRoll < 0.1 ? 1e5 : energyRoll < 0.15 ? -5 : 5 + rng.next() * 1500,
            dirX: rng.next() - 0.5,
            dirY: rng.next() - 0.5,
            duration: rng.int(4) === 0 ? 1 + rng.int(40) : 1,
            sourceMass: rng.next() * 10,
            sourceBodyId: rng.int(3) - 1,
            originX: 200 + rng.next() * 400,
            originY: 200 + rng.next() * 150,
            flags: rng.int(128),
            params: {
              penetration: rng.int(2) ? rng.int(60) : undefined,
              crackSeeds: rng.int(6),
              crackStress: rng.int(2) ? rng.next() * 255 : undefined,
              heat: rng.int(3) === 0 ? rng.next() * 6000 : undefined,
              shock: rng.int(3) === 0 ? rng.next() * 400 : undefined,
              embed: rng.int(5),
              embedDelay: rng.int(90),
              latch: rng.next() * 255,
              harvest: rng.next(),
              pull: rng.next() * 3,
              compress: rng.int(20),
              crater: rng.int(3) === 0 ? rng.int(30) : undefined,
              scatter: rng.next() * 2,
            },
          };
          world.applyDamage(ids[target]!, ev);
        }
        if (t === 100) world.carve(ids[rng.int(2)]!, 0.5, 3);
        if (t === 180) world.heal(ids[rng.int(2)]!, 0.4, 5);
        if (t === 200) world.shed(ids[rng.int(2)]!, 200, 'blow');
        if (t === 210)
          world.grow(ids[rng.int(2)]!, {
            cells: 40,
            materialKey: world.core.bodyById[ids[0]!]!.materials[1]!.key,
          });
        world.tick();
        if (t % 65 === 0) checkConsistent(world);
      }
      checkConsistent(world);
      world.restore(ids[0]!);
      world.tick();
      checkConsistent(world);
      world.removeBody(ids[1]!);
      for (let i = 0; i < 30; i++) world.tick();
      checkConsistent(world);
    });
  }
});
