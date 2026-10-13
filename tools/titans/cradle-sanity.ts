/**
 * THE CRADLE's cord under stress: AI fights (and forced sever/regrow cycles) checked every tick for what the camera and the
 * other fighter read: finite positions for both fighters and every Cradle body, no teleports (a fighter's root moving more
 * than MAX_STEP px in one tick), rig regions near their fighter, and finite view bounds. Prints the first offence per fight.
 *
 *   npx tsx tools/titans/cradle-sanity.ts [--foes=planet,asteroid] [--seconds=120] [--cycles=0] [--seed=301]
 */
import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  type Difficulty,
  type MatchConfig,
  type TitanId,
} from '@/contracts';
import { createAI } from '@/ai';
import { createFighter, type FighterImpl } from '@/combat';
import type { CradleBehaviour } from '@/combat/behaviours/kit/cradle';
import { createMatterWorld } from '@/matter';
import { createAiSource, createMatch } from '@/sim';
import { getTitanDef } from '@/titans';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const foes = opt('foes', 'planet,asteroid,lastone,supernova,nexus').split(',') as TitanId[];
const cap = +opt('seconds', '120') * 60;
const cycles = +opt('cycles', '0');
const MAX_STEP = 40;
let seed = +opt('seed', '301');
let bad = 0;
for (const foe of foes)
  for (const side of [0, 1] as const) {
    const [a, b] = side === 0 ? ['cradle' as TitanId, foe] : [foe, 'cradle' as TitanId];
    const level = 4 as Difficulty;
    const cfg: MatchConfig = {
      seed: seed++,
      stage: 'nursery',
      mode: 'aivai',
      footwork: 'orbit',
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
      createAiSource(m, 0, createAI(level, getTitanDef(a), cfg.seed * 7 + 1, { footwork: 'orbit' })),
      createAiSource(m, 1, createAI(level, getTitanDef(b), cfg.seed * 7 + 2, { footwork: 'orbit' })),
    );
    const fc = m.fighters[side] as FighterImpl;
    const beh = fc.behaviour as unknown as CradleBehaviour;
    const last = [NaN, NaN, NaN, NaN];
    let cuts = 0;
    let first = '';
    for (let t = 0; t < cap && m.phase !== 'matchend' && !first; t++) {
      // forced cycles: cut the cord every 9 s (regrowth takes ~7 s + 46 ticks a link)
      if (cycles > 0 && t % 540 === 300 && beh.cordLinks > 0) beh.debugSever();
      m.step();
      for (const e of m.events) if (e.t === 'cue' && e.slot === side && e.id === 'cord-sever') cuts++;
      for (let k = 0; k < 2; k++) {
        const f = m.fighters[k] as FighterImpl;
        const v = f.view;
        const vals = [f.px, f.py, v.x, v.y, v.boundsX0, v.boundsX1, v.boundsY0, v.boundsY1];
        if (!vals.every(Number.isFinite))
          first = `t${t} fighter ${k} non-finite: ${vals.map((x) => x.toFixed?.(1)).join(' ')}`;
        else if (
          Number.isFinite(last[k * 2]!) &&
          Math.hypot(f.px - last[k * 2]!, f.py - last[k * 2 + 1]!) > MAX_STEP &&
          m.phase === 'fight'
        )
          first = `t${t} fighter ${k} jumped ${Math.hypot(f.px - last[k * 2]!, f.py - last[k * 2 + 1]!).toFixed(0)} px (${fc.state})`;
        else if (v.boundsX1 - v.boundsX0 > 900 || v.boundsY1 - v.boundsY0 > 700)
          first = `t${t} fighter ${k} bounds ${(v.boundsX1 - v.boundsX0).toFixed(0)}×${(v.boundsY1 - v.boundsY0).toFixed(0)}`;
        last[k * 2] = f.px;
        last[k * 2 + 1] = f.py;
      }
      for (const body of beh.regionBodies) {
        const tr = body.transform;
        if (!Number.isFinite(tr.x) || !Number.isFinite(tr.y)) first = `t${t} region ${body.id} non-finite`;
        else if (Math.hypot(tr.x - fc.px, tr.y - fc.py) > 420)
          first = `t${t} region ${body.id} ${Math.hypot(tr.x - fc.px, tr.y - fc.py).toFixed(0)} px from the Cradle (${fc.state}, ${m.phase}, rig jumps ${beh.rigJumps})`;
      }
    }
    if (first) bad++;
    console.log(
      `${foe.padEnd(10)} side ${side}  cuts ${cuts}/${beh.cordCuts}  recoveries ${beh.recoveries}  ${first || 'ok'}`,
    );
  }
console.log(bad ? `${bad} fights with offences` : 'all clean');
