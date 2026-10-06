import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  parseScript,
  type MatchConfig,
  type RenderLayer,
  type TitanId,
} from '@/contracts';
import { tuning } from '@/debug/tuning';
import { createMatterWorld } from '@/matter';
import { createMatch, createScriptSource, type Match } from '@/sim';
import { getTitanDef, URI_ID, uriDef } from '@/titans';
import { URI_ORDER, uriPart } from '@/titans/uri/rig';
import { createFighter } from './index';
import type { FighterImpl } from './fighter';
import type { UriBehaviour } from './behaviours/uri';
import { skipIntro } from './testing/harness';

/** A real match with 우리 in slot 0 against `foe`, the foe placed `dx` px from it (negative = on its left). */
function uriMatch(dx = 260, seed = 7): { m: Match; u: FighterImpl; beh: UriBehaviour } {
  const cfg: MatchConfig = {
    seed,
    stage: 'nursery',
    mode: 'versus',
    slots: [
      { titan: URI_ID, controller: 'human' },
      { titan: 'planet', controller: 'human' },
    ],
  };
  const m = createMatch(cfg, {
    createWorld: (s) => createMatterWorld(s),
    createFighter,
    getTitanDef: (id: TitanId) => (id === URI_ID ? uriDef() : getTitanDef(id)),
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  });
  skipIntro(m);
  const u = m.fighters[0] as FighterImpl;
  const foe = m.fighters[1] as unknown as { px: number; py: number };
  foe.px = u.px + dx;
  foe.py = u.py;
  for (let k = 0; k < 4; k++) m.step();
  return { m, u, beh: u.behaviour as unknown as UriBehaviour };
}

/** Where each body's grid corner (its map cell 0, 0) is in the world, relative to the reference → world offset. */
function corners(u: FighterImpl, beh: UriBehaviour): Map<string, [number, number, number, number]> {
  const o = beh.offset;
  const out = new Map<string, [number, number, number, number]>();
  for (const k of URI_ORDER) {
    const b = beh.bodyOf(k);
    const t = b.transform;
    out.set(k, [t.x - t.anchorX - o.x, t.y - t.anchorY - o.y, t.rot ?? 0, t.facing]);
  }
  void u;
  return out;
}

describe('우리 in the game (Phase 2A/2B)', () => {
  it('is one primary (the pelvis) and 12 region bodies, each the asset part placed at its reference layout', () => {
    const { u, beh } = uriMatch();
    expect(u.def.name).toBe('우리');
    expect(beh.regionBodies).toHaveLength(12);
    expect(u.regions).toHaveLength(12);
    const c = corners(u, beh);
    for (const k of URI_ORDER) {
      const meta = uriPart(k);
      const [x, y, rot, facing] = c.get(k)!;
      // at rest the grid's corner lands on the reference layout (within the half pixel of the idle bob), unrotated
      // (the pylons breathe by ±0.02 rad: at most one rotation step)
      expect(Math.abs(x - meta.x0), k).toBeLessThanOrEqual(1);
      // (the command moon also bobs on its tether: ±1.2 px more)
      expect(Math.abs(y - meta.y0), k).toBeLessThanOrEqual(k === 'moon' ? 3 : 1.5);
      if (k === 'pyL' || k === 'pyR')
        expect(Math.min(Math.abs(rot), Math.abs(256 - rot)), k).toBeLessThanOrEqual(1);
      else expect(rot, k).toBe(0);
      expect(facing).toBe(1);
    }
    // the whole body is about 300 px tall and 400 wide at native scale (spec §3)
    const b = u.liveBounds();
    expect(b.y1 - b.y0).toBeGreaterThan(280);
    expect(b.x1 - b.x0).toBeGreaterThan(380);
  });

  it('is never mirrored: with the opponent on its left everything is drawn and hit exactly as with it on the right', () => {
    const right = uriMatch(260);
    const left = uriMatch(-260);
    expect(right.u.facing).toBe(1);
    expect(left.u.facing).toBe(-1);
    const a = corners(right.u, right.beh);
    const b = corners(left.u, left.beh);
    for (const k of URI_ORDER) expect(b.get(k), k).toEqual(a.get(k));
    // every layer it draws faces +1
    const layers: RenderLayer[] = left.u.renderLayers({ x0: 0, y0: 0, w: 640, h: 360 }, 1);
    expect(layers.length).toBeGreaterThanOrEqual(3);
    for (const L of layers) expect(L.facing, L.id).toBe(1);
  });

  it('registers its diagnostics (centre of mass, pivots, cores, target) and a whole-body mass frame', () => {
    const { u, beh } = uriMatch();
    const owners = [...tuning.diagnostics()].map(([k]) => k);
    expect(owners).toContain(`match.p${u.slot + 1}.uri.rig`);
    const mf = { x: 0, y: 0, gyration: 0, radius: 0 };
    expect(beh.massFrame(mf)).toBe(true);
    // the centre of mass sits inside the body, near the chamber, and the frame is the size of the whole fortress
    const b = u.liveBounds();
    expect(mf.x).toBeGreaterThan(b.x0);
    expect(mf.x).toBeLessThan(b.x1);
    expect(mf.y).toBeGreaterThan(b.y0);
    expect(mf.y).toBeLessThan(b.y1);
    expect(mf.radius).toBeGreaterThan(120);
    expect(mf.gyration).toBeGreaterThan(40);
  });

  it('a button plays its authored move (D31) with the arm on the opponent side leading, and feeds the live pass', () => {
    for (const [dx, lead] of [
      [260, 'R'],
      [-260, 'L'],
    ] as const) {
      const { m, beh } = uriMatch(dx);
      m.setSources(
        createScriptSource(parseScript('2:strike'), m.tick + 1),
        createScriptSource([], m.tick + 1),
      );
      const phases = new Set<string>();
      let leadSeen: string | null = null;
      let impact = false;
      for (let t = 0; t < 120; t++) {
        m.step();
        const v = beh.kview;
        if (v.phase) phases.add(v.phase);
        if (v.lead) leadSeen = v.lead;
        // compressed for the blow (the spread's joint limit is 0.8: the oracle's impact clamp to 0.74 lands on it)
        if (v.spread[lead] <= 0.8 + 1e-6) impact = true;
      }
      expect([...phases]).toEqual(expect.arrayContaining(['load', 'drive', 'follow', 'taper']));
      expect(leadSeen).toBe(lead);
      expect(impact).toBe(true);
      // the front layer carries the live elements and the shading planes
      const layers = (m.fighters[0] as FighterImpl).renderLayers(
        { x0: 0, y0: 0, w: 640, h: 360 },
        1,
      ) as (RenderLayer & {
        uriLive?: { hotR: number; fistSpread?: readonly number[] };
        light?: Uint8Array;
        shade?: Uint8Array;
      })[];
      const front = layers.find((L) => L.id.startsWith('uri-front'))!;
      expect(front.uriLive?.hotR).toBeGreaterThan(30);
      expect(front.light?.length).toBe(front.w * front.h * 4);
      expect(front.shade?.length).toBe(front.w * front.h * 4);
    }
  });

  it('is deterministic (world + behaviour hash)', () => {
    const run = (): number => {
      const { m, u } = uriMatch(240, 11);
      for (let t = 0; t < 60; t++) m.step();
      return (m.world.hash() ^ u.stateHash(0)) >>> 0;
    };
    expect(run()).toBe(run());
  });
});
