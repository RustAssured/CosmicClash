import { describe, expect, it } from 'vitest';
import type { DamageEvent } from '@/contracts';
import { createMatterWorld, type MatterWorldEx } from './index';
import { gasPlanet, layeredDisc, type TestBody } from './testing/bodies';

/**
 * The two-hemisphere world (S3's design, proposal 143): the shell (r > innerR) exists twice; a half-turn swaps the faces exactly,
 * the core is shared, the ledger stays exact and two swaps are the identity.
 */

const blow = (type: DamageEvent['type'], x: number, y: number, energy: number): DamageEvent => ({
  type,
  shape: { kind: 'point', x, y, r: 10 },
  energy,
  dirX: 1,
  dirY: 0,
  duration: 1,
  sourceMass: 6,
  sourceBodyId: -1,
  originX: x - 50,
  originY: y,
  flags: 0,
  params: { compress: 8 },
});

const run = (w: MatterWorldEx, n: number): void => {
  for (let i = 0; i < n; i++) w.tick();
};

function planet(seed = 3): { tb: TestBody; world: MatterWorldEx; id: number; innerR: number } {
  const tb = gasPlanet({ size: 46, seed, x: 400, y: 260 });
  const world = createMatterWorld(seed);
  const id = world.createBody(tb.spec).id;
  return { tb, world, id, innerR: Math.max(4, tb.map.coreRadius + 4) };
}

const snapshot = (tb: TestBody): Uint8Array[] => [
  tb.map.material.slice(),
  tb.map.density.slice(),
  tb.map.integrity.slice(),
  tb.map.bondR.slice(),
  tb.map.bondD.slice(),
  tb.map.flags.slice(),
];

describe('two-hemisphere shell', () => {
  it('the far face is the pristine world mirrored about the core column; the core does not move', () => {
    const { tb, world, id, innerR } = planet();
    expect(world.shellFace(id)).toBe(-1);
    expect(world.defineShell(id, innerR)).toBe(true);
    expect(world.defineShell(id, innerR)).toBe(false);
    world.settleBody(id);
    const before = tb.map.material.slice();
    const pristine = world.core.bodyById[id]!.snap.material.slice();
    const m0 = world.stats(id).mass;
    expect(world.swapShell(id)).toBe(true);
    expect(world.shellFace(id)).toBe(1);
    const { w, h, coreX, coreY } = tb.map;
    let mirrored = 0;
    let shell = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const c = y * w + x;
        const dx = x + 0.5 - (coreX + 0.5);
        const dy = y + 0.5 - (coreY + 0.5);
        if (dx * dx + dy * dy <= innerR * innerR) {
          expect(tb.map.material[c]).toBe(before[c]); // the core is shared
          continue;
        }
        const mx = 2 * coreX - x;
        if (mx < 0 || mx >= w) continue;
        shell++;
        if (tb.map.material[c] === pristine[y * w + mx]) mirrored++;
      }
    expect(shell).toBeGreaterThan(1000);
    expect(mirrored).toBe(shell);
    expect(world.stats(id).mass).toBeCloseTo(m0, 6);
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
  });

  it('damage stays on its face: the far face comes round pristine, and the wound comes back exactly', () => {
    const { tb, world, id, innerR } = planet(5);
    world.defineShell(id, innerR);
    const totalBefore = world.stats(id).initialMass;
    world.applyDamage(id, blow('CRUSH', 360, 260, 900));
    world.applyDamage(id, blow('KINETIC', 372, 240, 700));
    run(world, 80);
    const damaged = world.stats(id);
    const wounded = snapshot(tb);
    const nearLost = damaged.initialMass - damaged.mass;
    expect(nearLost).toBeGreaterThan(30);
    world.swapShell(id);
    world.refresh(id);
    const turned = world.stats(id);
    // the whole planet still weighs the same; only the face toward us changed
    expect(turned.mass).toBeCloseTo(damaged.mass, 6);
    expect(turned.initialMass).toBeCloseTo(totalBefore, 6);
    // the face now toward us is pristine where the wound was
    let voidNow = 0;
    let voidWounded = 0;
    for (let c = 0; c < tb.map.material.length; c++) {
      if (world.core.bodyById[id]!.snap.material[c] === 0) continue;
      if (tb.map.material[c] === 0) voidNow++;
      if (wounded[0]![c] === 0) voidWounded++;
    }
    expect(voidWounded).toBeGreaterThan(20);
    expect(voidNow).toBe(0);
    world.swapShell(id);
    const back = snapshot(tb);
    for (let k = 0; k < back.length; k++) expect(back[k]).toEqual(wounded[k]);
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
  });

  it('a swap with wounds and cuts in flight settles them first; deterministic', () => {
    const go = (): number => {
      const { world, id, innerR } = planet(7);
      world.defineShell(id, innerR);
      world.applyDamage(id, blow('FRACTURE', 362, 262, 800));
      world.applyDamage(id, blow('KINETIC', 366, 250, 800));
      world.tick();
      world.swapShell(id);
      expect(world.diagnostics().heldSlabs).toBe(0);
      run(world, 60);
      world.applyDamage(id, blow('CRUSH', 362, 262, 800));
      run(world, 60);
      world.swapShell(id);
      run(world, 30);
      expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
      return world.hash();
    };
    expect(go()).toBe(go());
  });

  it('restore brings both faces back; bodies without a shell are untouched by the API', () => {
    const { tb, world, id, innerR } = planet(9);
    const pristine = tb.map.material.slice();
    world.defineShell(id, innerR);
    world.applyDamage(id, blow('CRUSH', 360, 260, 900));
    run(world, 40);
    world.swapShell(id);
    world.applyDamage(id, blow('CRUSH', 360, 260, 900));
    run(world, 40);
    world.restore(id);
    world.refresh(id);
    const s = world.stats(id);
    expect(s.mass).toBeCloseTo(s.initialMass, 3);
    world.swapShell(id); // back to the original face, pristine too
    expect(Array.from(tb.map.material)).toEqual(Array.from(pristine));
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);

    const other = createMatterWorld(1);
    const oid = other.createBody(layeredDisc({ size: 30, seed: 2, x: 300, y: 200 }).spec).id;
    expect(other.swapShell(oid)).toBe(false);
    expect(other.shellFace(oid)).toBe(-1);
  });
});
