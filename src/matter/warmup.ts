import { DamageFlag, LOGICAL_H, LOGICAL_W, Rng, type DamageEvent, type DamageType } from '@/contracts';
import { celadonBody, latticeDisc, layeredDisc } from './testing/bodies';
import { createMatterWorld } from './world';

const TYPES: readonly DamageType[] = ['FRACTURE', 'KINETIC', 'CRUSH', 'THERMAL', 'TIDAL', 'ASSIMILATION'];

function warmEvent(rng: Rng, kind: number, targetX: number, srcX: number): DamageEvent {
  const type = TYPES[kind % TYPES.length]!;
  const dir = Math.sign(targetX - srcX) || 1;
  const ty = 260 + rng.next() * 80;
  const tx = targetX - dir * (6 + rng.next() * 30);
  const base = {
    dirX: dir,
    dirY: (rng.next() - 0.5) * 0.5,
    duration: 1,
    sourceMass: 6,
    sourceBodyId: 0,
    originX: srcX,
    originY: 300,
    flags: 0,
    params: {},
  };
  switch (type) {
    case 'FRACTURE':
      return {
        ...base,
        type,
        energy: 200 + rng.next() * 300,
        shape: { kind: 'line', x0: tx - dir * 20, y0: ty - 14, x1: tx + dir * 40, y1: ty + 14, width: 5 },
        flags: DamageFlag.SEED_CRACK,
        params: { crackSeeds: 3 },
      };
    case 'KINETIC':
      return {
        ...base,
        type,
        energy: 200 + rng.next() * 300,
        shape: { kind: 'point', x: tx, y: ty, r: 7 },
        flags: DamageFlag.EMBED,
        params: { embed: 3, embedDelay: 30 },
      };
    case 'CRUSH':
      return {
        ...base,
        type,
        energy: 500 + rng.next() * 700,
        shape: { kind: 'point', x: tx, y: ty, r: 14 },
        params: { compress: 12, shock: 1 },
      };
    case 'THERMAL':
      return {
        ...base,
        type,
        energy: 80 + rng.next() * 120,
        shape: { kind: 'point', x: tx, y: ty, r: 16 },
        params: { shock: kind % 2 ? 150 : 0 },
      };
    case 'TIDAL':
      return {
        ...base,
        type,
        energy: 5,
        duration: 24,
        flags: DamageFlag.CONTINUOUS,
        shape: { kind: 'field', x: targetX, y: 300, r: 110, falloff: 1.4 },
        params: { pull: 1.2 },
      };
    default:
      return {
        ...base,
        type,
        energy: 250,
        shape: { kind: 'point', x: tx, y: ty, r: 12 },
        flags: DamageFlag.LATCH,
        params: { latch: 200, harvest: 0.7 },
      };
  }
}

/**
 * Exercise every hot path of the matter world once on a small private scene so V8 has type feedback and optimised code before
 * the first real fight (the first ticks of a cold JIT are several times slower). Call it once during loading, e.g. while the
 * title screen is up. It owns its own world and RNG, touches no shared state and leaves nothing behind, so determinism of real
 * worlds is unaffected (covered by a test). Returns the number of ticks simulated. Costs roughly 0.4 s (mostly cold-JIT time); it cut the worst of the first 20 fight ticks from ~13-26 ms to ~3-9 ms.
 */
export function warmUp(ticks = 100): number {
  const world = createMatterWorld(0x5eed);
  const a = world.createBody(layeredDisc({ size: 44, seed: 3, x: 330, y: 300, ownerSlot: 0 }).spec).id;
  const b = world.createBody(
    celadonBody({ size: 46, seed: 5, x: 830, y: 300, facing: -1, ownerSlot: 1 }).spec,
  ).id;
  const c = world.createBody(latticeDisc({ size: 34, seed: 9, x: 580, y: 150, ownerSlot: 1 }).spec).id;
  world.setGravitySource(1, {
    x: 830,
    y: 300,
    strength: 320,
    radius: 220,
    consumeRadius: 14,
    creditBodyId: b,
  });
  const rng = new Rng(11);
  const view = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };
  const ids = [a, b, c];
  const xs = [330, 830, 580];
  for (let t = 0; t < ticks; t++) {
    if (t % 6 === 0) {
      const k = (t / 6) | 0;
      const i = k % 3;
      const ev = warmEvent(rng, k, xs[i]!, xs[(i + 1) % 3]!);
      world.applyDamage(ids[i]!, ev);
    }
    world.tick();
    if (t % 3 === 0) world.renderLayers(view, 0.5);
  }
  world.stats(a);
  world.hash();
  return ticks;
}
