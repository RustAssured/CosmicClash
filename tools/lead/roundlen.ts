/**
 * Round length across a set of pairings, AI vs AI, headless and deterministic (S11: the round-length pass).
 *   npx tsx tools/lead/roundlen.ts [--pairs=uri:colossus,mouth:lastone,mouth:all] [--n=4] [--level=6] [--mlevel=6]
 *                                  [--length=normal] [--pace=1.3] [--clock=120] [--boss=1] [--mouth=eRef:600,…]
 *                                  [--seed=1] [--why=1] [--out=file.json]
 * Each pair plays n matches with the sides alternated (the Mouth in arena B, as in the game). `--pace` sets the match
 * config's pace (MatchConfig.pace, the matter damage-taken multiplier); without it the match uses the default.
 * Prints per pair: wins, rounds, median / p10 / p90 round seconds, timeouts; then the same over every round.
 */
import { writeFileSync } from 'node:fs';
import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  ROUND_LENGTH_PACE,
  ROUND_LENGTH_SECONDS,
  type Difficulty,
  type MatchConfig,
  type RoundLength,
  type TitanId,
} from '@/contracts';
import { createAI } from '@/ai';
import { createFighter } from '@/combat';
import { arenaForMatch } from '@/combat/mouth/arena';
import { createMatterWorld } from '@/matter';
import { createAiSource, createMatch } from '@/sim';
import { MOUTH_LIVE } from '@/combat/mouth/tuning';
import { IMPLEMENTED_TITANS, getTitanDef, mouthBossDef } from '@/titans';

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
export const DEFAULT_PAIRS =
  'uri:colossus,uri:lastone,colossus:lastone,lastone:planet,supernova:blackhole,asteroid:nexus,planet:uri,' +
  'mouth:lastone,mouth:supernova,mouth:uri,mouth:colossus';
/** `a:all` expands to a against every roster titan. */
const pairs = arg('pairs', DEFAULT_PAIRS)
  .split(',')
  .flatMap((p) => {
    const [a, b] = p.split(':') as [TitanId, string];
    return b === 'all'
      ? IMPLEMENTED_TITANS.filter((t) => t !== a).map((t): [TitanId, TitanId] => [a, t])
      : [[a, b as TitanId] as [TitanId, TitanId]];
  });
/** `--mouth=eRef:600,damageMul:0.7`: try the Mouth's live tuning (MOUTH_LIVE) without editing it. */
for (const kv of arg('mouth', '').split(',').filter(Boolean)) {
  const [k, v] = kv.split(':');
  (MOUTH_LIVE as Record<string, number>)[k!] = +v!;
}
const n = +arg('n', '4');
const level = +arg('level', '6') as Difficulty;
/** `--mlevel=4`: the Mouth plays at its own level (the others at --level). */
const mlevel = +arg('mlevel', String(level)) as Difficulty;
const lv = (id: TitanId): Difficulty => (id === 'mouth' ? mlevel : level);
/** `--length=short|normal|long`: the Options row (pace and clock); `--pace` / `--clock` (s) override either. */
const length = arg('length', '') as RoundLength | '';
const paceArg = arg('pace', '');
const pace = paceArg ? +paceArg : length ? ROUND_LENGTH_PACE[length] : undefined;
const clockArg = arg('clock', '');
const roundSeconds = clockArg ? +clockArg : length ? ROUND_LENGTH_SECONDS[length] : undefined;
const boss = arg('boss', '0') === '1';
const seed0 = +arg('seed', '1');
const out = arg('out', '');
/** `--why=1`: one line per round end (each side's integrity, mass fraction and core integrity). */
const WHY = arg('why', '0') === '1';

interface Rec {
  a: TitanId;
  b: TitanId;
  winner: TitanId | 'none';
  rounds: number[];
  timeouts: number;
}

