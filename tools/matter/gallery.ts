import { writeContactSheet } from '../lead/png';
import { DamageFlag } from '@/contracts';
import {
  blackHole,
  celadonBody,
  gasPlanet,
  latticeDisc,
  layeredDisc,
  ribbedSlab,
  star,
} from '@/matter/testing/bodies';
import { dmg, runScenario } from './scenario';

const which = process.argv[2] ?? 'all';
const out = (n: string): string => `.scratch/${n}.png`;

function fracture(): void {
  const b = celadonBody({ seed: 11, x: 320, y: 180 });
  // A blow from the left edge, then a lash across, then a crack-seeding Shatter Blow at the top.
  const r = runScenario({
    seed: 4,
    bodies: [b],
    capture: [0, 6, 20, 60, 120, 240],
    crop: { x: 190, y: 60, w: 260, h: 240 },
    events: [
      {
        tick: 2,
        body: 0,
        ev: dmg({
          type: 'FRACTURE',
          shape: { kind: 'line', x0: 240, y0: 130, x1: 340, y1: 210, width: 6 },
          energy: 420,
          dirX: 0.78,
          dirY: 0.62,
        }),
      },
      {
        tick: 4,
        body: 0,
        ev: dmg({
          type: 'FRACTURE',
          shape: { kind: 'cone', x: 300, y: 100, dirX: 0.1, dirY: 1, range: 38, halfAngle: 0.5 },
          energy: 380,
          dirX: 0.1,
          dirY: 1,
          flags: DamageFlag.SEED_CRACK,
          params: { crackSeeds: 4 },
        }),
      },
    ],
  });
  writeContactSheet(out('gal-fracture'), r.frames, 3, 2, 3);
}

function kinetic(): void {
  const b = layeredDisc({ seed: 5, x: 320, y: 180 });
  const r = runScenario({
    seed: 5,
    bodies: [b],
    capture: [0, 4, 16, 50, 90, 200],
    crop: { x: 190, y: 60, w: 260, h: 240 },
    events: [
      {
        tick: 2,
        body: 0,
        ev: dmg({
          type: 'KINETIC',
          shape: { kind: 'point', x: 262, y: 170, r: 7 },
          energy: 600,
          dirX: 1,
          dirY: 0.15,
          flags: DamageFlag.EMBED,
          params: { embed: 4, embedDelay: 40 },
        }),
      },
      {
        tick: 3,
        body: 0,
        ev: dmg({
          type: 'KINETIC',
          shape: { kind: 'point', x: 330, y: 122, r: 6 },
          energy: 350,
          dirX: 0.1,
          dirY: 1,
        }),
      },
    ],
  });
  writeContactSheet(out('gal-kinetic'), r.frames, 3, 2, 3);
}

function kineticIron(): void {
  const b = ribbedSlab({ seed: 5, x: 320, y: 180 });
  const r = runScenario({
    seed: 5,
    bodies: [b],
    capture: [0, 4, 16, 50, 90, 200],
    crop: { x: 190, y: 90, w: 260, h: 180 },
    events: [
      {
        tick: 2,
        body: 0,
        ev: dmg({
          type: 'KINETIC',
          shape: { kind: 'point', x: 262, y: 175, r: 7 },
          energy: 600,
          dirX: 1,
          dirY: 0.05,
        }),
      },
      {
        tick: 3,
        body: 0,
        ev: dmg({
          type: 'KINETIC',
          shape: { kind: 'point', x: 330, y: 148, r: 6 },
          energy: 350,
          dirX: 0.1,
          dirY: 1,
        }),
      },
    ],
  });
  writeContactSheet(out('gal-kinetic-iron'), r.frames, 3, 2, 3);
}

function crush(): void {
  const b = gasPlanet({ seed: 8, x: 320, y: 180 });
  const r = runScenario({
    seed: 5,
    bodies: [b],
    capture: [0, 3, 12, 40, 100, 220],
    crop: { x: 190, y: 60, w: 260, h: 240 },
    events: [
      {
        tick: 2,
        body: 0,
        ev: dmg({
          type: 'CRUSH',
          shape: { kind: 'point', x: 268, y: 168, r: 16 },
          energy: 1600,
          dirX: 1,
          dirY: 0.1,
          params: { compress: 14, shock: 1 },
        }),
      },
    ],
  });
  writeContactSheet(out('gal-crush'), r.frames, 3, 2, 3);
}

function thermal(): void {
  const b = latticeDisc({ seed: 4, x: 320, y: 180 });
  const r = runScenario({
    seed: 5,
    bodies: [b],
    capture: [0, 8, 30, 70, 140, 300],
    crop: { x: 190, y: 60, w: 260, h: 240 },
    events: [
      {
        tick: 2,
        body: 0,
        ev: dmg({
          type: 'THERMAL',
          shape: { kind: 'point', x: 282, y: 160, r: 12 },
          energy: 45,
          dirX: 1,
          dirY: 0.2,
          params: { shock: 120 },
        }),
      },
    ],
  });
  writeContactSheet(out('gal-thermal'), r.frames, 3, 2, 3);
}

