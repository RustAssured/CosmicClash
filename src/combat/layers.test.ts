import { describe, expect, it } from 'vitest';
import {
  LOGICAL_H,
  LOGICAL_W,
  parseScript,
  type RenderLayer,
  type TitanId,
  type ViewRect,
} from '@/contracts';
import { createMatterWorld } from '@/matter';
import { getTitanDef } from '@/titans';
import type { FighterImpl } from './fighter';
import { instantiateTemplate, makeFatShape } from './shapes';
import { createScriptSource, makeMatch, skipIntro } from './testing/harness';

const VIEW: ViewRect = { x0: 300, y0: 100, w: LOGICAL_W, h: LOGICAL_H };

/** What the renderer does with a layer it uploaded: forget the dirty rect. */
const consume = (layers: readonly RenderLayer[]): void => {
  for (const l of layers) l.dirty = null;
};

describe('render layers: dirty protocol and coverage', () => {
  it('the body layer mirrors and CONSUMES the matter map dirty rect, accumulating until the renderer clears it', () => {
    const m = makeMatch({ createWorld: (s) => createMatterWorld(s) });
    skipIntro(m);
    const f1 = m.fighters[1] as FighterImpl;
    m.setSources(
      createScriptSource(parseScript('0:right*90,80:crush'), m.tick + 1),
      createScriptSource([], m.tick + 1),
    );
    let sawDirty = false;
    let unionOk = true;
    for (let i = 0; i < 260; i++) {
      m.step();
      const map = f1.body.map;
      const layers = f1.renderLayers(VIEW, 1);
      const body = layers[0]!;
      // the map's own rect is always handed over, never left to grow forever
      expect(map.dirty).toBeNull();
      expect(body.pixels).toBe(map.pixels);
      expect(body.version).toBe(map.version);
      if (body.dirty) {
        sawDirty = true;
        expect(body.dirty.x1).toBeGreaterThan(body.dirty.x0);
        expect(body.dirty.y1).toBeGreaterThan(body.dirty.y0);
      }
      // the renderer only uploads every other frame here: an unconsumed rect must persist (and only ever grow)
      if (i % 2 === 0) consume(layers);
      else if (body.dirty) {
        const keep = { ...body.dirty };
        f1.renderLayers(VIEW, 1);
        const d = body.dirty!;
        if (d.x0 > keep.x0 || d.y0 > keep.y0 || d.x1 < keep.x1 || d.y1 < keep.y1) unionOk = false;
      }
    }
    expect(sawDirty).toBe(true);
    expect(unionOk).toBe(true);
  });

  it('overlay layers report a dirty rect covering old and new pixels and keep it until consumed', () => {
    const m = makeMatch({ createWorld: (s) => createMatterWorld(s) });
    skipIntro(m);
    m.setSources(
      createScriptSource(parseScript('0:right*60'), m.tick + 1),
      createScriptSource([], m.tick + 1),
    );
    const f0 = m.fighters[0] as FighterImpl;
    let dirtyFrames = 0;
    for (let i = 0; i < 90; i++) {
      m.step();
      const layers = f0.renderLayers(VIEW, 1);
      for (const l of layers.slice(1)) {
        if (l.dirty === null) continue;
        dirtyFrames++;
        expect(l.dirty.x0).toBeGreaterThanOrEqual(0);
        expect(l.dirty.y0).toBeGreaterThanOrEqual(0);
        expect(l.dirty.x1).toBeLessThanOrEqual(l.w);
        expect(l.dirty.y1).toBeLessThanOrEqual(l.h);
      }
      // consume every 3rd frame only: the rect persists across the frames in between
      if (i % 3 === 0) consume(layers);
    }
    expect(dirtyFrames).toBeGreaterThan(20);
  });

  it.each(['lastone', 'asteroid'] as TitanId[])(
    '%s: the additive FX overlay is big enough for every hitbox of every move at full charge (no clipped beams)',
    (id) => {
      const m = makeMatch({ a: id, b: id, createWorld: (s) => createMatterWorld(s) });
      const f = m.fighters[0] as FighterImpl;
      const fx = f.renderLayers(VIEW, 1).find((l) => l.blend === 'add');
      expect(fx).toBeDefined();
      const def = getTitanDef(id);
      const reach = def.attributes.reach / 5;
      const sh = makeFatShape();
      let maxX = 0;
      let maxY = 0;
      for (const mv of def.moves)
        for (const v of Object.values(mv.variants))
          for (const hb of v.hitboxes) {
            const cr = (mv.extra?.['chargeReach'] as [number, number] | undefined)?.[1] ?? 1;
            const scale = Math.pow(reach, hb.reachScale ?? 1) * cr;
            for (const tpl of [hb.shape, hb.sweepTo]) {
              if (!tpl) continue;
              instantiateTemplate(tpl, { x: 0, y: 0, facing: 1, scale }, sh);
              const xs =
                sh.kind === 'line'
                  ? [sh.x0, sh.x1]
                  : [sh.x + (sh.kind === 'cone' ? sh.range : sh.kind === 'ring' ? sh.r1 : sh.r)];
              const ys = sh.kind === 'line' ? [sh.y0, sh.y1] : [sh.y];
              for (const x of xs) maxX = Math.max(maxX, Math.abs(x));
              for (const y of ys) maxY = Math.max(maxY, Math.abs(y));
            }
          }
      // the overlay is centred on the body: it must reach at least as far as the farthest hitbox point on both axes
      expect(fx!.w / 2).toBeGreaterThanOrEqual(maxX);
      expect(fx!.h / 2).toBeGreaterThanOrEqual(maxY);
    },
  );

  it('FighterView bounds come from the world (world.liveBounds) and follow the body as it moves and as matter is lost', () => {
    const m = makeMatch({ createWorld: (s) => createMatterWorld(s) });
    skipIntro(m);
    m.setSources(
      createScriptSource(parseScript('0:right*70,60:crush'), m.tick + 1),
      createScriptSource([], m.tick + 1),
    );
    const f0 = m.fighters[0] as FighterImpl;
    const box = { x0: 0, y0: 0, x1: 0, y1: 0 };
    let worst = 0;
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      m.step();
      // the cached bounds may lag the exact scan by a few px of lean, never by a body-sized error
      if (!m.world.liveBounds(f0.body.id, box)) continue;
      const v = f0.view;
      worst = Math.max(
        worst,
        Math.abs(v.boundsX0 - box.x0),
        Math.abs(v.boundsX1 - box.x1),
        Math.abs(v.boundsY0 - box.y0),
        Math.abs(v.boundsY1 - box.y1),
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(250);
    expect(worst).toBeLessThan(16);
  });
});

describe('script offset used by the tools', () => {
  it('a stick event at script tick 0 moves the fighter when the offset is the tick the fight went live + 1', () => {
    const m = makeMatch({ createWorld: (s) => createMatterWorld(s) });
    skipIntro(m);
    const f0 = m.fighters[0] as FighterImpl;
    const x0 = f0.px;
    m.setSources(
      createScriptSource(parseScript('0:right*30'), m.tick + 1),
      createScriptSource([], m.tick + 1),
    );
    for (let i = 0; i < 30; i++) m.step();
    expect(f0.px - x0).toBeGreaterThan(10);
  });
});