function play(seed: number, titans: [TitanId, TitanId]): Rec {
  const cfg: MatchConfig = {
    seed,
    stage: 'nursery',
    mode: 'aivai',
    footwork: 'orbit',
    pace,
    roundSeconds,
    slots: [
      { titan: titans[0], controller: 'ai', aiLevel: lv(titans[0]) },
      { titan: titans[1], controller: 'ai', aiLevel: lv(titans[1]) },
    ],
  };
  const defOf = (id: TitanId) => (id === 'mouth' && boss ? mouthBossDef() : getTitanDef(id));
  const m = createMatch(cfg, {
    createWorld: createMatterWorld,
    createFighter,
    getTitanDef: defOf,
    arena: arenaForMatch(DEFAULT_ARENA, titans),
    lighting: DEFAULT_LIGHTING,
  });
  m.setSources(
    createAiSource(m, 0, createAI(lv(titans[0]), defOf(titans[0]), seed * 7 + 1, { footwork: 'orbit' })),
    createAiSource(m, 1, createAI(lv(titans[1]), defOf(titans[1]), seed * 7 + 2, { footwork: 'orbit' })),
  );
  const rounds: number[] = [];
  let start = -1;
  let timeouts = 0;
  let ticks = 0;
  // --why: body mass each side lost within 1.5 s of a blow it took vs at any other time (burning, debris, pulls…)
  const lastHit = [-1e9, -1e9];
  const lossHit = [0, 0];
  const lossOther = [0, 0];
  const mass = [m.fighters[0].view.bodyStats.mass, m.fighters[1].view.bodyStats.mass];
  while (m.phase !== 'matchend' && ticks < 60 * 60 * 8) {
    m.step();
    ticks++;
    if (WHY) {
      for (const e of m.events) if (e.t === 'hit') lastHit[e.target] = m.tick;
      for (let s = 0; s < 2; s++) {
        const now = m.fighters[s]!.view.bodyStats.mass;
        const d = mass[s]! - now;
        if (d > 0 && m.phase === 'fight') {
          if (m.tick - lastHit[s]! <= 90) lossHit[s]! += d;
          else lossOther[s]! += d;
        }
        mass[s] = now;
      }
    }
    for (const e of m.events) {
      if (e.t !== 'round') continue;
      if (e.phase === 'fight') {
        start = m.tick;
        lossHit.fill(0);
        lossOther.fill(0);
      } else if ((e.phase === 'ko' || e.phase === 'timeover') && start >= 0) {
        rounds.push((m.tick - start) / 60);
        if (WHY)
          console.log(
            `  ${titans.join(' v ')} r${m.round} ${((m.tick - start) / 60).toFixed(1)} s ${e.phase}: ` +
              m.fighters
                .map(
                  (f) =>
                    `${f.def.id} ${f.view.integrityPct.toFixed(0)}% mass ${f.view.bodyStats.massFrac.toFixed(2)} core ${f.view.bodyStats.coreIntegrity.toFixed(2)} lost by blows ${lossHit[f.slot]!.toFixed(0)} / else ${lossOther[f.slot]!.toFixed(0)}`,
                )
                .join(' | '),
          );
        if (e.phase === 'timeover') timeouts++;
        start = -1;
      }
    }
  }
  return {
    a: titans[0],
    b: titans[1],
    winner: m.winner === -1 ? 'none' : titans[m.winner]!,
    rounds,
    timeouts,
  };
}

const q = (a: number[], p: number): number => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0;
};
const fmt = (a: number[]): string =>
  `median ${q(a, 0.5).toFixed(1)} s  p10 ${q(a, 0.1).toFixed(1)}  p90 ${q(a, 0.9).toFixed(1)}  (n ${a.length})`;

const t0 = performance.now();
const all: Rec[] = [];
for (const [a, b] of pairs) {
  const recs: Rec[] = [];
  for (let i = 0; i < n; i++) recs.push(play(seed0 + i, i % 2 === 0 ? [a, b] : [b, a]));
  all.push(...recs);
  const rs = recs.flatMap((r) => r.rounds);
  const wa = recs.filter((r) => r.winner === a).length;
  console.log(
    `${a} vs ${b}: ${a} ${wa}–${n - wa}; rounds ${fmt(rs)}; timeouts ${recs.reduce((s, r) => s + r.timeouts, 0)}`,
  );
}
const rs = all.flatMap((r) => r.rounds);
console.log(
  `\nall (L${level}, pace ${pace ?? 'default'}, clock ${roundSeconds ?? 90} s${boss ? ', boss' : ''}): ${fmt(rs)}; timeouts ${all.reduce(
    (s, r) => s + r.timeouts,
    0,
  )}; ${((performance.now() - t0) / 1000).toFixed(0)} s wall`,
);
if (out) writeFileSync(out, JSON.stringify({ level, pace, boss, n, recs: all }, null, 1));