function tidal(): void {
  const victim = layeredDisc({ seed: 5, size: 50, x: 230, y: 180, ownerSlot: 0 });
  const bh = blackHole({ seed: 2, x: 470, y: 180, ownerSlot: 1 });
  const events = [];
  for (let t = 5; t <= 100; t++)
    events.push({
      tick: t,
      body: 0,
      ev: dmg({
        type: 'TIDAL',
        shape: { kind: 'field', x: 230, y: 180, r: 110, falloff: 1.4 },
        energy: 5,
        dirX: 1,
        dirY: 0,
        flags: DamageFlag.CONTINUOUS,
        sourceBodyId: 1,
        originX: 470,
        originY: 180,
        params: { pull: 1.2 },
      }),
    });
  const r = runScenario({
    seed: 5,
    bodies: [victim, bh],
    capture: [0, 12, 30, 60, 100, 160],
    crop: { x: 120, y: 60, w: 400, h: 240 },
    events,
    setup: (world, bodies) =>
      world.setGravitySource(1, {
        x: 470,
        y: 180,
        strength: 420,
        radius: 300,
        consumeRadius: 14,
        creditBodyId: bodies[1]!.id,
      }),
  });
  writeContactSheet(out('gal-tidal'), r.frames, 3, 2, 3);
  console.log(
    'tidal stats',
    r.world.stats(victim ? 0 : 0).massLost,
    r.world.stats(1).massGained,
    r.world.ledger(),
  );
}

function assim(): void {
  const b = celadonBody({ seed: 4, x: 320, y: 180 });
  const r = runScenario({
    seed: 5,
    bodies: [b],
    capture: [0, 20, 80, 160, 280, 420],
    crop: { x: 190, y: 60, w: 260, h: 240 },
    events: [
      {
        tick: 2,
        body: 0,
        ev: dmg({
          type: 'ASSIMILATION',
          shape: { kind: 'point', x: 268, y: 170, r: 10 },
          energy: 300,
          dirX: 1,
          dirY: 0.2,
          flags: DamageFlag.LATCH,
          originX: 60,
          originY: 100,
          sourceBodyId: -1,
          params: { latch: 200, harvest: 0.6 },
        }),
      },
    ],
  });
  writeContactSheet(out('gal-assim'), r.frames, 3, 2, 3);
}

function starHit(): void {
  const b = star({ seed: 4, x: 320, y: 180 });
  const r = runScenario({
    seed: 5,
    bodies: [b],
    capture: [0, 8, 30, 70, 140, 240],
    crop: { x: 190, y: 60, w: 260, h: 240 },
    events: [
      {
        tick: 2,
        body: 0,
        ev: dmg({
          type: 'KINETIC',
          shape: { kind: 'point', x: 268, y: 168, r: 10 },
          energy: 500,
          dirX: 1,
          dirY: 0.1,
        }),
      },
    ],
  });
  writeContactSheet(out('gal-star'), r.frames, 3, 2, 3);
}

function carveSheet(): void {
  const makers = [
    (o: object) => celadonBody(o),
    (o: object) => layeredDisc(o),
    (o: object) => ribbedSlab(o),
    (o: object) => latticeDisc(o),
  ];
  const items: { pixels: Uint32Array; w: number; h: number }[] = [];
  makers.forEach((mk, bi) => {
    for (const frac of [1, 0.5, 0.1, -0.5]) {
      const b = mk({ seed: 3 + bi, x: 320, y: 180 });
      const r = runScenario({
        seed: 9,
        bodies: [b],
        capture: [1],
        crop: { x: 190, y: 70, w: 260, h: 220 },
        events: [],
        setup: (world, bodies) => {
          const id = bodies[0]!.id;
          if (frac === 1) return;
          if (frac > 0) world.carve(id, frac, 11);
          else {
            world.carve(id, 0.1, 11);
            world.heal(id, 0.5, 5);
          }
        },
      });
      items.push(r.frames[0]!);
    }
  });
  writeContactSheet(out('gal-carve'), items, 4, 1, 2);
}

if (which === 'all' || which === 'carve') carveSheet();
if (which === 'all' || which === 'crush') crush();
if (which === 'all' || which === 'thermal') thermal();
if (which === 'all' || which === 'tidal') tidal();
if (which === 'all' || which === 'assim') assim();
if (which === 'all' || which === 'star') starHit();
if (which === 'all' || which === 'fracture') fracture();
if (which === 'all' || which === 'kinetic') kinetic();
if (which === 'all' || which === 'iron') kineticIron();
console.log('done');
