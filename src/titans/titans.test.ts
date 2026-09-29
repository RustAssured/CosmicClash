import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIGHTING,
  MAX_BODY_CELLS,
  MAX_BODY_DIM,
  TITAN_IDS,
  pa,
  validateTitanDef,
  type StageLighting,
} from '@/contracts';
import {
  IMPLEMENTED_TITANS,
  TITAN_DEFS,
  generateTitanBody,
  getTitanDef,
  paintTitanMap,
  renderPortrait,
} from '@/titans';
import { buildMaterialTable } from '@/matter';

const COLD: StageLighting = {
  dir: [-0.3, -0.6, 0.74],
  color: '#cfe6ff',
  ambient: '#0e1a3a',
  rim: '#7fc8ff',
  screenPos: [0.3, -0.1],
};

describe('titan definitions', () => {
  it('implements exactly the vertical-slice roster', () => {
    expect(IMPLEMENTED_TITANS).toEqual(['lastone', 'asteroid']);
    for (const id of IMPLEMENTED_TITANS) expect(getTitanDef(id).id).toBe(id);
    expect(() => getTitanDef('nexus')).toThrow(/not implemented/);
  });

  it.each(IMPLEMENTED_TITANS)('%s passes the contract validator (frame data feel targets)', (id) => {
    expect(validateTitanDef(getTitanDef(id))).toEqual([]);
  });

  it.each(IMPLEMENTED_TITANS)('%s matches the design bible attributes', (id) => {
    const a = getTitanDef(id).attributes;
    const want = {
      lastone: { mass: 5, cohesion: 8, heat: 5, gravity: 3, reach: 7, tempo: 7 },
      asteroid: { mass: 3, cohesion: 6, heat: 5, gravity: 1, reach: 4, tempo: 9 },
    }[id as 'lastone' | 'asteroid'];
    expect(a).toEqual(want);
  });

  it('every move id is unique and namespaced by its titan; every aim variant exists', () => {
    for (const id of IMPLEMENTED_TITANS) {
      const def = getTitanDef(id);
      const seen = new Set<string>();
      for (const m of def.moves) {
        expect(m.id.startsWith(`${id}.`)).toBe(true);
        expect(seen.has(m.id)).toBe(false);
        seen.add(m.id);
        for (const aim of ['up', 'forward', 'down'] as const) expect(m.variants[aim]).toBeDefined();
      }
    }
  });

  it('move follow-ups and shells reference real data', () => {
    for (const id of IMPLEMENTED_TITANS) {
      const def = getTitanDef(id);
      const ids = new Set(def.moves.map((m) => m.id));
      for (const m of def.moves) {
        const fu = m.extra?.['followUp'] as { move: string } | undefined;
        if (fu) expect(ids.has(fu.move)).toBe(true);
      }
      const guard = def.moves.find((m) => m.slot === 'guard')!;
      const shell = guard.extra?.['shell'] as { absorb: Record<string, number> };
      expect(Object.keys(shell.absorb).length).toBeGreaterThanOrEqual(5);
      for (const v of Object.values(shell.absorb)) expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('Last One matches its spec: HUD tendril pips and a 3.5–4.5 s ultimate; Asteroid spends fragments on Swarm', () => {
    const lo = getTitanDef('lastone');
    expect(lo.resource.id).toBe('tendrils');
    expect(lo.resource.max).toBeGreaterThanOrEqual(20);
    expect(lo.resource.max).toBeLessThanOrEqual(30);
    const ult = lo.moves.find((m) => m.slot === 'ultimate')!;
    const total = ult.frame.startup + ult.frame.active + ult.frame.recovery;
    expect(total).toBeGreaterThanOrEqual(210);
    expect(total).toBeLessThanOrEqual(270);
    const ast = getTitanDef('asteroid');
    expect(ast.moves.find((m) => m.slot === 'signature')!.resourceCost).toBeGreaterThan(0);
  });

  it('titans not implemented yet are absent (no stubs)', () => {
    for (const id of TITAN_IDS) expect(id in TITAN_DEFS).toBe(IMPLEMENTED_TITANS.includes(id));
  });
});

describe.each(IMPLEMENTED_TITANS)('generator: %s', (id) => {
  const def = getTitanDef(id);
  const { map, rig } = paintTitanMap(def, 1234, DEFAULT_LIGHTING);
  const table = buildMaterialTable(def.materials);

  const solid = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < map.w && y < map.h && map.material[y * map.w + x] !== 0;

  it('is deterministic: same seed and lighting give identical bytes; another seed differs', () => {
    const b = paintTitanMap(def, 1234, DEFAULT_LIGHTING).map;
    expect(Buffer.compare(Buffer.from(b.baseColor.buffer), Buffer.from(map.baseColor.buffer))).toBe(0);
    expect(Buffer.compare(Buffer.from(b.material), Buffer.from(map.material))).toBe(0);
    const c = paintTitanMap(def, 4321, DEFAULT_LIGHTING).map;
    expect(Buffer.compare(Buffer.from(c.material), Buffer.from(map.material))).not.toBe(0);
  });

  it('is lit for the stage: another light changes colours but not the silhouette', () => {
    const cold = paintTitanMap(def, 1234, COLD).map;
    expect(Buffer.compare(Buffer.from(cold.baseColor.buffer), Buffer.from(map.baseColor.buffer))).not.toBe(0);
    expect(Buffer.compare(Buffer.from(cold.material), Buffer.from(map.material))).toBe(0);
  });

  it('fits the body budget and is 90–180 px across', () => {
    let x0 = map.w,
      x1 = -1,
      y0 = map.h,
      y1 = -1,
      cells = 0;
    for (let y = 0; y < map.h; y++)
      for (let x = 0; x < map.w; x++)
        if (solid(x, y)) {
          cells++;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
    expect(map.w).toBeLessThanOrEqual(MAX_BODY_DIM);
    expect(map.h).toBeLessThanOrEqual(MAX_BODY_DIM);
    expect(cells).toBeLessThanOrEqual(MAX_BODY_CELLS);
    expect(cells).toBeGreaterThan(4000);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    expect(Math.max(w, h)).toBeGreaterThanOrEqual(90);
    expect(Math.max(w, h)).toBeLessThanOrEqual(180);
    expect(Math.min(w, h)).toBeGreaterThanOrEqual(80);
    // never touches the map border (room for the renderer's edge lighting and for growth)
    expect(x0).toBeGreaterThan(1);
    expect(y0).toBeGreaterThan(1);
    expect(x1).toBeLessThan(map.w - 2);
    expect(y1).toBeLessThan(map.h - 2);
  });

  it('is one connected body (4-connected flood fill from the core reaches every cell)', () => {
    const seen = new Uint8Array(map.w * map.h);
    const stack = [map.coreY * map.w + map.coreX];
    seen[stack[0]!] = 1;
    let n = 0;
    while (stack.length) {
      const i = stack.pop()!;
      n++;
      const x = i % map.w;
      const y = (i / map.w) | 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (!solid(nx, ny)) continue;
        const j = ny * map.w + nx;
        if (!seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    let total = 0;
    for (let i = 0; i < map.material.length; i++) if (map.material[i] !== 0) total++;
    expect(n).toBe(total);
  });

  it('has its core inside solid matter and every core-disc cell present', () => {
    expect(solid(map.coreX, map.coreY)).toBe(true);
    const R = map.coreRadius;
    for (let y = -R; y <= R; y++)
      for (let x = -R; x <= R; x++)
        if (x * x + y * y <= (R - 1) * (R - 1)) expect(solid(map.coreX + x, map.coreY + y)).toBe(true);
  });

  it('uses only defined materials, has opaque colours on solids and nothing on void, densities and relief set', () => {
    const used = new Set<number>();
    for (let i = 0; i < map.material.length; i++) {
      const m = map.material[i]!;
      if (m === 0) {
        expect(map.baseColor[i]).toBe(0);
        expect(map.density[i]).toBe(0);
        continue;
      }
      used.add(m);
      expect(m).toBeLessThan(table.length);
      expect(pa(map.baseColor[i]!)).toBe(255);
      expect(map.density[i]).toBeGreaterThan(0);
    }
    // every authored material really appears (no dead entries in the JSON)
    for (let id = 1; id <= def.materials.length; id++)
      expect(used.has(id), `material ${def.materials[id - 1]!.key}`).toBe(true);
    let maxH = 0;
    for (let i = 0; i < map.height.length; i++) maxH = Math.max(maxH, map.height[i]!);
    expect(maxH).toBeGreaterThan(100);
  });

  it('the rig matches the map (ids are the JSON order, anchors are on matter)', () => {
    const ids = Object.values(rig.ids);
    for (const v of ids) expect(v).toBeGreaterThan(0);
    if (id === 'lastone') {
      const r = rig as import('@/titans').LastOneRig;
      expect(r.roots.length).toBe(def.resource.max);
      for (const root of r.roots) expect(solid(Math.round(root.x), Math.round(root.y))).toBe(true);
      expect(solid(Math.round(r.eye.x), Math.round(r.eye.y))).toBe(true);
      expect(map.material[Math.round(r.eye.y) * map.w + Math.round(r.eye.x)]).toBe(
        r.ids.iris === 0 ? 0 : map.material[Math.round(r.eye.y) * map.w + Math.round(r.eye.x)],
      );
    }
  });

  it('body generation returns an independent, resolved copy each call (cached painting)', () => {
    const a = generateTitanBody(def, 99, DEFAULT_LIGHTING);
    const b = generateTitanBody(def, 99, DEFAULT_LIGHTING);
    expect(a.map).not.toBe(b.map);
    expect(a.map.material).not.toBe(b.map.material);
    a.map.material[a.map.coreY * a.map.w + a.map.coreX] = 0;
    expect(b.map.material[b.map.coreY * b.map.w + b.map.coreX]).not.toBe(0);
    expect(a.materials.length).toBe(
      def.materials.length + 1 + a.materials.filter((m) => m.key === 'ash' || m.key === 'char').length,
    );
    expect(a.materials[0]!.id).toBe(0);
  });

  it('paints a stable, cropped portrait for menus', () => {
    const p = renderPortrait(id, 5);
    expect(p.w).toBeGreaterThan(60);
    expect(p.pixels.length).toBe(p.w * p.h);
    expect(renderPortrait(id, 5)).toBe(p);
  });
});

describe('Last One specifics', () => {
  it('layers: shell over lattice over a core hidden behind the eye, halo attached by spokes, tendril roots on matter', () => {
    const def = getTitanDef('lastone');
    const { map, rig } = paintTitanMap(def, 7, DEFAULT_LIGHTING);
    const r = rig as import('@/titans').LastOneRig;
    const counts = new Map<number, number>();
    for (let i = 0; i < map.material.length; i++)
      counts.set(map.material[i]!, (counts.get(map.material[i]!) ?? 0) + 1);
    const shell = counts.get(r.ids.shell) ?? 0;
    const inner = counts.get(r.ids.inner) ?? 0;
    expect(shell).toBeGreaterThan(inner * 0.4);
    expect(counts.get(r.ids.gilt)).toBeGreaterThan(300); // halo + inlays
    expect(counts.get(r.ids.core)).toBeGreaterThan(200);
    // the core is behind (left of) the eye when facing right and does not overlap it
    expect(r.core.x).toBeLessThan(r.eye.x);
    expect(Math.hypot(r.core.x - r.eye.x, r.core.y - r.eye.y)).toBeGreaterThan(r.core.r + r.eye.r * 0.6);
  });
});
