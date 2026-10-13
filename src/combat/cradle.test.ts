import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  type Difficulty,
  type MatchConfig,
  type TitanId,
} from '@/contracts';
import { createAI } from '@/ai';
import { createMatterWorld } from '@/matter';
import { DEPTH_MID, chunkDepth, type Chunk } from '@/matter/chunks';
import { createAiSource, createMatch } from '@/sim';
import { getTitanDef } from '@/titans';
import { createFighter, type FighterImpl } from '.';
import type { CradleBehaviour } from './behaviours/kit/cradle';

/**
 * THE CRADLE's cord under stress (WJ's playtest, feedback round 1: "weird screen glitches when the cord was cut and some
 * wild stuff after that, the characters glitched across the screen"). A fight with the cord cut at its root every few
 * seconds, so it severs and regrows wrong again and again, checked every tick for what the camera and the other fighter
 * read: finite positions and bounds, no teleports, every rig region near its fighter, and the rig never having to be
 * rebuilt. (Cause found: a thrown, heavy chain could spin a link up past what the solver holds; it now caps spin and speed
 * and wraps angles after every step.)
 */
function stressFight(foe: TitanId, side: 0 | 1, seed: number, ticks: number, cutEvery: number) {
  const level = 4 as Difficulty;
  const [a, b] = side === 0 ? ['cradle' as TitanId, foe] : [foe, 'cradle' as TitanId];
  const cfg: MatchConfig = {
    seed,
    stage: 'nursery',
    mode: 'aivai',
    footwork: 'orbit',
    infinite: true,
    slots: [
      { titan: a, controller: 'ai', aiLevel: level },
      { titan: b, controller: 'ai', aiLevel: level },
    ],
  };
  const m = createMatch(cfg, {
    createWorld: (s) => createMatterWorld(s),
    createFighter,
    getTitanDef,
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  });
  m.setSources(
    createAiSource(m, 0, createAI(level, getTitanDef(a), seed * 7 + 1, { footwork: 'orbit' })),
    createAiSource(m, 1, createAI(level, getTitanDef(b), seed * 7 + 2, { footwork: 'orbit' })),
  );
  const fc = m.fighters[side] as FighterImpl;
  const beh = fc.behaviour as unknown as CradleBehaviour;
  const problems: string[] = [];
  const last: number[] = [NaN, NaN, NaN, NaN];
  let worstRegion = 0;
  let planeChunks = 0;
  let rounds = -1;
  for (let t = 0; t < ticks && problems.length === 0; t++) {
    if (cutEvery > 0 && t % cutEvery === cutEvery - 1 && beh.cordLinks > 0) beh.debugSever();
    m.step();
    // a new round (or the infinite mode's respawn after a KO) puts both fighters back on their marks: not a teleport
    const r = m.wins[0] + m.wins[1];
    if (r !== rounds || m.fighters.some((f) => (f as FighterImpl).state === 'intro')) last.fill(NaN);
    rounds = r;
    for (let k = 0; k < 2; k++) {
      const f = m.fighters[k] as FighterImpl;
      const v = f.view;
      const vals = [f.px, f.py, v.x, v.y, v.boundsX0, v.boundsX1, v.boundsY0, v.boundsY1];
      if (!vals.every(Number.isFinite))
        problems.push(`t${t}: fighter ${k} has a non-finite position or bounds`);
      if (m.phase === 'fight' && Number.isFinite(last[k * 2]!)) {
        const step = Math.hypot(f.px - last[k * 2]!, f.py - last[k * 2 + 1]!);
        if (step > 40) problems.push(`t${t}: fighter ${k} jumped ${step.toFixed(0)} px in one tick`);
      }
      if (v.boundsX1 - v.boundsX0 > 900 || v.boundsY1 - v.boundsY0 > 700)
        problems.push(`t${t}: fighter ${k}'s bounds blew up`);
      last[k * 2] = f.px;
      last[k * 2 + 1] = f.py;
    }
    // the cut limb stays in the fight plane (it was drawn at 2x in the near class: the 'screen glitch' WJ saw)
    const pool = (m.world as unknown as { core: { chunks: { hi: number; list: Chunk[] } } }).core.chunks;
    for (let s = 0; s < pool.hi; s++) {
      const c = pool.list[s]!;
      if (c.alive && c.plane && chunkDepth(c) !== DEPTH_MID)
        problems.push(`t${t}: a severed link left the fight plane`);
      if (c.alive && c.plane) planeChunks++;
    }
    for (const r of beh.debugRegions()) {
      const d = Math.hypot(r.x - fc.px, r.y - fc.py);
      worstRegion = Math.max(worstRegion, d);
      if (!Number.isFinite(d) || d > 340)
        problems.push(`t${t}: a ${r.kind} region is ${d.toFixed(0)} px from the Cradle`);
    }
  }
  return { problems, cuts: beh.cordCuts, recoveries: beh.recoveries, worstRegion, planeChunks };
}

describe('the Cradle: cutting the cord never breaks the fight (WJ playtest round 1)', () => {
  it.each([
    ['asteroid', 0, 401],
    ['planet', 1, 402],
  ] as const)(
    'vs %s (side %i): many sever / regrow cycles, finite and sane every tick',
    (foe, side, seed) => {
      const r = stressFight(foe, side, seed, 60 * 80, 300);
      expect(r.problems).toEqual([]);
      // (a cut on a cord still regrowing counts too; regrowth takes 7 s + a link every 46 ticks)
      expect(r.cuts).toBeGreaterThanOrEqual(6);
      expect(r.planeChunks).toBeGreaterThan(0);
      expect(r.recoveries).toBe(0);
    },
    120_000,
  );

  // two plain AI fights in which, before the fix, a thrown cord spun up and dragged a region 450 px off (seeds from
  // tools/titans/cradle-sanity.ts)
  it.each([
    ['planet', 1, 302],
    ['nexus', 0, 309],
  ] as const)(
    'vs %s (side %i): a whole AI fight, the rig stays together',
    (foe, side, seed) => {
      const r = stressFight(foe, side, seed, 60 * 80, 0);
      expect(r.problems).toEqual([]);
      expect(r.recoveries).toBe(0);
    },
    120_000,
  );
});
