/**
 * The Mouth against the roster, AI vs AI, headless and deterministic (D37 verification):
 *   npx tsx tools/mouth/duel.ts [--foes=all|planet,lastone] [--n=2] [--level=3] [--seed=1] [--boss=1] [--ticks=21600]
 * For each foe: n matches (the Mouth alternating slot 0 / 1), real Match + matter world + fighters + AIs, arena B. Prints the
 * winner, the rounds' lengths, the blows each side landed, and checks determinism (the first match re-run gives the same hash).
 */
import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  type Difficulty,
  type MatchConfig,
  type TitanId,
} from '@/contracts';
import { createMatterWorld } from '@/matter';
import { createFighter } from '@/combat';
import { createMatch, createAiSource } from '@/sim';
import { IMPLEMENTED_TITANS, getTitanDef, mouthBossDef } from '@/titans';
import { createAI } from '@/ai';
import { arenaForMatch } from '@/combat/mouth/arena';

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const foesArg = arg('foes', 'all');
const foes = (foesArg === 'all' ? IMPLEMENTED_TITANS : foesArg.split(',')) as TitanId[];
const n = +arg('n', '2');
const level = +arg('level', '3') as Difficulty;
const seed0 = +arg('seed', '1');
const boss = arg('boss', '0') === '1';
const maxTicks = +arg('ticks', String(60 * 60 * 6));
/** --log=1: every blow the Mouth takes (energy, weight, health before → after). */
const LOG = arg('log', '0') === '1';

export interface MouthDuel {
  winner: TitanId | 'none';
  wins: [number, number];
  rounds: number[];
  dealt: [number, number];
  hash: number;
  ticks: number;
  timeouts: number;
}

export function playMouth(
  seed: number,
  foe: TitanId,
  mouthSlot: 0 | 1,
  lv: Difficulty,
  bossOn: boolean,
): MouthDuel {
  const titans: [TitanId, TitanId] = mouthSlot === 0 ? ['mouth', foe] : [foe, 'mouth'];
  const cfg: MatchConfig = {
    seed,
    stage: 'nursery',
    mode: 'aivai',
    footwork: 'orbit',
    slots: [
      { titan: titans[0], controller: 'ai', aiLevel: lv },
      { titan: titans[1], controller: 'ai', aiLevel: lv },
    ],
  };
  const defOf = (id: TitanId) => (id === 'mouth' && bossOn ? mouthBossDef() : getTitanDef(id));
  const m = createMatch(cfg, {
    createWorld: createMatterWorld,
    createFighter,
    getTitanDef: defOf,
    arena: arenaForMatch(DEFAULT_ARENA, titans),
    lighting: DEFAULT_LIGHTING,
  });
  const ais = [0, 1].map((s) => createAI(lv, defOf(titans[s]!), seed * 7 + s, { footwork: 'orbit' }));
  m.setSources(createAiSource(m, 0, ais[0]!), createAiSource(m, 1, ais[1]!));
  const rounds: number[] = [];
  const dealt: [number, number] = [0, 0];
  let fightStart = -1;
  let ticks = 0;
  let timeouts = 0;
  const mv = m.fighters[mouthSlot].view;
  while (m.phase !== 'matchend' && ticks < maxTicks) {
    const hp0 = mv.integrityPct;
    m.step();
    ticks++;
    for (const e of m.events) {
      if (e.t === 'hit') dealt[e.attacker]++;
      if (LOG && e.t === 'hit' && e.target === mouthSlot)
        console.log(
          `  t${ticks} ${foe} → mouth: ${e.type} ${e.energy.toFixed(0)} (${e.weight}) mouth ${hp0.toFixed(1)}% → ${mv.integrityPct.toFixed(1)}%`,
        );
      if (e.t === 'round') {
        if (e.phase === 'fight') fightStart = ticks;
        else if ((e.phase === 'ko' || e.phase === 'timeover') && fightStart >= 0) {
          rounds.push(ticks - fightStart);
          if (e.phase === 'timeover') timeouts++;
          fightStart = -1;
        }
      }
    }
  }
  return {
    winner: m.winner === -1 ? 'none' : titans[m.winner]!,
    wins: [m.wins[0], m.wins[1]],
    rounds,
    dealt,
    hash: m.hash(),
    ticks,
    timeouts,
  };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('mouth/duel.ts')) {
  let mouthWins = 0;
  let total = 0;
  const t0 = performance.now();
  let deterministic = true;
  for (const foe of foes) {
    for (let i = 0; i < n; i++) {
      const slot = (i % 2) as 0 | 1;
      const r = playMouth(seed0 + i, foe, slot, level, boss);
      total++;
      if (r.winner === 'mouth') mouthWins++;
      const ms = slot;
      const fs = 1 - slot;
      console.log(
        `${boss ? 'boss ' : ''}mouth(p${ms + 1}) vs ${foe}: winner ${r.winner} ${r.wins[0]}–${r.wins[1]}, rounds ${r.rounds
          .map((t) => (t / 60).toFixed(0) + 's')
          .join(
            ' ',
          )}${r.timeouts ? ` (${r.timeouts} by the clock)` : ''}, blows landed mouth ${r.dealt[ms]} / ${foe} ${r.dealt[fs]}, ${(r.ticks / 60).toFixed(0)} s, hash ${r.hash}`,
      );
      if (i === 0) {
        const again = playMouth(seed0 + i, foe, slot, level, boss);
        if (again.hash !== r.hash) {
          deterministic = false;
          console.log(`  NOT DETERMINISTIC: ${again.hash} vs ${r.hash}`);
        }
      }
    }
  }
  console.log(
    `\nthe Mouth won ${mouthWins} / ${total} at L${level}${boss ? ' (boss)' : ''} in ${((performance.now() - t0) / 1000).toFixed(0)} s; deterministic: ${deterministic}`,
  );
}
