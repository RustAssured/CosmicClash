/**
 * THE CRADLE in AI-vs-AI fights against the roster (real matter world, orbit footwork): who wins, how long, how often the
 * cord is cut and regrown, and which moves the AI uses. A quick read between balance sweeps.
 *
 *   npx tsx tools/titans/cradle-duel.ts [--foes=planet,asteroid] [--level=4] [--seconds=120] [--per=1]
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
import { ROSTER } from '@/titans/roster';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const foes = (
  opt('foes', '') ? opt('foes', '').split(',') : ROSTER.map((r) => r.id).filter((id) => id !== 'cradle')
) as TitanId[];
const level = +opt('level', '4') as Difficulty;
const cap = +opt('seconds', '180') * 60;
const per = +opt('per', '1');
let wins = 0;
let n = 0;
const moves: Record<string, number> = {};
let seed = 101;
for (const foe of foes)
  for (const side of [0, 1] as const)
    for (let k = 0; k < per; k++) {
      const [a, b] = side === 0 ? ['cradle' as TitanId, foe] : [foe, 'cradle' as TitanId];
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
      let t = 0;
      let cuts = 0;
      const t0 = performance.now();
      while (m.phase !== 'matchend' && t < cap) {
        m.step();
        t++;
        for (const e of m.events) {
          if (e.t === 'move' && e.slot === side) moves[e.moveId] = (moves[e.moveId] ?? 0) + 1;
          if (e.t === 'cue' && e.slot === side && e.id === 'cord-sever') cuts++;
        }
      }
      const beh = (m.fighters[side] as FighterImpl).behaviour as unknown as CradleBehaviour;
      const score = m.winner === -1 ? 0.5 : m.winner === side ? 1 : 0;
      wins += score;
      n++;
      console.log(
        `${foe.padEnd(10)} side ${side}  ${score === 1 ? 'WIN ' : score === 0 ? 'loss' : 'draw'} ${m.wins[side]}-${m.wins[1 - side]}  ${(t / 60).toFixed(0)} s  cuts ${cuts}  links ${beh.cordLinks}  (${((performance.now() - t0) / 1000).toFixed(1)} s cpu)`,
      );
    }
console.log(`win rate ${((wins / n) * 100).toFixed(0)} % of ${n}`);
console.log('moves', JSON.stringify(moves));
