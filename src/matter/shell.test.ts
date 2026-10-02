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
    expect(world.swapShell(id, 1)).toBe(true);
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
    world.swapShell(id, 1);
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
    world.swapShell(id, 1);
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
      world.swapShell(id, 1);
      expect(world.diagnostics().heldSlabs).toBe(0);
      run(world, 60);
      world.applyDamage(id, blow('CRUSH', 362, 262, 800));
      run(world, 60);
      world.swapShell(id, 1);
      run(world, 30);
      expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
      return world.hash();
    };
    expect(go()).toBe(go());
  });

  it('a time-sliced swap moves a band of rows per tick, drawn = hit-tested every tick, and ends byte-identical to a one-shot swap', () => {
    const arrays = (tb: TestBody): Uint8Array[] => snapshot(tb);
    const make = (): { tb: TestBody; world: MatterWorldEx; id: number } => {
      const p = planet(11);
      p.world.defineShell(p.id, p.innerR);
      p.world.applyDamage(p.id, blow('KINETIC', 360, 258, 900));
      run(p.world, 60);
      p.world.settleBody(p.id);
      return p;
    };
    const a = make();
    const b = make();
    const before = arrays(b.tb);
    expect(a.world.swapShell(a.id, 1)).toBe(true);
    const oneShot = arrays(a.tb);
    run(a.world, 18);
    const oneShotLater = arrays(a.tb);
    expect(b.world.swapShell(b.id)).toBe(true);
    expect(b.world.swapShell(b.id)).toBe(false); // one at a time
    const { w, h } = b.tb.map;
    let ticks = 0;
    while (b.world.shellProgress(b.id) < 1) {
      b.world.tick();
      ticks++;
      const done = Math.round(b.world.shellProgress(b.id) * h);
      if (b.world.shellProgress(b.id) < 1) {
        expect(done).toBeGreaterThan(0);
        // every row is wholly one face: moved rows the new face, the rest still the old one
        const mat = b.tb.map.material;
        let wrong = 0;
        for (let c = 0; c < w * h; c++)
          if (mat[c] !== (c < done * w ? oneShot[0]![c] : before[0]![c])) wrong++;
        expect(wrong).toBe(0);
      }
      // what is drawn is what can be hit
      const px = b.tb.map.pixels;
      let bad = 0;
      for (let c = 0; c < w * h; c++) if ((px[c]! >>> 24 !== 0) !== (b.tb.map.material[c] !== 0)) bad++;
      expect(bad).toBe(0);
    }
    expect(ticks).toBe(18);
    expect(b.world.shellFace(b.id)).toBe(1);
    const sliced = arrays(b.tb);
    for (let k = 0; k < sliced.length; k++) expect(sliced[k]).toEqual(oneShotLater[k]);
    // and back again: two sliced swaps are the identity
    b.world.swapShell(b.id);
    run(b.world, 18);
    const back = arrays(b.tb);
    for (let k = 0; k < back.length; k++) expect(back[k]).toEqual(before[k]);
    expect(Math.abs(b.world.ledger().error)).toBeLessThan(1e-3);
  });

  it('blows during a sliced swap hold no slabs and keep the ledger exact; deterministic', () => {
    const go = (): number => {
      const { world, id, innerR } = planet(13);
      world.defineShell(id, innerR);
      world.swapShell(id);
      for (let t = 0; t < 18; t++) {
        if (t % 5 === 0)
          world.applyDamage(id, blow(t % 10 === 0 ? 'CRUSH' : 'FRACTURE', 360, 240 + t * 2, 700));
        world.tick();
        // no slab is held across moving rows (what the blows free leaves when the last band has moved)
        if (world.shellProgress(id) < 1) expect(world.diagnostics().heldSlabs).toBe(0);
      }
      run(world, 40);
      expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
      return world.hash();
    };
    expect(go()).toBe(go());
  });

  it('a painted far face (proposal 135) comes round exactly as painted, born-bonded, and goes back exactly', () => {
    const { tb, world, id, innerR } = planet(15);
    const { w, h, coreX, coreY } = tb.map;
    const n = w * h;
    const snap = world.core.bodyById[id]!.snap;
    // the far side: the same disc outline, but other continents (shift the material pattern by a third of the width) and its own light
    const far = {
      material: new Uint8Array(n),
      density: new Uint8Array(n).fill(128),
      height: new Uint8Array(n).fill(90),
      baseColor: new Uint32Array(n),
    };
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const c = y * w + x;
        if (snap.material[c] === 0) continue;
        const sx = (x + Math.floor(w / 3)) % w;
        far.material[c] = snap.material[y * w + sx] || snap.material[c]!;
        far.baseColor[c] = 0xff000000 | (x * 2) | ((y * 2) << 8);
      }
    expect(world.defineShell(id, innerR, { ...far, material: new Uint8Array(3) })).toBe(false); // wrong size
    expect(world.defineShell(id, innerR, far)).toBe(true);
    const before = snapshot(tb);
    const m0 = world.stats(id).mass;
    world.swapShell(id, 1);
    let shellCells = 0;
    let wrong = 0;
    let bonded = 0;
    let pairs = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const c = y * w + x;
        const dx = x + 0.5 - (coreX + 0.5);
        const dy = y + 0.5 - (coreY + 0.5);
        if (dx * dx + dy * dy <= innerR * innerR) continue;
        shellCells++;
        if (tb.map.material[c] !== far.material[c]) wrong++;
        if (far.material[c] !== 0 && tb.map.baseColor[c] !== (far.baseColor[c]! | 0xff000000) >>> 0) wrong++;
        if (x < w - 1 && tb.map.material[c] !== 0 && tb.map.material[c + 1] !== 0) {
          pairs++;
          if (tb.map.bondR[c]! > 0) bonded++;
        }
      }
    expect(shellCells).toBeGreaterThan(1000);
    expect(wrong).toBe(0);
    expect(bonded).toBe(pairs);
    expect(world.stats(id).mass).toBeCloseTo(m0, 6);
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);
    world.swapShell(id, 1);
    const back = snapshot(tb);
    for (let k = 0; k < back.length; k++) expect(back[k]).toEqual(before[k]);
  });

  it('the far face adds tactics, not durability: one-face initial mass, loss on either face counts 1:1', () => {
    const plain = planet(17);
    const { world, id, innerR } = planet(17);
    world.refresh(id);
    const initial = world.stats(id).initialMass;
    world.defineShell(id, innerR);
    world.refresh(id);
    expect(world.stats(id).initialMass).toBeCloseTo(plain.world.stats(plain.id).initialMass, 9);
    expect(world.stats(id).initialMass).toBeCloseTo(initial, 9);
    expect(world.stats(id).massFrac).toBeCloseTo(plain.world.stats(plain.id).massFrac, 9);
    const cells0 = world.ledger().cellMass;
    const lost0 = world.stats(id).initialMass - world.stats(id).mass;
    world.applyDamage(id, blow('CRUSH', 360, 260, 900));
    run(world, 60);
    world.swapShell(id);
    run(world, 20);
    world.applyDamage(id, blow('KINETIC', 362, 250, 900));
    run(world, 60);
    world.refresh(id);
    const s = world.stats(id);
    const lostCells = cells0 - world.ledger().cellMass; // matter gone from both faces and the core
    expect(lostCells).toBeGreaterThan(60);
    expect(s.initialMass - s.mass - lostCells - lost0).toBeCloseTo(-world.core.bodyById[id]!.pool, 6);
  });

  it('restore brings both faces back; bodies without a shell are untouched by the API', () => {
    const { tb, world, id, innerR } = planet(9);
    const pristine = tb.map.material.slice();
    world.defineShell(id, innerR);
    world.applyDamage(id, blow('CRUSH', 360, 260, 900));
    run(world, 40);
    world.swapShell(id, 1);
    world.applyDamage(id, blow('CRUSH', 360, 260, 900));
    run(world, 40);
    world.restore(id);
    world.refresh(id);
    const s = world.stats(id);
    expect(s.mass).toBeCloseTo(s.initialMass, 3);
    world.swapShell(id, 1); // back to the original face, pristine too
    expect(Array.from(tb.map.material)).toEqual(Array.from(pristine));
    expect(Math.abs(world.ledger().error)).toBeLessThan(1e-3);

    const other = createMatterWorld(1);
    const oid = other.createBody(layeredDisc({ size: 30, seed: 2, x: 300, y: 200 }).spec).id;
    expect(other.swapShell(oid)).toBe(false);
    expect(other.shellFace(oid)).toBe(-1);
  });
});
