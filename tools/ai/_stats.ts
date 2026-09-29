import type { Difficulty, TitanId } from '@/contracts';
import { playMatch } from './duel';
const a = (process.argv[2] ?? 'lastone') as TitanId, b = (process.argv[3] ?? 'asteroid') as TitanId;
const la = +(process.argv[4] ?? 3) as Difficulty, lb = +(process.argv[5] ?? 3) as Difficulty;
const fake = process.argv[6] !== 'real';
const seeds = [1, 2, 3, 4];
const plans: Record<string, number>[] = [{}, {}];
let wins = [0, 0];
for (const seed of seeds) {
  const { res, ais } = playMatch(seed, a, b, la, lb, '', fake);
  wins[res.winner === -1 ? 0 : res.winner]!++;
  for (let s = 0; s < 2; s++) for (const line of res.logs[s]!) { const m = /^t=\d+ (.*?)(:| →|\[)/.exec(line); if (m) plans[s]![m[1]!.replace(/ \(.*\)/, '')] = (plans[s]![m[1]!.replace(/ \(.*\)/, '')] ?? 0) + 1; }
  console.log(`seed ${seed}: winner ${res.winner} wins ${res.wins} ${(res.ticks / 60).toFixed(0)}s integrity ${res.integrity.map((x) => x.toFixed(0))}`);
  void ais;
}
console.log('plans A', plans[0]);
console.log('plans B', plans[1]);
