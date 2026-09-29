/**
 * Headless duel runner: plays N fights between two titans at given AI levels and prints results.
 *   npx tsx tools/ai/duel.ts [--a=lastone] [--b=asteroid] [--la=3] [--lb=3] [--n=10] [--seed=1] [--dummy=a|b] [--log] [--fake]
 * Uses the real Match, real Fighters and the real matter world (`--fake` swaps in the test double for speed).
 * `--dummy=b` makes slot b a do-nothing dummy. Prints per-fight winner/reason/rounds and an overall tally.
 */
import { DEFAULT_ARENA, DEFAULT_LIGHTING, type Difficulty, type MatchConfig, type TitanId } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { createFighter } from '@/combat';
import { createFakeWorld } from '@/combat/testing/fakeWorld';
import { createMatch, createAiSource, type Match } from '@/sim';
import { getTitanDef } from '@/titans';
import { createAI } from '@/ai';
import { UtilityAI } from '@/ai/controller';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const flag = (k: string): boolean => args.includes(`--${k}`);

const a = opt('a', 'lastone') as TitanId;
const b = opt('b', 'asteroid') as TitanId;
const la = +opt('la', '3') as Difficulty;
const lb = +opt('lb', '3') as Difficulty;
const n = +opt('n', '6');
const seed0 = +opt('seed', '1');
const dummy = opt('dummy', '');

export interface DuelResult {
  winner: 0 | 1 | -1;
  wins: [number, number];
  ticks: number;
  reason: string;
  integrity: [number, number];
  logs: [string[], string[]];
}

export function playMatch(seed: number, ta: TitanId, tb: TitanId, levelA: Difficulty, levelB: Difficulty, dummySlot: string, fake: boolean, maxTicks = 60 * 60 * 5): { match: Match; res: DuelResult; ais: (UtilityAI | null)[] } {
  const cfg: MatchConfig = {
    seed,
    stage: 'nursery',
    mode: 'aivai',
    slots: [
      { titan: ta, controller: dummySlot === 'a' ? 'dummy' : 'ai', aiLevel: levelA },
      { titan: tb, controller: dummySlot === 'b' ? 'dummy' : 'ai', aiLevel: levelB },
    ],
  };
  const match = createMatch(cfg, {
    createWorld: (s) => (fake ? createFakeWorld(s) : createMatterWorld(s)),
    createFighter,
    getTitanDef,
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  });
  const ais: (UtilityAI | null)[] = [null, null];
  const src = [null, null] as (ReturnType<typeof createAiSource> | null)[];
  if (dummySlot !== 'a') {
    ais[0] = createAI(levelA, getTitanDef(ta), seed * 7 + 1) as UtilityAI;
    src[0] = createAiSource(match, 0, ais[0]);
  }
  if (dummySlot !== 'b') {
    ais[1] = createAI(levelB, getTitanDef(tb), seed * 7 + 2) as UtilityAI;
    src[1] = createAiSource(match, 1, ais[1]);
  }
  match.setSources(src[0], src[1]);
  let ticks = 0;
  while (match.phase !== 'matchend' && ticks < maxTicks) {
    match.step();
    ticks++;
  }
  const v = match.fighters.map((f) => f.view);
  const res: DuelResult = {
    winner: match.winner,
    wins: [match.wins[0], match.wins[1]],
    ticks,
    reason: match.phase === 'matchend' ? 'match over' : 'tick cap',
    integrity: [v[0]!.integrityPct, v[1]!.integrityPct],
    logs: [ais[0] ? [...ais[0].log] : [], ais[1] ? [...ais[1].log] : []],
  };
  return { match, res, ais };
}

if (process.argv[1]?.endsWith('duel.ts')) {
  const tally = [0, 0, 0];
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const { res } = playMatch(seed0 + i, a, b, la, lb, dummy, flag('fake'));
    tally[res.winner === -1 ? 2 : res.winner]!++;
    console.log(
      `fight ${i + 1}: winner ${res.winner === -1 ? '—' : res.winner === 0 ? a : b} (${res.wins[0]}–${res.wins[1]}) in ${(res.ticks / 60).toFixed(1)} s sim, integrity ${res.integrity[0]!.toFixed(0)}% / ${res.integrity[1]!.toFixed(0)}%${res.reason === 'tick cap' ? ' [tick cap]' : ''}`,
    );
    if (flag('log') && i === 0) {
      console.log('--- A log (last 25) ---\n' + res.logs[0].slice(-25).join('\n'));
      console.log('--- B log (last 25) ---\n' + res.logs[1].slice(-25).join('\n'));
    }
  }
  console.log(`\n${a} L${la} ${tally[0]} — ${tally[1]} ${b} L${lb}  (${tally[2]} undecided) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
