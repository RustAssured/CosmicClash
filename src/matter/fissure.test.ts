import { describe, expect, it } from 'vitest';
import { LOGICAL_H, LOGICAL_W, rgba, type DamageEvent } from '@/contracts';
import { WITNESS_MATERIALS } from '@/titans/art/lastone';
import { createMatterWorld, type MatterWorldEx } from './index';
import { buildMaterialTable } from './materials';
import { celadonBody, gasPlanet, type TestBody } from './testing/bodies';

/**
 * Wound light belongs to the body (Lead, Phase 2): CRUSH fissures glow with molten rock only on a body that holds magma; any
 * other body cracks dark unless it authors its own fissure light (`setFissureGlow`), and heat glows along each material's own
 * glowRamp. The Witness's wound light is white-gold and cyan, never red or orange, whoever hits it.
 */

const view = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };

const crush = (x: number, y: number): DamageEvent => ({
  type: 'CRUSH',
  shape: { kind: 'point', x, y, r: 12 },
  energy: 1100,
  dirX: 1,
  dirY: 0,
  duration: 1,
  sourceMass: 8,
  sourceBodyId: -1,
  originX: x - 60,
  originY: y,
  flags: 0,
  params: { compress: 8 },
});

/** Red / orange: red clearly dominant over blue and over green (hue ~0-40 degrees), bright enough to read as glow. */
function isRedOrange(p: number): boolean {
  if (p >>> 24 === 0) return false;
  const r = p & 255;
  const g = (p >>> 8) & 255;
  const b = (p >>> 16) & 255;
  return r >= 120 && r - b >= 80 && r - g >= 40;
}

/** A Witness region: the celadon test silhouette made of the Witness's own materials (carapace, vein, channel). */
function witnessRegion(): TestBody {
  const tb = celadonBody({ size: 40, seed: 3, x: 420, y: 200 });
  tb.spec.materials = buildMaterialTable(WITNESS_MATERIALS.slice(0, 3));
  return tb;
}

/** Red/orange pixels: in the body's own sprite (fissures, heat) and in every debris / particle layer. */
function countRedOrange(world: MatterWorldEx, tb: TestBody): { body: number; layers: number } {
  world.refresh();
  let body = 0;
  for (let i = 0; i < tb.map.pixels.length; i++)
    if (tb.map.material[i] !== 0 && isRedOrange(tb.map.pixels[i]!)) body++;
  let layers = 0;
  for (const l of world.renderLayers(view, 0))
    for (let i = 0; i < l.pixels.length; i++) if (isRedOrange(l.pixels[i]!)) layers++;
  return { body, layers };
}

function batter(world: MatterWorldEx, id: number, x: number, y: number, probe: () => void): void {
  for (let k = 0; k < 3; k++) {
    world.applyDamage(id, crush(x + k * 3, y + k * 5 - 5));
    for (let t = 0; t < 20; t++) {
      world.tick();
      if (t % 5 === 0) probe();
    }
  }
}

describe('fissure and wound light follow the body', () => {
  it('a Planet CRUSH on a Witness region shows no red or orange anywhere', () => {
    const tb = witnessRegion();
    const world = createMatterWorld(11);
    const id = world.createBody(tb.spec).id;
    const body = world.core.bodyById[id]!;
    expect(body.fissureLit).toBe(false);
    let worst = { body: 0, layers: 0 };
    let cracked = 0;
    batter(world, id, 392, 200, () => {
      const r = countRedOrange(world, tb);
      worst = { body: Math.max(worst.body, r.body), layers: Math.max(worst.layers, r.layers) };
      let c = 0;
      for (let i = 0; i < tb.map.flags.length; i++)
        if (tb.map.material[i] !== 0 && (tb.map.flags[i]! & 2) !== 0) c++;
      cracked = Math.max(cracked, c);
    });
    expect(cracked).toBeGreaterThan(10); // the CRUSH did crack it
    expect(body.magma).toBe(false);
    expect(worst).toEqual({ body: 0, layers: 0 });
  });

  it('the Witness can author its own (white-gold) fissure light: lit, still never orange', () => {
    const tb = witnessRegion();
    const world = createMatterWorld(11);
    const id = world.createBody(tb.spec).id;
    world.setFissureGlow(id, rgba(255, 241, 201, 255));
    const body = world.core.bodyById[id]!;
    expect(body.fissureLit).toBe(true);
    let worst = 0;
    batter(world, id, 392, 200, () => {
      const r = countRedOrange(world, tb);
      worst = Math.max(worst, r.body + r.layers);
    });
    expect(body.magma).toBe(true);
    expect(worst).toBe(0);
  });

  it('a magma-bearing body still shows molten fissures (the detector sees them)', () => {
    const tb = gasPlanet({ size: 46, seed: 2, x: 420, y: 200 });
    const world = createMatterWorld(12);
    const id = world.createBody(tb.spec).id;
    expect(world.core.bodyById[id]!.fissureLit).toBe(true);
    let worst = 0;
    batter(world, id, 382, 200, () => {
      worst = Math.max(worst, countRedOrange(world, tb).body);
    });
    expect(world.core.bodyById[id]!.magma).toBe(true);
    expect(worst).toBeGreaterThan(0);
  });
});
